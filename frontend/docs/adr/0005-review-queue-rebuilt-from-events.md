---
status: accepted
---

# The Review Queue is rebuilt from KYCRegistry events, not from a list held on-chain

`KYCRegistry` stores per-address mappings and nothing enumerable: given an address it will tell you whether that address is verified or pending, but it cannot tell you who is waiting. A Reviewer needs exactly the answer the contract cannot give. The Review Queue is therefore reconstructed off-chain in two steps: scan `KYCSubmitted` with the chunked log reader in [`chainLogs.ts`](../../src/lib/pepefi/chainLogs.ts) (which already handles the provider block-range cap and this chain's block time) to discover the universe of addresses that have ever applied, then read each address's current bucket live from the contract (`records()` / `pending()`) rather than from `KYCVerified` / `KYCRevoked` events. The live read side-steps a real trap: an address can cycle verified → revoked → verified again, and bucketing that history correctly from three separate event streams means taking the latest by block-and-log-index across all of them — one live read per address is simpler.

That said, "live read" is two separate `eth_call`s (`records()` and `pending()`), not one — a first implementation left them unpinned, so a state-changing tx landing between the two calls could make them observe different blocks and mis-bucket an address (e.g. a just-approved address briefly reading as `revoked`). Both calls now pass the same `blockTag` (the block number the scan itself is bounded by), so within one `refetch()` they are guaranteed to observe one consistent block — the two-calls-not-one shape stays, but the staleness window it could have opened is closed.

The obvious alternative — add an address array to the registry and redeploy — was rejected, and the redeployment itself is not the reason. `PerpetualExchange.setKycRegistry` and `PepeClaim` both point at the deployed instance, so a new registry means an owner-only migration on a live deployment; and every record already in the old one, including the demo and whale accounts seeded through `batchVerify`, would be gone. This system has already lost a day to one contract-address drift. Trading that for a data structure that a log scan reproduces is not a trade worth making.

## Considered options

**An off-chain database, recording submissions as the frontend sends them.** Rejected because it invents a second source of truth and immediately raises the question it cannot answer: when the database says pending and the chain says verified, which one is the queue? The chain is the registry; anything else is a cache pretending otherwise.

## Consequences

- The queue's address universe is only as complete as the range scanned. The page states the window it covered rather than presenting the list as exhaustive.
- **`batchVerify` is invisible to this queue, entirely — not just to the verified section.** It writes `records[user]` directly and never calls `submitKYC`, so no `KYCSubmitted` ever fires for those addresses; they never enter the discovered universe at all, in any bucket, even though `isVerified` returns true for them. The Reviewer's queue means "addresses that went through the review flow", and the page says so. `approveKYCBatch` is unaffected: every address in it went through `submitKYC` first, so each already has a `KYCSubmitted` on record.
- Reading the queue costs one multi-chunk log scan plus one contract read per discovered address, so it is a deliberate load-and-refresh, never a polling loop. The project already has an RPC-pressure problem; this page must not add to it.
