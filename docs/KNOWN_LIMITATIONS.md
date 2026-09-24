# Known Limitations

Written for the project report. Every item here was verified against the code on
2026-07-27, not assumed. Where something was fixed, the fix is named; where it
was not, the reason is given rather than glossed over.

## Status at a glance

| # | Limitation | Status |
|---|---|---|
| 1 | V1 contracts do not use SafeERC20 | **Mitigated** — V2 uses SafeERC20; the UI now defaults to V2 |
| 2 | `PerpetualExchange.oracle` is immutable | **Mitigated** — keeper relays the on-chain feed |
| 3 | Oracle is a single owner key | **Mitigated** — GuardedOracle + V2 `setOracle` |
| 4 | No third-party security audit | **Open** — Slither + Aderyn + invariants; audit still required |
| 5 | Mock stablecoins have unrestricted `mint` | **By design** (testnet only) |
| 6 | AssetVault is not fully collateralized | **By design** — bounded in V2 |
| 7 | Contract tests never ran in CI | **Fixed** |
| 8 | Two payout contracts had zero tests | **Fixed** |
| 9 | Batched chain reads blanked pages | **Fixed** |
| 10 | Agent sessions had no asset restriction | **Fixed and live on Base Sepolia** |
| 11 | V2 vault: no reentrancy guard, unbounded asset registry | **Fixed** |
| 12 | Frontend type escapes (`any`) | **Reduced 42 → 19**; rest is library typing |
| 13 | All 6 roles on one deployer key | **Mitigated** — separated 2026-07-27; multisig + revoke still open |
| 14 | x402 revenue split is an on-chain tx inside the paid request | **Fixed** — ledger + single-signer batch worker; caveats below |
| 15 | `maxTimeoutSeconds` is advertised, not enforced | **Configured** (60s); facilitator does not enforce an upper bound |
| 16 | Public facilitator: unknown rate limit, errors surfaced as 500 | **Partly fixed** — verify-phase errors now 429/502; limit still unknown |
| 17 | No KYT/KYA screening of counterparty addresses | **Open** — not implemented, budget sketched |
| 18 | No latency / success-rate acceptance thresholds | **Partly measured** — facilitator + 402 challenge measured; paid path not |
| 19 | No self-hosted facilitator; x402.org pays the settlement gas | **By design (testnet)** — no SLA, no visibility into its wallet |
| 20 | On-chain revenue totals cannot separate demo self-payments from external ones | **Open** — documented; needs an event scan |

---

## 1. V1 contracts do not use SafeERC20

40 of 49 ERC-20 calls across `contracts/src/` ignore the return value; the other
9 wrap it in `require(...)`. Neither is safe against real-world tokens.

The usual explanation — "some tokens return false instead of reverting" — is
only half of it. Mainnet USDT's `transfer` returns **nothing at all**. Calling it
through an interface declaring `returns (bool)` reverts while decoding empty
return data, so `require(token.transfer(...))` fails even when the transfer
would have succeeded.

`contracts/test/v2/AssetVaultV2SafeERC20.t.sol` builds a void-return token and
demonstrates both halves: V2 completes a mint and redeem against it, V1 reverts.

**Why V1 is not patched:** V1 is deployed on Sepolia with live positions.
Changing its source would not change the deployed bytecode, so the code would no
longer describe what is running. Redeploying would destroy existing positions.
V2 carries the fix; V1's gap is documented here.

**What was done instead.** `TokenizedAssetsPage` now defaults to V2 on any chain
where the V2 stack is deployed, so V1 is something a reader opts into rather than
the path a new user lands on. Selecting V1 raises a warning naming the missing
protections and stating that deployed bytecode cannot be changed. V1 stays
reachable because the comparison is the point: the two vaults sitting side by
side on the same chain is the clearest evidence of what the hardening actually
changed. On testnet the gap does not fire — MockUSDC and MockUSDT both revert on
failure, which is the well-behaved case V1 assumes.

## 2. `PerpetualExchange.oracle` is immutable — mitigated by relay

```solidity
IOracle public immutable oracle;   // PerpetualExchange.sol:79 — set once, no setter
```

The Chainlink, Pyth, and Aggregator adapters are deployed and queryable, but
cannot be wired into the trading engine without redeploying the exchange, which
would destroy all open positions. `AdminOraclePage` therefore shows a read-only
three-source price comparison and states plainly that the engine runs on
MockOracle. Nothing in the UI claims the adapters are connected.

**The relay.** The exchange cannot be *pointed at* the adapters, but it can be
*fed by* them. Set `RELAY_SOURCE` (or `KEEPER_RELAY_SOURCE`) to the aggregator
address and `agent/keeper/run.ts` reads the on-chain feed and writes that price
into MockOracle, falling back to the public price APIs only for assets the
adapters do not cover (most equities on testnet). The exchange then settles on
Chainlink/Pyth data at one remove.

Be precise about the deployment status too: **the relay has never been switched
on in CI.** Neither keeper workflow sets `RELAY_SOURCE`, so both chains are
currently fed from the public APIs. The code path exists and is wired; the
configuration is not. Turning it on is a workflow env change, not a code change.

Be precise about what that is: a **trusted relay, not a trustless integration**.
The keeper key can still write whatever it likes. It removes the dependency on a
centralised exchange API, not the dependency on the keeper. Direct integration
still requires redeploying the exchange, which would destroy every open
position.

## 3. Oracle is a single owner key — mitigated, not eliminated

`MockOracle.updatePrice` is `onlyOwner`: one compromised key can set any price
and drain everything downstream. `GuardedOracleTest` keeps that as a baseline
test so the difference is measurable.

`src/v2/GuardedOracle.sol` is a drop-in replacement (same
`getPrice(bytes32) -> (price, updatedAt)`) that bounds it:

- N keepers instead of one owner
- a per-update deviation cap — a compromised keeper cannot crash or spike the
  price, only nudge it
- rejection rather than clamping, because a clamped price is a fabricated number
  the reader cannot detect
- an optional reference source (the Chainlink/Pyth aggregator) that posts must
  agree with
- per-asset freeze and global pause, held by a separate guardian role
- admin role transferable to a multisig behind a timelock

`AssetVaultV2.setOracle` lets the tokenized layer migrate to it in one
transaction — its oracle is ordinary storage, unlike the exchange's.

**What this does not achieve:** keepers remain trusted. A patient attacker can
still walk the price in legal steps, and there is a test named for exactly that
(`test_attackerCanStillWalkPriceGradually`). This converts "one key can do
anything instantly" into "one key can do a little, slowly, and visibly".
Custody-grade pricing still needs a decentralized feed as the reference source.

## 4. No third-party security audit

None of the contracts has been audited, and nothing here substitutes for one —
an audit is third-party by definition. What has been automated:

- **Slither** runs on every contracts change in CI (reporting mode; tighten
  `fail-on` once findings are triaged)
- **Invariant tests** — `AssetVaultV2Invariant.t.sol` drives randomised
  sequences of mint, redeem, price moves, and time warps, checking five
  properties across 128,000 calls: fees are never counted as redeemable
  collateral, the vault always covers what it owes the operator, tracked
  exposure equals real token supply, exposure never exceeds the cap, and
  registration stays within its ceiling.

- **Aderyn** (Cyfrin, v0.6.8) run against `src/v2/` on 2026-07-27 as a second
  static-analysis engine — it overlaps Slither but does not duplicate it.
  1 High and 12 Low. The High and the two Low findings that could have mattered
  are false positives here, triaged individually in
  `docs/audit/ADERYN_TRIAGE.md` with reasoning rather than dismissal; raw output
  in `docs/audit/aderyn-v2-report.md`.

Unit tests check the cases we thought of; invariants check the ones we did not.
An auditor will still find things neither does.

The clearest evidence for that last sentence is our own: the fee accounting error
CI caught on 2026-07-27 was found by an invariant test, and neither Slither nor
Aderyn would have flagged it — the code was internally consistent and locally
correct, just wrong about a quantity. Static analysis finds a class of bug. This
was a different class, and there are classes neither tool nor test covers.

## 5. Mock stablecoins have unrestricted `mint`

`MockUSDC.mint` and `MockUSDT.mint` are callable by anyone, deliberately, so
testnet users can fund themselves. These must never be deployed to a network
carrying value.

## 6. AssetVault is not fully collateralized

The vault is the counterparty to every long. V2 does not change that — it bounds
it with per-asset caps, prices it with fees, and blocks new mints before the
reserve is exhausted. Full treatment, including the tests that pin each claim,
is in [RISK_MODEL.md](RISK_MODEL.md).

---

## Fixed on 2026-07-27

**7. Contract tests never ran in CI.** A workflow existed at
`contracts/.github/workflows/test.yml`, but GitHub Actions only reads the
repository root, so it never executed — the repo looked like it had CI where it
did not. Deleted, and replaced with `.github/workflows/contracts-ci.yml` and
`frontend-ci.yml`, both confirmed passing.

**8. Two payout contracts had zero test coverage.** `EsgRewardDistributor` and
`PepeClaim` both hand out tokens and neither was imported by any test. 22 tests
added covering double-claim, ownership, ESG threshold gating, per-claim caps,
dry pools, KYC gating, and the claimed flag surviving KYC revocation.

**9. Batched chain reads blanked pages.** A `try/catch` around a whole
`Promise.all` loses every value in the batch when any one read fails.
`DashboardPage` batched positions, margin, balance, and TraderStake together —
and TraderStake is `0x0` on chains where it isn't deployed, so one guaranteed
failure emptied the dashboard. `safeRead` was moved from a single page into
`src/lib/pepefi/safeRead.ts` and applied to the batches that blank a view.

**10. Agent sessions had no asset restriction.** `AgentSessionManager` capped
per-trade margin, total budget, and leverage — all of which bound how much an
agent can lose, none of which bound *what* it trades. A budgeted agent could put
the entire allowance into an asset the user never intended to hold.

Added a per-session allow-list: `createSessionWithAssets`, `setSessionAssets`,
`isAssetAllowed`, `allowedAssets`, `allowedAssetCount`, enforced in
`openPositionForSession`. Only the session owner can change it — an agent that
could widen its own permissions would make the list decorative.

Deliberately opt-in: an empty list means unrestricted, so `createSession` and
every session already created behave exactly as before. The existing
AgentSessionManager test suite passes unchanged, which is the evidence for that.

**Live on Base Sepolia as of 2026-07-27.** Redeployed to
`0x4E7cC1B79B72ab72531a6C790e14304370f70764` via
`script/DeployAgentSessionManager.s.sol`, which deploys only the session manager
against the existing exchange — running the full `Deploy.s.sol` would have
destroyed every open position.

Verified on chain rather than assumed: the new manager is bound to the live
exchange, is authorized via `authorizedAgents`, and demo session 0 allows sBTC
and sETH while returning `false` for sAAPL and sTSLA.

The previous instance `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8` is untouched
and its 13 sessions remain readable, but it has no asset gate.

**Correction (2026-08-06).** The line that used to sit here — "Frontend
(`sessionManager.ts`) and `agent/.env` both point at the new address" — was only
half true. `agent/.env.example` and the hardcoded fallback in `agent/x402_agent.ts`
still named the **old** manager, and every agent entry point defaulted to
`DEMO_SESSION_ID=6`. Session ids are per-manager: the new manager has only `#0`
(`nextSessionId` reads 1), while `#6` exists solely on the old one. So the two
halves of the configuration disagreed, and anyone who followed this document and
switched the address would have pointed an agent at a session that does not
exist.

Now aligned on the new manager with `DEMO_SESSION_ID=0`. Verified on chain
2026-08-06: session 0 is unrevoked, expires 2027-07, caps at 1000 per trade /
3000 budget / 5× leverage, allows exactly `sBTC` and `sETH` and returns false for
`sAAPL`; the manager is bound to the live exchange and `authorizedAgents` returns
true for it.

**11. V2 vault hardening.** Four defects found reviewing my own V2 work, all in
code not yet deployed. The one that mattered: `mint()` prices every active asset
via `reserveRatioBps()`, and registration was unbounded — an operator onboarding
markets would make mint progressively more expensive until it exceeded the block
gas limit, bricking their own vault by using the product as intended. Now capped
at `MAX_REGISTERED_ASSETS` with `unregisterAsset` to free slots, which refuses
while tokens are outstanding so holders cannot be stranded. Also added
`nonReentrant` on the four state-changing functions, a storage `__gap`, and a
dedicated `AggregatorOracleAdapter` suite (it would front Chainlink and Pyth in
production and had none).

**12. Frontend type escapes.** 42 `any` casts reduced to 19. Removed
`catch (e: any)` throughout (`prettyError` already accepts `unknown`), replaced
`(log as any).args` with ethers' `EventLog`, and dropped seven
`(window as any).ethereum` casts in favour of the `declare global` block that
already existed in `useWallet.ts`. That last change surfaced a latent conflict
hidden by a stale `tsbuildinfo` — the casts had been suppressing type checking
for everything downstream in those files.

The remaining 19 are MUI `sx`, recharts formatter callbacks, and template code,
where the upstream types are genuinely loose. Not worth contorting around.

## 13. All six roles sat on one deployer key — separated 2026-07-27

**Done:** admin, keeper, guardian, and risk now sit on four distinct keys on both
GuardedOracle and AssetVaultV2. Each was exercised against Sepolia before being
relied on: the guardian key paused and unpaused the vault, the new keeper key
posted a price (which also cleared a live staleness fault), and a $1 post against
a $73,468 sBTC reverted `DeviationTooLarge` with the stored price unchanged.
Addresses and the full verification log are in
[ROLE_SEPARATION.md](ROLE_SEPARATION.md).

**Still open, and it matters:** the admin is a fresh single-purpose EOA, not a
multisig. That is better than the deployer key — which also holds funds and every
other role — but one key is one key. A compromised admin can still widen the
deviation cap, repoint the oracle, or upgrade the vault. The cap bounds a
compromised keeper; nothing bounds a compromised admin. The fix is a Safe 2-of-3
across the team, free on Sepolia, blocked only on collecting two teammate
addresses. A multisig with one signer is not a multisig, so the interim EOA is
described as what it is rather than counted as the fix.

**Also still open:** the deployer has not been revoked. Deliberate — the new
keeper key is not yet in GitHub Actions, so revoking now would stop the price
feed. Until it is revoked the deployer remains a single point of compromise for
both contracts, so the separation above is real but not yet exclusive.

The original gap, for the record: both contracts held admin, keeper, guardian,
risk, and pauser all on `0xE80A8136…Eb93`.

`script/HandoverRoles.s.sol` performs the separation in the only safe order —
grant, verify on chain, then revoke with admin last — and reverts
`WouldLeaveNoAdmin` rather than proceeding if the replacement admin is not
confirmed. `test/v2/RoleHandover.t.sol` performs the mistake deliberately and
asserts that a contract left with zero admins can never grant a role or be
upgraded again.

Procedure in [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md).

---

## x402 payment layer (added 2026-09-17)

Items 14–20 cover `agent/signal-api`. Everything stated as measured was measured
on 2026-09-17 with `agent/signal-api/scripts/probe-facilitator.ts`, from a client
in Taiwan. The Vercel function runs in `sin1`, so its round-trip to the
facilitator will differ from these figures. They are an order of magnitude, not
an SLA.

## 14. The 70/20/10 revenue split is an on-chain transaction inside the paid request — fixed with a ledger + single-signer worker

**What it was.** `GET /signals/:trader` and `GET /oracle/:asset` called
`settleRevenue()` before responding: balance → allowance → (approve) →
`FeeRouter.routeExternalRevenue`, awaiting each receipt. Three problems, the
third found while verifying this entry:

- **Latency.** The response was bound to block confirmation (≥ 2 s).
- **Nonce collisions across instances.** `settlement.ts` serialised settlements
  with an in-process promise chain. Vercel runs several instances sharing one
  `FEE_SETTLEMENT_PRIVATE_KEY`, and in-process serialisation cannot coordinate
  across them.
- **Ordering.** In x402-hono 0.5.3 the route handler runs *before* the
  facilitator's `/settle`. If `/settle` then failed, the buyer got a 402 and was
  not charged, but our revenue split had already gone on-chain.

**What changed.** The handlers no longer call `settleRevenue()` at all. They
call `c.set("ledgerEntry", { trader, feeUsd, at, source })` and return their
data immediately (`agent/signal-api/src/app.ts`). A middleware wrapping
`paymentMiddleware` reads that entry back out *after* `next()` returns, checks
whether the response carries `X-PAYMENT-RESPONSE` (x402-hono only sets this
when the facilitator's `/settle` succeeded), and only then pushes the entry to
a queue (`agent/signal-api/src/ledger.ts`). If the facilitator settle fails,
x402-hono replaces the response with a 402 before our middleware's check runs,
so the entry is never read and nothing is queued — **that is the ordering fix**:
recording moved from "before we know if payment succeeded" to "after".

A separate script, `agent/signal-api/src/settlement-worker.ts`, drains the
queue and is the only thing that ever calls `routeExternalRevenue`. It runs as
a single process on a cron trigger (`.github/workflows/x402-settlement-worker.yml`,
`*/10 * * * *`, `concurrency: cancel-in-progress: false` so overlapping runs
queue rather than run concurrently). **With exactly one process ever holding
`FEE_SETTLEMENT_PRIVATE_KEY`, the cross-instance nonce collision is eliminated
by construction**, not just made less likely.

**Queue: Upstash Redis, chosen and not measured against alternatives.** The
project had no persistent store at all. Upstash's REST API needs no persistent
TCP connection, which matches Vercel's serverless functions — each push/pop is
one HTTPS call, the same shape the codebase already uses for the facilitator
and price feeds. The alternative considered and rejected was a file committed
to the repo via the GitHub API: no new service, but committing on every paid
request would collide with the bundle-fingerprint check in
`check-vercel-bundle.mjs` and rate-limit against GitHub's own API. Vercel
KV/Postgres were not evaluated in depth; Upstash was picked for the REST-only
property and free tier, not because the others were tested and found worse.

**Retry and failure.** Three lists: `x402:settlement:queue` (new entries, FIFO
via RPUSH/LPOP), `x402:settlement:retry` (entries that failed at least once,
processed first on each run), `x402:settlement:dead` (failed
`SETTLEMENT_MAX_RETRIES`, default 5, times — needs a human). Each run processes
up to `SETTLEMENT_BATCH_SIZE` (default 25) retry entries, then up to the
remaining budget of new entries. If more than `SETTLEMENT_MAX_FAIL_PCT` (default
30%) of what it processed failed, the script exits non-zero and the workflow
run is red — the same convention `base-sepolia-keeper.yml` already uses for
feed writes, applied here to settlement.

**What `settled` means now.** It used to mean "this transaction hash exists
on-chain." It now means "queued; a worker will attempt it." A response can say
`settled: true` and the on-chain transfer can still fail later and end up in
the dead-letter list — the response is written before the worker ever runs.
`GET /` states this in `revenueModel`.

**Tested offline, not on testnet — and the first version of this test was
wrong.** The recording decision lives in `applyLedgerRecording()`, a pure
function exported from `app.ts`: `(ledgerEntry, response) → response`. It reads
nothing but its arguments and touches no contract, no provider, no `ethers`
code at all — `ledgerFlow.test.ts` tests it directly with hand-built `Response`
objects (a stub Upstash server behind it, to also prove the actual RPUSH
happens). It checks: no entry → passthrough; entry but no
`X-PAYMENT-RESPONSE` (facilitator settle didn't succeed) → not recorded; settle
succeeded + ledger configured → exactly one queue entry with the right fields,
`settled:true`; ledger not configured → data still returned, `settled:false`,
`settleError` names the missing env; the Upstash write itself failing → same,
data still returned, error surfaced rather than swallowed.

The first version of this test went through the real `/signals` and `/oracle`
handlers with a real (stub-driven) facilitator and asserted `200`. It passed
locally and failed in CI — `getTraderPerformance`/`getOracleSnapshot` need a
live Base Sepolia RPC to return real position/oracle data, and it only worked
locally because this machine's `agent/.env` happened to have a working RPC URL
already set from unrelated local dev. `agent-ci.yml` has no RPC configured
(deliberately, per its own header comment: the point of that workflow is tests
that need no keys and touch no network), so any request through those handlers
always failed with 400 before the facilitator or the ledger were ever reached.
The extraction above is the fix: it moved the thing actually being tested (the
recording *decision*) out from behind the thing that can't run offline (the
trading data fetch), instead of trying to fake a Base Sepolia RPC.

`settlementWorker.test.ts` drives the retry → dead-letter transition directly,
without `FEE_SETTLEMENT_PRIVATE_KEY` set, so `settleRevenue` fails
deterministically with `"settlement disabled"` — no chain reachability needed
there either. **Neither test has run against a live queue or a live signer.**
As of this writing the GitHub Actions workflow has the four secrets it needs
(`FEE_SETTLEMENT_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`) but has not executed in production — GitHub
Actions' `workflow_dispatch` API refuses to run a workflow that only exists on
a feature branch (`HTTP 404: workflow ... not found on the default branch`),
so the first real run will be either the first scheduled tick after this PR
merges to `master`, or a manual dispatch right after that merge. A local run of
`settlement-worker.ts` against the real Upstash instance and the real
`FEE_SETTLEMENT_PRIVATE_KEY` signer did succeed (2026-09-17): it connected,
read an empty queue, and exited 0 — the credentials work, there was just
nothing to settle yet, since the deployed API is still running the pre-ledger
code until this merges.

**Left open:**

- **Cron cadence is best-effort**, like the price keeper workflows. An entry
  can sit in the queue for well over 10 minutes before being drained, and
  §18's "settlement success" acceptance metric still has no data source until
  the worker actually runs.
- **The retry backoff is "next cron tick," not exponential.** A transient RPC
  failure and a permanent one (e.g., wrong `X402_FEE_ROUTER`) are retried
  identically until the attempt count runs out.
- **The dead-letter list is not surfaced anywhere a human would see it**
  without checking Upstash directly or reading workflow logs; the workflow
  only turns red, it doesn't say why in a way that reaches a dashboard.
- **`settlement.ts`'s own in-process queue** (the promise chain that used to
  serialise per-instance settlement) is still there, now serialising calls
  *within* the single worker process. It's redundant now that the worker
  already processes entries in a sequential loop, but harmless, so it was left
  rather than touched for its own sake.

**On-chain evidence of the old ordering.** Before the ledger change, the x402
FeeRouter recorded two routes for external buyer `0x858b36C7…0bA972` on
2026-07-15: `routeExternalRevenue` at 13:08:30 and 13:12:12 UTC, the buyer's
`transferWithAuthorization` at 13:08:34 and 13:12:16. **The split landed four
seconds before the payment it was splitting** — exactly the ordering described
above. Both routes also used trader `0x0`, so their 70% (2 × $0.007 test USDC)
sits in `traderEarnings[address(0)]` and can never be withdrawn. The zero-address
check in `app.ts:577-586` now blocks that input on `/signals`; `FeeRouter` itself
still accepts it.

**Where the split's money comes from.** It is still not the buyer's payment
moving through the router. The facilitator settles the buyer's USDC into `payTo`
(per `.env.example:21-25`, the treasury EOA that also holds
`FEE_SETTLEMENT_PRIVATE_KEY`). Later, the worker calls `routeExternalRevenue`,
which `safeTransferFrom`s an equal amount out of that same wallet
(`FeeRouter.sol:129`, `settlement.ts:116`). The amounts match and the order is
now correct, but it is two transactions minutes apart, not one atomic route.
If `PAY_TO` is ever set to an address other than the settlement wallet, the
worker pays the split from a balance the buyer never touched.

**2026-09-23:** evidence and funding source recorded. No code change: the
ordering was already fixed on 2026-09-17, and making the route atomic is a
`NEXT_STEPS.md` item, not a patch.

**What batching did not fix, because it can't from our side.** The facilitator
step is untouched: x402-hono still awaits the facilitator's `/settle`, which
waits for the `transferWithAuthorization` receipt, before releasing the
response. A paid x402 v1 `exact` request still cannot come back faster than one
Base block through this middleware. See §18.

## 15. `maxTimeoutSeconds` is advertised, not enforced

Both paid routes now set `maxTimeoutSeconds: 60`. Before this they set nothing,
and x402-hono 0.5.3 filled in **300**. The value reaches the client in the 402
challenge, and the client uses it to compute EIP-3009 `validBefore`. Verified by
`signal-api/src/facilitatorErrors.test.ts`, which asserts the challenge carries 60.

**How the facilitator treats it.** The x402 core spec does not require a
facilitator to check an upper bound on `validBefore`. We sent signed
authorizations from a random zero-balance wallet to `https://x402.org/facilitator/verify`.
Only `/verify` was called, never `/settle`, so nothing could move. A result of
`insufficient_balance` means the time checks passed.

| Case | validAfter | validBefore | Result |
|---|---|---|---|
| A | now−600 (x402 0.5.3 client) | now+60 | insufficient_balance → accepted |
| B | 0 | now+60 | insufficient_balance → accepted |
| C | now−600 | now+3 | `valid_before` rejected |
| D | now−600 | now+3600 | insufficient_balance → accepted |
| E | now+300 | now+600 | `valid_after` rejected |
| F | 0 | now+30 days | insufficient_balance → accepted |

Conclusion: this facilitator behaves like the reference implementation. It
rejects `validBefore < now + 6` and future `validAfter`, and applies **no upper
bound**. A 30-day authorization passes the time checks. It is not the broken
`(validBefore − validAfter) < maxTimeoutSeconds` variant, because case B would
have failed. The ordering inference (C and E fail before the balance check, so
an upper-bound check would have surfaced in D or F) relies on the error each case
returned, not on reading the facilitator's source, which is not public.

**What that means for us.** `maxTimeoutSeconds: 60` states intent and bounds
compliant clients, nothing more. A client can sign a longer window and it will
be accepted. The exposure falls mainly on the payer, since a leaked `X-PAYMENT`
header stays spendable for longer, but the only possible payee is our `payTo`.
Enforcing the bound would mean checking `validBefore` in our own middleware
before calling `/verify`. That was not done: the risk is to the payer, not to us.

Note also that the installed x402 client (0.5.3) signs `validAfter = now − 600`,
not 0. A facilitator of the broken variant would reject case B but accept A, so
our own clients would not have exposed that bug.

**Why 60 s and not something derived from `maxPriceAge`.** The two limits
protect different things. `maxPriceAge` (read live from
`PerpetualExchange.maxPriceAge()`, 21600 s (6 h) on 2026-09-23) decides whether a price
is still tradable. The `/oracle/*` freshness gate (`app.ts:590-624`) runs
before `paymentMiddleware` on **every** request, including the paid retry that
carries `X-PAYMENT`. So a buyer holding a 60-second authorization cannot be
sold a price older than `maxPriceAge`: if the price went stale in between, the
paid retry gets `503 price_stale` before `/verify` is ever called. The
requirement "no longer than the staleness threshold" holds because 60 s is far
below `maxPriceAge`; 60 was chosen from the response time of a single GET.

**2026-09-23:** rationale recorded; value unchanged.

## 16. Public facilitator: rate limit unknown, errors used to surface as 500

**Limit.** `docs.x402.org` publishes no RPS or quota for `x402.org/facilitator`.
It says only that the public facilitator is intended for development and testnet
workflows. Its responses carry no `RateLimit-*` headers, and it is served through
Cloudflare → Vercel. **We did not load-test it to find the ceiling.** It is
someone else's shared service, and finding its limit means pushing it past its
limit. The 50 RPS figure that circulates belongs to Coinbase's CDP facilitator,
a different service. Treat the public facilitator's limit as unknown and lower
than production needs.

This matters more than the number suggests. Every Vercel instance shares the
same facilitator and, from its point of view, a small set of egress IPs, so
whatever limit exists is shared across all of our instances, not applied per
instance.

**Error handling, before.** x402-hono 0.5.3 throws from `/verify` on any non-200
(`Failed to verify payment: <statusText>`) and does not catch it. A facilitator
429 reached the buyer as Hono's generic `500 Internal Server Error`, with no
indication of whose fault it was or whether to retry.

**Now.** `app.ts` wraps `paymentMiddleware`:

| Facilitator returns | Buyer now gets |
|---|---|
| HTTP 429 on `/verify` | `429 facilitator_rate_limited` + `Retry-After: 5` |
| HTTP 5xx on `/verify`, or network failure | `502 facilitator_unavailable` |
| 200 `isValid:false` with a rate-limit reason (the CDP shape) | `429` instead of `402` |
| 200 `isValid:false` for a real reason (bad signature, …) | `402`, unchanged |
| any error we do not recognise | original path, unchanged |

Each wrapped response states that nothing was charged. Tested offline against a
stub facilitator in `signal-api/src/facilitatorErrors.test.ts`, which runs in
`npm test`.

**Not done:**

- **Retry.** A server-side retry would stack more calls onto a facilitator that
  is already refusing them. `Retry-After` hands that decision to the client.
- **Fallback facilitator.** None configured. A second facilitator would need its
  own trust assessment, since it signs settlements into our `payTo`.
- **Settle-phase rate limits.** When `/settle` fails, x402-hono puts the `Error`
  object itself into the 402 body, which serialises to `{}`. The reason is lost
  before our wrapper sees it, so a settle-phase 429 still reaches the buyer as a
  bare 402. Fixing it means patching or replacing the middleware. The buyer is
  not charged in this case, and since §14's ledger change no revenue split is
  queued either (the entry is only recorded when `X-PAYMENT-RESPONSE` is present).
- **Detection is string-based.** It matches `statusText` ("Too Many Requests")
  and reason strings. If the facilitator changes wording, recognition degrades
  back to the old behaviour. The test pins the shapes we know about.

## 17. No KYT / KYA screening of counterparty addresses

Neither direction screens addresses. `agent/x402_agent.ts` pays whatever `payTo`
a 402 challenge names. `signal-api` accepts payment from any `from` address the
facilitator verifies, and `routeExternalRevenue` sends 70% to whatever trader
address the request path contains, after only a format and zero-address check.

**Why the existing identity work does not cover it.** The VC/SSI layer
(`AGENT_IDENTITY_VC_SSI.md`) answers *who authorised this agent, and within what
limits*. It says nothing about whether an address is sanctioned, mixer-linked, or
exploit-linked. An authorised agent can pay a sanctioned address with a perfectly
valid VC. **The VC governs the principal and KYA governs the address. Each
complements the other, and neither replaces it.**

**What production would need:**

- A screening call before signing on the paying side, and on receipt of
  `payer` / before `routeExternalRevenue` on the receiving side.
- A cached allow/deny list in front of the vendor, so repeat counterparties do
  not pay per-call latency every time. The agent-to-agent traffic here is highly
  repetitive.
- Fail-closed or fail-open as an explicit, documented choice. For outbound
  payments fail-closed is the defensible default. For inbound micro-payments
  screening can run after delivery, since the funds have already arrived and the
  question becomes whether to route the split.
- Retry with backoff. Third-party screening APIs have intermittent network
  errors. One reported PoC measured roughly 99.97% success at 10 TPS outside load
  tests, which at our volumes would mean occasional failures that must not become
  a declined payment.

**Rough budget, not measured by us.** Screening vendors typically add one HTTPS
round-trip, in the low hundreds of milliseconds, and are priced per screened
address or by contract. At $0.005–$0.01 per call, a per-call paid screen can cost
more than the payment it screens. That is the practical argument for caching and
for screening addresses rather than transactions. Treat these figures as
something to confirm with a vendor, not as numbers from this project.

**Why not implemented.** Testnet only, no vendor account, and a mock screen would
be the kind of decorative control §10 warns about.

## 18. Latency and success-rate acceptance thresholds

The repository had no latency, throughput, or success-rate targets for the paid
path. (`signal-api/src/benchmarks.ts` is unrelated: it serves the S&P 500 / gold
/ BTC comparison data for the Portfolio page.)

**Measured 2026-09-17**, sequential with a 500 ms gap, from Taiwan:

| Metric | n | p50 | p95 | max | Non-success |
|---|---|---|---|---|---|
| `x402.org/facilitator` `/verify` | 30 | 438 ms | 552 ms | 834 ms | 0 |
| Deployed `/signals/:trader` → 402 challenge | 30 | 118 ms | 150 ms | 151 ms | 0 |
| Deployed `/oracle/sBTC` → 402 challenge | 30 | 390 ms | 888 ms | 1087 ms | 0 |

`/oracle` is slower at the challenge because its freshness gate makes two RPC
reads *before* the 402, which is deliberate: x402 has no refunds, so a stale
price is refused before payment.

**Proposed thresholds, and why one of them changed:**

| Metric | Proposed | Status |
|---|---|---|
| Paid endpoint P95, excluding our revenue split | ≤ 500 ms was proposed | **Not achievable as stated.** A paid request is challenge + `/verify` + handler + facilitator `/settle`, and the last one waits for an on-chain receipt (§14). `/verify` alone has p95 552 ms from here. A meaningful target needs a real paid-path measurement first. |
| Facilitator `/verify` latency | p95 ≤ 600 ms from the function region | Measured above, but from Taiwan, not from `sin1` |
| 402 challenge P95 | `/signals` ≤ 250 ms, `/oracle` ≤ 1000 ms | Measured |
| Revenue settlement success | ≥ 99%, every failure visible in `settleError` | **No data.** The batch worker (§14) now makes this countable in principle — it prints `settled=/failed=/dead=` per run and fails the CI job past `SETTLEMENT_MAX_FAIL_PCT` — but the workflow has not executed in production (no secrets set yet), so there is still no real sample to report a percentage from. |

**Not measured:** the full paid request. It needs a funded Base Sepolia buyer
wallet and spends test USDC on every sample, so it was left for a human to run,
for example with `agent/examples/buy-signal.ts` in a loop. Until then no P95 for
the paid path is claimed here.

**2026-09-24:** a concurrency run of the 402 challenge (1/5/10 concurrent) and
the settlement worker's throughput ceiling (150/hour at default settings) are in
[COST_MODEL.md](COST_MODEL.md#capacity). The paid path is still unmeasured.

## 19. No self-hosted facilitator — settlement gas is paid by x402.org

`app.ts:44-45` defaults `X402_FACILITATOR_URL` to `https://x402.org/facilitator`,
and no deployment overrides it. That facilitator, not us, submits the buyer's
EIP-3009 `transferWithAuthorization` and pays its gas.

**On-chain evidence.** Every x402 payment into our `payTo` checked on Base
Sepolia was sent by `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`, not by any
key we hold — for example `0x2590feb2…6d4` and `0x9e0a6a04…90f81` (2026-07-15,
external buyer `0x858b36C7…0bA972`), gasUsed 91,272 each, and treasury self-pay
tests on 2026-06-22/23 at 83,648–83,672 gas. Full list in
[COST_MODEL.md](COST_MODEL.md#measured-on-chain).

**What that means:**

- **No SLA.** `docs.x402.org` describes the public facilitator as intended for
  development and testnet workflows (see §16). There is no uptime or latency
  commitment to rely on.
- **Testnet only.** It settles Base Sepolia. Nothing in this repository has been
  run against a mainnet facilitator.
- **We cannot monitor its wallet.** If `0xd407…f1bf` runs out of ETH, `/settle`
  fails. x402-hono then throws inside its settle block
  (`index.mjs:155-162`) and replaces our response with a 402: the buyer is not
  charged, and because the ledger only records on `X-PAYMENT-RESPONSE` (§14),
  no revenue split is queued either. The failure is safe, but we would only see
  it as a wave of 402s after valid payments — we have no balance alert on a
  wallet we do not own.
- **The cost is hidden, not zero.** On mainnet with a self-hosted facilitator,
  this gas becomes ours. [COST_MODEL.md](COST_MODEL.md) prices it.

**2026-09-23:** entry added; the `/x402` docs page footer now names the
facilitator and who pays its gas (`frontend/src/locales/{en,zh-TW}/x402.ts`).

## 20. On-chain revenue totals cannot separate demo self-payments from external ones

`/revenue` reads `FeeRouter.platformEarnings()` and multiplies (`onchainRevenue.ts:40-73`).
It has no event scan, so it cannot say which routes came from whom, and it
reports `count: null` rather than a number.

**What the total contains.** The x402 FeeRouter has four `routeExternalRevenue`
calls, all $0.01, all sent by the treasury (see [COST_MODEL.md](COST_MODEL.md#measured-on-chain)).
Two match external payments from `0x858b36C7…0bA972` on 2026-07-15. The two
from June 15–16 name the treasury itself as trader; whether an external payment
preceded them was not checked (the transfer listing read on 2026-09-23 did not
reach back that far). Separately, many `/oracle` payments on 2026-06-22/23
were the treasury paying itself through x402 and were never routed at all
(`/oracle` did not settle then — `app.ts:710-711`). So the headline "x402
Revenue" mixes self-paid demo activity with real external revenue, and the
number of paid calls is unknown.

**Why filtering by sender does not work.** Every route, demo or real, is sent by
the same treasury key; the current worker uses it too (`settlement.ts:44`).

**What is no longer true.** `/demo/buy-signal` no longer settles anything
(`app.ts:500-508`), so it cannot add to the total going forward. The docs page
and README used to say it paid $0.01 and returned a real settlement tx; that
copy was wrong and is fixed.

**2026-09-23:** demo copy corrected in `frontend/src/locales/{en,zh-TW}/x402.ts`,
`agent/README.md` and the `/demo/buy-signal` comment and `paymentInfo.note`. The
home-page KPI and the docs page showed `count: null` as "0 calls"; they now show
"—" / "call count not tracked on-chain". No attribution field was added to
`/revenue`: doing it honestly needs an event scan (`NEXT_STEPS.md`).

---

## Frontend

**Dead Minimal UI template code still reaches the production bundle.** The app is
built on the Minimal UI template, and its demo dashboard was never removed:
`routes/sections/dashboard.tsx` is imported by nothing (`routes/sections/index.tsx`
mounts only `pepefiRoutes` and `authRoutes`), and `layouts/dashboard/layout.tsx`
plus `layouts/components/account-drawer` / `account-popover` are reachable only
through it.

Despite being unmounted, the template's placeholder identity is present in the
built entry chunk — grepping `dist/assets/index-*.js` finds both
`Jaydon Frankie` and `demo@minimals.cc`, which come from
`auth/hooks/use-mocked-user.ts`. Rollup is not shaking the chain out. Nothing
renders it today, but a hardcoded fake user shipping inside a financial product's
bundle is the kind of thing a technical due-diligence reader will find, and the
right fix is to delete the template dashboard rather than to keep pruning
imports around it. Not attempted here because it is a large deletion that wants
its own change and its own verification pass.

**Entry chunk is 1,057 kB (328 kB gzipped).** Routes were already code-split;
vendors were not, so everything landed in one file. `vite.config.ts` now splits
ethers / MUI / recharts / react into their own chunks, taking the entry from
1,789 kB → 1,057 kB (570 → 328 kB gzip) and stopping a routine deploy from
invalidating ~1.7 MB of otherwise-unchanged vendor cache.

What remains is dominated by `components/iconify/icon-sets.ts` — 168 kB of source
inlining 206 icons as raw SVG bodies (320 paths in the built chunk). That is a
deliberate trade: icons ship with the bundle instead of being fetched from the
Iconify CDN, which keeps the app working offline and avoids a third-party request
on every page. Splitting it would mean lazy icon loading and a flash of missing
glyphs. Left as is, but it is the next lever if the entry chunk needs to shrink.

**The product code is not linted.** `eslint.config.mjs` ignores
`src/pages/pepefi/**`, `src/components/pepefi/**`, `src/hooks/**` and
`src/lib/pepefi/**` — deliberate per the comment there (ported code, original
style preserved), but it means the lint gate in CI covers the template scaffolding
and not the application. `tsc --noEmit` does cover everything.

---

## Honest positioning

This is a **high-completeness academic prototype deployed to testnets**, not a
production financial product. It has 24 contracts, 420 passing tests, CI, three
chain deployments, a documented risk model, and an AI agent stack with VC/SSI
authentication. It does not have an audit, a decentralized oracle, or any
regulatory authorization.

Six of the eleven assets reference real securities (sAAPL, sTSLA, sNVDA, sMSFT,
sGOOGL, sBOND). Offering leveraged exposure to those to the public requires
licensing in essentially every jurisdiction. No amount of engineering changes
that, which is why the commercial direction is B2B infrastructure sold to
already-licensed institutions rather than a retail-facing venue.
