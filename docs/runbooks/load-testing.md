# Runbook: load testing (k6)

Two [k6](https://k6.io/docs/get-started/installation/) scripts cover the load targets in brief 11.5 (#155). They are standalone k6 JavaScript, not part of `pnpm test`, and add no npm dependency.

| Script | Scenario | Default load | Thresholds (fail the run when broken) |
| --- | --- | --- | --- |
| `test/load/viewers.js` | Public pool pages: `GET /v1/p/:slug` and `GET /v1/pools/:id/sharecard.png` | Ramp to 1,000 concurrent viewers over 1m, hold 5m | errors < 1%; p95 preview < 500 ms; p95 share card < 1,000 ms |
| `test/load/commits.js` | `POST /v1/pools/:id/commit/prepare` | 100 commits spread evenly over 5 minutes | errors < 1%; p95 prepare < 2,000 ms |

The load figures (1,000 viewers, 100 commits in five minutes) come from the brief. The brief has no latency numbers in this repo, so the p95 limits above are starting values; override them with `-e P95_PREVIEW_MS=`, `-e P95_SHARECARD_MS=` and `-e P95_PREPARE_MS=` once a target is agreed.

The commit script exercises `prepare` (simulation and auth-entry assembly), which is the expensive server path. It does not sign or call `/tx/submit`, because that needs member wallets to sign each auth entry; a full submit test needs a signing harness and funded testnet members.

## Running against staging

1. Pick an open pool. Note its id and share slug (`GET /v1/pools/:id` returns `shareSlug`).
2. Viewers:
   ```sh
   k6 run -e BASE_URL=https://staging.example.com -e SLUG=<share slug> -e POOL_ID=<pool id> test/load/viewers.js
   ```
3. Commits: create or reuse test members with a bound wallet and collect their access tokens (`POST /v1/auth/otp/verify`). Several tokens spread the load across users, which is closer to real traffic; `prepare` itself is not counted against the relayer's per-user sponsorship caps (those apply at `/tx/submit`).
   ```sh
   k6 run -e BASE_URL=https://staging.example.com -e POOL_ID=<pool id> -e TOKENS=<t1,t2,...> test/load/commits.js
   ```
4. Watch the API and indexer logs and the sponsor balance during the commit run.

Never point these at production: the commit script drives real RPC simulation load at the network's RPC provider.

## Reduced local run

Against the dev server (`pnpm dev:server`, port 3000):

```sh
k6 run -e SLUG=<slug> -e VUS=50 -e RAMP=15s -e HOLD=1m test/load/viewers.js
k6 run -e POOL_ID=<id> -e TOKENS=<t1> -e COMMITS=10 -e WINDOW=1m test/load/commits.js
```

## Results

No results are recorded yet; fill this in after the first staging run, and add a row each time the thresholds or infrastructure change.

| Date | Target | Script | Load | p95 | Error rate | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| _pending_ | staging | viewers.js | 1,000 VUs, 5m | | | |
| _pending_ | staging | commits.js | 100 / 5m | | | |
