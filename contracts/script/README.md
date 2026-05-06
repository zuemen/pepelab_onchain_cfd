# Deployment Scripts

## 快速部署（本地 Anvil）

確認 Anvil 已在 `http://localhost:8545` 執行，然後在專案根目錄執行：

```bash
anvil &          # 若尚未啟動
bash deploy-anvil.sh
```

腳本會依序：
1. `forge build` — 編譯所有合約
2. `forge script Deploy.s.sol --broadcast` — 部署到本地節點
3. 解析 broadcast JSON，取出各合約地址
4. 將 ABI JSON 複製到 `frontend/src/contracts/abi/`
5. 產生 `frontend/src/contracts/addresses.ts`

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
