# Runbook: contract TTL (ttl-extend)

Contract instances and wasm code are not extended by contract calls (contracts ADR 0005). The `ttl-extend` job (`startTtlKeeper`, hourly) extends each contract's instance and code with `ExtendFootprintTtl` when under ~20 days remain.

## Coverage (as of #94)

| Entry kind | Source | Cadence |
|---|---|---|
| Core contract instances + code | `CONTRACT_NAMES` in deployments | Every run |
| Shared smart-wallet code | `smartWallet.wasmHash` in deployments | Every run |
| User wallet instances | `user.walletAddress` paginated (`WALLETS_PER_TTL_RUN=25`) | Rotates through all wallets |
| Bond contract instances | `bond.supplierAddress` paginated (`BONDS_PER_TTL_RUN=20`) | Rotates through all bonds |
| Open dispute data entries | `dispute.id` via `disputeDataKeys()` | Requires `keepAlive` extension (see below) |

## Dispute data entries

Each open dispute stores persistent contract-data entries inside the `disputes` contract. `ttl.ts` exports `disputeDataKeys(disputeContractId, ids)` to build the ledger keys; wiring it through `chain.keepAlive` is the next step. Until then the job logs the open count and the disputes contract *instance* is kept alive by the core-contract sweep.

## Alerts

- **`ttl-extend ALERT wallet entries not found`**: wallet instance missing from RPC (archived?). Restore with `RestoreFootprint`, then verify `walletAddress` in DB. Page-level.
- **`ttl-extend ALERT bond entries not found`**: bond contract instance missing (supplier off-boarded?). Restore if still active; remove from `bond` table if not. Page-level.
- **Cost**: extending code is real rent paid by the sponsor. Each core contract needs extension every ~40 days. Include it in the sponsor-balance alert (see `docs/runbooks/sponsor-account.md`).

## Manual run

Call `chain.keepAlive(addresses)` from a maintenance script; a second call immediately after should extend nothing.
