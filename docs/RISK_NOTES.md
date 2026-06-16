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

---

_最後更新：2026-06-16。對應 commit 見 git log（Track C）。_
