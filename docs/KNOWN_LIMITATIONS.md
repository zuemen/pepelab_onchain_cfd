# Known Limitations

Written for the project report. Every item here was verified against the code on
2026-07-27, not assumed. Where something was fixed, the fix is named; where it
was not, the reason is given rather than glossed over.

## Status at a glance

| # | Limitation | Status |
|---|---|---|
| 1 | V1 contracts do not use SafeERC20 | **Open** — V2 fixed, V1 documented |
| 2 | `PerpetualExchange.oracle` is immutable | **Open** — architectural, needs redeploy |
| 3 | Oracle is a single owner key | **Open** — needs decentralized feed |
| 4 | No third-party security audit | **Open** |
| 5 | Mock stablecoins have unrestricted `mint` | **By design** (testnet only) |
| 6 | AssetVault is not fully collateralized | **By design** — bounded in V2 |
| 7 | Contract tests never ran in CI | **Fixed** |
| 8 | Two payout contracts had zero tests | **Fixed** |
| 9 | Batched chain reads blanked pages | **Fixed** |
| 10 | Agent sessions had no asset restriction | **Fixed and live on Base Sepolia** |
| 11 | V2 vault: no reentrancy guard, unbounded asset registry | **Fixed** |
| 12 | Frontend type escapes (`any`) | **Reduced 42 → 19**; rest is library typing |

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

## 2. `PerpetualExchange.oracle` is immutable

```solidity
IOracle public immutable oracle;   // PerpetualExchange.sol:79 — set once, no setter
```

The Chainlink, Pyth, and Aggregator adapters are deployed and queryable, but
cannot be wired into the trading engine without redeploying the exchange, which
would destroy all open positions. `AdminOraclePage` therefore shows a read-only
three-source price comparison and states plainly that the engine runs on
MockOracle. Nothing in the UI claims the adapters are connected.

## 3. Oracle is a single owner key

`MockOracle.updatePrice` is `onlyOwner`. One compromised key can set any price
and drain value from every contract that prices off it. A production deployment
must point at a decentralized feed. This is the most serious unmitigated risk
in the system and is not solved by any of the work above.

## 4. No third-party security audit

None of the contracts has been audited. The 420-test suite and the documented
risk model are not a substitute for one.

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
