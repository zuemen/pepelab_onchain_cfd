# Patch Changes — Phase 3: Chainlink Oracle Adapter (2026-06)

對應 `docs/DESIGN_x402_AI_AGENT.md` 第 4 節「Oracle → Chainlink/Pyth」與 Phase 3。
把單點 owner 更新的 MockOracle 升級為真去中心化預言機的第一步：一個 **drop-in 的
Chainlink 介接合約**，**核心零改動**。

**測試基準**：239 → **249 passed, 0 failed**（新增 `ChainlinkOracleAdapter.t.sol` 10 個）。

---

## 新增（`contracts/src/ChainlinkOracleAdapter.sol`）

- 實作與 `MockOracle` 完全相同的對外介面：`getPrice(bytes32) → (uint256 price 8-dec,
  uint256 updatedAt)` 與 `isStale(bytes32)`。`PerpetualExchange` 的 `oracle` 是 constructor
  的 immutable `IOracle`，因此**部署時把 exchange 指向本 adapter 即可換上 Chainlink，
  核心合約一行不改**。
- `mapping(bytes32 => address) feeds`：assetId → Chainlink AggregatorV3 feed，
  `setFeed(assetId, feed) onlyOwner` 管理，emit `FeedSet`。
- 讀 `latestRoundData()`，把任意小數位的 feed 答案**正規化成 8 位**（MockOracle 慣例）；
  `answer <= 0` → `InvalidPrice`，未設 feed → `FeedNotSet`。
- `STALE_THRESHOLD = 86400`（24h）對齊 MockOracle；鏈上真正的時效防護仍由
  exchange 的 `maxPriceAge` 把關（上一輪 R2 已加）。

## 測試（`contracts/test/ChainlinkOracleAdapter.t.sol`，10 個）

| 測試 | 驗證 |
|------|------|
| `test_setFeed_onlyOwner` / `_setsAndEmits` | feed 管理權限與設定 |
| `test_getPrice_8decimals_passThrough` | 8-dec feed 原樣 |
| `test_getPrice_normalizesFrom18` / `_From6` | 18/6-dec feed 正規化成 8-dec |
| `test_getPrice_revertsFeedNotSet` / `_InvalidPrice` | 未設 feed / 非正價格 revert |
| `test_isStale_freshIsFalse` / `_oldIsTrue` | 24h 時效判斷 |
| `test_dropIn_perpetualExchangeOpensPosition` | **以 adapter 部署 exchange 並成功開倉**，entryPrice 正規化正確（drop-in 證明） |

測試用 `contracts/test/MockAggregatorV3.sol`（模擬 Chainlink feed，可設答案/時間/小數位）。
ABI 置於 `frontend/src/contracts/abi/ChainlinkOracleAdapter.json`。

---

## 上線用法 & 尚未處理

- **部署**：把 `Deploy.s.sol` 中 `new PerpetualExchange(usdc, oracle)` 的 `oracle` 換成
  `new ChainlinkOracleAdapter()`，再對每個有 Chainlink feed 的資產 `setFeed(assetId,
  feedAddr)`。Base / Ethereum 主網的 BTC/USD、ETH/USD 等 feed 位址見 Chainlink 文件。
  （本 patch 未改 Deploy.s.sol 預設仍用 MockOracle，避免影響現有 testnet demo；
  上 mainnet 時切換即可。）
- **合成股票/ESG 資產**（sAAPL、sTSLA…）：Chainlink 測試網多無對應 feed，未設 feed 的
  資產會 `FeedNotSet`。可改接 **Pyth**（pull 型，需先 post update data 再讀
  `getPriceNoOlderThan`）；adapter 介面相同的 Pyth 版本可作為後續加項。
- Pyth 介接合約（同 `IOracle` 介面）留待需要合成資產真實報價時再實作。
