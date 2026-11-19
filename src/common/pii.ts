import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-layer encryption for personal data at rest (brief 7.3: KYC results, bank details). AES-256-GCM with
 * a random 96-bit IV per value; the auth tag makes any tampering fail decryption. The key comes from the secret
 * manager (`ENCRYPTION_KEY_ID`) as base64 of 32 bytes and is never stored with the data.
 */
export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export class PiiCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY_ID must resolve to base64 of exactly 32 bytes (AES-256)');
  }

  seal(value: unknown): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  open<T = unknown>(s: Sealed): T {
    if (s?.v !== 1) throw new Error('unsupported sealed value');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8')) as T;
  }
}

/** Shows only the last 4 characters of an identifier (BVN, NIN, account number) for display and logs. */
export const mask = (id: string): string => (id.length <= 4 ? '****' : `${'*'.repeat(id.length - 4)}${id.slice(-4)}`);

/**
 * Error-reporting scrubber (#143). Anything sent to a third party (Sentry) passes through here first: keys that
 * name personal or secret data are replaced outright, and free text is pattern-scrubbed for phone numbers,
 * 10-11 digit identifiers (BVN, NIN, account numbers), bearer tokens and JWTs, wherever they appear.
 */
export const REDACTED = '[redacted]';

const SENSITIVE_KEY = /^(phone|phonenumber|msisdn|bvn|nin|accountnumber|account_number|otp|otpcode|password|passcode|pin|secret|token|accesstoken|refreshtoken|authorization|cookie|apikey|api_key)$/i;

const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\+?\d{1,3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  /\b\d{10,15}\b/g,
];

export function scrubText(text: string): string {
  return TEXT_PATTERNS.reduce((t, re) => t.replace(re, REDACTED), text);
}

/** Deep-copies `value`, redacting sensitive keys and scrubbing every string. Cycles and depth are bounded. */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8 || seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubValue(v, depth + 1, seen);
  return out;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export interface ScrubbableEvent {
  message?: string;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: unknown; query_string?: unknown };
  user?: unknown;
}

export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
  const b = breadcrumb as unknown as ScrubbableBreadcrumb;
  if (b.message !== undefined) b.message = scrubText(b.message);
  if (b.data !== undefined) b.data = scrubValue(b.data) as Record<string, unknown>;
  return breadcrumb;
}

/** Scrubs an error event in place: request bodies, cookies, headers and query strings are dropped entirely. */
export function scrubEvent<T extends object>(event: T): T {
  const e = event as unknown as ScrubbableEvent;
  if (e.request) {
    delete e.request.data;
    delete e.request.cookies;
    delete e.request.headers;
    delete e.request.query_string;
    if (e.request.url !== undefined) e.request.url = scrubText(e.request.url.split('?')[0]!);
  }
  delete e.user;
  if (e.message !== undefined) e.message = scrubText(e.message);
  if (e.extra !== undefined) e.extra = scrubValue(e.extra) as Record<string, unknown>;
  if (e.contexts !== undefined) e.contexts = scrubValue(e.contexts) as Record<string, unknown>;
  for (const b of e.breadcrumbs ?? []) scrubBreadcrumb(b);
  for (const v of e.exception?.values ?? []) if (v.value !== undefined) v.value = scrubText(v.value);
  return event;
}
