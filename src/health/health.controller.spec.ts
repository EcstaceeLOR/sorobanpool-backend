import { ServiceUnavailableException } from '@nestjs/common';
import { DEFAULT_INDEXER_LAG_ALERT_LEDGERS } from '../config/env.js';
import { checkReadiness, HealthController, indexerSignal, READY_CHECK_TIMEOUT_MS, type ReadinessDeps } from './health.controller.js';

const healthy = (): ReadinessDeps => ({
  database: async () => [{ '?column?': 1 }],
  latestLedger: async () => 1_000,
  indexerCursor: async () => 995,
});
const boom = (msg: string) => async () => { throw new Error(msg); };

const lagging = (): ReadinessDeps => ({ ...healthy(), indexerCursor: async () => 1_000 - DEFAULT_INDEXER_LAG_ALERT_LEDGERS - 1 });

describe('HealthController', () => {
  it('reports ok on /health and /health/live without failing when lag is unknown', async () => {
    const c = new HealthController({ env: { INDEXER_LAG_ALERT_LEDGERS: DEFAULT_INDEXER_LAG_ALERT_LEDGERS } } as never, {
      ...healthy(), latestLedger: boom('down'),
    });
    const body = await c.check();
    expect(body.status).toBe('ok');
    expect(body.indexer).toBe('skipped');
    expect(c.live()).toEqual({ status: 'ok' });
  });

  it('reports indexer: degraded on /health with simulated lag (#85)', async () => {
    const c = new HealthController({ env: { INDEXER_LAG_ALERT_LEDGERS: DEFAULT_INDEXER_LAG_ALERT_LEDGERS } } as never, lagging());
    expect(await c.check()).toMatchObject({ status: 'ok', indexer: 'degraded' });
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
    const r = await checkReadiness(lagging());
    expect(r.failing).toEqual(['indexer']);
    expect(r.checks.indexer).toMatch(/lagging by 21 ledgers/);
  });

  it('takes the threshold from the configured env value', async () => {
    const r = await checkReadiness(healthy(), READY_CHECK_TIMEOUT_MS, 4);
    expect(r.failing).toEqual(['indexer']);
    expect(r.checks.indexer).toMatch(/lagging by 5 ledgers \(limit 4\)/);
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
    const s = { env: { INDEXER_LAG_ALERT_LEDGERS: DEFAULT_INDEXER_LAG_ALERT_LEDGERS }, prisma: { $queryRaw: boom('db down'), indexerCursor: { findUnique: async () => null } }, chain: { latestLedger: async () => 1 } };
    const err = await new HealthController(s as never).ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ error: 'NOT_READY', failing: ['database'] });
  });
});

describe('indexerSignal', () => {
  it('exposes the lag for the metrics gauge', async () => {
    expect(await indexerSignal(lagging())).toMatchObject({ status: 'degraded', lag: DEFAULT_INDEXER_LAG_ALERT_LEDGERS + 1 });
    expect(await indexerSignal({ ...healthy(), indexerCursor: async () => undefined })).toMatchObject({ status: 'skipped' });
  });
});
