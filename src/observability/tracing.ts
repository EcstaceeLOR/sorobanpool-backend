import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

type Attribute = string | number | boolean;
interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  attributes: Record<string, Attribute>;
  status: number;
  ended?: bigint;
  exception?: string;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, Attribute>): Span;
  startActiveSpan<T>(name: string, attributes: Record<string, Attribute>, callback: (span: Span) => T): T;
}

export interface Span {
  setAttribute(name: string, value: Attribute): void;
  setStatus(status: { code: 'OK' | 'ERROR' }): void;
  recordException(error: Error | string): void;
  isRecording(): boolean;
  end(): void;
}

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

const active = new AsyncLocalStorage<SpanData>();
const hex = (length: number) => randomBytes(length).toString('hex');
const nanoTime = () => BigInt(Date.now()) * 1_000_000n;

function createSpan(data: SpanData, exportSpan: (span: SpanData) => void): Span {
  return {
    setAttribute(name, value) { data.attributes[name] = value; },
    setStatus(status) { data.status = status.code === 'ERROR' ? 2 : 1; },
    recordException(error) { data.exception = error instanceof Error ? error.message : error; },
    isRecording() { return data.ended === undefined; },
    end() {
      if (data.ended !== undefined) return;
      data.ended = nanoTime();
      exportSpan(data);
    },
  };
}

function otlpSpan(span: SpanData) {
  const attributes = Object.entries(span.attributes).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value } : { intValue: String(value) },
  }));
  if (span.exception) attributes.push({ key: 'exception.message', value: { stringValue: span.exception } });
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.name.startsWith('http.server') ? 2 : 3,
    startTimeUnixNano: String(span.start),
    endTimeUnixNano: String(span.ended),
    attributes,
    status: { code: span.status },
  };
}

export async function initializeTracing(endpoint: string, role: string): Promise<Tracing | undefined> {
  if (!endpoint) return undefined;
  const pending = new Set<Promise<void>>();
  const resourceAttributes = [
    { key: 'service.name', value: { stringValue: 'sorobanpool-backend' } },
    { key: 'service.version', value: { stringValue: process.env.npm_package_version ?? '0.0.1' } },
    { key: 'service.role', value: { stringValue: role } },
  ];
  const exportSpan = (span: SpanData) => {
    const request = fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: resourceAttributes }, scopeSpans: [{ scope: { name: 'sorobanpool-backend' }, spans: [otlpSpan(span)] }] }] }),
    }).then((response) => {
      if (!response.ok) throw new Error(`OpenTelemetry exporter returned HTTP ${response.status}`);
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: 'OpenTelemetry export failed', error: error instanceof Error ? error.message : String(error) }));
    }).finally(() => pending.delete(request));
    pending.add(request);
  };
  const tracer: Tracer = {
    startSpan(name, attributes = {}) {
      const parent = active.getStore();
      return createSpan({
        traceId: parent?.traceId ?? hex(16),
        spanId: hex(8),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name, start: nanoTime(), attributes: { ...attributes }, status: 0,
      }, exportSpan);
    },
    startActiveSpan<T>(name: string, attributes: Record<string, Attribute>, callback: (span: Span) => T): T {
      const parent = active.getStore();
      const data: SpanData = {
        traceId: parent?.traceId ?? hex(16), spanId: hex(8),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name, start: nanoTime(), attributes: { ...attributes }, status: 0,
      };
      return active.run(data, () => callback(createSpan(data, exportSpan)));
    },
  };
  return {
    tracer,
    async shutdown() { await Promise.all(pending); },
  };
}

export function traceHttpRequest(tracer: Tracer) {
  return (req: Request, res: Response, next: NextFunction): void => {
    tracer.startActiveSpan('http.server.request', {
      'http.request.method': req.method,
      ...(typeof req.headers['x-request-id'] === 'string' ? { 'http.request.id': req.headers['x-request-id'] } : {}),
    }, (span) => {
      res.once('finish', () => {
        const route = (req.route as { path?: string } | undefined)?.path;
        if (route) span.setAttribute('http.route', `${req.baseUrl ?? ''}${route}`);
        span.setAttribute('http.response.status_code', res.statusCode);
        if (res.statusCode >= 500) span.setStatus({ code: 'ERROR' });
        span.end();
      });
      next();
    });
  };
}

export function traceOperation<T>(tracer: Tracer, name: string, attributes: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, attributes, async (span) => {
    try {
      return await operation();
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: 'ERROR' });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function instrumentRpcServer<T extends object>(server: T, tracer?: Tracer): T {
  if (!tracer) return server;
  return new Proxy(server, {
    get(target, property) {
      const method = Reflect.get(target, property, target) as unknown;
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => traceOperation(
        tracer,
        `soroban.rpc.${String(property)}`,
        { 'rpc.system': 'soroban', 'rpc.method': String(property) },
        () => Reflect.apply(method, target, args) as Promise<unknown>,
      );
    },
  });
}
