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

- **金鑰隔離用 GitHub environment，不用 secret 名稱。** 每個租戶一個 `keeper-<id>` environment，裡面的 secret 仍叫 `KEEPER_PRIVATE_KEY`。environment secret 只有引用該 environment 的 job 拿得到；不同名稱的 repo 層級 secret 則任何 workflow 都拿得到。
- **目前每個租戶複製一支 workflow，不用 matrix。** 位址放進 matrix 之後，`check-addresses.mjs` 的逐行檢查看不到哪個位址屬於哪個租戶；而且一支檔案服務所有租戶，改壞一次就全部停。CI 以 `KEEPER_TENANT: <id>` 辨認租戶的 keeper，位址改以該租戶的部署登記比對。

**租戶 oracle 自身的過期檢查是關掉的**（`maxPriceAge = 0`）。keeper 寫價前先讀 `getPrice`，讀取 revert 就拒寫；oracle 層的過期檢查開著，一次超過上限的中斷之後 keeper 就永遠寫不進去。過期由 exchange 與金庫各自依 `updatedAt` 把關（都是 6 小時）。

這不會讓過期價格被接受，理由是租戶 oracle 的每一個「會動到錢」的讀者都自己檢查 `updatedAt`（2026-10-02 逐一對過 `contracts/src`）：

| 讀者 | 路徑 | 過期時 |
|---|---|---|
| `PerpetualExchange` 開倉 | `_freshPrice`：`block.timestamp > updatedAt + maxPriceAge` 就 revert | `StalePrice`，`maxPriceAge` 由 `DeployTenant` 設成 6 小時、`VerifyTenant` 讀回 |
| `PerpetualExchange` 平倉、`closePositionFor`、清算 | `_requireFresh`（同一條件，另拒絕零價格） | `StalePrice` |
| `AssetVaultV2_5` mint／redeem／NAV | `effectiveMaxPriceAge()`（`min(maxPriceAge, LAST_GOOD_MAX_AGE)`），NAV 迴圈對過期資產改用 last-good 或視為不可估值 | `StalePrice`／不計入，`maxPriceAge` 設 6 小時 |
| `PerpetualExchange.getUnrealizedPnL`／`getPositionValue`／`getMarkPrice` | view，不檢查 | 只回傳數值、不改任何狀態；需要「現在能不能成交」時用 `PerpetualExchangeLens.hasValidPrice`（依 exchange 的 `maxPriceAge`） |

其餘租戶合約（`InsuranceVault`、`FeeRouter`、`TraderStake`、`CopyTracker`、`StrategyRegistry`、`AgentSessionManager`）不讀 oracle。代價只有一個：`GuardedOracle.isStale()` 在 `maxPriceAge = 0` 時永遠回 `false`，**租戶的監控不能用它判斷過期**，要用 exchange 的 `maxPriceAge` 對 `updatedAt`（`agent/keeper/health-check` 就是這樣做的）。回歸測試在 `contracts/test/DeployTenant.t.sol`：停擺 3 天後 oracle 仍可讀、exchange 自己拒絕過期價、keeper 下一筆寫價即恢復。

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
3. **階段 2：前端依租戶切換位址（工具完成）；第一個試點租戶（未做）**。位址沒有擴充進 `addresses.ts`：它被 agent 端 import、被 signal-api 的 bundle 內聯，維持為「平台部署的純資料」。租戶的位址在 `frontend/src/contracts/deployments/<id>.json`（部署登記，由部署紀錄產生），建置期只把被選中的那一份打進 bundle；沒有登記檔就 build 失敗，不退回平台的合約（[frontend ADR 0009 增補](../frontend/docs/adr/0009-tenant-config-layer.md)）。前端租戶設定檔**仍然沒有地址欄位**。`consistency.yml` 檢查：登記格式、同租戶不重複、專屬租戶除結算幣外不得與平台或其他租戶共用任何位址、前端登記與部署紀錄逐欄位相同。
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
| 平台 keeper workflow 改成讀 JSON、租戶 workflow 改用 matrix | 動到線上價格的活性路徑，只能以實際執行驗證；租戶數量少時複製更安全 | 租戶變多時，另一個 PR |
| 共用平台 `ESGRegistryV2` 的選項 | 預設（專屬）已足夠試點 | 有租戶要求時 |
| 前端連 Base 主網的專屬部署；專屬租戶的逐頁走查 | 沒有主網部署，也沒有可瀏覽的專屬租戶 | 試點時 |
| 事故手冊區分單一租戶與跨租戶事故 | `TENANT_OPERATIONS.md` §4 只有判斷表，沒有完整手冊 | 試點前 |
