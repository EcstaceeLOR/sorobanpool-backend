/** A bounded, TTL'd cache entry. `poolId` and `ledger` allow targeted and cross-process invalidation. */
export interface CachedPreview<V = unknown> {
  value: V;
  poolId: bigint;
  ledger: number;
  expiresAt: number;
}

/**
 * In-memory cache for public pool pages. Both limits are mandatory: the TTL bounds staleness when an
 * invalidation is missed, and the size bound stops the cache growing without limit on a busy site.
 * Insertion order doubles as an LRU ordering: a hit moves its key to the end.
 */
export class PoolPreviewCache<V = unknown> {
  private readonly entries = new Map<string, CachedPreview<V>>();
  private readonly slugsByPool = new Map<string, Set<string>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get(slug: string): CachedPreview<V> | undefined {
    const entry = this.entries.get(slug);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.remove(slug);
      return undefined;
    }
    this.entries.delete(slug);
    this.entries.set(slug, entry);
    return entry;
  }

  set(slug: string, value: V, poolId: bigint, ledger: number): void {
    this.remove(slug);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(slug, { value, poolId, ledger, expiresAt: this.clock() + this.ttlMs });
    const key = poolId.toString();
    const slugs = this.slugsByPool.get(key) ?? new Set<string>();
    slugs.add(slug);
    this.slugsByPool.set(key, slugs);
  }

  evictSlug(slug: string): void {
    this.remove(slug);
  }

  evictPool(poolId: bigint): void {
    for (const slug of this.slugsByPool.get(poolId.toString()) ?? []) this.remove(slug);
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(slug: string): void {
    const entry = this.entries.get(slug);
    if (!entry) return;
    this.entries.delete(slug);
    const key = entry.poolId.toString();
    const slugs = this.slugsByPool.get(key);
    slugs?.delete(slug);
    if (!slugs?.size) this.slugsByPool.delete(key);
  }
}
