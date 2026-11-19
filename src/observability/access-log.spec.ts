import { REDACTED, redact } from './access-log.js';
import { startHarness, type Harness } from '../../test/harness.js';

// Planted values: none of these may ever appear in an access log line (#147).
const PHONE = '+2348031234567';
const BVN = '22212345678';
const NIN = '70123456789';
const CAC = 'RC1234567';
const ACCOUNT = '0123456789';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.planted.token';
const PLANTED = [PHONE, BVN, NIN, CAC, ACCOUNT, TOKEN];

function expectClean(text: string): void {
  for (const secret of PLANTED) expect(text).not.toContain(secret);
}

describe('redact', () => {
  it('replaces sensitive keys at any depth', () => {
    const out = redact({
      phone: PHONE, bvn: BVN, nin: NIN, cac: CAC, accountNumber: ACCOUNT, access_token: TOKEN,
      nested: { refreshToken: TOKEN, list: [{ phoneNumber: PHONE }] },
      safe: 'hello',
    }) as Record<string, unknown>;
    expect(out.phone).toBe(REDACTED);
    expect(out.cac).toBe(REDACTED);
    expect(out.safe).toBe('hello');
    expectClean(JSON.stringify(out));
  });

  it('scrubs long digit runs even under innocuous keys', () => {
    const out = JSON.stringify(redact({ q: `call ${PHONE} or ${BVN}`, note: `acct ${ACCOUNT}` }));
    expectClean(out);
    expect(out).toContain('call');
  });

  it('leaves short numbers and non-strings alone', () => {
    expect(redact({ page: '2', limit: 20, ok: true })).toEqual({ page: '2', limit: 20, ok: true });
  });
});

describe('access log middleware', () => {
  let h: Harness;
  const lines: string[] = [];
  beforeAll(async () => { h = await startHarness({}, { accessLog: (line) => lines.push(line) }); });
  afterAll(async () => { await h.close(); });
  beforeEach(() => { lines.length = 0; });

  it('writes one JSON line per request with the route template and a request id', async () => {
    const r = await h.http().get('/v1/offers/abc').set('X-Request-Id', 'req-123');
    expect(r.headers['x-request-id']).toBe('req-123');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string);
    expect(entry).toMatchObject({ method: 'GET', route: '/v1/offers/:id', status: r.status, requestId: 'req-123', userId: null });
    expect(typeof entry.durationMs).toBe('number');
    expect(lines[0]).not.toContain('/offers/abc');
  });

  it('generates a request id when none (or an unsafe one) is sent', async () => {
    const r = await h.http().get('/v1/health').set('X-Request-Id', 'bad id with spaces');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(lines[0] as string).requestId).toBe(r.headers['x-request-id']);
  });

  it('includes the request id in error bodies as well as the response header', async () => {
    const r = await h.http().get('/v1/me').set('X-Request-Id', 'error-req-1').expect(401);
    expect(r.headers['x-request-id']).toBe('error-req-1');
    expect(r.body.requestId).toBe('error-req-1');
  });

  it('never logs planted secrets from the query or the body', async () => {
    await h.http().get('/v1/health').query({ phone: PHONE, bvn: BVN, nin: NIN, cac: CAC, accountNumber: ACCOUNT, token: TOKEN, q: PHONE });
    await h.http().post('/v1/auth/otp/request').send({ phone: PHONE, bvn: BVN, nin: NIN, accountNumber: ACCOUNT, token: TOKEN });
    expect(lines).toHaveLength(2);
    expectClean(lines.join('\n'));
  });

  it('logs the user id, not the phone, on authenticated requests', async () => {
    const { userId, token } = await h.login('+2348030000901');
    lines.length = 0;
    await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
    const entry = JSON.parse(lines[0] as string);
    expect(entry.userId).toBe(userId);
    expect(lines[0]).not.toContain('2348030000901');
    expect(lines[0]).not.toContain(token);
  });
});
