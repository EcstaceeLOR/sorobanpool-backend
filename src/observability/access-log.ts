import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Structured access logs (#147): one JSON line per request with method, route template, status, duration, user id
 * and request id. The user is identified by id only (never phone), the body is never logged, and query values pass
 * through `redact` so identity numbers, bank details, phones and credentials cannot reach the log pipeline.
 */
export type AccessLogSink = (line: string) => void;

export const stdoutSink: AccessLogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Normalised (lowercase, alphanumeric only) keys whose values are always replaced. */
const SENSITIVE_KEYS = new Set([
  'phone', 'phonenumber', 'msisdn', 'bvn', 'nin', 'cac', 'cacnumber', 'rcnumber', 'accountnumber', 'bankaccount',
  'iban', 'otp', 'code', 'password', 'secret', 'authorization', 'signature', 'apikey', 'token',
]);

/** Any key ending like this is treated as a credential (accessToken, refresh_token, clientSecret, ...). */
const SENSITIVE_SUFFIXES = ['token', 'secret', 'password', 'phone', 'accountnumber'];

/** Long digit runs are phone, BVN, NIN or account numbers whatever key they sit under. */
const LONG_DIGITS = /\+?\d[\d\s-]{8,}\d/g;

export const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_SUFFIXES.some((s) => k.endsWith(s));
}

/** Returns a copy of `value` that is safe to log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return value.replace(LONG_DIGITS, REDACTED);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Express middleware; register it first so it also logs requests rejected before routing (413, 401, 404). */
export function accessLog(sink: AccessLogSink) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      // Route template, never the raw URL, so ids and tokens in paths stay out of the log.
      const route = (req.route as { path?: string } | undefined)?.path;
      const user = (req as Request & { user?: { id?: string } }).user;
      sink(JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'request',
        requestId,
        method: req.method,
        route: route ? `${req.baseUrl ?? ''}${route}` : 'unmatched',
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
        userId: user?.id ?? null,
        query: redact(req.query),
      }));
    });
    next();
  };
}
