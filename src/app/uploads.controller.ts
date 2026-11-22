import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, StreamableFile, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { canReadEvidence, evidenceHash, KYB_ALLOWED_MIME, KYB_DOCUMENT_KINDS, signUrl, THUMB_WIDTHS, thumbKey, toPublicThumbnail, validateUpload, verifySignedUrl } from '../evidence/evidence.js';
import { type AuthedUser, CurrentUser, parse, Public } from './http.js';
import { SERVICES, type Services } from './services.js';

@Controller()
export class UploadsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private secret(): string {
    return this.s.env.JWT_SECRET + ':uploads';
  }

  /** Step 1: declare the file; returns a short-lived signed PUT URL. The server computes the hash, not the client. */
  @Post('uploads/sign')
  async sign(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({
      kind: z.enum(['DELIVERY', 'DISPUTE', 'WAYBILL', 'PRODUCT', ...KYB_DOCUMENT_KINDS]), mime: z.string(), size: z.number().int(),
      poolId: z.string().regex(/^\d+$/).optional(), disputeId: z.string().regex(/^\d+$/).optional(),
    }), body);
    const problem = validateUpload(b.mime, b.size);
    if (problem) throw new BadRequestException({ error: 'UPLOAD_INVALID', message: problem });
    if (b.kind === 'PRODUCT' && !u.roles.includes('SUPPLIER')) throw new ForbiddenException('only suppliers upload product images');
    if ((KYB_DOCUMENT_KINDS as readonly string[]).includes(b.kind)) {
      if (!(KYB_ALLOWED_MIME as readonly string[]).includes(b.mime)) throw new BadRequestException({ error: 'UPLOAD_INVALID', message: 'KYB documents must be PDF, JPEG or PNG' });
      if (!(await this.s.prisma.supplierProfile.findUnique({ where: { userId: u.id } }))) throw new ForbiddenException('apply as a supplier before uploading KYB documents');
    }
    const row = await this.s.prisma.evidence.create({
      data: { ownerId: u.id, poolId: b.poolId ? BigInt(b.poolId) : null, disputeId: b.disputeId ? BigInt(b.disputeId) : null, kind: b.kind, objectKey: '', sha256: '', mime: b.mime },
    });
    const objectKey = `${b.kind.toLowerCase()}/${row.id}`;
    await this.s.prisma.evidence.update({ where: { id: row.id }, data: { objectKey } });
    const signed = signUrl(this.secret(), 'PUT', objectKey, u.id, this.s.now().getTime());
    return { evidenceId: row.id, objectKey, uploadUrl: signed.url, expires: signed.expires };
  }

  /** Step 2: raw bytes to the signed URL. Public routes authenticate by signature only. */
  @Public() @Put('uploads/put') @HttpCode(200)
  async put(@Query() q: Record<string, string>, @Body() bytes: Buffer) {
    const p = { key: q.key ?? '', u: q.u ?? '', e: Number(q.e), s: q.s ?? '' };
    if (!verifySignedUrl(this.secret(), 'PUT', p, this.s.now().getTime())) throw new UnauthorizedException('upload URL is invalid or expired');
    const row = await this.s.prisma.evidence.findFirst({ where: { objectKey: p.key, ownerId: p.u } });
    if (!row) throw new NotFoundException('unknown upload');
    if (row.sha256) throw new BadRequestException({ error: 'ALREADY_UPLOADED', message: 'This upload slot is already used' });
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new BadRequestException('empty body');
    const problem = validateUpload(row.mime, bytes.length);
    if (problem) throw new BadRequestException({ error: 'UPLOAD_INVALID', message: problem });
    // Public product photos are re-encoded as small WebP with metadata stripped (no EXIF location).
    const isPublic = row.kind === 'PRODUCT';
    let stored: Uint8Array = bytes;
    if (isPublic) {
      try {
        stored = await toPublicThumbnail(bytes);
      } catch {
        // Undecodable bytes are the uploader's problem (a 400 they can act on), not a server fault.
        throw new BadRequestException({ error: 'IMAGE_INVALID', message: 'That file could not be read as an image' });
      }
    }
    await this.s.store.put(isPublic ? 'public' : 'evidence', p.key, stored);
    if (isPublic) await this.storeThumbnails(p.key, stored);
    const sha = evidenceHash(stored);
    await this.s.prisma.evidence.update({ where: { id: row.id }, data: { sha256: sha, mime: isPublic ? 'image/webp' : row.mime } });
    return { evidenceId: row.id, sha256: sha };
  }

  /**
   * Thumbnails for a product photo (#104), stored beside the original. Best effort: a failure is logged and never
   * fails the upload, because the original is already stored and usable.
   */
  private async storeThumbnails(objectKey: string, original: Uint8Array): Promise<void> {
    for (const width of THUMB_WIDTHS) {
      try {
        await this.s.store.put('public', thumbKey(objectKey, width), await toPublicThumbnail(original, width));
      } catch (e) {
        console.warn(`[uploads] ${width}px thumbnail failed for ${objectKey}: ${(e as Error).message}`);
      }
    }
  }

  /** The caller's own uploaded KYB documents (#131); read them through `GET /evidence/:id/url`. */
  @Get('suppliers/documents')
  async myDocuments(@CurrentUser() u: AuthedUser) {
    const docs = await this.s.prisma.evidence.findMany({ where: { ownerId: u.id, kind: { in: [...KYB_DOCUMENT_KINDS] }, NOT: { sha256: '' } }, orderBy: { createdAt: 'asc' } });
    return docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, sha256: d.sha256, uploadedAt: d.createdAt }));
  }

  /** Short-lived read URL (5 minutes) for participants, arbiters and admins. */
  @Get('evidence/:id/url')
  async readUrl(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const ev = await this.s.prisma.evidence.findUnique({ where: { id } });
    if (!ev || !ev.sha256) throw new NotFoundException('evidence not found');
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    let isPoolParticipant = ev.ownerId === u.id;
    if (!isPoolParticipant && wallet && ev.poolId !== null) {
      const pool = await this.s.prisma.pool.findUnique({ where: { id: ev.poolId } });
      const member = await this.s.prisma.commitment.findUnique({ where: { poolId_memberAddress: { poolId: ev.poolId, memberAddress: wallet } } });
      isPoolParticipant = !!pool && (pool.organizerAddress === wallet || pool.supplierAddress === wallet || (member?.units ?? 0) > 0);
    }
    // Evidence is uploaded before a dispute exists, so it is linked to the pool, not the dispute. An arbiter may read
    // evidence of any pool that currently has an open dispute (and nothing else).
    let disputeId = ev.disputeId;
    if (disputeId === null && ev.poolId !== null && u.roles.includes('ARBITER')) {
      disputeId = (await this.s.prisma.dispute.findFirst({ where: { poolId: ev.poolId, state: 'OPEN' } }))?.id ?? null;
    }
    if (!canReadEvidence({ userId: u.id, roles: u.roles, isPoolParticipant, disputeId, assignedArbiterFor: disputeId ?? undefined })) {
      throw new ForbiddenException('not allowed to read this evidence');
    }
    return signUrl(this.secret(), 'GET', ev.objectKey, u.id, this.s.now().getTime());
  }

  /** Public product photos only (kind PRODUCT): already resized, metadata-stripped WebP. Everything else needs a signed URL. */
  /** `?w=320` or `?w=800` returns that thumbnail (#104); any other value, or none, returns the original. */
  @Public() @Get('images/:id') @Header('Cache-Control', 'public, max-age=86400, immutable')
  async image(@Param('id') id: string, @Query('w') w?: string) {
    const ev = await this.s.prisma.evidence.findUnique({ where: { id } });
    const width = THUMB_WIDTHS.find((x) => String(x) === w);
    const objectKey = ev && ev.kind === 'PRODUCT' && ev.sha256 ? ev.objectKey : null;
    let bytes: Buffer | null = null;
    if (objectKey) {
      if (width) bytes = await this.s.store.get('public', thumbKey(objectKey, width));
      // A missing thumbnail (uploaded before #104, or its generation failed) falls back to the original.
      if (!bytes) bytes = await this.s.store.get('public', objectKey);
    }
    if (!ev || !bytes) throw new NotFoundException('image not found');
    return new StreamableFile(bytes, { type: 'image/webp' });
  }

  @Public() @Get('evidence/file') @Header('Cache-Control', 'private, no-store')
  async file(@Query() q: Record<string, string>) {
    const p = { key: q.key ?? '', u: q.u ?? '', e: Number(q.e), s: q.s ?? '' };
    if (!verifySignedUrl(this.secret(), 'GET', p, this.s.now().getTime())) throw new UnauthorizedException('link is invalid or expired');
    const ev = await this.s.prisma.evidence.findFirst({ where: { objectKey: p.key } });
    const bytes = ev ? await this.s.store.get(ev.kind === 'PRODUCT' ? 'public' : 'evidence', p.key) : null;
    if (!ev || !bytes) throw new NotFoundException('file not found');
    return new StreamableFile(bytes, { type: ev.mime });
  }
}
