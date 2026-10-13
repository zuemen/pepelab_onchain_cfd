# Deployment Scripts

## 快速部署（本地 Anvil）

```bash
anvil &
cd contracts && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
cd ../agent && npx tsx heroes/writeAddresses.ts
```

`DeployLocalDemo` 只能在 chainId 31337 執行：平台整套合約、11 個資產、開啟碳定價。
`writeAddresses.ts` 把位址寫回 `frontend/src/contracts/addresses.ts` 的本機鏈區塊，並輸出
`heroes/out/addresses.json`。要連同模擬交易者的歷史一起建出來，用 `scripts/heroes-replay.sh`
（見 `heroes/README.md`）。

根目錄的 `deploy-anvil.sh`／`seed-anvil.sh` 已過時，執行會直接中止。

---

## 部署順序與設定

| # | 合約 | 建構參數 |
|---|------|---------|
| 1 | `MockUSDC` | — |
| 2 | `MockOracle` | — |
| 3 | `oracle.addAsset` × 4 | sBTC/sETH/sAAPL/sTSLA（8-decimal 價格） |
| 4 | `PerpetualExchange` | `(usdc, oracle)` |
| 5 | `StrategyRegistry` | — |
| 6 | `CopyTracker` | `(usdc, exchange, registry)` |
| 7 | `exchange.setCopyTracker(ct)` | — |

> **Oracle 價格格式**：使用 8-decimal（例如 `$50,000 = 50_000e8`）。
> `PerpetualExchange` 在讀取時會乘以 `1e10` 轉為 18-decimal 儲存。

---

## Asset IDs

合成資產 ID 是資產符號字串的 `keccak256` 雜湊，與 Solidity `keccak256("sBTC")` 一致。

```bash
cast keccak "sBTC"   # sBTC asset ID
cast keccak "sETH"   # sETH asset ID
cast keccak "sAAPL"  # sAAPL asset ID
cast keccak "sTSLA"  # sTSLA asset ID
```

---

## 手動部署（Testnet）

```bash
# 設定環境變數
export PRIVATE_KEY=<your-private-key>
export RPC_URL=https://sepolia.infura.io/v3/<your-key>

cd contracts
forge script script/Deploy.s.sol \
    --rpc-url   "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    --verify \
    --etherscan-api-key "$ETHERSCAN_KEY" \
    -vvv
```

---

## 前端整合

部署後，`frontend/src/contracts/` 目錄結構：

```
frontend/src/contracts/
├── addresses.ts          ← 所有合約地址 + Asset IDs（TypeScript）
└── abi/
    ├── MockUSDC.json
    ├── MockOracle.json
    ├── PerpetualExchange.json
    ├── StrategyRegistry.json
    └── CopyTracker.json
```

在前端使用 ethers.js v6：

```typescript
import { ethers } from "ethers";
import { CONTRACT_ADDRESSES, ASSET_IDS } from "@/contracts/addresses";
import ExchangeABI from "@/contracts/abi/PerpetualExchange.json";

const provider = new ethers.BrowserProvider(window.ethereum);
const signer   = await provider.getSigner();

const exchange = new ethers.Contract(
  CONTRACT_ADDRESSES.PerpetualExchange,
  ExchangeABI,
  signer
);
```
