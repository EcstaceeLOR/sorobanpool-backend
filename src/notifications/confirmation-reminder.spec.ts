import { queueConfirmationReminders } from './dispatcher.js';
import { render } from './templates.js';

type Db = Parameters<typeof queueConfirmationReminders>[0];

const secsBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 1000;

const USERS = [
  { id: 'u-org', walletAddress: 'GORG' },
  { id: 'u-m1', walletAddress: 'GM1' },
  { id: 'u-m2', walletAddress: 'GM2' },
];

/** In-memory stand-in for the Prisma calls the reminder makes, with the same compare-and-set semantics. */
function fakeDb(opts: { deliveredAt: string; perishable?: boolean; title?: string }) {
  const sent: { userId: string; template: string; payload: unknown; runAfter: Date }[] = [];
  const claimed = new Set<string>();
  const pool = { id: 7n, offerId: 'offer-1', organizerAddress: 'GORG', state: 'Delivered', deliveredAt: new Date(opts.deliveredAt) };
  const db = {
    pool: { findMany: async () => [pool] },
    offer: { findUnique: async () => ({ id: 'offer-1', title: opts.title ?? 'Rice 50kg', perishable: opts.perishable ?? false }) },
    commitment: { findMany: async () => [{ memberAddress: 'GM1' }, { memberAddress: 'GM2' }] },
    user: { findMany: async ({ where }: { where: { walletAddress: { in: string[] } } }) => USERS.filter((u) => where.walletAddress.in.includes(u.walletAddress)) },
    confirmationReminder: {
      createMany: async ({ data }: { data: { poolId: bigint; userId: string }[] }) => {
        const key = `${data[0]!.poolId}:${data[0]!.userId}`;
        if (claimed.has(key)) return { count: 0 };
        claimed.add(key);
        return { count: 1 };
      },
    },
    notification: {
      create: async ({ data }: { data: { userId: string; template: string; payload: unknown; runAfter: Date } }) => {
        sent.push(data);
        return data;
      },
    },
  };
  return { db: db as unknown as Db, sent };
}

// Delivered 10 Oct 08:00 UTC. Windows below end at the instant named in each test.
const DELIVERED = '2026-10-10T08:00:00Z';

describe('confirmation-window reminders (#95)', () => {
  it('reminds the organizer and each member 6 hours before the window closes, and not earlier or later', async () => {
    const windowEnd = '2026-10-12T10:00:00Z';
    const windows = { standardSecs: secsBetween(DELIVERED, windowEnd), perishableSecs: 1 };
    const { db, sent } = fakeDb({ deliveredAt: DELIVERED });

    expect(await queueConfirmationReminders(db, new Date('2026-10-12T03:59:00Z'), windows)).toBe(0);
    expect(await queueConfirmationReminders(db, new Date('2026-10-12T04:00:00Z'), windows)).toBe(3);
    expect(sent.map((n) => n.userId).sort()).toEqual(['u-m1', 'u-m2', 'u-org']);
    expect(sent[0]).toMatchObject({ template: 'confirm_window_ending', payload: { product: 'Rice 50kg', hours: 6 } });
    expect(await queueConfirmationReminders(db, new Date('2026-10-12T10:00:00Z'), windows)).toBe(0); // window closed
  });

  it('sends each user at most one reminder per pool, even when the job runs again', async () => {
    const windows = { standardSecs: secsBetween(DELIVERED, '2026-10-12T10:00:00Z'), perishableSecs: 1 };
    const { db, sent } = fakeDb({ deliveredAt: DELIVERED });
    await queueConfirmationReminders(db, new Date('2026-10-12T04:00:00Z'), windows);
    expect(await queueConfirmationReminders(db, new Date('2026-10-12T04:30:00Z'), windows)).toBe(0);
    expect(await queueConfirmationReminders(db, new Date('2026-10-12T05:00:00Z'), windows)).toBe(0);
    expect(sent).toHaveLength(3);
  });

  it('defers a quiet-hours reminder to 07:00 WAT when the window is still open then', async () => {
    // 01:00 UTC is 02:00 WAT (quiet). The window closes at 07:00 UTC, after the 06:00 UTC (07:00 WAT) deferral.
    const windows = { standardSecs: secsBetween(DELIVERED, '2026-10-13T07:00:00Z'), perishableSecs: 1 };
    const { db, sent } = fakeDb({ deliveredAt: DELIVERED });
    expect(await queueConfirmationReminders(db, new Date('2026-10-13T01:00:00Z'), windows)).toBe(3);
    expect(sent[0]!.runAfter).toEqual(new Date('2026-10-13T06:00:00Z'));
  });

  it('skips a quiet-hours reminder whose deferred time would fall after the window closes', async () => {
    // Window closes at 02:00 UTC next morning, so the 06:00 UTC deferral is too late.
    const windows = { standardSecs: secsBetween(DELIVERED, '2026-10-11T02:00:00Z'), perishableSecs: 1 };
    const { db, sent } = fakeDb({ deliveredAt: DELIVERED });
    expect(await queueConfirmationReminders(db, new Date('2026-10-11T00:00:00Z'), windows)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('sends a delivery-day reminder at once, even inside quiet hours', async () => {
    // 21:00 UTC on the delivery day is 22:00 WAT, inside quiet hours, but the pool was delivered that same WAT day.
    const windows = { standardSecs: secsBetween(DELIVERED, '2026-10-11T03:00:00Z'), perishableSecs: 1 };
    const { db, sent } = fakeDb({ deliveredAt: DELIVERED });
    const now = new Date('2026-10-10T21:00:00Z');
    expect(await queueConfirmationReminders(db, now, windows)).toBe(3);
    expect(sent[0]!.runAfter).toEqual(now);
  });

  it('uses the perishable window for perishable offers', async () => {
    const windows = { standardSecs: 30 * 86_400, perishableSecs: secsBetween(DELIVERED, '2026-10-12T10:00:00Z') };
    const { db } = fakeDb({ deliveredAt: DELIVERED, perishable: true });
    expect(await queueConfirmationReminders(db, new Date('2026-10-12T04:00:00Z'), windows)).toBe(3);
  });

  it('keeps every reminder within the 160-character SMS limit, for both languages', () => {
    const longTitle = 'x'.repeat(40);
    for (const lang of ['EN', 'PCM'] as const) {
      expect(render('confirm_window_ending', lang, { product: longTitle, hours: 6 }).length).toBeLessThanOrEqual(160);
    }
  });
});
