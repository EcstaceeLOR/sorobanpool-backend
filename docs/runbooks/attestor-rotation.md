# Runbook: attestor key rotation

The attestor key signs `registry.attest`, the only path that writes a user's verification hash and level on-chain (`src/verification/attestor.ts`). The registry accepts a signature only if `config.is_attestor(address)` is true, and `config.set_attestor(address, enabled)` is admin-only. The backend loads the key once at startup from `ATTESTOR_SECRET_REF` (`src/app/services.ts`). Rotation is therefore: add the new key on-chain, switch the backend to it, prove it works, then disable the old key.

Rotate on a schedule, whenever someone with access to the secret leaves, and immediately if the key may be exposed (see **Suspected compromise** below). Rehearse on testnet before doing it on mainnet.

## Before you start

- Admin key for the `config` contract (the `admin` in `deployments/<network>.json`), loaded in the Stellar CLI (`stellar keys ls`).
- Contract ids from `deployments/<network>.json` (`contracts.config.id`, `contracts.registry.id`).
- Access to the secret store that `ATTESTOR_SECRET_REF` points at, and permission to restart the API.
- Today's attestation count is well below `ATTESTOR_DAILY_CAP`: the cap counts every `attest` audit-log row for the UTC day regardless of which key signed it, so rotation does not reset it, and test attestations during rotation count towards it.

Throughout, `NET` is `testnet` or `mainnet`, `CONFIG` is the config contract id, and `ADMIN` is the CLI key name for the admin.

## Steps

1. **Generate the new key** and record its public key.
   ```sh
   stellar keys generate attestor-$(date +%Y%m%d) --network $NET
   NEW=$(stellar keys address attestor-$(date +%Y%m%d))
   ```
   The attestor account must exist on the ledger for its signature to be checked. On testnet: `stellar keys fund attestor-$(date +%Y%m%d) --network $NET`. On mainnet, send it the minimum balance from treasury. The attestor never pays fees; the sponsor is the transaction source (ADR 0001).

2. **Register it in `config`** while the old key is still enabled, so there is no gap.
   ```sh
   stellar contract invoke --id $CONFIG --source $ADMIN --network $NET -- set_attestor --a $NEW --enabled true
   stellar contract invoke --id $CONFIG --source $ADMIN --network $NET -- is_attestor --a $NEW   # expect: true
   ```

3. **Store the secret and switch the reference.** Put the new secret seed in the secret store under a new name (for example `ATTESTOR_SECRET_2026Q4`), then set `ATTESTOR_SECRET_REF` to point at it (`env:ATTESTOR_SECRET_2026Q4` with the current `env:` resolver). Keep the old secret where it is until step 6.

4. **Restart the API** so `buildServices` loads the new key. The worker processes do not attest, but restart them too if they share the env file.

5. **Verify attestation still works.** Run one KYC verification for a test user (`POST /v1/kyc/start`), then check:
   - The newest `AuditLog` row with `action = 'attest'` has a `data.tx` hash.
   - That transaction's auth entry is signed by `$NEW` (look it up on stellar.expert or with `stellar tx`).
   - `GET /v1/kyc/status` for the test user shows the new level.

   If any of these fail, stop and go to **Rollback**.

6. **Disable the old key.**
   ```sh
   stellar contract invoke --id $CONFIG --source $ADMIN --network $NET -- set_attestor --a $OLD --enabled false
   stellar contract invoke --id $CONFIG --source $ADMIN --network $NET -- is_attestor --a $OLD   # expect: false
   ```
   Then delete the old secret from the secret store and record the rotation (date, old and new public keys, operator) in the ops log.

Attestations already written by the old key stay valid: the registry stores the hash and level, not the signer.

## Daily cap and alerts during rotation

- The cap (`ATTESTOR_DAILY_CAP`, default 500) and the spike alert at 80% of it (`ATTESTOR_SPIKE_RATIO`) are computed from the audit log for the current UTC day, across both keys. Plan rotation for a quiet period, and keep verification runs in step 5 to the minimum.
- If the cap is reached mid-rotation, `/kyc/start` fails with `attestor daily cap of N reached` and the log shows `[attestor] ALERT daily cap N reached`. Either wait for the next UTC day or raise `ATTESTOR_DAILY_CAP` (also a restart), and lower it again afterwards.
- A `[attestor] ALERT n/N attestations today` line during rotation is expected only if your own test attestations pushed the count up; otherwise investigate before continuing.

## Rollback

Before step 6 the old key is still enabled, so rollback is just switching back:

1. Set `ATTESTOR_SECRET_REF` back to the old secret and restart the API.
2. Confirm with one attestation as in step 5 (signed by `$OLD`).
3. Disable the new key: `set_attestor --a $NEW --enabled false`, and delete its secret.

After step 6, re-enable the old key with `set_attestor --a $OLD --enabled true` first, then follow the steps above. Only do that if the old key was rotated on schedule, never if it was rotated because it may be exposed.

## Suspected compromise

Do step 6 first for the exposed key (disable it), so the window is as short as possible, then do steps 1 to 5 with a fresh key. Attestations stop until the new key is live; that is the intended failure mode. Review `attest` rows in the audit log from the exposure window and use the admin `registry.revoke` for any that were not issued by the KYC flow.
