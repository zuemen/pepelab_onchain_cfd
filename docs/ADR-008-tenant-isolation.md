---
status: proposed
---

# 每個白標租戶一套合約與金鑰：共用程式碼，不共用資金、權限與事故

> **實作狀態（2026-10-02）**：階段 0–2 的**工具**已完成（部署腳本、讀回驗證、前端依租戶切換位址、CI 對帳、營運文件），
> 都只在測試與 fork 上跑過；**沒有任何租戶真的部署**，收費模式仍待決。逐項見文末「已完成／未完成」。
> `status` 仍是 `proposed`：接受這份決定是擁有者的事，不是實作進度。

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
| `AssetVaultV2`（proxy，選用；新租戶直接部署 V2.5）＋合成資產代幣 | ✓ | | 發行上限、儲備率、鑄造暫停是逐租戶的風險決定；代幣各自發行，持有人權利清楚 |
| `TraderStake` | ✓ | | 交易員的質押與罰沒只對這個租戶的 `CopyTracker` 負責 |
| `KYCRegistry` | ✓ | | 誰通過 KYC 是持牌機構自己的法遵決定；RWA 市場只在接了 registry 時才有 KYC 門檻，所以每個租戶一定有一顆 |
| `GuardedOracle` | ✓ | | 見下方「oracle 與 keeper」 |
| `AgentSessionManager` | ✓ | | 綁定該租戶的 exchange；session 不跨租戶 |
| `ESGRegistryV2`（碳分級見證） | 預設 ✓ | 可選（未實作） | 見證是關於資產的事實，理論上可共用；但 exchange 與 vault 用它定價，共用等於平台的見證人能改所有租戶的費率。預設專屬，租戶明確選擇才指向平台的登錄。`DeployTenant.s.sol` 目前只做專屬這一種 |
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

實作時的兩個修正（2026-10-01，細節在 [`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md)）：

- **金鑰隔離用 GitHub environment，secret 名稱也與平台不同。** 每個租戶一個 `keeper-<id>` environment，裡面放 `TENANT_KEEPER_PRIVATE_KEY`／`TENANT_RPC_URL`。environment secret 只有引用該 environment 的 job 拿得到；名稱刻意不叫 `KEEPER_PRIVATE_KEY`，因為 environment 漏放某個 secret 時 GitHub 會退回 repo 層級的同名 secret（2026-10-02 修正，PR #228 審查 F3）。
- **每個租戶一支 workflow，但不手寫、不複製：由範本產生**（`ops/tenant-keeper/keeper.template.yml`＋`scripts/gen-tenant-keeper.mjs`，檔名 `keeper-<id>.yml`）。`check-workflow-guards.mjs` 以範本重新產生、逐位元比對，範本本身整檔釘選；新增租戶不必改任何雜湊，也不能藉租戶的 workflow 改掉守門 step。位址不寫進 workflow，執行期從部署登記讀。不用 matrix 的理由不變：一支檔案服務所有租戶，改壞一次就全部停。

**租戶 oracle 自身的過期檢查是關掉的**（`maxPriceAge = 0`）。keeper 寫價前先讀 `getPrice`，讀取 revert 就拒寫；oracle 層的過期檢查開著，一次超過上限的中斷之後 keeper 就永遠寫不進去。過期由 exchange 與金庫各自依 `updatedAt` 把關（都是 6 小時）。

**價格變動的界線與過期無關，由 oracle 的兩道限速負責**：單次上限（`params.oracleMaxDeviationBps`）與時間窗累計上限（`params.oracleWindowSeconds`／`oracleWindowDeviationBps`，不得為 0），可選的參考來源（`shared.referenceSource`）。2026-10-02 之前租戶 oracle 只設了單次上限，連續多筆寫價的累計變動沒有上限——平台自己的 `RedeployGuardedOracle.s.sol` 早已要求的時間窗，租戶版漏了（PR #228 審查 F1）。代價：長時間停擺後的大幅跳價，沒有參考來源時要分幾個時間窗追上；有參考來源時，與參考一致的寫價直接落地並重設時間窗。

這不會讓過期價格被接受，理由是租戶 oracle 的每一個「會動到錢」的讀者都自己檢查 `updatedAt`（2026-10-02 逐一對過 `contracts/src`）：

| 讀者 | 路徑 | 過期時 |
|---|---|---|
| `PerpetualExchange` 開倉 | `_freshPrice`：`block.timestamp > updatedAt + maxPriceAge` 就 revert | `StalePrice`，`maxPriceAge` 由 `DeployTenant` 設成 6 小時、`VerifyTenant` 讀回 |
| `PerpetualExchange` 平倉、`closePositionFor`、清算 | `_requireFresh`（同一條件，另拒絕零價格） | `StalePrice` |
| `AssetVaultV2_5` mint／redeem／NAV | `effectiveMaxPriceAge()`（`min(maxPriceAge, LAST_GOOD_MAX_AGE)`），NAV 迴圈對過期資產改用 last-good 或視為不可估值 | `StalePrice`／不計入，`maxPriceAge` 設 6 小時 |
| `PerpetualExchange.getUnrealizedPnL`／`getPositionValue`／`getMarkPrice` | view，不檢查 | 只回傳數值、不改任何狀態；需要「現在能不能成交」時用 `PerpetualExchangeLens.hasValidPrice`（依 exchange 的 `maxPriceAge`） |

其餘租戶合約（`InsuranceVault`、`FeeRouter`、`TraderStake`、`CopyTracker`、`StrategyRegistry`、`AgentSessionManager`）不讀 oracle。代價只有一個：`GuardedOracle.isStale()` 在 `maxPriceAge = 0` 時永遠回 `false`，**租戶的監控不能用它判斷過期**，要用 exchange 的 `maxPriceAge` 對 `updatedAt`（`agent/keeper/health-check` 就是這樣做的；前端監控頁在專屬租戶上也改成這樣，平台部署照舊用 `isStale()`，PR #228 審查 F6）。回歸測試在 `contracts/test/DeployTenant.t.sol`：停擺 3 天後 oracle 仍可讀、exchange 自己拒絕過期價、keeper 下一筆寫價即恢復。

### 隔離的三個面向

- **資金**：每租戶自己的 exchange 保證金、`InsuranceVault`、`AssetVault` 準備、`FeeRouter` treasury。沒有任何跨租戶的 bailout 或資金移轉路徑；`InsuranceVault.bailout` 只接受自己的 exchange。
- **權限**：每租戶自己的 admin／risk／guardian／keeper／marketOperator。一個租戶的 admin 不能對另一個租戶的合約做任何事；檢查腳本擋下任何跨租戶或與正式站重複的地址。
- **事故**：租戶 A 的 guardian 暫停 A 的 exchange、凍結 A 的 oracle 資產、暫停 A 的 vault，對 B **完全沒有影響**，因為那是不同的合約。仍然會同時影響多個租戶的只有共用層：上游價格來源斷線（所有租戶的價格一起過期、開平倉一起 revert `StalePrice`）、共用前端或 keeper 程式的缺陷（下次部署時一起受影響）、底層鏈本身。這三者要在事故手冊裡被列為「跨租戶事故」，通報對象是所有租戶。

### 與 guardian／Timelock 治理的關係

平台自己的 Timelock 移交在 [`GOVERNANCE_HANDOVER.md`](GOVERNANCE_HANDOVER.md)（`DeployGovernance.s.sol`、`HandoverToTimelock.s.sol`，位址寫死為平台的合約）；租戶版的 Timelock 腳本還沒有。

- **`DeployTenant.s.sol` 在部署結束時就把所有權交給租戶的 admin**，部署者不留任何角色：`Ownable` 合約 `transferOwnership`，`AccessControl` 合約先授予、讀回、才放棄。平台是「先 cutover、之後再移交」，因為它在替一套有資金的合約換 exchange；新租戶沒有這個包袱，而一步到位的所有權轉移最便宜的時機，就是整組合約還沒有任何資金的時候。admin 之後要不要再放到 Timelock 後面，由 admin 自己做（`VerifyTenant` 以 `EXPECTED_OWNER` 支援）。
- 每個租戶的治理結構與現行目標一致（[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md)、[`ROLE_SEPARATION.md`](ROLE_SEPARATION.md)）：admin 是 multisig，理想上在 Timelock 後面；guardian 是能快速暫停、但不能恢復或升級的溫錢包；risk 只調上限與費率；keeper 是受偏離上限約束的熱錢包。
- 差別只在「每個租戶一套」。guardian 的暫停權限是逐租戶的：租戶的營運團隊與平台值班都可以被授予**該租戶**的 guardian，但任何人都不會持有跨租戶的 guardian。
- **待決**：租戶 admin multisig 的簽署人組成（只有租戶？平台＋租戶？）與 Timelock 延遲長度。這決定了「誰能升級某個租戶的 vault」，是商務與法遵問題，不在本 ADR 決定。
- 現行合約的限制照樣適用於每個租戶：exchange 的 owner 是單一 Ownable 地址、guardian 暫停有 72 小時上限且只有 owner 能解除。

## 遷移路徑

1. **階段 0（完成）**：前端租戶設定層（default 租戶＝現行正式站，外觀與行為不變）、租戶部署設定範本與唯讀檢查、本 ADR。沒有任何合約或 broadcast 變動。
2. **階段 1：部署腳本參數化（工具完成，未廣播）**。原本的想法是把 `Redeploy129Exchange.s.sol` 的常數改成讀環境變數；實際做法是另寫一支 `DeployTenant.s.sol`，直接讀 `deploy/tenants/<id>.json`——cutover 腳本的工作是「替平台換 exchange 並改指共用的保險金與 FeeRouter」，租戶需要的是「全部新部署、不碰任何既有合約」，兩者的前置檢查與不可逆點完全不同，硬塞進同一支只會兩邊都變危險。腳本沒有任何寫死的位址；`VerifyTenant.s.sol` 做部署後的唯讀讀回。keeper workflow「以租戶部署設定為輸入」的部分改成：租戶各自一支 workflow，CI 以部署登記比對位址（上方「實作時的兩個修正」）。
3. **階段 2：前端依租戶切換位址（工具完成）；第一個試點租戶（未做）**。位址沒有擴充進 `addresses.ts`：它被 agent 端 import、被 signal-api 的 bundle 內聯，維持為「平台部署的純資料」。租戶的位址在 `frontend/src/contracts/deployments/<id>.json`（部署登記，由部署紀錄產生），建置期只把被選中的那一份打進 bundle；沒有登記檔就 build 失敗，不退回平台的合約（[frontend ADR 0009 增補](../frontend/docs/adr/0009-tenant-config-layer.md)）。前端租戶設定檔**仍然沒有地址欄位**。`consistency.yml` 檢查：登記格式（含重複的 JSON 鍵）、同租戶不重複、專屬租戶登記裡的每一個位址都不得出現在平台位址全集或其他租戶裡（唯一例外是顯式宣告共用、且就是平台那一顆的結算幣）、前端登記與部署紀錄逐欄位相同；`tenant-verify.yml` 對每個專屬租戶以公開 RPC 跑 `VerifyTenant`。
4. **階段 3：收費模式定案與實作**（上方待決事項）。**這是第一個租戶能標成 `deployed` 的前提。**
5. **現行正式站是「租戶零」**：它繼續用現有那套合約，不搬遷任何部位。新租戶從零開始，不存在跨套合約移轉部位的需求；若日後正式站本身要換新版合約，仍依既有的 cutover 程序（排空、重新部署），與租戶化無關。

## Considered options

**單一部署、合約內加 `tenantId` 分帳。** 否決：要改 exchange、保險金、FeeRouter、vault 的每一條資金路徑，並且讓一個 bug 就能跨租戶挪用資金；暫停鍵仍是共用的。隔離靠程式邏輯而不是合約邊界，稽核範圍也跟著變大。

**共用 exchange、每租戶只分開 vault 與 treasury。** 否決：保證金與保險金仍共用，一個租戶的清算缺口會吃掉共用保險金；guardian 暫停仍然全站一起停。

**完全獨立的程式碼分支（每租戶 fork）。** 否決：修補無法同步，稽核成本乘以租戶數。租戶差異全部放在設定（前端 JSON、部署 JSON），不放在程式碼。

## Consequences

- 每多一個租戶就多一套合約的部署、驗證、監控與 keeper gas；營運成本隨租戶數線性增加，需要反映在收費模式裡（待決）。
- 事故手冊需要區分「單一租戶事故」與「跨租戶事故」（共用上游來源、共用程式缺陷、鏈本身）。
- 位址有兩個來源，各管各的：`addresses.ts` 是平台部署，`frontend/src/contracts/deployments/<id>.json` 是租戶部署。前端租戶在登記成 `dedicated` 之前只能換品牌與政策，仍指向平台的合約——而且必須以一份 `kind: "platform"` 的登記明確宣告，不是預設。
- `scripts/check-tenant-deploy.mjs` 是部署前的第一道關卡，只讀、不送交易；真正的部署仍由持有金鑰的人依 [`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md) 執行。

## 已完成／未完成（2026-10-02）

### 已完成（都沒有廣播任何交易）

| 項目 | 位置 | 驗證 |
|---|---|---|
| 租戶部署腳本：讀 `deploy/tenants/<id>.json`，部署整套專屬合約，結束時移交給 admin、部署者零權限 | `contracts/script/DeployTenant.s.sol` | forge 單元測試 21 支（mock 結算幣＋MockOracle）；Base Sepolia fork 測試 2 支（與平台並存、平台狀態不變，2026-10-02 對當日鏈上狀態重跑仍過）；本機 anvil fork 模擬 143 筆交易；全套 `forge test` 979 過、0 敗、3 skip（fork）；`PerpetualExchange` runtime 23,911 B 不變，`contracts/src` 無任何修改 |
| 部署後唯讀讀回驗證 | `contracts/script/VerifyTenant.s.sol` | 同上；竄改紀錄、改 guardian、部署者殘留角色都會被抓到 |
| 部署設定 schema v2（`params`：oracle 種類、OI／獲利上限、要不要金庫）與部署紀錄檢查 | `deploy/tenants/`、`scripts/check-tenant-deploy.mjs` | node 測試 50 支 |
| 前端依租戶切換合約位址，沒有登記就 fail-closed；default 租戶逐位元不變 | `frontend/src/contracts/deployment.ts`、`deployments/<id>.json` | vitest 914 支（66 檔），`VITE_TENANT=demo-bank` 下同樣 914 支全過；其中 `tenantDeployment.test.ts` 30 支（default 的 getter 以 `toBe` 比對同一物件、位址以快照釘住、原始碼掃描）；default、demo-bank 與一個暫時的專屬租戶三種 build。2026-10-02 把 default build 與 `origin/master` 的 build 對照：非 JS 產物 269 檔只有 `index.html` 的入口 chunk 雜湊不同；bundle 內的位址集合只多一個 `BASE_SEPOLIA_ORACLE_SHOWCASE.AggregatorOracle`（隔離檢查要拿平台位址集合比對，它以資料形式進 bundle，不建立任何合約物件） |
| CI：租戶隔離（不與平台或其他租戶共用合約）、前端登記↔部署紀錄對帳、租戶 keeper workflow 的位址／environment／concurrency | `scripts/check-addresses.mjs`、`consistency.yml` | node 測試 21 支；以真實 keeper workflow 的租戶複本驗證 |
| 營運文件：每租戶的 keeper 金鑰與 environment、workflow、signal-api、SDK | [`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md) | — |

### 未完成

| 項目 | 為什麼還沒做 | 誰能做 |
|---|---|---|
| **收費模式**（base fee＋markup 的數字與收取方式） | 商務決定；鏈上分潤需要新版 FeeRouter | 擁有者決定後再實作 |
| **第一個試點租戶的廣播** | 需要金鑰、multisig、定案的收費模式 | 擁有者 |
| 租戶 admin multisig 的簽署人組成、Timelock 延遲與租戶版 Timelock 腳本 | 商務與法遵決定 | 擁有者 |
| agent 端（signal-api、MCP server、Telegram bot）讀租戶的合約 | `agent/shared` 的位址在載入時綁定平台部署；要改程式並重新打包 | 下一階段 |
| keeper 程式在只有一顆 GuardedOracle 的租戶上的實跑驗證；租戶的健檢 workflow | 需要一個已部署的租戶與金鑰 | 試點時 |
| 平台 keeper workflow 改成讀 JSON | 動到線上價格的活性路徑，只能以實際執行驗證；租戶用的是範本 | 另一個 PR |
| 租戶 keeper 範本在真的租戶上 dispatch | 需要已部署的租戶與金鑰；範本只做過靜態檢查與 actionlint | 試點時 |
| 租戶版 Timelock 腳本 | 沒有 Timelock 時 admin multisig 可以立即升級金庫（PR #228 審查 F9）；延遲長度是商務／法遵決定 | 擁有者決定後 |
| Base 主網的共用元件與結算幣 | 原生 USDC 是 6 位小數，`PerpetualExchange` 要 18 位；設定檢查今天擋下所有主網設定 | 擁有者決定後 |
| 共用平台 `ESGRegistryV2` 的選項 | 預設（專屬）已足夠試點 | 有租戶要求時 |
| 前端連 Base 主網的專屬部署；專屬租戶的逐頁走查 | 沒有主網部署，也沒有可瀏覽的專屬租戶 | 試點時 |
| 事故手冊區分單一租戶與跨租戶事故 | `TENANT_OPERATIONS.md` §4 只有判斷表，沒有完整手冊 | 試點前 |
| **master 的 required checks**（branch protection／ruleset） | CI 檢查（守門、位址、租戶設定、`VerifyTenant`、forge）目前都只是建議性質，紅燈的 PR 仍可合併；設定是 repo 層級的權限，不在 PR 範圍 | 擁有者；第一個專屬租戶上線的前置條件（`TENANT_OPERATIONS.md` §1.6 第 0 步） |
| 租戶的 x402 結算 worker | 只有 keeper 有範本與守門支援。要比照 keeper 做範本、守門類別與改名的 secret（不可沿用 `FEE_SETTLEMENT_PRIVATE_KEY`：environment 漏放時會退回 repo 層級的平台金鑰）；不放寬 `PROTECTED_SECRETS` | 有租戶要收 x402 時（`TENANT_OPERATIONS.md` §2.1） |
| 租戶的價格監控與告警 | 時間窗限速只是減速（預設值下 24 小時仍可推到約 169 倍），真正的界線是監控與 guardian 的反應時間 | 試點前 |

## PR #228 審查修正（2026-10-02）

對抗式審查（F1–F10）之後的修正。原則：不逐案補黑名單，改成結構性的檢查；`contracts/src` 不動（`PerpetualExchange` runtime 仍是 23,911 B）。

| # | 發現 | 做法 |
|---|---|---|
| F1 | 租戶 `GuardedOracle` 只有單次上限、沒有時間窗限速 | 設定 schema v3：`params.oracleMaxDeviationBps`／`oracleWindowSeconds`／`oracleWindowDeviationBps`（都有上下限、guarded 必填、不得為 0；mock 必須是 `null`），`shared.referenceSource`（位址或 `"none"`，有就接上）。`DeployTenant` 寫入、`VerifyTenant` 讀回。回歸測試：短時間內的連續寫價，累計超過時間窗上限的那一筆以 `WindowDeviationTooLarge` 被擋，時間窗過後 keeper 可以繼續前進 |
| F2 | 「dedicated 不得與平台共用」是黑名單；結算幣可填任何地址；部署者自報 | 平台位址全集（設定檔、退役清單 `retiredPlatformAddresses.json`、workflow、agent 設定裡出現過的每一個位址，`scripts/lib/platform-addresses.mjs`）；登記裡的每一個位址欄位自動列舉比對；共用只限 `shared` 顯式宣告、白名單內（只有 `contracts.SettlementToken`）、而且就是平台那一顆；JSON 重複鍵、缺欄位、多欄位、`kind` 缺漏或拼錯都紅；租戶之間同一條規則。部署設定的 `shared.*` 也改成白名單（每一個只能是平台的指定角色）。`tenant-verify.yml` 以公開 RPC 對每個專屬租戶跑 `VerifyTenant`（沒有 secret、RPC 不通就失敗，每天也跑一次）；部署者的真實性改由 CREATE 位址推導驗證 |
| F3 | 每租戶 keeper workflow 與守門檢查互相矛盾 | 範本＋產生器＋守門檢查的「租戶 keeper」類別（見上方「實作時的修正」），secret 改名；兩支檢查對同一份產生出來的 workflow 同時通過（測試） |
| F4 | 專屬租戶沒設 `VITE_SIGNAL_API_URL` 時悄悄退回平台的 signal-api | `vite.config.ts` 讓專屬租戶沒設、或設成平台的網址時 build 失敗；平台與示範租戶不變 |
| F5 | `VerifyTenant` 只驗角色與接線 | 加驗 oracle 限速與參考來源、各讀取方的 `maxPriceAge`、exchange 與金庫的風控參數（與設定逐項相等）、ERC-1967 implementation／admin slot、最終歸屬（熱錢包沒有 admin、owner 不是熱錢包）、部署者不留任何權限。負向測試在 `contracts/test/TenantHardening.t.sol` 與 `TenantVerifyCodeAndPrivileges.t.sol`；**不是每一類都有**，沒有負向測試的類別列在下面「PR #228 複審修正」 |
| F6 | 租戶 oracle 的 `isStale()` 永遠 false，監控頁失真 | 專屬租戶以時間戳對照 6 小時；平台部署照舊（測試釘住） |
| F7 | OI 上限沒有上界；主網可放行 EOA admin；6 位小數的主網 USDC 不能用 | OI 上限 1–10,000,000；`ALLOW_EOA_ADMIN` 在 8453 無效；結算幣限制寫進文件，主網今天過不了共用元件白名單 |
| F8 | 部署過程中 exchange 有開放窗口 | 建立後立刻 owner `pause()`，移交前 `unpause()`（會啟動 30 分鐘清算寬限，部署完成後 30 分鐘內不能開倉） |
| F9 | 租戶沒有 Timelock | 文件寫明 admin multisig 可以立即升級金庫、上線前要寫進服務條款或補 Timelock；列入未完成 |
| F10 | 測試與 CI 覆蓋 | 不帶 selector 的 `vm.expectRevert()` 改成具體錯誤；fork 測試註明「平台未被動到」的斷言價值有限；JSON 重複鍵偵測（`scripts/lib/strict-json.mjs`）。fork 測試照舊在 CI 跳過（需要外部 RPC），`tenant-verify.yml` 補上對真實鏈的讀取 |

與審查建議不同的地方：

- 時間窗限速是整顆 oracle 一組參數（`GuardedOracle` 的長度與上限是全域的，狀態才是每檔資產），所以設定檔也只有一組；改成每檔不同要改 `contracts/src`。
- 角色多一條規則：admin 不得兼 marketOperator（否則「owner 不是熱錢包」無從保證）。
- 部署者的真實性用 CREATE 位址推導驗證，不讀廣播檔（`fs_permissions` 不開放 `broadcast/`，而推導在 fork 與 CI 上都能做）。

驗證（2026-10-02，都沒有廣播任何交易）：`forge test` 992 過、0 敗、3 skip（fork）；本機 anvil fork（Base Sepolia 區塊 47,569,483）只做模擬，`DeployTenant` 內建讀回與獨立的 `VerifyTenant.run()` 全部 `ok`（有／無參考來源兩種）；vitest 961 支（default 與 `VITE_TENANT=demo-bank` 各一次）；node 測試 132 支；`check-workflow-guards`、`check-addresses`、`check-tenant-deploy`、actionlint 1.7.12（含 shellcheck、含範本）全過。default build 對照 `origin/master`（3137080）的 build：非 JS 產物 269 檔只有 `index.html` 的入口 chunk 雜湊不同（換掉雜湊後逐字相同），JS 多一個 `deployment-*.js` chunk，bundle 內的位址集合只多 `BASE_SEPOLIA_ORACLE_SHOWCASE.AggregatorOracle`（與前一次比對相同）；退役清單只在建置期讀，不進 bundle。另以一個暫時的專屬租戶確認：沒設 `VITE_SIGNAL_API_URL`、或設成平台的網址，build 都失敗。

## PR #228 複審修正（2026-10-02）

修正複審的發現。同樣不動 `contracts/src`（`PerpetualExchange` runtime 仍是 23,911 B）。

| # | 發現 | 做法 |
|---|---|---|
| A2／A1 | 平台位址全集漏收平台的角色 EOA（owner／admin／guardian／risk）與只出現在 `ops/monitoring`、`contracts/broadcast` 的平台合約 | 全集改成「預設全收、排除要寫理由」：`git ls-files` 列出的**所有**文字檔裡的每一個位址（含 32 位元組補零的位址），只排除租戶自己的檔案、測試 fixture、第三方 `lib/`、lockfile、產生的 bundle（`UNIVERSE_EXCLUDES`，逐條有理由）；零位址、預編譯合約、官方 USDC、Permit2、Anvil 預設帳號以具名白名單扣除（`WELL_KNOWN_NON_PLATFORM`，逐筆有理由），Anvil 預設帳號另外直接擋（私鑰公開）。全集 144 → 217 個位址。回歸測試從 `contracts/script/Verify130.s.sol` 與 `docs/ROLE_SEPARATION.md` 讀出平台的角色位址，逐一放進租戶的每個角色與部署者，全部被擋 |
| C1 | 限速範圍比平台寬鬆；文件低估了累計幅度 | 範圍收緊為 `oracleWindowSeconds` ≥ 3600、`oracleWindowDeviationBps` ≤ 2500、`oracleMaxDeviationBps` ≤ 1000，預設＝平台值（Solidity 常數與 `PARAM_RANGES` 由測試釘成相同；keeper 的 `load-env.mjs` 也跟著改）。文件改寫成正確的界線：T 秒內最多乘 (1+W)^(⌊T/d⌋+1)，往下對稱；預設值下 1 小時 1.25 倍、6 小時約 3.05 倍、24 小時約 169 倍（正向測試把 6 小時的實際推價釘在這個界線內）。明寫限速只是減速，防線是 keeper 金鑰保護、參考來源、監控告警與 guardian 暫停 |
| C3 | 有參考來源時的界線 | 照實寫進文件：參考價 ±`oracleMaxDeviationBps`，次數不限（上限已壓到 10%）。腳本層沒有更好的補強；把確認容忍度與單次上限拆開要改 `contracts/src` |
| G1 | 文件建議複製平台的結算 worker | 刪除該建議；改寫成「租戶結算 worker 尚未支援」，需要時要先做範本、守門類別與改名的 secret。`PROTECTED_SECRETS` 沒有放寬 |
| G2 | 文件與註解說 CI 檢查「成為合併條件」 | 改成如實描述：它們是 CI 檢查，要 repo 設定 required checks 才會擋合併；目前 master 沒有設定。`TENANT_OPERATIONS.md` §1.6 第 0 步列為第一個專屬租戶上線的前置條件。沒有修改任何 repo 設定 |
| C2 | `VerifyTenant` 不比對 bytecode | 每一顆合約（含金庫實作與 exchange 連結的 library）的 runtime code 與本 repo 編譯產物逐位元組比對，只遮蔽 immutable、library 位址與結尾 metadata（理由見 `TENANT_DEPLOYMENT.md` §4）。ERC-1967 三個 slot 對每一顆檢查。複審的探針改寫成負向測試：實作多一個函式時驗證失敗 |
| C4 | 多出來的角色持有者偵測不到；維持保證金等參數漏驗 | 兩輪：已知位址逐角色「該有才有」（每次跑）；從部署紀錄新增的 `deployBlock` 起掃角色授予事件，重建持有者集合並要求等於預期（`eth_getLogs`，跨度超過上限時印 NOTE，`TENANT_PRIVILEGE_SCAN_REQUIRED=true` 時改為失敗）。補驗 `maintenanceMarginBpsOf`（必須 0）、ESG `maxAttestationAge`；資產模式與 unpriced exemption 印 WARN |
| A3 | signal-api 網址用字串比對 | 改成 `new URL()` 解析後比對 hostname（小寫、去尾點；port、path、query、hash、userinfo 一律不影響判斷）；CSP 的 connect-src 兩邊都用解析後的 origin |
| G3 | 金鑰核對失敗後，後面的 step 靠副作用才停下 | 核對 step 有 `id`；之後每個帶 `if:` 的 step 明確要求核對成功，不用 `always()`；測試釘住這個結構 |
| G4 | relay 來源取自設定檔 | 範本先以 `cast call` 讀租戶 oracle 的 `referenceSource()`，與設定不同就停 |
| G5 | 私鑰在 job 層級 env 等 | 租戶範本：私鑰只在需要的 step、`npm ci --ignore-scripts`、foundry 釘 v1.8.0。平台 keeper workflow 是整檔釘選的，這次沒動 |
| G6 | 租戶 id 可以是 `keeper`、`settlement` | 加保留字清單 |
| A4 | `tokens` 的鍵沒在 CI 檢查 | `check-addresses.mjs` 要求鍵是已知資產代號 |
| C5 | 凍結與暫停的判斷 | 凍結訊息分 guardian（附到期）與 admin（沒有到期）；有到期的暫停只 WARN、沒有到期的判失敗，exchange 與 oracle 一致 |
| C6 | Solidity 端沒擋參考來源等於價格來源 | 加上檢查與測試 |

另外：本機 anvil 演練（只廣播到本機 fork）發現 `DeployTenant` 最後的 `exchange.unpause()` 在真的廣播時 out of gas（模擬時同一個 timestamp，估出的 gas 不含寫入暫停時間），已改成固定 gas 上限 300,000。上一輪只做模擬，沒有發現。

**仍沒有負向測試的類別**：金庫的 `oracle`／`esgRegistry` 被 admin 改掉；exchange 的 `adlEnabled`、`rwaAsset` 旗標；「金庫不是 token 的 minter」；主網上 owner 必須是合約（只有 preflight 有測）；unpriced exemption 生效時只 WARN；`eth_getLogs` 掃描本身只在 anvil 演練實證，CI 沒有自動化測試（單元測試用測試錄下的 log 當事件歷史）。

沒有修改的地方與理由：

- A5（`contracts.X402FeeRouter` 沒有鏈上驗證）：前端只顯示、沒有資金流，寫進 `TENANT_DEPLOYMENT.md`；前端要用它付款之前必須補驗證。
- C7（部署中斷時的狀態）：已正確，不需要改。
- 前端建置期的平台位址集合仍只有前端看得到的平台位址與退役清單，沒有改成 repo 全集：Vercel 的建置環境不保證有 git，全集由 CI 的 `check-addresses.mjs` 負責。
- R1（平台私鑰是 repo 層級 secret、environment 沒有保護、`admin-approval` 不存在）是 repo 設定，不在 PR 範圍，由擁有者處理。
