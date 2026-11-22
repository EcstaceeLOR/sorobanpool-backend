import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../app/http.js';
import { SERVICES, type Services } from '../app/services.js';
import { DEFAULT_INDEXER_LAG_ALERT_LEDGERS } from '../config/env.js';

/** Upper bound for each readiness probe, so a hung dependency fails the check instead of hanging the probe. */
export const READY_CHECK_TIMEOUT_MS = 2_000;

/** Injection token for tests that need to simulate a lagging indexer without a database or RPC. */
export const READINESS_DEPS = Symbol('READINESS_DEPS');

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

/** Compact signal exposed on GET /health (#85). */
export type IndexerHealth = 'ok' | 'degraded' | 'skipped';

export interface IndexerSignal {
  status: IndexerHealth;
  /** Latest known lag, when both the RPC tip and the cursor are available. */
  lag?: number;
  /** Same wording as the readiness check, so operators see one explanation everywhere. */
  detail: string;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Settled<T> = PromiseSettledResult<T>;

/** Derives the lag signal from a single pair of probes, shared by /health, /health/ready and /metrics. */
function signalFrom(ledger: Settled<number>, cursor: Settled<number | undefined>, lagAlertLedgers: number): IndexerSignal {
  if (cursor.status === 'rejected') return { status: 'skipped', detail: reason(cursor.reason) };
  if (ledger.status === 'rejected' || cursor.value === undefined) return { status: 'skipped', detail: 'skipped' };
  const lag = Math.max(0, ledger.value - cursor.value);
  if (lag > lagAlertLedgers) return { status: 'degraded', lag, detail: `lagging by ${lag} ledgers (limit ${lagAlertLedgers})` };
  return { status: 'ok', lag, detail: 'ok' };
}

/** Best-effort indexer lag signal; never throws, so liveness and metrics stay available during a dependency outage. */
export async function indexerSignal(
  deps: Pick<ReadinessDeps, 'latestLedger' | 'indexerCursor'>,
  lagAlertLedgers = DEFAULT_INDEXER_LAG_ALERT_LEDGERS,
  timeoutMs = READY_CHECK_TIMEOUT_MS,
): Promise<IndexerSignal> {
  const [ledger, cursor] = await Promise.allSettled([
    within(deps.latestLedger(), timeoutMs),
    within(deps.indexerCursor(), timeoutMs),
  ]);
  return signalFrom(ledger, cursor, lagAlertLedgers);
}

/** Checks every dependency independently and reports which ones fail (#144). */
export async function checkReadiness(
  deps: ReadinessDeps,
  timeoutMs = READY_CHECK_TIMEOUT_MS,
  lagAlertLedgers = DEFAULT_INDEXER_LAG_ALERT_LEDGERS,
): Promise<Readiness> {
  const [db, ledger, cursor] = await Promise.allSettled([
    within(deps.database(), timeoutMs),
    within(deps.latestLedger(), timeoutMs),
    within(deps.indexerCursor(), timeoutMs),
  ]);
  const checks: Readiness['checks'] = {
    database: db.status === 'fulfilled' ? 'ok' : reason(db.reason),
    rpc: ledger.status === 'fulfilled' ? 'ok' : reason(ledger.reason),
    indexer: signalFrom(ledger, cursor, lagAlertLedgers).detail,
  };
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
  constructor(
    @Inject(SERVICES) private readonly s: Services,
    @Optional() @Inject(READINESS_DEPS) private readonly overrideDeps?: ReadinessDeps,
  ) {}

  private get deps(): ReadinessDeps {
    return this.overrideDeps ?? readinessDeps(this.s);
  }

  /** Kept for existing probes and dashboards, plus the indexer lag signal from #85. Always answers 200. */
  @Public() @Get()
  async check(): Promise<{ status: 'ok'; role: string; indexer: IndexerHealth }> {
    const indexer = await indexerSignal(this.deps, this.s.env.INDEXER_LAG_ALERT_LEDGERS);
    return { status: 'ok', role: process.env.ROLE ?? 'api', indexer: indexer.status };
  }

  /** Liveness: the process is up and serving. Never touches a dependency, so an outage cannot cause restart loops. */
  @Public() @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: 200 when the database, RPC and indexer are healthy, otherwise 503 naming the failing ones. */
  @Public() @Get('ready')
  async ready(): Promise<{ status: 'ready'; checks: Readiness['checks'] }> {
    const r = await checkReadiness(this.deps, READY_CHECK_TIMEOUT_MS, this.s.env.INDEXER_LAG_ALERT_LEDGERS);
    if (!r.ready) {
      throw new ServiceUnavailableException({ error: 'NOT_READY', message: `Not ready: ${r.failing.join(', ')}`, failing: r.failing, checks: r.checks });
    }
    return { status: 'ready', checks: r.checks };
  }
}
