# API (v1)

Auth is a bearer access token (15 min) from OTP login; refresh tokens rotate and a replayed token revokes the family. Routes marked *public* need no token. Errors: `{error, message}`; contract failures are `422 {error:"CONTRACT_ERROR", contractCode}` (map the code with `src/chain/artifacts/errors.json`).

**Auth/users**: `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout` (public) · passkeys: `POST /auth/passkey/register/{options,verify}` (signed in), `POST /auth/passkey/login/{options,verify}` (public, usernameless; challenges are single use and expire in 5 minutes) · `GET|PATCH /me` (includes local account `status`) · `POST /wallets/passkey {passkeyId}` creates the user's passkey smart wallet from a passkey they registered (sponsor-deployed, idempotent; contracts ADR 0006) · `GET /wallets/challenge`, `POST /wallets` bind a classic device-key account instead (testnet fallback for browsers without passkeys) · `POST /suppliers/apply` (runs CAC and bank-account-name checks; an admin still decides), `GET /suppliers/me` · `POST /kyc/start` (BVN or NIN + selfie: identity, liveness, face match; on success the attestor writes level 1 on-chain), `GET /kyc/status` (identifier masked) · `POST /registry/register/prepare`
**Catalog**: `GET /offers`, `GET /offers/:id` (public) · `POST /offers`, `PATCH /offers/:id`, `POST /offers/:id/publish`, `/offers/:id/refresh-fx` (SUPPLIER)
**Pools**: `POST /pools/prepare` (ORGANIZER) · `GET /pools`, `GET /pools/:id`, `GET /pools/:id/quote?units=` · `GET /p/:slug`, `GET /pools/:id/sharecard.png?variant=wide|square&lang=en|pcm` (public; wide 1200x630, square 1080x1080, Pidgin labels with `lang=pcm`) · `POST /pools/:id/{commit|increase|withdraw|close-early|accept|reject|dispatch|delivery|pickup|refund|member-confirm}/prepare`
**Transactions**: `POST /tx/submit {txXdr, signedAuthEntries[], idempotencyKey}`
**Evidence**: `POST /uploads/sign`, `PUT /uploads/put` (signed URL), `GET /evidence/:id/url`, `GET /evidence/file` (signed URL, 5 min)
**Disputes**: `POST /disputes/prepare`, `POST /disputes/:id/evidence/prepare`, `GET /disputes/:id`, `GET /disputes?mine=true` · arbiter (ARBITER): `GET /arbiter/queue` (includes `slaSecondsLeft`, `breached` and `slaLabel` per open dispute; the most overdue item appears first), `GET /arbiter/disputes/:id`, `POST /arbiter/disputes/:id/resolve/prepare`
**Bond**: `POST /bonds/deposit/prepare`, `/bonds/withdraw/prepare`, `GET /bonds/me` (SUPPLIER)
**Admin** (ADMIN): `GET /admin/suppliers`, `POST /admin/suppliers/:userId/decision`, `POST /admin/users/:userId/{attest|roles}`, `POST /admin/offers/:id/takedown`, `GET /admin/audit`

`POST /admin/users/:id/suspend` and `/unsuspend` take `{reason}` (required, 1–500 characters). Supplier approvals (`POST /admin/suppliers/:userId/decision` with `{approve:true}`) and suspensions create pending actions instead of executing immediately; a different ADMIN approves them with `POST /admin/actions/:id/approve`. Pending actions are listed by `GET /admin/actions`, expire after `ADMIN_ACTION_EXPIRY_MINUTES` (default 30), and every request and approval is written to the audit log. Rejection and unsuspension remain immediate. A successful suspension approval prepares the `registry.suspend` transaction using the approving admin's wallet and updates local status to `SUSPENDED`; submit the returned transaction through `POST /tx/submit`.

Risk reporting (ADMIN): `GET /admin/risk/rates?slice=supplier|category|state` returns one row per selected slice with pool counts and failure/dispute rates for both 7- and 30-day windows. Failure rate is failed/expired/cancelled pools divided by completed pools; dispute rate is distinct disputed delivered pools divided by delivered pools in the window. A zero denominator produces a rate of `0`. Supplier values are wallet addresses, category values come from the pool's offer, and state values use the organizer's trader-profile state (falling back to the supplier profile, then `Unknown`). The response shape is `{slice, values:[{value, failedPools7d, completedPools7d, failureRate7d, disputedPools7d, deliveredPools7d, disputeRate7d, failedPools30d, completedPools30d, failureRate30d, disputedPools30d, deliveredPools30d, disputeRate30d}]}`; rates are decimal fractions.

`GET /admin/dashboard?windowDays=7` returns GMV (delivered units × final unit price), currently held escrow, active pools, failure rate, and dispute rate for a rolling 1–365 day window (default 7). GMV and escrow are decimal strings in USDC stroops. Active pools are in Open, Filled, Accepted, Dispatched or Delivered states. Failure rate is failed/expired/cancelled pools divided by all settled/failed/expired/cancelled pools ended in the window. Dispute rate is the distinct delivered pools with a dispute opened in the window divided by pools delivered in the window. Rates are fractions and become 0 when their denominator is zero. Results are cached in-process for 60 seconds per window. Dashboard scans use `Pool_endedAt_state_idx`, `Pool_deliveredAt_state_idx`, `Pool_escrowBalance_idx`, the existing `Pool_state_fillDeadline_idx`, and `Dispute_openedAt_idx`; the respective `EXPLAIN` access paths can be confirmed by querying the predicates shown in `src/app/reports.controller.ts`.

`GET /admin/risk/pairs?threshold=0.6` returns organizer-supplier pairs that meet the share threshold (default `0.6`) and the minimum three-pool evidence count. Each result is `{organizer, supplier, pools, volume, shareOfOrganizer}`; `volume` is a USDC stroops string. Threshold must be between 0 and 1 inclusive.

Every `prepare` returns `{txXdr, authEntries[], validUntilLedger, contract, fn}`; the client signs only `authEntries` with its wallet and sends them to `/tx/submit`. Quotes read the indexed pool and are indicative; the contract is authoritative.

**Operational**: `GET /health` · `GET /health/live` · `GET /health/ready` (see below) · `GET /metrics` (Prometheus text; bearer `METRICS_TOKEN`, required in production) · `GET /openapi.json` · `GET /pools/:id/stream` (public Server-Sent Events: a `pool` event with state, units, tier and ledger now and after each indexed event, `ping` every 25s; at most 500 streams per API process).

Every request accepts a well-formed `X-Request-Id` (1–64 ASCII letters, digits, dot, underscore or hyphen) or receives a generated UUID. The value is returned in `X-Request-Id`, included in error bodies and request/error logs, and forwarded to outbound FX and Horizon HTTP providers.

Rate limit: `RATE_LIMIT_PER_MIN` requests per client IP per minute (default 300), then `429 {error:"RATE_LIMITED", retryAfterSecs}`; health is exempt. Behind a proxy set Express `trust proxy` so the real client IP is used.

Body limits: JSON bodies over `JSON_BODY_LIMIT` (default `100kb`) and raw uploads (`image/*`, `video/mp4`, `application/pdf`) over `UPLOAD_BODY_LIMIT` (default `16mb`) are refused with `413 {error:"PAYLOAD_TOO_LARGE"}` before any route runs.

Compression and caching: JSON `GET` responses of at least `COMPRESSION_THRESHOLD_BYTES` (default 1024) are sent with brotli when the client accepts it, otherwise gzip, with `Vary: Accept-Encoding`. Public routes set `Cache-Control` by class (`src/app/http-setup.ts`): `GET /offers` and `GET /offers/:id` use `public, max-age=60, stale-while-revalidate=300`; `GET /p/:slug` (live progress) uses `public, max-age=15, stale-while-revalidate=60`; `GET /pools/:id/sharecard.png` uses `public, max-age=60`, so WhatsApp and CDN previews refresh within a minute of a pool changing. Authenticated routes set no `Cache-Control`.

`docs/openapi.json` (also served at `/v1/openapi.json`) lists every route with method, auth requirement, roles (`x-roles`) and path parameters. It is generated from controller metadata (`pnpm openapi` after changing routes; a test fails if it is stale). It does not describe request or response schemas; this file does. The most used operations (OTP login and refresh, offer list and detail, FX quote, pool list, read and quote, pool prepare and commit) carry request and response examples from `src/app/openapi-examples.ts`, each request example checked against the handler's zod schema by `openapi.spec.ts`.

## Health probes

`GET /health/live` answers `200 {status:"ok"}` whenever the process is serving and never touches a dependency, so a database or RPC outage cannot put the container into a restart loop. `GET /health` also always answers `200`, but adds `indexer: "ok" | "degraded" | "skipped"`: it is `degraded` when the latest network ledger minus the stored cursor exceeds `INDEXER_LAG_ALERT_LEDGERS` (default 20), and `skipped` before the first run or when the tip is unknown.

`GET /health/ready` checks each dependency independently, each bounded at 2s:

| Check | Fails when |
| --- | --- |
| `database` | `SELECT 1` errors or times out |
| `rpc` | the Soroban RPC cannot return the latest ledger |
| `indexer` | the indexer cursor is more than `INDEXER_LAG_ALERT_LEDGERS` (20 by default) ledgers behind the RPC tip; `skipped` before its first run or when the tip is unknown |

It answers `200 {status:"ready", checks}` or `503 {error:"NOT_READY", message, failing:[...], checks}`. Use liveness for restarts and readiness for routing:

```yaml
# docker-compose
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3000/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  interval: 10s
  timeout: 3s
  retries: 3

# Kubernetes
livenessProbe:
  httpGet: { path: /v1/health/live, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /v1/health/ready, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3
```

All three health routes are exempt from the rate limit.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the process stops accepting new connections and lets in-flight requests finish (`app.close()`), stops every scheduler so no new tick starts while a running tick completes, then disconnects Prisma, and exits 0. If that takes longer than 9s (`SHUTDOWN_TIMEOUT_MS` in `src/app/shutdown.ts`) it exits 1; long-lived `/pools/:id/stream` connections are the usual reason. Keep the platform's kill grace period above that (Docker `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`).

## Metrics and alerts

`http_request_duration_seconds` is a histogram labelled `method`, `route` (the route template, such as `/v1/offers/:id`, or `unmatched`; never a raw URL or id) and `status_class` (`2xx`, `4xx`, `5xx`). `http_requests_total` counts requests by `method`, `route` and `status`. `indexer_lag_ledgers` is a gauge of the latest network ledger minus the indexer cursor (0 before the first run); it is 0 when caught up and rises while the indexer is behind. `sp_notifications_pending` and `sp_notifications_failed` are gauges from the notification table. Example Prometheus alert rules:

```yaml
groups:
  - name: sorobanpool-api
    rules:
      - alert: ApiErrorRateHigh
        expr: |
          sum(rate(http_request_duration_seconds_count{status_class="5xx"}[5m]))
            / sum(rate(http_request_duration_seconds_count[5m])) > 0.02
        for: 10m
        annotations:
          summary: API 5xx error rate above 2%
      - alert: ApiLatencyP95High
        expr: |
          histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))) > 1
        for: 10m
        annotations:
          summary: "p95 latency above 1s on {{ $labels.route }}"
      - alert: IndexerLagHigh
        expr: indexer_lag_ledgers > 20
        for: 5m
        annotations:
          summary: "indexer is more than 20 ledgers behind the network tip"
```

OpenTelemetry traces are enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. The API records HTTP server spans, Prisma query spans and individual Soroban RPC spans; resources identify `service.name`, `service.version` and `service.role`. The SDK exporter is shut down after HTTP/background work drains.
