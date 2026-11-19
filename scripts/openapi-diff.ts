// Lists breaking changes between two OpenAPI documents (#153). CI runs it on pull requests against the base branch's
// docs/openapi.json; a PR labelled `breaking-api` skips the check (see .github/workflows/openapi-diff.yml).
//
// Usage: node scripts/openapi-diff.ts <base-openapi.json> <head-openapi.json>
//
// Breaking: a removed operation; an operation that now needs auth; a new required parameter or request field; a request
// field whose accepted types, enum values or bounds got narrower; a removed response field, a response field that is no
// longer always present, or a response field that can now hold a type it could not before.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Schema = Record<string, unknown>;
type Doc = { paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Schema> } };
type Operation = {
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function resolver(doc: Doc) {
  return function resolve(s: Schema | undefined, seen = new Set<string>()): Schema | undefined {
    const ref = s?.$ref;
    if (typeof ref !== 'string') return s;
    if (seen.has(ref)) return {};
    seen.add(ref);
    return resolve(doc.components?.schemas?.[ref.replace('#/components/schemas/', '')], seen);
  };
}

const typesOf = (s: Schema | undefined): Set<string> | undefined =>
  s?.type === undefined ? undefined : new Set(Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]);
const missing = (a: Iterable<unknown>, b: Set<unknown>) => [...a].filter((x) => !b.has(x));
const props = (s: Schema | undefined) => (s?.properties ?? {}) as Record<string, Schema>;
const required = (s: Schema | undefined) => new Set((s?.required ?? []) as string[]);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function diffOpenApi(base: Doc, head: Doc): string[] {
  const out: string[] = [];
  const rb = resolver(base);
  const rh = resolver(head);

  const schema = (b0: Schema | undefined, h0: Schema | undefined, where: string, mode: 'request' | 'response', depth = 0) => {
    const b = rb(b0);
    const h = rh(h0);
    if (!b || !h || depth > 20) return;
    const bt = typesOf(b);
    const ht = typesOf(h);
    if (mode === 'request' && bt && ht && missing(bt, ht).length) out.push(`${where}: request no longer accepts type ${missing(bt, ht).join('/')}`);
    if (mode === 'response' && bt && ht && missing(ht, bt).length) out.push(`${where}: response can now be ${missing(ht, bt).join('/')}`);
    if (mode === 'request' && Array.isArray(b.enum) && Array.isArray(h.enum)) {
      const gone = missing(b.enum, new Set(h.enum));
      if (gone.length) out.push(`${where}: request enum no longer accepts ${gone.map((x) => JSON.stringify(x)).join(', ')}`);
    }
    if (mode === 'request') {
      for (const k of ['minLength', 'minimum', 'minItems'] as const) {
        const bv = num(b[k]) ?? -Infinity;
        const hv = num(h[k]) ?? -Infinity;
        if (hv > bv) out.push(`${where}: request ${k} tightened to ${hv}`);
      }
      for (const k of ['maxLength', 'maximum', 'maxItems'] as const) {
        const bv = num(b[k]) ?? Infinity;
        const hv = num(h[k]) ?? Infinity;
        if (hv < bv) out.push(`${where}: request ${k} tightened to ${hv}`);
      }
      if (typeof h.pattern === 'string' && h.pattern !== b.pattern) out.push(`${where}: request pattern changed to ${h.pattern}`);
      for (const k of missing(required(h), required(b))) out.push(`${where}.${k}: request field is now required`);
    } else {
      for (const k of Object.keys(props(b))) if (!(k in props(h))) out.push(`${where}.${k}: response field removed`);
      for (const k of missing(required(b), required(h))) if (k in props(h)) out.push(`${where}.${k}: response field is no longer always present`);
    }
    for (const [k, bp] of Object.entries(props(b))) if (k in props(h)) schema(bp, props(h)[k], `${where}.${k}`, mode, depth + 1);
    if (b.items && h.items) schema(b.items as Schema, h.items as Schema, `${where}[]`, mode, depth + 1);
  };

  for (const [path, bm] of Object.entries(base.paths ?? {})) {
    for (const method of METHODS) {
      const bo = bm[method];
      if (!bo) continue;
      const id = `${method.toUpperCase()} ${path}`;
      const ho = head.paths?.[path]?.[method];
      if (!ho) {
        out.push(`${id}: operation removed`);
        continue;
      }
      if (Array.isArray(bo.security) && bo.security.length === 0 && Array.isArray(ho.security) && ho.security.length > 0) {
        out.push(`${id}: now requires authentication`);
      }
      const bParams = new Set((bo.parameters ?? []).filter((p) => p.required).map((p) => `${p.in}:${p.name}`));
      for (const p of ho.parameters ?? []) if (p.required && !bParams.has(`${p.in}:${p.name}`)) out.push(`${id}: new required ${p.in} parameter ${p.name}`);
      // Only a documented optional body becoming required is breaking; documenting a body for the first time is not.
      if (bo.requestBody && !bo.requestBody.required && ho.requestBody?.required) out.push(`${id}: request body is now required`);
      schema(bo.requestBody?.content?.['application/json']?.schema, ho.requestBody?.content?.['application/json']?.schema, `${id} body`, 'request');
      for (const [status, br] of Object.entries(bo.responses ?? {})) {
        schema(br.content?.['application/json']?.schema, ho.responses?.[status]?.content?.['application/json']?.schema, `${id} ${status}`, 'response');
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error('usage: node scripts/openapi-diff.ts <base.json> <head.json>');
    process.exit(2);
  }
  const breaking = diffOpenApi(JSON.parse(readFileSync(basePath, 'utf8')) as Doc, JSON.parse(readFileSync(headPath, 'utf8')) as Doc);
  if (breaking.length) {
    console.error(`OpenAPI breaking changes (${breaking.length}):`);
    for (const b of breaking) console.error(`  - ${b}`);
    console.error('\nIf these are intended, add the `breaking-api` label to the pull request and note them in the description.');
    process.exit(1);
  }
  console.log('openapi diff: no breaking changes');
}
