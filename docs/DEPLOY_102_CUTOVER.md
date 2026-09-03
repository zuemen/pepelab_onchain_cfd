# #102 — Four-contract chain redeploy & full-system rewiring

> **Audience:** the team member who holds the funded Base Sepolia deployer key.
> **This is the single highest-risk item in [#93](https://github.com/zuemen/pepelab_onchain_cfd/issues/93).** Anything missed shows up as "some feature silently broke on demo day". Read the whole runbook once before touching anything.
>
> Everything an AI could do without the key is already done (see the sub-issues below). This document is the part that needs a human: deploying contracts, revoking an on-chain authorisation, publishing demo strategies, and end-to-end verification.

---

## 0. Before you start

### 0.1 Sub-issues that must be merged first

| Issue | What it delivers | State |
|---|---|---|
| #96 | `PerpetualExchange` carbon-tier pricing (per-asset fee + leverage from `CarbonTiers`) | merged |
| #97 | `CopyTracker` per-`Allocation` fee buffer + `StrategyRegistry` diversification constraints | merged |
| #98 | `SustainabilityBadge` + carbon-tier `EsgRewardDistributor` | merged |
| #106 | `sBOND` tracks BGRN (green bond ETF) instead of Treasuries | **PR #117 — merge before deploying** |

If #117 is not merged, `agent/keeper/feeds.ts` / `symbols.ts` / `assetMeta.ts` still point `sBOND` at TLT and the registration in step 3 will register the wrong underlying.

### 0.2 Tooling

- **Foundry** — `foundryup` then confirm `forge --version` and `cast --version`. (The repo's automation sandbox cannot install it; this must be your own machine.)
- **`jq`** — the seed scripts parse `broadcast/*.json`.
- **Node 20+ / yarn / npm** — for the frontend and agent rebuilds.
- `gh` CLI, logged in, if you want to open the follow-up PR from the command line.

### 0.3 Secrets (environment only — never commit)

```bash
export PRIVATE_KEY=0x…                 # funded Base Sepolia deployer (the current owner of every contract below)
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # or an Alchemy/Infura Base Sepolia endpoint
export BASESCAN_API_KEY=…              # optional, enables --verify
```

The deployer key **must be the current `owner()`** of `PerpetualExchange`, `FeeRouter`, `InsuranceVault`, `StrategyRegistry`, `AgentSessionManager`, `EsgRewardDistributor`, `PepeIncentives`, `TraderStake` — every `onlyOwner` call below runs as it. Confirm with `cast call <addr> "owner()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL` if unsure.

Deployer wallet needs **Base Sepolia ETH** for gas — budget generously, this is ~15–20 deploy/setter transactions. Faucet: <https://docs.base.org/chain/network-faucets>.

### 0.4 Freeze window

The cutover has a point of no return (step 4.5 / step 7). Do it when nobody is mid-demo and you have the **full two-day buffer** ahead, not the afternoon before the defence.

---

## 1. Blast radius — what moves, what stays, what breaks

`PerpetualExchange` has no proxy and its `usdc` / `oracle` are `immutable`, so the carbon-pricing rewrite (#96) can only reach the chain through a **redeploy**. That cascades:

### Redeploys (new addresses)

| Contract | Why it can't stay |
|---|---|
| `PerpetualExchange` | carbon pricing is in the bytecode; `immutable` oracle/usdc |
| `CopyTracker` | `exchange`, `registry`, `traderStake`, `feeRouter` are all `immutable` |
| `AgentSessionManager` | `exchange` is `immutable` → **session ids restart from 0**, and every VC issued from the frontend `/sessions` page becomes stale |
| `StrategyRegistry` | #97 constraints; and if it redeploys, **every published Allocation is gone** (see §9) |

> `EsgRewardDistributor` and `PepeIncentives` also hold the exchange address as `immutable`. Decide with the team whether they redeploy too, or whether their exchange binding is cosmetic enough to leave. If they redeploy, `EsgRewardDistributor` also needs its payout switched from PEPE to `SustainabilityBadge` (#98) — confirm that's in the version you deploy.

### Stay put (carry over)

`MockUSDC`, `MockUSDT`, `MockOracle` (V1) / `GuardedOracle` (V2), `KYCRegistry`, `InsuranceVault`, `FeeRouter`, `TraderStake`, `AssetVault` / `AssetVaultV2_3`, `PepeToken`, `PepeAMM`, `MockSwapRouter`.

`ESGRegistryV2`, `SustainabilityBadge`, and the V2 `EsgRewardDistributor` are **new deployments** in this cutover — see §2.5.

Prices, KYC state, trader stakes, vault reserves and the tokenised-asset layer all survive because their contracts don't move.

### Breaks the moment step 4.5 lands

Repointing `InsuranceVault.setExchange` / `FeeRouter.setExchange` to the new exchange makes the **old** exchange a venue where losing positions can no longer close or be liquidated (bailout + vault-fee paths revert `NotAuthorized`). This is why draining the old exchange to **zero open positions** (§4) comes first.

### Current Base Sepolia addresses (84532) — the "before" snapshot

From `frontend/src/contracts/addresses.ts` (`BASE_SEPOLIA` block):

```
MockUSDC          0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
MockUSDT          0x5c8A1e970D275Cc269e09A949D68693120416d78
MockOracle        0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3
TraderStake       0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe
InsuranceVault    0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812
FeeRouter         0x00f6cf0113399a7A451c7f85fe094a28092d3e0c
PerpetualExchange 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072   ← redeploys
StrategyRegistry  0x54e8C43f9Eb151Bb8DD6e61d16a969C4D0e73915   ← redeploys (see §9)
CopyTracker       0x96357144fE56c5E0e33e8046bE2A63F45528b210   ← redeploys
MockSwapRouter    0xC9b0e5C219AA1B3eB00E92Fd9a883B182F0AE8Ae
ESGRegistry       0x73310bfb9f93711e9405EB717e3426246BD58618   ← V1; V2 address TBD (§2.5)
KYCRegistry       0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d
AssetVault        0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5

AgentSessionManager (current)  0x4E7cC1B79B72ab72531a6C790e14304370f70764   ← redeploys
AgentSessionManager (OLD/dead) 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8   ← must NOT be authorised on the new exchange (§7)
```

Keep a scratch file open — you'll paste ~5 new addresses into it as you go.

---

## 2. Prepare the deploy scripts (do this on a branch, get it reviewed)

The existing redeploy scripts predate carbon pricing. **They will not produce a correct exchange as-is.**

### 2.1 `contracts/script/RedeployExchange.s.sol`

It currently:
- passes `address(0)` as the third constructor arg (`_esgRegistry`) — the carbon-pricing exchange reads carbon medians from `ESGRegistryV2`, so this must be the **real V2 address**;
- registers only `sBTC / sETH / sAAPL / sTSLA` and KYC-flags `sAAPL / sTSLA` only — #102 needs **all 11 assets** registered and the full KYC set (`sAAPL sTSLA sNVDA sMSFT sGOOGL sICLN sESGU sBOND`, i.e. every `regulated: true` asset in `frontend/src/lib/pepefi/assetMeta.ts`);
- has a guard `require(FUNDING_INTERVAL() == 300)` tied to the old funding-bug story — keep or drop depending on whether you're redeploying from the already-fixed exchange.

Update it to:
1. `new PerpetualExchange(USDC, ORACLE, ESG_REGISTRY_V2)`
2. loop-register all 11 `keccak256(symbol)` asset ids (there's no per-asset carbon config on the exchange — it derives fee/leverage from `CarbonTiers` + the registry median at open time, so registration is just "this asset exists")
3. `setRwaAsset(id, true)` for each of the 8 KYC-gated symbols
4. keep the `MAX_PRICE_AGE = 21_600`, `EXECUTION_FEE = 1e14`, `ADL_ENABLED = true`, `setKycRegistry`, `setFeeRouter`, `setInsuranceVault` calls
5. deploy `CopyTracker` + `StrategyRegistry` (new) and wire `exchange.setCopyTracker`, `traderStake.setCopyTracker`, `feeRouter.setCopyTracker` (the script already does the CopyTracker trio — add the new-registry deploy)
6. deploy `AgentSessionManager(newExchange)` and `exchange.setAgentAuthorized(newSessionManager, true)` — **and nothing else in `authorizedAgents`** (the old `0x5Ebcc64C…` is simply never added)
7. leave `InsuranceVault.setExchange` / `FeeRouter.setExchange` as the **last two calls** (irreversible for the old venue)
8. read every wiring back with `require(...)` before returning, and `console.log` all new addresses

`RedeployCopyTracker.s.sol` is a good reference for the env-var + read-back style.

### 2.2 Dry-run it

```bash
cd contracts
DRY_RUN=true forge script script/RedeployExchange.s.sol:RedeployExchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
```

The script surveys the **old** exchange and prints its open-position count. **Do not proceed while it is non-zero** (§4).

### 2.3 `contracts/script/SeedESG.s.sol`

`sBOND`'s scores still say "US Treasuries". #106 (PR #117) updates them to a green-bond profile — confirm that's in the branch you deploy from. If you're on `ESGRegistryV2` (multi-attestation), `SeedESG` targets the V1 `setESG` API and needs a V2 equivalent — check whether a `SeedESGV2` / attestation-seeding script exists; if not, that's a gap to raise.

### 2.5 `ESGRegistryV2` / `SustainabilityBadge` / `EsgRewardDistributor` — deploy scripts do NOT exist yet

The contracts are merged (`contracts/src/ESGRegistryV2.sol`, `SustainabilityBadge.sol`, `EsgRewardDistributor.sol`, `CarbonTiers.sol`) **with tests but no deploy scripts** — `contracts/script/` still only has the V1 `DeployESG.s.sol` / `SeedESG.s.sol`. Part of §2's script work is writing:

| New script | Deploys | Constructor | Order |
|---|---|---|---|
| `DeployESGRegistryV2.s.sol` | `ESGRegistryV2` | `(address admin)` | **before the exchange** (the exchange's 3rd constructor arg) |
| `SeedESGV2.s.sol` | — (attestations) | — | after registry, before exchange |
| `DeploySustainabilityBadge.s.sol` | `SustainabilityBadge` | `(address admin)` | any time before `EsgRewardDistributor` |
| `DeployEsgRewardDistributorV2.s.sol` | `EsgRewardDistributor` | `(address _exchange, address _esgRegistry, address _badge)` | **after the exchange** — it binds the new exchange |

**`ESGRegistryV2` seeding is not `setESG`.** The V2 flow:

1. `registry.grantRole(ATTESTOR_ROLE, <attestor EOA>)` — the admin must grant this **explicitly, per named address**; it is not auto-granted at construction. For the demo's "three agencies disagree" story you grant it to 2–3 EOAs.
2. Each attestor calls `registry.attest(assetId, carbonIntensity, e, s, g, sourceHash)` for all 11 assets. `carbonIntensity` and the source hash come from `docs/data/carbon-intensity.md`; `sourceHash = keccak256(sourceURL + retrievalDate)`.
3. `registry.setMaxAttestationAge(<seconds>)` if the default needs changing — keep it consistent with `frontend/src/lib/pepefi/carbon.ts` `MAX_ATTESTATION_AGE_DAYS` (365).

> **Honesty note for the paper (from #93):** in the demo the "independent" attestor keys are all held by the team. `attest` from distinct addresses makes "three agencies gave 82 / 61 / 79" a real on-chain state, but that's staging, not institutional independence. Say so before you're asked.

Seed **before** deploying the exchange — an exchange opened against an unseeded registry prices every asset at the most conservative tier (`Unrated`: 1×, top fee), which is fail-closed but not what the demo shows.

`CarbonRetirement` / `MockCarbonCredit` (#93's week-4 sacrificeable item) is out of scope for this cutover.

---

## 3. Deploy the chain

Once §2 is reviewed and merged, and §2.2 dry-run reports **0 open positions**:

```bash
cd contracts
forge script script/RedeployExchange.s.sol:RedeployExchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"} \
  -vvv
```

Copy from the console output into your scratch file:

```
PerpetualExchange_NEW    = 0x…
CopyTracker_NEW          = 0x…
StrategyRegistry_NEW     = 0x…
AgentSessionManager_NEW  = 0x…
demo sessionId           = 0
```

The broadcast JSON is at `contracts/broadcast/RedeployExchange.s.sol/84532/run-latest.json` — `jq` it if you need to recover an address later.

**Sanity checks before moving on:**

```bash
cast call $PerpetualExchange_NEW "FUNDING_INTERVAL()(uint256)"      --rpc-url $BASE_SEPOLIA_RPC_URL   # 28800 (8h)
cast call $PerpetualExchange_NEW "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $FEE_ROUTER            "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $TRADER_STK            "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $INS_VAULT             "exchange()(address)"               --rpc-url $BASE_SEPOLIA_RPC_URL   # == PerpetualExchange_NEW
cast call $PerpetualExchange_NEW "authorizedAgents(address)(bool)" $AgentSessionManager_NEW --rpc-url $BASE_SEPOLIA_RPC_URL  # true
# a High-carbon asset is 1x-capped with the top fee; a Low-carbon one is 5x / low fee:
cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"    $(cast keccak "sMSFT") --rpc-url $BASE_SEPOLIA_RPC_URL   # 1
cast call $PerpetualExchange_NEW "tradingFeeBpsForAsset(bytes32)(uint256)"  $(cast keccak "sMSFT") --rpc-url $BASE_SEPOLIA_RPC_URL   # 100
cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"    $(cast keccak "sNVDA") --rpc-url $BASE_SEPOLIA_RPC_URL   # 5
```

---

## 4. Drain the old exchange (do this BEFORE step 3 if the dry-run showed open positions)

1. **Announce** the freeze to anyone with a test wallet.
2. **Stop new opens on the old exchange** — the front end already hides the trading surface in Simple Mode; for Expert Mode, either deploy a frontend build pointing at the new addresses (§8) or accept that opens keep working until §8 lands. New opens on the old exchange during the window just become more positions to drain.
3. Re-run `DRY_RUN=true forge script … RedeployExchange` and read the open-position count and owners.
4. Have each owner **close** their positions (or liquidate what's liquidatable) until the dry-run reports **0**.
5. Have each owner **withdraw free margin** from the old exchange:
   ```bash
   cast send $OLD_EXCHANGE "withdrawMargin(uint256)" <amount> --private-key <owner_key> --rpc-url $BASE_SEPOLIA_RPC_URL
   ```
6. Only now run step 3's `--broadcast`.

If you *must* proceed with open positions (you won't have time to chase everyone), the script logs it as a deliberate choice — those positions lose the insurance backstop. Prefer not to.

---

## 5. Rewiring checklist

Every item from [#102](https://github.com/zuemen/pepelab_onchain_cfd/issues/102). Tick as you go.

| # | Target | Action |
|---|---|---|
| 1 | `frontend/src/contracts/addresses.ts` — `BASE_SEPOLIA` block | Replace `PerpetualExchange`, `StrategyRegistry`, `CopyTracker`, and `ESGRegistry`→V2. **This file is the single source of truth** — the keeper and MCP server read contract addresses from it, not from their own env. |
| 2 | `frontend/src/contracts/abi/*.json` | Re-copy `PerpetualExchange.json`, `CopyTracker.json`, `StrategyRegistry.json`, `AgentSessionManager.json`, and any new-contract ABIs from `contracts/out/`. The carbon-pricing exchange has new functions/events the frontend needs. |
| 3 | `agent/keeper` `settleFunding` target | Reads the exchange address from `addresses.ts` (item 1). Confirm `agent/keeper/run.ts` / `core.ts` pick it up; restart the keeper process/CI. |
| 4 | `agent/mcp-server` contract bindings | Same — reads `addresses.ts`. Restart the MCP server. Verify `open_position` / `close_position` / `get_session` resolve the new exchange + new session manager. |
| 5 | `CopyTracker` upstreams | Done in step 3's script (`exchange` via constructor + `setCopyTracker`; `feeRouter.setCopyTracker`; `traderStake.setCopyTracker`; new `StrategyRegistry` via constructor). Re-verify with the `cast call` checks in §3. |
| 6 | `FeeRouter` authorized callers | `FeeRouter` gates `receivePerformanceFee` / vault-fee routing on `exchange` and `copyTracker` slots — both repointed in step 3. Confirm no separate allow-list needs the new exchange added. |
| 7 | `InsuranceVault` / `KYCRegistry` bindings | `InsuranceVault.setExchange(new)` — done in step 3 (last call). `KYCRegistry` — the **exchange** points at the registry (`setKycRegistry` in step 3), the registry itself doesn't point back, so nothing to change on the registry. |
| 8 | `AgentSessionManager` authorised on the new exchange | `exchange.setAgentAuthorized(AgentSessionManager_NEW, true)` — done in step 3. |
| 9 | **Revoke the old `AgentSessionManager` `0x5Ebcc64C…`** | See §7. |
| 10 | `EsgRewardDistributor` / `PepeIncentives` immutable exchange | If you redeploy them (§1), capture addresses and add to `addresses.ts`. If not, document that their exchange binding is stale-but-harmless. `EsgRewardDistributor` payout: confirm it's `SustainabilityBadge`, not PEPE (#98). |
| 11 | `deploy-base-sepolia.sh` / `seed-*.sh` / `contracts/script/Deploy*.s.sol` | Update any hardcoded old addresses so a future full redeploy is coherent. `DeploySyntheticAssets.s.sol` / `DeployGuardedStack.s.sol` name strings for `sBOND` come from #106. |
| 12 | `MockSwapRouter` pre-funding | `cast send $MockSwapRouter "fundRouter()" --value <ETH> …` (or the token-funding call it exposes) so `/exchange` ETH↔USDC swaps have liquidity. Confirm the amount with the team. |
| 13 | Register the BGRN asset | Covered by "all 11 assets" in step 3 (the id `keccak256("sBOND")` is unchanged — #106 keeps the symbol). Keeper feeds `sBOND`←`BGRN` (from #106). Set the initial oracle price near BGRN's real level (~$48, from `INITIAL_PRICES` / `symbols.ts` seed) so the keeper's first real fetch clears the deviation guard (`KEEPER_REJECT_DEVIATION=0.5`). |

### `agent/.env`

Update if present (most bindings come from `addresses.ts`, but a few are pinned in env):

- `SESSION_MANAGER_ADDRESS` → `AgentSessionManager_NEW`
- `DEMO_SESSION_ID` → `0` (new manager starts fresh; the old `#0` / `#6` don't exist on it)
- `PERP_ADDRESS` (informational) → `PerpetualExchange_NEW`
- `KEEPER_VAULT_ADDRESS` → unchanged (`AssetVault` doesn't move)

---

## 6. Frontend + agent redeploy

```bash
# frontend
cd frontend
yarn install
yarn build            # tsc + vite — must be clean
yarn test             # full vitest suite — must be green
# deploy the build (Vercel or wherever the demo site lives)

# agent
cd ../agent
npm install
npm run typecheck
npm run test          # keeper + signal-api offline tests
# restart: signal-api, keeper (or its CI schedule), mcp-server
```

The keeper's first run against the new exchange writes fresh prices for all 11 assets. Watch its log for `DeviationTooLarge` on `sBOND` — if it rejects, the on-chain seed price is too far from BGRN's real price; fix the seed and let the keeper approach in steps.

---

## 7. Revoke the old `AgentSessionManager` `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8`

**Why:** it's still in the *old* exchange's `authorizedAgents` and was never revoked. It has **no per-session asset allow-list** (`createSessionWithAssets` didn't exist when it was deployed), so any session on it with a budget can put the whole allowance into an asset the user never intended to hold — a live path around the asset gate. See `docs/KNOWN_LIMITATIONS.md` §10.

**On the new exchange:** it's automatically *not* authorised — a fresh `PerpetualExchange` starts with an empty `authorizedAgents` map and step 3 only adds `AgentSessionManager_NEW`. So the new venue is clean by construction.

**On the old exchange** (defence-in-depth while it's still readable):

```bash
cast send $OLD_EXCHANGE "setAgentAuthorized(address,bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 false \
  --private-key "$PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# verify
cast call $OLD_EXCHANGE "authorizedAgents(address)(bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 --rpc-url "$BASE_SEPOLIA_RPC_URL"   # false
```

Also confirm the *current* manager `0x4E7cC1B…` is not carried onto the new exchange unless you deliberately want both (you don't — its `exchange` is immutable and points at the old one, so it can't trade on the new venue anyway).

For the demo "try to exempt a user from the carbon fee → watch it revert" moment: that's a property of the new exchange (there is *no* per-user fee-exemption path — it's a tested absence, `CarbonPricing.t.sol`), not something you configure here.

---

## 8. Demo data — republish the example Allocations

The new `StrategyRegistry` is **empty**. Existing published strategies cannot migrate. You need **at least 3** that each pass the #97 constraints:

- **≥ 3 assets**
- **each weight ≤ 5000 bps (50%)**
- **weights sum to exactly 10000 bps**
- leverage per leg ∈ {1, 2, 5} *and* within the asset's carbon-tier ceiling (High-carbon assets are capped at 1×; use 1× everywhere for the demo to stay clear of that edge)

**Publisher accounts:** decide with the team which EOA(s) publish these, and note them in [#102](https://github.com/zuemen/pepelab_onchain_cfd/issues/102). Per publisher, in order:

1. `StrategyRegistry_NEW.registerTrader("<display name>")` — `publishStrategy` is `onlyRegistered`.
2. If the new registry was constructed with a non-zero `stakeContract` (it takes `_stake` = `TraderStake` in its constructor), the publisher must be **stake-eligible**: `cast call $StrategyRegistry_NEW "isEligible(address)(bool)" <publisher>` must be `true` — top up their `TraderStake` deposit if not. (If `_stake` was `address(0)`, this gate is skipped.)
3. `publishStrategy(Allocation[])` — `Allocation` is `(bytes32 asset, uint256 weightBps, bool isLong, uint256 leverage)`. Enforced: length ≥ 3, no duplicate asset, each `weight ≤ 5000`, `Σ weight == 10000`, `leverage ∈ {1,2,5}`.

Suggested set (carbon tiers per `frontend/src/lib/pepefi/carbon.ts` + `assetMeta.ts`: Low = sNVDA, sAAPL, sETH, sICLN, sBOND; Mid = sESGU; High = sMSFT, sGOOGL, sTSLA, sGOLD, sBTC):

| Strategy | Legs (all long, 1×) | Rationale |
|---|---|---|
| **Low-carbon Conservative** | sICLN 3400 · sBOND 3300 · sNVDA 3300 | three Low-tier assets, lowest weighted carbon, nothing above 34% |
| **Balanced** | sAAPL 2500 · sESGU 2500 · sGOLD 2500 · sETH 2500 | spans Low / Mid / High, four-way even split |
| **Growth** | sNVDA 4000 · sMSFT 3000 · sGOOGL 3000 | tech-weighted; sMSFT + sGOOGL are High-carbon so they're 1×-capped — shows the mechanism biting |

Publish either via `cast send $StrategyRegistry_NEW "publishStrategy(...)"` per strategy, or extend `contracts/script/SeedMarket.s.sol` (it already builds `StrategyRegistry.Allocation[]` variants) and run it against the new registry:

```bash
cd contracts
USDC_ADDR=$USDC EXCHANGE_ADDR=$PerpetualExchange_NEW REGISTRY_ADDR=$StrategyRegistry_NEW \
FEE_ROUTER_ADDR=$FEE_ROUTER STAKE_ADDR=$TRADER_STK \
  forge script script/SeedMarket.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast -vvv
```

Verify: `/marketplace` shows 3 strategies and each can be sorted by weighted carbon intensity.

---

## 9. End-to-end verification (the two checks #102 requires)

### 9.1 A full adopt flow with correct per-asset billing

1. On `/marketplace`, adopt **Balanced** (spans three carbon tiers).
2. Confirm the fee buffer reserved is computed **per `Allocation` leg** (#97) — a mix of Low + High assets must reserve enough that every leg opens; the failure symptom is "opened 2 of 4 legs, then reverted on margin".
3. Open a position on a **High-carbon** asset directly (`sMSFT`) and a **Low-carbon** one (`sNVDA`):
   - `sMSFT` trading fee ≈ `CarbonTiers` High (`tradingFeeBps` 100) and **max leverage 1×** — try 2× and confirm it reverts.
   - `sNVDA` trading fee ≈ Low (`tradingFeeBps` 10), leverage up to 5× accepted.
4. Let a position accrue borrow fee for a bit; confirm the hourly rate matches the tier frozen into the position at open (later attestation changes must **not** retro-change it).

```bash
# fee + leverage cap the exchange will apply, per asset
for s in sNVDA sMSFT sBOND sESGU; do
  lev=$(cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"   $(cast keccak "$s") --rpc-url $BASE_SEPOLIA_RPC_URL)
  fee=$(cast call $PerpetualExchange_NEW "tradingFeeBpsForAsset(bytes32)(uint256)" $(cast keccak "$s") --rpc-url $BASE_SEPOLIA_RPC_URL)
  echo "$s  maxLev=$lev  tradingFeeBps=$fee"
done
# expect: sNVDA/sBOND Low (5, 10) · sESGU Mid (2, 40) · sMSFT High (1, 100)
```

### 9.2 Expert Mode — all 11 pages still work after the redeploy

Expert Mode is in the oral defence. Walk every page connected to a real wallet on Base Sepolia:

`TradeTerminalPage` · `WhaleTrackerPage` · `TraderDashboard` · `TraderStakePage` · `RewardsPage` · `VaultPage` · `AgentMonitorPage` · `X402DocsPage` · `AdminKYCPage` · `AdminOraclePage` · `AdminTreasuryPage`

Watch for: blank panels (stale ABI), "wrong network" where there shouldn't be, admin pages that can't read owner-only state (deployer key mismatch), the agent monitor showing no sessions (expected — session ids reset; create a fresh demo session).

### 9.3 The "non-discretion" demo moment

From the deployer (owner) account, attempt to give a specific user a reduced carbon fee. There is no function for it — the closest call reverts or doesn't exist. That's the live proof of the thesis sentence; rehearse exactly which call you'll type.

---

## 10. If it fails partway

| Failed at | Recovery |
|---|---|
| §2 dry-run shows open positions | Not a failure — drain (§4), retry. Nothing was sent. |
| §3 broadcast reverts mid-script | `forge` scripts are **not atomic across transactions**. Read `run-latest.json` to see which txs landed. If the exchange deployed but wiring didn't finish, you can finish the setters manually with `cast send` (they're all `onlyOwner`). Do **not** re-run the whole script — you'll get a second exchange. |
| §4.5 `InsuranceVault.setExchange` landed but something later broke | The old venue is already degraded. Push forward — fix the remaining wiring with `cast send`, don't try to revert. |
| Frontend build red after §5 | The ABI copy is the usual culprit. `contracts/out/<Name>.sol/<Name>.json` → `frontend/src/contracts/abi/<Name>.json`. |
| Keeper rejects `sBOND` price | Seed price too far from BGRN real (~$48). Update the on-chain price closer with `cast send $ORACLE "setPrice(bytes32,uint256)" $(cast keccak "sBOND") <price_8dec>` and let the keeper converge. |

There is **no clean rollback** past §4.5. That's why the drain and the dry-run gate exist.

---

## 11. Sign-off checklist

- [ ] #117 (#106) merged
- [ ] §2 script work done + reviewed + merged: updated `RedeployExchange.s.sol`; **new** `DeployESGRegistryV2` / `SeedESGV2` / `DeploySustainabilityBadge` / `DeployEsgRewardDistributorV2` scripts
- [ ] `ESGRegistryV2` deployed; `ATTESTOR_ROLE` granted; 11 assets attested (× each attestor EOA)
- [ ] `SustainabilityBadge` + V2 `EsgRewardDistributor` deployed (distributor after the exchange)
- [ ] Old exchange drained to 0 open positions; free margin withdrawn
- [ ] `RedeployExchange` broadcast; 5 new addresses captured
- [ ] `cast call` sanity checks in §3 all pass
- [ ] `addresses.ts` + ABIs updated; frontend `yarn build` + `yarn test` green; site redeployed
- [ ] agent `npm run typecheck` + `npm run test` green; keeper / signal-api / mcp-server restarted
- [ ] keeper wrote fresh prices for all 11 assets, no `DeviationTooLarge`
- [ ] old `0x5Ebcc64C…` shows `agentAuthorized == false` on the old exchange; not present on the new one
- [ ] `MockSwapRouter` funded
- [ ] 3 demo Allocations published; `/marketplace` sorts by weighted carbon
- [ ] §9.1 per-asset billing verified (High-carbon 1×-capped, Low-carbon 5×)
- [ ] §9.2 all 11 Expert Mode pages walked
- [ ] §9.3 fee-exemption revert rehearsed
- [ ] `#102` updated with the new addresses + publisher accounts

---

## Appendix — want this as an interactive wizard?

The mechanical parts (address propagation into `addresses.ts` + `agent/.env`, the `cast call` verification sweep, the demo-strategy publish) can be wrapped in a stage-gated bash wizard that opens each explorer link, captures each address, writes it where it belongs, and confirms before every irreversible `cast send`. Ask and it can be generated into `scripts/`. The deploy itself (`forge script … --broadcast`) stays a manual step you run and read — it needs your judgement on gas, reverts, and the open-position count.
