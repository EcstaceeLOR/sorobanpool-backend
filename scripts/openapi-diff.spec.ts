import { readFileSync } from 'node:fs';
import { diffOpenApi } from './openapi-diff.js';

type Doc = Parameters<typeof diffOpenApi>[0];

const spec = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({ paths, components: { schemas } }) as Doc;
const op = (extra: Record<string, unknown> = {}) => ({ security: [], responses: { '200': { description: 'Success' } }, ...extra });
const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const res = (schema: unknown) => ({ '200': { description: 'Success', content: { 'application/json': { schema } } } });

describe('openapi breaking-change diff (#153)', () => {
  it('reports nothing for identical or purely additive specs', () => {
    const base = spec({ '/v1/a': { get: op() } });
    expect(diffOpenApi(base, base)).toEqual([]);
    const head = spec({ '/v1/a': { get: op() }, '/v1/b': { post: op() } });
    expect(diffOpenApi(base, head)).toEqual([]);
  });

  it('flags removed routes and newly authenticated routes', () => {
    const base = spec({ '/v1/a': { get: op(), post: op() } });
    const head = spec({ '/v1/a': { get: op({ security: [{ bearerAuth: [] }] }) } });
    expect(diffOpenApi(base, head)).toEqual(['GET /v1/a: now requires authentication', 'POST /v1/a: operation removed']);
  });

  it('flags removed response fields and widened response types, following $refs', () => {
    const base = spec({ '/v1/u': { get: op({ responses: res({ $ref: '#/components/schemas/U' }) }) } }, {
      U: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] },
    });
    const head = spec({ '/v1/u': { get: op({ responses: res({ $ref: '#/components/schemas/U' }) }) } }, {
      U: { type: 'object', properties: { id: { type: ['string', 'null'] } }, required: ['id'] },
    });
    expect(diffOpenApi(base, head)).toEqual(['GET /v1/u 200.name: response field removed', 'GET /v1/u 200.id: response can now be null']);
  });

  it('flags tightened request bodies', () => {
    const before = { type: 'object', properties: { code: { type: 'string', minLength: 4 }, kind: { enum: ['A', 'B'] } }, required: ['code'] };
    const after = { type: 'object', properties: { code: { type: 'string', minLength: 6 }, kind: { enum: ['A'] }, extra: { type: 'string' } }, required: ['code', 'extra'] };
    const base = spec({ '/v1/x': { post: op({ requestBody: body(before) }) } });
    const head = spec({ '/v1/x': { post: op({ requestBody: body(after) }) } });
    expect(diffOpenApi(base, head)).toEqual([
      'POST /v1/x body.extra: request field is now required',
      'POST /v1/x body.code: request minLength tightened to 6',
      'POST /v1/x body.kind: request enum no longer accepts "B"',
    ]);
  });

  it('treats documenting a previously undocumented body as additive', () => {
    const base = spec({ '/v1/x': { post: op() } });
    const head = spec({ '/v1/x': { post: op({ requestBody: body({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }) }) } });
    expect(diffOpenApi(base, head)).toEqual([]);
  });

  it('flags a new required parameter', () => {
    const base = spec({ '/v1/q': { get: op() } });
    const head = spec({ '/v1/q': { get: op({ parameters: [{ name: 'units', in: 'query', required: true }] }) } });
    expect(diffOpenApi(base, head)).toEqual(['GET /v1/q: new required query parameter units']);
  });

  it('finds no breaking change between the committed spec and itself', () => {
    const doc = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8')) as Doc;
    expect(diffOpenApi(doc, doc)).toEqual([]);
  });
});
