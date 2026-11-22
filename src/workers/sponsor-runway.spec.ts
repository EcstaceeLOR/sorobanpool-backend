import { averageDailySpend, checkSponsorRunway, TX_FEE_ESTIMATE_STROOPS } from './maintenance.js';
import { startHarness, type Harness } from '../../test/harness.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const XLM = 10_000_000n;

describe('sponsor runway (#100)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.db.prisma.sponsorUsage.deleteMany(); });

  /** Records `count` sponsored transactions on `day` (YYYY-MM-DD) for a distinct synthetic user. */
  const spend = (day: string, count: number) => h.db.prisma.sponsorUsage.create({ data: { userId: `runway-${day}`, day, count } });
  const balance = (stroops: bigint) => ({ sponsorBalance: async () => stroops });

  it('averages the last seven days of sponsored transactions into a daily spend', async () => {
    await spend('2026-10-04', 7); // first day of the window (today minus six)
    await spend('2026-10-10', 7); // today
    await spend('2026-10-03', 100); // outside the window: ignored
    expect(await averageDailySpend(h.db.prisma, NOW)).toBe((14n * TX_FEE_ESTIMATE_STROOPS) / 7n);
  });

  it('alerts on runway, not on a fixed XLM floor, when there is history', async () => {
    // 70 transactions over the window at 0.1 XLM each: 10 XLM of spend in 7 days, so about 1 XLM a day.
    await spend('2026-10-10', 70);
    const low = await checkSponsorRunway(h.db.prisma, balance(69n * XLM / 10n), NOW, { minXlm: 100, minRunwayDays: 7 });
    expect(low.runwayDays).toBe(6);
    expect(low.low).toBe(true);
    // 70 XLM sits below the old 100 XLM floor but covers 70 days at this spend, so it is healthy.
    const healthy = await checkSponsorRunway(h.db.prisma, balance(70n * XLM), NOW, { minXlm: 100, minRunwayDays: 7 });
    expect(healthy.runwayDays).toBe(70);
    expect(healthy.low).toBe(false);
  });

  it('falls back to the fixed minimum when there is no recent history', async () => {
    await spend('2026-10-03', 500); // only outside the window
    const under = await checkSponsorRunway(h.db.prisma, balance(99n * XLM), NOW, { minXlm: 100, minRunwayDays: 7 });
    expect(under.runwayDays).toBeNull();
    expect(under.low).toBe(true);
    const over = await checkSponsorRunway(h.db.prisma, balance(101n * XLM), NOW, { minXlm: 100, minRunwayDays: 7 });
    expect(over.runwayDays).toBeNull();
    expect(over.low).toBe(false);
  });

  it('respects a configured runway threshold', async () => {
    await spend('2026-10-10', 70); // about 1 XLM a day
    const r = await checkSponsorRunway(h.db.prisma, balance(20n * XLM), NOW, { minXlm: 100, minRunwayDays: 30 });
    expect(r.runwayDays).toBe(20);
    expect(r.low).toBe(true);
  });
});
