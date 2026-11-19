# 0009 Refunds are pull-first, with keeper pushes as the backstop

**Context.** Brief 14.4 leaves the refund default open: push (the system sends every member their refund) or pull (each member claims their own). A pool owes refunds in two situations: a final pool that did not deliver (`Expired`, `Failed`, `Cancelled`: everything back), and a `Settled` pool whose final tier price is below what members paid (the difference back). Members are market traders on phones, often offline, many of whom will never open the app again once the goods are picked up. The backend cannot move escrowed funds (architecture.md); only the `group_buy` contract can.

**Decision.** Both paths exist, and neither depends on the other:

- **Pull.** A member claims their own refund at any time after the pool is final: `POST /pools/:id/refund/prepare` builds `group_buy.claim_refund(member, pool_id)` (`src/app/pools.controller.ts`), the member signs the auth entry, and `/tx/submit` sends it. This is the default the product promises in the app ("Refund of N… is ready in the app").
- **Push.** The keeper (`src/keeper/jobs.ts`, job `push-refunds`) calls `group_buy.push_refunds(pool_id, PUSH_REFUND_BATCH)` for every final pool that still holds escrow (`hasUnclaimedRefunds`: final state, `refundsPushed = false`, `escrowBalance > 0`). Each call refunds up to `PUSH_REFUND_BATCH = 25` members who have not claimed. When the contract reports nothing left (return value `0`), the runner sets `pool.refundsPushed = true` (`src/workers/runners.ts`, `keeperChain`) and stops scanning the pool. A final pool whose indexed escrow is already zero is marked the same way at the start of every tick (`keeperTick`).

The contract is the arbiter for both paths and decides who is still owed what; the backend only asks. Either path emits the same `group_buy.refund` event, which the indexer applies to the member's `refundClaimed` and the pool's escrow (`src/indexer/projector.ts`), so the read model does not care which path paid.

**Why a batch of 25.** One `push_refunds` invocation is one Soroban transaction, and every refunded member costs a token transfer plus writes to that member's commitment entry. Soroban caps the CPU instructions, ledger entries read and written, and event bytes per transaction, so an unbounded loop over a large pool would exceed the limits and fail as a whole. 25 keeps one call well inside those limits for the largest pools the catalogue allows, while still clearing a typical pool in a few keeper ticks (every 15 s by default). It matches `ALLOCATE_BATCH`, which faces the same limits for shortfall allocation. If the contract's per-member cost changes, re-measure against the network's resource limits before raising it.

**Alternatives considered.**

- *Pull only.* Simplest and cheapest, but refunds would sit unclaimed for members who never return, and the app's promise that "you get everything back automatically" would not hold.
- *Push only, all at once.* One transaction per pool, but it would breach Soroban per-transaction limits on large pools and fail entirely; a single malformed member entry would block every other refund in the pool.
- *Push per member (one transaction each).* No resource risk, but N transactions per pool, all paid by the fee sponsor, for no benefit over a bounded batch.

**Consequences.**

- Members who claim early get their money at once; everyone else is paid within a few keeper ticks of the pool going final, with no action needed.
- The sponsor pays for push batches. Members who pull save the sponsor that cost.
- Keeper actions are idempotent (ADR 0002): a duplicate or early `push_refunds` is refused by the contract and counted as `refused`, not as an error.
- **Failure modes.**
  - *Keeper down:* refunds wait, but nothing is lost; pull still works, and the keeper resumes from the read model when it restarts.
  - *Indexer behind:* the keeper may push for a pool the contract has already emptied; the contract returns `0` or refuses, and the pool is marked `refundsPushed` on the next tick.
  - *Contract refuses a batch* (for example a member's token account cannot receive): the action is logged by `runKeeper` and retried on every tick. A pool that never drains shows up as persistent `push-refunds` errors in the keeper log and needs an operator to look at that member's entry.
  - *Sponsor drained:* pushes stop with the rest of the product (paged by the maintenance job); pull also needs the sponsor, so both wait for a top-up.
