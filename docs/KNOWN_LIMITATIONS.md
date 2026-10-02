# Known Limitations

Written for the project report. Every item here was verified against the code on
2026-07-27, not assumed. Where something was fixed, the fix is named; where it
was not, the reason is given rather than glossed over.

> **Status as of 2026-09-30:** #1–#13 were verified on 2026-07-27; #14–#20 (x402
> layer) were added on 2026-09-17; #21–#26 (exchange guardian/pause, caps, slash
> reserve, portfolio-margin removal) came with PR #191, which is merged as
> **source only, not deployed**; #27–#29 (guardian asset-mode limit, timelock
> handover, V2.5 unpriced exemption) came with PR #198, merged the same way —
> **source only, not deployed**. The status column below was not re-verified item
> by item on 2026-09-30. Current numbers: 920 Foundry tests on `master` after
> PR #191 (portfolio-margin-only tests were removed with the feature); PR #198
> reported 956 passing plus fork tests that are skipped by default — whether all
> pass is whatever the latest Contracts CI run says. Current deployment and what is
> live vs. source-only:
> [`README.md`](../README.md).

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
| 19 | No self-hosted facilitator; x402.org pays the settlement gas | **By design (testnet)** — no SLA, we don't control or fund its wallet and have no alert on it |
| 20 | On-chain revenue totals cannot separate demo self-payments from external ones | **Open** — documented; needs an event scan |
| 21 | No delisting / final-settlement function in `PerpetualExchange` | **Open** — positions on a permanently dead feed cannot close |
| 22 | Guardian pause expiry bounds each pause, not the number of pauses | **By design** — owner rotates a misbehaving guardian |
| 23 | Global pause blocks exits and liquidations | **By design** — deposits stay open; funding/borrow frozen; grace period after |
| 24 | Portfolio margin has no account-level net liquidation | **Open** — `portfolioMarginEnabled` must stay **off** in production until implemented and audited (off on the live deployment) |
| 25 | InsuranceVault has no virtual shares (first-depositor inflation) | **Mitigated** — zero-share deposits revert; attack profitability not removed |
| 26 | Portfolio (cross) margin removed | **Resolved by removal** (2026-09-30) — supersedes #24; isolated margin only |
| 27 | Exchange guardian's per-asset brake stops at ReduceOnly; only the owner can Halt | **By design** (2026-09-30, PR #198, source only) — the *exchange* guardian cannot freeze exits by asset mode. The GuardedOracle guardian's freeze and pause are **bounded in source** (2026-10-01, `contracts/oracle-freeze-expiry-checkin`: 72h expiry, 24h cooldown) but **not deployed**: the live oracle `0x8E9e…` still has no expiry (see §27 below) |
| 28 | After the timelock handover, recovery actions wait 48h and depend on one Safe | **By design** — losing the Safe freezes governance permanently |
| 29 | V2.5 unpriced exemption values a closed dead-feed asset at an arbitrarily old price | **Accepted** — closed assets only, never below its last recorded price, dust-only without one |
| 30 | Daily check-in still transfers PEPE on the deployed PepeIncentives, against the #101 decision | **Fixed in source** (2026-10-01, issue #169) — check-ins credit non-transferable achievement points; **not deployed**, the live contract is unchanged |

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
an SLA. The §19/§20 on-chain figures are a separate, later measurement: public
Blockscout API reads from 2026-09-23. The settlement worker's capacity ceiling
is a separate run again, dated 2026-09-24, in
[COST_MODEL.md](COST_MODEL.md#capacity).

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
merges to `master`, or a manual dispatch right after that merge. As of
2026-09-29 the worker refuses to run outside GitHub Actions (`GITHUB_ACTIONS`
must be `true`): the CI job's 20-minute timeout is what guarantees the Redis
lease lock (1500 s) cannot expire mid-run, and a local process has no such
bound, so a local run could overlap the CI worker and pay twice. Locally only
`settlement-worker.ts --dry-run` is allowed, which reads the queue without
taking the lock, claiming keys or signing. (A local run against the real
Upstash instance on 2026-09-17, before this restriction, connected, read an
empty queue and exited 0.) The `GITHUB_ACTIONS` check is a speed bump, not a
security boundary — anyone can set that variable locally. The actual boundary
is that `FEE_SETTLEMENT_PRIVATE_KEY` exists only in GitHub secrets, together
with the workflow's concurrency group and the Redis lease lock.

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
check in `app.ts:579-588` now blocks that input on `/signals`; `FeeRouter` itself
still accepts it.

**Where the split's money comes from.** It is still not the buyer's payment
moving through the router. The facilitator settles the buyer's USDC into `payTo`
(per `.env.example:21-25`, the treasury EOA that also holds
`FEE_SETTLEMENT_PRIVATE_KEY`). Later, the worker calls `routeExternalRevenue`,
which `safeTransferFrom`s an equal amount out of that same wallet
(`FeeRouter.sol:129`, `settlement.ts:116`). The amounts match and the order is
now correct, but it is two transactions minutes apart, not one atomic route.
If `PAY_TO` is unset, it falls back to the FeeRouter address itself
(`resolvePayTo`, `agent/shared/src/env.ts:14-17`); if it is ever set to some
other address than the settlement wallet, the worker pays the split from a
balance the buyer never touched either way.

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
is still tradable. The `/oracle/*` freshness gate (`app.ts:592-626`) runs
before `paymentMiddleware` on **every** request, including the paid retry that
carries `X-PAYMENT`. So a buyer holding a 60-second authorization cannot be
sold a price older than `maxPriceAge`, unless the gate's own read fails (it
fails open — `app.ts:622-624` swallows the error and calls `next()`): if the
price went stale in between, the paid retry gets `503 price_stale` before
`/verify` is ever called. The
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
- **We don't control or fund it and have no alert on it.** If `0xd407…f1bf` runs out of ETH, `/settle`
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
calls totalling $0.04, all $0.01, all sent by the treasury (see
[COST_MODEL.md](COST_MODEL.md#measured-on-chain)): 2 match external payments
from `0x858b36C7…0bA972` on 2026-07-15, and 2 are of unverified origin
(2026-06-15/16, trader = treasury — whether an external payment preceded them
was not checked; the transfer listing read on 2026-09-23 did not reach back
that far). Separately, at least two `/oracle` payments on 2026-06-22/23 were
the treasury paying itself through x402 and were never routed at all (`/oracle`
did not settle then — `app.ts:712-714`). So the headline "x402 Revenue" may mix
self-paid demo activity with real external revenue, and the number of paid
calls is unknown: those unrouted June 22/23 payments are themselves the
evidence that payments and routes are not the same count, so the call count
cannot be inferred from routes either.

**Why filtering by sender does not work.** Every route, demo or real, is sent by
the same treasury key; the current worker uses it too (`settlement.ts:44`).

**What is no longer true.** `/demo/buy-signal` no longer settles anything
(`app.ts:502-508`), so it cannot add to the total going forward. The docs page
and README used to say it paid $0.01 and returned a real settlement tx; that
copy was wrong and is fixed.

**2026-09-23:** demo copy corrected in `frontend/src/locales/{en,zh-TW}/x402.ts`,
`agent/README.md` and the `/demo/buy-signal` comment and `paymentInfo.note`. The
home-page KPI and the docs page showed `count: null` as "0 calls"; they now show
"—" / "call count not tracked on-chain". No attribution field was added to
`/revenue`: doing it honestly needs an event scan (`NEXT_STEPS.md`).

---

## PerpetualExchange emergency controls (added 2026-09-29)

## 21. No delisting / final-settlement function

There is no function that settles every open position of an asset at a final
price. If an asset's oracle stops updating for good, `closePosition`,
`liquidatePosition` and (in portfolio mode) `withdrawMargin` for accounts
holding it revert with `StalePrice` until the owner restores a feed. Setting
the asset to `Halted` stops new damage but does not release the positions.
Until a settlement function exists, markets being retired must be wound down
while a keeper still refreshes their last price (the ReduceOnly flow).

## 22. Guardian pause expiry bounds each pause, not the number of pauses

A guardian pause lapses after `GUARDIAN_PAUSE_DURATION` (72h). The guardian
cannot extend a running pause but can start a new one after it lapses; the
owner removes a misbehaving guardian with `setGuardian`. The owner may take
over a running guardian pause (it then never lapses). Owner pauses never lapse.

**Update (2026-09-29, later the same day):** the chaining gap above is closed.
After a guardian pause ends — by lapsing or by the owner lifting it — the
guardian may not pause again for `GUARDIAN_PAUSE_COOLDOWN` (24h); the owner is
not bound by it. A guardian acting alone can therefore freeze withdrawals for
at most **72h 30min** at a stretch (72h pause + 30min post-pause grace), and
every such stretch is followed by at least **23h 30min** in which withdrawals
work. Only the owner can hold the market shut longer.

**Correction (2026-09-29, review round 3):** in the current code the
post-pause grace period DOES block withdrawals (`withdrawMargin` calls
`_requireNoGlobalGrace`), so a guardian acting alone can freeze withdrawals
for up to **72h 30min** at a stretch (72h pause + 30min grace), not 72h. The
cooldown bounds each stretch but not the duty cycle: a guardian that pauses
again the moment each 24h cooldown ends keeps the market stopped for 72 of
every 96 hours — about **75% downtime** — indefinitely. Only the owner can
stop that, by replacing the guardian (`setGuardian`).

## 23. Global pause blocks exits and liquidations

While paused, traders cannot close and underwater positions cannot be
liquidated; only `depositMargin` stays open. Funding and borrow fees do not
accrue over paused (or Halted) time, and liquidations, new opens and
withdrawals wait out `LIQUIDATION_GRACE_PERIOD` (30 min) after the pause ends;
after a Halt is lifted, liquidations and opens on that asset wait likewise.

## 24. Portfolio margin has no account-level net liquidation — keep it off

`setPortfolioMarginEnabled` switches the liquidation GATE to account level
(a leg is liquidatable only when it and the whole account are underwater),
but settlement is still per leg. When a losing leg is finally liquidated,
its shortfall is charged only to the owner's free margin; the margin and
unrealized profit of the owner's other open legs — which kept the account
healthy and the loser alive — are not taken. The pool (InsuranceVault, ADL,
bad debt) absorbs the rest, after which the owner can close the other leg and
withdraw. An independent review reproduced this with a 1,750 USDC shortfall.

Guards added on 2026-09-29 narrow the window without closing it: no new opens
while the account is below maintenance; withdrawals only while equity stays at
or above the SUM OF INITIAL margin; profit on ReduceOnly / Halted legs and on
zero-price legs counts as 0 (and a zero-price leg's loss as its whole margin);
no withdrawals while holding a Halted asset; every leg must be on a fresh feed
for withdrawals, opens and liquidations.

**Portfolio margin must remain disabled in production** until account-level
netting (settling the whole account against its combined equity) is
implemented and audited. It is off on the live deployment.

**Update (2026-09-30):** superseded by #26 — portfolio margin has been
removed from the contract altogether.

## 25. InsuranceVault has no virtual shares

The vault mints `shares = amount × supply / totalAssets` with no virtual
shares or dead-share offset. A first depositor who mints 1 share and then
inflates `totalAssets` (any protocol inflow counts) can make later deposits
round down. Since 2026-09-29 a deposit that would mint **0 shares reverts**
(`ZeroShares`), so a victim's USDC can no longer be silently absorbed; a
deposit that rounds to a *small* number of shares still loses the rounding
remainder to existing holders. Virtual shares (ERC-4626-style offset) would
remove the attack's profitability and are the intended follow-up.

## 26. Portfolio (cross) margin removed

Portfolio margin was **removed from `PerpetualExchange` on 2026-09-30**, for
two reasons: the contract had grown to 28,054 B of runtime code, over the
EIP-170 limit of 24,576 B, so it could not be deployed; and the H3 gap (#24)
could not be closed without account-level net liquidation. The mode was never
enabled on-chain and neither the frontend nor the agent used it.

Every position is now isolated: it is liquidated on its own maintenance
requirement, can lose at most its own margin, and free margin or other
positions neither shield it nor pay for it. `portfolioMarginEnabled`,
`setPortfolioMarginEnabled` and `getAccountHealth` no longer exist.

The last implementation (with the guards described in #24) can be recovered
from git history at commit `d4b7b9e`. Re-introducing it requires
account-level netting and a fresh audit, and must fit the size budget.


## 27. Guardian's per-asset brake stops at ReduceOnly (added 2026-09-30)

Added on branch `contracts/p1-cutover-periphery` (merged to `master` as PR #198,
source only, not deployed) after the audit-level review of the #130 cutover. `ExchangeOpsLib.setAssetMode` now lets the exchange
guardian move an asset only into ReduceOnly: from Active, or idempotently from
ReduceOnly, which sets `guardianLocked` so the market operator cannot re-open
it (second review, L2). ReduceOnly refuses new exposure but
keeps closes, liquidations and margin withdrawals working. Halted, which also
freezes exits, is reserved to the owner (the timelock after the handover).
Before this change a compromised guardian key could Halt every asset and hold
all open positions hostage until the owner intervened.

The global `pause()` is unchanged: the guardian can still stop everything,
exits included (#23). That pause is bounded (72h expiry, 24h cooldown, #22),
while a Halt had no expiry at all. `PerpetualExchange.setAssetMode`'s NatSpec
was brought in line with the library in commit `26dc78a` (comments only;
runtime still 23,911 B).

**Scope of the guarantee: the exchange guardian only.** GuardedOracle's
`GUARDIAN_ROLE` is a different key with different powers:
`setAssetFrozen(id, true)` and `setPaused(true)` have **no expiry**, and a
frozen or paused oracle *reverts* `getPrice`. Every consumer fails closed.
Closes and liquidations on an exchange that reads that oracle
(`ORACLE_KIND=guarded`), and mints and redeems on the V2 vault, all revert
until the oracle guardian unfreezes. A compromised oracle-guardian key can
therefore lock exits indefinitely. It cannot move a price or take funds.
This is accepted for now, with the following response after the handover:

- The timelock, as the oracle's `DEFAULT_ADMIN_ROLE`, revokes the compromised
  holder's `GUARDIAN_ROLE` and grants it to a new key (48h).
- The new guardian calls `setAssetFrozen(id, false)` and `setPaused(false)`.
- Until then, the exchange's own guardian can still put affected markets into
  ReduceOnly so no new exposure piles up behind the frozen feed.

The response above describes the **live** oracle `0x8E9e…`, which is the
build without an expiry. It stays the procedure until that oracle is replaced.

### Bounded guardian halts (source only, 2026-10-01; revised 2026-10-02)

Branch `contracts/oracle-freeze-expiry-checkin` adds the bound to
`src/v2/GuardedOracle.sol`. GuardedOracle is not upgradeable, so it reaches a
chain only through `script/RedeployGuardedOracle.s.sol` (new instance, vault
`setOracle`); an exchange deployed with `ORACLE_KIND=guarded` holds its oracle
immutable and keeps the old behaviour until that exchange is redeployed.
Nothing has been deployed.

What the new build does:

- **Guardian** (`GUARDIAN_ROLE` without the admin role). A freeze or pause
  lapses at most `GUARDIAN_HALT_DURATION` (72h) after it started, with no
  transaction: `getPrice`, `isStale`, `peek` and `paused()` all read the halt
  as "in force until expiry". The guardian cannot extend a halt (halting an
  already-halted scope reverts) and cannot lift an admin halt. The clocks
  belong to the scope, so several guardian keys share them.
  - *Freeze:* may be lifted early and re-placed inside the same window; the
    window's end never moves. After the window ends, 24h
    (`GUARDIAN_HALT_COOLDOWN`) before another freeze window on that asset.
  - *Pause:* lifting it early **closes its window at the lift**, so the 24h
    cooldown runs from when the pause actually ended and the next pause gets a
    full window of its own. Exception: if a guardian freeze was placed while
    the pause was in force, that freeze runs to the pause's original end and so
    does the pause window (no re-pause inside it, cooldown from there).
- **Admin** (`DEFAULT_ADMIN_ROLE`, the timelock after the handover). A halt it
  places has no expiry and only the admin can lift it.
  - `takeOverAssetFreeze(id)` / `takeOverPause()` turn a **running** guardian
    halt into one with no expiry, and revert `NothingToTakeOver` when there is
    none (lifted, lapsed, or already the admin's). This is the call to queue in
    the timelock: if the guardian lifts a false alarm while the proposal waits,
    executing it does nothing instead of starting a new indefinite halt.
  - `setAssetFrozen(id, true)` / `setPaused(true)` by the admin mean "make sure
    an admin halt with no expiry is in force": they start one when nothing is
    in force, and also convert a running guardian halt. Use them only when an
    indefinite halt is wanted regardless of what the guardian did meanwhile.
  - 72h is longer than the 48h timelock on purpose: a takeover proposed right
    after the guardian acts executes before the halt lapses.
- **Freeze and pause share a clock where they overlap**, measured by when the
  pause **actually** ran (`lastGuardianPause()` returns that interval). The
  pause covers every asset, so without a shared rule the two scopes could be
  alternated to keep one asset unreadable indefinitely. A guardian freeze that
  opens a new window:
  - while a guardian pause is in force: ends no later than the pause;
  - within 24h after a guardian pause that ran for `d` ended: is shortened by
    `d`; refused for that day if the pause ran its full 72h, or if this asset's
    own guardian freeze window ended less than 24h before the pause started;
  - otherwise (and under an admin pause): the full 72h.
  A pause that is lifted at once (a false alarm, or one stolen guardian key
  trying to burn the brakes) therefore costs later freezes nothing. An earlier
  draft of this branch capped every freeze to the pause's 72h window even after
  the pause was lifted, and then refused all freezes for a day after that
  window; the PR #219 review found that any pause, even one lifted at once,
  weakened every asset's brake for days, and the rule above replaces it.
  Why the pause window closes on an early lift instead of staying open with
  only the in-force time capping freezes: an open window can be re-entered,
  so when a freeze starts nobody knows yet how long the pause will end up
  running; a freeze given its full length in a lifted gap, with the pause
  re-entered around it, could then outlast the 144h bound. Closing the window makes
  the pause's record final the moment it ends, so the freeze rule can use it.
  The cost: after lifting a pause early the guardian cannot pause again for
  24h (it can still freeze assets, at full length after a false alarm).
- An account that holds both roles is treated as the admin (its halts do not
  lapse). `GuardedOracle`'s constructor grants both to the deployer;
  `RedeployGuardedOracle` renounces the deployer's guardian role and warns
  when `GUARDIAN` equals the broadcaster.

What a guardian acting alone can still do with the new build, per asset
(measured to the second by `test/v2/GuardedOracleHaltBound.t.sol`, 3,000 fuzz
runs per strategy, plus deterministic worst cases):

- hold it halted for at most **144h** in one unbroken stretch (a 72h freeze,
  then a 72h pause opened before the freeze ends); then the asset gets 24h with
  no guardian halt of any kind;
- halted time between two clean 24h spans (short clean gaps inside it count
  as halted) is **under 192h** (was 168h before the revision: a short pause, a
  freeze opened just under a day after it, and a full pause opened just under
  a day after that freeze ended can now follow one another). A completed clean
  day therefore follows the previous one within **216h**. The previous text
  here ("recurs at least every 168h") understated this even for the earlier
  draft (192h start to start).

The admin revoking the role (48h) ends it sooner.

**These bounds hold only while the guardian acts alone.** The cross-scope rule
reads the record of the last *guardian* pause. Any admin action on the pause --
an admin `setPaused(true)`, or lifting a pause (including one it took over) --
leaves no guardian record behind, so right after it the guardian's next freeze
gets its full length again. While a guardian key is suspected, a timelock
proposal that lifts an oracle halt (pause or freeze) must revoke the suspected
holder's `GUARDIAN_ROLE` in the same batch; otherwise the 144h / 192h bounds do
not apply.

What the bound does **not** give, and what it costs:

- **A lapse is fail-open.** After 72h the halt is gone whether or not the
  reason for it is. A freeze placed over a suspect price, or a pause placed
  over a compromised keeper, must be followed by an admin takeover or by the
  fix (revoke the keeper) inside the window.
- **A lapse does not refresh the price.** Keepers cannot post to a frozen
  asset or a paused oracle, so the stored price is as old as the halt.
  `maxPriceAge` in the oracle and in each consumer still decides whether it is
  usable until the keeper posts again; the step cap and the rate limit apply
  to that post as usual. The live oracle's own `maxPriceAge` is 30 days, under
  which only the consumers' 6h limits stand between a lapsed freeze and a
  three-day-old price. `RedeployGuardedOracle` therefore does not copy it: the
  new oracle gets `ORACLE_MAX_PRICE_AGE` (default 21600 = 6h, bounded to
  1h..30d, never 0), and every copied price must already be younger than that,
  so no asset is stale the moment the vault is re-pointed.
- **Cooldowns.** After a freeze window ends, that asset cannot be frozen by the
  guardian for 24h (other assets can). After a pause ends, the pause is not
  available to the guardian for 24h (from the actual end; from the original
  end when a freeze was placed under it), and new freezes in that day are
  shortened by how long the pause ran, or refused as described above. The
  admin can still halt (48h through the timelock), and the exchange guardian's
  pause / ReduceOnly and the vault's `PAUSER_ROLE` are separate keys with
  separate clocks.
- **A freeze placed under a pause, or within a day after a long pause, is
  short** (it ends with the pause, or is shortened by the pause's length) and
  may be too short for a timelock takeover: propose the takeover of the pause
  as soon as it starts. The call still succeeds when the result is very short
  (down to seconds) and it still uses up that asset's freeze window: the asset
  cannot be frozen by the guardian again for 24h after it ends. Read
  `guardianFreezeTerms(id)` before freezing to see how long the freeze would
  last.
- **A freeze placed while a guardian pause is in force keeps the pause
  unavailable until 24h after the pause's original end** (up to 96h after it
  started), even if both are lifted minutes later: the pause was already
  pinned when the freeze was placed, and lifting the freeze first does not undo
  that. Per-asset freezes stay available meanwhile.
- **A lapse emits no event** (there is no transaction). Watchers read
  `expiresAt` from `AssetFreezeStarted` / `PauseStarted`, or `freezeOf` /
  `pauseState` / `lastGuardianPause`.
- After the admin lifts a guardian freeze early, the guardian can freeze that
  asset again until its original window ends. Revoke the role in the same
  proposal if the guardian is the problem.

Tests: `test/v2/GuardedOracleHaltExpiry.t.sol` (expiry and cooldown
boundaries, admin no-expiry, takeover functions, cross-scope rule, interaction
with the step cap / rate limit / reference check, a V2 vault redeem across a
lapse), `test/v2/GuardedOracleHaltBound.t.sol` (exact-interval bounds,
false-alarm regression, admin interleaving) and
`test/fork/RedeployGuardedOracleFork.t.sol`.

## 28. Timelock governance: 48h recovery, single Safe (added 2026-09-30)

Once `HandoverToTimelock` runs, every owner and admin action (`unpause`,
lifting Halted or ReduceOnly as owner, re-pointing, `recapitalize`, vault
upgrades) needs a Safe proposal plus the 48h `minDelay`. The fast path is
limited to the guardian (pause, ReduceOnly) and the keeper (Active <->
ReduceOnly). The timelock administers itself (`admin = address(0)`) and the
deployer holds no role on it, so **if the proposer/executor Safe is lost, no
proposal can ever be made or executed. The protocol's governance is then
frozen permanently.** Nothing in the contracts can recover from that. See
`docs/GOVERNANCE_HANDOVER.md` §1 for the Safe threshold requirements.


## 29. V2.5 unpriced exemption and old prices (added 2026-09-30)

The V2.5 mint gate refuses every mint while any outstanding asset has neither
a live quote nor a last-good mark of 6h or younger. RISK_ROLE's
`setUnpricedExemption(id, true)` is the non-timelock way out when a feed is
permanently dead and dust keeps `unregisterAsset` refusing. It works only while
`assetCap[id] == 0`; raising the cap clears the flag, so closing the asset
again needs a fresh decision (re-checked against the new outstanding), and
`unregisterAsset` deletes both the flag and the last-good mark. The asset stays in the
liability at its **last recorded price, however old**, or at 0 when there is
no recorded price and at most `EXEMPT_DUST_UNITS` (0.001 token) is
outstanding.

Residual risk, accepted: if the real price of that closed asset rose after its
feed died, the liability is under-stated by (price rise × outstanding). This
is bounded because the asset is closed, so outstanding can only shrink. The
reserve ratio still counts it, and the ratio stays flagged stale, so a breach
never auto-clears. The alternative, leaving mints of every healthy asset
blocked behind a 48h timelock proposal, was judged worse.

Operational cost: while any exempted asset exists the ratio stays flagged
stale, so **every** later breach recovery needs a manual `clearMintingHalt()`
by RISK_ROLE — not just the first one.

## 30. Daily check-in: points in source, PEPE on chain (added 2026-10-01)

Issue #101 decided that the daily check-in should stop paying PEPE and credit
non-transferable achievement points instead: anything transferable acquires a
price, and anything with a price gets farmed. Only the wording changed at the
time. Issue #169 recorded that `PepeIncentives.dailyCheckIn()` still called
`pepe.safeTransfer`.

Branch `contracts/oracle-freeze-expiry-checkin` changes the source:

- `dailyCheckIn()` credits `achievementPoints[msg.sender]` (and
  `totalAchievementPoints`) and transfers nothing. It no longer reads the PEPE
  pool, so an empty pool does not stop a check-in.
- Points are non-transferable by construction: the contract has no function
  that moves, approves, spends or burns them, and none that credits them
  directly from the owner. They only increase, and only for the account that
  checked in. The owner does set the per-check-in amounts (`setDailyParams`),
  now bounded: base and per-day bonus at most 1,000e18 each, streak cap at
  most 30, so one check-in credits at most 30,000e18 (`MAX_POINTS_PER_CHECK_IN`)
  and `totalAchievementPoints` cannot be pushed into overflow. Every change
  emits `DailyParamsSet`.
- Same curve and same scale as before: `dailyBase` 50e18, `dailyStreakBonus`
  10e18 per consecutive day, capped at a 7-day streak (110e18). The event is
  renamed `CheckInPointsCredited` (same fields): the old build's `DailyCheckIn`
  carried a PEPE amount actually transferred, and an indexer that counts that
  event must not count points as PEPE.
- Two small hardenings in the same function: the streak is computed in
  `uint256` (a cap of 255 used to overflow `uint8` and revert every later
  check-in), and `setDailyParams` refuses a cap of 0 or anything over the
  bounds above.
- The other reward paths (`claimTradeMining`, `claimTierReward`,
  `claimCopyReward`, `claimEsgHoldReward`) are **unchanged and still pay
  PEPE**. #101 decided only the check-in.

**Not deployed.** `PepeIncentives` is not upgradeable (no proxy, immutable
`pepe` / `exchange` / `copyTracker`), so this reaches a chain only by deploying
a new instance and updating `addresses.ts`. A new instance starts empty:
streaks, tier and copy claims, and mined-position flags in the old one are not
carried over. The live Base Sepolia instance `0xEBfA…` (owner `0x858b…`, not
the deployer; see GOVERNANCE_HANDOVER §1) still transfers PEPE on every
check-in.

Frontend: `/rewards` asks the chain which build it is
(`probeCheckInUnit` in `frontend/src/lib/pepefi/achievements.ts`): it reads the
contract's bytecode (`eth_getCode`) and looks for the `achievementPoints`
selector, which only the new build has. It does not try calling the function:
ethers v6 reports every JSON-RPC error on `eth_call` (rate limit, header not
found, internal error, HTTP 429) the same way as a call to a missing function,
so a flaky RPC would have flipped a points build back to "PEPE" (PR #219 review
B-F1). A failed read is "unknown" and keeps the last settled answer for that
contract address; once "points" is settled it is never downgraded. Against the
live contract the probe answers "PEPE" and the page says exactly what it did
before; against a new instance it switches to the points wording and shows the
balance. The same answer (`hooks/useCheckInUnit.ts`) picks the check-in error
text, the admin pool description and the PepeLab "not enough PEPE" hint, so
none of them tells a points build's users that check-in pays PEPE.
`/rewards` is behind `FEATURE_PEPE_REWARDS`, off by default.

Still open, for a decision:

- whether the four PEPE reward paths should follow the same principle;
- whether points should ever be spendable or feed a level (the contract gives
  them no use today);
- the PepeLab daily-quest line already says "achievement points" for the
  check-in while the live contract pays PEPE. It is not probed, because
  `/pepe` is behind `FEATURE_GAMEFI` (off by default) and does not send the
  transaction.

Tests: `test/PepeIncentives.t.sol` (no PEPE moves, empty pool, curve and cap,
parameter bounds and event, no transfer/approve/burn/mint surface, pause, fuzz
against a model of the curve) and `frontend/src/lib/pepefi/achievements.test.ts`
(the probe, including -32005 / -32000 / -32603 / 429 errors).

## Frontend

**~~Dead Minimal UI template code still reaches the production bundle.~~ 已修正（2026-09-30）。**
原本的記載：範本的 demo dashboard（`routes/sections/dashboard.tsx`）沒有被掛載，但假使用者
`Jaydon Frankie`、`demo@minimals.cc` 仍然出現在正式 bundle。複查時 `dashboard.tsx` 與
`use-mocked-user.ts` 已在先前的清理中刪除，但 `dist/assets` 仍 grep 得到 `Jaydon Frankie` 與
`minimals.cc`，實際來源是：

- 語系 catalog 的 `common.notification.*`（範本通知鈴的示範文字，含 `@Jaydon Frankie`）——
  只剩 `src/_mock/_others.ts` 引用，但 catalog 物件整份打包，所以字串照樣出貨；
- `components/iconify/iconify.tsx` 的 console 警告帶 `https://docs.minimals.cc/icons/`；
- `routes/paths.ts` 的 `minimalStore`（MUI 商店連結，無人使用）。

注意：`layouts/dashboard/layout.tsx`（PR #197 改過品牌字串）**不是**範本專用——它是
`routes/sections/pepefi.tsx` 的 `DashboardLayout`，也就是正式站所有 App 內頁的外殼，保留。

處理方式：以 `src/main.tsx` 為起點做 import 可達性分析，刪除所有無法從 `pepefiRoutes`／`authRoutes`
到達的範本檔案——`src/_mock/`（14 檔）、`assets/data`、`assets/icons`、`auth/components/form-{divider,
resend-code,return-link,socials}`、`components/{custom-popover,file-thumbnail,flag-icon}`、
`layouts/components/{language-popover,sign-in-button,workspaces-popover}`、`layouts/nav-config-workspace`、
`sections/blank`、`theme/theme-overrides`、`utils/format-time`；移除上述三處字串；刪除 `public/assets`
底下無任何引用的範本圖檔（`images/{mock,home,about,contact,faqs}`、`icons/{apps,components,courses,
empty,faqs,files,glass,workspaces}`，約 6 MB）。仍無法到達、但屬於產品程式碼的
`components/pepefi/{ErrorBoundary,WhaleAlertBanner,pepeSkinsData}`、`hooks/useWhaleAlerts` 未動。

驗證：`yarn build` 後掃 `dist/` 所有文字檔，`Jaydon Frankie`、`demo@minimals.cc`、`minimals.cc`
（以及不分大小寫的 `minimals`）皆 0 筆。entry chunk 989.87 kB（gzip 334.70 kB）→ 987.00 kB
（gzip 333.41 kB）——假資料本來就沒被打包，出貨的只是那幾段字串，所以體積差異很小。

**Entry chunk is 1,057 kB (328 kB gzipped).** Routes were already code-split;
vendors were not, so everything landed in one file. `vite.config.ts` now splits
ethers / MUI / recharts / react into their own chunks, taking the entry from
1,789 kB → 1,057 kB (570 → 328 kB gzip) and stopping a routine deploy from
invalidating ~1.7 MB of otherwise-unchanged vendor cache.

2026-09-30 現況：移除範本殘留後 987.00 kB（gzip 333.41 kB）；同日套用 dependabot 的 frontend
minor/patch 升級（react 19.3、zod 4.6、es-toolkit 1.52、react-hook-form 7.89 等）後回到
1,038.37 kB（gzip 351.28 kB）。增量來自上游套件本身，未做額外拆分。

What remains is dominated by `components/iconify/icon-sets.ts` — 168 kB of source
inlining 206 icons as raw SVG bodies (320 paths in the built chunk). That is a
deliberate trade: icons ship with the bundle instead of being fetched from the
Iconify CDN, which keeps the app working offline and avoids a third-party request
on every page. Splitting it would mean lazy icon loading and a flash of missing
glyphs. Left as is, but it is the next lever if the entry chunk needs to shrink.

**「你已持有 N 天」只在這段持有始於最近約一天內時才顯示**（2026-09-30，#134 殘項）。
詳情層的持有天數由 `hooks/useHeldSince.ts` 從代幣的鏈上 Transfer 事件倒推（`lib/pepefi/heldSince.ts`），
掃描範圍沿用 `chainLogs.scanFromBlock`：Base Sepolia 公開節點的 getLogs 一次只收 1,000 塊，
上限 60 段 ≈ 26.7 小時。持有早於這個範圍、任何一段讀取失敗、或倒推對不上時一律**不顯示**，
不以掃描下緣充當起點（那會是一個猜出來的數字）。要對長期持有者也顯示，需要索引器
（signal-api 或區塊瀏覽器 API）提供完整的 Transfer 歷史。

**RPC 成本與因應**（PR #202 審查 M1）：一次查詢在最壞情況（長期持有者，起點早於掃描範圍）
要把整個範圍掃完——60 段 × 2 個 filter（轉入、轉出）≈ 110–120 次序列 getLogs，外加
balanceOf 與 getBlockNumber，全部走使用者錢包擴充的 RPC。因此：(1) 詳情層**預設不查**，
只顯示「查詢持有天數」按鈕，使用者按了才掃；(2) 結果放進 module-level 快取
（`lib/pepefi/heldSinceQuery.ts`，鍵為 `chainId:token:user:balance`），**負結果也快取**，
同一個餘額不重掃；讀取失敗與中止不寫快取，使用者可以之後再查；(3) 快取只活在這個分頁，
重新整理頁面後會再查一次。剛買進的人通常第一步（5 段 × 2 個 filter）就找到，約 12 次請求。

**`@swc/core` 鎖在 1.13.5，`@vitejs/plugin-react-swc` 停在 4.1.x**（2026-09-30，PR #202 審查 Low-2）。
dependabot #187 想把 plugin-react-swc 升到 4.3.3，它要求 `@swc/core` ≥1.15；實際解析到的 1.16.13
在載入原生 binding 前會驗證 `%LOCALAPPDATA%/swc` 的 ACL，這台 Windows 開發機上因為另一個 SID
對該目錄有替換權限而拒絕載入（`Failed to load native binding`），`vite build` 與 `yarn dev` 直接中止；
指定 `SWC_NATIVE_BINDING_CACHE` 到專案內目錄也失敗（swc-project/swc#12442）。因此
`frontend/package.json` 的 `resolutions` 把 `@swc/core` 鎖在已驗證可載入的 1.13.5。CI（Linux）與
Vercel 不受這個問題影響，但鎖版是為了讓 Windows 開發機的 build 與 dev 不壞。上游修正或改走
`@vitejs/plugin-react`（Babel）之前不要解除；解除時先在 Windows 上跑一次 `yarn build`。

**/exchange 兌換卡對的是舊版 PepeAMM，前端以能力探測降級**（2026-10-01，#165）。
Base Sepolia 上的 PepeAMM（`0x93be…6d63`）bytecode 只有 16 個 selector，沒有 `oraclePrice()`、
`maxOracleAge()`、`currentDeviationBps()`、`totalShares()`、`removeLiquidity()`——它是 commit
`9030ff1` 的 oracle 定價版（`getPrice()` = oracle 報價 ×1e10，兌換依 oracle 價扣 0.3% 成交、無滑點、
無 stale 檢查、無池價偏離保護），不是 `contracts/src/PepeAMM.sol`（`fdd94e4`，恆定乘積 + band）。
前端 ABI 是新版，舊頁面因此把 oracle 價標成「池內現價」、`oraclePrice()` revert 顯示「—」、
價格衝擊以儲備比例為基準而失真（USDC→ETH 夾成 0%，ETH→USDC 算出約 51% 的假衝擊）。
修法（`lib/pepefi/ammPoolView.ts`）：先以 `getCode` 掃 PUSH4 selector 判斷版本，缺的函式不呼叫；
恆定乘積版的池內現價一律由同一次讀到的儲備算出；舊版改標「兌換價（依 Oracle 定價）」與
「池內可兌出庫存」、不列 Oracle 參考價並附說明；讀失敗顯示「無法取得」；版本不明則不顯示價格。
要讓畫面回到「池內現價 vs Oracle 參考價」的雙欄設計，需要擁有者重新部署新版 PepeAMM 並更新
`addresses.ts`（新版有 1h stale 檢查，keeper 更新頻率需跟上）。

PR #215 審查後補上的行為（`lib/pepefi/ammSwapFlow.ts`、`ammPoolView.ts` 的 `buildSwapCardView`）：

- **衝擊基準與 quote 同一次讀取**。頁面原本只在載入時讀一次基準，放著不動 20 分鐘後 oracle 已經
  走掉，即時 quote 對上舊基準會重現 0.00%／假衝擊。現在 quote 的 effect 以 `Promise.all` 同時讀
  基準（舊版 `getPrice()`、恆定乘積版 `getReserves()`），畫面上的兌換價也用同一次讀到的值；另外
  每 15 秒重讀一次池子與報價（分頁在背景時不讀，回到前景時先把報價標成讀取中、立刻重讀一次——
  #220、PR #223 L3；回前景觸發的重讀 2 秒內只算一次）。基準讀不到
  就不顯示衝擊，不退回舊值。報價以「方向＋金額」為鍵：金額改了、新報價回來之前不顯示上一個金額
  的收到數量／衝擊／最低收到，按鈕停用（#220）。
- **舊版合約的 quote 不看庫存**（oracle 價 × 數量），金額一大就報出池子付不出來的數字。`quotedOut`
  超過輸出側庫存時畫面顯示「超過池內可兌出庫存」、按鈕停用、不顯示收到數量。這是前端擋的，合約
  本身仍然只會在 swap 時 revert。
- **送出前預檢**。`executeSwap` 在送任何交易（含 approve）之前先比對庫存、USDC→ETH 再讀
  `balanceOf` 比對餘額（#220），最後以 eth_call 模擬 swap，必定失敗就一筆都不送。USDC→ETH 額度
  不足時模擬一定撞到 `ERC20InsufficientAllowance`，這不算失敗：新版合約的 `transferFrom` 排在所有
  檢查之後（撞到它代表前面都過了），舊版排在最前面、其餘會失敗的條件是庫存、餘額與 minOut——
  三者都在 approve 之前另外檢查。（OZ v5 先扣額度再轉帳，所以額度不足的 revert 會遮住餘額不足；
  #220 之前這會讓沒有 USDC 的帳號先白付一筆 approve 才失敗。）
- **minOut 不低於畫面上的「最低收到數量」，也不低於即時報價的 99.5%**（#220、PR #223 審查 M1/M2）。
  `executeSwap` 收的是畫面上顯示的那筆報價；approve 之前與 approve 上鏈之後各讀一次即時 quote，
  低於畫面的最低收到數量（畫面報價 × (1 − 0.5%)）就回「價格已變動」、不送 swap，報價標成讀取中、
  重讀新報價讓使用者重新確認；ETH→USDC（不需 approve）也一樣。通過時實際送出（與模擬）的
  minOut = max(畫面報價 × 0.995, 即時報價 × 0.995)：畫面報價是舊的而即時價大幅變好時，底線跟著
  拉高到即時報價，不會讓容忍度變成 30%；畫面報價異常小（例如 1 wei）也一樣有即時報價這道底線。
  算出來是 0（金額小到打 0.5% 後為 0）就不送，畫面上按鈕顯示「金額太小」。#220 之前 approve 後
  會以新 quote × 0.995 送出，價格在等簽名的期間變差時，實收會低於使用者看到的最低收到數量
  （審查在 fork 上重現：畫面 0.007347 ETH、實收 0.003692 ETH）。報價寫進畫面超過 30 秒沒換新、
  或分頁剛回到前景，在新報價回來前都視為讀取中，不能拿來送出（PR #223 L3）。
  **設計內的殘餘**：模擬通過之後、上鏈之前價格再變動超過 0.5%，swap 會在鏈上 revert（付 gas、
  不會以更差的價格成交）。
  **殘餘限制**：舊版在額度不足時無法事前完整模擬（`transferFrom` 擋在最前面），所以「approve 之後
  庫存被別人換走」或「approve 之後價格變差」仍會白付一筆 approve 的 gas——但不會再送出必定失敗
  或低於最低收到數量的 swap；額度已經留著，重新確認後不必再 approve。
- **版本判斷**。成功的判斷以 chainId＋位址快取（bytecode 不會變），`getCode` 之後失敗不會把畫面
  蓋成「無法確認」；`getCode` 與其他讀取並行；還沒讀完時顯示「正在確認線上合約版本…」，與
  「無法確認」是兩句話。舊版的判斷不只靠排除法：bytecode 要沒有 `totalShares()`，執行期再確認
  `getPrice()` 等於 oracle 報價 ×1e10（AMM 自己的 `oracle()` 與 `ETH_ASSET_ID()`）；兩者都讀到卻
  不相等時立刻同時重讀一次再判（oracle 剛好在兩次讀取之間更新不會閃成「無法確認」，#220）：
  重讀**確認相等**才判為舊版；重讀仍不相等、或重讀讀不到（逾時／失敗），都降為版本不明
  （PR #223 L1），下一輪再確認。

**The product code is not linted.** `eslint.config.mjs` ignores
`src/pages/pepefi/**`, `src/components/pepefi/**`, `src/hooks/**` and
`src/lib/pepefi/**` — deliberate per the comment there (ported code, original
style preserved), but it means the lint gate in CI covers the template scaffolding
and not the application. `tsc --noEmit` does cover everything.

---

## Honest positioning

This is a **high-completeness academic prototype deployed to testnets**, not a
production financial product. It has 33 contract definitions under
`contracts/src` (including mocks and superseded vault versions), 776 Foundry
test/invariant functions (source count on 2026-09-30; the "24 contracts, 420
passing tests" previously written here dated from mid-2026 and is superseded),
CI, deployments on Base Sepolia and Sepolia, a documented risk model, and an AI
agent stack with VC/SSI authentication. It does not have an audit, a decentralized oracle, or any
regulatory authorization.

Six of the eleven assets reference real securities (sAAPL, sTSLA, sNVDA, sMSFT,
sGOOGL, sBOND). Offering leveraged exposure to those to the public requires
licensing in essentially every jurisdiction. No amount of engineering changes
that, which is why the commercial direction is B2B infrastructure sold to
already-licensed institutions rather than a retail-facing venue.
