# Contributing
- Branches: `feat/…`, `fix/…`, `chore/…`. Conventional Commits. Squash merges.
- Every PR must build, pass lint/typecheck/tests, update docs, and reference an issue.
- Never commit secrets.
- Escrow, settlement, disputes and bond changes need two maintainer reviews.

## First-time setup

You need **Node 24** and **pnpm 10** (the exact pnpm version is pinned in `package.json` → `packageManager`; `corepack enable`
picks it up). A database is **not** needed to run the tests: they use an in-process PostgreSQL (PGlite, ADR 0004).

```bash
git clone <your fork> && cd sorobanpool-backend
corepack enable                     # uses the pnpm version from package.json
pnpm install --frozen-lockfile      # postinstall runs `prisma generate` into src/generated/
pnpm lint && pnpm exec tsc --noEmit && pnpm build
pnpm test                           # whole suite on PGlite, no Docker required
```

To run the API itself, follow the README **Quickstart**: `cp .env.example .env`, start PostgreSQL and Redis
(`docker compose up -d postgres redis minio`, or a local PostgreSQL 16+ and Redis 7), export `SPONSOR_SECRET`, then
`pnpm prisma:migrate:deploy` and `pnpm start:dev`. The API listens on `PORT` (3000 by default); the frontend dev server
expects to be on 3001 (`WEBAUTHN_ORIGIN`, `PUBLIC_APP_URL`). With no database at all, `pnpm dev:server` runs everything on
PGlite on port 3100.

## Common failures and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '…/src/generated/prisma/client.js'` | The Prisma client was not generated (install ran with `--ignore-scripts`, or the schema changed) | `pnpm exec prisma generate` |
| Startup fails with an env validation error | `.env` missing, or a secret shorter than 32 characters | `cp .env.example .env`; keep every `*_SECRET` at 32+ characters |
| `SPONSOR_SECRET` missing / sponsor has no XLM | The sponsor pays every fee on testnet | `stellar keys generate sp-dev --network testnet --fund && export SPONSOR_SECRET=$(stellar keys show sp-dev)` |
| `relation "…" does not exist` against a local PostgreSQL | Migrations not applied | `pnpm prisma:migrate:deploy` (tests apply them to PGlite themselves) |
| Tests pass locally, fail in CI's `real-postgres` job | Behaviour that differs between PGlite and PostgreSQL 16 | `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm test` against a local PostgreSQL |
| `docs/openapi.json is up to date` fails | A route, DTO or role changed | `pnpm openapi`, then commit `docs/openapi.json` |
| `auth contract` test fails on a new route | The route is public but not listed, or lacks a role | Add `@Roles(…)`, or list it in `PUBLIC_ROUTES` in `test/auth-contract.spec.ts` if it really is public |
| `pnpm test:cov` fails on a threshold | Coverage of a money-critical module dropped below its floor (`vitest.config.ts`) | Add tests for the code you touched; never lower a floor to get green |
| `pnpm install --frozen-lockfile` fails | `package.json` changed without the lockfile | Run `pnpm install` and commit `pnpm-lock.yaml` |

## Coverage floors

`pnpm test:cov` (run by CI) enforces per-module floors in `vitest.config.ts` for the money-critical code. Coverage when
the floors were set (statements / branches / functions / lines, %):

| Module | Measured | Floor |
| --- | --- | --- |
| `src/pools/pricing.ts` | 100 / 87.5 / 100 / 100 | 98 / 85 / 98 / 98 |
| `src/relayer/**` | 96.96 / 93.75 / 87.5 / 100 | 95 / 90 / 85 / 98 |
| `src/keeper/**` | 100 / 97.05 / 66.66 / 100 | 98 / 95 / 65 / 98 |
| `src/indexer/projector.ts` | 85.71 / 76.66 / 77.77 / 86.81 | 84 / 75 / 75 / 85 |

When a PR raises a module's coverage, raise its floor to just under the new figure and update this table.

## Migrations
CI runs `node scripts/lint-migrations.ts`, which fails on statements that are dangerous on a populated database:
`drop-column`, `drop-table`, `not-null-without-default` (an `ADD COLUMN … NOT NULL` with no `DEFAULT`),
`non-concurrent-index` (a `CREATE INDEX` without `CONCURRENTLY` on a table the migration did not create) and
`alter-column-type`. If one is genuinely safe, annotate it on the same line or the line above, with a reason:

```sql
-- migration-lint: allow drop-column nothing has read "legacyFlag" since v1.4
ALTER TABLE "User" DROP COLUMN "legacyFlag";
```

Migrations that predate the linter are listed in `scripts/migration-lint-baseline.json` and are not scanned; never add
new migrations there.

## API contract
`docs/openapi.json` is generated (`pnpm openapi`) and checked by `openapi-diff` on pull requests. It fails on removed
routes or response fields, newly required request fields or parameters, and tightened request types. If a breaking
change is intended, add the `breaking-api` label to the PR and call the change out in its description.

## First-PR checklist

- [ ] The PR references its issue (`Closes #N`) and has one logical change.
- [ ] `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` and `pnpm test:cov` pass locally.
- [ ] New behaviour has tests; money math (pricing, refunds, allocation) also has a property in `src/pools/pricing.property.spec.ts` when it changes.
- [ ] Route changes: `pnpm openapi` re-run and `docs/openapi.json` committed; new public routes added to `PUBLIC_ROUTES`.
- [ ] Schema changes come with a migration under `prisma/migrations/`.
- [ ] Docs updated (`README.md`, `docs/`, or an ADR in `docs/decisions/` for a design choice).
- [ ] No secrets, `.env` files or generated client code committed.
