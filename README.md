# PepeFi On-Chain CFD

A proof-of-concept perpetual CFD (Contract for Difference) protocol deployed on Sepolia testnet, built as an NCCU Capstone 2026 project.

## Architecture

| Layer | Component | Role |
|---|---|---|
| Core | `PerpetualExchange` | Open/close positions, margin management |
| Oracle | `PriceOracle` | Keeper-updated price feed |
| Liquidity | `LiquidityVault` | LP deposits, PnL settlement |
| Fees | `FeeRouter` | 70/20/10 split (trader / platform / vault) |
| Copy Trading | `CopyTracker` | Follow/unfollow traders, mirror positions |
| Staking | `TraderStake` | Reputation stake with slashing |
| Swap | `MockSwapRouter` | Bidirectional ETH ↔ mUSDC at 1 ETH = 3000 USDC |

## Features

- **Long / Short positions** with configurable leverage (1×–10×)
- **Copy trading** — follow a trader, positions mirror automatically
- **LP Vault** — provide liquidity and earn from spread/fees
- **Trader staking** — stake ETH as reputation collateral
- **Bidirectional swap** — ETH → mUSDC (mint) and mUSDC → ETH (burn + send)
- **Admin treasury** — claim accumulated platform fees, convert to ETH
- **On-chain history** — queryFilter-based event log across all contracts

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
| `TraderFollowed` / `TraderUnfollowed` | CopyTracker |
| `CopyFeeDistributed` | FeeRouter |
| `PriceUpdated` | PriceOracle |
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

## Deployment (Sepolia)

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --broadcast --verify
# Then update frontend/src/contracts/addresses.ts with new addresses
# Pre-fund swap router:
# cast send <SwapRouter> "fundRouter()" --value 1ether --rpc-url $SEPOLIA_RPC
```

## Stack

- Solidity 0.8.20 + Foundry
- React 18 + TypeScript + Vite
- ethers.js v6
- Tailwind CSS v3
- MetaMask (EIP-1193)

## Disclaimer

Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
