# API usage guide: one pool, end to end

`docs/api.md` is the reference; this walks one complete journey against the dev server: sign in, bind a wallet,
create and publish an offer, prepare a pool, commit, settle, and claim a refund. Every write to the chain follows the
same two steps (prepare, then submit), so once you have done one you have done them all.

> **Status of the sample responses.** Request bodies, field names and status codes below are taken from the
> controllers (`src/app/*.controller.ts`). The response bodies are **illustrative**: values such as ids, hashes,
> XDR and ledgers are placeholders (`…`). Before relying on this guide, run each command against `pnpm dev:server`
> and replace the samples with real output (issue #164 asks for exactly that).

## 0. Start the dev server

```sh
SPONSOR_SECRET=S...   # a funded testnet key: it sponsors fees and acts as attestor and faucet
pnpm dev:server       # nest build && node dist/dev/dev-server.js
# dev api listening on :3100 (indexer from ledger …)
```

The dev server (`src/dev/dev-server.ts`) runs an in-memory Postgres (PGlite) against the real testnet contracts, with the
indexer every 3 s and the keeper every 6 s. It echoes OTP codes (`OTP_DEV_ECHO`), and it bootstraps
`+2348000000001` as ADMIN and `+2348000000002` as ARBITER. It refuses to start with `NODE_ENV=production`.

```sh
API=http://localhost:3100/v1
```

Every route needs `Authorization: Bearer <accessToken>` unless `docs/api.md` marks it public. Errors are always
`{error, message}`; see `docs/errors.md`.

## 1. Sign in with a phone number

```sh
curl -s -X POST $API/auth/otp/request -H 'content-type: application/json' -d '{"phone":"08031234567"}'
```

```json
{ "phone": "+2348031234567", "devCode": "123456" }
```

`devCode` appears only on the dev server; in production the code arrives by SMS.

```sh
curl -s -X POST $API/auth/otp/verify -H 'content-type: application/json' -d '{"phone":"08031234567","code":"123456"}'
```

```json
{
  "user": { "id": "cm…", "phone": "+2348031234567", "walletAddress": null },
  "roles": ["TRADER"],
  "accessToken": "eyJ…",
  "refreshToken": "…",
  "expiresIn": 900
}
```

```sh
TOKEN=eyJ…   # access tokens last 15 minutes; POST /auth/refresh {refreshToken} for a new pair
```

## 2. Bind a wallet

Browsers use a passkey wallet (`POST /wallets/passkey`). From a terminal, the testnet fallback is a classic account
that proves possession by signing a challenge:

```sh
curl -s $API/wallets/challenge -H "authorization: Bearer $TOKEN"
```

```json
{ "challenge": "q3V…", "expiresAt": "…" }
```

Sign the challenge string's UTF-8 bytes with the account's ed25519 key and send the signature in base64, for example
with the Stellar SDK: `Keypair.fromSecret(S).sign(Buffer.from(challenge)).toString('base64')`.

```sh
curl -s -X POST $API/wallets -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"G…","signature":"…"}'
```

```json
{ "walletAddress": "G…" }
```

On the dev server, `POST /dev/faucet/start` funds the account with test XLM and returns a USDC trustline transaction
to sign; send it back to `POST /dev/faucet/finish {signedXdr}` to receive 100 test USDC.

Register the wallet on-chain once per role (this is the first prepare/submit pair; see step 5 for how submit works):

```sh
curl -s -X POST $API/registry/register/prepare -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"role":"Trader"}'
```

## 3. Create and publish an offer (supplier)

A supplier applies with `POST /suppliers/apply`; an admin (sign in as `+2348000000001`) approves with
`POST /admin/suppliers/:userId/decision {"approve":true}`, which grants SUPPLIER and writes the attestation on-chain.
Then, as the supplier:

```sh
curl -s -X POST $API/offers -H "authorization: Bearer $SUPPLIER_TOKEN" -H 'content-type: application/json' -d '{
  "title": "Long grain rice 50kg", "description": "Parboiled, sealed bags", "unitLabel": "50kg bag", "category": "rice",
  "images": ["…", "…"], "tiersNgn": [{"minUnits": 10, "priceNgn": "78000"}, {"minUnits": 30, "priceNgn": "74000"}],
  "moq": 10, "maxUnits": 60, "maxPerMember": 10, "leadTimeHours": 72,
  "deliveryAreas": [{"state": "Lagos"}], "validUntil": "2026-12-01T00:00:00Z"
}'
```

```json
{ "id": "cm…", "status": "DRAFT", "flags": [] }
```

```sh
curl -s -X POST $API/offers/$OFFER_ID/publish -H "authorization: Bearer $SUPPLIER_TOKEN"
```

```json
{ "id": "cm…", "status": "LIVE", "offerHash": "…", "ngnPerUsd": 1502.5, "tiersUsdc": [{ "minUnits": 10, "unitPrice": "…" }] }
```

Publishing converts the naira tiers to USDC at the current rate; it refuses with `FX_DIVERGENCE` while the rate
sources disagree.

## 4. Prepare a pool (organizer)

An admin grants ORGANIZER with `POST /admin/users/:userId/roles {"role":"ORGANIZER"}`.

```sh
curl -s -X POST $API/pools/prepare -H "authorization: Bearer $ORGANIZER_TOKEN" -H 'content-type: application/json' -d '{
  "offerId": "'$OFFER_ID'", "fillDeadline": "2026-11-25T18:00:00Z",
  "hub": {"address": "Shop 12, Mile 12 Market", "contact": "08031234567"},
  "pickupWindow": {"from": "2026-11-28", "to": "2026-11-30"}, "organizerFeeBp": 100
}'
```

```json
{
  "txXdr": "AAAA…", "authEntries": ["AAAA…"], "validUntilLedger": 123456,
  "contract": "group_buy", "fn": "create_pool", "shareSlug": "a1b2c3d4e5", "hubHash": "…"
}
```

Submit it as in step 5. Once the indexer sees `pool_new`, the pool appears at `GET /pools?…` and publicly at
`GET /p/:shareSlug`.

## 5. Commit (member), and how every submit works

```sh
curl -s -X POST $API/pools/$POOL_ID/commit/prepare -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"units": 2}'
```

```json
{ "txXdr": "AAAA…", "authEntries": ["AAAA…"], "validUntilLedger": 123456, "contract": "group_buy", "fn": "commit" }
```

**Signing auth entries.** Sign only the `authEntries`, never the transaction: the fee sponsor is the transaction's
source and signs it at submit time. Each entry is a base64 `SorobanAuthorizationEntry`; sign it for the network
passphrase with an expiry no later than `validUntilLedger` (with the JS SDK, `authorizeEntry(entry, keypair,
validUntilLedger, networkPassphrase)`), and send the signed entries back in the same order. Passkey wallets sign the
same entries through WebAuthn. The relayer refuses a transaction whose source, operations, fee or signer it does not
expect (`TxRejected` codes in `docs/errors.md`).

```sh
curl -s -X POST $API/tx/submit -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"txXdr":"AAAA…","signedAuthEntries":["AAAA…"],"idempotencyKey":"commit-pool42-0001"}'
```

```json
{ "hash": "…", "contractId": "C…", "fn": "commit", "returnValue": null }
```

Reuse the same `idempotencyKey` to retry safely: a repeat returns the stored result (or `IN_PROGRESS` while the first
attempt is still running).

Follow progress with `GET /pools/$POOL_ID` (state, units, current and next tier price) or live with
`GET /pools/$POOL_ID/stream` (Server-Sent Events).

## 6. Settle

Settlement is not a member action. After the supplier accepts and dispatches and the organizer confirms delivery
(`/pools/:id/{accept,dispatch,delivery}/prepare`), the keeper calls `settle` once the confirm window passes or enough
members have picked up (`src/keeper/jobs.ts`). Watch it happen:

```sh
curl -s $API/pools/$POOL_ID -H "authorization: Bearer $TOKEN"
```

```json
{ "id": "42", "state": "Settled", "finalUnitPriceUsdc": "…", "escrowBalanceUsdc": "…", "…": "…" }
```

## 7. Claim a refund

When the final tier price is below what you paid (or the pool did not deliver), claim the difference:

```sh
curl -s -X POST $API/pools/$POOL_ID/refund/prepare -H "authorization: Bearer $TOKEN"
```

Submit it as in step 5. If you do nothing, the keeper pushes unclaimed refunds in batches of 25
(`docs/decisions/0009-refund-push-vs-pull.md`).
