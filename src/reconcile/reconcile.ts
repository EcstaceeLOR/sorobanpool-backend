/**
 * Reconcile job: compares the indexed read-model state against on-chain state and
 * reports a structured diff (issue #97).
 *
 * The diff is pure data — it never mutates the read model or the chain. Callers
 * decide whether to alert, re-index, or discard the report.
 */

import type { PoolState, PoolRow } from '../indexer/read-model.js';

// ---------------------------------------------------------------------------
// On-chain view port (narrow — only what reconcile needs)
// ---------------------------------------------------------------------------

export interface OnChainPool {
  id: bigint;
  state: PoolState;
  totalUnits: number;
  escrowBalance: bigint;
}

export interface ReconcileChainPort {
  /** Returns pool ids that exist on-chain (all active pools the contract tracks). */
  listPoolIds(): Promise<bigint[]>;
  /** Returns the on-chain pool, or undefined if the id is unknown to the contract. */
  getPool(id: bigint): Promise<OnChainPool | undefined>;
}

// ---------------------------------------------------------------------------
// Read-model port
// ---------------------------------------------------------------------------

export interface ReconcileStorePort {
  /** Returns all pool rows in the read model that are not in a terminal state. */
  listActivePools(): Promise<PoolRow[]>;
  /** Returns a single pool row by id. */
  pool(id: bigint): Promise<PoolRow | undefined>;
}

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

export type PoolFieldDiff = {
  field: 'state' | 'totalUnits' | 'escrowBalance';
  indexed: unknown;
  onChain: unknown;
};

export interface PoolDiff {
  id: bigint;
  fields: PoolFieldDiff[];
}

export interface ReconcileReport {
  /** Pools present in the read model but not found on-chain. */
  missingOnChain: bigint[];
  /** Pools found on-chain but absent from the read model. */
  missingInIndex: bigint[];
  /** Pools present in both but with at least one field mismatch. */
  modified: PoolDiff[];
  /** Wall-clock when the report was generated (ISO-8601). */
  generatedAt: string;
  /** Summary counts. */
  summary: {
    checked: number;
    ok: number;
    missingOnChain: number;
    missingInIndex: number;
    modified: number;
  };
}

// ---------------------------------------------------------------------------
// Core reconcile function
// ---------------------------------------------------------------------------

/**
 * Produces a structured diff between the indexed state and on-chain state.
 * The comparison is scoped to pools that appear in either side; terminal
 * pools that are absent on-chain are not flagged (the contract may have
 * pruned them). Pass `includeTerminal: true` to report those too.
 */
export async function reconcilePools(
  store: ReconcileStorePort,
  chain: ReconcileChainPort,
  now: () => Date = () => new Date(),
  options: { includeTerminal?: boolean } = {},
): Promise<ReconcileReport> {
  const TERMINAL: ReadonlySet<PoolState> = new Set(['Settled', 'Expired', 'Failed', 'Cancelled']);

  const [indexedPools, chainIds] = await Promise.all([
    store.listActivePools(),
    chain.listPoolIds(),
  ]);

  const indexedById = new Map(indexedPools.map((p) => [p.id, p]));
  const chainIdSet = new Set(chainIds);

  const missingOnChain: bigint[] = [];
  const modified: PoolDiff[] = [];

  // Check every indexed pool against on-chain state.
  for (const indexed of indexedPools) {
    if (!chainIdSet.has(indexed.id)) {
      if (options.includeTerminal || !TERMINAL.has(indexed.state)) {
        missingOnChain.push(indexed.id);
      }
      continue;
    }

    const onChain = await chain.getPool(indexed.id);
    if (!onChain) {
      if (options.includeTerminal || !TERMINAL.has(indexed.state)) {
        missingOnChain.push(indexed.id);
      }
      continue;
    }

    const fields: PoolFieldDiff[] = [];

    if (indexed.state !== onChain.state) {
      fields.push({ field: 'state', indexed: indexed.state, onChain: onChain.state });
    }
    if (indexed.totalUnits !== onChain.totalUnits) {
      fields.push({ field: 'totalUnits', indexed: indexed.totalUnits, onChain: onChain.totalUnits });
    }
    if (indexed.escrowBalance !== onChain.escrowBalance) {
      fields.push({ field: 'escrowBalance', indexed: indexed.escrowBalance, onChain: onChain.escrowBalance });
    }

    if (fields.length > 0) {
      modified.push({ id: indexed.id, fields });
    }
  }

  // Check for on-chain pools absent from the read model.
  const missingInIndex: bigint[] = [];
  for (const id of chainIds) {
    if (!indexedById.has(id)) {
      missingInIndex.push(id);
    }
  }

  const checked = indexedPools.length + missingInIndex.length;
  const ok = checked - missingOnChain.length - missingInIndex.length - modified.length;

  return {
    missingOnChain,
    missingInIndex,
    modified,
    generatedAt: now().toISOString(),
    summary: {
      checked,
      ok: Math.max(0, ok),
      missingOnChain: missingOnChain.length,
      missingInIndex: missingInIndex.length,
      modified: modified.length,
    },
  };
}
