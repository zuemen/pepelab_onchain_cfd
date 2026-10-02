---
status: proposed
date: 2026-10-02
plan-item: P3-08
---

# 每個租戶一個分層保險金庫：租戶自有資本當 junior、外部 LP 當 senior，對沖在鏈下由租戶執行

> 2026-10-02。本文只是設計，**沒有任何程式或部署變動**。損失吸收的現況見 [`RISK_WATERFALL.md`](RISK_WATERFALL.md)，
> 代幣化金庫的風險見 [`RISK_MODEL.md`](RISK_MODEL.md)，租戶隔離見 [`ADR-008`](ADR-008-tenant-isolation.md)，
> 合約升級架構見 [`ADR-015`](ADR-015-v3-upgradeability.md)。外部資料的查詢日期都是 2026-10-02；標 **未查證** 的項目沒有找到可靠來源。
> 標 **【待擁有者決定】** 的項目本 ADR 不替擁有者做決定。

## 1. 背景

### 1.1 現在誰在承擔損失

永續 CFD 沒有獨立的做市商或 LP 對手方。所有交易者的保證金放在 exchange 合約自己的 USDC 餘額裡，這個資金池就是所有部位的對手方（`docs/RISK_WATERFALL.md:31-33`）：

- 保證金以 `safeTransferFrom` 存進 exchange，以 `freeMargin` 記帳；贏家的獲利只是記進 `freeMargin`，`withdrawMargin` 從 exchange 自己的餘額付（`contracts/src/PerpetualExchange.sol:1040-1042`、`:1055-1059`）。
- 餘額不夠時提領 revert，**不會**自動向保險金庫撥款（`docs/RISK_WATERFALL.md:33`）。

一筆部位的虧損超過保證金時，缺口由 `_absorbShortfall` 處理（`contracts/src/PerpetualExchange.sol:1247-1269`），順序是：

1. 保險金庫：`bailout(min(缺口, totalAssets))`，撥回 exchange。
2. ADL：對同資產、反方向、有獲利的部位依建立順序掃描，最多 128 筆，削減獲利（`PerpetualExchange.sol:1301`、`:133`）。
3. 仍未覆蓋的部分發 `BadDebt` 事件，沒有後續補足機制（`docs/RISK_WATERFALL.md:51-52`）。

文件的結論是「現行部署版**不保證恆償付**」（`docs/RISK_WATERFALL.md:73`）。

### 1.2 兩種不同的風險，現在只有一種有後盾

| 風險 | 是什麼 | 現在誰吸收 |
|---|---|---|
| **缺口風險** | 單一部位的虧損超過它的保證金（跳空、清算來不及） | 保險金庫 → ADL → `BadDebt`（上一節） |
| **淨曝險風險** | 交易者**整體**淨賺錢：例如多數人做多、價格上漲，贏家的獲利大於輸家的保證金總和 | **沒有任何資本。** 最後幾個提領的人拿不到錢。`ops/monitoring/monitors.json` 沒有比對「exchange 餘額 vs. 交易者總請求權」的規則 |

原始碼版（PR #191，未部署）加了逐資產 OI 上限與單筆獲利上限。合約註解寫明它們的用途是替「以資金池為對手方的交易所」界定最壞負債：穩定價格下最壞情況約為 `(maxLongOI + maxShortOI) × maxProfitBps`（`contracts/src/PerpetualExchange.sol:425-433`）。上限只界定了負債，**還沒有一筆資本是照這個上限準備的**。

### 1.3 現有金庫

| 金庫 | 資金來源 | 吸收什麼 | 證據 |
|---|---|---|---|
| `InsuranceVault`（pIV 份額） | 任何人 `deposit`；清算罰金（剩餘抵押的 20%）；`vaultFeeShareBps` 的交易費分成（現行為 0）；FeeRouter 的 10%（跟單費、績效費、x402 收入）；owner `recapitalize`（不發份額） | 缺口風險，只經由 `bailout` | `contracts/src/InsuranceVault.sol:82`、`:73`、`:145-146`；`PerpetualExchange.sol:1216-1218`、`:1705-1713`；`contracts/src/FeeRouter.sol:24-25`、`:102-127`；`docs/RISK_WATERFALL.md:27` |
| `AssetVaultV2` 家族（UUPS） | 鑄造者的 USDC＋營運方 `fundVault` | 合成資產多頭的對手方，非足額；`minReserveRatioBps` 11000 | `docs/RISK_MODEL.md:13-18`、`:36-38`；`contracts/src/v2/AssetVaultV2_4.sol:243`、`:711` |

`InsuranceVault` 的幾個性質，直接決定了分層設計要改什麼：

- **提領沒有鎖倉、沒有冷卻**（`InsuranceVault.sol:97-105`）。LP 看到大行情時可以搶在 bailout 前提走——首損資本最需要的「事故當下不能跑」它沒有。
- `bailout` 只接受綁定的 exchange，金額不得超過 `totalAssets`，可以被撥到 0（`InsuranceVault.sol:154-156`；`RISK_WATERFALL.md:46-47`）。
- 沒有虛擬份額（`docs/KNOWN_LIMITATIONS.md:859-867`，#25）。
- exchange 的 `insuranceVault` **不是 immutable**，owner 用 `setInsuranceVault` 可以換（`PerpetualExchange.sol:265`、`:733-736`），exchange 只呼叫三個函式：`totalAssets`、`bailout`、`depositFromProtocol`（`PerpetualExchange.sol:21-25`）。另外 bailout floor 會以 `bailout(floor, pos.owner)` 直接付給被爆倉的交易者（`:1927`）。
- `FeeRouter.insuranceVault` **是 immutable**（`contracts/src/FeeRouter.sol:20`）：換保險金庫時，FeeRouter 的 10% 仍流進舊金庫。

`AssetVaultV2` 不承擔永續部位的損益（只在註解提到 exchange），是另一個產品的對手方；本 ADR 不把它納入分層，只在 §6 談它與租戶資本的關係。

### 1.4 對沖

repo 裡沒有任何對沖介面。最接近的是 signal-api 的 `/risk/exposure`：只列多空 OI 與保險金 `totalAssets`，沒有淨額欄位（`agent/signal-api/src/exposure.ts:209-210`、`:237`、`:250`）；以及聚合器裡的 `skewProxyBps`（`agent/shared/src/aggregate.ts:160`）。原始碼版的 exchange 有逐資產的 `longOpenSize`／`shortOpenSize`（`PerpetualExchange.sol:454-455`），淨曝險可以從它算，但部署版沒有。

### 1.5 白標的要求

ADR-008 規定每個租戶一套 `InsuranceVault`，不跨租戶 bailout（`docs/ADR-008-tenant-isolation.md:31`、`:92`），「保險金那 10% 由誰出」未決（`:54`）。RISK_WATERFALL 把「保險金庫資本由誰出資、規模、提領規則」與「壞帳是否由客戶補足」列為需客戶確認（`docs/RISK_WATERFALL.md:141-142`）。持牌機構拿自有資本當對手方時，需要一個**看得懂、算得出最大損失**的結構，而不是「資金池互為對手方、最後幾個人拿不到錢」。

### 1.6 關於計畫裡的順序

商業化計畫把這一項寫成「保險金庫 → ADL → junior buffer」。這裡有一個用詞上的矛盾要先講清楚：**junior（次順位）指的是最先吸收損失的那一層**，所以報酬最高。放在 ADL 之後的資本其實是「最後防線（backstop）」，承擔的是最不可能發生的損失，報酬應該最低。兩種都是合理的設計，但它們的出資人、報酬、揭露都不一樣，不能用同一個名字。本 ADR 的建議把 junior 放在 ADL 之前（§3），並把「要不要再加一層 ADL 之後的租戶 backstop」列為擁有者決定（§8 第 1 題）。

## 2. 外部參考（查證）

| 設計 | 事實 | 來源 |
|---|---|---|
| Ostium（RWA perp，部署在 **Arbitrum**，不是 Base） | OLP 是 senior；junior buffer 由 Ostium 關係方與策略夥伴出資，**交易者損益先由 buffer 全額吸收**，buffer 用完才輪到 OLP。贏家由金庫鏈上支付、buffer 縮小，結算時把鏈下對沖帳的對應獲利送回鏈上補 buffer。方向性部位「先在內部軋差，只把剩餘的淨 delta」交給做市商、主經紀商等機構夥伴在**鏈下**對沖 | <https://docs.ostium.com/protocol/how-ostium-works> |
| Ostium 提款 | OLP 提款採申請後結算，通常 2–3 天 | <https://docs.ostium.com/vault/getting-started/withdraw.md> |
| GMX v2 GM／GLV 池 | 池子是交易者的對手方（交易者獲利來自池子的價值）；每個 GM 池風險隔離，以多空各自的 `MAX_OPEN_INTEREST` 與 `MAX_POOL_AMOUNT` 設上限，另有 reserve factor 與 `MAX_PNL_FACTOR` | <https://docs.gmx.io/docs/providing-liquidity> |
| GMX v2 ADL | 待結 PnL 對池值比例超過 `MAX_PNL_FACTOR_FOR_ADL` 時強制減少獲利部位 | <https://docs.gmx.io/docs/trading/liquidations> |
| Hyperliquid HLP | 社群所有的金庫，負責做市與清算；從最近一次存款起鎖定 4 天 | <https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/protocol-vaults> |
| gTrade gToken | ERC-4626 金庫；抵押不足時鑄造 GNS 補庫，上限每 24 小時總供給 0.05%；提款以 3 天為一個 epoch，依抵押率等 1–3 個 epoch | <https://docs.gains.trade/liquidity-farming-pools/gtoken-vaults>、<https://docs.gains.trade/liquidity-farming-pools/gtoken-vaults/staker-faq.md> |
| dYdX v4 | 清算 → 保險基金 → 去槓桿；隔離市場各有獨立保險基金 | <https://help.dydx.trade/en/articles/166973-contract-loss-mechanisms-on-dydx-chain> |
| 分層 LP（Level Finance） | Senior／Mezzanine／Junior 三種 LLP，各層隔離。**損失分配公式未查證**（官方文件抓取失敗） | <https://support.level.finance/what-can-i-do-with-a-senior-mezzanine-or-junior-llp/> |

最接近本專案的是 Ostium：同樣是 RWA 為主、同樣以 USDC 結算、同樣需要在休市時處理跳空，而它的答案是「關係方出 junior、外部 LP 出 senior、淨 delta 在鏈下對沖」。

## 3. 方案比較

| | A. 維持現況＋上限 | **B. 分層保險金庫（建議，先做）** | C. 分層對手方金庫（GMX／Ostium 式） | D. 租戶 backstop 放在 ADL 之後 |
|---|---|---|---|---|
| 是什麼 | 只靠 OI 上限、獲利上限、ReduceOnly 限制曝險；保險金庫照舊 | 新的 `TranchedInsuranceVault` 取代 `InsuranceVault`：junior 份額（租戶自有資本）先吸收、senior 份額（外部 LP）後吸收；介面與 exchange 相容，以 `setInsuranceVault` 換上 | 金庫直接當每筆部位的對手方：交易者獲利由金庫付、虧損進金庫；exchange 只保管保證金 | 保持現在的順序，壞帳發生後由租戶的承諾資本補足（鏈上金庫或鏈下承諾） |
| 解決缺口風險 | 部分（減少發生） | ✓，且有明確先後 | ✓ | ✓，但只在 ADL 之後 |
| 解決淨曝險風險 | ✗ | 部分：見下方「B 的限制」 | ✓（這是它的設計目的） | ✗ |
| 合約改動 | 無（PR #191 已有，待 cutover） | 新合約一顆＋租戶的 FeeRouter；**exchange 不動** | exchange 平倉、清算、funding 路徑都要改 | 小（一顆收款合約）或無（鏈下） |
| 能否放進現行 exchange | — | 能：exchange 只呼叫三個函式，`insuranceVault` 可換 | **不能**：exchange 只剩 665 B（`docs/DEPLOY_130_CUTOVER.md:264`），要等 V3（ADR-015） | 能 |
| 對終端客戶 | ADL 仍是第二道 | junior＋senior 都用完才 ADL | ADL 只在池子 PnL 比例過高時 | **ADL 先於租戶資本**：客戶的帳面獲利會先被削，持牌機構最難對客戶解釋的一種 |
| 出資人報酬 | — | junior 拿較高的費用分成＋清算罰金優先；senior 拿較低、較穩的分成 | junior 拿交易者淨損失（house edge）＋費用；senior 拿固定比例 | backstop 承擔最少，報酬最低（或只是義務、無報酬） |
| 主要風險 | 淨曝險完全沒有資本 | 淨曝險只有在「轉成缺口」時才被吸收（見下） | 金庫直接承擔方向性風險，需要對沖與更嚴的上限；合約改動大 | 和 A 一樣，加上 ADL 的客戶關係成本 |

**B 的限制要講清楚。** 淨曝險風險在 B 之下仍然不會「自動」撥款：保險金庫只在部位虧損超過保證金時被呼叫。交易者整體淨賺、而 exchange 餘額不夠時，提領仍會 revert。B 對這件事的處理是兩個非合約的補強：

1. 監控：新增「償付性」規則（§5 階段 0）——exchange 的 USDC 餘額對比全部 `freeMargin`＋未平倉保證金＋未實現獲利，低於門檻即 SEV-1。
2. 補資本的動作有明確的人與錢：租戶以 junior 份額的資金 `recapitalize` 到 exchange（需要一個經 Timelock 的注資函式，見 §5 階段 1 第 4 點），或觸發 ReduceOnly。

真正讓資本自動站在交易者對面的是 C，它需要改 exchange 的結算路徑，只能在 V3 做。

## 4. 決定（建議）

**採 B，作為上主網前的版本；C 進 V3（ADR-015），D 不作為預設、改為擁有者可選的附加承諾。**

### 4.1 新的損失吸收順序（逐倉、單一租戶）

| 順位 | 吸收者 | 吸收什麼 | 觸發條件 | 上限 |
|---|---|---|---|---|
| 0 | （事前）OI 上限、獲利上限、ReduceOnly、暫停 | 限制最大負債 | 開倉時 | 由租戶風控設定，**上主網前必須非 0**（§7） |
| 1 | 虧損部位持有人 | 該部位保證金 | 平倉或清算時 `平倉金額 < 0` | 保證金全額 |
| 2 | **junior 份額（租戶自有資本）** | 缺口 | 順位 1 不足 | junior 淨值 |
| 3 | **senior 份額（外部 LP）** | 缺口 | junior 淨值為 0 | senior 淨值；可設「senior 單日最大撥款」以爭取人工介入時間【待擁有者決定】 |
| 4 | ADL | 反方向獲利部位的帳面獲利 | junior＋senior 都不足 | 掃描到的獲利總和（最多 128 筆） |
| 5 | `BadDebt` 揭露；可選的租戶 backstop（方案 D） | 未覆蓋壞帳 | 順位 4 仍不足 | 無上限／依租戶承諾 |

`bailout(amount)` 在新金庫裡先扣 junior、再扣 senior；`totalAssets()` 回傳 junior＋senior 的可用淨值（exchange 據此計算可撥金額與 bailout floor，`PerpetualExchange.sol:1886`）。

### 4.2 資金來源與報酬

| | junior | senior |
|---|---|---|
| 出資人 | 租戶本身或其指定的關係方（做市商、自營部門）；**只限白名單地址** | 合格投資人或公開 LP（依租戶的法遵決定，可用租戶的 `KYCRegistry` 做門檻） |
| 收入 | 清算罰金（現在 20% 進金庫，`PerpetualExchange.sol:1216-1218`）**全部**；交易費分成（`vaultFeeShareBps`）的較大比例 | 交易費分成的較小比例；FeeRouter 的 10%（若租戶決定給 senior） |
| 分配比例 | 【待擁有者決定】。參數化為 `juniorFeeWeightBps`；建議預設讓 junior 的「收入／承擔」比例高於 senior，否則沒有人願意出 junior | 同左 |
| 最低規模 | junior 淨值 ≥ `juniorMinRatio × 最壞負債`（最壞負債用 §1.2 的公式從鏈上上限算）；低於此值時**自動停止新開倉**的做法需要改 exchange，V1 改由監控＋marketOperator 切 ReduceOnly | — |
| 提領 | 申請後冷卻（建議 ≥ 7 天）＋提領後 junior 淨值不得低於最低規模；`bailout` 期間（有未結缺口時）凍結 | 申請後冷卻（參考 Ostium 2–3 天、HLP 4 天、gTrade 3–9 天）；冷卻期間份額仍承擔損失 |
| 份額會計 | ERC-4626 式、含虛擬份額（一併修掉 #25） | 同左 |

**為什麼 junior 一定要有冷卻與凍結：** 現行 `InsuranceVault` 沒有鎖倉（`InsuranceVault.sol:97-105`），首損資本若能在 bailout 前一個區塊提走，順位表就只是紙上的。

### 4.3 對沖介面

**鏈上只提供「看」，不提供「動錢」。對沖由租戶（或其授權的機構夥伴）在鏈下執行，盈虧在鏈下結算後以注資回到 junior。**

鏈上（新金庫或 V3 的 lens）提供唯讀資料：

- 逐資產淨曝險：`(longOpenSize − shortOpenSize) × index price`（`PerpetualExchange.sol:454-455`，原始碼版才有）。
- 最壞負債：依 OI 上限與 `maxProfitBps` 計算（`PerpetualExchange.sol:425-433` 的公式）。
- junior／senior 淨值、待提領申請、最近一次 bailout。

鏈下：

- 執行者：租戶的交易部門或其指定的做市商／主經紀商（Ostium 的做法）。平台不代租戶下對沖單——那是持牌業務，不是軟體服務。
- 對沖的盈虧**不經過合約**。對沖賺錢時，租戶以 `depositJunior` 補回 junior；虧錢時由租戶自行承擔。鏈上不認列鏈下帳戶的價值。
- 對帳：租戶每日提供對沖部位報告（格式由租戶風控定）；平台的監控只看鏈上淨曝險 vs. junior 淨值的比例。

**不做鏈上 hedger 角色（不讓任何角色把金庫的 USDC 轉去對沖場所）**，理由：

1. 多一個能把資金移出金庫的角色，就多一條被盜的路徑；這把金鑰也會變成最值錢的熱錢包（ADR-014 的範圍）。
2. 本專案的大部分資產是美股、ETF、黃金期貨（`agent/keeper/market.ts:16-28`），Base 上這些標的有沒有足夠深度的鏈上對沖場所：**未查證**。
3. 若將來要做，權限限制至少包括：只能動 junior 的資金、每資產上限＝當下淨曝險 ×（1＋容忍度）、目的地合約白名單由 Timelock 設定、guardian 可即時凍結、每筆發事件且被監控為 SEV-2。這些寫在這裡是為了將來的 ADR，不是本次決定。

### 4.4 和現有金庫的關係

- **`InsuranceVault`**：新租戶直接部署 `TranchedInsuranceVault`，不再部署舊版。平台自己（「租戶零」）的舊保險金庫：現有 pIV 持有人轉成 senior 份額（自願贖回後再存入，不做強制轉換），舊金庫保留到餘額為 0。
- **`FeeRouter`**：它的 `insuranceVault` 是 immutable（`FeeRouter.sol:20`），換金庫時 FeeRouter 也要重新部署並改接（exchange 的 `feeRouter` 可換，`PerpetualExchange.sol:681`）。新租戶沒有這個問題。
- **`AssetVaultV2`**：不併入。它承擔的是合成資產多頭，風險形狀不同（準備率而不是保證金）。但租戶若同時開兩個產品，它的 junior 資本與 `fundVault` 的注資是**同一筆公司資本的兩個用途**，風控要合併看（§6）。
- **ADL 與 `BadDebt`**：合約邏輯不變；只是前面多了兩層。

## 5. 實作計畫

工作量是單人估計（含測試，不含外部稽核與等待時間），**未經驗證**。

| 階段 | 內容 | 工作量 | 前置 |
|---|---|---|---|
| **0. 量測與揭露（不改合約）** | (1) `/risk/exposure` 加逐資產淨曝險、最壞負債、exchange 餘額 vs. 總請求權；(2) 監控新增「償付性」與「淨曝險 / 金庫淨值」兩條規則（ADR-009 的規則流程）；(3) 租戶風控報告範本（§6 的清單） | 3–5 人日 | 淨曝險要原始碼版 exchange（#130 cutover 後） |
| **1. `TranchedInsuranceVault`** | (1) 實作 `IInsuranceVaultPerp` 三個函式，`bailout` 先 junior 後 senior，支援 `bailout(floor, trader)` 直接付交易者；(2) 兩種份額、虛擬份額、提領申請與冷卻、有缺口時凍結 junior；(3) junior 白名單、senior 可接 `KYCRegistry`；(4) Timelock 才能呼叫的 `fundExchange`（用 junior 資金補 exchange 的償付缺口，處理淨曝險，見 §3「B 的限制」）；(5) 收入分配參數；(6) fuzz／invariant 測試：任何順序的 bailout、提領、存入下，junior 先歸零才動 senior | 10–15 人日 | — |
| **2. 部署工具與租戶接線** | `DeployTenant.s.sol` 改部署新金庫；`VerifyTenant` 讀回；監控規則；`TENANT_DEPLOYMENT.md`、`RISK_WATERFALL.md` 改寫 | 3–5 人日 | 階段 1 |
| **3. 平台（租戶零）切換** | 部署新金庫與新 FeeRouter，Timelock 排程 `setInsuranceVault`／`setFeeRouter`（48 小時），舊金庫只剩贖回 | 2 人日＋48 小時延遲 | 階段 1、Timelock 移交（P1-15） |
| **4. V3 對手方金庫（方案 C）** | 併入 ADR-015 的 V3：金庫成為每筆部位的對手方 | 隨 V3 估計 | ADR-015 |
| 外部稽核 | 新金庫是持資金合約 | **未查證**（要詢價） | 階段 1 |

## 6. 對 B2B 租戶的意義：風控部門要看什麼

租戶拿自有資本當 junior，等於在做「對客戶的方向性曝險的首損承擔者」。風控部門至少要能回答：

1. **最大可能損失**：每個資產的 `(maxLongOI + maxShortOI) × maxProfitBps`，加總後對 junior 淨值的倍數。上限若是 0（預設關閉，`RISK_WATERFALL.md:81-82`），最大損失就沒有上限。
2. **淨曝險與集中度**：逐資產淨多／淨空、前十大部位佔比、單一客戶佔 OI 比例。
3. **跳空風險**：股票、ETF、黃金期貨在休市時價格不更新（`agent/keeper/market.ts:1-9`），開盤跳空直接變成缺口。休市時 ReduceOnly 的開關（`agent/keeper/operator.ts:1-10`）預設關閉；租戶要決定是否打開。
4. **價格來源風險**：缺口的大小取決於清算時的價格是否及時；見 [ADR-013](ADR-013-pull-oracle.md)。
5. **對沖的基差與執行**：鏈上指數價格與鏈下對沖標的（例如股票 vs. 該股的 CFD 或期貨）之間的差；對沖帳戶本身的對手方與保證金風險。
6. **流動性**：senior 的提領冷卻內可能被提走多少；junior 被凍結時公司資金的流動性需求。
7. **ADL 與壞帳的揭露**：junior＋senior 用完之後客戶的獲利會被削（`RISK_WATERFALL.md:140`），要寫進契約與風險揭露書。
8. **兩個產品的合併曝險**：同時經營代幣化配置（`AssetVaultV2`，非足額，`RISK_MODEL.md:13-18`）時，junior 與 `fundVault` 的注資要合併計算。
9. **資本與會計處理**：junior 份額在租戶帳上是投資、保證金還是準備，以及當地法規對「以自有資本承作客戶 CFD 對手方」的資本要求——**未查證，需要租戶的法遵與會計師判斷**。

## 7. 上主網前必須成立的條件

1. 每個要上主網的租戶：OI 上限與獲利上限**非 0**，且 junior 淨值 ≥ 擁有者定下的「最壞負債倍數」（§8 第 3 題）。
2. `TranchedInsuranceVault` 有 invariant 測試證明「junior 歸零前 senior 不動」「提領申請不能繞過凍結」，並經過外部稽核。
3. 償付性監控規則上線，並在測試網上模擬一次「交易者整體淨賺導致餘額不足」的告警與處置（含 `fundExchange` 經 Timelock 的時間）。
4. 金庫的 owner／admin 已在 Timelock 後面（P1-15）；junior 白名單與收入分配參數的變更都經過 Timelock。
5. 租戶的風險揭露書寫明順位表（§4.1），包含 ADL。
6. 租戶風控已收到並簽核 §6 的報告範本。

## 8. 待擁有者決定

1. **junior 的位置**：照本 ADR 放在 ADL 之前（建議），還是照計畫原文放在 ADL 之後（方案 D 的 backstop）？或兩者都要（ADL 前的 junior＋ADL 後的租戶 backstop 承諾）？
2. **收入分配**：清算罰金、交易費分成（`vaultFeeShareBps` 的數字）、FeeRouter 的 10% 在 junior／senior 之間怎麼分。
3. **junior 最低規模**：以最壞負債的幾倍為下限；低於下限時是只告警，還是要求 marketOperator 立即切 ReduceOnly。
4. **senior 是否開放給公眾**：開放就涉及募集與投資人保護，屬於租戶的法遵問題；不開放就只有 junior（等於租戶全額自擔）。
5. **提領冷卻天數**：junior 與 senior 各多久。
6. **平台自己（租戶零）是否也要有 junior**：如果有，出資人是誰。
7. **senior 單日撥款上限**：要不要設（設了會在大事故時更早進入 ADL，但給人工介入時間）。
8. **鏈上 hedger**：維持「鏈上只看、不動錢」（建議），還是在 V3 評估鏈上對沖。

## 9. Consequences

- 每個租戶的部署多一顆持資金合約（取代舊的 `InsuranceVault`），稽核範圍增加。
- 損失順位從「保險 → ADL → 壞帳」變成「junior → senior → ADL → 壞帳」，`RISK_WATERFALL.md`、`INTEGRATION_GUIDE.md`、租戶的風險揭露書都要改。
- 淨曝險風險在 V1 仍然只有「監控＋人工注資」，不是自動的；這一點要寫進 `KNOWN_LIMITATIONS.md`，直到 V3 的對手方金庫上線。
- 平台不經手對沖，因此不承擔租戶的對沖損益，也不需要對沖場所的帳戶；代價是平台無法保證租戶真的有對沖。

## 10. 參考

- 本 repo：[`RISK_WATERFALL.md`](RISK_WATERFALL.md)、[`RISK_MODEL.md`](RISK_MODEL.md)、[`ADR-008`](ADR-008-tenant-isolation.md)、[`ADR-009`](ADR-009-monitoring.md)、[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) #25
- Ostium：<https://docs.ostium.com/protocol/how-ostium-works>、<https://docs.ostium.com/vault/getting-started/withdraw.md>
- GMX：<https://docs.gmx.io/docs/providing-liquidity>、<https://docs.gmx.io/docs/trading/liquidations>
- Hyperliquid：<https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/protocol-vaults>
- Gains Network：<https://docs.gains.trade/liquidity-farming-pools/gtoken-vaults>
- dYdX：<https://help.dydx.trade/en/articles/166973-contract-loss-mechanisms-on-dydx-chain>
- Level Finance：<https://support.level.finance/what-can-i-do-with-a-senior-mezzanine-or-junior-llp/>（內容未能直接讀取）
