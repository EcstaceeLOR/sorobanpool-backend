import { readFileSync, writeFileSync } from 'node:fs';
import { appControllers } from './app.module.js';
import { buildOpenApi, OpenApiController } from './openapi.js';
import { API_SCHEMAS, OPERATION_BODIES } from './openapi-schemas.js';
import { otpRequestBody, otpVerifyBody, refreshBody } from './auth.controller.js';
import { startHarness } from '../../test/harness.js';
import type { ZodType } from 'zod';
import { OPENAPI_EXAMPLES } from './openapi-examples.js';
import { commitBody, poolPrepareBody } from './pools.controller.js';

const file = new URL('../../docs/openapi.json', import.meta.url);
// The committed document describes the production surface: no dev faucet.
const prod = () => buildOpenApi([...appControllers({ env: { NODE_ENV: 'production', STELLAR_NETWORK: 'mainnet' } } as never), OpenApiController]);
const doc = prod() as { paths: Record<string, Record<string, { security: unknown[]; 'x-roles'?: string[]; parameters?: { name: string }[] }>> };

describe('openapi', () => {
  it('docs/openapi.json is up to date (run `pnpm openapi` after changing routes)', () => {
    const text = JSON.stringify(prod(), null, 2) + '\n';
    if (process.env.UPDATE_OPENAPI) writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
  it('captures public routes, bearer routes, roles and path params', () => {
    expect(doc.paths['/v1/health']!.get!.security).toEqual([]);
    expect(doc.paths['/v1/offers/{id}']!.get!.parameters![0]!.name).toBe('id');
    const admin = Object.entries(doc.paths).filter(([p]) => p.startsWith('/v1/admin'));
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.every(([, m]) => Object.values(m).every((o) => o.security.length === 1 && o['x-roles']?.includes('ADMIN')))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('/v1/dev');
  });
  // #152: the auth, pools and catalog bodies are described, and every schema reference resolves.
  it('describes request and response bodies for the covered operations', () => {
    type Op = { operationId: string; requestBody?: unknown; responses: Record<string, { content?: unknown }> };
    const ops = Object.values(doc.paths).flatMap((m) => Object.values(m)) as unknown as Op[];
    const byId = new Map(ops.map((o) => [o.operationId, o]));
    for (const id of Object.keys(OPERATION_BODIES)) expect(byId.has(id), id).toBe(true);
    expect(byId.get('AuthController.verify')!.requestBody).toBeDefined();
    expect(byId.get('AuthController.verify')!.responses['200']!.content).toBeDefined();
    expect(byId.get('PoolsController.list')!.responses['200']!.content).toBeDefined();
    expect(byId.get('CatalogController.list')!.responses['200']!.content).toBeDefined();
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(API_SCHEMAS[r], r).toBeDefined();
  });
  type ZodLike = { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
  const handlerBodies: [string, ZodLike][] = [
    ['OtpRequest', otpRequestBody],
    ['OtpVerify', otpVerifyBody],
    ['RefreshRequest', refreshBody],
  ];
  it.each(handlerBodies)('the %s schema matches the zod schema its handler parses with', (name, zodSchema) => {
    const json = API_SCHEMAS[name] as { properties: Record<string, unknown>; required: string[] };
    const shape = zodSchema.shape;
    expect(Object.keys(json.properties).sort()).toEqual(Object.keys(shape).sort());
    const required = Object.keys(shape).filter((k) => !shape[k]!.safeParse(undefined).success);
    expect([...json.required].sort()).toEqual(required.sort());
  });
  it('is served at /v1/openapi.json without auth', async () => {
    const h = await startHarness();
    try {
      const r = await h.http().get('/v1/openapi.json');
      expect(r.status).toBe(200);
      expect(r.body.openapi).toBe('3.1.0');
      expect(Object.keys(r.body.paths).length).toBeGreaterThan(30);
    } finally { await h.close(); }
  });
});

describe('openapi examples (#178)', () => {
  type Op = { operationId: string; requestBody?: { content: Record<string, { example: unknown }> }; responses: Record<string, { content?: Record<string, { example: unknown }> }> };
  const ops = Object.values(prod().paths as Record<string, Record<string, Op>>).flatMap((m) => Object.values(m));
  const byId = new Map(ops.map((o) => [o.operationId, o]));

  /** The handlers' own request schemas: an example that does not parse here would be rejected by the API. */
  const requestSchemas: Record<string, ZodType> = {
    'AuthController.request': otpRequestBody,
    'AuthController.verify': otpVerifyBody,
    'AuthController.refresh': refreshBody,
    'PoolsController.prepare': poolPrepareBody,
    'PoolsController.act': commitBody,
  };

  it('covers auth, offers, pool read, quote and prepare calls', () => {
    for (const id of ['AuthController.verify', 'CatalogController.list', 'CatalogController.one', 'PoolsController.get', 'PoolsController.quote', 'PoolsController.prepare']) {
      expect(OPENAPI_EXAMPLES[id], id).toBeDefined();
    }
    expect(Object.keys(OPENAPI_EXAMPLES).length).toBeGreaterThanOrEqual(10);
  });

  it.each(Object.entries(OPENAPI_EXAMPLES))('%s is a real operation and its examples are in the document', (id, ex) => {
    const op = byId.get(id);
    expect(op, `${id} is not a route`).toBeDefined();
    expect(op!.responses['200']!.content!['application/json']!.example).toEqual(ex.response);
    if (ex.request !== undefined) expect(op!.requestBody!.content['application/json']!.example).toEqual(ex.request);
    expect(JSON.parse(JSON.stringify(ex.response))).toEqual(ex.response); // plain JSON, nothing lost in transit
  });

  it.each(Object.entries(requestSchemas))('%s request example passes the handler schema', (id, schema) => {
    const ex = OPENAPI_EXAMPLES[id]!;
    expect(ex.request).toBeDefined();
    const r = schema.safeParse(ex.request);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('every request example has a handler schema checked above', () => {
    const withRequest = Object.entries(OPENAPI_EXAMPLES).filter(([, e]) => e.request !== undefined).map(([id]) => id).sort();
    expect(withRequest).toEqual(Object.keys(requestSchemas).sort());
  });
});
