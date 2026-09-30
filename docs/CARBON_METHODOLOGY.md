# 碳強度分級方法論

> **草案**（2026-09-30）。分級規則以 `contracts/src/CarbonTiers.sol` 與 `contracts/src/ESGRegistryV2.sol`
> 為準；資料來源見 [`data/carbon-intensity.md`](data/carbon-intensity.md)；設計決策見
> [`ADR-003`](ADR-003-carbon-priced-capital.md)、[`ADR-005`](ADR-005-carbon-spot-prices-entry-not-holding.md)、
> [`ADR-006`](ADR-006-carbon-tier-is-a-witnessed-fact.md)。
> 目前的 attestation **全部是自有見證**，沒有第三方確信（assurance）。標示「**需客戶確認**」的部分，
> 需由持牌客戶與其永續／法遵單位決定是否可接受。本文件不構成永續揭露或投資建議。

## 1. 分級做什麼用

碳分級決定資產的**持有成本與槓桿上限**，不是對資產的價值判斷：

| 消費者 | 讀取 | 用途 |
|---|---|---|
| `PerpetualExchange`（現行 Base 部署已接上 `ESGRegistryV2`） | `medianCarbonTier` | 逐資產的交易費率、每小時借貸費、槓桿上限 |
| `AssetVaultV2` 2.4.0 | `medianCarbonTier` | mint（現貨買入）費率；redeem 為固定費率，不依碳分級（ADR-005：不對高碳資產的「退出」加價） |

## 2. 分級規則（`CarbonTiers.sol`）

### 2.1 等級與門檻

門檻是 `internal constant`，**不可由營運方調整**。這是刻意的：可調整的門檻等於營運方可以悄悄為單一資產改政策。

| 等級 | 營收基礎碳強度（tCO2e／每百萬美元營收，範疇一＋二） |
|---|---|
| Low | < 1.0 |
| Mid | 1.0 – 8.0（含兩端） |
| High | > 8.0 |
| Unrated | 沒有有效的 attestation |

### 2.2 各等級參數

| 等級 | 交易費 | 借貸費（每小時） | 槓桿上限 |
|---|---|---|---|
| Low | 10 bps（0.10%） | 1 bps（0.01%） | 5× |
| Mid | 40 bps（0.40%） | 4 bps（0.04%） | 2× |
| High | 100 bps（1.00%，交易所上限） | 10 bps（0.10%，交易所上限） | 1× |
| **Unrated** | 同 High | 同 High | 1× |

**未評等資產一律落到最保守等級**：沒有 attestation、或所有 attestation 都已過期時，讀取結果是
`(Unrated, 0, 0, isRated = false)`，參數與 High 相同。Unrated 與 High 保持為不同的列舉值，
讓畫面與事件可以寫「未評等」，而不是誤報為「已評為 High」。

## 3. 見證（attestation）機制（`ESGRegistryV2.sol`）

### 3.1 一筆 attestation 包含什麼

| 欄位 | 說明 |
|---|---|
| `tier` | 見證者宣告的碳等級。**這是定價依據的事實**（ADR-006），而不是由數字重新推算的等級 |
| `basis` | 分級依據：`Revenue`（營收基礎碳強度）／`Absolute`（年化絕對排放加產業基準）／`Qualitative`（產業或工具類別判斷） |
| `carbonIntensity` | 1e18 定點數；`Revenue` 基礎必填，其他基礎可為 0 |
| E／S／G | 0–100 分，目前不參與定價 |
| `sourceHash` | 見證者在鏈下計算的「來源網址＋取得日期」雜湊；不可為 0。合約**無法驗證**它指向真實文件 |
| `observedAt` | 上鏈時間 |

提交時的檢查：
- 只有 `ATTESTOR_ROLE` 可以提交；同一見證者再次提交會覆蓋自己的上一筆。
- `basis = Revenue` 時，`carbonIntensity` 不可為 0，且宣告的 `tier` 必須等於依門檻換算的等級，否則 revert。
  這是防止「數字與等級不一致」的閘門。
- 其他兩種基礎沒有這個檢查，因為營收基礎的數字對商品與加密資產沒有可比意義
  （例如以市值正規化比特幣排放，會算出比 Apple 還低的數字）。

### 3.2 中位數與離散度

`medianCarbonTier(assetId)` 只取**未過期**的 attestation：

- 以等級的序數（Unrated 0、Low 1、Mid 2、High 3）取中位數；偶數筆時取中間兩筆平均後**無條件捨去**。
- 同時回傳筆數 `count` 與離散度 `dispersion`（最大序數減最小序數），讓畫面可以呈現「幾個來源、意見多分歧」。

### 3.3 有效期

- 原始碼預設 `maxAttestationAge = 180 天`；admin 可調整，0 代表不檢查。
- **Base 現行部署的值是 365 天**（31536000 秒，2026-09-30 鏈上讀取），不是原始碼預設值。
- 過期的 attestation 不計入中位數、筆數與離散度。

## 4. 現況（Base Sepolia，2026-09-30 唯讀核對）

| 項目 | 現況 |
|---|---|
| 抽查資產 | sBTC → High；sAAPL → Low；sICLN → Low |
| 每個資產的 attestation 筆數 | 抽查的三個資產都只有 **1 筆** |
| 見證者 | 抽查的三個資產都是**同一個位址**，而且與合約 owner 是同一個 EOA |
| 離散度 | 0（只有一筆，沒有可比較的意見） |

因此，目前的「中位數」與「離散度」機制**沒有發揮獨立見證的作用**。合約的 NatSpec 本身就寫明：
如果所有 `ATTESTOR_ROLE` 都由同一營運方控制，「多個來源意見不一」只是表演，不是獨立性。

各資產的等級與依據（詳見 `data/carbon-intensity.md`）：

| 資產 | 依據 | 等級 |
|---|---|---|
| sAAPL、sNVDA | Revenue（公司永續報告的範疇一＋二／10-K 營收） | Low |
| sGOOGL、sTSLA、sMSFT | Revenue | High（> 8） |
| sETH | Absolute（權益證明網路年化排放） | Low |
| sBTC | Absolute（工作量證明網路年化排放） | High |
| sGOLD | Absolute（每盎司開採排放的產業基準） | High |
| sESGU | 部分持股加權（約 24% 覆蓋率） | Mid |
| sICLN、sBOND（追蹤 BGRN） | Qualitative（產業／工具類別判斷） | Low |

## 5. 資料品質：對照 PCAF

PCAF（Partnership for Carbon Accounting Financials）的《Global GHG Accounting and Reporting Standard》
Part A 以 1–5 分表示資料品質（1 最好）。以上市股票與公司債為例，大致是：

| PCAF 分數 | 資料性質 |
|---|---|
| 1 | 公司自行揭露、且經第三方確信的排放 |
| 2 | 公司自行揭露、未經確信的排放 |
| 3 | 以實體活動資料推估（例如產量 × 排放係數） |
| 4 | 以經濟活動資料推估（例如營收 × 產業排放係數） |
| 5 | 以更粗略的經濟資料推估（例如資產、產業平均） |

（分數定義以 PCAF 最新版標準原文為準；本表為摘要，**需客戶的永續單位確認**。）

**我們目前的位置**：

| 資產類別 | 我方資料 | 大致對應 | 差距 |
|---|---|---|---|
| 個股（sAAPL 等五檔） | 公司永續報告揭露的範疇一＋二，經第三方彙整網站轉引，營收取自 SEC 申報 | 最接近 **2**；報告本身是否經確信，我方**未逐一查核** | 未核對確信聲明；經二手彙整網站取得；未含範疇三；年度可能落後 |
| ETF（sESGU） | 部分持股加權（約 24% 覆蓋率） | 介於 **2 與 4** 之間，覆蓋率不足 | 覆蓋率過低，未處理未收錄持股 |
| 商品、加密資產（sGOLD、sBTC、sETH） | 產業或網路層級的年化排放估計 | PCAF 的上市股票分數**不直接適用** | 沒有公認的單位與方法，屬於產業基準判斷 |
| 定性分級（sICLN、sBOND） | 產業或工具類別判斷，沒有計算數字 | 低於 **5**（無量化推估） | 需要改為持股加權或發行人揭露 |

另外兩個**與 PCAF 分數無關、但更根本**的差距：

1. **見證者不獨立**：所有 attestation 都由同一個營運方 EOA 上鏈（見第 4 節）。
2. **來源無法在鏈上驗證**：`sourceHash` 只證明「見證者宣稱有來源」，不證明來源內容。

## 6. 限制

- 分級只看範疇一＋二，不含範疇三。
- 營收基礎的碳強度只適用於有營收的公司；商品與加密資產使用不同依據，彼此的等級不是在同一把尺上比較。
- 門檻為常數：修改門檻需要重新部署合約；前端另有一份 TypeScript 鏡像（`frontend/src/lib/pepefi/carbon.ts`），
  兩者需同步修改，否則會無聲漂移。
- 等級影響費率與槓桿上限，**不是**永續揭露、綠色認證或任何法規分類（例如 SFDR、歐盟分類標準）的判斷。

## 7. 改進路線

| 優先 | 項目 | 說明 | 狀態 |
|---|---|---|---|
| 1 | 第三方確信 | 由獨立確信機構對資料與分級流程出具有限確信（limited assurance）意見 | 未開始；**需客戶確認**要求的確信等級 |
| 2 | 授權資料源 | 改接有授權的 ESG／排放資料供應商，取代二手彙整網站 | 未開始；授權成本與條款**需客戶確認** |
| 3 | 獨立見證者 | 把 `ATTESTOR_ROLE` 授予彼此獨立的機構（例如客戶的永續單位、資料供應商），讓中位數與離散度有意義 | 未開始 |
| 4 | 來源可驗證 | 把來源文件內容雜湊或存證（例如 IPFS）與 `sourceHash` 對應 | 未開始 |
| 5 | 補齊 ETF 覆蓋率 | 以完整持股加權計算 sESGU 等 ETF | 未開始 |
| 6 | 標示 PCAF 分數 | 在每筆 attestation 的鏈下資料中註明對應的 PCAF 資料品質分數 | 未開始 |
