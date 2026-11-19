import { startHarness, type Harness } from './harness.js';
import { acceptsEncoding, CACHE_CONTROL } from '../src/app/http-setup.js';

const APP_ORIGIN = 'http://localhost:3001';

describe('HTTP setup: body limits (#171)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ JSON_BODY_LIMIT: '2kb', UPLOAD_BODY_LIMIT: '4kb' }); });
  afterAll(async () => { await h.close(); });

  it('rejects oversize JSON with a JSON 413 before any route runs', async () => {
    const r = await h.http().post('/v1/auth/otp/request').set('Content-Type', 'application/json')
      .send(JSON.stringify({ phone: '+2348030000001', pad: 'x'.repeat(4096) }));
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts JSON under the limit', async () => {
    const r = await h.http().post('/v1/auth/otp/request').send({ phone: '+2348030000002' });
    expect(r.status).not.toBe(413);
  });

  it('applies the separate, configurable upload limit to raw bodies', async () => {
    const r = await h.http().put('/v1/uploads/put').set('Content-Type', 'image/png').send(Buffer.alloc(8192));
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('HTTP setup: CORS and security headers (#172)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('sends CORS headers with credentials to the configured app origin', async () => {
    const r = await h.http().get('/v1/offers').set('Origin', APP_ORIGIN);
    expect(r.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow any other origin', async () => {
    const r = await h.http().get('/v1/offers').set('Origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight only for the configured origin', async () => {
    const ok = await h.http().options('/v1/offers').set('Origin', APP_ORIGIN).set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    const bad = await h.http().options('/v1/offers').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets the key security headers', async () => {
    const r = await h.http().get('/v1/offers');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });
});

describe('HTTP setup: compression and caching (#174)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ COMPRESSION_THRESHOLD_BYTES: '0' }); });
  afterAll(async () => { await h.close(); });

  it('gzips JSON GET responses at or over the threshold and still returns the same body', async () => {
    const r = await h.http().get('/v1/offers').set('Accept-Encoding', 'gzip');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('does not compress when the client accepts no supported encoding', async () => {
    const r = await h.http().get('/v1/offers').set('Accept-Encoding', 'identity');
    expect(r.headers['content-encoding']).toBeUndefined();
  });

  it('sets Cache-Control on public catalog routes', async () => {
    const r = await h.http().get('/v1/offers');
    expect(r.headers['cache-control']).toBe(CACHE_CONTROL.catalog);
  });

  it('parses Accept-Encoding including q=0 exclusions', () => {
    expect(acceptsEncoding('gzip, br', 'br')).toBe(true);
    expect(acceptsEncoding('gzip;q=1.0, br;q=0', 'br')).toBe(false);
    expect(acceptsEncoding('GZIP', 'gzip')).toBe(true);
    expect(acceptsEncoding(undefined, 'gzip')).toBe(false);
  });
});

describe('HTTP setup: default thresholds', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('leaves small JSON bodies uncompressed', async () => {
    const r = await h.http().get('/v1/fx/quote').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
  });
});
