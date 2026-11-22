import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'] as const;
export const SIGNED_URL_TTL_SECONDS = 300;

/** Supplier KYB document kinds (#131). Stored privately; only the owner and admins can get a read URL. */
export const KYB_DOCUMENT_KINDS = ['KYB_CAC_CERTIFICATE', 'KYB_PROOF_OF_ADDRESS', 'KYB_DIRECTOR_ID'] as const;
export const KYB_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export function validateUpload(mime: string, sizeBytes: number): string | null {
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) return `file type ${mime} is not allowed`;
  if (sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) return `file must be between 1 byte and ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB`;
  return null;
}

/** sha256 of the stored bytes; the hash goes on-chain, the bytes stay in access-controlled storage. */
export const evidenceHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Who may read a piece of evidence: pool participants, the assigned arbiter, and admins. */
export interface EvidenceAccess {
  userId: string;
  roles: string[];
  isPoolParticipant: boolean;
  assignedArbiterFor?: bigint;
  disputeId?: bigint | null;
}

export function canReadEvidence(a: EvidenceAccess): boolean {
  if (a.roles.includes('ADMIN')) return true;
  if (a.isPoolParticipant) return true;
  return a.roles.includes('ARBITER') && a.disputeId != null && a.assignedArbiterFor === a.disputeId;
}

/** HMAC over purpose|key|user|expiry. The purpose (GET/PUT) keeps a read link from ever authorising a write. */
function mac(secret: string, purpose: string, objectKey: string, userId: string, expires: number): string {
  return createHmac('sha256', secret).update(`${purpose}|${objectKey}|${userId}|${expires}`).digest('base64url');
}

export function signParts(secret: string, purpose: 'GET' | 'PUT', objectKey: string, userId: string, now = Date.now()): { e: number; s: string } {
  const e = Math.floor(now / 1000) + SIGNED_URL_TTL_SECONDS;
  return { e, s: mac(secret, purpose, objectKey, userId, e) };
}

/** Short-lived (5 minute) signed URL for local/dev storage; S3 deployments use native presigned URLs instead. */
export function signUrl(secret: string, purpose: 'GET' | 'PUT', objectKey: string, userId: string, now = Date.now()): { url: string; expires: number } {
  const { e, s } = signParts(secret, purpose, objectKey, userId, now);
  const path = purpose === 'PUT' ? '/v1/uploads/put' : '/v1/evidence/file';
  return { url: `${path}?key=${encodeURIComponent(objectKey)}&u=${encodeURIComponent(userId)}&e=${e}&s=${s}`, expires: e };
}

export function verifySignedUrl(secret: string, purpose: 'GET' | 'PUT', p: { key: string; u: string; e: number; s: string }, now = Date.now()): boolean {
  if (!Number.isFinite(p.e) || p.e < Math.floor(now / 1000)) return false;
  const a = Buffer.from(mac(secret, purpose, p.key, p.u, p.e));
  const b = Buffer.from(p.s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public product images: resize to a low-bandwidth WebP and drop all metadata (EXIF GPS included). */
export async function toPublicThumbnail(input: Uint8Array, width = 640): Promise<Buffer> {
  return sharp(input).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}

/** Widths of the WebP thumbnails made beside each product photo (#104): feeds use 320, detail views 800. */
export const THUMB_WIDTHS = [320, 800] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

/** Object key of a thumbnail; it sits next to the original in the public bucket. */
export const thumbKey = (objectKey: string, width: ThumbWidth): string => `${objectKey}@${width}.webp`;
