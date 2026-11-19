import { Controller, Get, Inject, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { PUBLIC_KEY, Public, ROLES_KEY } from './http.js';
import { API_SCHEMAS, OPERATION_BODIES } from './openapi-schemas.js';

type Ctor = abstract new (...args: never[]) => object;

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch',
};

const join = (...p: string[]) => '/' + p.map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/**
 * Builds an OpenAPI 3.1 document from controller metadata: paths, methods, auth and role requirements, path parameters.
 * Request/response bodies come from openapi-schemas.ts for the operations listed there (#152); the rest are described
 * in docs/api.md.
 */
export function buildOpenApi(controllers: readonly Ctor[], prefix = '/v1'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const c of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, c) ?? '');
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      if (name === 'constructor') continue;
      // Descriptors, not property reads: some controllers define getters that would run against a missing instance.
      const handler = Object.getOwnPropertyDescriptor(c.prototype, name)?.value as object | undefined;
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (method === undefined || !(method in METHODS)) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const express = join(prefix, base, sub);
      const path = express.replace(/:(\w+)/g, '{$1}');
      const isPublic = Reflect.getMetadata(PUBLIC_KEY, handler) === true;
      const roles = (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? [];
      const params = [...express.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1]!, in: 'path', required: true, schema: { type: 'string' } }));
      const operationId = `${c.name}.${name}`;
      const body = OPERATION_BODIES[operationId];
      const json = (schema: unknown) => ({ 'application/json': { schema } });
      (paths[path] ??= {})[METHODS[method]!] = {
        operationId,
        tags: [c.name.replace(/Controller$/, '')],
        ...(params.length ? { parameters: params } : {}),
        ...(isPublic ? { security: [] } : { security: [{ bearerAuth: [] }] }),
        ...(roles.length ? { 'x-roles': roles } : {}),
        ...(body?.request ? { requestBody: { required: true, content: json(body.request) } } : {}),
        responses: {
          '200': body?.response ? { description: 'Success', content: json(body.response) } : { description: 'Success' },
          '400': { description: 'Validation error' },
          '429': { description: 'Rate limited' },
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SorobanPool API', version: '1.0.0', description: 'Bearer JWT unless an operation is public. Errors are {error, message}.' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: API_SCHEMAS },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export const OPENAPI_DOC = Symbol('OPENAPI_DOC');

@Controller('openapi.json')
export class OpenApiController {
  constructor(@Inject(OPENAPI_DOC) private readonly doc: Record<string, unknown>) {}
  @Public() @Get()
  get(): Record<string, unknown> {
    return this.doc;
  }
}
