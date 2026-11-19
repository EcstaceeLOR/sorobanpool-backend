import type { Runner } from '../workers/runners.js';

/**
 * Upper bound on a graceful shutdown (#145). Keep it below the platform's kill grace period (Docker's default is
 * 10s via `stop_grace_period`, Kubernetes' `terminationGracePeriodSeconds` 30s) so the process exits on its own.
 */
export const SHUTDOWN_TIMEOUT_MS = 9_000;

export interface ShutdownTargets {
  /** Stops accepting connections and waits for in-flight requests (Nest `app.close()`). Absent on worker roles. */
  closeHttp?: () => Promise<void>;
  /** Schedulers: each stops starting ticks and waits for the one in progress. */
  runners: readonly Runner[];
  /** Closes the database pool (`prisma.$disconnect()`). */
  disconnect: () => Promise<void>;
}

/** Drains in order: request intake first, then background ticks, then the database they both use. */
export async function shutdown(t: ShutdownTargets): Promise<void> {
  await t.closeHttp?.();
  await Promise.all(t.runners.map((r) => r.stop()));
  await t.disconnect();
}

export interface ShutdownOptions {
  timeoutMs?: number;
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
}

/**
 * Registers SIGTERM/SIGINT handlers that run `shutdown` once, exiting 0 when it completes and 1 on error or when it
 * exceeds the timeout (e.g. a long-lived SSE stream holding the HTTP server open). Returns the handler for tests.
 */
export function installShutdown(t: ShutdownTargets, o: ShutdownOptions = {}): (signal: string) => Promise<void> {
  const timeoutMs = o.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;
  const handler = (signal: string): Promise<void> => {
    if (running) return running;
    console.log(`${signal} received: draining requests and background work`);
    running = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        exit(code);
        resolve();
      };
      const timer = setTimeout(() => {
        console.error(`shutdown exceeded ${timeoutMs}ms; exiting`);
        finish(1);
      }, timeoutMs);
      shutdown(t).then(
        () => finish(0),
        (e: unknown) => {
          console.error(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
          finish(1);
        },
      );
    });
    return running;
  };
  for (const s of o.signals ?? (['SIGTERM', 'SIGINT'] as const)) process.once(s, (sig) => void handler(sig));
  return handler;
}
