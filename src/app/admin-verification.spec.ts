import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, PHONE_ADMIN, type Harness } from '../../test/harness.js';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('admin verification: salts, revocation and FX history', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  let n = 0;
  const phone = () => `+2348061000${String(n++).padStart(3, '0')}`;

  async function trader() {
    const u = await h.login(phone());
    await h.bindWallet(u.token, Keypair.random());
    return u;
  }

  async function secondAdmin() {
    const admin = await h.login(phone());
    await h.bindWallet(admin.token, Keypair.random());
    await h.s.prisma.userRole.upsert({ where: { userId_role: { userId: admin.userId, role: 'ADMIN' } }, create: { userId: admin.userId, role: 'ADMIN' }, update: {} });
    return admin;
  }

  const organizerRole = (userId: string) => h.s.prisma.userRole.findUniqueOrThrow({ where: { userId_role: { userId, role: 'ORGANIZER' } } });

  describe('verification hashes (#128)', () => {
    it('keeps the salt of an admin attestation encrypted with its record, and verifies the on-chain hash against it', async () => {
      const admin = await h.login(PHONE_ADMIN);
      const u = await trader();
      await h.http().post(`/v1/admin/users/${u.userId}/attest`).set(auth(admin.token)).send({ role: 'Organizer', level: 2 }).expect(200);

      const row = await organizerRole(u.userId);
      expect(row.level).toBe(2);
      expect(row.verHash).toMatch(/^[0-9a-f]{64}$/);

      const rec = await h.s.prisma.verificationRecord.findFirstOrThrow({ where: { userId: u.userId, kind: 'ATTESTATION:ORGANIZER' } });
      expect(JSON.stringify(rec.result)).not.toContain(row.verHash!);
      const opened = h.s.pii.open<{ salt: string; verHash: string; level: number }>(rec.result as never);
      expect(opened.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(opened.verHash).toBe(row.verHash);
      expect(opened.level).toBe(2);

      const ok = await h.http().post(`/v1/admin/users/${u.userId}/verify-hash`).set(auth(admin.token)).send({ verHash: row.verHash }).expect(200);
      expect(ok.body).toEqual({ verified: true, recordId: rec.id, kind: 'ATTESTATION:ORGANIZER', status: 'VERIFIED', role: 'Organizer', level: 2 });
    });

    it('refuses a hash that does not match, a hash that belongs to another user, and non-admins', async () => {
      const admin = await h.login(PHONE_ADMIN);
      const u = await trader();
      await h.http().post(`/v1/admin/users/${u.userId}/attest`).set(auth(admin.token)).send({ role: 'Organizer', level: 1 }).expect(200);
      const hash = (await organizerRole(u.userId)).verHash!;

      expect((await h.http().post(`/v1/admin/users/${u.userId}/verify-hash`).set(auth(admin.token)).send({ verHash: '0'.repeat(64) }).expect(200)).body).toEqual({ verified: false });
      const other = await trader();
      expect((await h.http().post(`/v1/admin/users/${other.userId}/verify-hash`).set(auth(admin.token)).send({ verHash: hash }).expect(200)).body).toEqual({ verified: false });
      await h.http().post(`/v1/admin/users/${u.userId}/verify-hash`).set(auth(u.token)).send({ verHash: hash }).expect(403);
      await h.http().post(`/v1/admin/users/${u.userId}/verify-hash`).set(auth(admin.token)).send({ verHash: 'not-a-hash' }).expect(400);

      expect(await h.s.prisma.auditLog.count({ where: { action: 'user.verify_hash', target: u.userId } })).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /admin/users/:id/revoke (#129)', () => {
    it('needs a second admin, downgrades the level, marks the record and audits the reason', async () => {
      const admin = await h.login(PHONE_ADMIN);
      const u = await trader();
      await h.http().post(`/v1/admin/users/${u.userId}/attest`).set(auth(admin.token)).send({ role: 'Organizer', level: 1 }).expect(200);

      await h.http().post(`/v1/admin/users/${u.userId}/revoke`).set(auth(u.token)).send({ role: 'Organizer', reason: 'FRAUD' }).expect(403);
      await h.http().post(`/v1/admin/users/${u.userId}/revoke`).set(auth(admin.token)).send({ role: 'Organizer', reason: 'BECAUSE' }).expect(400);

      const requested = await h.http().post(`/v1/admin/users/${u.userId}/revoke`).set(auth(admin.token)).send({ role: 'Organizer', reason: 'FRAUD' }).expect(200);
      expect(requested.body.status).toBe('PENDING_APPROVAL');
      expect((await organizerRole(u.userId)).level).toBe(1); // unchanged until a second admin approves

      await h.http().post(`/v1/admin/actions/${requested.body.actionId}/approve`).set(auth(admin.token)).expect(403);
      const originalHash = (await organizerRole(u.userId)).verHash!;

      const reviewer = await secondAdmin();
      const approved = await h.http().post(`/v1/admin/actions/${requested.body.actionId}/approve`).set(auth(reviewer.token)).expect(200);
      expect(approved.body).toMatchObject({ status: 'REVOKED', level: 0, contract: 'registry', fn: 'revoke' });
      const call = h.chain.calls.at(-1)!;
      expect(call).toMatchObject({ kind: 'prepare', contract: 'registry', fn: 'revoke' });
      expect(call.args![2]).toEqual(['Organizer']);
      expect(call.args![3]).toBe('FRAUD');

      expect(await organizerRole(u.userId)).toMatchObject({ level: 0, verHash: null });
      const rec = await h.s.prisma.verificationRecord.findFirstOrThrow({ where: { userId: u.userId, kind: 'ATTESTATION:ORGANIZER' } });
      expect(rec.status).toBe('REVOKED');
      const audit = await h.s.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.revoke', target: u.userId } });
      expect(audit).toMatchObject({ actorId: reviewer.userId });
      expect(audit.data).toMatchObject({ role: 'Organizer', reason: 'FRAUD' });

      // The record is kept for audit: the revoked hash still verifies, now reported as REVOKED.
      expect(originalHash).toMatch(/^[0-9a-f]{64}$/);
      const stillKnown = await h.http().post(`/v1/admin/users/${u.userId}/verify-hash`).set(auth(admin.token)).send({ verHash: originalHash }).expect(200);
      expect(stillKnown.body).toMatchObject({ verified: true, recordId: rec.id, status: 'REVOKED' });

      // Approved once: the same request cannot be approved again, and there is nothing left to revoke.
      await h.http().post(`/v1/admin/actions/${requested.body.actionId}/approve`).set(auth(reviewer.token)).expect(409);
      await h.http().post(`/v1/admin/users/${u.userId}/revoke`).set(auth(admin.token)).send({ role: 'Organizer', reason: 'FRAUD' }).expect(404);
    });

    it('refuses to request a revocation for a role the user does not hold', async () => {
      const admin = await h.login(PHONE_ADMIN);
      const u = await trader();
      await h.http().post(`/v1/admin/users/${u.userId}/revoke`).set(auth(admin.token)).send({ role: 'Supplier', reason: 'FRAUD' }).expect(404);
    });
  });

  describe('GET /admin/fx (#125)', () => {
    it('lists quotes newest first with their sources and divergence, paginated and read-only', async () => {
      const admin = await h.login(PHONE_ADMIN);
      const base = Date.UTC(2026, 10, 20, 10);
      // Oldest: the bare-list shape publishing stored; divergence is derived.
      await h.s.prisma.fxQuote.create({ data: { id: 'fx-1', pair: 'NGN/USD', rate: '1425', sources: [{ source: 'a', ngnPerUsd: 1350 }, { source: 'b', ngnPerUsd: 1500 }] as never, createdAt: new Date(base) } });
      // Middle: the fx-refresh job's shape, with its divergence stored.
      await h.s.prisma.fxQuote.create({ data: { id: 'fx-2', pair: 'NGN/USD', rate: '1348.525', sources: { quotes: [{ source: 'a', ngnPerUsd: 1347.74 }, { source: 'b', ngnPerUsd: 1349.31 }], divergence: 0.0012 } as never, createdAt: new Date(base + 60_000) } });
      // Newest: a single source, so no divergence can be computed.
      await h.s.prisma.fxQuote.create({ data: { id: 'fx-3', pair: 'NGN/USD', rate: '1350', sources: [{ source: 'a', ngnPerUsd: 1350 }] as never, createdAt: new Date(base + 120_000) } });

      const first = await h.http().get('/v1/admin/fx?limit=2').set(auth(admin.token)).expect(200);
      expect(first.body.map((r: { id: string }) => r.id)).toEqual(['fx-3', 'fx-2']);
      expect(first.body[0]).toMatchObject({ divergence: null, sources: [{ source: 'a', ngnPerUsd: 1350 }] });
      expect(first.body[1].divergence).toBeCloseTo(0.0012, 6);
      expect(first.headers['x-next-cursor']).toBe('fx-2');

      const second = await h.http().get('/v1/admin/fx?limit=2&cursor=fx-2').set(auth(admin.token)).expect(200);
      expect(second.body.map((r: { id: string }) => r.id)).toEqual(['fx-1']);
      expect(second.body[0].divergence).toBeCloseTo(0.1111, 4);
      expect(second.headers['x-next-cursor']).toBeUndefined();

      await h.http().get('/v1/admin/fx?limit=101').set(auth(admin.token)).expect(400);
      const u = await trader();
      await h.http().get('/v1/admin/fx').set(auth(u.token)).expect(403);
    });
  });
});
