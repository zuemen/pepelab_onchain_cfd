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
*fed by* them. Set `RELAY_SOURCE` to the aggregator address and `priceKeeper.ts`
reads the on-chain feed and writes that price into MockOracle, falling back to
the CEX APIs only for assets the adapters do not cover (most equities on
testnet). The exchange then settles on Chainlink/Pyth data at one remove.

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
and its 13 sessions remain readable, but it has no asset gate. Frontend
(`sessionManager.ts`) and `agent/.env` both point at the new address.

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
