/** Risk numbers for the admin console (brief 8.4) and the alert thresholds (brief 12.3). Pure: tested without a database. */
export const FAILURE_RATE_ALERT = 0.05; // failure rate over 7 days
export const DISPUTE_RATE_ALERT = 0.08; // dispute rate over 7 days
export const PAIR_MIN_POOLS = 3; // a pair needs at least this many pools to be worth flagging
export const PAIR_SHARE_ALERT = 0.6; // share of one organizer's pools that go to a single supplier

export interface PoolFact {
  id: string;
  state: string;
  supplier: string;
  organizer: string;
  category?: string;
  nigerianState?: string;
  /** What the pool holds in escrow now (stroops). */
  escrow: bigint;
  /** Value delivered: received units x final price (stroops); 0 until delivered. */
  gross: bigint;
  /** Total pool value in stroops, used for organizer-supplier concentration. */
  volume?: bigint;
  /** When we first saw it, and when it ended (settled/failed/expired/cancelled), if it has. */
  indexedAt: Date;
  endedAt: Date | null;
  deliveredAt?: Date | null;
}

export interface DisputeFact {
  poolId: string;
  supplier: string;
  openedAt: Date;
}

export interface Flag {
  kind: 'FAILURE_RATE' | 'DISPUTE_RATE' | 'PAIR_CONCENTRATION';
  message: string;
  subject?: string;
}

export interface RiskOverview {
  gmv: bigint;
  escrowHeld: bigint;
  poolsByState: Record<string, number>;
  failureRate7d: number;
  dispute7d: { disputes: number; deliveredPools: number; rate: number };
  bySupplier: { supplier: string; pools: number; disputes: number; disputeRate: number }[];
  pairs: { organizer: string; supplier: string; pools: number; shareOfOrganizer: number; volume: bigint }[];
  flags: Flag[];
}

export type RiskSlice = 'supplier' | 'category' | 'state';

export interface RiskRates {
  slice: RiskSlice;
  values: {
    value: string;
    failedPools7d: number;
    completedPools7d: number;
    failureRate7d: number;
    disputedPools7d: number;
    deliveredPools7d: number;
    disputeRate7d: number;
    failedPools30d: number;
    completedPools30d: number;
    failureRate30d: number;
    disputedPools30d: number;
    deliveredPools30d: number;
    disputeRate30d: number;
  }[];
}

const FAILED = new Set(['Failed', 'Expired', 'Cancelled']);
const DELIVERED = new Set(['Delivered', 'Settled']);
const DAY = 86_400_000;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

function sliceValue(pool: PoolFact, slice: RiskSlice): string {
  if (slice === 'supplier') return pool.supplier;
  if (slice === 'category') return pool.category ?? 'Uncategorized';
  return pool.nigerianState ?? 'Unknown';
}

/** Failure and dispute rates for each requested slice over matching 7- and 30-day windows. */
export function riskRates(pools: readonly PoolFact[], disputes: readonly DisputeFact[], now: Date, slice: RiskSlice): RiskRates {
  const grouped = new Map<string, {
    failedPools7d: number; completedPools7d: number; disputedPools7d: number; deliveredPools7d: number;
    failedPools30d: number; completedPools30d: number; disputedPools30d: number; deliveredPools30d: number;
  }>();
  const disputesByPool = new Map<string, DisputeFact[]>();
  for (const dispute of disputes) {
    const poolDisputes = disputesByPool.get(dispute.poolId) ?? [];
    poolDisputes.push(dispute);
    disputesByPool.set(dispute.poolId, poolDisputes);
  }

  for (const pool of pools) {
    const value = sliceValue(pool, slice);
    const totals = grouped.get(value) ?? {
      failedPools7d: 0, completedPools7d: 0, disputedPools7d: 0, deliveredPools7d: 0,
      failedPools30d: 0, completedPools30d: 0, disputedPools30d: 0, deliveredPools30d: 0,
    };
    for (const days of [7, 30] as const) {
      const since = now.getTime() - days * DAY;
      const endedInWindow = pool.endedAt !== null && pool.endedAt.getTime() >= since;
      const deliveredAt = pool.deliveredAt ?? (DELIVERED.has(pool.state) ? pool.endedAt ?? pool.indexedAt : null);
      const deliveredInWindow = deliveredAt !== null && deliveredAt.getTime() >= since;
      const isFailed = FAILED.has(pool.state);
      const isCompleted = isFailed || pool.state === 'Settled';
      const isDelivered = DELIVERED.has(pool.state);
      const disputesInWindow = (disputesByPool.get(pool.id) ?? []).some((d) => d.openedAt.getTime() >= since);
      if (days === 7) {
        if (endedInWindow && isCompleted) totals.completedPools7d++;
        if (endedInWindow && isFailed) totals.failedPools7d++;
        if (deliveredInWindow && isDelivered) totals.deliveredPools7d++;
        if (deliveredInWindow && isDelivered && disputesInWindow) totals.disputedPools7d++;
      } else {
        if (endedInWindow && isCompleted) totals.completedPools30d++;
        if (endedInWindow && isFailed) totals.failedPools30d++;
        if (deliveredInWindow && isDelivered) totals.deliveredPools30d++;
        if (deliveredInWindow && isDelivered && disputesInWindow) totals.disputedPools30d++;
      }
    }
    grouped.set(value, totals);
  }

  return {
    slice,
    values: [...grouped.entries()].map(([value, n]) => ({
      value,
      ...n,
      failureRate7d: ratio(n.failedPools7d, n.completedPools7d),
      disputeRate7d: ratio(n.disputedPools7d, n.deliveredPools7d),
      failureRate30d: ratio(n.failedPools30d, n.completedPools30d),
      disputeRate30d: ratio(n.disputedPools30d, n.deliveredPools30d),
    })).sort((a, b) => a.value.localeCompare(b.value)),
  };
}

function organizerSupplierPairs(pools: readonly PoolFact[]) {
  const perOrganizer = new Map<string, number>();
  const grouped = new Map<string, { organizer: string; supplier: string; pools: number; volume: bigint }>();
  for (const pool of pools) {
    perOrganizer.set(pool.organizer, (perOrganizer.get(pool.organizer) ?? 0) + 1);
    const key = `${pool.organizer}|${pool.supplier}`;
    const pair = grouped.get(key) ?? { organizer: pool.organizer, supplier: pool.supplier, pools: 0, volume: 0n };
    pair.pools++;
    pair.volume += pool.volume ?? pool.gross;
    grouped.set(key, pair);
  }
  return [...grouped.values()]
    .map((pair) => ({ ...pair, shareOfOrganizer: ratio(pair.pools, perOrganizer.get(pair.organizer) ?? 0) }))
    .sort((a, b) => b.pools - a.pools || a.organizer.localeCompare(b.organizer) || a.supplier.localeCompare(b.supplier));
}

/** Returns organizer-supplier pairs that meet the configurable share threshold and minimum evidence count. */
export function pairConcentration(
  pools: readonly PoolFact[],
  threshold = PAIR_SHARE_ALERT,
  minimumPools = PAIR_MIN_POOLS,
) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError('threshold must be between 0 and 1');
  return organizerSupplierPairs(pools).filter((pair) => pair.pools >= minimumPools && pair.shareOfOrganizer >= threshold);
}

export function riskOverview(pools: readonly PoolFact[], disputes: readonly DisputeFact[], now: Date, pairShareThreshold = PAIR_SHARE_ALERT): RiskOverview {
  const since = now.getTime() - 7 * DAY;
  const poolsByState: Record<string, number> = {};
  for (const p of pools) poolsByState[p.state] = (poolsByState[p.state] ?? 0) + 1;

  const ended7d = pools.filter((p) => p.endedAt && p.endedAt.getTime() >= since && (FAILED.has(p.state) || p.state === 'Settled'));
  const failed7d = ended7d.filter((p) => FAILED.has(p.state)).length;
  const failureRate7d = ratio(failed7d, ended7d.length);

  const delivered = pools.filter((p) => DELIVERED.has(p.state));
  const disputes7d = disputes.filter((d) => d.openedAt.getTime() >= since);
  const dispute7d = { disputes: disputes7d.length, deliveredPools: delivered.length, rate: ratio(disputes7d.length, delivered.length) };

  const sup = new Map<string, { pools: number; disputes: number }>();
  for (const p of delivered) sup.set(p.supplier, { pools: (sup.get(p.supplier)?.pools ?? 0) + 1, disputes: sup.get(p.supplier)?.disputes ?? 0 });
  for (const d of disputes) {
    const e = sup.get(d.supplier);
    if (e) e.disputes++;
  }
  const bySupplier = [...sup.entries()].map(([supplier, v]) => ({ supplier, ...v, disputeRate: ratio(v.disputes, v.pools) })).sort((a, b) => b.disputeRate - a.disputeRate || b.pools - a.pools);

  const pairs = organizerSupplierPairs(pools);

  const flags: Flag[] = [];
  if (ended7d.length > 0 && failureRate7d > FAILURE_RATE_ALERT) flags.push({ kind: 'FAILURE_RATE', message: `Pool failure rate is ${(failureRate7d * 100).toFixed(1)}% over 7 days (limit ${FAILURE_RATE_ALERT * 100}%)` });
  if (delivered.length > 0 && dispute7d.rate > DISPUTE_RATE_ALERT) flags.push({ kind: 'DISPUTE_RATE', message: `Dispute rate is ${(dispute7d.rate * 100).toFixed(1)}% over 7 days (limit ${DISPUTE_RATE_ALERT * 100}%)` });
  for (const x of pairs) {
    if (x.pools >= PAIR_MIN_POOLS && x.shareOfOrganizer >= pairShareThreshold) flags.push({
      kind: 'PAIR_CONCENTRATION', subject: `${x.organizer}|${x.supplier}`,
      message: `${x.pools} pools (${Math.round(x.shareOfOrganizer * 100)}% of this organizer's) go to one supplier: review for collusion`,
    });
  }

  return {
    gmv: pools.reduce((s, p) => s + p.gross, 0n),
    escrowHeld: pools.reduce((s, p) => s + p.escrow, 0n),
    poolsByState, failureRate7d, dispute7d, bySupplier, pairs, flags,
  };
}
