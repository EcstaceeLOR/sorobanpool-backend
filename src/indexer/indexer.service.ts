import { decodeEvent, type DecodedEvent, type RawEvent } from './decode.js';
import type { Projector } from './projector.js';
import {
  DEFAULT_INDEXER_BATCH_LEDGERS, DEFAULT_INDEXER_LAG_ALERT_LEDGERS, DEFAULT_INDEXER_PROGRESS_LOG_LEDGERS,
  DEFAULT_INDEXER_RETRIES, DEFAULT_INDEXER_RETRY_BASE_MS, DEFAULT_INDEXER_RETRY_JITTER, DEFAULT_INDEXER_RETRY_MAX_MS,
} from '../config/env.js';
import type { Metrics } from '../observability/metrics.js';

/** Kept as an alias so existing imports keep working; the source of truth is the env default. */
export const LAG_ALERT_LEDGERS = DEFAULT_INDEXER_LAG_ALERT_LEDGERS;
/** The retention window slides ~1 ledger per 5 s, so a fresh start begins this far inside it (about 5 minutes). */
export const RETENTION_MARGIN_LEDGERS = 60;

export interface RpcPort {
  latestLedger(): Promise<number>;
  /** Oldest ledger the RPC still serves events for (events are only retained for a limited window). */
  oldestLedger(): Promise<number>;
  getEvents(startLedger: number, endLedger: number, contractIds: string[]): Promise<RawEvent[]>;
}

export interface CursorStore {
  get(): Promise<number | undefined>;
  set(ledger: number): Promise<void>;
}

export interface EventSink {
  /** Stores the raw event idempotently (ChainEvent table). */
  saveRaw(raw: RawEvent): Promise<void>;
}

/**
 * Where a brand-new indexer (no cursor yet) begins. A number is an operator's explicit choice and is honoured
 * strictly: below the RPC retention window it fails loudly, because history would be silently lost. `'oldest'`
 * (the default for a fresh install) starts at the oldest retained ledger and logs that earlier history, if any,
 * must be backfilled from an archive (docs/runbooks/indexer-backfill.md). `{ from }` (the contracts' deploy ledger)
 * starts there when RPC still retains it, otherwise behaves like `'oldest'`.
 */
export type StartLedger = number | 'oldest' | { from: number };

export interface IndexerMetrics {
  lag: number;
  lastLedger: number;
  behindRetention: boolean;
}

export interface BackoffOptions {
  /** Extra attempts after the first failure. */
  retries: number;
  baseMs: number;
  maxMs: number;
  /** Symmetric fraction of the delay jittered by a random draw in [0, 1). */
  jitter?: number;
  /** Injectable so tests assert the exact delay sequence without real timers. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Attempt `n` (0-based) waits base*2^n, capped at maxMs, then jittered (still capped at maxMs). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, jitter = 0, random: () => number = Math.random): number {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  if (jitter <= 0) return Math.round(capped);
  return Math.round(Math.min(maxMs, capped * (1 - jitter + random() * 2 * jitter)));
}

/** Runs a flaky call with bounded exponential backoff; a spent retry budget rethrows the last error. */
export async function withBackoff<T>(fn: () => Promise<T>, o: BackoffOptions): Promise<T> {
  const wait = o.sleep ?? sleep;
  const random = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= o.retries) throw error;
      const delayMs = backoffDelay(attempt, o.baseMs, o.maxMs, o.jitter ?? 0, random);
      o.onRetry?.(attempt + 1, delayMs, error);
      await wait(delayMs);
    }
  }
}

export interface IndexerOptions {
  retries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  backoffJitter?: number;
  progressEveryLedgers?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
}

export class Indexer {
  metrics: IndexerMetrics = { lag: 0, lastLedger: 0, behindRetention: false };

  constructor(
    private readonly rpc: RpcPort,
    private readonly cursor: CursorStore,
    private readonly sink: EventSink,
    private readonly projector: Projector,
    private readonly contractIds: string[],
    private readonly startLedger: StartLedger,
    private readonly batch = DEFAULT_INDEXER_BATCH_LEDGERS,
    /** Runs after an event is newly committed (never on replays). Failures are logged, not fatal: at-most-once side effects. */
    private readonly onApplied?: (ev: DecodedEvent) => Promise<unknown>,
    private readonly lagAlertLedgers = DEFAULT_INDEXER_LAG_ALERT_LEDGERS,
    /** Prometheus registry for the lag gauge (#85). Optional so unit tests need no observability setup. */
    private readonly prom?: Metrics,
    /** Backoff and progress-log settings (#87). Optional so existing callers keep their behaviour. */
    private readonly options: IndexerOptions = {},
  ) {}

  /** One poll: fetch from the cursor, store raw, project, advance. Safe to call repeatedly. */
  async tick(): Promise<{ processed: number }> {
    const retry = <T>(name: string, call: () => Promise<T>): Promise<T> => withBackoff(call, {
      retries: this.options.retries ?? DEFAULT_INDEXER_RETRIES,
      baseMs: this.options.backoffBaseMs ?? DEFAULT_INDEXER_RETRY_BASE_MS,
      maxMs: this.options.backoffMaxMs ?? DEFAULT_INDEXER_RETRY_MAX_MS,
      jitter: this.options.backoffJitter ?? DEFAULT_INDEXER_RETRY_JITTER,
      sleep: this.options.sleep,
      random: this.options.random,
      onRetry: (attempt, delayMs, error) => console.warn(`[indexer] ${name} failed (${(error as Error).message}); retry ${attempt} in ${delayMs}ms`),
    });
    const latest = await retry('latestLedger', () => this.rpc.latestLedger());
    const oldest = await retry('oldestLedger', () => this.rpc.oldestLedger());
    const from = (await this.cursor.get()) ?? this.initialCursor(oldest);
    this.metrics.behindRetention = from + 1 < oldest;
    if (this.metrics.behindRetention) {
      throw new Error(`indexer is behind the RPC event retention window (cursor ${from}, oldest ${oldest}); backfill required`);
    }
    const to = Math.min(latest, from + this.batch);
    let processed = 0;
    if (to > from) {
      const raws = await retry('getEvents', () => this.rpc.getEvents(from + 1, to, this.contractIds));
      for (const raw of raws) {
        await this.sink.saveRaw(raw);
        const ev = decodeEvent(raw);
        if (ev && (await this.projector.apply(ev))) {
          processed++;
          if (this.onApplied) await this.onApplied(ev).catch((e: Error) => console.error(`[indexer] onApplied ${ev.contract}.${ev.event}: ${e.message}`));
        }
      }
      await this.cursor.set(to);
    }
    this.metrics.lastLedger = Math.max(to, from);
    this.metrics.lag = Math.max(0, latest - this.metrics.lastLedger);
    this.prom?.setGauge('indexer_lag_ledgers', {}, this.metrics.lag);
    this.logProgress(from, to, processed);
    return { processed };
  }

  /** One line each time the batch crosses an N-ledger boundary, so a backlog is visibly draining. */
  private logProgress(from: number, to: number, processed: number): void {
    const every = this.options.progressEveryLedgers ?? DEFAULT_INDEXER_PROGRESS_LOG_LEDGERS;
    if (Math.floor(to / every) <= Math.floor(from / every)) return;
    const log = this.options.log ?? ((line: string) => console.log(line));
    log(`[indexer] progress ${from + 1}..${to} processed=${processed} lag=${this.metrics.lag}`);
  }

  private initialCursor(oldest: number): number {
    if (typeof this.startLedger === 'number') return this.startLedger - 1;
    if (typeof this.startLedger === 'object' && this.startLedger.from >= oldest + RETENTION_MARGIN_LEDGERS) return this.startLedger.from - 1;
    const start = oldest + RETENTION_MARGIN_LEDGERS;
    console.warn(`[indexer] no cursor yet: starting near the oldest retained ledger (${start}, oldest ${oldest}); earlier events, if any, need a backfill`);
    return start - 1;
  }

  get shouldAlert(): boolean {
    return this.metrics.lag > this.lagAlertLedgers || this.metrics.behindRetention;
  }
}
