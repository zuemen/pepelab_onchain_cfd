# Patch Changes — Security Hardening Round 2 (2026-06)

整體目標：在加新功能（x402 / AI Agent）之前，先把核心永續引擎的安全性與正確性補齊。
本輪不新增業務功能，只在既有結構內修補 5 個安全/正確性問題，並補上 12 個回歸測試。

**測試基準**：修補前 203 tests passed → 修補後 **215 tests passed, 0 failed**。

---

## SEC #1 — PerpetualExchange 缺少 ReentrancyGuard，且違反 CEI

**檔案：** `contracts/src/PerpetualExchange.sol`

問題：`_closePosition` 在更新 `freeMargin` 之前就對 `insuranceVault.bailout()` 做外部呼叫，又對
`feeRouter` 做 `transfer` + 回呼，屬教科書級的 Checks-Effects-Interactions 違反。
雖然目前 USDC 是 mock 不會 reenter，但審查者一眼會看到。

修補：
- 合約改為 `is Ownable, ReentrancyGuard`（OpenZeppelin）。
- 為所有資金流動函式加上 `nonReentrant`：`depositMargin`、`depositMarginFor`、`withdrawMargin`、
  `openPosition`、`openPositionFor`、`closePosition`、`closePositionFor`、`liquidatePosition`、
  `withdrawExecutionFees`。
- 重構 `_closePosition` 與 `liquidatePosition` 為嚴格 CEI 順序：先把 `isOpen`、OI、`freeMargin`
  全部更新完，最後才做 `bailout` / `transfer` / `depositFromProtocol` 等外部呼叫。
- 額外修補：績效費 `perfFee` 不得使 `closeAmount` 轉負（原碼有潛在 `uint(int)` underflow 風險）。

## SEC #2 — MockUSDC.setSwapRouter 無權限控制

**檔案：** `contracts/src/MockUSDC.sol`

問題：`setSwapRouter` 為 `external` 無修飾子，任何人都能搶先設定 router 並取得 `burnFrom` 權限。
`mint` 也完全 public。

修補：
- `MockUSDC` 改為 `is ERC20, Ownable`，`setSwapRouter` 加上 `onlyOwner`。
- `mint` 維持 public（部署腳本與測試需要），但在合約頂部加上 **TESTNET-ONLY** 警語，明確標註
  「絕不可部署到 production」。
- `script/Deploy.s.sol` 由部署者（owner）呼叫 `setSwapRouter`，行為不變，測試全綠。

## SEC #3 — 讀取預言機價格時未檢查時效（stale price）

**檔案：** `contracts/src/PerpetualExchange.sol`

問題：開倉/平倉/清算都直接 `oracle.getPrice()`，未檢查 `updatedAt`。Keeper 掛掉時會用陳舊價格
清算或結算，是 DeFi 經典漏洞。

修補：
- 新增 `maxPriceAge`（預設 `24 hours`）與 `setMaxPriceAge(uint256)`（onlyOwner）。
- 新增內部 helper `_freshPrice` / `_requireFresh`，超過 `maxPriceAge` 即 `revert StalePrice(asset, updatedAt)`。
- 在 `_openPosition`、`_closePosition`、`liquidatePosition` 三條 state-changing 路徑上強制檢查。
- View 函式（`getUnrealizedPnL` 等）刻意保持寬鬆，前端仍可用陳舊資料渲染。

## SEC #4 — 資金費率僅在平倉一次性結算，無人 crank 即失效

**檔案：** `contracts/src/PerpetualExchange.sol`

問題：`settleFunding` 任何人可呼叫但無誘因，且 funding index 只在有人呼叫時才累積。
若沒人定期呼叫，funding 機制實際失效；trader 也可能 frontrun settle 規避費用。

修補：
- 拆出 `_pokeFunding(asset)`：依「自上次更新以來經過的完整 interval 數」一次補齊累積
  （`intervals = (now - last) / FUNDING_INTERVAL`），不再只結算一個區間。
- 在 `_openPosition` / `_closePosition` / `liquidatePosition` 開頭自動呼叫 `_pokeFunding`，
  funding 不再依賴利他的外部 caller。
- 開倉時先 poke 再鎖 `entryFundingIndex`，確保新倉位不被收取開倉前的歷史 funding。
- `settleFunding` 保留為 permissionless crank，向後相容（既有 `Funding.t.sol` 全綠）。

## SEC #5 — 清算無清算人獎勵，實務上無人會呼叫

**檔案：** `contracts/src/PerpetualExchange.sol`

問題：`liquidatePosition` 把剩餘抵押全數送進金庫，清算人連 gas 都拿不回來，
協議償付能力靠運氣。

修補：
- 新增常數 `LIQUIDATION_REWARD_BPS = 500`（剩餘抵押的 5%）。
- 清算時將剩餘抵押拆分：5% → `msg.sender`（清算人獎勵），95% → InsuranceVault。
- `test_liquidation_remainderGoesToVault` 僅斷言 `assertGt`，行為相容；新測試另外驗證
  5/95 拆分精確成立。

---

## 新增測試（`contracts/test/SecurityFixes.t.sol`，12 個）

| 測試 | 驗證項目 |
|------|----------|
| `test_setSwapRouter_revertsForNonOwner` | SEC#2 非 owner 無法設定 router |
| `test_setSwapRouter_ownerSucceedsOnce` | SEC#2 owner 可設定一次 |
| `test_openPosition_revertsOnStalePrice` | SEC#3 開倉拒絕陳舊價格 |
| `test_closePosition_revertsOnStalePrice` | SEC#3 平倉拒絕陳舊價格 |
| `test_closePosition_succeedsAfterOracleRefresh` | SEC#3 Keeper 更新後恢復正常 |
| `test_setMaxPriceAge_onlyOwner` | SEC#3 maxPriceAge 權限 |
| `test_funding_autoSettledOnClose` | SEC#4 平倉時自動結算（無人 crank） |
| `test_settleFunding_accruesMultipleIntervals` | SEC#4 多區間一次補齊 |
| `test_newPosition_notChargedForPastFunding` | SEC#4 新倉不付歷史 funding |
| `test_liquidation_paysRewardToCaller` | SEC#5 清算人獲得 5% 獎勵、5/95 拆分 |
| `test_liquidation_revertsOnStalePrice` | SEC#3/#5 不在陳舊價格上清算 |
| `test_withdrawMargin_reentrancyBlocked` | SEC#1 惡意 token 重入被擋下 |

---

## 尚未處理（建議下一輪）

- 預言機目前仍是單點 owner 更新的 mock。`maxPriceAge` 已能擋陳舊資料，但真正的去中心化
  需接 Chainlink / Pyth。屬架構升級，非本輪範圍。
- `executionFee` 收進合約後僅 owner 可提，未分潤給 Keeper。可在 x402 整合時一併設計
  agent / keeper 的付費結算。
