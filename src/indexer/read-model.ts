import type { DecodedEvent } from './decode.js';

export type PoolState =
  | 'Open' | 'Filled' | 'Accepted' | 'Dispatched' | 'Delivered' | 'Settled' | 'Expired' | 'Failed' | 'Cancelled';

export interface PoolRow {
  id: bigint;
  organizer: string;
  supplier: string;
  offerHash: string;
  /** Links this pool to the off-chain hub details recorded when the pool was prepared. */
  hubHash: string;
  state: PoolState;
  totalUnits: number;
  receivedUnits: number | null;
  currentTierIdx: number;
  /** Final unit price once Filled, else unset (0n). */
  finalUnitPrice: bigint;
  escrowBalance: bigint;
  frozenAmount: bigint;
  advancePaid: bigint;
  filledAt: Date | null;
  acceptedAt: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  pickedUnits: number;
  /** From the `settled` event: what the supplier, the platform and the organizer were paid. */
  supplierNet: bigint;
  platformFee: bigint;
  organizerFee: bigint;
  /** When the pool ended (settled, expired, failed or cancelled). */
  endedAt: Date | null;
  /** True from a short delivery until alloc_ok. */
  allocationPending: boolean;
  refundsPushed: boolean;
  lastEventLedger: number;
}

export interface CommitmentRow {
  poolId: bigint;
  member: string;
  units: number;
  paid: bigint;
  refundClaimed: bigint;
  pickedUp: boolean;
}

export interface DisputeRow {
  id: bigint;
  poolId: bigint;
  opener: string;
  claimedAmount: bigint;
  openedAt: Date;
  state: 'OPEN' | 'RESOLVED' | 'TIMED_OUT';
  /** Number of `d_evid` events seen; the arbiter views need this without another DB query. */
  evidenceCount: number;
  /** When RESOLVED/TIMED_OUT stopped the SLA clock; null while OPEN. */
  closedAt: Date | null;
  arbiter?: string;
  reasoningHash?: string;
}

export interface BondRow {
  supplier: string;
  total: bigint;
  reserved: bigint;
  /** Cumulative slash amounts from `slashed` events: what was asked for and what the bond could cover. */
  slashRequested: bigint;
  slashActual: bigint;
  lastEventLedger: number;
}

export interface ReputationTierRow {
  subject: string;
  role: string;
  tier: number;
}

/** One plain event in a pool's activity feed. `actor` is a full address kept server-side only. */
export interface ActivityEventRow {
  poolId: bigint;
  type: string;
  actor?: string;
  units?: number;
  tier?: number;
  ledger: number;
  occurredAt: Date;
  /** Aggregate events have no member identity and are safe for anyone to see. */
  aggregate: boolean;
}

export interface ActivityRow extends ActivityEventRow {
  seq: number;
}

/** JSON shape returned by GET /pools/:id/activity: no raw addresses, no XDR, no payloads. */
export interface ActivityView {
  id: string;
  type: string;
  message: string;
  at: string;
  ledger: number;
  actor?: string;
  units?: number;
  tier?: number;
}

const ACTIVITY: Record<string, { type: string; message: string; aggregate: boolean }> = {
  'group_buy.pool_new': { type: 'created', message: 'Pool created', aggregate: true },
  'group_buy.committed': { type: 'joined', message: 'A member joined the pool', aggregate: false },
  'group_buy.commit_up': { type: 'increased', message: 'A member added units', aggregate: false },
  'group_buy.withdrawn': { type: 'left', message: 'A member withdrew', aggregate: false },
  'group_buy.tier_up': { type: 'price_break', message: 'A price break was reached', aggregate: true },
  'group_buy.filled': { type: 'filled', message: 'The pool filled', aggregate: true },
  'group_buy.expired': { type: 'expired', message: 'The pool expired', aggregate: true },
  'group_buy.cancelled': { type: 'cancelled', message: 'The pool was cancelled', aggregate: true },
  'group_buy.accepted': { type: 'accepted', message: 'The supplier accepted', aggregate: true },
  'group_buy.rejected': { type: 'rejected', message: 'The supplier rejected', aggregate: true },
  'group_buy.failed': { type: 'failed', message: 'The pool failed', aggregate: true },
  'group_buy.dispatch': { type: 'dispatched', message: 'The goods were dispatched', aggregate: true },
  'group_buy.advance': { type: 'advanced', message: 'The supplier was advanced funds', aggregate: true },
  'group_buy.delivered': { type: 'delivered', message: 'The goods arrived', aggregate: true },
  'group_buy.shortfall': { type: 'shortfall', message: 'A shortfall was recorded', aggregate: true },
  'group_buy.alloc_ok': { type: 'allocation_confirmed', message: 'Allocation was confirmed', aggregate: true },
  'group_buy.pickup': { type: 'picked_up', message: 'A member picked up their goods', aggregate: false },
  'group_buy.settled': { type: 'settled', message: 'The pool was settled', aggregate: true },
  'group_buy.refund': { type: 'refunded', message: 'A member claimed a refund', aggregate: false },
};

const MESSAGES: Record<string, string> = Object.fromEntries(Object.values(ACTIVITY).map((v) => [v.type, v.message]));
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Maps an indexed contract event to a feed row, or undefined when it is not a pool activity event. */
export function activityFromEvent(ev: DecodedEvent): Omit<ActivityEventRow, 'poolId'> | undefined {
  const kind = ACTIVITY[`${ev.contract}.${ev.event}`];
  if (!kind) return undefined;
  const data: unknown[] = Array.isArray(ev.data) ? ev.data : [];
  const row: { type: string; aggregate: boolean; actor?: string; units?: number; tier?: number } = { type: kind.type, aggregate: kind.aggregate };
  switch (ev.event) {
    case 'committed':
    case 'commit_up':
      row.actor = String(data[0]); row.units = num(data[1]); break;
    case 'withdrawn':
    case 'refund':
      row.actor = String(data[0]); break;
    case 'pickup':
      row.actor = String(ev.data); break;
    case 'tier_up':
      row.tier = num(data[0] ?? ev.data); break;
    case 'filled':
    case 'delivered':
      row.units = num(data[0]); break;
  }
  return { ...row, ledger: ev.ledger, occurredAt: ev.closedAt };
}

/** Stellar addresses and other actor identifiers never leave the API unredacted. */
export function redactAddress(address: string): string {
  const s = address.trim();
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '****';
}

export function activityView(row: ActivityRow): ActivityView {
  return {
    id: String(row.seq),
    type: row.type,
    message: MESSAGES[row.type] ?? row.type,
    at: row.occurredAt.toISOString(),
    ledger: row.ledger,
    ...(row.actor ? { actor: redactAddress(row.actor) } : {}),
    ...(row.units !== null && row.units !== undefined ? { units: row.units } : {}),
    ...(row.tier !== null && row.tier !== undefined ? { tier: row.tier } : {}),
  };
}

/** Persistence port for the projector. The Prisma implementation maps these onto the schema. */
export interface ReadStore {
  pool(id: bigint): Promise<PoolRow | undefined>;
  savePool(row: PoolRow): Promise<void>;
  commitment(poolId: bigint, member: string): Promise<CommitmentRow | undefined>;
  saveCommitment(row: CommitmentRow): Promise<void>;
  dispute(id: bigint): Promise<DisputeRow | undefined>;
  saveDispute(row: DisputeRow): Promise<void>;
  bond(supplier: string): Promise<BondRow | undefined>;
  saveBond(row: BondRow): Promise<void>;
  reputationTier(subject: string, role: string): Promise<ReputationTierRow | undefined>;
  saveReputationTier(row: ReputationTierRow): Promise<void>;
  saveActivity(row: ActivityEventRow): Promise<void>;
  /** True if the event id was already processed; marks it processed otherwise. */
  markProcessed(eventId: string, ev: { ledger: number; contract: string; topic: string }): Promise<boolean>;
  /** Runs `fn` so that all of its writes commit together or not at all. */
  atomically<T>(fn: (s: ReadStore) => Promise<T>): Promise<T>;
}

export class MemoryReadStore implements ReadStore {
  pools = new Map<bigint, PoolRow>();
  commitments = new Map<string, CommitmentRow>();
  disputes = new Map<bigint, DisputeRow>();
  bonds = new Map<string, BondRow>();
  reputationTiers = new Map<string, ReputationTierRow>();
  activities: ActivityRow[] = [];
  processed = new Set<string>();
  async pool(id: bigint) { return this.pools.get(id); }
  async savePool(r: PoolRow) { this.pools.set(r.id, { ...r }); }
  async commitment(p: bigint, m: string) { return this.commitments.get(`${p}:${m}`); }
  async saveCommitment(r: CommitmentRow) { this.commitments.set(`${r.poolId}:${r.member}`, { ...r }); }
  async dispute(id: bigint) { return this.disputes.get(id); }
  async saveDispute(r: DisputeRow) { this.disputes.set(r.id, { ...r }); }
  async bond(s: string) { return this.bonds.get(s); }
  async saveBond(r: BondRow) { this.bonds.set(r.supplier, { ...r }); }
  async reputationTier(subject: string, role: string) { return this.reputationTiers.get(`${subject}:${role}`); }
  async saveReputationTier(r: ReputationTierRow) { this.reputationTiers.set(`${r.subject}:${r.role}`, { ...r }); }
  async saveActivity(r: ActivityEventRow) { this.activities.push({ seq: this.activities.length + 1, ...r }); }
  async markProcessed(id: string) {
    if (this.processed.has(id)) return true;
    this.processed.add(id);
    return false;
  }
  /** Best effort in memory: restores a snapshot if `fn` throws. */
  async atomically<T>(fn: (s: ReadStore) => Promise<T>): Promise<T> {
    const snap = {
      pools: new Map(this.pools), commitments: new Map(this.commitments), disputes: new Map(this.disputes),
      bonds: new Map(this.bonds), reputationTiers: new Map(this.reputationTiers), activities: [...this.activities], processed: new Set(this.processed),
    };
    try {
      return await fn(this);
    } catch (e) {
      Object.assign(this, snap);
      throw e;
    }
  }
}
