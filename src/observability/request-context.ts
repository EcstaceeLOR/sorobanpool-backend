import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function withRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContext.run({ requestId }, callback);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function requestHeaders(headers?: HeadersInit): Headers {
  const outgoing = new Headers(headers);
  const requestId = currentRequestId();
  if (requestId && !outgoing.has('X-Request-Id')) outgoing.set('X-Request-Id', requestId);
  return outgoing;
}
