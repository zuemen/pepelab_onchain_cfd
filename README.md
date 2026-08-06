# PepeFi On-Chain CFD

A proof-of-concept perpetual CFD (Contract for Difference) protocol deployed on **Base Sepolia** testnet, built as an NCCU Capstone 2026 project.

## Networks

| Network | Status | Notes |
|---|---|---|
| **Base Sepolia (84532)** | ✅ Active — primary deployment | Price keeper runs via GitHub Actions |
| Sepolia (11155111) | ⚠️ Secondary — **still being fed** | `price-keeper.yml` 每 15 分鐘仍在更新它的 MockOracle + GuardedOracle |

> **2026-08-06 更正**：本表先前寫 Sepolia「Oracle no longer updated; contracts
> frozen by stale-price guard」。那是錯的 —— `.github/workflows/price-keeper.yml`
> 一直都在跑，從未停用。正確的說法是「Sepolia 不再是主要部署，但喂價仍在運作」；
> 上面所有 V2 金庫（`AssetVaultV2*`）與 GuardedOracle 的展示都依賴它活著。

## Architecture

| Layer | Component | Role |
|---|---|---|
| Core | `PerpetualExchange` | Open/close positions, margin, funding, liquidation |
| Oracle | `MockOracle` | Keeper-updated price feed (Chainlink / Pyth / Aggregator adapters available) |
| Liquidity | `InsuranceVault` | LP deposits (pIV shares), bailouts, liquidation remainder |
| Fees | `FeeRouter` | 70/20/10 split (trader / platform / vault) |
| Copy Trading | `CopyTracker` | Follow/unfollow traders, mirror positions |
| Staking | `TraderStake` | Reputation stake with slashing |
| Swap | `MockSwapRouter` | Bidirectional ETH ↔ mUSDC at 1 ETH = 3000 USDC |

## Deployed Contracts (Base Sepolia)

Source of truth: `frontend/src/contracts/addresses.ts`

| Contract | Address |
|---|---|
| PerpetualExchange | `0xef75eca6514ce96b18382e921ac6190a0cf8c072` |
| MockOracle | `0xed90c4f3b48213888870c1fc8486921cb0990aa3` |
| InsuranceVault | `0xb364e2e3e1e7a2b033ef03a4accef42066f3d812` |
| FeeRouter | `0x00f6cf0113399a7a451c7f85fe094a28092d3e0c` |
| MockUSDC | `0x69fd695bc7c3afdb35aba35cd6890c506400b035` |
| MockSwapRouter | `0xc9b0e5c219aa1b3eb00e92fd9a883b182f0ae8ae` |
| CopyTracker | `0x96357144fe56c5e0e33e8046be2a63f45528b210` |
| StrategyRegistry | `0x54e8c43f9eb151bb8dd6e61d16a969c4d0e73915` |
| TraderStake | `0x01aeb530bcfc69f036309ffe55acc7ea6c5a28fe` |
| AgentSessionManager | `0x4E7cC1B79B72ab72531a6C790e14304370f70764` |
| KYCRegistry | `0x5d95fd9e7a5f80e5369e24783f1f98e0f952360d` |

> **AgentSessionManager 位址更正（2026-08-06）**：本表先前寫舊的
> `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8`，與前端／agent 實際使用的位址不符。
> 舊 manager **沒有 per-session 資產白名單**，照舊值建 session 等於少一道資產閘門。
> 舊 manager 目前仍在 exchange 的 `authorizedAgents` 名單中且從未撤權。

## Features

- **Long / Short positions** with configurable leverage (1×–5×, per-asset overrides)
- **Funding rate** — OI-imbalance driven, 0.75% cap per interval.
  Source 的 `FUNDING_INTERVAL` 是 **8h**（→ 2.25%/日上限），但 ⚠️ **已部署的
  bytecode 仍是 300 秒（5 分鐘）**：2026-08-06 對 `0xEf75…c072` 實測
  `FUNDING_INTERVAL() = 300`，同樣的 0.75% 上限在 5 分鐘週期下是 **≈216%/日**。
  `FUNDING_INTERVAL` 是 `constant`，改 source 不會改動已部署的合約 ——
  **必須重新部署 exchange 才會生效**。在那之前不要以 8h 的數字向任何人描述本協議。
- **Liquidation engine** — permissionless, 5% maintenance margin, liquidator reward
- **Insurance vault** — LP shares (pIV), bailout floor, optional auto-deleveraging (ADL)
- **Copy trading** — follow a trader, positions mirror automatically, slashing on big losses
- **Trader staking** — stake ETH as reputation collateral
- **RWA / KYC gating** — flagged assets require KYC verification (opt-in)
- **Bidirectional swap** — ETH → mUSDC (mint) and mUSDC → ETH (burn + send)
- **On-chain history** — queryFilter-based event log across all contracts

## Price Keeper

Prices are pushed to `MockOracle` by a GitHub Actions workflow
(`.github/workflows/base-sepolia-keeper.yml`) on a 15-minute cron, plus a
`settleFunding` crank. The exchange rejects prices older than `maxPriceAge`
on every state-changing call.

**資料來源（2026-08-06 更正）**：本節先前寫「CoinGecko / Stooq + ±45% move
guard」，那描述的是 master 的舊版行內 bash keeper。現況是：

| 來源 | 用途 |
|---|---|
| **Pyth relay**（`AggregatorOracleAdapter 0x8215…813D`） | sBTC / sETH —— 讀鏈上去中心化預言機 |
| **Yahoo Finance** | 其餘資產（測試網沒有 Pyth feed） |
| ~~Stooq~~ | ❌ **已死** —— CI log 實證回傳 HTML 404，`parseFeedValue` 會擋下 |
| ~~CoinGecko~~ | 不再用於喂價（前端顯示仍可能用到） |

實作是單一份 `agent/keeper/run.ts`（有單元測試），偏離保護由 `core.ts` 的
`stepTowards` 處理，不是舊的 ±45% 硬閘門。

> Pyth relay 是**受信任的中繼，不是無信任的整合**：keeper 的金鑰仍可寫任何值。
> 它拿掉的是對中心化交易所 API 的依賴，不是對 keeper 的依賴。

Before a live demo, trigger the workflow manually (Actions → Base Sepolia
Keeper → Run workflow) to guarantee fresh prices.

## On-Chain Auditability

Every state-changing action emits a Solidity event. The `/history` page replays those events client-side via ethers.js `queryFilter` so anyone can verify the full activity log without trusting a backend.

```ts
// Example: fetch last 5000 blocks of PositionOpened for any user
const filter = exchange.filters.PositionOpened(null, null, null)
const logs   = await exchange.queryFilter(filter, -5000)
```

Events covered:

| Event | Contract |
|---|---|
| `SwapEthToUsdc` / `SwapUsdcToEth` | MockSwapRouter |
| `PositionOpened` / `PositionClosed` | PerpetualExchange |
| `MarginDeposited` / `MarginWithdrawn` | PerpetualExchange |
| `PositionLiquidated` / `FundingSettled` | PerpetualExchange |
| `TraderFollowed` / `TraderUnfollowed` | CopyTracker |
| `CopyFeeDistributed` | FeeRouter |
| `PriceUpdated` | MockOracle |
| `Staked` / `Slashed` | TraderStake |

## Development

```bash
# Contracts
cd contracts
forge build
forge test

# Frontend — yarn only（package.json 有 "packageManager": "yarn@1.22.22"）
# 用 npm 會產生一份沒有任何流程會驗證的 package-lock.json，且 npm 會忽略
# package.json 裡的 "resolutions"（安全 pin 就在那裡）。
cd frontend
yarn install --frozen-lockfile
yarn dev

# Agent
cd agent
npm ci
npm test
```

## Deployment (Base Sepolia)

```bash
./deploy-base-sepolia.sh
# Then update frontend/src/contracts/addresses.ts with new addresses
# Pre-fund swap router:
# cast send <SwapRouter> "fundRouter()" --value 1ether --rpc-url $BASE_SEPOLIA_RPC
```

## Design Notes / Known Trade-offs

- Liquidation currently forfeits the position's remaining collateral
  (5% to the liquidator, remainder to the InsuranceVault) instead of
  refunding the owner — intentional simplification for the prototype.
- `MockUSDC.mint` is unrestricted (test convenience); the faucet
  (1,000 mUSDC / 24h) is the intended user path.
- ADL and portfolio margin are opt-in flags, off by default.

## Stack

- Solidity 0.8.20 + Foundry (OpenZeppelin v5)
- React 19 + TypeScript + Vite + MUI
- ethers.js v6
- MetaMask (EIP-1193)

## Security Status

本專案於 2026-08-06 做過一次全面稽核，結果與待辦清單在
[`docs/audit/AUDIT_2026-08-06.md`](docs/audit/AUDIT_2026-08-06.md)。

**在下列項目解決前，不建議對外做 live demo：**

1. Deployer / owner 私鑰在 public repo 的 git 歷史中，且仍是四個合約的 owner
   → [`docs/RUNBOOK_KEY_ROTATION.md`](docs/RUNBOOK_KEY_ROTATION.md)
2. 線上 `FUNDING_INTERVAL` 是 300 秒而非 source 的 8h（見上方 Features 說明）
3. `PepeAMM` 是零滑點預言機定價，不是恆定乘積 AMM
4. `MockUSDC.mint` 無權限控管

## Disclaimer

Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
