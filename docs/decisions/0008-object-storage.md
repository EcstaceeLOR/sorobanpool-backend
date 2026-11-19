# 0008 Object storage and hosting: S3-compatible, two buckets, files served through the API

**Context.** The brief (14.4) asks for a recorded decision on storage and hosting. The backend stores two very
different kinds of file: delivery, dispute and waybill **evidence**, which can show faces, addresses and documents and
must only be readable by the people in that pool or dispute; and supplier **product photos**, which are public. The
product targets cheap hosting in Nigeria and must run fully on a laptop for contributors.

**Decision.**

- **One port, two adapters.** `ObjectStore` (`src/evidence/store.ts`) has `put` and `get` for two logical buckets,
  `public` and `evidence`. `OBJECT_STORE=s3` uses `S3ObjectStore` (any S3-compatible service: AWS S3, Cloudflare R2,
  MinIO) with path-style addressing so custom endpoints work. `OBJECT_STORE=local` uses `LocalObjectStore`, a
  directory tree under `EVIDENCE_DIR`, for development and tests; docker compose also runs MinIO for testing the S3
  path locally.
- **Two buckets, both private at the provider.** `S3_BUCKET_PUBLIC` and `S3_BUCKET_EVIDENCE` have **no** public
  access policy: block all public access, no bucket website, no anonymous `GetObject`. Only the backend's credentials
  (`S3_ACCESS_KEY_REF` / `S3_SECRET_KEY_REF`) can read or write. "Public" describes who may see the file through the
  API, not the bucket ACL.
- **Files are served by the API, not by presigned S3 URLs.** Uploads and evidence reads use the backend's own
  HMAC-signed URLs (`signUrl` / `verifySignedUrl` in `src/evidence/evidence.ts`), keyed with `JWT_SECRET + ':uploads'`
  and bound to the object key, the user and the purpose (`PUT` or `GET`):
  - `POST /v1/uploads/sign` returns a `PUT /v1/uploads/put` URL; the server hashes the bytes, so the client cannot
    choose the hash that goes on-chain.
  - `GET /v1/evidence/:id/url` checks `canReadEvidence` (owner, pool participant, the arbiter of an open dispute, or
    admin) and returns a `GET /v1/evidence/file` URL, served with `Cache-Control: private, no-store`.
  - Product photos are re-encoded to small WebP with metadata stripped (no EXIF location) and served from
    `GET /v1/images/:id` with `Cache-Control: public, max-age=86400, immutable`, so a CDN in front of the API can
    cache them.
- **Signed URL lifetime: 5 minutes** (`SIGNED_URL_TTL_SECONDS = 300`) for both upload and read. Long enough for a
  slow mobile upload to start; short enough that a leaked link expires before it spreads. Uploads are capped at
  15 MB and to JPEG, PNG, WebP, MP4 and PDF (`MAX_EVIDENCE_BYTES`, `ALLOWED_MIME`).
- **Keys** are `<kind>/<evidence id>` (for example `dispute/ck...`), never user-supplied; both stores reject keys with
  `..` or a leading `/`.
- **Hosting:** the three roles run as containers from one image (`Dockerfile`); storage is whichever S3-compatible
  service the host provides. R2 is the default recommendation (no egress fees, S3 API); MinIO for self-hosting.

**Alternatives considered.**

- *Presigned S3 URLs straight to the bucket.* Saves API bandwidth, but the authorisation check and the
  server-computed hash would have to move to a post-upload callback, the bucket would need a CORS policy, and the
  link format would differ between providers. Revisit if evidence volume makes API bandwidth a real cost; the
  5-minute lifetime and per-user binding should carry over.
- *A public bucket for product photos.* Removes one hop, but loses the re-encode/strip step as an enforcement point
  and exposes the bucket listing surface. The API route plus a CDN gives the same latency.
- *Database `bytea` storage.* Simple, but bloats backups and the restore path ([restore-and-rebuild](../runbooks/restore-and-rebuild.md)).

**Consequences.**

- Every evidence and image byte passes through the API process; size limits and the CDN cache matter for cost.
- Rotating `JWT_SECRET` invalidates outstanding upload and read links (at most 5 minutes of them).
- Backups of the database do not include files; bucket versioning or replication is the provider's job, and a
  restored database can reference objects by key as long as the bucket survives.
- Local mode has no access control beyond the API, which is fine for development and must never be used in
  production (`OBJECT_STORE=local` writes to the container filesystem).
