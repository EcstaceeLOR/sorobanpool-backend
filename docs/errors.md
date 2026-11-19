# Error response catalogue

Every error response is JSON with an `error` code and, almost always, a human-readable `message`. Clients should
branch on `error` and the HTTP status, never on `message` (it may be reworded or localised). The mapping from thrown
errors to responses lives in `ApiExceptionFilter` (`src/app/http.ts`).

`src/app/error-catalogue.spec.ts` fails when the code throws an error code that is missing from this page, so add a
row here whenever you add a code.

## Contract errors

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `CONTRACT_ERROR` | 422 | A contract refused the transaction. The body carries `contractCode`, the Soroban `Error(Contract, #n)` number. | Look `contractCode` up in `src/chain/artifacts/errors.json` (generated from the contracts; each entry has `code`, `contract`, `name`) and show the matching plain-language message. Do not retry unchanged. |

The contract error list is not copied here: `src/chain/artifacts/errors.json` is the source of truth and is refreshed
with the contract artifacts.

## Request and server errors

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `VALIDATION` | 400 | The request body, query or path failed validation. The body carries `issues: [{path, message}]` (or a `message` for path ids). | Fix the listed fields. |
| `RATE_LIMITED` | 429 | More than `RATE_LIMIT_PER_MIN` requests from this IP in a minute. The body carries `retryAfterSecs`. | Wait `retryAfterSecs`, then retry. |
| `BUSY` | 503 | Too many open Server-Sent Event streams on this API process. | Retry later, or poll `GET /pools/:id`. |
| `NOT_AVAILABLE` | 501 | Naira payments are not enabled on this deployment. | Hide the naira option. |
| `NOT_IMPLEMENTED` | 400 | The requested payment method (`NGN` commit) is not supported yet. | Use `USDC`. |
| `NOT_FOUND` | 404 or 400 | The referenced passkey, pool, transfer or anchor record does not exist. | Refresh the list; do not retry. |
| `FORBIDDEN` | 403 | The resource belongs to another user. | Do not retry. |
| `HTTP` | varies | A framework error raised with a plain string message. | Treat by status. |
| `INTERNAL` | 500 | Unexpected failure; it has been reported. | Retry later; contact support if it persists. |

Framework exceptions raised with a plain string (for example `NotFoundException('pool not found')`,
`UnauthorizedException('missing bearer token')`, `ForbiddenException('insufficient role')`) arrive in NestJS's
default shape, `{statusCode, message, error}`, where `error` is the status text (`Bad Request`, `Unauthorized`,
`Forbidden`, `Not Found`). Treat them by status.

## Sign-in, sessions and wallets

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `INVALID_PHONE` | 400 | The phone number is not a valid Nigerian number. | Ask the user to check the number. |
| `OTP_RATE_LIMITED` | 429 | Too many codes requested for this phone. | Wait before requesting another code. |
| `OTP_WRONG` | 401 | The code does not match. | Let the user try again. |
| `OTP_EXPIRED` | 401 | The code expired (5 minutes) or was already used. | Request a new code. |
| `OTP_LOCKED` | 401 | Too many wrong attempts for this code. | Request a new code. |
| `TOKEN_INVALID` | 401 | The access token is invalid or expired. | Refresh with `POST /auth/refresh`, then retry once. |
| `REFRESH_INVALID` | 401 | The refresh token is unknown or expired. | Sign in again. |
| `REFRESH_REUSED` | 401 | A rotated refresh token was replayed; the whole token family is revoked. | Sign in again. |
| `ACCOUNT_DISABLED` | 401 | The account is not active. | Show a support message. |
| `PASSKEY_CHALLENGE_INVALID` | 401 | The WebAuthn challenge expired, was used, or belongs to another user. | Start the passkey flow again. |
| `PASSKEY_INVALID` | 401 | The passkey registration or assertion did not verify. | Start the passkey flow again. |
| `PASSKEY_NOT_FOUND` | 401 | No passkey with that id is registered to this user. | Register a passkey first. |
| `PASSKEY_ALGORITHM_UNSUPPORTED` | 401 | The passkey does not use ES256 (P-256), which the smart wallet requires. | Register a different passkey. |
| `PASSKEY_KEY_INVALID` | 401 | The passkey's public key could not be decoded. | Register a different passkey. |
| `NO_WALLET` | 400 | The user (or the target user) has not bound a wallet. | Create or bind a wallet first. |
| `WALLET_EXISTS` | 401 | The account already has a wallet (passkey or device). | Use the existing wallet. |
| `WALLET_TAKEN` | 401 | That wallet is bound to another account. | Use a different wallet. |
| `USE_PASSKEY_WALLET` | 401 | A contract address was sent to the classic-wallet bind route. | Use `POST /wallets/passkey`. |
| `INVALID_ADDRESS` | 401 | The address is not a valid Stellar account. | Fix the address. |
| `CHALLENGE_EXPIRED` | 401 | The wallet challenge expired or was not requested. | Request a new challenge. |
| `BAD_SIGNATURE` | 401 | The signature does not match the wallet challenge. | Sign the challenge again with the right key. |

## Transactions and fee sponsorship

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `KEY_IN_USE` | 400 | The idempotency key belongs to another user. | Use a fresh, unique key. |
| `IN_PROGRESS` | 400 | A submit with this idempotency key is still running. | Retry the same request shortly; it returns the stored result. |
| `NOT_ALLOWED` | 403 | The contract function is not on the sponsorship allow-list. | Do not retry. |
| `UNKNOWN_CONTRACT` | 403 | The transaction targets a contract that is not part of this deployment. | Prepare the transaction through the API. |
| `CAP_REACHED` | 429 | The user hit their daily sponsored-transaction cap. | Try again tomorrow. |
| `NOT_PLAIN_TX` | 400 | The XDR is not a plain transaction (for example a fee bump). | Send the `txXdr` returned by prepare. |
| `BAD_SOURCE` | 400 | The transaction source is not the fee sponsor. | Send the `txXdr` returned by prepare, unmodified. |
| `BAD_OPS` | 400 | The transaction does not have exactly one operation. | Send the `txXdr` returned by prepare, unmodified. |
| `BAD_OP_TYPE` | 400 | The operation is not a contract invocation. | Send the `txXdr` returned by prepare, unmodified. |
| `BAD_FUNC` | 400 | The host function is not a plain contract call. | Send the `txXdr` returned by prepare, unmodified. |
| `FEE_TOO_HIGH` | 400 | The fee exceeds the relayer's maximum. | Prepare again. |
| `AUTH_MISMATCH` | 400 | An auth entry is not for a contract call, or does not match the invoked function. | Sign exactly the `authEntries` from prepare, in order. |
| `UNSUPPORTED_CREDENTIALS` | 400 | An auth entry uses credentials the relayer does not accept. | Sign with the user's wallet address credentials. |
| `WRONG_SIGNER` | 403 | An auth entry is signed by someone other than the user's wallet. | Sign with the bound wallet. |
| `SPONSOR_AUTH` | 403 | The transaction asks for the sponsor's authorisation. | Do not retry; prepare through the API. |

## Catalogue, pools and evidence

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `OFFER_INVALID` | 400 | The offer failed catalogue rules. The body carries `issues: string[]`. | Fix the listed problems. |
| `NOT_DRAFT` | 400 | Only draft offers can be edited or published. | Publish a new offer instead. |
| `EXPIRED` | 400 | The offer's `validUntil` is in the past. | Choose a new validity date. |
| `BAD_VALIDITY` | 400 | `validUntil` must be within 14 days. | Choose an earlier date. |
| `BAD_STATE` | 400 | The offer or naira transfer is not in a state that allows this action. | Refresh and check the state. |
| `KYB_REQUIRED` | 403 | Only verified suppliers can publish offers. | Finish supplier verification. |
| `FX_DIVERGENCE` | 400 | The naira rate sources disagree too much to price the offer. | Retry in a few minutes. |
| `NO_CLUSTER` | 400 | A market-only pool needs the organizer's market set first. | Set the market with `PUT /me/profile`. |
| `EVIDENCE_INVALID` | 400 | Evidence ids are unknown, not the caller's, or not uploaded yet. | Upload the files first, then retry. |
| `UPLOAD_INVALID` | 400 | The upload's type or size is not allowed. | Use an allowed file type and size. |
| `ALREADY_UPLOADED` | 400 | The upload slot was already used. | Request a new upload slot. |
| `IMAGE_INVALID` | 400 | The file could not be read as an image. | Upload a different file. |
| `VERIFICATION_BUSY` | 503 | The attestor's daily cap is reached; the check passed and will be finished later. | Show the "verification pending" state. |

## Naira payments

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `AMOUNT_OUT_OF_RANGE` | 400 | The naira amount is outside the anchor's limits. | Choose a different amount. |
| `FX_UNAVAILABLE` | 503 | No usable naira rate right now. | Retry later. |

## Development server only

These come from `/dev/*` routes, which do not exist in production.

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `FAUCET_UNAVAILABLE` | 400 | Friendbot could not fund the test account. | Retry later. |
| `BAD_TX` | 400 | The signed trustline transaction is not the expected one. | Sign the `trustlineXdr` returned by `faucet/start`. |
| `TRUSTLINE_FAILED` | 400 | The trustline transaction failed on-chain. | Retry the faucet. |
| `NO_ANCHOR` | 400 | No mock anchor is configured. | Configure the mock anchor. |
