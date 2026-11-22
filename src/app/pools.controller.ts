import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { A } from '../chain/args.js';
import { canonicalJson, sha256Hex } from '../common/canonical-json.js';
import { formatUsdc, toStroops } from '../common/money.js';
import { unitLabelHash } from '../catalog/offer.js';
import { quote as priceQuote, ceilingPrice, tierIndex, validateCommitCaps } from '../pools/pricing.js';
import { renderShareCard } from '../sharecards/sharecard.js';
import { tiersUsdcFromJson, publicOffer } from './catalog.controller.js';
import { type AuthedUser, CurrentUser, parse, Public, Roles } from './http.js';
import { CACHE_CONTROL } from './http-setup.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';
import type { Prisma } from '../generated/prisma/client.js';

const naira = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Request bodies, exported so the OpenAPI examples are checked against exactly what the handlers parse (#178). */
export const poolPrepareBody = z.object({
  offerId: z.string(), fillDeadline: z.coerce.date(), hub: z.object({ address: z.string().min(3), contact: z.string().min(5) }),
  pickupWindow: z.object({ from: z.string(), to: z.string() }), organizerFeeBp: z.number().int().min(0).max(200).default(0), clusterOnly: z.boolean().default(false),
});
export const commitBody = z.object({ units: z.number().int().positive(), method: z.enum(['USDC', 'NGN']).default('USDC') });
export const poolListQuery = z.object({
  state: z.string().max(30).optional(), category: z.string().max(60).optional(), deliveryState: z.string().max(60).optional(),
  lga: z.string().max(60).optional(), cluster: z.string().max(30).optional(), cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20), mine: z.enum(['true', 'false']).default('false'),
});

const PUBLIC_POOL_STATES = ['Open'];
type PreviewView = Record<string, unknown>;

@Controller()
export class PoolsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async latestRate(): Promise<number | undefined> {
    const q = await this.s.prisma.fxQuote.findFirst({ orderBy: { createdAt: 'desc' } });
    return q ? Number(q.rate.toString()) : undefined;
  }

  /** Builds create_pool for the organizer and records the off-chain hub details under a unique hub hash. */
  @Roles('ORGANIZER') @Post('pools/prepare')
  async prepare(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(poolPrepareBody, body);
    const offer = await this.s.prisma.offer.findUnique({ where: { id: b.offerId } });
    if (!offer || offer.status !== 'LIVE' || offer.validUntil <= this.s.now()) throw new NotFoundException('offer is not available');
    const supplier = await this.s.prisma.user.findUniqueOrThrow({ where: { id: offer.supplierId } });
    if (!supplier.walletAddress) throw new BadRequestException('supplier has no wallet');
    const organizer = await walletOf(this.s, u.id);
    let cluster: string | undefined;
    if (b.clusterOnly) {
      cluster = (await this.s.prisma.traderProfile.findUnique({ where: { userId: u.id } }))?.cluster ?? undefined;
      if (!cluster) throw new BadRequestException({ error: 'NO_CLUSTER', message: 'Set your market first to restrict a pool to it' });
    }
    const hubHash = sha256Hex(canonicalJson({ address: b.hub.address, contact: b.hub.contact, nonce: randomBytes(16).toString('hex') }));
    const shareSlug = randomBytes(5).toString('hex');
    await this.s.prisma.pendingPool.create({
      data: { hubHash, offerId: offer.id, organizerAddress: organizer, hubAddress: b.hub.address, hubContact: b.hub.contact, pickupWindow: b.pickupWindow, fillDeadline: b.fillDeadline, shareSlug, cluster: cluster ?? null },
    });
    try {
      const prepared = await prepareAction(this.s, 'group_buy', 'create_pool', A.createPool(organizer, {
        supplier: supplier.walletAddress, offerHash: offer.offerHash, unitLabelHash: unitLabelHash(offer.unitLabel), category: offer.category,
        tiers: tiersUsdcFromJson(offer.tiersUsdc), moq: offer.moq, maxUnits: offer.maxUnits, maxPerMember: offer.maxPerMember,
        leadTimeSecs: offer.leadTimeHours * 3600, perishable: offer.perishable,
      }, hubHash, b.organizerFeeBp, cluster, Math.floor(b.fillDeadline.getTime() / 1000)));
      return { ...prepared, shareSlug, hubHash };
    } catch (e) {
      await this.s.prisma.pendingPool.delete({ where: { hubHash } }).catch(() => undefined);
      throw e;
    }
  }

  private async poolView(id: bigint) {
    const pool = await this.s.prisma.pool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('pool not found');
    const offer = await this.s.prisma.offer.findUnique({ where: { id: pool.offerId } });
    const tiers = offer ? tiersUsdcFromJson(offer.tiersUsdc) : [];
    const members = await this.s.prisma.commitment.count({ where: { poolId: id, units: { gt: 0 } } });
    const rate = await this.latestRate();
    const first = tiers[0];
    const price = first ? ceilingPrice(tiers, pool.totalUnits) : 0n;
    const next = tiers[(tierIndex(tiers, pool.totalUnits) ?? -1) + 1];
    return {
      pool, offer, tiers, members, rate,
      view: {
        id: pool.id.toString(), state: pool.state, shareSlug: pool.shareSlug, offerId: pool.offerId, organizer: pool.organizerAddress, supplier: pool.supplierAddress,
        hub: { address: pool.hubAddress, contact: pool.hubContact }, pickupWindow: pool.pickupWindow, fillDeadline: pool.fillDeadline,
        totalUnits: pool.totalUnits, receivedUnits: pool.receivedUnits, moq: offer?.moq ?? null, maxUnits: offer?.maxUnits ?? null, members,
        ngnPerUsd: rate ?? null,
        filledAt: pool.filledAt,
        progressPct: offer && offer.moq > 0 ? Math.min(100, Math.floor((pool.totalUnits * 100) / offer.moq)) : 0,
        currentUnitPriceUsdc: price.toString(), currentUnitPriceNaira: rate ? naira(((price * BigInt(Math.round(rate * 1e6))) / 10_000_000n / 1_000_000n)) : null,
        nextBreak: next ? { minUnits: next.minUnits, unitsToGo: next.minUnits - pool.totalUnits, unitPriceUsdc: next.unitPrice.toString() } : null,
        tiersUsdc: tiers.map((t) => ({ minUnits: t.minUnits, unitPrice: t.unitPrice.toString() })),
        finalUnitPriceUsdc: pool.finalUnitPrice ? toStroops(pool.finalUnitPrice.toString()).toString() : null, escrowBalanceUsdc: toStroops(pool.escrowBalance.toString()).toString(), // stroops, like every other *Usdc field here
        offer: offer ? publicOffer(offer) : null,
        trustMessage: 'Your money is held safely. The supplier is paid only after the goods arrive. If the group does not fill, you get everything back automatically.',
      },
    };
  }

  private async poolCards(rows: Prisma.PoolGetPayload<object>[]) {
    const ids = rows.map((p) => p.id);
    const [offers, counts, rate] = await Promise.all([
      this.s.prisma.offer.findMany({ where: { id: { in: [...new Set(rows.map((p) => p.offerId))] } } }),
      this.s.prisma.commitment.groupBy({ by: ['poolId'], where: { poolId: { in: ids }, units: { gt: 0 } }, _count: { _all: true } }),
      this.latestRate(),
    ]);
    const offerById = new Map(offers.map((o) => [o.id, o]));
    const membersById = new Map(counts.map((c) => [c.poolId, c._count._all]));
    return rows.map((p) => {
      const offer = offerById.get(p.offerId);
      const tiers = offer ? tiersUsdcFromJson(offer.tiersUsdc) : [];
      const first = tiers[0];
      const price = first ? ceilingPrice(tiers, p.totalUnits) : 0n;
      return {
        id: p.id.toString(), state: p.state, organizer: p.organizerAddress, supplier: p.supplierAddress, shareSlug: p.shareSlug,
        offerId: p.offerId, totalUnits: p.totalUnits, moq: offer?.moq ?? null,
        members: membersById.get(p.id) ?? 0, progressPct: offer && offer.moq > 0 ? Math.min(100, Math.floor((p.totalUnits * 100) / offer.moq)) : 0,
        fillDeadline: p.fillDeadline, title: offer?.title ?? null, unitLabel: offer?.unitLabel ?? null,
        currentUnitPriceNaira: rate ? naira(((price * BigInt(Math.round(rate * 1e6))) / 10_000_000n / 1_000_000n)) : null,
        hub: p.hubAddress, category: p.category, deliveryState: p.deliveryState, deliveryLga: p.deliveryLga, cluster: p.cluster,
      };
    });
  }

  @Get('pools/:id')
  async get(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const { view } = await this.poolView(BigInt(id));
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    const mine = wallet ? await this.s.prisma.commitment.findUnique({ where: { poolId_memberAddress: { poolId: BigInt(id), memberAddress: wallet } } }) : null;
    return { ...view, myCommitment: mine ? { units: mine.units, paid: mine.paid.toString(), pickedUp: mine.pickedUp } : null };
  }

  /** Public preview used by WhatsApp links. */
  @Public() @Get('p/:slug') @Header('Cache-Control', CACHE_CONTROL.livePreview)
  async preview(@Param('slug') slug: string): Promise<PreviewView> {
    const current = await this.s.prisma.pool.findUnique({ where: { shareSlug: slug }, select: { id: true, lastEventLedger: true } });
    if (!current) {
      this.s.previewCache.evictSlug(slug);
      throw new NotFoundException('pool not found');
    }
    const hit = this.s.previewCache.get(slug);
    if (hit && hit.poolId === current.id && hit.ledger === current.lastEventLedger) return hit.value as PreviewView;
    const { pool, view } = await this.poolView(current.id);
    this.s.previewCache.set(slug, view, pool.id, pool.lastEventLedger);
    return view;
  }

  @Public() @Get('pools')
  async list(@CurrentUser() u: AuthedUser | undefined, @Res({ passthrough: true }) res: Response, @Query() query: Record<string, string | undefined>) {
    const q = parse(poolListQuery, query ?? {});
    const wallet = u ? (await this.s.prisma.user.findUnique({ where: { id: u.id }, select: { walletAddress: true } }))?.walletAddress : undefined;
    const conditions: Prisma.PoolWhereInput[] = [];
    if (!u) conditions.push({ state: { in: [...PUBLIC_POOL_STATES] } });
    else if (!q.state && q.mine !== 'true') conditions.push({ state: 'Open' });
    if (q.state) conditions.push({ state: q.state });
    if (q.category) conditions.push({ category: q.category });
    if (q.deliveryState) conditions.push({ deliveryState: q.deliveryState });
    if (q.lga) conditions.push({ deliveryLga: q.lga });
    if (q.cluster) conditions.push({ cluster: q.cluster });
    if (q.mine === 'true') {
      if (!wallet) return [];
      const joined = (await this.s.prisma.commitment.findMany({ where: { memberAddress: wallet, units: { gt: 0 } }, select: { poolId: true } })).map((c) => c.poolId);
      conditions.push({ OR: [{ organizerAddress: wallet }, { supplierAddress: wallet }, { id: { in: joined } }] });
    }
    const rows = await this.s.prisma.pool.findMany({
      where: { AND: conditions }, orderBy: { id: 'desc' }, take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: BigInt(q.cursor) }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    if (rows.length > q.limit) res.setHeader('X-Next-Cursor', page[page.length - 1]!.id.toString());
    return this.poolCards(page);
  }

  @Get('pools/:id/quote')
  async quote(@Param('id') id: string, @Query('units') units: string) {
    const n = Number(units);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('units must be a positive integer');
    const { pool, tiers, rate } = await this.poolView(BigInt(id));
    if (!tiers.length) throw new BadRequestException('pool has no offer terms');
    const q = priceQuote(tiers, pool.totalUnits, n);
    const ngn = (x: bigint) => (rate ? naira((x * BigInt(Math.round(rate * 1e6)) + 9_999_999_999_999n) / 10_000_000_000_000n) : null);
    return {
      units: n, amountNowUsdc: q.amountNow.toString(), amountNowDisplay: formatUsdc(q.amountNow), amountNowNairaEstimate: ngn(q.amountNow),
      currentUnitPriceUsdc: q.currentUnitPrice.toString(), expectedRefundIfClosedNowUsdc: q.expectedRefundIfClosedNow.toString(),
      nextBreak: q.nextBreak ? { minUnits: q.nextBreak.minUnits, unitsToGo: q.nextBreak.unitsToGo, unitPriceUsdc: q.nextBreak.unitPrice.toString() } : null,
      note: 'Naira amounts are indicative. You pay the current tier price now; if the pool reaches a better tier you are refunded the difference automatically.',
    };
  }

  /** `?variant=wide|square` (#175) and `?lang=pcm` (#176); each combination is a distinct URL, so caches key on both. */
  @Public() @Get('pools/:id/sharecard.png') @Header('Content-Type', 'image/png') @Header('Cache-Control', CACHE_CONTROL.shareCard)
  async shareCard(@Param('id') id: string, @Query() query: unknown) {
    const q = parse(z.object({
      variant: z.enum(['wide', 'square']).default('wide'),
      lang: z.enum(['en', 'pcm']).default('en'),
    }), query ?? {});
    const { view, offer } = await this.poolView(BigInt(id));
    const unitsToMoq = Math.max(0, (view.moq ?? 0) - view.totalUnits);
    return new StreamableFile(await renderShareCard({
      product: offer?.title ?? 'Group buy', supplier: offer?.brand ?? 'Verified supplier', currentPriceNaira: view.currentUnitPriceNaira ?? '—',
      nextBreak: view.nextBreak ? { unitsToGo: view.nextBreak.unitsToGo, priceNaira: view.currentUnitPriceNaira ?? '—' } : undefined,
      unitsToMoq, progressPct: view.progressPct, deadline: view.fillDeadline,
    }, q.variant, q.lang === 'pcm' ? 'PCM' : 'EN'));
  }

  private async assertCommitCaps(userId: string, wallet: string, poolId: bigint, units: number): Promise<void> {
    const [pool, role, rep] = await Promise.all([
      this.s.prisma.pool.findUnique({ where: { id: poolId } }),
      this.s.prisma.userRole.findUnique({ where: { userId_role: { userId, role: 'TRADER' } }, select: { level: true } }),
      this.s.prisma.reputationTier.findUnique({ where: { subject_role: { subject: wallet, role: 'Trader' } }, select: { tier: true } }),
    ]);
    if (!pool) return;
    const offer = await this.s.prisma.offer.findUnique({ where: { id: pool.offerId } });
    if (!offer) return;
    const tiers = tiersUsdcFromJson(offer.tiersUsdc);
    if (!tiers.length) return;
    const [commitment, memberCount, listedMembers] = await Promise.all([
      this.s.prisma.commitment.findUnique({ where: { poolId_memberAddress: { poolId, memberAddress: wallet } } }),
      this.s.prisma.commitment.count({ where: { poolId, units: { gt: 0 } } }),
      this.s.prisma.commitment.count({ where: { poolId } }),
    ]);
    const failure = validateCommitCaps({
      tiers, poolTotalUnits: pool.totalUnits, maxPerMember: offer.maxPerMember, maxUnits: offer.maxUnits,
      maxMemberShareBp: this.s.env.COMMIT_MAX_MEMBER_SHARE_BP, maxMembersPerPool: this.s.env.COMMIT_MAX_MEMBERS_PER_POOL,
      traderTierCaps: this.s.env.COMMIT_TRADER_TIER_CAPS_STROOPS.split(',').map((x) => BigInt(x.trim())),
      memberUnits: commitment?.units ?? 0, memberPaid: commitment ? toStroops(commitment.paid.toString()) : 0n,
      memberCount, listedMembers, isListed: !!commitment, registryLevel: role?.level ?? 0, reputationTier: rep?.tier ?? 0, units,
    });
    if (failure) throw new BadRequestException(failure);
  }

  /** Thin wrappers that turn one user intent into a contract call; the contract enforces every rule. */
  @Post('pools/:id/:action/prepare')
  async act(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const poolId = BigInt(id);
    const me = await walletOf(this.s, u.id);
    const units = () => parse(z.object({ units: z.number().int().positive() }), body).units;
    switch (action) {
      case 'commit': {
        const b = parse(commitBody, body);
        if (b.method === 'NGN') throw new BadRequestException({ error: 'NOT_IMPLEMENTED', message: 'Naira payments arrive with the anchor integration' });
        await this.assertCommitCaps(u.id, me, poolId, b.units);
        return prepareAction(this.s, 'group_buy', 'commit', A.commit(me, poolId, b.units));
      }
      case 'increase': return prepareAction(this.s, 'group_buy', 'increase', A.commit(me, poolId, units()));
      case 'withdraw': return prepareAction(this.s, 'group_buy', 'withdraw_commitment', A.withdraw(me, poolId));
      case 'close-early': return prepareAction(this.s, 'group_buy', 'close_early', A.closeEarly(me, poolId));
      case 'accept': {
        const b = parse(z.object({ advanceBp: z.number().int().min(0).max(4000).default(0) }), body ?? {});
        return prepareAction(this.s, 'group_buy', 'accept', A.accept(me, poolId, b.advanceBp));
      }
      case 'reject': return prepareAction(this.s, 'group_buy', 'reject', A.reject(me, poolId));
      case 'dispatch': {
        const b = parse(z.object({ waybillHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }), body ?? {});
        return prepareAction(this.s, 'group_buy', 'dispatch', A.dispatch(me, poolId, b.waybillHash));
      }
      case 'delivery': {
        const b = parse(z.object({ receivedUnits: z.number().int().min(0), evidenceIds: z.array(z.string()).min(1) }), body);
        const rows = await this.s.prisma.evidence.findMany({ where: { id: { in: b.evidenceIds }, poolId, ownerId: u.id } });
        if (rows.length !== b.evidenceIds.length || rows.some((r) => !r.sha256)) throw new BadRequestException({ error: 'EVIDENCE_INVALID', message: 'Upload your delivery photos first' });
        // One on-chain hash for the whole bundle: sha256 of the sorted file hashes.
        const bundle = createHash('sha256').update(rows.map((r) => r.sha256).sort().join('')).digest('hex');
        return prepareAction(this.s, 'group_buy', 'confirm_delivery', A.confirmDelivery(me, poolId, b.receivedUnits, bundle));
      }
      case 'pickup': return prepareAction(this.s, 'group_buy', 'confirm_pickup', A.pickup(me, poolId));
      case 'refund': return prepareAction(this.s, 'group_buy', 'claim_refund', A.claimRefund(me, poolId));
      case 'member-confirm': return prepareAction(this.s, 'group_buy', 'member_confirm_delivery', A.memberConfirm(me, poolId));
      default: throw new NotFoundException(`unknown action ${action}`);
    }
  }
}
