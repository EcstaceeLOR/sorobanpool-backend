# Architecture
See the build brief sections 4 and 7. The backend cannot move escrowed funds; contracts are the source of truth.

## Decisions
Decisions are recorded in [docs/decisions/](decisions/).
- [0008 Object storage and hosting](decisions/0008-object-storage.md): S3-compatible, private buckets, files served through the API with 5-minute signed URLs.
- [0009 Refunds are pull-first, with keeper pushes as the backstop](decisions/0009-refund-push-vs-pull.md): `claim_refund` for members, `push_refunds` in batches of 25 from the keeper.
