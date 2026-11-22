import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Keypair } from '@stellar/stellar-sdk';
import { A, type Role } from '../chain/args.js';
import { sha256Hex } from '../common/canonical-json.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ChainPort } from '../app/services.js';

export class AttestorCapReached extends Error {
  constructor(public readonly cap: number) {
    super(`attestor daily cap of ${cap} reached; attestations resume tomorrow (UTC) or after an operator raises ATTESTOR_DAILY_CAP`);
  }
}

/** Cap alert threshold: a run towards the daily cap usually means a bug or a compromised flow (brief 7.8, 12.3). */
export const ATTESTOR_SPIKE_RATIO = 0.8;
/** Default for ATTESTOR_SPIKE_MULTIPLE: today above three times the trailing daily average raises a spike alert (#130). */
export const DEFAULT_SPIKE_MULTIPLE = 3;
/** Days in the trailing window that gives the daily average a spike is measured against. */
export const SPIKE_BASELINE_DAYS = 7;
/** A spike needs at least this many attestations today, so a quiet baseline does not alarm on the first few. */
export const SPIKE_FLOOR = 10;

const DAY_MS = 86_400_000;

/** A fresh per-attestation salt: 128 bits, hex. It is stored only encrypted, with the verification record (#128). */
export function newAttestationSalt(): string {
  return randomBytes(16).toString('hex');
}

export interface VerHashInput {
  userId: string;
  providerRef: string;
  level: number;
  salt: string;
}

/**
 * The one place the on-chain verification hash is built: `sha256(userId|providerRef|level|salt)` (brief 3.2, 7.8).
 * Changing this formula would make every hash already on-chain unverifiable, so it is pinned by tests.
 */
export function verHashOf(p: VerHashInput): string {
  return sha256Hex(`${p.userId}|${p.providerRef}|${p.level}|${p.salt}`);
}

/** True when `verHash` (hex) is the hash of this attestation. Compared in constant time. */
export function verHashMatches(verHash: string, p: VerHashInput): boolean {
  const given = Buffer.from(verHash.toLowerCase(), 'utf8');
  const expected = Buffer.from(verHashOf(p), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface AttestorOptions {
  /** Spike alert when today's attestations exceed this multiple of the trailing daily average (ATTESTOR_SPIKE_MULTIPLE). */
  spikeMultiple?: number;
  /** Called once per attestation that trips the spike alert; the API wires this to the metric. */
  onSpike?: () => void;
}

/**
 * The only path that writes verification to the chain (`registry.attest`). On-chain there is only
 * `ver_hash = sha256(userId|providerRef|level|salt)` and a level: no personal data (brief 3.2, 7.8). The salt
 * stays off-chain, encrypted with the verification record, so the hash can be re-derived for an audit but not
 * guessed. A daily cap bounds the damage of a compromised attestor flow; admin `revoke` undoes a bad attestation.
 * Spike alerts (#130) warn before the cap is reached: today's count above the trailing average times the multiple.
 * Rotating the key: docs/runbooks/attestor-rotation.md.
 */
export class Attestor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chain: Pick<ChainPort, 'invokeServer'>,
    private readonly key: Keypair,
    private readonly dailyCap: number,
    private readonly now: () => Date,
    private readonly alert: (msg: string) => void = (m) => console.error(m),
    private readonly opts: AttestorOptions = {},
  ) {}

  private utcMidnight(t: Date): number {
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  }

  async attestedToday(): Promise<number> {
    const since = new Date(this.utcMidnight(this.now()));
    return this.prisma.auditLog.count({ where: { action: 'attest', at: { gte: since } } });
  }

  /** Average attestations per UTC day over the `SPIKE_BASELINE_DAYS` before today. */
  async trailingDailyAverage(): Promise<number> {
    const today = this.utcMidnight(this.now());
    const count = await this.prisma.auditLog.count({
      where: { action: 'attest', at: { gte: new Date(today - SPIKE_BASELINE_DAYS * DAY_MS), lt: new Date(today) } },
    });
    return count / SPIKE_BASELINE_DAYS;
  }

  /**
   * Spike detection (#130). `todayCount` includes the attestation about to be written, so the one that crosses the
   * line is the one reported. The cap itself is not affected: this only alerts.
   */
  private async checkSpike(todayCount: number): Promise<void> {
    const trailing = await this.trailingDailyAverage();
    const threshold = Math.max(trailing * (this.opts.spikeMultiple ?? DEFAULT_SPIKE_MULTIPLE), SPIKE_FLOOR);
    if (todayCount <= threshold) return;
    this.alert(`[attestor] SPIKE ${todayCount} attestations today; trailing ${SPIKE_BASELINE_DAYS}-day average ${trailing.toFixed(2)}/day, alert above ${threshold.toFixed(2)}`);
    this.opts.onSpike?.();
  }

  async attest(userId: string, wallet: string, role: Role, level: number, providerRef: string, actorId = 'attestor'): Promise<{ hash: string; verHash: string; salt: string }> {
    const done = await this.attestedToday();
    if (done >= this.dailyCap) {
      this.alert(`[attestor] ALERT daily cap ${this.dailyCap} reached`);
      throw new AttestorCapReached(this.dailyCap);
    }
    if (done + 1 >= this.dailyCap * ATTESTOR_SPIKE_RATIO) this.alert(`[attestor] ALERT ${done + 1}/${this.dailyCap} attestations today`);
    await this.checkSpike(done + 1);
    const salt = newAttestationSalt();
    const verHash = verHashOf({ userId, providerRef, level, salt });
    const r = await this.chain.invokeServer('registry', 'attest', A.attest(this.key.publicKey(), wallet, role, verHash, level), [this.key]);
    await this.prisma.auditLog.create({ data: { actorId, action: 'attest', target: userId, data: { role, level, verHash, tx: r.hash } } });
    return { hash: r.hash, verHash, salt };
  }
}
