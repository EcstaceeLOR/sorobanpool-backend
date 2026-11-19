import * as Sentry from '@sentry/node';
import { scrubBreadcrumb, scrubEvent } from '../common/pii.js';

/** Where unexpected failures go. Expected ones (validation, auth, contract refusals) are never reported. */
export interface ErrorReporter {
  capture(e: unknown, where: string): void;
}

export class NoopReporter implements ErrorReporter {
  capture(): void {}
}

/** Sentry via the official SDK. Request bodies, headers and cookies can carry tokens and phone numbers, so none are sent. */
export class SentryReporter implements ErrorReporter {
  constructor(dsn: string, environment: string) {
    Sentry.init({
      dsn, environment, tracesSampleRate: 0,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      // #143: phones, BVN/NIN-like ids, bearer tokens and JWTs are scrubbed from messages, extra data,
      // contexts and breadcrumbs, both when a breadcrumb is recorded and again when the event is sent.
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
  }
  capture(e: unknown, where: string): void {
    Sentry.withScope((scope) => { scope.setTag('where', where); Sentry.captureException(e); });
  }
}

export const createReporter = (dsn: string, environment: string): ErrorReporter => (dsn ? new SentryReporter(dsn, environment) : new NoopReporter());
