# Architecture
See the build brief sections 4 and 7. The backend cannot move escrowed funds; contracts are the source of truth.

Decisions are recorded in [docs/decisions/](decisions/). Storage and hosting: [ADR 0008](decisions/0008-object-storage.md) (S3-compatible, private buckets, files served through the API with 5-minute signed URLs).
