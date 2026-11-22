import { PoolPreviewCache } from './preview-cache.js';

describe('PoolPreviewCache', () => {
  it('returns a hit within the TTL and expires it after the TTL', () => {
    let now = 1000;
    const cache = new PoolPreviewCache<string>(5000, 2, () => now);
    cache.set('abc', 'view', 7n, 10);
    now = 5999;
    expect(cache.get('abc')?.value).toBe('view');
    now = 6000;
    expect(cache.get('abc')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts every slug belonging to a pool when an event is applied', () => {
    const cache = new PoolPreviewCache<string>(5000, 10);
    cache.set('one', 'a', 7n, 1);
    cache.set('two', 'b', 7n, 1);
    cache.set('three', 'c', 8n, 1);
    cache.evictPool(7n);
    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toBeUndefined();
    expect(cache.get('three')?.value).toBe('c');
  });

  it('bounds its size, dropping the least recently used entry', () => {
    let now = 0;
    const cache = new PoolPreviewCache<number>(5000, 2, () => now);
    cache.set('a', 1, 1n, 1);
    now = 1;
    cache.set('b', 2, 2n, 1);
    expect(cache.get('a')?.value).toBe(1);
    now = 2;
    cache.set('c', 3, 3n, 1);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.get('c')?.value).toBe(3);
  });

  it('keeps only one reverse mapping when a slug is replaced', () => {
    const cache = new PoolPreviewCache<number>(5000, 5);
    cache.set('same', 1, 1n, 1);
    cache.set('same', 2, 2n, 1);
    cache.evictPool(1n);
    expect(cache.get('same')?.value).toBe(2);
    cache.evictPool(2n);
    expect(cache.size).toBe(0);
  });
});
