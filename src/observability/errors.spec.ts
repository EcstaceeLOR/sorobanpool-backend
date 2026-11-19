import { REDACTED, scrubBreadcrumb, scrubEvent, type ScrubbableEvent } from '../common/pii.js';
import { NoopReporter, createReporter, type ErrorReporter } from './errors.js';
import { startHarness, type Harness } from '../../test/harness.js';

class Recorder implements ErrorReporter {
  seen: { e: unknown; where: string }[] = [];
  capture(e: unknown, where: string) { this.seen.push({ e, where }); }
}

describe('error reporting', () => {
  it('is a no-op without a DSN and Sentry only with one', () => {
    expect(createReporter('', 'test')).toBeInstanceOf(NoopReporter);
    expect(createReporter('', 'test').capture(new Error('x'), 'w')).toBeUndefined();
  });

  describe('through the HTTP filter', () => {
    let h: Harness;
    const rec = new Recorder();
    beforeAll(async () => {
      h = await startHarness();
      (h.s as { reporter: ErrorReporter }).reporter = rec;
    });
    afterAll(async () => { await h.close(); });

    it('reports unexpected 500s but not validation, auth or not-found errors', async () => {
      expect((await h.http().post('/v1/auth/otp/request').send({})).status).toBe(400); // validation
      expect((await h.http().get('/v1/me')).status).toBe(401); // auth
      expect((await h.http().get('/v1/offers/does-not-exist')).status).toBe(404);
      expect(rec.seen).toEqual([]);
      // force an unexpected failure inside a handler
      const boom = new Error('database exploded');
      h.s.prisma.offer.findMany = (() => { throw boom; }) as never;
      expect((await h.http().get('/v1/offers')).status).toBe(500);
      expect(rec.seen).toEqual([{ e: boom, where: 'http' }]);
    });
  });
});

describe('SentryReporter delivery', () => {
  it('sends the error with a where tag to the configured DSN and nothing identifying', async () => {
    const { createServer } = await import('node:http');
    const { gunzipSync } = await import('node:zlib');
    const Sentry = await import('@sentry/node');
    const { SentryReporter } = await import('./errors.js');
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let b = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') b = gunzipSync(b);
        bodies.push(b.toString());
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      new SentryReporter(`http://pubkey@127.0.0.1:${port}/1`, 'test').capture(new Error('indexer exploded'), 'indexer');
      await Sentry.flush(5000);
      const all = bodies.join('\n');
      expect(all).toContain('indexer exploded');
      expect(all).toContain('"where":"indexer"');
      const event = all.split('\n').map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).find((o) => o && 'exception' in o)!;
      expect(event.request).toBeUndefined();
      expect(event.user).toBeUndefined();
    } finally {
      await Sentry.close(1000);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// #143: realistic events are scrubbed of phones, BVN/NIN-like ids and bearer tokens everywhere they appear.
describe('PII scrubbing for error reports', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
  const leaks = ['+2348012345678', '08012345678', '22123456789', 'Bearer abc.def-123', JWT];

  it.each([
    ['message', { message: 'OTP send failed for +2348012345678' }],
    ['exception value', { exception: { values: [{ value: 'BVN 22123456789 did not verify' }] } }],
    ['extra data', { extra: { note: 'retrying 08012345678', nested: { header: 'Bearer abc.def-123' } } }],
    ['contexts', { contexts: { auth: { raw: `token ${JWT}` } } }],
    ['breadcrumbs', { breadcrumbs: [{ message: 'GET /v1/users/+2348012345678', data: { url: '/v1/kyc?bvn=22123456789' } }] }],
    ['sensitive keys', { extra: { phone: '0801', bvn: '1', password: 'p', Authorization: 'x', accountNumber: '9' } }],
  ])('removes PII from %s', (_where, event) => {
    const out = JSON.stringify(scrubEvent(structuredClone(event) as ScrubbableEvent));
    for (const leak of leaks) expect(out).not.toContain(leak);
    expect(out).not.toMatch(/"(phone|bvn|password|Authorization|accountNumber)":"(?!\[redacted\])/);
  });

  it('drops request bodies, cookies, headers, query strings and the user', () => {
    const event: ScrubbableEvent = {
      request: { url: '/v1/auth/otp/verify?phone=%2B2348012345678', data: { phone: '+2348012345678' }, cookies: { s: 'x' }, headers: { authorization: 'Bearer t' }, query_string: 'phone=1' },
      user: { id: 'u1' },
    };
    const out = scrubEvent(event);
    expect(out.request).toEqual({ url: '/v1/auth/otp/verify' });
    expect(out.user).toBeUndefined();
  });

  it('keeps ordinary diagnostic text and short numbers', () => {
    const out = scrubEvent({ message: 'pool 42 failed at ledger 5123456', extra: { units: 12, state: 'Filled' } });
    expect(out.message).toBe('pool 42 failed at ledger 5123456');
    expect(out.extra).toEqual({ units: 12, state: 'Filled' });
  });

  it('scrubs breadcrumbs as they are recorded', () => {
    expect(scrubBreadcrumb({ message: 'sms to 08012345678', data: { otp: '123456' } })).toEqual({ message: `sms to ${REDACTED}`, data: { otp: REDACTED } });
  });
});
