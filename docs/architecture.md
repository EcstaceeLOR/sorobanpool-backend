# Architecture
See the build brief sections 4 and 7. The backend cannot move escrowed funds; contracts are the source of truth.

## Decisions
Decisions are recorded in [docs/decisions/](decisions/).
- [0008 Object storage and hosting](decisions/0008-object-storage.md): S3-compatible, private buckets, files served through the API with 5-minute signed URLs.
- [0009 Refunds are pull-first, with keeper pushes as the backstop](decisions/0009-refund-push-vs-pull.md): `claim_refund` for members, `push_refunds` in batches of 25 from the keeper.

## Raw chain-event retention (#90)

`ChainEvent` is the replay log used to rebuild read models. Its retention policy is:

- **Final pools** (`Settled`, `Expired`, `Failed`, `Cancelled`): events older than `CHAIN_EVENT_RETENTION_DAYS` (180 days by default, measured from the ledger close time) are pruned.
- **Non-final pools**: every event is kept regardless of age, because the pool can still change and must remain rebuildable from its first event.
- **Events with no pool** (config, registry, reputation, bond, wallet): pruned on the same schedule; they never contribute to a pool rebuild.
- **Events with unknown pool ownership**: marked `protected` at ingest and never pruned automatically.

`pruneChainEvents` in `src/workers/maintenance.ts` runs inside the maintenance runner. It scans in bounded batches
(`batchSize` rows per query, `maxBatches` queries per run) ordered by close time, so a large backlog drains over several
ticks without long locks. The indexer cursor and the projected `Pool`, `Commitment`, `Dispute` and `Bond` rows are never
pruned: they are the current read model, not history.
