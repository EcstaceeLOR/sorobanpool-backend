/**
 * Timeouts, bounded retries and a circuit breaker for outbound provider calls (FX, KYC, SMS). A hung provider must
 * not hold a request or a worker forever, and a provider that keeps failing should be skipped for a while instead of
 * being hammered on every call.
 */

export interface CallPolicy {
  /** Per-attempt deadline. The attempt's AbortSignal fires when it passes. */
  timeoutMs: number;
  /** Extra attempts after the first one fails. 0 means a single attempt. */
  retries: number;
  /** Delay before the first retry; doubles on each further retry. */
  retryDelayMs: number;
}

export interface BreakerOptions {
  /** Consecutive failed calls (after their retries) that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before letting one trial call through (half-open). */
  resetMs: number;
  now?: () => number;
}

/** Defaults per provider kind; every value can be overridden where the adapter is built. */
export const PROVIDER_POLICIES = {
  fx: { timeoutMs: 5_000, retries: 1, retryDelayMs: 200 },
  kyc: { timeoutMs: 15_000, retries: 1, retryDelayMs: 500 },
  sms: { timeoutMs: 10_000, retries: 2, retryDelayMs: 500 },
} as const satisfies Record<string, CallPolicy>;

export const DEFAULT_BREAKER: Omit<BreakerOptions, 'now'> = { failureThreshold: 5, resetMs: 30_000 };

export class CallTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`${name} timed out after ${ms} ms`);
    this.name = 'CallTimeoutError';
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`${name} is unavailable (circuit open)`);
    this.name = 'CircuitOpenError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private current: BreakerState = 'closed';
  private readonly now: () => number;

  constructor(private readonly o: BreakerOptions = DEFAULT_BREAKER) {
    this.now = o.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.o.resetMs) this.current = 'half-open';
    return this.current;
  }

  /** False while open; true when closed, or half-open (one trial call decides whether it closes again). */
  allow(): boolean {
    return this.state !== 'open';
  }

  success(): void {
    this.failures = 0;
    this.current = 'closed';
  }

  failure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.o.failureThreshold) {
      this.current = 'open';
      this.openedAt = this.now();
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn` under `policy` and `breaker`. Each attempt gets its own AbortSignal and deadline; a call only counts
 * against the breaker once all its retries are spent, so one blip does not trip it.
 */
export async function callWithPolicy<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
  policy: CallPolicy,
  breaker?: CircuitBreaker,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  if (breaker && !breaker.allow()) throw new CircuitOpenError(name);
  let last: unknown;
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new CallTimeoutError(name, policy.timeoutMs));
      }, policy.timeoutMs);
    });
    try {
      const value = await Promise.race([fn(ctl.signal), deadline]);
      breaker?.success();
      return value;
    } catch (e) {
      last = e;
      if (attempt < policy.retries) await wait(policy.retryDelayMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  breaker?.failure();
  throw last;
}
