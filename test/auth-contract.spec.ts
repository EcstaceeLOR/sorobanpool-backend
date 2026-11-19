import { readFileSync } from 'node:fs';
import { startHarness, type Harness } from './harness.js';

/**
 * Auth contract for every route in docs/openapi.json (#170). The document is generated from the controllers (see
 * src/app/openapi.spec.ts, which also keeps it fresh), so a new route shows up here automatically:
 *  - a route with no bearer requirement must be in PUBLIC_ROUTES, or the static check fails;
 *  - every bearer route answers 401 without a token;
 *  - every role-restricted route answers 403 to a signed-in user without the role, and not 401/role-403 with it.
 */
type Operation = { security?: unknown[]; 'x-roles'?: string[] };
const doc = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};

/** Every unauthenticated route, listed on purpose. Adding a public route means adding it here. */
const PUBLIC_ROUTES = new Set([
  'POST /v1/auth/logout',
  'POST /v1/auth/otp/request',
  'POST /v1/auth/otp/verify',
  'POST /v1/auth/passkey/login/options',
  'POST /v1/auth/passkey/login/verify',
  'POST /v1/auth/refresh',
  'GET /v1/evidence/file',
  'GET /v1/fx/quote',
  'GET /v1/health',
  'GET /v1/images/{id}',
  'GET /v1/metrics',
  'GET /v1/offers',
  'GET /v1/offers/{id}',
  'GET /v1/openapi.json',
  'GET /v1/p/{slug}',
  'GET /v1/pools/{id}/sharecard.png',
  'GET /v1/pools/{id}/stream',
  'PUT /v1/uploads/put',
]);

const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, method, path, op })),
);
const bearer = operations.filter((o) => (o.op.security ?? []).length > 0);
const roleRestricted = bearer.filter((o) => (o.op['x-roles'] ?? []).length > 0);
const allRoles = [...new Set(roleRestricted.flatMap((o) => o.op['x-roles']!))];

/** Any concrete value works for a path parameter: the auth guard runs before the handler looks at it. */
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, 'auth-contract');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

async function call(h: Harness, method: string, path: string, token?: string): Promise<{ status: number; body: { message?: string } }> {
  const req = h.http()[method as Method](concrete(path));
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req;
}

describe('auth contract (docs/openapi.json)', () => {
  it('every operation declares its auth: bearer, or an explicit entry in PUBLIC_ROUTES', () => {
    const undeclared = operations.filter((o) => !Array.isArray(o.op.security)).map((o) => o.key);
    expect(undeclared, 'operations with no security metadata').toEqual([]);
    const unlistedPublic = operations.filter((o) => o.op.security!.length === 0 && !PUBLIC_ROUTES.has(o.key)).map((o) => o.key);
    expect(unlistedPublic, 'public operations missing from PUBLIC_ROUTES').toEqual([]);
    const stale = [...PUBLIC_ROUTES].filter((k) => !operations.some((o) => o.key === k && o.op.security!.length === 0));
    expect(stale, 'PUBLIC_ROUTES entries that are not public operations').toEqual([]);
  });

  describe('runtime', () => {
    let h: Harness;
    let noRole: string;
    let withRoles: string;

    beforeAll(async () => {
      h = await startHarness();
      noRole = (await h.login('+2348000009001')).token;
      const granted = await h.login('+2348000009002');
      // Roles are read from the database on every request (AuthGuard), so a grant here applies to the existing token.
      for (const role of allRoles) await h.db.prisma.userRole.create({ data: { userId: granted.userId, role } });
      withRoles = granted.token;
    });
    afterAll(async () => { await h?.close(); });

    it('rejects every bearer route without a token (401)', async () => {
      const failures: string[] = [];
      for (const o of bearer) {
        const r = await call(h, o.method, o.path);
        if (r.status !== 401) failures.push(`${o.key} -> ${r.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('rejects every role-restricted route for a user without the role (403)', async () => {
      const failures: string[] = [];
      for (const o of roleRestricted) {
        const r = await call(h, o.method, o.path, noRole);
        if (r.status !== 403) failures.push(`${o.key} -> ${r.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('lets a user with the role past the auth guard (not 401, not "insufficient role")', async () => {
      const failures: string[] = [];
      for (const o of roleRestricted) {
        const r = await call(h, o.method, o.path, withRoles);
        if (r.status === 401 || (r.status === 403 && r.body?.message === 'insufficient role')) failures.push(`${o.key} -> ${r.status}`);
      }
      expect(failures).toEqual([]);
    });
  });
});
