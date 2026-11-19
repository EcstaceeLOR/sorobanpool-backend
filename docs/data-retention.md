# Data retention and deletion schedule

How long each category of personal and operational data is kept, why, and which job deletes it. Written for the
Nigeria Data Protection Act (NDPA) 2023: personal data must be kept no longer than the purpose needs, and the purpose
and retention must be documented.

- **Retention** is the proposed period after the trigger shown. Periods are proposals for legal and ops review.
- **Legal basis** is a placeholder (`TBD`) until counsel confirms it: the candidates are contract, legal obligation,
  legitimate interest and consent.
- **Enforced by** names the job that deletes the data, or **Gap** when nothing deletes it today.

Nothing on-chain can be deleted: contracts store only hashes and amounts (no names, phones or documents), and the
indexed copies of on-chain data (`ChainEvent`, `Pool`, `Commitment`, `Bond`) are public by nature. They are listed so
every table is covered.

## Schedule

| Category | Tables | Personal data | Retention | Legal basis | Enforced by |
|---|---|---|---|---|---|
| OTP challenges | `OtpChallenge` | phone, hashed code | 24 h after `expiresAt` (codes expire in 5 min, `OTP_TTL_MS`) | TBD | **Gap**: expired and consumed rows are kept forever |
| Passkey challenges | `PasskeyChallenge` | user id (registration only) | Until used, at most 24 h after `expiresAt` (5 min, `CHALLENGE_TTL_MS`) | TBD | Partial: deleted on use (`passkey.controller.ts`); **Gap**: unused expired rows are kept |
| Sessions (refresh tokens) | `Session` | user id, token hash | 30 days after `expiresAt` or `revokedAt` (tokens live 30 days, `REFRESH_TTL_MS`) | TBD | **Gap**: expired and revoked rows are kept forever |
| Accounts | `User`, `UserRole`, `Passkey`, `TraderProfile` | phone, display name, wallet address, market | While the account is active; on closure, delete or anonymise after the longest dependent retention below | TBD | **Gap**: no account closure or deletion flow |
| Supplier KYB | `SupplierProfile` | business name, CAC number, address, masked bank account | Life of the supplier relationship plus a period set by legal (commonly 5 to 6 years for KYB records) | TBD (likely legal obligation) | **Gap** |
| KYC records | `VerificationRecord` | provider result (encrypted, AES-256-GCM), provider reference | Period set by legal after the check (commonly 5 years); the on-chain attestation holds only a salted hash | TBD (likely legal obligation) | **Gap** |
| Evidence | `Evidence` plus objects in the evidence bucket | delivery and dispute photos, video, documents | 1 year after the pool or dispute closes, longer when a dispute is open or under appeal | TBD | **Gap**: neither rows nor stored objects are deleted |
| Notifications | `Notification` | user id, template payload (names, amounts) | 90 days after `sentAt` (or after the last failed attempt) | TBD | **Gap** |
| Audit log | `AuditLog` | admin actor id, target user id, action data | Period set by legal and security review (commonly 1 to 7 years) | TBD (likely legitimate interest) | **Gap** (by design it must not be editable; deletion should only be age-based) |
| Idempotency keys | `IdempotencyKey` | user id, stored response | 24 h to 7 days after `createdAt` | TBD | **Gap** (an Idempotency-Key cleanup job is tracked separately) |
| Fee sponsorship counters | `SponsorUsage` | user id per day | 30 days after `day` | TBD | **Gap** |
| Naira transfers | `AnchorTransfer` | user id, amounts, anchor references | Period set by legal for payment records (commonly 5 to 6 years) | TBD (likely legal obligation) | **Gap** |
| Pending pools | `PendingPool` | organizer wallet, hub address and contact | Until the pool is indexed; delete unclaimed rows 7 days after `fillDeadline` | TBD | **Gap** |
| Offers | `Offer` | supplier id (business data, not personal) | While live, then as long as pools reference them | n/a | `expireOffers` (maintenance) marks them `EXPIRED`; nothing deletes them |
| FX quotes | `FxQuote` | none | 90 days (one row a minute) | n/a | **Gap**: grows by ~1,440 rows a day |
| Indexed chain data | `ChainEvent`, `IndexerCursor`, `Pool`, `Commitment`, `Dispute`, `Bond` | wallet addresses (public on-chain) | Kept: the read model is rebuilt from these | n/a | Not applicable |

Rate-limit counters (`src/app/rate-limit.ts`) live in process memory, reset every window, and are not persisted.

## Follow-ups

Every **Gap** above needs a deletion job. They fit the existing `maintenance` runner (`src/workers/runners.ts`, every
5 minutes; `src/workers/maintenance.ts`), which already owns `expireOffers`, using `deleteMany` with an age filter
and a row limit per run, so a large backlog drains gradually. Evidence deletion must also delete the stored object,
not only the row. These are listed as follow-ups in the PR that added this document.

Review this table whenever a Prisma model is added: every model in `prisma/schema.prisma` should appear above.
