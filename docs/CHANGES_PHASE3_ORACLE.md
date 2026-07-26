# Patch Changes — Phase 3: Oracle Adapters (Chainlink + Pyth) (2026-06)

對應 `docs/DESIGN_x402_AI_AGENT.md` 第 4 節「Oracle → Chainlink/Pyth」與 Phase 3。
把單點 owner 更新的 MockOracle 升級為真去中心化預言機：兩個 **drop-in 介接合約**
（Chainlink 給 crypto、Pyth 給合成/股票資產），**核心皆零改動**。

**測試基準**：239 → 249（Chainlink）→ **259 passed, 0 failed**（再加 Pyth 10 個）。

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
- **合成股票/ESG 資產**（sAAPL、sTSLA…）：Chainlink 測試網多無對應 feed → 改用下方 Pyth。

---

## Pyth 介接（`contracts/src/PythOracleAdapter.sol`）

同樣是 **drop-in `IOracle`**（`getPrice` 8-dec + `isStale`），核心零改動，補上 Chainlink
在測試網缺的合成/股票資產（Pyth 有 AAPL、TSLA 等 feed）。

- `constructor(address _pyth)`：注入 Pyth 合約；`mapping(bytes32 => bytes32) priceIds`
  把 assetId → Pyth price id，`setPriceId(onlyOwner)` 管理，emit `PriceIdSet`。
- 讀 `getPriceUnsafe(id)` 拿 Pyth 的 `(mantissa, expo, publishTime)`，依
  `value = mantissa * 10^expo` **正規化成 8-dec**（scale by `10^(expo+8)`，向上或向下）；
  `price <= 0` → `InvalidPrice`，未設 id → `PriceIdNotSet`。
- Pyth 是 **pull 型**：實際上鏈價格由 keeper 先 `updatePriceFeeds`（payable）推送，
  adapter 只負責 view 讀取；鏈上時效一樣由 exchange `maxPriceAge` 把關，`isStale`
  以 24h 對齊 MockOracle。

測試（`contracts/test/PythOracleAdapter.t.sol`，10 個）：權限、expo -8/-5/-10 三種正規化、
`PriceIdNotSet`/`InvalidPrice`、24h 時效、以 adapter 部署 exchange 開倉的 drop-in 整合。
測試用 `contracts/test/MockPyth.sol`。ABI 置於
`frontend/src/contracts/abi/PythOracleAdapter.json`。

選用建議：**crypto 資產走 Chainlink、合成/股票走 Pyth**，按 asset 在部署時各設各的
adapter（或未來做一個 router 依 assetId 分流，屬選用加項）。

---

## 尚未處理（Phase 3 剩餘）

- `Deploy.s.sol` 切換成真 adapter（目前仍預設 MockOracle 以保 testnet demo）。
- FeeRouter permissionless 收入入口（讓 x402 收入真正上鏈分潤；屬「新增方法」，待拍板）。
- agent 風控監控面板。
