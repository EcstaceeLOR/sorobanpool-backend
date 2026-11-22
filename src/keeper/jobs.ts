import type { PoolState } from '../indexer/read-model.js';

/** Contract parameters the keeper needs (seconds), mirrored from `config.get_params`. */
export interface KeeperParams {
  acceptWindowSecs: number;
  deliveryGraceSecs: number;
  confirmWindowSecs: number;
  perishableConfirmWindowSecs: number;
  earlyReleaseWeightBp: number;
  arbitrationSlaSecs: number;
}

export interface KeeperPool {
  id: bigint;
  state: PoolState;
  perishable: boolean;
  totalUnits: number;
  pickedUnits: number;
  leadTimeSecs: number;
  fillDeadline: number;
  filledAt: number;
  acceptedAt: number;
  deliveredAt: number;
  /** Shortfall allocation still outstanding (received < total and not fully allocated). */
  allocationPending: boolean;
  /** Final pool with refunds still unclaimed. */
  hasUnclaimedRefunds: boolean;
}

export interface KeeperDispute {
  id: bigint;
  open: boolean;
  openedAt: number;
}

export type KeeperAction =
  | { job: 'close-pools'; fn: 'close'; args: [bigint] }
  | { job: 'fail-accept'; fn: 'fail_accept'; args: [bigint] }
  | { job: 'fail-delivery'; fn: 'fail_delivery'; args: [bigint] }
  | { job: 'allocate'; fn: 'allocate_shortfall'; args: [bigint, number] }
  | { job: 'settle'; fn: 'settle'; args: [bigint] }
  | { job: 'push-refunds'; fn: 'push_refunds'; args: [bigint, number] }
  | { job: 'dispute-timeout'; fn: 'timeout'; args: [bigint] };

export const PUSH_REFUND_BATCH = 25;
export const ALLOCATE_BATCH = 25;

/** Pure: decides what the keeper should send at `nowSecs`. The chain re-checks every condition. */
export function dueActions(
  pools: readonly KeeperPool[],
  disputes: readonly KeeperDispute[],
  p: KeeperParams,
  nowSecs: number,
): KeeperAction[] {
  const out: KeeperAction[] = [];
  for (const pool of pools) {
    switch (pool.state) {
      case 'Open':
        if (nowSecs >= pool.fillDeadline) out.push({ job: 'close-pools', fn: 'close', args: [pool.id] });
        break;
      case 'Filled':
        if (nowSecs > pool.filledAt + p.acceptWindowSecs) out.push({ job: 'fail-accept', fn: 'fail_accept', args: [pool.id] });
        break;
      case 'Accepted':
      case 'Dispatched':
        if (nowSecs > pool.acceptedAt + pool.leadTimeSecs + p.deliveryGraceSecs) {
          out.push({ job: 'fail-delivery', fn: 'fail_delivery', args: [pool.id] });
        }
        break;
      case 'Delivered': {
        if (pool.allocationPending) {
          out.push({ job: 'allocate', fn: 'allocate_shortfall', args: [pool.id, ALLOCATE_BATCH] });
          break;
        }
        const window = pool.perishable ? p.perishableConfirmWindowSecs : p.confirmWindowSecs;
        const windowOver = nowSecs >= pool.deliveredAt + window;
        const early = pool.totalUnits > 0 && pool.pickedUnits * 10_000 >= p.earlyReleaseWeightBp * pool.totalUnits;
        if (windowOver || early) out.push({ job: 'settle', fn: 'settle', args: [pool.id] });
        break;
      }
      case 'Settled':
      case 'Expired':
      case 'Failed':
      case 'Cancelled':
        if (pool.hasUnclaimedRefunds) out.push({ job: 'push-refunds', fn: 'push_refunds', args: [pool.id, PUSH_REFUND_BATCH] });
        break;
    }
  }
  for (const d of disputes) {
    if (d.open && nowSecs > d.openedAt + p.arbitrationSlaSecs) out.push({ job: 'dispute-timeout', fn: 'timeout', args: [d.id] });
  }
  return out;
}

/** Error class returned by classifyKeeperError. */
export type KeeperErrorKind = 'refused' | 'transient' | 'permanent';

/**
 * Classifies a keeper error (#93):
 *   refused  — contract rejected the call (expected, harmless)
 *   transient — RPC timeout / rate limit / network hiccup (worth retrying)
 *   permanent — anything else (alert, do not retry)
 */
export function classifyKeeperError(e: unknown): KeeperErrorKind {
  const msg = (e as Error)?.message ?? '';
  if (/Error\(Contract, #\d+\)/.test(msg)) return 'refused';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|TooManyRequests|429|503|504|timeout/i.test(msg)) return 'transient';
  return 'permanent';
}

export interface ChainPort {
  /** Invokes a keeper-callable function; resolves true on success, false if the chain refused. */
  invoke(action: KeeperAction): Promise<boolean>;
}

const TRANSIENT_BACKOFF_MS = [1_000, 3_000, 9_000] as const;

/** Runs the due actions; one failing action never blocks the rest (#93 retry). */
export async function runKeeper(
  chain: ChainPort,
  actions: readonly KeeperAction[],
  onError: (a: KeeperAction, e: unknown) => void = () => {},
): Promise<{ ok: number; refused: number; errored: number }> {
  const r = { ok: 0, refused: 0, errored: 0 };
  for (const a of actions) {
    let lastErr: unknown;
    let success = false;
    for (let attempt = 0; attempt <= TRANSIENT_BACKOFF_MS.length; attempt++) {
      try {
        if (await chain.invoke(a)) { r.ok++; success = true; break; }
        r.refused++; success = true; break;
      } catch (e) {
        const kind = classifyKeeperError(e);
        if (kind !== 'transient' || attempt === TRANSIENT_BACKOFF_MS.length) { lastErr = e; break; }
        await new Promise<void>((res) => setTimeout(res, TRANSIENT_BACKOFF_MS[attempt]));
      }
    }
    if (!success) {
      r.errored++;
      onError(a, lastErr);
    }
  }
  return r;
}
