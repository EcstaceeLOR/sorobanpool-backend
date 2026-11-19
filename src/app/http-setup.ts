import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { Env } from '../config/env.js';
import { accessLog, stdoutSink, type AccessLogSink } from '../observability/access-log.js';

/** Media and evidence uploads arrive as raw bodies; everything else is JSON. */
export const UPLOAD_TYPES = ['image/*', 'video/mp4', 'application/pdf'];

/** `Cache-Control` per public route class (#174). Authenticated routes set none, so nothing private is cached. */
export const CACHE_CONTROL = {
  /** Offers change only when a supplier edits or publishes them. */
  catalog: 'public, max-age=60, stale-while-revalidate=300',
  /** Public pool previews show live progress, so they go stale quickly. */
  livePreview: 'public, max-age=15, stale-while-revalidate=60',
  /** Share card PNGs are re-rendered from pool state; a minute keeps WhatsApp previews cheap without lying for long. */
  shareCard: 'public, max-age=60',
} as const;

type HttpEnv = Pick<Env, 'PUBLIC_APP_URL' | 'JSON_BODY_LIMIT' | 'UPLOAD_BODY_LIMIT' | 'COMPRESSION_THRESHOLD_BYTES'>;

/**
 * The HTTP surface shared by `main.ts` and the test harness, so tests exercise the same headers, limits and
 * compression that production serves (#171, #172, #174).
 */
export function configureHttp(
  app: NestExpressApplication,
  env: HttpEnv,
  opts: { accessLog?: AccessLogSink } = {},
): void {
  app.setGlobalPrefix('v1');
  // First, so every request is logged, including ones rejected by body limits, CORS or auth (#147).
  app.use(accessLog(opts.accessLog ?? stdoutSink));
  app.use(helmet());
  app.enableCors({ origin: [env.PUBLIC_APP_URL], credentials: true });
  // Small JSON limit keeps a flood of large bodies from exhausting memory; uploads keep their own, larger limit.
  app.useBodyParser('json', { limit: env.JSON_BODY_LIMIT });
  app.useBodyParser('raw', { type: UPLOAD_TYPES, limit: env.UPLOAD_BODY_LIMIT });
  app.use(payloadTooLarge);
  app.use(compressJson(env.COMPRESSION_THRESHOLD_BYTES));
}

/** Body-parser rejects oversize bodies before any route runs; answer with the API's JSON error shape, not HTML. */
export function payloadTooLarge(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; limit?: number } | undefined;
  if (e?.type !== 'entity.too.large') {
    next(err);
    return;
  }
  res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: `Request body exceeds the ${e.limit} byte limit` });
}

/** True when `encoding` is listed in Accept-Encoding without `q=0`. */
export function acceptsEncoding(header: string | undefined, encoding: string): boolean {
  return (header ?? '').split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name?.trim().toLowerCase() !== encoding) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * Compresses JSON GET responses at or above `thresholdBytes` with brotli, or gzip when brotli is not accepted (#174).
 * Public routes serve mobile users on slow networks; small bodies are left alone because compression would cost
 * more than it saves.
 */
export function compressJson(thresholdBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      const type = String(res.getHeader('Content-Type') ?? '');
      if (typeof body !== 'string' || !type.includes('application/json') || res.getHeader('Content-Encoding')) {
        return send(body);
      }
      res.vary('Accept-Encoding');
      if (Buffer.byteLength(body) < thresholdBytes) return send(body);
      const accept = req.headers['accept-encoding'];
      const encoding = acceptsEncoding(accept, 'br') ? 'br' : acceptsEncoding(accept, 'gzip') ? 'gzip' : undefined;
      if (!encoding) return send(body);
      const compressed = encoding === 'br'
        ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } })
        : gzipSync(body);
      res.setHeader('Content-Encoding', encoding);
      return send(compressed);
    }) as Response['send'];
    next();
  };
}
