import { divergenceOf, storedSources } from './fx.js';

describe('FX divergence (#125)', () => {
  it('is the spread between the highest and lowest rate, relative to the lowest', () => {
    expect(divergenceOf([{ source: 'a', ngnPerUsd: 1500 }, { source: 'b', ngnPerUsd: 1350 }])).toBeCloseTo(0.1111, 4);
    expect(divergenceOf([{ source: 'a', ngnPerUsd: 1350 }, { source: 'b', ngnPerUsd: 1350 }])).toBe(0);
  });

  it('needs two valid rates; implausible or missing values do not count', () => {
    expect(divergenceOf([{ source: 'a', ngnPerUsd: 1350 }])).toBeNull();
    expect(divergenceOf([{ source: 'a', ngnPerUsd: 1350 }, { source: 'b', ngnPerUsd: Number.NaN }])).toBeNull();
    expect(divergenceOf([{ source: 'a', ngnPerUsd: 1350 }, { source: 'b', ngnPerUsd: 0 }])).toBeNull();
  });
});

describe('stored FX sources (#125)', () => {
  const sources = [{ source: 'er-api', ngnPerUsd: 1347.74 }, { source: 'coingecko', ngnPerUsd: 1349.31 }];

  it('reads the {quotes, divergence} shape the fx-refresh job stores', () => {
    const out = storedSources({ quotes: sources, divergence: 0.0012 });
    expect(out).toEqual({ sources, divergence: 0.0012 });
  });

  it('reads the bare list that publishing stored earlier, deriving the divergence', () => {
    const out = storedSources(sources);
    expect(out.sources).toEqual(sources);
    expect(out.divergence).toBeCloseTo(divergenceOf(sources)!, 10);
  });

  it('tolerates an empty or unexpected value without throwing', () => {
    expect(storedSources(null)).toEqual({ sources: [], divergence: null });
    expect(storedSources({})).toEqual({ sources: [], divergence: null });
  });
});
