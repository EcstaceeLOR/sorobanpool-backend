import { Keypair } from '@stellar/stellar-sdk';
import { vi } from 'vitest';
import { sha256Hex } from '../common/canonical-json.js';
import { Attestor, DEFAULT_SPIKE_MULTIPLE, SPIKE_BASELINE_DAYS, SPIKE_FLOOR, newAttestationSalt, verHashMatches, verHashOf } from './attestor.js';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 10, 22, 12); // 2026-11-22 midday UTC

/** An in-memory auditLog that honours the `action` and `at` (gte/lt) filters the attestor uses. */
function fakeAudit(seed: { action: string; at: number }[] = []) {
  const rows = seed.map((r) => ({ action: r.action, at: new Date(r.at) }));
  const clock = { now: TODAY };
  const prisma = {
    auditLog: {
      count: async ({ where }: { where: { action: string; at: { gte: Date; lt?: Date } } }) =>
        rows.filter((r) => r.action === where.action && r.at >= where.at.gte && (!where.at.lt || r.at < where.at.lt)).length,
      create: async ({ data }: { data: { action: string } }) => {
        rows.push({ action: data.action, at: new Date(clock.now) });
        return data;
      },
    },
  };
  return { prisma: prisma as never, clock, rows };
}

/** `perDay` attestations on each of the baseline days before today, all inside the trailing window. */
function baseline(perDay: number): { action: string; at: number }[] {
  const out: { action: string; at: number }[] = [];
  const todayStart = Date.UTC(2026, 10, 22);
  for (let d = 1; d <= SPIKE_BASELINE_DAYS; d++) {
    for (let i = 0; i < perDay; i++) out.push({ action: 'attest', at: todayStart - d * DAY + 3_600_000 * (i + 1) });
  }
  return out;
}

const wallet = () => Keypair.random().publicKey();
const attestorKey = Keypair.random();
const chain = { invokeServer: async () => ({ hash: 'ab'.repeat(32), returnValue: undefined }) } as never;

function attestorWith(seed: { action: string; at: number }[], opts: { spikeMultiple?: number; onSpike?: () => void; dailyCap?: number } = {}) {
  const audit = fakeAudit(seed);
  const alerts: string[] = [];
  const attestor = new Attestor(audit.prisma, chain, attestorKey, opts.dailyCap ?? 1000, () => new Date(audit.clock.now), (m) => alerts.push(m), {
    spikeMultiple: opts.spikeMultiple, onSpike: opts.onSpike,
  });
  return { attestor, audit, alerts };
}

describe('verification hash', () => {
  const input = { userId: 'user-1', providerRef: 'admin-review', level: 1, salt: 'deadbeef' };

  it('is deterministic and is the sha256 of userId|providerRef|level|salt', () => {
    expect(verHashOf(input)).toBe(verHashOf({ ...input }));
    expect(verHashOf(input)).toBe(sha256Hex('user-1|admin-review|1|deadbeef'));
  });

  it('changes with every input, so a different salt or level gives a different hash', () => {
    const base = verHashOf(input);
    expect(verHashOf({ ...input, salt: 'deadbeee' })).not.toBe(base);
    expect(verHashOf({ ...input, level: 2 })).not.toBe(base);
    expect(verHashOf({ ...input, providerRef: 'other' })).not.toBe(base);
    expect(verHashOf({ ...input, userId: 'user-2' })).not.toBe(base);
  });

  it('verifies a known hash, in either case, and refuses anything else', () => {
    const known = sha256Hex('user-1|admin-review|1|deadbeef');
    expect(verHashMatches(known, input)).toBe(true);
    expect(verHashMatches(known.toUpperCase(), input)).toBe(true);
    expect(verHashMatches(known, { ...input, salt: 'deadbeee' })).toBe(false);
    expect(verHashMatches('00'.repeat(32), input)).toBe(false);
  });

  it('gives every attestation a fresh 128-bit salt', () => {
    const salts = new Set(Array.from({ length: 200 }, () => newAttestationSalt()));
    expect(salts.size).toBe(200);
    for (const s of salts) expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns a salt and hash that re-derive to the same value', async () => {
    const { attestor } = attestorWith([]);
    const r = await attestor.attest('user-9', wallet(), 'Supplier', 1, 'admin-review', 'admin');
    expect(r.verHash).toBe(verHashOf({ userId: 'user-9', providerRef: 'admin-review', level: 1, salt: r.salt }));
    expect(verHashMatches(r.verHash, { userId: 'user-9', providerRef: 'admin-review', level: 1, salt: r.salt })).toBe(true);
  });
});

describe('attestor spike alert (#130)', () => {
  it('stays quiet while today is within the multiple of a steady baseline', async () => {
    // Baseline: 4 a day, so the threshold is max(4 x 3, floor 10) = 12 with the default multiple.
    const onSpike = vi.fn();
    const { attestor, alerts } = attestorWith(baseline(4), { onSpike });
    expect(DEFAULT_SPIKE_MULTIPLE).toBe(3);
    for (let i = 0; i < 12; i++) await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    expect(onSpike).not.toHaveBeenCalled();
    expect(alerts.some((m) => m.includes('SPIKE'))).toBe(false);
  });

  it('alerts, and counts a metric, on each attestation above the multiple of the baseline', async () => {
    const onSpike = vi.fn();
    const { attestor, alerts } = attestorWith(baseline(4), { onSpike });
    for (let i = 0; i < 12; i++) await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review'); // the 13th today
    expect(onSpike).toHaveBeenCalledTimes(1);
    const spike = alerts.find((m) => m.includes('SPIKE'))!;
    expect(spike).toContain('13 attestations today');
    expect(spike).toContain('4.00/day');
  });

  it('honours a configured multiple', async () => {
    // Baseline 10 a day: threshold 20 with multiple 2, 30 with the default of 3.
    const low = vi.fn();
    const a = attestorWith(baseline(10), { spikeMultiple: 2, onSpike: low });
    for (let i = 0; i < 21; i++) await a.attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    expect(low).toHaveBeenCalledTimes(1);

    const dflt = vi.fn();
    const b = attestorWith(baseline(10), { onSpike: dflt });
    for (let i = 0; i < 21; i++) await b.attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    expect(dflt).not.toHaveBeenCalled();
  });

  it('does not alarm on the first attestations of a quiet day, because of the floor', async () => {
    const onSpike = vi.fn();
    const { attestor } = attestorWith([], { onSpike }); // no baseline at all: average 0
    for (let i = 0; i < SPIKE_FLOOR; i++) await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    expect(onSpike).not.toHaveBeenCalled();
    await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review'); // 11th: above the floor of 10
    expect(onSpike).toHaveBeenCalledTimes(1);
  });

  it('leaves the daily cap unchanged: a spike only alerts, and the attestation past the cap is still refused', async () => {
    // Baseline 1 a day: threshold max(1 x 3, floor 10) = 10, so the 11th and 12th today spike but are still written.
    const onSpike = vi.fn();
    const { attestor, alerts } = attestorWith(baseline(1), { onSpike, dailyCap: 12 });
    for (let i = 0; i < 12; i++) await attestor.attest('u', wallet(), 'Trader', 1, 'admin-review');
    expect(onSpike).toHaveBeenCalledTimes(2);
    expect(alerts.filter((m) => m.includes('SPIKE'))).toHaveLength(2);
    await expect(attestor.attest('u', wallet(), 'Trader', 1, 'admin-review')).rejects.toThrow(/daily cap of 12 reached/);
    expect(onSpike).toHaveBeenCalledTimes(2); // the refused attempt raises no spike
  });
});
