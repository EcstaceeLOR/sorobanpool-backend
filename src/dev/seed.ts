/**
 * Local development seed (#150): a verified supplier with two live offers, an organizer, three traders and one pool
 * in each of the Open, Filled, Delivered and Settled states, with commitments.
 *
 *   pnpm seed              (builds, then runs dist/dev/seed.js against DATABASE_URL)
 *
 * Idempotent: every row has a fixed id and is upserted, so running it twice creates no duplicates. Refuses to run
 * when NODE_ENV=production or STELLAR_NETWORK=mainnet. The pools are read-model rows only; nothing is sent on-chain.
 */
import { existsSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrisma } from '../persistence/prisma-stores.js';

export class SeedRefused extends Error {}

/** Throws unless the environment is clearly not production. */
export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') throw new SeedRefused('refusing to seed: NODE_ENV=production');
  if (env.STELLAR_NETWORK === 'mainnet') throw new SeedRefused('refusing to seed: STELLAR_NETWORK=mainnet');
}

/** Deterministic, valid Stellar addresses for seeded actors (never funded, never used to sign). */
const address = (n: number): string => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();

const SUPPLIER = { id: 'seed-supplier', phone: '+2348000000101', name: 'Ada Foods (seed)' };
const ORGANIZER = { id: 'seed-organizer', phone: '+2348000000102', name: 'Bayo Organizer (seed)' };
const TRADERS = [1, 2, 3].map((i) => ({ id: `seed-trader-${i}`, phone: `+234800000020${i}`, name: `Trader ${i} (seed)` }));

const POOL_STATES = ['Open', 'Filled', 'Delivered', 'Settled'] as const;

export interface SeedSummary {
  users: number;
  offers: number;
  pools: number;
  commitments: number;
}

export async function seed(prisma: PrismaClient, now = new Date()): Promise<SeedSummary> {
  const day = 24 * 60 * 60 * 1000;
  const people = [
    { ...SUPPLIER, role: 'SUPPLIER', wallet: address(1) },
    { ...ORGANIZER, role: 'ORGANIZER', wallet: address(2) },
    ...TRADERS.map((t, i) => ({ ...t, role: 'TRADER', wallet: address(10 + i) })),
  ];
  for (const p of people) {
    await prisma.user.upsert({
      where: { id: p.id },
      create: { id: p.id, phone: p.phone, displayName: p.name, walletAddress: p.wallet },
      update: {},
    });
    await prisma.userRole.upsert({
      where: { userId_role: { userId: p.id, role: p.role } },
      create: { userId: p.id, role: p.role, level: 1 },
      update: {},
    });
  }
  for (const t of TRADERS) {
    await prisma.traderProfile.upsert({
      where: { userId: t.id },
      create: { userId: t.id, market: 'Wuse Market', state: 'FCT', lga: 'AMAC' },
      update: {},
    });
  }
  await prisma.supplierProfile.upsert({
    where: { userId: SUPPLIER.id },
    create: {
      userId: SUPPLIER.id, businessName: SUPPLIER.name, cacNumber: 'RC0000000', address: '1 Seed Road, Abuja',
      state: 'FCT', lga: 'AMAC', categories: ['grains', 'oil'], deliveryAreas: [{ state: 'FCT' }],
      bankName: 'Seed Bank', bankAccountMasked: '******0000', kybStatus: 'APPROVED',
    },
    update: {},
  });
  await prisma.fxQuote.upsert({
    where: { id: 'seed-fx' },
    create: { id: 'seed-fx', pair: 'USDC/NGN', rate: '1500', sources: [{ name: 'seed', rate: '1500' }] },
    update: {},
  });

  const offers = [
    { id: 'seed-offer-rice', title: 'Long-grain rice, 50kg bag', unitLabel: 'bag', category: 'grains', tiers: [[10, '72000'], [50, '69000'], [100, '66500']] },
    { id: 'seed-offer-oil', title: 'Vegetable oil, 25L keg', unitLabel: 'keg', category: 'oil', tiers: [[20, '48000'], [80, '45500']] },
  ] as const;
  for (const o of offers) {
    const tiersNgn = o.tiers.map(([minUnits, priceNgn]) => ({ minUnits, priceNgn }));
    await prisma.offer.upsert({
      where: { id: o.id },
      create: {
        id: o.id, supplierId: SUPPLIER.id, title: o.title, description: `${o.title}, delivered to the hub (seed data).`,
        unitLabel: o.unitLabel, category: o.category, images: [], tiersNgn,
        tiersUsdc: tiersNgn.map((t) => ({ minUnits: t.minUnits, unitPrice: String(BigInt(t.priceNgn) * 10_000_000n / 1500n) })),
        fxQuoteId: 'seed-fx', moq: o.tiers[0][0], maxUnits: 500, maxPerMember: 20, leadTimeHours: 72,
        deliveryAreas: [{ state: 'FCT' }], validUntil: new Date(now.getTime() + 30 * day), offerHash: '', status: 'LIVE',
      },
      update: {},
    });
  }

  let commitments = 0;
  for (const [i, state] of POOL_STATES.entries()) {
    const id = BigInt(9001 + i);
    const units = [4, 12, 12, 12][i] as number;
    const ended = state === 'Settled';
    await prisma.pool.upsert({
      where: { id },
      create: {
        id, offerId: offers[0].id, organizerAddress: address(2), supplierAddress: address(1), hubAddress: 'Wuse Market, Abuja',
        hubContact: ORGANIZER.phone, hubHash: '', pickupWindow: { from: '09:00', to: '17:00' }, state,
        totalUnits: units, currentUnitPrice: '480.0000000', fillDeadline: new Date(now.getTime() + (state === 'Open' ? 3 : -3) * day),
        filledAt: state === 'Open' ? null : new Date(now.getTime() - 2 * day),
        deliveredAt: state === 'Delivered' || ended ? new Date(now.getTime() - day) : null,
        endedAt: ended ? now : null, receivedUnits: state === 'Delivered' || ended ? units : null,
        shareSlug: `seed-pool-${i + 1}`,
      },
      update: {},
    });
    for (const [j] of TRADERS.entries()) {
      const memberAddress = address(10 + j);
      const share = Math.floor(units / TRADERS.length);
      await prisma.commitment.upsert({
        where: { poolId_memberAddress: { poolId: id, memberAddress } },
        create: { poolId: id, memberAddress, units: share, paid: String(share * 480), pickedUp: ended },
        update: {},
      });
      commitments++;
    }
  }

  return { users: people.length, offers: offers.length, pools: POOL_STATES.length, commitments };
}

async function main(): Promise<void> {
  // Same `.env` loading as main.ts (shell variables win), then the guard, so NODE_ENV in `.env` is honoured too.
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) process.loadEnvFile('.env');
  assertSeedAllowed(process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new SeedRefused('DATABASE_URL is not set (copy .env.example to .env)');
  const prisma = createPrisma(url);
  try {
    const s = await seed(prisma);
    console.log(`seeded: ${s.users} users, ${s.offers} offers, ${s.pools} pools (Open, Filled, Delivered, Settled), ${s.commitments} commitments`);
    console.log('re-running is safe: existing seed rows are left unchanged');
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (`node dist/dev/seed.js`), not when imported by the tests.
if (process.argv[1]?.endsWith('seed.js')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
