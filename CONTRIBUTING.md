# Contributing
- Branches: `feat/…`, `fix/…`, `chore/…`. Conventional Commits. Squash merges.
- Every PR must build, pass lint/typecheck/tests, update docs, and reference an issue.
- Never commit secrets.
- Escrow, settlement, disputes and bond changes need two maintainer reviews.

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
