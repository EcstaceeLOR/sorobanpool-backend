import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CallTimeoutError, callWithPolicy, CircuitBreaker, CircuitOpenError } from './resilience.js';
import { ResilientSmsSender } from '../notifications/dispatcher.js';
import { ResilientVerificationProvider, SandboxVerificationProvider } from '../verification/provider.js';

/** A stub provider whose behaviour the test switches between hanging, failing and answering. */
function stubServer() {
  let mode: 'hang' | 'fail' | 'ok' = 'ok';
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    if (mode === 'hang') return; // never answers
    if (mode === 'fail') {
      res.writeHead(503).end('down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  return {
    server,
    setMode: (m: typeof mode) => { mode = m; },
    hits: () => hits,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  };
}

const noWait = async () => undefined;

describe('outbound call resilience (#177)', () => {
  const stub = stubServer();
  beforeAll(() => new Promise<void>((r) => stub.server.listen(0, '127.0.0.1', () => r())));
  afterAll(() => new Promise<void>((r) => { stub.server.closeAllConnections(); stub.server.close(() => r()); }));

  const get = (signal: AbortSignal) => fetch(stub.url(), { signal }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

  it('times out a hanging provider instead of waiting forever', async () => {
    stub.setMode('hang');
    const started = Date.now();
    await expect(callWithPolicy('stub', get, { timeoutMs: 100, retries: 0, retryDelayMs: 0 })).rejects.toBeInstanceOf(CallTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('retries a bounded number of times, then gives up', async () => {
    stub.setMode('fail');
    const before = stub.hits();
    await expect(callWithPolicy('stub', get, { timeoutMs: 1_000, retries: 2, retryDelayMs: 0 }, undefined, noWait)).rejects.toThrow(/HTTP 503/);
    expect(stub.hits() - before).toBe(3);
  });

  it('opens after repeated failures, short-circuits while open, and half-opens after the delay', async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetMs: 10_000, now: () => t });
    const policy = { timeoutMs: 1_000, retries: 0, retryDelayMs: 0 };
    stub.setMode('fail');
    await expect(callWithPolicy('stub', get, policy, breaker)).rejects.toThrow(/HTTP 503/);
    expect(breaker.state).toBe('closed');
    await expect(callWithPolicy('stub', get, policy, breaker)).rejects.toThrow(/HTTP 503/);
    expect(breaker.state).toBe('open');

    const before = stub.hits();
    await expect(callWithPolicy('stub', get, policy, breaker)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(stub.hits()).toBe(before); // no request while open

    t = 10_000;
    expect(breaker.state).toBe('half-open');
    stub.setMode('ok');
    await expect(callWithPolicy('stub', get, policy, breaker)).resolves.toEqual({ ok: true });
    expect(breaker.state).toBe('closed');
  });

  it('re-opens straight away when the half-open trial fails', async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetMs: 1_000, now: () => t });
    const policy = { timeoutMs: 1_000, retries: 0, retryDelayMs: 0 };
    stub.setMode('fail');
    await expect(callWithPolicy('stub', get, policy, breaker)).rejects.toThrow();
    t = 1_000;
    expect(breaker.state).toBe('half-open');
    await expect(callWithPolicy('stub', get, policy, breaker)).rejects.toThrow(/HTTP 503/);
    expect(breaker.state).toBe('open');
  });

  it('wraps the SMS adapter: a hanging send times out and repeated failures open its breaker', async () => {
    const hanging = { send: () => new Promise<void>(() => undefined) };
    const sms = new ResilientSmsSender(hanging, { timeoutMs: 50, retries: 0, retryDelayMs: 0 }, new CircuitBreaker({ failureThreshold: 1, resetMs: 60_000 }));
    await expect(sms.send('+2348000000000', 'hi')).rejects.toBeInstanceOf(CallTimeoutError);
    await expect(sms.send('+2348000000000', 'hi')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('wraps the KYC adapter without changing its answers', async () => {
    const kyc = new ResilientVerificationProvider(new SandboxVerificationProvider());
    expect(kyc.name).toBe('sandbox');
    const claim = { firstName: 'Ada', lastName: 'Obi', dateOfBirth: '1990-01-01' };
    expect((await kyc.verifyBvn('12345678901', claim)).ok).toBe(true);
    expect((await kyc.verifyBvn('12345678900', claim)).reason).toBe('NOT_FOUND');
  });
});
