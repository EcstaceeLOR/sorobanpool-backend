import { Controller, Get, Inject, Query, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { toStroops } from '../common/money.js';
import { PAIR_SHARE_ALERT, pairConcentration, riskOverview, riskRates, type PoolFact } from '../risk/metrics.js';
import { type AuthedUser, CurrentUser, parse, Roles } from './http.js';
import { walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';
import type { Prisma } from '../generated/prisma/client.js';

const dec = (d: { toString(): string }): bigint => toStroops(d.toString());
const str = (b: bigint): string => b.toString();

@Controller()
export class ReportsController {
  private readonly dashboardCache = new Map<number, { expiresAt: number; value: Record<string, unknown> }>();

  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** Current operational counters and rates for the selected rolling window; cached per window for one minute. */
  @Roles('ADMIN') @Get('admin/dashboard')
  async dashboard(@Query('windowDays') windowDays?: string) {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }), { days: windowDays });
    const cached = this.dashboardCache.get(days);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const since = new Date(this.s.now().getTime() - days * 86_400_000);
    const [gmv, escrow, openPools, failures, disputes] = await Promise.all([
      this.s.prisma.$queryRaw<{ value: Prisma.Decimal }[]>(Prisma.sql`
        SELECT COALESCE(SUM("receivedUnits" * "finalUnitPrice"), 0)::numeric AS value
        FROM "Pool"
        WHERE "deliveredAt" >= ${since} AND state IN ('Delivered', 'Settled')
      `),
      this.s.prisma.$queryRaw<{ value: Prisma.Decimal }[]>(Prisma.sql`
        SELECT COALESCE(SUM("escrowBalance"), 0)::numeric AS value
        FROM "Pool" WHERE "escrowBalance" > 0
      `),
      this.s.prisma.pool.count({ where: { state: { in: ['Open', 'Filled', 'Accepted', 'Dispatched', 'Delivered'] } } }),
      this.s.prisma.$queryRaw<{ completed: number; failed: number }[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE state IN ('Settled', 'Failed', 'Expired', 'Cancelled'))::int AS completed,
          COUNT(*) FILTER (WHERE state IN ('Failed', 'Expired', 'Cancelled'))::int AS failed
        FROM "Pool"
        WHERE "endedAt" >= ${since} AND state IN ('Settled', 'Failed', 'Expired', 'Cancelled')
      `),
      this.s.prisma.$queryRaw<{ delivered: number; disputed: number }[]>(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::int FROM "Pool"
           WHERE "deliveredAt" >= ${since} AND state IN ('Delivered', 'Settled')) AS delivered,
          (SELECT COUNT(DISTINCT p.id)::int
           FROM "Dispute" d JOIN "Pool" p ON p.id = d."poolId"
           WHERE d."openedAt" >= ${since} AND p."deliveredAt" >= ${since}
             AND p.state IN ('Delivered', 'Settled')) AS disputed
      `),
    ]);
    const completed = failures[0]?.completed ?? 0;
    const delivered = disputes[0]?.delivered ?? 0;
    const value = {
      windowDays: days,
      since,
      gmv: toStroops(gmv[0]?.value.toString() ?? '0').toString(),
      escrowHeld: toStroops(escrow[0]?.value.toString() ?? '0').toString(),
      openPools,
      failureRate: completed ? (failures[0]!.failed / completed) : 0,
      disputeRate: delivered ? ((disputes[0]?.disputed ?? 0) / delivered) : 0,
      generatedAt: this.s.now().toISOString(),
    };
    this.dashboardCache.set(days, { expiresAt: Date.now() + 60_000, value });
    return value;
  }

  /** GMV, escrow held, failure and dispute rates, supplier ranking and the organizer-supplier collusion signal. */
  @Roles('ADMIN') @Get('admin/risk/overview')
  async overview() {
    const [pools, disputes] = await Promise.all([this.s.prisma.pool.findMany(), this.s.prisma.dispute.findMany()]);
    const supplierOf = new Map(pools.map((p) => [p.id, p.supplierAddress]));
    const facts = await this.poolFacts(pools);
    const r = riskOverview(facts, disputes.map((d) => ({ poolId: d.poolId.toString(), supplier: supplierOf.get(d.poolId) ?? '', openedAt: d.openedAt })), this.s.now());
    return { ...r, pairs: r.pairs.map((pair) => ({ ...pair, volume: str(pair.volume) })), gmv: str(r.gmv), escrowHeld: str(r.escrowHeld), generatedAt: this.s.now().toISOString() };
  }

  @Roles('ADMIN') @Get('admin/risk/rates')
  async rates(@Query('slice') slice?: string) {
    const b = parse(z.object({ slice: z.enum(['supplier', 'category', 'state']) }), { slice });
    const [pools, disputes] = await Promise.all([this.s.prisma.pool.findMany(), this.s.prisma.dispute.findMany()]);
    const facts = await this.poolFacts(pools);
    return riskRates(facts, disputes.map((d) => ({ poolId: d.poolId.toString(), supplier: '', openedAt: d.openedAt })), this.s.now(), b.slice);
  }

  @Roles('ADMIN') @Get('admin/risk/pairs')
  async pairs(@Query('threshold') threshold?: string) {
    const b = parse(z.object({ threshold: z.coerce.number().min(0).max(1).optional() }), { threshold });
    const pools = await this.s.prisma.pool.findMany();
    const facts = await this.poolFacts(pools);
    return pairConcentration(facts, b.threshold ?? PAIR_SHARE_ALERT).map((pair) => ({ ...pair, volume: str(pair.volume) }));
  }

  private async poolFacts(pools: Prisma.PoolGetPayload<object>[]): Promise<PoolFact[]> {
    const organizerAddresses = [...new Set(pools.map((p) => p.organizerAddress))];
    const supplierAddresses = [...new Set(pools.map((p) => p.supplierAddress))];
    const [offers, organizers, suppliers] = await Promise.all([
      this.s.prisma.offer.findMany({ where: { id: { in: [...new Set(pools.map((p) => p.offerId))] } }, select: { id: true, category: true } }),
      this.s.prisma.user.findMany({ where: { walletAddress: { in: organizerAddresses } }, select: { walletAddress: true, trader: { select: { state: true } } } }),
      this.s.prisma.user.findMany({ where: { walletAddress: { in: supplierAddresses } }, select: { walletAddress: true, supplier: { select: { state: true } } } }),
    ]);
    const categories = new Map(offers.map((offer) => [offer.id, offer.category]));
    const organizerStates = new Map(organizers.map((user) => [user.walletAddress, user.trader?.state]));
    const supplierStates = new Map(suppliers.map((user) => [user.walletAddress, user.supplier?.state]));
    return pools.map((p) => ({
      id: p.id.toString(), state: p.state, supplier: p.supplierAddress, organizer: p.organizerAddress,
      category: categories.get(p.offerId), nigerianState: organizerStates.get(p.organizerAddress) ?? supplierStates.get(p.supplierAddress),
      escrow: dec(p.escrowBalance),
      gross: p.receivedUnits !== null && p.finalUnitPrice ? BigInt(p.receivedUnits) * dec(p.finalUnitPrice) : 0n,
      volume: p.receivedUnits !== null && p.finalUnitPrice
        ? BigInt(p.receivedUnits) * dec(p.finalUnitPrice)
        : dec(p.escrowBalance) + dec(p.advancePaid),
      indexedAt: p.indexedAt, endedAt: p.endedAt, deliveredAt: p.deliveredAt,
    }));
  }

  @Roles('ADMIN') @Get('admin/disputes')
  async disputes(@Query('state') state?: string) {
    const rows = await this.s.prisma.dispute.findMany({ where: state ? { state } : {}, orderBy: { slaDueAt: 'asc' }, take: 200 });
    return rows.map((d) => ({ id: d.id.toString(), poolId: d.poolId.toString(), opener: d.openerAddress, state: d.state, claimedAmount: d.claimedAmount.toString(), openedAt: d.openedAt, slaDueAt: d.slaDueAt, arbiter: d.arbiterAddress }));
  }

  @Roles('ADMIN') @Get('admin/offers')
  async offers(@Query('status') status?: string) {
    return this.s.prisma.offer.findMany({ where: status ? { status: status as 'LIVE' } : {}, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, title: true, category: true, status: true, supplierId: true, validUntil: true, offerHash: true } });
  }

  @Roles('ADMIN') @Get('admin/pools')
  async pools(@Query('state') state?: string) {
    const rows = await this.s.prisma.pool.findMany({ where: state ? { state } : {}, orderBy: { id: 'desc' }, take: 200 });
    return rows.map((p) => ({ id: p.id.toString(), state: p.state, organizer: p.organizerAddress, supplier: p.supplierAddress, totalUnits: p.totalUnits, escrowBalance: p.escrowBalance.toString(), frozenAmount: p.frozenAmount.toString() }));
  }

  @Roles('ADMIN') @Get('admin/users')
  async users(@Query('q') q?: string) {
    const rows = await this.s.prisma.user.findMany({ where: q ? { OR: [{ phone: { contains: q } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {}, include: { roles: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((u) => ({ id: u.id, phone: u.phone, displayName: u.displayName, walletAddress: u.walletAddress, roles: u.roles.map((r) => ({ role: r.role, level: r.level })) }));
  }

  /** What a supplier was paid per settled pool: gross, platform and organizer fees, net. JSON, or CSV with ?format=csv. */
  @Roles('SUPPLIER') @Get('suppliers/statement')
  async statement(@CurrentUser() u: AuthedUser, @Query('format') format?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const wallet = await walletOf(this.s, u.id);
    const rows = await this.s.prisma.pool.findMany({
      where: { supplierAddress: wallet, state: 'Settled', ...(from || to ? { endedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) },
      orderBy: { endedAt: 'desc' },
    });
    const offers = new Map((await this.s.prisma.offer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.offerId))] } }, select: { id: true, title: true } })).map((o) => [o.id, o.title]));
    const lines = rows.map((p) => {
      const net = dec(p.supplierNet), plat = dec(p.platformFee), org = dec(p.organizerFee);
      return { poolId: p.id.toString(), product: offers.get(p.offerId) ?? '', settledAt: p.endedAt?.toISOString() ?? '', unitsDelivered: p.receivedUnits ?? 0, gross: str(net + plat + org), platformFee: str(plat), organizerFee: str(org), net: str(net) };
    });
    const total = lines.reduce((a, l) => ({ gross: a.gross + BigInt(l.gross), platformFee: a.platformFee + BigInt(l.platformFee), organizerFee: a.organizerFee + BigInt(l.organizerFee), net: a.net + BigInt(l.net) }), { gross: 0n, platformFee: 0n, organizerFee: 0n, net: 0n });
    if (format === 'csv') {
      const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
      const head = 'pool_id,product,settled_at,units_delivered,gross_stroops,platform_fee_stroops,organizer_fee_stroops,net_stroops';
      return new StreamableFile(Buffer.from([head, ...lines.map((l) => [l.poolId, l.product, l.settledAt, l.unitsDelivered, l.gross, l.platformFee, l.organizerFee, l.net].map(esc).join(','))].join('\n')), { type: 'text/csv', disposition: 'attachment; filename="statement.csv"' });
    }
    return { lines, total: { gross: str(total.gross), platformFee: str(total.platformFee), organizerFee: str(total.organizerFee), net: str(total.net) }, currency: 'USDC stroops' };
  }
}
