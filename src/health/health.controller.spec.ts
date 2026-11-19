import { ServiceUnavailableException } from '@nestjs/common';
import { LAG_ALERT_LEDGERS } from '../indexer/indexer.service.js';
import { checkReadiness, HealthController, type ReadinessDeps } from './health.controller.js';

const healthy = (): ReadinessDeps => ({
  database: async () => [{ '?column?': 1 }],
  latestLedger: async () => 1_000,
  indexerCursor: async () => 995,
});
const boom = (msg: string) => async () => { throw new Error(msg); };

describe('HealthController', () => {
  it('reports ok on /health and /health/live without touching any dependency', () => {
    const c = new HealthController({} as never);
    expect(c.check().status).toBe('ok');
    expect(c.live()).toEqual({ status: 'ok' });
  });
});

// #144: readiness lists each failing dependency, tested with each one failing in turn.
describe('checkReadiness', () => {
  it('is ready when every dependency is healthy', async () => {
    expect(await checkReadiness(healthy())).toEqual({ ready: true, failing: [], checks: { database: 'ok', rpc: 'ok', indexer: 'ok' } });
  });

  it.each([
    ['database', { database: boom('connection refused') }, 'connection refused'],
    ['rpc', { latestLedger: boom('ECONNRESET') }, 'ECONNRESET'],
    ['indexer', { indexerCursor: boom('relation does not exist') }, 'relation does not exist'],
  ] as const)('reports %s when it fails', async (name, override, why) => {
    const r = await checkReadiness({ ...healthy(), ...override });
    expect(r.ready).toBe(false);
    expect(r.failing).toEqual([name]);
    expect(r.checks[name]).toBe(why);
  });

  it('fails the indexer when it lags beyond the alert threshold', async () => {
    const r = await checkReadiness({ ...healthy(), indexerCursor: async () => 1_000 - LAG_ALERT_LEDGERS - 1 });
    expect(r.failing).toEqual(['indexer']);
    expect(r.checks.indexer).toMatch(/lagging by 21 ledgers/);
  });

  it('skips the indexer check before its first run, or when the RPC tip is unknown', async () => {
    expect((await checkReadiness({ ...healthy(), indexerCursor: async () => undefined })).checks.indexer).toBe('skipped');
    const r = await checkReadiness({ ...healthy(), latestLedger: boom('down') });
    expect(r.failing).toEqual(['rpc']);
    expect(r.checks.indexer).toBe('skipped');
  });

  it('fails a dependency that does not answer in time', async () => {
    const r = await checkReadiness({ ...healthy(), database: () => new Promise(() => {}) }, 20);
    expect(r.failing).toEqual(['database']);
    expect(r.checks.database).toMatch(/timed out/);
  });

  it('answers 503 with the failing dependencies from /health/ready', async () => {
    const s = { prisma: { $queryRaw: boom('db down'), indexerCursor: { findUnique: async () => null } }, chain: { latestLedger: async () => 1 } };
    const err = await new HealthController(s as never).ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ error: 'NOT_READY', failing: ['database'] });
  });
});
