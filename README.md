# PepeFi On-Chain CFD

A proof-of-concept perpetual CFD (Contract for Difference) protocol deployed on **Base Sepolia** testnet, built as an NCCU Capstone 2026 project.

## Networks

| Network | Status | Notes |
|---|---|---|
| **Base Sepolia (84532)** | ✅ Active — primary deployment | Price keeper runs via GitHub Actions |
| Sepolia (11155111) | ⚠️ Deprecated | Oracle no longer updated; contracts frozen by stale-price guard |

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
| AgentSessionManager | `0x5ebcc64c712c5a26119789dcbd0753981dc518e8` |
| KYCRegistry | `0x5d95fd9e7a5f80e5369e24783f1f98e0f952360d` |

## Features

- **Long / Short positions** with configurable leverage (1×–5×, per-asset overrides)
- **Funding rate** — 8h interval, OI-imbalance driven, 0.75% cap per interval
- **Liquidation engine** — permissionless, 5% maintenance margin, liquidator reward
- **Insurance vault** — LP shares (pIV), bailout floor, optional auto-deleveraging (ADL)
- **Copy trading** — follow a trader, positions mirror automatically, slashing on big losses
- **Trader staking** — stake ETH as reputation collateral
- **RWA / KYC gating** — flagged assets require KYC verification (opt-in)
- **Bidirectional swap** — ETH → mUSDC (mint) and mUSDC → ETH (burn + send)
- **On-chain history** — queryFilter-based event log across all contracts

## Price Keeper

Prices are pushed to `MockOracle` by a GitHub Actions workflow
(`.github/workflows/base-sepolia-keeper.yml`) on a 15-minute cron:
real market data from CoinGecko / Stooq, a ±45% move guard, plus a
`settleFunding` crank and vault solvency logging. The exchange rejects
prices older than `maxPriceAge` on every state-changing call.

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

# Frontend
cd frontend
npm install
npm run dev
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

## Disclaimer

Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
