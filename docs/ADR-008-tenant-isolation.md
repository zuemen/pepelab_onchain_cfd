---
status: proposed
---

# 每個白標租戶一套合約與金鑰：共用程式碼，不共用資金、權限與事故

白標的定位是：持牌機構用自己的品牌上架這套鏈上 CFD 與 agent 付費 API。現況是**單一共用部署**——Base Sepolia 上一組 `PerpetualExchange`、`InsuranceVault`、`FeeRouter`、`AssetVaultV2_4`、`GuardedOracle`、`AgentSessionManager`，一組 keeper，一組角色金鑰，所有使用者共用。合約裡沒有任何「租戶」或「營運者」的概念（唯一沾邊的是 exchange 的 `marketOperator`，它是切換 ReduceOnly 的角色，不是租戶）。

幾個合約層的事實決定了這件事只能用「部署」而不能用「參數」解決：

- `PerpetualExchange.oracle` 是 `immutable`，換 oracle 就是換 exchange。
- `FeeRouter` 的 `platformTreasury` 是 `immutable`，分潤比例（70% 交易員／20% 平台／10% 保險金）是常數。
- `InsuranceVault.bailout` 只接受它綁定的 exchange 呼叫；保險金是一個池子，沒有分帳。
- guardian 的 `pause()` 是整個 exchange 一起停，`GuardedOracle.setPaused` 是整個 oracle 一起停。

也就是說，兩個機構只要共用同一個 exchange，就共用同一池保險金、同一個收款地址、同一個暫停鍵——一家的事故就是另一家的事故。前端的租戶設定（[frontend ADR 0009](../frontend/docs/adr/0009-tenant-config-layer.md)）只能決定畫面與送單前的政策，它不是安全邊界。

## 決定

**每個租戶一套自己的合約、金鑰與收款地址；共用的是程式碼、工具與上游價格來源，不共用資金、權限與事故面。**

### 共用與不共用

| 元件 | 每租戶一套 | 共用 | 理由 |
|---|:-:|:-:|---|
| `PerpetualExchange`（含 `StrategyRegistry`／`CopyTracker`，若租戶啟用） | ✓ | | 部位、保證金、暫停鍵、資產模式都在這裡；oracle 綁死在建構子 |
| `InsuranceVault` | ✓ | | 損失吸收不跨租戶；A 的清算缺口不能用 B 的保險金補 |
| `FeeRouter`＋租戶收款地址（treasury） | ✓ | | treasury 是 immutable；收入隔離 |
| `AssetVaultV2_4`（proxy）＋合成資產代幣 | ✓ | | 發行上限、儲備率、鑄造暫停是逐租戶的風險決定；代幣各自發行，持有人權利清楚 |
| `GuardedOracle` | ✓ | | 見下方「oracle 與 keeper」 |
| `AgentSessionManager` | ✓ | | 綁定該租戶的 exchange；session 不跨租戶 |
| `ESGRegistryV2`（碳分級見證） | 預設 ✓ | 可選 | 見證是關於資產的事實，理論上可共用；但 exchange 與 vault 用它定價，共用等於平台的見證人能改所有租戶的費率。預設專屬，租戶明確選擇才指向平台的登錄 |
| 角色金鑰：admin、risk、guardian、keeper、marketOperator、部署者 | ✓ | | 權限隔離；`scripts/check-tenant-deploy.mjs` 禁止租戶之間或與正式站共用任何一把 |
| 合約程式碼與版本 | | ✓ | 同一份原始碼、同一組測試；租戶不分叉合約 |
| 前端程式碼 | | ✓ | 以租戶設定產生各自的 build（ADR 0009） |
| keeper 程式（`agent/keeper/`） | | ✓ | 同一份程式，每租戶各自的排程、金鑰與目標位址 |
| 上游價格來源（行情 API、`AggregatorOracle` 等參考價） | | ✓（可換） | 見下方；租戶可指定自己授權的資料源 |
| 結算幣（USDC／測試網 MockUSDC） | | ✓ | 鏈上既有的代幣，不是我們的元件 |

### 收費模式：base fee ＋ 租戶 markup（**待決**）

結構是「平台收 base fee，租戶在上面加自己的 markup」。**數字、收取方式都未決定**，本 ADR 不替它們做決定，只記錄需要決定的事：

1. base fee 與 markup 的數字（bps），以及是否依資產或碳分級區分。
2. 收在鏈上還是鏈下：
   - 鏈上：需要一個能分給「平台 treasury」與「租戶 treasury」兩個地址的 FeeRouter 版本——現行 `FeeRouter` 只有一個 immutable treasury、比例是常數，**需要改合約**。
   - 鏈下：租戶的 FeeRouter 全部收進租戶 treasury，平台以授權費／月費按鏈上成交量開票，**不需改合約**，但平台收入依賴對帳。
3. 保險金那一份（現行 10%）由誰出、是否計入 base fee。

`deploy/tenants/*.json` 的 `fees` 欄位在決定前固定是 `pending-decision`、數字為 `null`，檢查腳本不允許這種狀態的租戶標成 `deployed`。

### oracle 與 keeper：專屬 oracle、共用上游、分開金鑰

| 方案 | 優點 | 缺點 |
|---|---|---|
| A. 全部共用（一個 `GuardedOracle`、一把 keeper 金鑰） | 最便宜：每輪一組餵價交易 | guardian 凍結一個資產＝所有租戶一起凍結；keeper 金鑰外洩影響所有租戶；exchange 的 oracle 是 immutable，**共用之後就永遠拆不開** |
| **B. 每租戶一個 `GuardedOracle`＋各自 keeper 金鑰，共用上游價格來源與 keeper 程式（建議）** | 凍結、暫停、偏離上限是逐租戶的決定；金鑰外洩只影響一個租戶；程式只維護一份 | 餵價交易數隨租戶數線性增加（gas、RPC 額度）；上游來源斷線仍會同時影響所有租戶 |
| C. 全部專屬（含上游資料源） | 事故完全隔離；租戶用自己授權的資料 | 成本最高；需要租戶自備資料授權 |

建議 **B**，並保留租戶升級到 C 的路：`priceSource` 在部署設定裡是 `shared` 欄位，換成租戶自己的來源不需要改合約。方案 A 被否決的決定性理由是不可逆——exchange 的 oracle 綁死在建構子，一旦兩個租戶共用，之後要拆就是重新部署 exchange 並清空部位。

keeper 的排程可以是同一支 workflow 以租戶為 matrix 展開，但每個租戶用自己的 secret 名稱（`deploy/tenants/<id>.json` 的 `secretsEnv`），而且一個租戶的餵價失敗不能讓其他租戶那一輪也失敗。

### 隔離的三個面向

- **資金**：每租戶自己的 exchange 保證金、`InsuranceVault`、`AssetVault` 準備、`FeeRouter` treasury。沒有任何跨租戶的 bailout 或資金移轉路徑；`InsuranceVault.bailout` 只接受自己的 exchange。
- **權限**：每租戶自己的 admin／risk／guardian／keeper／marketOperator。一個租戶的 admin 不能對另一個租戶的合約做任何事；檢查腳本擋下任何跨租戶或與正式站重複的地址。
- **事故**：租戶 A 的 guardian 暫停 A 的 exchange、凍結 A 的 oracle 資產、暫停 A 的 vault，對 B **完全沒有影響**，因為那是不同的合約。仍然會同時影響多個租戶的只有共用層：上游價格來源斷線（所有租戶的價格一起過期、開平倉一起 revert `StalePrice`）、共用前端或 keeper 程式的缺陷（下次部署時一起受影響）、底層鏈本身。這三者要在事故手冊裡被列為「跨租戶事故」，通報對象是所有租戶。

### 與 guardian／Timelock 治理的關係

`master` 上還沒有 Timelock 合約，也沒有治理移交文件；以下只引用概念，細節以之後的治理移交文件為準。

- 每個租戶的治理結構與現行目標一致（[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md)、[`ROLE_SEPARATION.md`](ROLE_SEPARATION.md)）：admin 是 multisig，理想上在 Timelock 後面；guardian 是能快速暫停、但不能恢復或升級的溫錢包；risk 只調上限與費率；keeper 是受偏離上限約束的熱錢包。
- 差別只在「每個租戶一套」。guardian 的暫停權限是逐租戶的：租戶的營運團隊與平台值班都可以被授予**該租戶**的 guardian，但任何人都不會持有跨租戶的 guardian。
- **待決**：租戶 admin multisig 的簽署人組成（只有租戶？平台＋租戶？）與 Timelock 延遲長度。這決定了「誰能升級某個租戶的 vault」，是商務與法遵問題，不在本 ADR 決定。
- 現行合約的限制照樣適用於每個租戶：exchange 的 owner 是單一 Ownable 地址、guardian 暫停有 72 小時上限且只有 owner 能解除。

## 遷移路徑

1. **階段 0（本次）**：前端租戶設定層（default 租戶＝現行正式站，外觀與行為不變）、租戶部署設定範本與唯讀檢查、本 ADR。沒有任何合約或 broadcast 變動。
2. **階段 1：部署腳本參數化（dry-run 為主）**。`Redeploy129Exchange.s.sol` 目前把 USDC、oracle、FeeRouter、保險金、KYC 等位址寫成常數，必須改成讀環境變數才能用於新租戶；keeper workflow 改成以租戶部署設定為輸入。每一步先以不加 `--broadcast` 的模擬驗證。
3. **階段 2：第一個試點租戶（測試網）**。依 [`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md) 部署一整套專屬合約，部署設定改成 `deployed`；`addresses.ts` 需要擴充成「依租戶的多組位址」（仍是唯一來源，`consistency.yml` 一併擴充），前端租戶設定才能指向自己的合約。前端租戶設定檔**刻意沒有地址欄位**——地址只有 `addresses.ts` 一個來源。
4. **階段 3：收費模式定案與實作**（上方待決事項）。
5. **現行正式站是「租戶零」**：它繼續用現有那套合約，不搬遷任何部位。新租戶從零開始，不存在跨套合約移轉部位的需求；若日後正式站本身要換新版合約，仍依既有的 cutover 程序（排空、重新部署），與租戶化無關。

## Considered options

**單一部署、合約內加 `tenantId` 分帳。** 否決：要改 exchange、保險金、FeeRouter、vault 的每一條資金路徑，並且讓一個 bug 就能跨租戶挪用資金；暫停鍵仍是共用的。隔離靠程式邏輯而不是合約邊界，稽核範圍也跟著變大。

**共用 exchange、每租戶只分開 vault 與 treasury。** 否決：保證金與保險金仍共用，一個租戶的清算缺口會吃掉共用保險金；guardian 暫停仍然全站一起停。

**完全獨立的程式碼分支（每租戶 fork）。** 否決：修補無法同步，稽核成本乘以租戶數。租戶差異全部放在設定（前端 JSON、部署 JSON），不放在程式碼。

## Consequences

- 每多一個租戶就多一套合約的部署、驗證、監控與 keeper gas；營運成本隨租戶數線性增加，需要反映在收費模式裡（待決）。
- 事故手冊需要區分「單一租戶事故」與「跨租戶事故」（共用上游來源、共用程式缺陷、鏈本身）。
- `addresses.ts` 與 `consistency.yml` 需要擴充成依租戶的多組位址（階段 2）；在那之前，前端租戶只能換品牌與政策，仍指向現行合約。
- `scripts/check-tenant-deploy.mjs` 是部署前的第一道關卡，只讀、不送交易；真正的部署仍由持有金鑰的人依 [`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md) 執行。
