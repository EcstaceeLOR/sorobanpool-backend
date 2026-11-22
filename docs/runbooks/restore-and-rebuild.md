# Runbook: restore the database and rebuild read models

The contracts are the source of truth (brief 7.3). The database holds two kinds of data, and they are recovered
differently:

| Kind | Tables | Recovered from |
| --- | --- | --- |
| **Off-chain records** (only exist here) | `User`, `UserRole`, `Passkey`, `Session`, `TraderProfile`, `SupplierProfile`, `VerificationRecord`, `Offer`, `PendingPool`, `Evidence`, `AnchorTransfer`, `FxQuote`, `Notification`, `AuditLog`, `IdempotencyKey`, `SponsorUsage` | a **backup** only |
| **Read models** (projected from contract events) | `Pool`, `Commitment`, `Dispute`, `Bond` | `ChainEvent` replay, or the chain |
| **Event log and cursor** | `ChainEvent`, `IndexerCursor` | a backup, then RPC within its retention window, then an archive |

`Offer` and `PendingPool` are written by the projector too (status changes), but they also hold off-chain data, so
they are never truncated during a rebuild.

## Path A: restore from a backup

1. **Stop writers.** Scale `api`, `worker` and `indexer` to zero (and any process with `INDEXER_EMBEDDED` or
   `KEEPER_EMBEDDED`). A worker running against a half-restored database will mis-reconcile and page.
2. **Restore.**
   - Managed PostgreSQL with point-in-time recovery (PITR): restore to a new instance at a timestamp **before** the
     incident. PITR replays WAL, so pick the last known-good moment rather than "latest" if the loss was a bad
     migration or a `DELETE`.
   - From a logical dump:
     ```sh
     createdb sorobanpool_restore
     pg_restore --no-owner --dbname "$RESTORE_URL" backup.dump
     ```
3. **Apply migrations** the backup may predate: `pnpm prisma:migrate:deploy` with `DATABASE_URL` set to the restored
   database. This only runs committed migrations; it never resets data.
4. **Point the app at it** (update `DATABASE_URL`), then start the `indexer` role first.
5. The indexer resumes from `IndexerCursor.lastLedger`. Events between the backup time and now are re-fetched from
   RPC and projected; `ChainEvent` is idempotent by event id, so overlap is harmless. If the backup is older than the
   RPC retention window (about 7 days on testnet; `getHealth.oldestLedger`), the indexer stops with
   `backfill required`: follow [indexer-backfill](indexer-backfill.md) for the gap, then continue.
6. Start `worker`, then `api`. Run the verification below.

Off-chain rows created after the backup point (new sign-ups, uploads, offers) are lost; the chain cannot recover
them. Evidence **files** survive in object storage, but their `Evidence` rows do not; list orphans with the bucket
listing if needed.

## Path B: rebuild read models from `ChainEvent`

Use this when the event log is intact but projections are wrong (a projector bug, a botched manual edit).

1. Stop the `indexer` role (and `INDEXER_EMBEDDED` processes) so nothing projects concurrently.
2. Clear the projections and mark every event unprocessed, in one transaction:
   ```sql
   BEGIN;
   TRUNCATE "Commitment", "Dispute", "Bond", "Pool";
   UPDATE "ChainEvent" SET "processedAt" = NULL;
   COMMIT;
   ```
3. Replay. There is **no standalone replay command yet**: the projector only runs from `Indexer.tick()`
   (`src/indexer/indexer.service.ts`), which re-reads events from RPC. So:
   - **All events still inside RPC retention** (a young deployment, or a recent cut-off): set the cursor to the first
     contract ledger and restart the indexer. Each event is re-fetched, matched to its `ChainEvent` row by id
     (`processedAt IS NULL`, so `markProcessed` re-applies it) and projected again.
     ```sql
     UPDATE "IndexerCursor" SET "lastLedger" = <deploy ledger - 1>;
     ```
     It catches up at 1,000 ledgers per tick; the `[indexer] ALERT lag=<n> ledgers` log line repeats until it reaches the tip.
   - **Events older than retention**: they exist only as `ChainEvent.payload`, and replaying them needs a small script
     that feeds each stored payload through `decodeEvent` and `Projector.apply` in ledger order. That script does
     not exist yet; until it does, treat this case as Path C for the older range.
4. Notifications: `onApplied` runs for every re-applied event, so a full replay can re-send member SMS. Before step 3,
   either stop the notifier (the `worker` role) or accept duplicates. The dispatcher's dedupe only covers events that
   were already processed.

## Path C: events lost too

If `ChainEvent` is gone and the range is older than RPC retention, import the events from a full-history source as
described in [indexer-backfill](indexer-backfill.md) (Galexie / ledger-metadata lake, or a Hubble/BigQuery export of
`history_contract_events` filtered to the contract ids in `DEPLOYMENTS_FILE`), then continue with Path B.

## Timing

- Restore: dominated by the database size and the provider (PITR restores are usually minutes to an hour).
- Re-projection: the indexer processes up to 1,000 ledgers per tick; at the default 5 s ledger close a day of history
  is about 17,000 ledgers, so roughly 17 ticks per day of history plus RPC latency.

## Verify after a restore or rebuild

1. Indexer caught up: no `[indexer] ALERT lag=...` log lines (lag is under `INDEXER_LAG_ALERT_LEDGERS`, default 20),
   `GET /health` reports `indexer: ok`, and no `backfill required` errors.
2. Every event projected:
   ```sql
   SELECT count(*) AS unprocessed FROM "ChainEvent" WHERE "processedAt" IS NULL;   -- expect 0
   SELECT max("ledger") FROM "ChainEvent";                                            -- close to the tip
   ```
3. Row counts are plausible against the last known numbers (keep these from the incident start):
   ```sql
   SELECT (SELECT count(*) FROM "Pool") AS pools, (SELECT count(*) FROM "Commitment") AS commitments,
          (SELECT count(*) FROM "Dispute") AS disputes, (SELECT count(*) FROM "Bond") AS bonds;
   ```
4. **Reconcile against the chain.** The `worker` role's maintenance job runs `reconcilePools` every 5 minutes and
   compares state, total units and escrow balance of every live pool with the contract. Start the worker and confirm
   no `[reconcile] ALERT pool ...` lines across two runs. Any persistent mismatch means a range is still missing or
   mis-projected.
5. Smoke test the API: `GET /v1/health`, then open a known live pool and compare its totals with an explorer.

## Rehearsal

The issue asks for a rebuild exercised on a copy of a dev database with recorded row counts. That needs a running
database and was not possible when this runbook was written; record the before/after counts from step 3 here on the
first rehearsal.
