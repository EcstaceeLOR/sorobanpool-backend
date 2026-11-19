# Runbook: sponsor account top-up, rotation and compromise

The sponsor account is the **source of every transaction** and pays every fee ([ADR 0001](../decisions/0001-sponsor-as-transaction-source.md)).
Users never hold XLM, so a drained or revoked sponsor stops the whole product: no commit, refund, dispute or
settlement can be submitted.

Where it lives in the code:

| What | Where |
| --- | --- |
| Key loading | `SPONSOR_SECRET_REF` → `resolveSecret` (`src/config/secrets.ts`), read once at startup in `src/app/services.ts` |
| Balance check | `checkSponsor` (`src/workers/maintenance.ts`), run every 5 minutes by `startMaintenance` |
| Alert threshold | `SPONSOR_MIN_XLM` (default 100) |
| What it will pay for | `SponsorshipPolicy` (`src/relayer/allowlist.ts`): contract function allow-list and per-user daily cap |
| Guard against abuse | `inspectUserTx` (`src/chain/inspect.ts`): refuses source-account credentials and fees above 5 XLM |
| Fee bump (whole-transaction wallets) | `feeBump` (`src/relayer/fee-bump.ts`) |

Commands below use the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) and `curl`. Replace `$HORIZON_URL`
and `$SPONSOR` (the sponsor's `G...` address, logged as `chain.sponsorAddress`).

## 1. Check the balance and runway

```sh
curl -s "$HORIZON_URL/accounts/$SPONSOR" | jq -r '.balances[] | select(.asset_type=="native") | .balance'
```

- The worker logs `[maintenance] ALERT sponsor balance <n> XLM is below <SPONSOR_MIN_XLM>` when it is low. Treat it as a page.
- Runway: `runwayDays(balance, avgDailySpend)` in `src/relayer/fee-bump.ts`; aim to keep more than 7 days.
- Rent for contract TTL extension is also paid by the sponsor (see [ttl-extend](ttl-extend.md)); include it in the budget.

## 2. Top up

1. Send XLM to `$SPONSOR` from the treasury account (a normal payment; the sponsor's key is not needed).
   ```sh
   stellar tx new payment --source treasury --destination "$SPONSOR" --asset native --amount <stroops> --network <network>
   ```
   On testnet only, Friendbot also works: `curl "https://friendbot.stellar.org/?addr=$SPONSOR"`.
2. Re-run the balance check above and confirm the new balance.
3. Wait for the next maintenance tick (at most 5 minutes) and confirm the `ALERT sponsor balance` line stops.

No restart is needed: the balance is read from Horizon on every check.

## 3. Rotate the sponsor key (planned)

The sponsor address is baked into every transaction the API prepares, and `inspectUserTx` refuses a transaction
whose source is not the current sponsor. Rotation therefore invalidates prepared-but-unsubmitted transactions; clients
re-prepare and retry. Do it in a quiet window.

1. Create and fund the new key (keep the old one funded until step 6):
   ```sh
   stellar keys generate sp-sponsor-next --network <network>
   stellar keys address sp-sponsor-next      # new G... address
   ```
   Fund it as in section 2 with at least a week of runway.
2. Store the new secret in the secret manager entry that `SPONSOR_SECRET_REF` points to (today only `env:NAME` is
   implemented; in development `export SPONSOR_SECRET=$(stellar keys show sp-sponsor-next)`).
3. If the attestor shares the sponsor key (allowed locally, `ATTESTOR_SECRET_REF=env:SPONSOR_SECRET`), the attestor
   key changes too and must be re-registered on the registry contract first; follow the attestor rotation runbook.
   In production keep them separate.
4. Restart **every** role (api, worker, indexer). The key is read once at startup, and the worker's keeper and
   maintenance jobs also submit as the sponsor.
5. Verify the relayer (section 5).
6. Move the remaining XLM from the old account to the treasury, then delete the old secret. Keep the old address in
   the incident log; transactions in history will still show it as the source.

## 4. Suspected compromise

The sponsor key can only spend its own XLM (it is never a signer for user funds or escrow), but an attacker can
drain it and so halt the product. Speed matters more than tidiness.

1. **Pause sponsorship.** There is no runtime switch for the relayer yet. Stop `POST /v1/tx/submit` at the edge:
   block the route at the load balancer / ingress, or scale the `api` role to zero. Also stop the `worker` role
   (keeper and maintenance submit as the sponsor) and any process with `KEEPER_EMBEDDED=true`.
   Do **not** use the `config` contract's `pause`: it halts the protocol for users, and it is never sponsored anyway.
2. **Drain what is left** to the treasury with the compromised key, before the attacker does:
   ```sh
   stellar tx new account-merge --source sp-sponsor-compromised --account <treasury G...> --network <network>
   ```
   (Or a payment of the balance minus the reserve if you need to keep the account.)
3. **Rotate** as in section 3 with a fresh key that never touched the compromised host.
4. **Restore service:** unblock the route, start the roles, verify (section 5).
5. **Investigate:** list what the old key signed since the suspected time,
   `curl -s "$HORIZON_URL/accounts/<old G...>/transactions?order=desc&limit=200"`, and compare with `SponsorUsage`
   rows and API logs. Anything not matching a `tx/submit` or a keeper job is attacker activity. File it under
   SECURITY.md.

## 5. Verify the relayer afterwards

1. `GET /v1/health` returns 200 on every role.
2. The API logs show the expected sponsor address at startup, and `curl "$HORIZON_URL/accounts/$SPONSOR"` shows a
   balance above `SPONSOR_MIN_XLM`.
3. Submit one sponsored action end to end on the target network (for example `registry.register` or a small
   `group_buy.commit` from a test user) and confirm the transaction hash on an explorer has the **new** sponsor as
   source and fee account.
4. No `ALERT sponsor balance` line after the next maintenance tick, and no `SponsorshipError` spikes in the API logs.

## Testnet dry run

The issue asks for a recorded testnet dry run. That needs a running stack and a funded testnet key, which were not
available when this runbook was written; record the outputs of sections 2, 3 and 5 here on the first rehearsal.
