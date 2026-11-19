import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, GoneException, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { A, type Role } from '../chain/args.js';
import { sha256Hex } from '../common/canonical-json.js';
import { type AuthedUser, CurrentUser, parse, Roles } from './http.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

const roleSchema = z.enum(['Trader', 'Organizer', 'Supplier']);

@Controller()
export class AdminController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private audit(actorId: string, action: string, target: string, data: object) {
    return this.s.prisma.auditLog.create({ data: { actorId, action, target, data } });
  }

  /** The user signs their own on-chain registration; profile_hash carries no personal data. */
  @Post('registry/register/prepare')
  async register(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({ role: roleSchema, cluster: z.string().max(30).optional() }), body);
    const profileHash = sha256Hex(`${u.id}:${b.role}`);
    return prepareAction(this.s, 'registry', 'register', A.register(await walletOf(this.s, u.id), b.role as Role, profileHash, b.cluster));
  }

  @Roles('ADMIN') @Get('admin/suppliers')
  async suppliers(@Query('status') status = 'PENDING') {
    const rows = await this.s.prisma.supplierProfile.findMany({ where: { kybStatus: status }, orderBy: { userId: 'asc' }, take: 100 });
    const records = await this.s.prisma.verificationRecord.findMany({ where: { id: { in: rows.map((r) => r.kybRecordId).filter((x): x is string => !!x) } } });
    // Reviewers see each automated check's outcome; the personal data behind them stays encrypted.
    const checks = new Map(records.map((r) => {
      const c = this.s.pii.open<{ checks: Record<string, { ok: boolean; reason?: string } | null> }>(r.result as never).checks;
      return [r.id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ? (v.ok ? 'PASSED' : v.reason ?? 'FAILED') : 'NOT_PROVIDED']))];
    }));
    return rows.map((r) => ({ ...r, kybChecks: (r.kybRecordId && checks.get(r.kybRecordId)) || null }));
  }

  /** Approves or rejects a supplier. Approval writes a verification hash on-chain with the attestor key. */
  @Roles('ADMIN') @Post('admin/suppliers/:userId/decision') @HttpCode(200)
  async decide(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), body);
    const profile = await this.s.prisma.supplierProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('supplier application not found');
    if (!b.approve) {
      await this.s.prisma.supplierProfile.update({ where: { userId }, data: { kybStatus: 'REJECTED' } });
      await this.audit(admin.id, 'supplier.reject', userId, b.note === undefined ? {} : { note: b.note });
      return { kybStatus: 'REJECTED' };
    }
    return this.requestApproval(admin.id, 'supplier.approve', userId, b.note === undefined ? {} : { note: b.note });
  }

  @Roles('ADMIN') @Get('admin/actions')
  async pendingActions() {
    const rows = await this.s.prisma.pendingAdminAction.findMany({
      where: { status: 'PENDING', expiresAt: { gt: this.s.now() } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, action: true, target: true, actorId: true, createdAt: true, expiresAt: true },
    });
    return rows;
  }

  @Roles('ADMIN') @Post('admin/actions/:id/approve') @HttpCode(200)
  async approveAction(@CurrentUser() admin: AuthedUser, @Param('id') id: string) {
    const pending = await this.s.prisma.pendingAdminAction.findUnique({ where: { id } });
    if (!pending) throw new NotFoundException('pending admin action not found');
    if (pending.actorId === admin.id) throw new ForbiddenException('another admin must approve this action');
    const now = this.s.now();
    if (pending.status === 'PENDING' && pending.expiresAt <= now) {
      await this.s.prisma.pendingAdminAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      await this.audit(admin.id, 'admin.action.expired', id, { requestedBy: pending.actorId, action: pending.action, target: pending.target });
      throw new GoneException('pending admin action has expired');
    }
    const claimed = await this.s.prisma.pendingAdminAction.updateMany({
      where: { id, actorId: { not: admin.id }, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'PROCESSING', approvedBy: admin.id },
    });
    if (claimed.count !== 1) throw new ConflictException('pending admin action is expired or already being processed');

    try {
      let result: Record<string, unknown>;
      let action: string;
      let auditData: Prisma.InputJsonObject;
      if (pending.action === 'supplier.approve') {
        const { note } = parse(z.object({ note: z.string().max(500).optional() }), pending.payload);
        const profile = await this.s.prisma.supplierProfile.findUnique({ where: { userId: pending.target } });
        if (!profile) throw new NotFoundException('supplier application not found');
        const tx = await this.attest(pending.target, 'Supplier', 1);
        action = 'supplier.approve';
        auditData = { requestedBy: pending.actorId, ...(note === undefined ? {} : { note }), tx: tx.hash };
        result = { kybStatus: 'APPROVED', txHash: tx.hash };
        await this.s.prisma.$transaction(async (db) => {
          await db.supplierProfile.update({ where: { userId: pending.target }, data: { kybStatus: 'APPROVED' } });
          await db.userRole.upsert({ where: { userId_role: { userId: pending.target, role: 'SUPPLIER' } }, create: { userId: pending.target, role: 'SUPPLIER', level: 1, verHash: tx.verHash }, update: { level: 1, verHash: tx.verHash } });
          await db.pendingAdminAction.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: now } });
          await db.auditLog.create({ data: { actorId: admin.id, action, target: pending.target, data: auditData } });
          await db.auditLog.create({ data: { actorId: admin.id, action: 'admin.action.approve', target: id, data: { requestedBy: pending.actorId, action: pending.action, target: pending.target } } });
        });
      } else if (pending.action === 'user.suspend') {
        const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), pending.payload);
        const prepared = await this.prepareSuspension(admin, pending.target);
        action = 'user.suspend';
        auditData = { requestedBy: pending.actorId, reason };
        result = { ...prepared, status: 'SUSPENDED' };
        await this.s.prisma.$transaction(async (db) => {
          await db.user.update({ where: { id: pending.target }, data: { status: 'SUSPENDED' } });
          await db.pendingAdminAction.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: now } });
          await db.auditLog.create({ data: { actorId: admin.id, action, target: pending.target, data: auditData } });
          await db.auditLog.create({ data: { actorId: admin.id, action: 'admin.action.approve', target: id, data: { requestedBy: pending.actorId, action: pending.action, target: pending.target } } });
        });
      } else {
        throw new ConflictException('unsupported pending admin action');
      }
      return result;
    } catch (error) {
      await this.s.prisma.pendingAdminAction.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PENDING', approvedBy: null } });
      throw error;
    }
  }

  /** Writes a verification (KYC) level for a trader or organizer. */
  @Roles('ADMIN') @Post('admin/users/:userId/attest') @HttpCode(200)
  async attestUser(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ role: roleSchema, level: z.number().int().min(1).max(5) }), body);
    const tx = await this.attest(userId, b.role, b.level);
    const dbRole = b.role.toUpperCase();
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId, role: dbRole } }, create: { userId, role: dbRole, level: b.level, verHash: tx.verHash }, update: { level: b.level, verHash: tx.verHash } });
    await this.audit(admin.id, 'user.attest', userId, { role: b.role, level: b.level, tx: tx.hash });
    return { txHash: tx.hash };
  }

  /** Grants an application role (e.g. ORGANIZER, ARBITER). On-chain standing comes from registration plus attestation. */
  @Roles('ADMIN') @Post('admin/users/:userId/roles') @HttpCode(200)
  async grant(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const { role } = parse(z.object({ role: z.enum(['ORGANIZER', 'ARBITER', 'TRADER']) }), body);
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId, role } }, create: { userId, role }, update: {} });
    await this.audit(admin.id, 'role.grant', userId, { role });
    return { ok: true };
  }

  @Roles('ADMIN') @Post('admin/users/:id/suspend') @HttpCode(200)
  async suspend(@CurrentUser() admin: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), body);
    const user = await this.s.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    return this.requestApproval(admin.id, 'user.suspend', id, { reason });
  }

  @Roles('ADMIN') @Post('admin/users/:id/unsuspend') @HttpCode(200)
  async unsuspend(@CurrentUser() admin: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), body);
    return this.setSuspension(admin, id, reason);
  }

  @Roles('ADMIN') @Post('admin/offers/:id/takedown') @HttpCode(200)
  async takedown(@CurrentUser() admin: AuthedUser, @Param('id') id: string) {
    await this.s.prisma.offer.update({ where: { id }, data: { status: 'TAKEN_DOWN' } });
    await this.audit(admin.id, 'offer.takedown', id, {}); // affects new pools only; existing pools keep their snapshot
    return { status: 'TAKEN_DOWN' };
  }

  @Roles('ADMIN') @Get('admin/audit')
  async auditLog(@Query('limit') limit = '50') {
    return this.s.prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  }

  private async attest(userId: string, role: Role, level: number): Promise<{ hash: string; verHash: string }> {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    // Manual admin review: the reference is the review itself. The capped attestor writes only a salted hash on-chain.
    return this.s.attestations.attest(userId, user.walletAddress, role, level, 'admin-review', 'admin');
  }

  private async setSuspension(admin: AuthedUser, userId: string, reason: string) {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    const action = 'unsuspend';
    const prepared = await prepareAction(this.s, 'registry', action, A.unsuspend(await walletOf(this.s, admin.id), user.walletAddress));
    const status = 'ACTIVE';
    await this.s.prisma.user.update({ where: { id: userId }, data: { status } });
    await this.audit(admin.id, `user.${action}`, userId, { reason });
    return { ...prepared, status };
  }

  private async prepareSuspension(admin: AuthedUser, userId: string) {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    return prepareAction(this.s, 'registry', 'suspend', A.suspend(await walletOf(this.s, admin.id), user.walletAddress));
  }

  private async requestApproval(actorId: string, action: string, target: string, payload: Prisma.InputJsonObject) {
    const expiresAt = new Date(this.s.now().getTime() + this.s.env.ADMIN_ACTION_EXPIRY_MINUTES * 60_000);
    const pending = await this.s.prisma.$transaction(async (db) => {
      const row = await db.pendingAdminAction.create({
        data: { action, target, actorId, payload, expiresAt },
      });
      await db.auditLog.create({ data: { actorId, action: 'admin.action.requested', target, data: { action, actionId: row.id, expiresAt: expiresAt.toISOString() } } });
      return row;
    });
    return { status: 'PENDING_APPROVAL', actionId: pending.id, expiresAt };
  }
}
