# Integration tests (MinIO and Redis)

`test/integration/` holds an opt-in suite that talks to real MinIO and Redis (#156). It is skipped by default, so `pnpm test` and CI are unaffected, and runs when `INTEGRATION=1` is set.

What it covers:

- **S3 adapter (`S3ObjectStore`) against MinIO:** binary upload and download round-trip, bucket separation (public vs evidence), overwrite, missing keys returning `null`, SigV4 signing (a request signed with the wrong secret is rejected by the server), and traversal keys rejected before any request. Each run creates fresh, uniquely named buckets.
- **Redis at `REDIS_URL`:** `PING`, and a key set with a TTL that is gone after it expires. The suite speaks the Redis protocol over `node:net`, so it needs no client library.

`S3ObjectStore` has no pre-signed URLs or object expiry today, so there is nothing to test for "sign" beyond request signing, or for object "expiry"; add cases here when those features land.

## Running locally

```sh
docker compose up -d minio redis
pnpm test:integration
```

Defaults match `docker-compose.yml`: MinIO at `http://127.0.0.1:9000` with `minioadmin` / `minioadmin`, Redis at `redis://127.0.0.1:6379`. Override them with:

| Variable | Default |
| --- | --- |
| `INTEGRATION_S3_ENDPOINT` | `http://127.0.0.1:9000` |
| `INTEGRATION_S3_ACCESS_KEY` | `minioadmin` |
| `INTEGRATION_S3_SECRET_KEY` | `minioadmin` |
| `INTEGRATION_REDIS_URL` | `redis://127.0.0.1:6379` (a password in the URL is sent with `AUTH`) |

## Testcontainers

The issue asks for Testcontainers. It is not a dependency of this repo yet, so the suite reads endpoints from the environment instead: it works the same against `docker compose`, CI service containers, or Testcontainers. Moving to Testcontainers later means adding `testcontainers` as a devDependency and starting the two containers in a `globalSetup` that sets the variables above.

## Optional CI job

Not enabled by default. To run the suite in GitHub Actions, add a job like:

```yaml
  integration:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports: ['6379:6379']
      minio:
        image: bitnami/minio:latest   # the official minio/minio image needs a `server` command, which services cannot pass
        env: { MINIO_ROOT_USER: minioadmin, MINIO_ROOT_PASSWORD: minioadmin }
        ports: ['9000:9000']
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration
```
