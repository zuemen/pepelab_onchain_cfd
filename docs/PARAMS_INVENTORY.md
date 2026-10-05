# 參數盤點（Phase 0：風險模型＋Besu 部署計畫）

> 盤點日期：2026-10-05。原始碼基準：`master` 24b515b。鏈上基準：Base Sepolia（84532）區塊 47714342，以公開 RPC 唯讀 `cast call` 讀取（沒有用任何私鑰）。
> 行號都是相對 repo 根目錄的 `檔案:行號`；`PerpetualExchange.sol` 指 `contracts/src/PerpetualExchange.sol`。
> **原始碼 ≠ 鏈上。** 依 [`RELEASE_STATUS.md`](RELEASE_STATUS.md)（2026-10-04）：Base Sepolia 有 12 個元件「鏈上＝原始碼」、17 個「原始碼較新（待部署）」。交易引擎鏈上是 #198 版（18,861 B），原始碼是 23,911 B（`docs/RELEASE_STATUS.md:27`）。下表凡是兩邊不同，都分欄標示。

## 0. 符號對照

| 任務書符號 | 程式對應 | 單位／小數 | 位置 |
|---|---|---|---|
| M | `pos.margin`（逐倉保證金，不含開倉手續費） | USDC，18 位小數 | `PerpetualExchange.sol:173` |
| L | `pos.leverage`（整數） | 倍 | `PerpetualExchange.sol:174` |
| S_0 | `pos.entryPrice`：開倉當下的 **mark**（排除自己），`markPremiumCapBps = 0` 時等於 index | 18 位小數（oracle 8 位 × 1e10） | `PerpetualExchange.sol:1791` |
| Q | `size = M·L·1e18 / S_0` | 標的數量，18 位小數 | `PerpetualExchange.sol:2020` |
| S | 結算價：`_markPriceExcluding(pos, index)`，排除自身 OI 的 mark | 18 位小數 | `PerpetualExchange.sol:2017` |
| m | `_maintenanceMarginBps(asset) / 10_000`（逐資產覆寫，預設 500） | bps | `PerpetualExchange.sol:1698-1701` |
| f | `pos.tradingFeeBps / 10_000`（開倉時凍結） | bps | `PerpetualExchange.sol:210` |
| r | `pos.borrowFeeBpsPerHour / 10_000`（開倉時凍結） | bps／小時 | `PerpetualExchange.sol:211` |
| h | `⌊(經過秒數 − 停機秒數) / 3600⌋` | 整數小時 | `PerpetualExchange.sol:1948-1953` |
| Φ | `_calcFunding(pos) = M·L·(I_side − I_entry) / 1e18`（正值＝要付） | USDC | `PerpetualExchange.sol:2085-2096` |

## 1. 槓桿、保證金率與清算

### 1.1 槓桿上限

| 項目 | 原始碼 | 鏈上（Base Sepolia） | 位置 |
|---|---|---|---|
| 全域上限 `MAX_LEVERAGE` | 5（constant） | 5 | `PerpetualExchange.sol:51` |
| 逐資產覆寫 `maxLeverageOf[asset]` | 0＝用全域；setter 上限 5 | 同 | `PerpetualExchange.sol:281`、`:780-784` |
| 有效上限 | `min(覆寫或 5, 碳分級上限)`；碳分級是嚴格度下限，owner 不能往上放寬 | 同 | `PerpetualExchange.sol:1692-1696` |
| 開倉檢查 | `leverage == 0 \|\| leverage > 有效上限` → revert | 同 | `PerpetualExchange.sol:1765` |
| 碳分級停用條件 | `esgRegistry == address(0)` 時回傳全域 `TRADING_FEE_BPS`／`BORROW_FEE_BPS_PER_HOUR`／`MAX_LEVERAGE`，tier 記成 Unrated | 鏈上有接 `esgRegistry`（0xBF5B…），**碳定價生效中** | `PerpetualExchange.sol:1653-1663` |

碳分級表（`CarbonTiers` library 的 internal constant，編譯時內嵌；改它就要重新部署）：

| Tier | 交易手續費 f | 借貸費 r | 最大槓桿 | 位置 |
|---|---|---|---|---|
| Low | 10 bps（0.10%） | 1 bps／h（0.01%） | 5x | `contracts/src/CarbonTiers.sol:97-99` |
| Mid | 40 bps（0.40%） | 4 bps／h（0.04%） | 2x | `contracts/src/CarbonTiers.sol:101-103` |
| High | 100 bps（1.00%） | 10 bps／h（0.10%） | 1x | `contracts/src/CarbonTiers.sol:105-107` |
| Unrated | 與 High **同一列**（最保守） | 同 High | 1x | `contracts/src/CarbonTiers.sol:145-146` |

鏈上實測（區塊 47714342，`maxLeverageForAsset`／`tradingFeeBpsForAsset`）：sETH、sAAPL＝5x／10 bps（Low）；sBTC、sTSLA＝1x／100 bps（High 或 Unrated）。四個資產的 MMR 都是 500。

### 1.2 初始保證金率與維持保證金率

| 項目 | 程式實際 | 位置 |
|---|---|---|
| 初始保證金率 | **沒有獨立參數**。IMR＝1/L（notional＝M·L）。開倉還要求 `freeMargin ≥ M + M·L·f`：開倉手續費從帳戶餘額另外扣，**不從 M 扣** | `PerpetualExchange.sol:1777-1780`、`:1793` |
| 最小保證金 | `MIN_MARGIN = 10e18`（10 USDC，constant） | `PerpetualExchange.sol:52`、`:1752` |
| MMR 預設 | `DEFAULT_MAINTENANCE_MARGIN_BPS = 500`（5%，constant） | `PerpetualExchange.sol:121` |
| MMR 逐資產覆寫 | `setMaintenanceMarginFor(asset, bps)`，bps ≤ 9,999；0＝用預設 | `PerpetualExchange.sol:790-794` |
| MMR 的基數 | **開倉名目 M·L**（固定值），不是現價名目 Q·S | `PerpetualExchange.sol:1171` |

注意：setter 不會檢查 `m < 1/L − f`。若把某資產的 MMR 設到 ≥ 1/L − f，該資產新開的倉位一開就可以被清算（`PerpetualExchange.sol:790-794` 只檢查上限 9,999）。

### 1.3 清算觸發條件（程式中的不等式）

`liquidatePosition` 計算（`PerpetualExchange.sol:1160-1177`）：

```
closeAmount = M + pnl − (tradingFee + borrowFee) − fundingPayment       (:1168)
maintenanceMargin = M·L · mmrBps / 10000                                  (:1171)
if (closeAmount > maintenanceMargin) revert PositionIsHealthy();          (:1175)
```

換成任務書符號，σ = +1（多）／−1（空）：

```
E = M + σ·Q·(S − S_0) − M·L·f − M·(L−1)·r·h − Φ
可清算 ⇔ E ≤ m·M·L
```

- `pnl` 用 `_settlementPnL`，只截斷上方獲利（profit cap），虧損不截，所以清算判斷不受 profit cap 影響（`PerpetualExchange.sol:1979-1995`）。
- f 是**平倉那一側**的手續費（開倉那一側已在開倉時從帳戶餘額扣掉）。
- 借貸費只對借來的部分 M·(L−1) 計，按整數小時、扣掉暫停與 Halted 的時間（`PerpetualExchange.sol:1948-1953`）。
- 所有運算都是整數除法（向零截斷）。

### 1.4 清算價封閉式（本程式下的正確形式）

令 φ = Φ/(M·L) = (I_side − I_entry)/1e18（每單位名目累積資金費，正值＝要付），β = r·h·(L−1)/L（每單位名目累積借貸費）：

| 方向 | 本程式 | 任務書 |
|---|---|---|
| 多單 | **S\* = S_0 · (1 − 1/L + m + f + β + φ)**，S ≤ S\* 時可清算 | S\* = S_0·(1−1/L)/(1−m) |
| 空單 | **S\* = S_0 · (1 + 1/L − m − f − β − φ)**，S ≥ S\* 時可清算 | （對稱形式）S_0·(1+1/L)/(1+m) |

差異與原因：

1. **MMR 的基數不同。** 任務書的式子對應「MM = m·Q·S」（隨現價變動的名目），解出來是分式；本程式 MM = m·M·L（開倉名目，固定），所以是線性式（`PerpetualExchange.sol:1171`）。
2. **權益扣了平倉手續費、借貸費、資金費**（`PerpetualExchange.sol:1163-1168`），任務書的式子沒有。資金費 φ 可以是負的（收到資金費時清算價離得更遠）。
3. **S 是 mark 不是 index**：`markPremiumCapBps > 0` 時，S = index·(1 + premiumBps/10⁴)，premium 由排除自身後的 OI 失衡決定，上限 ±200 bps（`PerpetualExchange.sol:79`、`:2050-2081`）。鏈上與原始碼預設都是 0（mark = index）。
4. 清算前會先跑 `_pokeFunding`，所以 φ 包含到當下為止所有已滿的 8 小時區間（`PerpetualExchange.sol:1157`）。

數值對照（h = 0、φ = 0、mark = index）：

| Tier／槓桿 | m | f | 本程式 多單 S\*/S_0 | 任務書 多單 | 本程式 空單 S\*/S_0 | 任務書對稱式 空單 |
|---|---|---|---|---|---|---|
| Low 5x | 5% | 0.10% | 0.8510 | 0.8421 | 1.1490 | 1.1429 |
| Mid 2x | 5% | 0.40% | 0.5540 | 0.5263 | 1.4460 | 1.4286 |
| High／Unrated 1x | 5% | 1.00% | 0.0600 | 0.0000 | 1.9400 | 1.9048 |

借貸費每小時把清算價往不利方向推 r·(L−1)/L：Low 5x 是每小時 0.008%·S_0，24 小時是 0.192%·S_0；1x 倉位沒有借貸費。

## 2. 資金費率與借貸費

### 2.1 資金費率

| 項目 | 程式實際 | 位置 |
|---|---|---|
| 函式名稱 | **確實有 `_pokeFunding`**（internal）；累積邏輯在 `_accrueFunding`；對外入口是 `settleFunding(bytes32)` | `PerpetualExchange.sol:1420`、`:1458`、`:1410` |
| 公式類型 | **OI 失衡（skew）型，不是 mark − index**。rateBps = trunc(75 × (OI_L − OI_S)/(OI_L + OI_S))，範圍 [−75, +75] 整數 bps；正值＝多方付 | `PerpetualExchange.sol:1514-1518` |
| OI 的定義 | `globalLongNotional`／`globalShortNotional`：**開倉名目**的加總，不隨價格重估 | `PerpetualExchange.sol:240-241` |
| 付方每單位名目 | \|rate\| × 1e-4 × 區間數，加到付方的累積指數 | `PerpetualExchange.sol:1476-1488` |
| 收方每單位名目 | 付方 × payerOI/receiverOI（總額守恆），但最多為付方的 10 倍（`MAX_FUNDING_RECEIVE_SCALE`），超過的部分留在付方 | `PerpetualExchange.sol:116`、`:1503-1509` |
| 週期 | `FUNDING_INTERVAL = 8 hours`（constant），只計滿的區間 | `PerpetualExchange.sol:94`、`:1443-1445` |
| 上限 | `MAX_FUNDING_RATE_BPS = 75`（每 8h 0.75%，每天 2.25%）；單次補算最多 `MAX_FUNDING_CATCHUP_INTERVALS = 21` 個區間（15.75%），跳過的區間雙方都免除 | `PerpetualExchange.sol:95`、`:106`、`:1446-1455` |
| 不累積的情況 | 任一邊 OI = 0；全域暫停或資產 Halted 的時間（時鐘往後平移） | `PerpetualExchange.sol:1463`、`:1433-1440` |
| 第一次觸碰 | 只啟動時鐘，不回溯累積 | `PerpetualExchange.sol:1423-1430` |
| 結算到倉位 | Φ = M·L·(I_side − I_entry)/1e18，平倉／清算／ADL 時從權益扣（或加） | `PerpetualExchange.sol:2085-2096` |

觸發入口（誰會讓資金費累積）：

| 入口 | 呼叫者 | 條件 | 位置 |
|---|---|---|---|
| `settleFunding(asset)` | 任何人 | `whenNotPaused`、非 Halted、距上次 ≥ 8h，否則 revert `FundingIntervalNotElapsed` | `PerpetualExchange.sol:1410-1416` |
| `_openPosition` | 開倉（直接、CopyTracker、AgentSessionManager） | 鎖 entry index 之前先 poke | `PerpetualExchange.sol:1775` |
| `_closePosition` | 平倉 | | `PerpetualExchange.sol:1852` |
| `liquidatePosition` | 清算 | | `PerpetualExchange.sol:1157` |
| `setAssetMode` | 進入 Halted 時 | | `PerpetualExchange.sol:995` |
| keeper | `base-sepolia-keeper.yml` 用 `cast send settleFunding` 對 sBTC／sETH／sAAPL／sTSLA crank，只在到期時送、價格被熔斷時跳過 | | `.github/workflows/base-sepolia-keeper.yml:197-281` |

### 2.2 借貸費（borrow fee）

```
borrowFee = M·(L−1) · borrowFeeBpsPerHour · ⌊active/3600⌋ / 10000      (PerpetualExchange.sol:1948-1953)
active = (now − openedAt) − (downtimeOf(asset) − downtimeAtOpen[id])
```

- 費率在開倉時凍結進 `pos.borrowFeeBpsPerHour`（碳分級 1／4／10 bps/h；未接 registry 時用全域 `BORROW_FEE_BPS_PER_HOUR`，預設 1、上限 10）（`PerpetualExchange.sol:60`、`:68`、`:1822-1824`）。
- 只在平倉／清算時一次扣，不是每期結算。

## 3. Oracle

### 3.1 介面

| 合約 | `getPrice(bytes32)` 回傳 | 其他讀取 | 過期處理 | 位置 |
|---|---|---|---|---|
| exchange 看到的 `IOracle` | `(uint256 price 8 位小數, uint256 updatedAt)`；exchange 乘 1e10 換成 18 位 | — | 由 exchange 自己檢查 | `PerpetualExchange.sol:13-15`、`:1718-1736` |
| MockOracle | 同上；**不檢查過期** | `isStale()` 依 `staleThreshold`（原始碼可設 5 分鐘到 24h，預設 24h；鏈上舊版只有 `STALE_THRESHOLD() = 86400`） | 無 | `contracts/src/MockOracle.sol:13-23`、`:77-81` |
| GuardedOracle | 同上；凍結中 revert、`maxPriceAge` 過期 revert（0＝不檢查） | `peek()` 回傳 `(price, updatedAt, exists, frozen)`，永不 revert；`isStale()` | getPrice 內 | `contracts/src/v2/GuardedOracle.sol:198-230` |
| AggregatorOracleAdapter | 兩個來源都活：差距 > `haltDeviationBps`（預設 20%）revert，否則取較新的；只剩一個來源時看 `allowSingleSource` | `isStale()`、`isDegraded()`（差距 > `maxDeviationBps` 預設 1%） | 由來源 | `contracts/src/AggregatorOracleAdapter.sol:89-160` |

**鏈上 exchange 讀的是 MockOracle**（`oracle()` = 0xeD90…0Aa3，immutable，`PerpetualExchange.sol:152`），owner 就是 keeper 的那把 key，**寫價沒有任何偏離上限**（`contracts/src/MockOracle.sol:64-75`）。GuardedOracle 由 keeper 鏡射寫入，目前只給 AssetVaultV2 用。

### 3.2 maxPriceAge

| 位置 | 原始碼預設 | 鏈上實際 | setter／界線 | 檢查位置 |
|---|---|---|---|---|
| PerpetualExchange `maxPriceAge` | 24 hours | **21,600 秒（6h）**（部署腳本設定） | `setMaxPriceAge` onlyOwner，(0, 7 days] | `PerpetualExchange.sol:139`、`:805-809`；開倉 `_freshPrice` `:1718-1725`，平倉／清算 `_requireFresh` `:1732-1736`。view 函式與 `withdrawMargin` 不檢查 |
| AssetVaultV2_5 `maxPriceAge` | initialize 設 1h | 鏈上 proxy 實作是 V2_4（RELEASE_STATUS） | `setRiskParams` RISK_ROLE，>0；**實際有效值 = min(maxPriceAge, 6h)**（`LAST_GOOD_MAX_AGE`） | `contracts/src/v2/AssetVaultV2_5.sol:140`、`:194`、`:304`、`:400-404`、`:434-437`、`:543-566` |
| GuardedOracle `maxPriceAge` | 1 hours | **2,592,000 秒（30 天）**（等於關掉，避免 keeper 讀價被擋） | `setRiskParams` DEFAULT_ADMIN | `contracts/src/v2/GuardedOracle.sol:106`、`:524-533`；租戶部署設 0（`contracts/script/VerifyTenant.s.sol:107-118`） |

部署腳本的 6h：`contracts/script/Redeploy130Hardened.s.sol:357`、`contracts/script/RedeployExchange.s.sol:112`（註解寫明原始碼預設是 24h）。

### 3.3 GuardedOracle 的保護

| 機制 | 原始碼預設 | 鏈上（舊版 3,742 B） | 位置 |
|---|---|---|---|
| 單次偏離上限 `maxDeviationBps` | 1,000（10%），setter 上限 5,000；超過就 **reject**，不 clamp | 1,000 | `GuardedOracle.sol:103`、`:345-348`、`:524-533` |
| reference source 交叉檢查 | 未設；有設時：reference 同意 → 跳過步進上限；不同意 → 必須往 reference 收斂且在步進上限內 | `referenceSource` = 0 | `GuardedOracle.sol:110`、`:330-341` |
| 速率限制（時間窗累積偏離） | 預設關（0）；`setWindowLimit(duration 5 分鐘到 7 天, bps ≤ 5,000)`；同時對照前一個時間窗，最壞約每（窗＋1 秒）2 倍上限 | 鏈上舊版**沒有**這兩個函式 | `GuardedOracle.sol:111-133`、`:354-386`、`:538-545` |
| 凍結／暫停 | guardian 凍結或暫停 72h 自動到期（fail-open），之後冷卻 24h；admin 的凍結無期限 | — | `GuardedOracle.sol:51`、`:57`、`:472-520` |
| 角色 | KEEPER_ROLE 寫價、GUARDIAN_ROLE 凍結、DEFAULT_ADMIN 調參 | — | `GuardedOracle.sol:41-42` |

租戶範本：`oracleMaxDeviationBps 1000`、`oracleWindowSeconds 3600`、`oracleWindowDeviationBps 2500`（`deploy/tenants/_template.json`）。

### 3.4 keeper 推價

| 項目 | 實際 | 位置 |
|---|---|---|
| 排程 | cron `*/15 * * * *`（名目 15 分鐘） | `.github/workflows/base-sepolia-keeper.yml:29` |
| **實測間隔** | **68–169 分鐘，平均約 90 分鐘**（GitHub 排程是 best-effort）；2026-09-30 曾 4.5 小時沒跑。另有 Cloudflare Worker 每 20 分鐘檢查、超過 15 分鐘沒跑就 `workflow_dispatch` 補觸發 | `.github/workflows/base-sepolia-keeper.yml:25-28`、`docs/RUNBOOK_KEEPER.md:114-118`、`ops/keeper-trigger/README.md:19` |
| 本次唯讀快照 | 區塊 47714342 時，sBTC／sETH／sAAPL／sTSLA 在 MockOracle 的 `updatedAt` 都是約 105 分鐘前 | 本文 |
| 程式 | `npx tsx keeper/run.ts`，單次執行、11 個資產各一輪，沒有常駐 loop | `.github/workflows/base-sepolia-keeper.yml:137`、`agent/keeper/run.ts:41-43`、`agent/keeper/round.ts:138` |
| 寫價條件 | 偏離 ≥ 0.1%（`KEEPER_DEVIATION`）或距上次 ≥ 900 秒（`KEEPER_HEARTBEAT`） | `agent/keeper/run.ts:61-62`、`agent/keeper/core.ts:45-68` |
| 熔斷 | 偏離 > 20% 需要 ≥ 2 個來源確認（來源間容差 2%），門檻再被 GuardedOracle `maxDeviationBps` 壓低；超限直接拒寫並把資產切成 ReduceOnly | `agent/keeper/core.ts:99-101`、`:281`、`:297`、`agent/keeper/protect.ts:73` |
| 價格來源 | CoinGecko（BTC/ETH）、Yahoo（股票、ETF、黃金期貨）；BTC/ETH 另有 Yahoo 做第二來源 | `agent/keeper/feeds.ts:15-37` |
| 寫入目標 | MockOracle 0xeD90…（exchange 讀這個）＋鏡射 GuardedOracle 0x8E9e…；並呼叫 AssetVaultV2 `observeReserve()` | `.github/workflows/base-sepolia-keeper.yml:60`、`:72-73` |
| 其他動作 | 休市切 ReduceOnly、開盤放寬（`setAssetMode`）；`settleFunding` crank | `agent/keeper/marketMode.ts:199`、`.github/workflows/base-sepolia-keeper.yml:197-281` |
| 健康檢查 | `oracle-health.yml` 每 3 小時唯讀檢查，門檻 18,000 秒，過期開 issue | `.github/workflows/oracle-health.yml:11`、`:41`、`:63` |
| **清算 bot** | **不存在。** keeper 不呼叫 `liquidatePosition`；repo 內唯一呼叫者是前端 `frontend/src/lib/pepefi/liquidation.ts`（手動） | 全 repo 搜尋 |

## 4. 清算流程與壞帳

| 項目 | 程式實際 | 位置 |
|---|---|---|
| 誰能清算 | **任何人**（無角色限制）；需要 `whenNotPaused`、資產非 Halted、不在恢復後 30 分鐘寬限期內、價格新鮮 | `PerpetualExchange.sol:1147-1158`、`:365`、`:942-959` |
| 全額或部分 | **只有全額清算**，沒有部分清算 | `PerpetualExchange.sol:1180-1191` |
| 剩餘抵押 > 0 的分配 | 「剩餘」= closeAmount。清算人 `LIQUIDATION_REWARD_BPS` = 5%（constant）；保險庫 `liquidationPenaltyBps` = 20%（setter，鏈上也是 2,000）；**其餘 75% 退回倉位持有人** | `PerpetualExchange.sol:56`、`:301`、`:1204-1219` |
| 平倉手續費的去處 | 留在 exchange 合約餘額（交易者資金池）；只有 `vaultFeeShareBps` 那一份實際收得到的手續費會轉進保險庫（預設 0，鏈上 0） | `PerpetualExchange.sol:276`、`:1705-1715`、`:1276-1287` |
| 剩餘抵押 < 0（壞帳） | `_absorbShortfall`：① InsuranceVault `bailout(min(缺口, totalAssets))` 把錢補回 exchange；② `adlEnabled` 時 ADL；③ 剩下的發 `BadDebt` 事件 | `PerpetualExchange.sol:1247-1270` |
| ADL | 掃同資產、**反方向**、目前有獲利的倉位，依索引順序最多 128 筆，削減其獲利（不收交易／借貸費，資金費照算）；`adlEnabled` 預設 false，**鏈上 true** | `PerpetualExchange.sol:133`、`:286`、`:1301-1366` |
| 自願平倉時資不抵債 | 走同一條 `_absorbShortfall`；另外若保險庫在補完缺口後還有餘裕，付給交易者 `BAILOUT_FLOOR_BPS` = 10% 保證金 | `PerpetualExchange.sol:119`、`:1880-1890`、`:1926-1928` |
| 壞帳最終承擔者 | 未覆蓋部分沒有自動補足，等於由所有持有 `freeMargin` 的使用者間接承擔 | `docs/RISK_WATERFALL.md:51`、`:71` |

保險庫（`contracts/src/InsuranceVault.sol`）資金來源：

| 來源 | 機制 | 位置 |
|---|---|---|
| 清算罰金 | exchange 呼叫 `depositFromProtocol` | `InsuranceVault.sol:216-221`、`PerpetualExchange.sol:1216-1219` |
| 交易手續費分潤 | `vaultFeeShareBps`（預設 0，鏈上 0） | `PerpetualExchange.sol:1705-1715` |
| 跟單績效費分潤 | FeeRouter 常數：平台 20%、保險庫 10%、領單交易員 70%（績效費本身是跟單倉位獲利的 10%） | `contracts/src/FeeRouter.sol:24-25`、`:161-170`、`PerpetualExchange.sol:53` |
| LP 存入 | `deposit`，ERC20 shares，virtual shares `DECIMALS_OFFSET = 6`；`withdraw` 沒有冷卻期 | `InsuranceVault.sol:56-58`、`:149`、`:162-170` |
| 注資 | `recapitalize` onlyOwner，不鑄 shares | `InsuranceVault.sol:140` |
| 種子 | `InsuranceSeeder` 部署時存入，shares 給 treasury | `contracts/src/InsuranceSeeder.sol:51-67` |
| 支出 | `bailout` 只有 exchange 能呼叫，單次沒有上限（不超過 totalAssets） | `InsuranceVault.sol:225-231` |

## 5. 抵押品與對手方

| 項目 | 程式實際 | 位置 |
|---|---|---|
| MockUSDC 小數位數 | **18**（沒有覆寫 decimals）。exchange 建構子強制抵押品是 18 位（`MIN_MARGIN` 與 `×1e10` 都寫死） | `contracts/src/MockUSDC.sol:10`、`PerpetualExchange.sol:637-650` |
| MockUSDC 權限 | `faucet()` 任何 EOA，每次 1,000、冷卻 1 天；`mint` 只有 owner 或 swapRouter；**唯一的 onlyOwner setter 是 `setSwapRouter`，只能設一次**；`burnFrom` 只有 router | `contracts/src/MockUSDC.sol:10-11`、`:32-37`、`:51-60`、`:71-72` |
| 6 位小數 USDC 怎麼接 | 透過 `WrappedUSDC18`（settlement 路徑，見 ADR-011） | `contracts/src/settlement/WrappedUSDC18.sol` |
| **交易所的對手方** | **協議本身（exchange 合約的 USDC 餘額）**。所有人的 `freeMargin`、保證金、手續費都存在同一個合約；獲利從這個池子付，虧損留在池子。沒有 LP 池擔任永續的對手方；InsuranceVault 是壞帳後盾（LP 賺手續費分潤），ADL 是第二道。資金費是多空之間互付 | `PerpetualExchange.sol:225`、`:1208`、`:1918` |
| OI 上限（原始碼） | `maxLongOI`／`maxShortOI` 逐資產，以**當前 index** 重估整邊 size；0＝不限；只在開倉檢查 | `PerpetualExchange.sol:447-455`、`:1014-1018`、`:1958-1968` |
| 單倉獲利上限（原始碼） | `maxProfitBps` 0 或 [10,000, 250,000] bps of margin，開倉時凍結 | `PerpetualExchange.sol:131-132`、`:459-468`、`:1024-1028` |
| OI／獲利上限（鏈上） | **鏈上舊版沒有**（`maxProfitBps` 呼叫 revert）；guardian／pause／asset mode 也沒有 | 唯讀 RPC |
| AssetVaultV2（另一個產品） | 合成資產現貨金庫，**金庫是所有多頭的對手方，非足額抵押**；mint 要求準備率 ≥ `minReserveRatioBps`（預設 110%），redeem 不受準備率限制 | `docs/RISK_MODEL.md:13-18`、`:43-60`、`contracts/src/v2/AssetVaultV2_5.sol:302-303` |

## 6. 測試框架與覆蓋

| 項目 | 實際 | 位置 |
|---|---|---|
| solc | 0.8.36（釘選） | `contracts/foundry.toml:15` |
| via_ir／optimizer | `via_ir = true`、`optimizer_runs = 200` | `contracts/foundry.toml:5-7` |
| evm_version | **沒有設定**（repo 內任何設定檔、workflow、腳本都沒有），使用 forge 預設 | `contracts/foundry.toml` |
| `[fuzz]`／`[invariant]` | 沒有區段，用預設；`WrappedUSDC18Invariant` 有 inline `invariant.runs = 64` | `contracts/test/settlement/WrappedUSDC18Invariant.t.sol:163`、`:300` |
| forge 版本 | CI 釘 v1.8.0（foundry-toolchain v1.9.1）；本機 1.7.1 | `.github/workflows/contracts-ci.yml:52-58` |
| CI 指令 | `forge build --sizes`、`forge test -vv --summary`；slither、gas snapshot 都是 continue-on-error | `.github/workflows/contracts-ci.yml:64`、`:67`、`:83`、`:111-112` |
| 大小門檻 | `PerpetualExchange maxRuntimeBytes = 23911`，EIP-170 = 24,576；**現行大小剛好等於門檻，餘裕 0 B** | `scripts/contract-size-budget.json:6`、`scripts/check-contract-size.mjs:34`、`.github/workflows/contract-size.yml:94` |
| 測試檔 | 91 個 `.t.sol`：根目錄 67、`v2/` 17、`fork/` 4、`settlement/` 3 | `contracts/test/` |
| 測試函式 | `function test*` 1,211 個（含 27 個 `testFuzz*`）；`invariant_*` 29 個 | grep 計數 |
| invariant | `ExchangeRiskCapsInvariant`（7）、`InsuranceVaultInvariant`（7）、`settlement/WrappedUSDC18Invariant`（10）、`v2/AssetVaultV2Invariant`（5） | 各檔 |
| fork 測試 | chainid ≠ 84532 時 `vm.skip`；CI 沒給 `--fork-url`，所以**CI 裡全部 skip** | `contracts/test/fork/VaultV2_5Fork.t.sol:25` |

主要測試檔分類（括號內是 test＋invariant 函式數）：

| 類別 | 檔案 |
|---|---|
| 交易引擎核心 | `PerpetualExchange`（25）、`IsolatedMargin`（7）、`ExchangeCoreFixes`（10）、`AuditFixesCore`（27）、`SecurityFixes`（12） |
| 資金費／mark | `Funding`（11）、`MarkPrice`（8） |
| 清算／壞帳 | `AutoDeleverage`（6）、`Bailout`（4）；另有 15 個測試檔呼叫 `liquidatePosition` |
| 風控參數 | `RiskParams`（6）、`ExchangeRiskCaps`（24）、`ExchangeRiskCapsInvariant`（7） |
| 碳分級 | `CarbonTiers`（19）、`CarbonPricing`（22） |
| 緊急控制 | `ExchangeGuardian`（65）、`ExchangeDowntime`（22） |
| 保險庫 | `InsuranceVault`（10）、`InsuranceVaultShares`（20）、`InsuranceVaultInvariant`（7） |
| Oracle | `MockOracle`（10）、`AggregatorOracle`（13）、`AggregatorOracleAdapter`（16）、`v2/GuardedOracle`（22）、`v2/GuardedOracleRateLimit`（8）、`v2/GuardedOracleHaltBound`（8）、`v2/GuardedOracleHaltExpiry`（65） |
| 抵押品 | `MockUSDC`（10）、`settlement/*` |
| 合成資產金庫 | `v2/AssetVaultV2*`（11 個檔） |

覆蓋率（**推估，沒有跑 `forge coverage`**）：清算不等式、資金費累積、ADL、bailout、OI／profit cap、guardian／downtime 都有專屬測試檔與 invariant，核心路徑大致都有涵蓋。可能的缺口：(1) 清算價封閉式本身沒有獨立的 fuzz 對照；(2) 「MMR ≥ 1/L − f 會一開倉就可清算」沒有負向測試；(3) fork 測試在 CI 不跑，鏈上參數只靠部署腳本與 `Verify*.s.sol` 檢查。

## 7. 任務書假設 vs 程式實際

| # | 任務書假設 | 程式實際 | 判定 | 位置 |
|---|---|---|---|---|
| 1 | ReentrancyGuard | 有，`PerpetualExchange is Ownable, ReentrancyGuard`；value-moving 函式都有 `nonReentrant`（`settleFunding`、`setAssetMode` 沒有，它們不轉帳） | 一致 | `PerpetualExchange.sol:8`、`:41` |
| 2 | stale price 檢查 maxPriceAge = 24h | 原始碼預設 24h；**鏈上 exchange 是 6h**（部署腳本設定）；vault 有效上限 6h；GuardedOracle 鏈上 30 天 | 不同（數值） | `PerpetualExchange.sol:139`、唯讀 RPC |
| 3 | 透過 `_pokeFunding` 累積資金費率 | 有 `_pokeFunding`，實際累積在 `_accrueFunding`；入口 `settleFunding`＋開／平／清算／Halt | 一致（補充） | `PerpetualExchange.sol:1420`、`:1458` |
| 4 | 清算獎勵 5% 清算人／95% 保險庫 | 清算人 5%、保險庫 **20%**（可調）、**其餘 75% 退回持有人**；剩餘 ≤ 0 時清算人拿 0 | 不同 | `PerpetualExchange.sol:1204-1207` |
| 5 | MockUSDC setter 限 onlyOwner | 唯一 onlyOwner setter 是 `setSwapRouter`（只能設一次）；`mint` 是 owner **或 swapRouter**；`faucet` 任何 EOA | 大致一致（補充） | `MockUSDC.sol:32-35`、`:71-72` |
| 6 | 設計文件 `docs/DESIGN_x402_AI_AGENT.md` | 存在 | 一致 | `docs/DESIGN_x402_AI_AGENT.md` |
| 7 | 清算價 S\* = S_0·(1−1/L)/(1−m) | 線性式 S_0·(1 − 1/L + m + f + β + φ)，MMR 基數是開倉名目 | 不同 | 第 1.4 節 |
| 8 | EIP-170：runtime 23,911 B | 原始碼一致，預算餘裕 0 B；**鏈上是 18,861 B 的舊版** | 一致（原始碼） | `scripts/contract-size-budget.json:6`、`docs/RELEASE_STATUS.md:27` |
| 9 | 碳分級 Low／Mid／High／Unrated 參數 | 完全一致；Unrated 與 High 同一列 | 一致 | `CarbonTiers.sol:97-107`、`:145-146` |
| 10 | guardian、逐資產 Active／ReduceOnly／Halted、OI 與獲利上限 | 原始碼有；**鏈上沒有**（舊版） | 原始碼一致／鏈上不存在 | `PerpetualExchange.sol:369-389`、`:447-468` |
| 11 | GuardedOracle 速率限制、凍結到期 | 原始碼有；鏈上舊版沒有速率限制函式 | 原始碼一致／鏈上不存在 | `GuardedOracle.sol:111-133`、`:51-57` |
| 12 | MockOracle、AggregatorOracle | 都存在；**exchange 鏈上讀的是 MockOracle**（無偏離上限）；AggregatorOracle 已從 keeper 移除 | 一致（補充） | `.github/workflows/base-sepolia-keeper.yml:64-67` |
| 13 | InsuranceVault virtual shares | `DECIMALS_OFFSET = 6` | 一致 | `InsuranceVault.sol:56-58` |
| 14 | AssetVaultV2 非足額抵押 | 一致；原始碼 V2_5，鏈上 proxy 實作 V2_4 | 一致 | `docs/RISK_MODEL.md:13-18`、`docs/RELEASE_STATUS.md:41` |
| 15 | 部署在 Base Sepolia（84532） | 一致；位址在 `frontend/src/contracts/addresses.ts` | 一致 | `docs/RELEASE_STATUS.md` |
| 16 | （隱含）有清算 keeper | **不存在**，只有前端手動 | 不存在 | 第 3.4 節 |

## 8. 給後續 Phase 的備註

### 8.1 constant／immutable（改了要重新部署，且會動到 EIP-170 大小）

`PerpetualExchange` 的預算餘裕是 0 B（`scripts/contract-size-budget.json:6`）。改 constant 的數值通常不會改變 bytecode 長度，但任何邏輯改動都可能超出預算。

| 參數 | 值 | 位置 |
|---|---|---|
| `MAX_LEVERAGE` | 5 | `PerpetualExchange.sol:51` |
| `MIN_MARGIN` | 10e18 | `:52` |
| `PERFORMANCE_FEE_BPS` | 1,000 | `:53` |
| `LIQUIDATION_REWARD_BPS` | 500 | `:56` |
| `MAX_TRADING_FEE_BPS`／`MAX_BORROW_FEE_BPS_PER_HOUR`／`MAX_MAINTENANCE_MARGIN_BPS`／`MAX_PRICE_AGE_LIMIT`／`MAX_EXECUTION_FEE`／`MAX_MARK_PREMIUM_CAP_BPS` | 100／10／9,999／7 days／1 ether／200 | `:67-79` |
| `FUNDING_INTERVAL`／`MAX_FUNDING_RATE_BPS`／`MAX_FUNDING_CATCHUP_INTERVALS`／`MAX_FUNDING_RECEIVE_SCALE` | 8h／75／21／10 | `:94-116` |
| `BAILOUT_FLOOR_BPS`／`DEFAULT_MAINTENANCE_MARGIN_BPS` | 1,000／500 | `:119-121` |
| `MIN_PROFIT_CAP_BPS`／`MAX_PROFIT_CAP_BPS`／`MAX_ADL_SCAN` | 10,000／250,000／128 | `:131-133` |
| `GUARDIAN_PAUSE_DURATION`／`COOLDOWN`／`LIQUIDATION_GRACE_PERIOD` | 72h／24h／30 分鐘 | `:350-365`、`:2109-2110` |
| 碳分級表 | 見 1.1 | `CarbonTiers.sol:97-107` |
| immutable：`usdc`（必須 18 位）、`oracle`、`esgRegistry`（0＝停用碳定價） | 建構子參數 | `PerpetualExchange.sol:151-163`、`:637-650` |
| FeeRouter 分潤 20／10／70、`treasury` immutable | | `FeeRouter.sol:19`、`:24-25` |
| InsuranceVault virtual shares | 1e6／1 | `InsuranceVault.sol:56-58` |
| GuardedOracle guardian 72h／24h；`maxDeviationBps` 上限 5,000 | | `GuardedOracle.sol:51-57`、`:529` |
| AssetVaultV2_5 `LAST_GOOD_MAX_AGE` 6h | | `AssetVaultV2_5.sol:194` |

### 8.2 有 setter 的參數

權限：PerpetualExchange、InsuranceVault、FeeRouter 都是 `Ownable`。**鏈上 exchange 的 owner 0x27C2… 是 EOA（code size 0），還沒有移交 timelock**；`docs/GOVERNANCE_HANDOVER.md:1-19` 規劃移交給 48h `TimelockController`（腳本 `contracts/script/DeployGovernance.s.sol`、`HandoverToTimelock.s.sol`）。合約本身沒有內建 timelock，延遲完全取決於 owner 是誰。

| 參數 | setter | 權限 | 界線 | 鏈上值 | 位置 |
|---|---|---|---|---|---|
| `TRADING_FEE_BPS` | `setTradingFeeBps` | owner | ≤ 100；**接了 esgRegistry 後無效** | 10 | `PerpetualExchange.sol:714-718` |
| `BORROW_FEE_BPS_PER_HOUR` | `setBorrowFeePerHour` | owner | ≤ 10；同上 | 1 | `:725-729` |
| `maxLeverageOf[asset]` | `setMaxLeverageFor` | owner | ≤ 5，只能比碳分級更緊 | — | `:780-784` |
| `maintenanceMarginBpsOf[asset]` | `setMaintenanceMarginFor` | owner | ≤ 9,999 | 500（預設） | `:790-794` |
| `liquidationPenaltyBps` | `setLiquidationPenaltyBps` | owner | ＋500 ≤ 10,000 | 2,000 | `:741-745` |
| `maxPriceAge` | `setMaxPriceAge` | owner | (0, 7d] | 21,600 | `:805-809` |
| `markPremiumCapBps` | `setMarkPremiumCapBps` | owner | ≤ 200 | 0 | `:816-820` |
| `vaultFeeShareBps` | `setVaultFeeShareBps` | owner | ≤ 10,000 | 0 | `:764-768` |
| `adlEnabled` | `setAdlEnabled` | owner | bool | true | `:797-800` |
| `executionFee` | `setExecutionFee` | owner | ≤ 1 ether | 1e14 | `:686-690` |
| `maxLongOI`／`maxShortOI` | `setMaxOpenInterest` | owner | 無界線（0＝不限） | 鏈上不存在 | `:1014-1018` |
| `maxProfitBps` | `setMaxProfitBps` | owner | 0 或 [10,000, 250,000] | 鏈上不存在 | `:1024-1028` |
| asset mode | `setAssetMode` | owner 任意；guardian 只能進 ReduceOnly；marketOperator Active↔ReduceOnly | | 鏈上不存在 | `:986-996`、`:2209-2266` |
| pause | `pause`／`unpause` | guardian 或 owner／只有 owner | | 鏈上不存在 | `:861-875` |
| 接線 | `setInsuranceVault`、`setFeeRouter`、`setCopyTracker`、`setAgentAuthorized`、`setKycRegistry`、`setRwaAsset`、`setGuardian`、`setMarketOperator` | owner | | | `:657-835` |
| GuardedOracle | `setRiskParams`、`setWindowLimit`、`setReferenceSource`、`addAsset` | DEFAULT_ADMIN | 見 3.3 | | `GuardedOracle.sol:282`、`:524-550` |
| AssetVaultV2_5 | `setRiskParams(redeemFee ≤ 1,000, minReserve ≥ 10,000, maxPriceAge > 0)`、`setAssetCap`、`setOracle` | RISK_ROLE／DEFAULT_ADMIN | | | `AssetVaultV2_5.sol:384`、`:543-566`、`:810` |
| AggregatorOracleAdapter | `setMaxDeviationBps`、`setHaltDeviationBps`、`setAllowSingleSource` | owner | | | `AggregatorOracleAdapter.sol:117-135` |

### 8.3 部署到新鏈（Besu）時，只靠部署參數或 setter 就能調的項目

全域規範是「修改既有合約不新增方法」，加上 exchange 預算餘裕 0 B，Besu 部署應該優先只用下列手段：

1. **建構子**：`usdc`（18 位小數；6 位的話先包 `WrappedUSDC18`）、`oracle`（建議 GuardedOracle，不要用 MockOracle）、`esgRegistry`（0＝不啟用碳定價，改用全域費率與槓桿 setter）。
2. **owner setter**：手續費、借貸費（僅限未接碳定價時）、逐資產槓桿（只能收緊）、逐資產 MMR、清算罰金、`maxPriceAge`、mark premium、保險庫分潤、ADL 開關、執行費、OI 上限、獲利上限、guardian／marketOperator、各種接線。
3. **GuardedOracle**：偏離上限、速率限制時間窗、reference source、`maxPriceAge`（租戶做法是設 0，由 exchange 與 vault 檢查）。
4. **AssetVaultV2_5**：redeem 費、最低準備率、`maxPriceAge`（有效上限 6h）、逐資產上限。
5. **現成腳本**：`contracts/script/DeployTenant.s.sol` 已經用 `deploy/tenants/<id>.json` 的參數部署整套（exchange `:268-295`、GuardedOracle `:351-354`、vault `:404`），並檢查 `network.chainId == block.chainid`（`:130`）。Besu 可以新增一份租戶設定，不需要改合約。

**不能只靠設定調的**（要改合約、重新部署）：`MAX_LEVERAGE`、碳分級表、`LIQUIDATION_REWARD_BPS`、預設 MMR、資金費週期與上限、`MIN_MARGIN`、bailout floor、MMR 基數（開倉名目）與清算價公式的形狀、部分清算（目前沒有）、清算 keeper（目前沒有，要另外寫鏈下程式，不必動合約）。

Besu 特有的待查項目（Phase 3 前要確認，本次沒有驗證）：

- `evm_version` 沒有釘選，forge 會用預設值；需要確認 Besu genesis 啟用的 hard fork 支援這個版本的 opcode，必要時在 `foundry.toml` 釘選。
- `PerpetualExchange` 依賴 external library `ExchangeOpsLib`（`PerpetualExchange.sol:2107` 起），部署時要 link。
- 私有 Besu 網路可以在 genesis 調 `contractSizeLimit`；就算放寬，Base 主線仍受 EIP-170 限制，預算規則不應該因 Besu 而放鬆。
- exchange 的價格新鮮度要配合 Besu 上 keeper 的實際間隔設定（Base Sepolia 的經驗：名目 15 分鐘，實際約 90 分鐘，所以設 6h）。
