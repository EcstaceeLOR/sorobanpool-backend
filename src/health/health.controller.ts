import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../app/http.js';
import { SERVICES, type Services } from '../app/services.js';
import { LAG_ALERT_LEDGERS } from '../indexer/indexer.service.js';

/** Upper bound for each readiness probe, so a hung dependency fails the check instead of hanging the probe. */
export const READY_CHECK_TIMEOUT_MS = 2_000;

/** What readiness depends on. Redis is not listed: no request path uses it yet. */
export interface ReadinessDeps {
  database(): Promise<unknown>;
  latestLedger(): Promise<number>;
  /** Last ledger the indexer has processed, or undefined before its first run. */
  indexerCursor(): Promise<number | undefined>;
}

export interface Readiness {
  ready: boolean;
  /** `ok`, `skipped`, or the reason the check failed. */
  checks: { database: string; rpc: string; indexer: string };
  failing: string[];
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Checks every dependency independently and reports which ones fail (#144). */
export async function checkReadiness(deps: ReadinessDeps, timeoutMs = READY_CHECK_TIMEOUT_MS): Promise<Readiness> {
  const [db, ledger, cursor] = await Promise.allSettled([
    within(deps.database(), timeoutMs),
    within(deps.latestLedger(), timeoutMs),
    within(deps.indexerCursor(), timeoutMs),
  ]);
  const checks: Readiness['checks'] = {
    database: db.status === 'fulfilled' ? 'ok' : reason(db.reason),
    rpc: ledger.status === 'fulfilled' ? 'ok' : reason(ledger.reason),
    indexer: 'skipped',
  };
  // Lag needs both the chain tip and the cursor; before the indexer's first run there is nothing to compare.
  if (cursor.status === 'rejected') checks.indexer = reason(cursor.reason);
  else if (ledger.status === 'fulfilled' && cursor.value !== undefined) {
    const lag = ledger.value - cursor.value;
    checks.indexer = lag > LAG_ALERT_LEDGERS ? `lagging by ${lag} ledgers (limit ${LAG_ALERT_LEDGERS})` : 'ok';
  }
  const failing = Object.entries(checks).filter(([, v]) => v !== 'ok' && v !== 'skipped').map(([k]) => k);
  return { ready: failing.length === 0, checks, failing };
}

export const readinessDeps = (s: Services): ReadinessDeps => ({
  database: () => s.prisma.$queryRaw`SELECT 1`,
  latestLedger: () => s.chain.latestLedger(),
  indexerCursor: async () => (await s.prisma.indexerCursor.findUnique({ where: { id: 'main' } }))?.lastLedger,
});

@Controller('health')
export class HealthController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** Kept for existing probes and dashboards: same as `live`, plus the process role. */
  @Public() @Get()
  check(): { status: 'ok'; role: string } {
    return { status: 'ok', role: process.env.ROLE ?? 'api' };
  }

  /** Liveness: the process is up and serving. Never touches a dependency, so an outage cannot cause restart loops. */
  @Public() @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: 200 when the database, RPC and indexer are healthy, otherwise 503 naming the failing ones. */
  @Public() @Get('ready')
  async ready(): Promise<{ status: 'ready'; checks: Readiness['checks'] }> {
    const r = await checkReadiness(readinessDeps(this.s));
    if (!r.ready) {
      throw new ServiceUnavailableException({ error: 'NOT_READY', message: `Not ready: ${r.failing.join(', ')}`, failing: r.failing, checks: r.checks });
    }
    return { status: 'ready', checks: r.checks };
  }
}
