import { ceilingPrice, cumulativeAlloc, finalUnitPrice, quote, quoteCommit, refundFor, type Tier } from './pricing.js';

/**
 * Property tests for the money math (#169). `fast-check` is not a dependency, so these use a small seeded PRNG with the
 * existing runner: every case is reproducible from the printed seed. CI (CI=true) uses a fixed seed; locally a random
 * one is drawn unless PRICING_PROPERTY_SEED is set, so re-running a failure is `PRICING_PROPERTY_SEED=<seed> pnpm test`.
 */
const SEED = Number(process.env.PRICING_PROPERTY_SEED ?? (process.env.CI ? 20_261_119 : Math.floor(Math.random() * 2 ** 31)));
const RUNS = 500;

/** mulberry32: tiny, deterministic, good enough for test-case generation. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rand = ReturnType<typeof rng>;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** A valid tier table: strictly increasing minUnits from a positive MOQ, non-increasing positive unit prices. */
function tierTable(r: Rand): Tier[] {
  const count = int(r, 1, 5);
  const tiers: Tier[] = [];
  let minUnits = int(r, 1, 200);
  let price = BigInt(int(r, 1_000, 50_000_000));
  for (let i = 0; i < count; i++) {
    tiers.push({ minUnits, unitPrice: price });
    minUnits += int(r, 1, 500);
    price -= BigInt(int(r, 0, Number(price - 1n) > 0 ? Math.min(Number(price - 1n), 5_000_000) : 0));
  }
  return tiers;
}

/** Runs `check` RUNS times; a failure names the seed and the generated input so it can be replayed. */
function forAll<T>(gen: (r: Rand) => T, check: (input: T) => void) {
  const r = rng(SEED);
  for (let run = 0; run < RUNS; run++) {
    const input = gen(r);
    try {
      check(input);
    } catch (e) {
      const shown = JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      throw new Error(`property failed (seed ${SEED}, run ${run}) for ${shown}: ${(e as Error).message}`);
    }
  }
}

describe(`pricing properties (seed ${SEED})`, () => {
  it('a quote never exceeds units x the tier-1 (highest) price', () => {
    forAll(
      (r) => ({ tiers: tierTable(r), before: int(r, 0, 3_000), units: int(r, 1, 1_000) }),
      ({ tiers, before, units }) => {
        const cap = tiers[0]!.unitPrice * BigInt(units);
        expect(quoteCommit(tiers, before, units) <= cap).toBe(true);
        expect(quote(tiers, before, units).amountNow <= cap).toBe(true);
      },
    );
  });

  it('the refund if the pool closed now is never negative', () => {
    forAll(
      (r) => ({ tiers: tierTable(r), before: int(r, 0, 3_000), units: int(r, 1, 1_000) }),
      ({ tiers, before, units }) => {
        expect(quote(tiers, before, units).expectedRefundIfClosedNow >= 0n).toBe(true);
      },
    );
  });

  it('a settled refund is never negative and equals paid minus final cost', () => {
    // Members commit in order; the pool then closes at some total >= the sum of commits. The final price can only be
    // at or below each member's ceiling, because totals only grow and prices never rise with volume.
    forAll(
      (r) => {
        const tiers = tierTable(r);
        const commits = Array.from({ length: int(r, 1, 8) }, () => int(r, 1, 400));
        return { tiers, commits, extra: int(r, 0, 2_000) };
      },
      ({ tiers, commits, extra }) => {
        let before = 0;
        const paid = commits.map((units) => {
          const amount = quoteCommit(tiers, before, units);
          before += units;
          return amount;
        });
        const finalPrice = finalUnitPrice(tiers, before + extra);
        let totalPaid = 0n;
        let totalCost = 0n;
        let totalRefund = 0n;
        commits.forEach((units, i) => {
          const refund = refundFor(paid[i]!, units, finalPrice);
          expect(refund >= 0n).toBe(true);
          expect(refund).toBe(paid[i]! - BigInt(units) * finalPrice);
          totalPaid += paid[i]!;
          totalCost += BigInt(units) * finalPrice;
          totalRefund += refund;
        });
        expect(totalRefund).toBe(totalPaid - totalCost);
        expect(finalPrice <= ceilingPrice(tiers, 0)).toBe(true);
      },
    );
  });

  it('shortfall allocation hands out exactly what was received, never more than each commit', () => {
    forAll(
      (r) => {
        const commits = Array.from({ length: int(r, 1, 10) }, () => int(r, 1, 500));
        const total = commits.reduce((a, b) => a + b, 0);
        return { commits, total, received: int(r, 0, total) };
      },
      ({ commits, total, received }) => {
        let cum = 0;
        let allocated = 0;
        for (const units of commits) {
          const share = cumulativeAlloc(cum, units, received, total);
          expect(share >= 0 && share <= units).toBe(true);
          allocated += share;
          cum += units;
        }
        expect(allocated).toBe(received);
      },
    );
  });
});
