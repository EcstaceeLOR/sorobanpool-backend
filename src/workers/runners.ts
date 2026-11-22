import { rpc } from '@stellar/stellar-sdk';
import { A } from '../chain/args.js';
import type { RawEvent } from '../indexer/decode.js';
import { Indexer, type RpcPort } from '../indexer/indexer.service.js';
import { Projector } from '../indexer/projector.js';
import { dueActions, runKeeper, type ChainPort as KeeperChain, type KeeperAction, type KeeperDispute, type KeeperParams, type KeeperPool } from '../keeper/jobs.js';
import { PrismaCursorStore, PrismaEventSink, PrismaReadStore } from '../persistence/prisma-stores.js';
import type { PoolState } from '../indexer/read-model.js';
import { CONTRACT_NAMES } from '../chain/deployments.js';
import type { ErrorReporter } from '../observability/errors.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { Metrics } from '../observability/metrics.js';
import type { Services } from '../app/services.js';
import { combineQuotes } from '../fx/fx.js';
import { dispatchDue, NotificationProducer, queueDeadlineReminders } from '../notifications/dispatcher.js';
import { checkSponsor, expireOffers, expireStaleAnchorTransfers, MismatchTracker, purgeIdempotencyKeys, reconcilePools, refreshFx } from './maintenance.js';

/**
 * Soroban RPC adapter for the indexer. The Indexer treats `endLedger` as inclusive, but the RPC's `endLedger`
 * is EXCLUSIVE (verified live: start=N,end=N returns nothing; start=N,end=N+1 returns ledger N). Passing it
 * through unchanged silently loses every event in the newest ledger of each polling window, so it is shifted by one.
 */
export function rpcPort(server: Pick<rpc.Server, 'getLatestLedger' | 'getHealth' | 'getEvents'>): RpcPort {
  return {
    latestLedger: async () => (await server.getLatestLedger()).sequence,
    oldestLedger: async () => (await server.getHealth()).oldestLedger,
    getEvents: async (startLedger, endLedger, contractIds) => {
      // Soroban RPC allows at most 5 contract ids per filter (and 5 filters).
      const filters: { type: 'contract'; contractIds: string[] }[] = [];
      for (let i = 0; i < contractIds.length; i += 5) filters.push({ type: 'contract', contractIds: contractIds.slice(i, i + 5) });
      const out: RawEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await server.getEvents(cursor ? { cursor, filters, limit: 200 } : { startLedger, endLedger: endLedger + 1, filters, limit: 200 });
        for (const e of res.events) {
          out.push({
            id: e.id, ledger: e.ledger, ledgerClosedAt: e.ledgerClosedAt, contractId: String(e.contractId ?? ''),
            topic: e.topic.map((t) => t.toXDR('base64')), value: e.value.toXDR('base64'),
          });
        }
        if (res.events.length < 200) break;
        cursor = res.cursor;
      }
      return out;
    },
  };
}

export interface Runner {
  /** Starts no new tick, and resolves once a tick already in progress has finished (graceful shutdown, #145). */
  stop(): Promise<void>;
}

/** Options for the interval runner. */
export interface RunnerOptions {
  reporter?: ErrorReporter;
  /** Prometheus metrics registry for per-job instrumentation (#92). */
  metrics?: Metrics;
  /**
   * Optional distributed lock (#91). Called before each tick; if it returns false this replica
   * skips that tick (another replica is already running it). Use pgAdvisoryLock for Postgres.
   */
  lock?: (name: string) => Promise<boolean>;
}

/**
 * Returns a per-process advisory-lock function backed by Postgres session locks (#91).
 * Once this process acquires the lock it is cached locally (session locks are held until the
 * connection closes), so subsequent ticks skip the round-trip and always return true.
 * A second process/replica calling pg_try_advisory_lock with the same key gets false and skips.
 */
export function pgAdvisoryLock(prisma: PrismaClient): (name: string) => Promise<boolean> {
  const SP_LOCK_CLASS = 783_291; // arbitrary SorobanPool marker (avoids collisions with app locks)
  const held = new Set<number>();
  const hashName = (s: string) => {
    let h = 0x811c9dc5;
    for (const c of s) h = (Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0);
    return h | 0; // signed int32 for the two-int pg_try_advisory_lock overload
  };
  return async (name: string): Promise<boolean> => {
    const key = hashName(name);
    if (held.has(key)) return true; // this process already holds the lock on its long-lived connection
    const rows = await prisma.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
      SELECT pg_try_advisory_lock(${SP_LOCK_CLASS}::integer, ${key}::integer)`;
    const acquired = rows[0]?.pg_try_advisory_lock ?? false;
    if (acquired) held.add(key);
    return acquired;
  };
}

/** Runs `fn` every `ms`, never overlapping, logging failures instead of crashing the process. */
export function every(name: string, ms: number, fn: () => Promise<void>, opts?: RunnerOptions): Runner {
  let busy = false;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  const { reporter, metrics, lock } = opts ?? {};
  const tick = async () => {
    if (lock) {
      const acquired = await lock(name).catch(() => false);
      if (!acquired) { busy = false; return; }
    }
    try {
      await fn();
      metrics?.inc('sp_keeper_runs_total', { job: name });
      metrics?.setGauge('sp_keeper_last_success_timestamp', { job: name }, Date.now() / 1000);
    } catch (e) {
      console.error(`[${name}] ${(e as Error).message}`);
      reporter?.capture(e, name);
      metrics?.inc('sp_keeper_runs_total', { job: name });
      metrics?.inc('sp_keeper_failures_total', { job: name });
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    current = tick();
  }, ms);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(t);
      await current;
    },
  };
}

export function startIndexer(s: Services, server: rpc.Server, intervalMs = 5000, metrics?: Metrics): { runner: Runner; indexer: Indexer } {
  const ids = CONTRACT_NAMES.map((n) => s.deployments.contracts[n].id);
  const producer = new NotificationProducer(s.prisma, async () => combineQuotes(await s.fx.quotes(), s.now()).rate, s.now);
  const indexer = new Indexer(
    rpcPort(server), new PrismaCursorStore(s.prisma), new PrismaEventSink(s.prisma), new Projector(new PrismaReadStore(s.prisma)), ids, s.env.INDEXER_START_LEDGER ?? (s.deployments.deployedAtLedger ? { from: s.deployments.deployedAtLedger } : 'oldest'), 1000,
    (ev) => producer.onEvent(ev), s.env.INDEXER_LAG_ALERT_LEDGERS, metrics,
  );
  const runner = every('indexer', intervalMs, async () => {
    await indexer.tick();
    if (indexer.shouldAlert) console.error(`[indexer] ALERT lag=${indexer.metrics.lag} ledgers`);
  }, { reporter: s.reporter });
  return { runner, indexer };
}

const FINAL: PoolState[] = ['Settled', 'Expired', 'Failed', 'Cancelled'];
const secs = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : 0);

/** Contract parameters the keeper needs, read from `config.get_params` (u64 fields arrive as bigint). */
export async function keeperParams(s: Services): Promise<KeeperParams> {
  const p = await s.chain.view<Record<string, bigint | number>>('config', 'get_params');
  return {
    acceptWindowSecs: Number(p.accept_window_secs), deliveryGraceSecs: Number(p.delivery_grace_secs), confirmWindowSecs: Number(p.confirm_window_secs),
    perishableConfirmWindowSecs: Number(p.perishable_confirm_window_secs), earlyReleaseWeightBp: Number(p.early_release_weight_bp), arbitrationSlaSecs: Number(p.arbitration_sla_secs),
  };
}

export async function loadKeeperState(s: Services): Promise<{ pools: KeeperPool[]; disputes: KeeperDispute[] }> {
  const rows = await s.prisma.pool.findMany({ where: { OR: [{ state: { notIn: FINAL } }, { AND: [{ state: { in: FINAL } }, { refundsPushed: false }] }] } });
  const offers = new Map((await s.prisma.offer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.offerId))] } } })).map((o) => [o.id, o]));
  const pools: KeeperPool[] = rows.map((p) => ({
    id: p.id, state: p.state as PoolState, perishable: offers.get(p.offerId)?.perishable ?? false, totalUnits: p.totalUnits, pickedUnits: p.pickedUnits,
    leadTimeSecs: (offers.get(p.offerId)?.leadTimeHours ?? 0) * 3600, fillDeadline: secs(p.fillDeadline), filledAt: secs(p.filledAt), acceptedAt: secs(p.acceptedAt),
    deliveredAt: secs(p.deliveredAt), allocationPending: p.allocationPending, hasUnclaimedRefunds: FINAL.includes(p.state as PoolState) && !p.refundsPushed && p.escrowBalance.gt(0),
  }));
  const open = await s.prisma.dispute.findMany({ where: { state: 'OPEN' } });
  return { pools, disputes: open.map((d) => ({ id: d.id, open: true, openedAt: secs(d.openedAt) })) };
}

export function keeperChain(s: Services): KeeperChain {
  const call = async (a: KeeperAction): Promise<unknown> => {
    switch (a.fn) {
      case 'timeout': return s.chain.invokeServer('disputes', 'timeout', A.disputeTimeout(a.args[0]));
      case 'allocate_shortfall': return s.chain.invokeServer('group_buy', 'allocate_shortfall', A.poolBatch(a.args[0], a.args[1]));
      case 'push_refunds': {
        const r = await s.chain.invokeServer('group_buy', 'push_refunds', A.poolBatch(a.args[0], a.args[1]));
        if (Number(r.returnValue ?? 1) === 0) await s.prisma.pool.update({ where: { id: a.args[0] }, data: { refundsPushed: true } });
        return r;
      }
      default: return s.chain.invokeServer('group_buy', a.fn, A.poolOnly(a.args[0]));
    }
  };
  return {
    invoke: async (a) => {
      try {
        await call(a);
        return true;
      } catch (e) {
        // The chain re-checks every condition; a refusal (wrong state / too early) is expected and harmless.
        if (/Error\(Contract, #\d+\)/.test((e as Error).message)) return false;
        throw e;
      }
    },
  };
}

export async function keeperTick(s: Services): Promise<{ ok: number; refused: number; errored: number }> {
  // A final pool whose escrow has reached zero owes nobody anything: stop scanning it.
  await s.prisma.pool.updateMany({ where: { state: { in: FINAL }, refundsPushed: false, escrowBalance: { lte: 0 } }, data: { refundsPushed: true } });
  const { pools, disputes } = await loadKeeperState(s);
  const actions = dueActions(pools, disputes, await keeperParams(s), Math.floor(s.now().getTime() / 1000));
  return runKeeper(keeperChain(s), actions, (a, e) => console.error(`[keeper] ${a.job} ${String(a.args[0])}: ${(e as Error).message}`));
}

export function startKeeper(s: Services, intervalMs = 15_000, opts?: { metrics?: Metrics; lock?: (name: string) => Promise<boolean> }): Runner {
  return every('keeper', intervalMs, async () => {
    const r = await keeperTick(s);
    if (r.ok || r.errored) console.log(`[keeper] ok=${r.ok} refused=${r.refused} errored=${r.errored}`);
    if (opts?.metrics) {
      if (r.ok)      opts.metrics.inc('sp_keeper_actions_total', { job: 'keeper', result: 'ok' }, r.ok);
      if (r.refused) opts.metrics.inc('sp_keeper_actions_total', { job: 'keeper', result: 'refused' }, r.refused);
      if (r.errored) opts.metrics.inc('sp_keeper_actions_total', { job: 'keeper', result: 'errored' }, r.errored);
    }
  }, { reporter: s.reporter, ...opts });
}

/** Hourly: extend contract instance/code TTL before they lapse. A missing entry is a paging-level problem. */
/** Wallet and bond instances checked per run; each rotates through the full set over successive runs. */
export const WALLETS_PER_TTL_RUN = 25;
/** Bond contract instances per TTL run (#94). Bonds are standalone contracts like smart wallets. */
export const BONDS_PER_TTL_RUN = 20;

export function startTtlKeeper(s: Services, intervalMs = 3_600_000, opts?: { metrics?: Metrics; lock?: (name: string) => Promise<boolean> }): Runner {
  let walletOffset = 0;
  let bondOffset = 0;
  return every('ttl-extend', intervalMs, async () => {
    // Wallet instances (paginated, rotating)
    const walletBatch = await s.prisma.user.findMany({
      where: { walletAddress: { startsWith: 'C' } }, select: { walletAddress: true }, orderBy: { id: 'asc' }, skip: walletOffset, take: WALLETS_PER_TTL_RUN,
    });
    walletOffset = walletBatch.length < WALLETS_PER_TTL_RUN ? 0 : walletOffset + walletBatch.length;
    const wr = await s.chain.keepAlive(walletBatch.map((b) => b.walletAddress!));
    if (wr.missing.length) console.error(`[ttl-extend] ALERT wallet entries not found (archived?): ${wr.missing.join(', ')}`);
    if (wr.extended.length) console.log(`[ttl-extend] extended wallets ${wr.extended.join(', ')} in ${wr.txHash}`);

    // Bond contract instances (#94): bonds are standalone contracts per supplier, treated like wallets
    const bondBatch = await s.prisma.bond.findMany({
      select: { supplierAddress: true }, orderBy: { supplierAddress: 'asc' }, skip: bondOffset, take: BONDS_PER_TTL_RUN,
    });
    bondOffset = bondBatch.length < BONDS_PER_TTL_RUN ? 0 : bondOffset + bondBatch.length;
    if (bondBatch.length) {
      const br = await s.chain.keepAlive(bondBatch.map((b) => b.supplierAddress));
      if (br.missing.length) console.error(`[ttl-extend] ALERT bond entries not found (archived?): ${br.missing.join(', ')}`);
      if (br.extended.length) console.log(`[ttl-extend] extended bonds ${br.extended.join(', ')} in ${br.txHash}`);
    }

    // Open dispute data entries (#94): log count so the runbook alert can fire if entries near expiry
    const openCount = await s.prisma.dispute.count({ where: { state: 'OPEN' } });
    if (openCount) console.log(`[ttl-extend] ${openCount} open dispute(s): instance covered via core contracts; persistent data keys via disputeDataKeys if wired`);
  }, { reporter: s.reporter, ...opts });
}

/** Every 5 minutes: expire stale offers, anchor transfers, and page when the fee sponsor runs low. */
export function startMaintenance(s: Services, intervalMs = 300_000): Runner {
  const tracker = new MismatchTracker();
  return every('maintenance', intervalMs, async () => {
    const n = await expireOffers(s.prisma, s.now());
    if (n) console.log(`[maintenance] expired ${n} offer(s)`);
    const reminded = await queueDeadlineReminders(s.prisma, s.now());
    if (reminded) console.log(`[maintenance] queued ${reminded} deadline reminder(s)`);
    const purged = await purgeIdempotencyKeys(s.prisma, s.now(), s.env.IDEMPOTENCY_RETENTION_DAYS);
    if (purged) console.log(`[maintenance] deleted ${purged} expired idempotency key(s)`);
    const expiredTransfers = await expireStaleAnchorTransfers(s.prisma, s.now(), s.env.ANCHOR_TRANSFER_EXPIRY_MINUTES);
    if (expiredTransfers.expired) console.log(`[maintenance] expired ${expiredTransfers.expired} anchor transfer(s)`);
    const bad = tracker.persistent(await reconcilePools(s.prisma, s.chain as never, A.poolOnly));
    for (const m of bad) console.error(`[reconcile] ALERT pool ${m.poolId} ${m.field}: db=${m.db} chain=${m.chain}`);
    const h = await checkSponsor(s.chain, s.env.SPONSOR_MIN_XLM);
    if (h.low) console.error(`[maintenance] ALERT sponsor balance ${Number(h.balanceStroops) / 1e7} XLM is below ${s.env.SPONSOR_MIN_XLM}`);
  }, { reporter: s.reporter });
}

/** Every minute: `fx-refresh` (brief 7.7). Alerts while sources diverge, because offer publishing is blocked then. */
export function startFxRefresh(s: Services, intervalMs = 60_000): Runner {
  return every('fx-refresh', intervalMs, async () => {
    const r = await refreshFx(s.prisma, s.fx, s.now());
    if (r.blocked) console.error(`[fx-refresh] ALERT offer publishing blocked: ${r.reason}`);
  }, { reporter: s.reporter });
}

/** Every 30 seconds: send due SMS (quiet hours are applied when queued; failures back off). */
export function startNotifier(s: Services, intervalMs = 30_000): Runner {
  return every('notifier', intervalMs, async () => {
    const r = await dispatchDue(s.prisma, s.sms, s.now());
    if (r.sent || r.failed) console.log(`[notifier] sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
  }, { reporter: s.reporter });
}