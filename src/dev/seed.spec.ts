import { SeedRefused, assertSeedAllowed, seed } from './seed.js';
import { startTestDb, type TestDb } from '../../test/pg.js';

describe('seed guard (#150)', () => {
  it('refuses to run in production or on mainnet', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(SeedRefused);
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', STELLAR_NETWORK: 'mainnet' })).toThrow(SeedRefused);
  });

  it('allows development and test', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', STELLAR_NETWORK: 'testnet' })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });
});

describe('seed data (#150)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.close(); });

  it('creates the supplier, organizer, traders, offers and a pool in each state', async () => {
    const s = await seed(db.prisma);
    expect(s).toEqual({ users: 5, offers: 2, pools: 4, commitments: 12 });
    const supplier = await db.prisma.supplierProfile.findUnique({ where: { userId: 'seed-supplier' } });
    expect(supplier?.kybStatus).toBe('APPROVED');
    const states = (await db.prisma.pool.findMany({ where: { shareSlug: { startsWith: 'seed-pool-' } } })).map((p) => p.state).sort();
    expect(states).toEqual(['Delivered', 'Filled', 'Open', 'Settled']);
  });

  it('is idempotent: a second run creates no duplicates', async () => {
    const count = async () => Promise.all([
      db.prisma.user.count(), db.prisma.userRole.count(), db.prisma.offer.count(),
      db.prisma.pool.count(), db.prisma.commitment.count(), db.prisma.fxQuote.count(),
    ]);
    const before = await count();
    await seed(db.prisma);
    expect(await count()).toEqual(before);
  });
});
