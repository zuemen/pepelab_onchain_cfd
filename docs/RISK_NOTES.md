# PepeLab — 風險與金融參數說明（Risk Notes）

本文件說明永續引擎的關鍵金融參數與償付後盾現況，供 demo / 評審 / 後續上線參考。
測試網：Base Sepolia (84532)。**未對外宣稱線上償付無虞。**

---

## 1. 資金費率（Funding）— C1

| 參數 | 值 | 說明 |
|------|----|------|
| `FUNDING_INTERVAL` | **8 hours** | 標準永續結算週期（Hyperliquid 等級的常見節奏） |
| `MAX_FUNDING_RATE_BPS` | **75** | 滿失衡（單邊 OI）時每 8h 上限 = 0.75% |

**日化換算（滿失衡時的硬上限）**：
```
0.75% / 8h × (24h / 8h) = 0.75% × 3 = 2.25% / 日
```
典型情況（多空部分失衡）遠低於此；`getFundingRate()` 回傳值 = 失衡比例 × 0.75%。

**修正紀錄**：先前 `FUNDING_INTERVAL = 5 minutes` 搭配同樣的 0.75% 上限，滿失衡時
日化 ≈ 0.75% × 288 ≈ **216%/日**，經濟上不合理。本輪改為 8h 週期，把日化壓回 2.25%/日。
前端 Trade Terminal 的「Funding (8h)」標籤也因此變得正確（先前標 8h 但實際 5min）。

**回歸測試**：`test/Funding.t.sol::testFunding_dailyRate_isEconomicallySane` 斷言
單 interval ≤ 上限、日化 = 225 bps 且 ≤ 1000 bps（10%/日 sanity ceiling）。

## 2. Funding 與 Borrow Fee 並存（不是重複收費）— C3

兩者收費對象與用途不同，互補而非疊收：

| 機制 | 對誰收 | 用途 | 常數 |
|------|--------|------|------|
| **Funding** | 多空中較擁擠的一方 → 付給另一方 | 平衡多空 OI 失衡（peer-to-peer） | `MAX_FUNDING_RATE_BPS` / `FUNDING_INTERVAL` |
| **Borrow fee** | 開槓桿（lev>1）的持倉者 → 協議 | 協議提供的「借出名目本金」的融資成本（Aave 概念） | `BORROW_FEE_BPS_PER_HOUR = 1`（0.01%/h） |

- Funding 是**部位之間**的轉移，協議不從中抽成（淨額為零）。
- Borrow fee 是**槓桿融資成本**，只對借入的部分（`margin × (lev−1)`）計息。
- lev = 1 的部位**不付 borrow fee**（沒有借入名目）。

合約內 `PerpetualExchange.sol` 的 funding 區塊註解亦載明此分工。

## 3. ADL / 組合保證金 與償付風險 — C2

### 現況
- `adlEnabled`：**預設 false**（自動減倉後盾未啟用）。
- `portfolioMarginEnabled`：**預設 false**（逐倉清算）。
- 線上償付鏈條目前為：**逐倉清算 + 保險金庫 `bailout`**（`InsuranceVault`）。

### 風險評估
oracle 計價的永續中，協議在多空不平衡時實質是對手方。極端行情下：
1. 清算可能來不及／清算後仍資不抵債（清算人獎勵 5% 後的殘值不足）。
2. 保險金庫 `bailout` 有上限（金庫餘額），耗盡後無進一步後盾。
3. **ADL（自動減倉）是最後一道後盾**：對對手獲利方按比例減倉，把系統性虧損社會化，
   避免協議資不抵債。目前旗標關閉 → 此後盾未生效。

### 在 live 安全啟用 `adlEnabled` 所需步驟（本輪未執行）
1. **資料面**：確認 `assetPositionIds[asset]` 索引正確、`MAX_ADL_SCAN`(=128) 對 demo 帳戶量級夠用。
2. **守恆驗證**：沿用既有 `test/AutoDeleverage.t.sol`「讀餘額來決策就要對應改動它」+ 總額守恆測試；
   啟用前在 fork/anvil 跑一輪極端行情 e2e，確認 bailout→haircut 後 reserves 守恆。
3. **owner tx**：`setAdlEnabled(true)`（onlyOwner）。需用部署者錢包簽，屬鏈上狀態變更。
4. **seed 帳戶**：先在 seed/demo 帳戶小額驗證減倉路徑與事件，再對外開放。

### 本輪決定
**先不在 live 啟用** `adlEnabled` / `portfolioMarginEnabled`（避免未充分壓測就改動已部署合約的
償付行為）。改為在**前端（Agent Risk Monitor 頁）與本文件明確標註**「ADL / 組合保證金：已實作、
旗標控管、待強化後啟用」，不暗示線上償付無虞。啟用為 capstone 後的 roadmap 項。

### 三個 live 風險旗標的安全啟用步驟（Track 2B）
| 旗標 | 預設 | 啟用前置 | owner tx |
|------|------|----------|----------|
| mark vs index（`markPremiumCapBps`） | `markPremiumCapBps = 0`（mark==index，等同關閉） | 設合理 cap（如 ≤ 100 bps）；跑 `MarkPrice.t.sol` 回歸；確認 OI 失衡溢價不致誤觸清算 | `setMarkPremiumCapBps(bps)` |
| `adlEnabled` | off | 見上「安全啟用 ADL」四步（守恆測試 `AutoDeleverage.t.sol`） | `setAdlEnabled(true)` |
| `portfolioMarginEnabled` | off（逐倉） | 跑組合保證金 fee-asymmetry 守恆測試；fork 壓測多腿帳戶健康度 | `setPortfolioMarginEnabled(true)` |

- 共同守則：**任何「讀某餘額來決策」的路徑都要有對應的總額守恆測試**（既有 `AutoDeleverage.t.sol`、
  組合保證金測試已涵蓋），啟用前在 fork/anvil 跑極端行情 e2e。
- size-based premium（大單滑點）：目前 oracle 計價為零滑點，極端情形可能被套利。雛形設計 = 依
  `notional / OI` 加成入場價（與 mark 溢價同源），列為設計待辦，本輪未改合約。

---

## 4. 幣價資料來源與「顯示價 ≠ 結算價」 — Track 1

| 用途 | 來源 | 金鑰 | 頻率 | 說明 |
|------|------|------|------|------|
| **前端顯示價** | CoinGecko `simple/price`（crypto）/ on-chain oracle（股票/RWA） | **免金鑰** | 每 8 秒 | 讓畫面永遠是活的，即使 keeper 沒在跑 |
| **鏈上結算價** | `MockOracle`（被 keeper 餵價） | keeper 需 1 把測試金鑰 | 每 30 分 | **開倉/平倉/清算一律以此為準** |

- **設計原則**：顯示價（CoinGecko，crypto 即時）僅供 UI 報價/PnL 預覽；**真正的開倉、平倉、清算都由合約讀 on-chain `MockOracle`**。Trade Terminal 同時顯示「display price」(大字) 與「Index (oracle · settles here)」(結算價)，避免脫節誤導。`useLivePrices` 的 `source` 欄位標明 `coingecko / oracle / mock`。
- **資料源（皆免費免金鑰）**：crypto = CoinGecko；股票/ETF/黃金 = Stooq（keeper 端，CSV）。

### 鏈上 oracle 自動更新（keeper）一次性設定
`.github/workflows/base-sepolia-keeper.yml` 每 30 分用 CoinGecko + Stooq 更新 `MockOracle`，**零成本**。
唯一需要的人為動作（**做一次即可**）：在 GitHub repo → Settings → Secrets and variables → Actions 加兩個 secret：

| Secret | 值 |
|--------|----|
| `BASE_SEPOLIA_RPC_URL` | 任一 Base Sepolia RPC（如 `https://sepolia.base.org`） |
| `KEEPER_PRIVATE_KEY` | 一把持少量測試 ETH 的 EOA；**必須是 `MockOracle` 的 owner**（`updatePrice` 為 onlyOwner），即部署者錢包 |

- 守衛：缺任一 secret → 工作流**清楚略過、不紅燈**（job 仍綠 + notice）；RPC 非 84532 → 報錯；單一資產取價失敗 → 跳過該資產不中斷。
- 替代方案：也可改用 Vercel Cron 打一支 serverless 用同樣金鑰簽 `updatePrice`（本輪維持 GitHub Actions，最簡且已就緒）。
- **誠實前提**：任何「鏈上寫入」都需要一把能簽 `updatePrice` 的金鑰；除此之外全自動。未設金鑰時前端仍走 CoinGecko 顯示即時價、不崩。

---

## 金流與金融風險（審查補充）

金融審查結論：CFD 損益／費用／資金費／清算／槓桿數學**正確**，金流償付結構
（輸家保證金 → 保險金庫 → ADL 三層）**健全**。以下不是 bug，而是把「信任假設與
簡化」誠實寫清楚，供報告／口委與後續上線評估。

### 🔴 預言機單點信任（最大風險）
- 所有 PnL／清算價皆來自 `MockOracle.getPrice`，而它目前由 owner／keeper 設值。
  **控制 oracle 即可操縱所有金流**（任意造價 → 任意清算／PnL）。這是目前系統最大的
  集中化風險，本質為「測試網 owner-oracle」。
- **正式版必須改用去中心化預言機**。repo 已備妥：
  - `contracts/src/AggregatorOracleAdapter.sol`（Chainlink + Pyth）
  - `contracts/src/PythOracleAdapter.sol`
  - `contracts/script/DeployWithPyth.s.sol`
- **遷移路徑（未來工作，非現在執行）**：因 oracle 位址在 `PerpetualExchange`
  constructor 為 immutable，無法就地切換 → 需用 `DeployWithPyth` **重部署**新的
  `PerpetualExchange` 指向 `AggregatorOracle`，並**遷移既有保證金／session／倉位**到新合約。
  現階段刻意不重部署（重部署會清掉現有 demo 的倉位／session／保證金）。
  **現為測試網 owner-oracle、正式換 Pyth／Chainlink。**

### 🟠 資金費非完全守恆
- `funding = notional × indexDiff`。當多空兩側 notional 不相等時，
  「多方付出的 ≠ 空方收到的」，差額由資金池／保險金庫吸收（或溢出）。
- 屬測試網簡化；正式應改為**多空之間守恆轉移**（peer-to-peer 淨額為零、協議不墊付）。

### 🟠 ADL（自動減倉）會削減帳面利潤
- 極端單邊行情、保險金庫不足時，合約會 **haircut 對面獲利倉**以維持系統償付。
- 因此**使用者帳面利潤不保證 100% 能提出**（真實永續亦如此，但此處須明確告知）。

### 🟡 mark vs index
- PnL／清算以 **mark 價**估值：`mark = index × (1 + OI失衡 × cap)`。
- 故 OI 失衡會影響損益——這是**刻意設計**，反映真實 perp 的標記價機制，非錯誤。

### 🟡 結算幣別分離
- 永續保證金用 **MockUSDC**（18-dec、可 mint、**測試幣非真錢**）。
- x402 付費才用**官方 USDC**（6-dec、Circle、EIP-3009）。兩者用途不同、刻意分離。

### ✅ 償付結構（健全）
- 賠付鏈條：**輸家保證金 → InsuranceVault bailout → ADL** 三層。
- 數學上保證 **Σ賠付 ≤ 池內儲備**，系統恆償付（不會無中生有賠付）。

---

_最後更新：2026-06-26。對應 commit 見 git log（金流／金融風險審查補充 + 前端風險提示）。_
