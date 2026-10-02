# 白標租戶的營運：keeper、signal-api、SDK

> 2026-10-01；2026-10-02 依 PR #228 審查修正（oracle 限速、keeper workflow 改由範本產生、signal-api 與監控頁）。隔離模型見 [`ADR-008-tenant-isolation.md`](ADR-008-tenant-isolation.md)，部署步驟見
> [`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md)。這份文件講的是**部署完成之後**，一個專屬租戶
> 每天要靠什麼運作，以及哪些部分今天還做不到。
>
> 本文件沒有任何會送交易的指令。建立 environment、放 secret、啟用 workflow、建立 Vercel 專案
> 都由擁有者本人操作。

## 0. 每個租戶各自一份的東西

| 項目 | 平台（default 租戶） | 專屬租戶 `<id>` | 誰建立 |
|---|---|---|---|
| 合約 | `frontend/src/contracts/addresses.ts` | `deploy/tenants/<id>.deployed.json`（`DeployTenant.s.sol` 的產出） | 持有部署者金鑰的人 |
| 前端位址 | `addresses.ts` | `frontend/src/contracts/deployments/<id>.json`（由部署紀錄產生） | PR，CI 對帳 |
| keeper 金鑰 | GitHub environment `keeper`（`KEEPER_PRIVATE_KEY`） | GitHub environment `keeper-<id>`（`TENANT_KEEPER_PRIVATE_KEY`、`TENANT_RPC_URL`） | 擁有者 |
| keeper workflow | `base-sepolia-keeper.yml` | `keeper-<id>.yml`（由範本產生：`node scripts/gen-tenant-keeper.mjs <id>`） | PR，CI 逐位元比對範本 |
| x402 收款地址 | repository variable `PAY_TO` | 租戶自己的 `PAY_TO`（租戶的 Vercel 專案）。租戶的結算 worker **尚未支援**（§2.1） | 擁有者 |
| x402 分潤路由 | `frontend/src/contracts/x402.ts` | 登記檔的 `contracts.X402FeeRouter`（`DeployX402Router.s.sol`，`TREASURY`＝租戶的 treasury） | 持有部署者金鑰的人 |
| signal-api | 現行 Vercel 專案 | 租戶自己的 Vercel 專案（**資料來源尚不能隔離**，見 §2.2） | 擁有者 |

共用的只有三樣：程式碼、結算幣、上游價格來源（`AggregatorOracle` 與行情 API）。其餘任何一項與平台或另一個租戶共用，都違反 ADR-008。

## 1. keeper

### 1.1 金鑰與角色

- keeper 的地址就是 `deploy/tenants/<id>.json` 的 `roles.keeper`。`DeployTenant.s.sol` 已經把租戶 oracle 的寫價權給它（guarded：`KEEPER_ROLE`；mock：`owner`），不需要再做任何授權。
- `roles.marketOperator` 可以就是 keeper（平台如此）。它只能在 Active 與 ReduceOnly 之間切換市場。
- 這把金鑰**只屬於這個租戶**。`scripts/check-tenant-deploy.mjs` 會擋下與平台位址全集或其他租戶重複的角色地址。
- **金鑰外洩時的影響範圍**是這一個租戶的價格，受租戶 `GuardedOracle` 的兩道限制（`DeployTenant` 依設定寫入、`VerifyTenant` 讀回確認，CI 每天對鏈上再驗一次）：
  - 單次上限 `params.oracleMaxDeviationBps`：每一筆相對前一筆；
  - 時間窗限速 `params.oracleWindowSeconds`（d）／`oracleWindowDeviationBps`（W）：一個時間窗內相對窗口起點的累計變動不超過 W。時間窗是一個接一個的，**每過一個時間窗就可以再乘一次 (1+W)**，所以這是複利、不是總上限：T 秒內價格最多乘 **(1+W)^(⌊T/d⌋+1)**，往下對稱（最多乘 (1−W) 的同一次方）。
  - 以預設值（也是範圍內最寬鬆的值：d=3600 秒、W=2500 bps、單次 1000 bps）計算，keeper 金鑰外洩後持續推價，依 PR #228 複審的最佳排程實測：**1 小時 1.25 倍、6 小時約 3.05 倍、24 小時約 169 倍**（往下：6 小時剩約 24%、24 小時剩約 0.13%）；上式給出的上界是 1.56 倍／4.77 倍／265 倍。exchange 的 `maxPriceAge` 是 6 小時，這段期間每一筆都是「新鮮」報價。
  - 有參考來源（`shared.referenceSource`）時，界線改成「**參考價 ±單次上限，次數不限**」：落在參考價 ±`oracleMaxDeviationBps` 之內的寫價視為與參考一致，略過時間窗並重設窗口，所以 keeper 可以在同一個區塊內反覆在這個區間裡來回（預設 10% 時，從參考價 −10% 推到 +10%，約 1.22 倍，可以一直重複）；偏離參考價更多的寫價只能是朝參考價收斂、且在單次上限內的一步。Base 主網強制要有參考來源，所以主網實際的界線就是這一條。`oracleMaxDeviationBps` 的上限因此壓在 1000（10%）；把「確認容忍度」與單次上限拆成兩個參數要改 `contracts/src`，不在這次的範圍。
  - 部位端另有每檔資產的 OI 上限與 `maxProfitBps`；guardian 可以凍結資產或暫停 oracle。

  **限速只是減速，不是防線。** 它把金鑰外洩後的推價拉長成幾小時，讓人有時間反應；真正的防線是：keeper 金鑰的保護（只在 `keeper-<id>` environment、只有範本產生的 workflow 讀得到）、參考來源、價格監控與告警、guardian 暫停 oracle 或凍結資產（以及 guardian 的反應時間）。上線前這四項都要到位；目前租戶沒有健檢與告警（§1.4），這是 §5 的待辦。

  只有單次上限、沒有時間窗的 oracle 不算受保護：連續多筆寫價的累計變動沒有上限（PR #228 審查 F1）。`params.oracleWindowDeviationBps` 因此不得為 0。三個參數的範圍不得比平台寬鬆（PR #228 複審 C1）：`oracleWindowSeconds` ≥ 3600、`oracleWindowDeviationBps` ≤ 2500、`oracleMaxDeviationBps` ≤ 1000；預設就是平台值。
- keeper 地址要有 gas。workflow 的 `Warn before the tank runs dry` 步驟在餘額低於 0.02 ETH 時警告、低於 0.002 ETH 時直接失敗。

### 1.2 建立 GitHub environment `keeper-<id>`

沿用 [`ops/keeper-trigger/README.md`](../ops/keeper-trigger/README.md)「部署前必做」第 2 步的模式，差別只有名稱與裡面放的 secret：

1. repo → Settings → Environments → New environment → 名稱 **`keeper-<id>`**（必須是這個名稱，CI 會檢查）。
2. Deployment branches and tags：Selected branches → `master`。
3. Environment secrets（名稱固定，值是**這個租戶的**）：
   - `TENANT_KEEPER_PRIVATE_KEY`：租戶的 keeper 私鑰；
   - `TENANT_RPC_URL`：租戶用的 RPC（可以與平台用同一個供應商，但放在這個 environment 裡）。
4. **不要**設 required reviewers、wait timer 或 custom deployment protection rule：keeper job 用 `deployment: false`，reviewers 與 wait timer 會讓排程卡住，custom rule 會讓 job 直接失敗（理由與出處在上述 README）。
5. **不要**把這兩個 secret 放在 repo 層級。

> **為什麼 secret 的名稱與平台不同。** environment 沒放某個 secret 時，`secrets.X` 會退回 repo 層級的同名 secret。租戶的 workflow 若也叫 `KEEPER_PRIVATE_KEY`，environment 漏放時拿到的就是平台的金鑰。名稱不同，就不可能退回平台的金鑰；`scripts/check-workflow-guards.mjs` 也只允許 `keeper-<id>.yml` 的 job（綁 `keeper-<id>`）引用這兩個名稱。
>
> 另一道：workflow 在送任何交易之前，先核對 `TENANT_KEEPER_PRIVATE_KEY` 推出的地址等於 `roles.keeper`，不等就失敗；核對沒過時，後面每一個 step 都不執行（帶 `if:` 的 step 明確要求核對成功）。私鑰只放在需要它的 step 的 env，`npm ci` 加 `--ignore-scripts`。
>
> 參考來源（relay）也先核對：設定檔的 `shared.referenceSource` 必須等於租戶 oracle 鏈上的 `referenceSource()`（`"none"` 時鏈上必須是零位址），不相等就停，不會中繼一個只寫在設定檔裡的來源。
>
> 順序仍然是：先建 environment、先放 secret，再合併 workflow（GitHub 遇到不存在的 environment 會自動建一個沒有保護的同名 environment）。

### 1.3 workflow：由範本產生，不手寫、不複製

每個專屬租戶的 keeper workflow 都是 **`.github/workflows/keeper-<id>.yml`**，由範本產生：

```bash
node scripts/gen-tenant-keeper.mjs <id>          # 寫出 .github/workflows/keeper-<id>.yml
node scripts/gen-tenant-keeper.mjs <id> --check  # 比對現有檔案
```

- 範本是 [`ops/tenant-keeper/keeper.template.yml`](../ops/tenant-keeper/keeper.template.yml)，唯一的代入值是租戶 id（`^[a-z][a-z0-9-]{1,30}$`，代入 YAML 不可能改變結構）。產生器只為已登記的專屬租戶產生（`frontend/src/contracts/deployments/<id>.json` 存在且 `kind: "dedicated"`）。
- 產生出來的檔案**不含任何位址**。執行期由 [`ops/tenant-keeper/load-env.mjs`](../ops/tenant-keeper/load-env.mjs) 從已審查的兩份登記讀出：`KEEPER_ORACLE_ADDRESS`（租戶的 Oracle）、`EXCHANGE`、`KEEPER_VAULT_ADDRESS`（有金庫時）、`KEEPER_RELAY_SOURCE`（＝`shared.referenceSource`，`"none"` 時不設）、`KEEPER_BREAKER_DEVIATION`（＝`oracleMaxDeviationBps`／10000，與 oracle 的單次上限一致）、`KEEPER_EXPECTED_ADDRESS`（`roles.keeper`）、`FUNDING_SYMBOLS`（`assets.registered`）。不是 dedicated、不是已部署、格式不對都失敗，不印任何東西。
- 其餘步驟與平台的 `base-sepolia-keeper.yml` 相同（餘額檢查、寫價與部分失敗門檻、熔斷告警、funding crank）；自己的 `concurrency.group`（`keeper-key-<id>`），告警 issue 標題含 id。

**CI 把關**（`consistency.yml`）：

- `scripts/check-workflow-guards.mjs` 的「租戶 keeper」類別：
  - `keeper-<id>.yml` 的內容必須**等於範本代入 `<id>` 的結果**（檢查器自己重新產生、逐位元比對；CRLF／BOM 不算差異）。手改任何一個字（含註解）、多一個觸發事件、換掉守門 step，都會紅；
  - 範本與 `load-env.mjs` 的整檔 sha256 釘在 `TENANT_KEEPER_PINS`。所以新增租戶**不必改任何雜湊**；要改租戶 keeper 的行為只能改範本，改範本就要人工審過後更新釘選（`--print-tenant-keeper-pins`）；
  - environment `keeper-<id>` 只允許 `keeper-<id>.yml#keep` 綁定，而且 `<id>` 必須是已登記的專屬租戶；`TENANT_KEEPER_PRIVATE_KEY`／`TENANT_RPC_URL` 只允許那個 job 引用；借用平台的 `keeper` environment 會紅；
  - 範本代入一個探測 id 之後，也必須通過所有結構規則（觸發只有 `schedule`／`workflow_dispatch`、`run:` 不內插、action 釘 SHA…），actionlint 也對它跑一次。
- `scripts/check-addresses.mjs`：帶 `KEEPER_TENANT: <id>` 的 job 必須綁 `keeper-<id>`、`concurrency.group` 含 `<id>`；workflow 裡出現的任何位址都以租戶的登記比對。
- 兩支檢查對同一份產生出來的 workflow 必須同時通過（`scripts/tenant-keeper.test.mjs` 釘住）。

這次**沒有**新增任何實際的租戶 keeper workflow：目前沒有專屬租戶。

**為什麼不用 matrix。** 一支檔案服務所有租戶，一次改壞就停掉所有租戶的價格，而 ADR-008 把「共用程式的缺陷」列為跨租戶事故。範本＋逐檔比對讓每個租戶各有一支檔案（各自的排程、失敗、告警），而內容仍然只有一個來源。

**平台的 `base-sepolia-keeper.yml` 沒有改成讀 JSON。** 它是平台價格的活性關鍵路徑，改動只能靠實際執行（對公開鏈送交易）驗證，而且改完行為不變、沒有租戶受益。租戶用的是範本。

### 1.4 外部觸發器與健檢

- **觸發器**：GitHub 排程的實際間隔是 68–169 分鐘（範本固定名目 15 分鐘；`deploy/tenants/<id>.json` 的 `keeper.cron` 目前只是參考值，不會代入 workflow）。要讓 [`ops/keeper-trigger`](../ops/keeper-trigger/README.md) 的 Worker 也照顧租戶的 keeper，把 `keeper-<id>.yml` 加進 `wrangler.toml` 的 `WORKFLOW_FILES`（逗號分隔）後重新 `wrangler deploy`。各支獨立判斷，一支觸發失敗不影響其他支。
- **健檢**：`oracle-health.yml` 目前只看平台的 oracle 與 exchange。**租戶沒有健檢**——keeper 連續失敗時不會有人被通知（每天的 `tenant-verify.yml` 只驗接線與參數，價格過期只 WARN）。試點租戶上線前要為它加一個健檢（建議同樣做成範本），或接受「只有 keeper 自己的紅燈」這個監控水準並寫進租戶的服務條款。
- **監控頁**：前端 `AgentMonitorPage` 的「過期」欄在專屬租戶上以價格時間戳對照 6 小時判斷（與 exchange、金庫一致），不問 oracle 的 `isStale()`——租戶 oracle 的 `maxPriceAge` 是 0，`isStale()` 永遠回 false。平台部署照舊用 `isStale()`。

### 1.5 keeper 程式與租戶 oracle 的相容性（上線前要驗證）

keeper 程式（`agent/keeper/`）是為平台的組合寫的：exchange 讀 MockOracle，另有一顆 GuardedOracle 給金庫，兩顆要同步。guarded 租戶只有一顆 oracle，exchange 與金庫都讀它。這次**沒有修改 keeper 程式**，以下是讀程式碼得到的結論，還沒有在真的租戶上跑過：

| 項目 | 現況 | 影響 |
|---|---|---|
| 主 oracle 的介面 | keeper 對 `KEEPER_ORACLE_ADDRESS` 呼叫 `getPrice`／`updatePrice`；GuardedOracle 兩個都有 | 把租戶的 GuardedOracle 填在 `KEEPER_ORACLE_ADDRESS` 即可 |
| `KEEPER_GUARDED_ORACLE` | 設了就會「先寫 Guarded、成功才寫 Mock」。兩個變數填同一顆的話，每檔資產每輪寫兩次 | 不要設。代價見下一列 |
| 熔斷門檻 | 沒設 `KEEPER_GUARDED_ORACLE` 時，keeper 不知道 oracle 的單次上限，只用 `KEEPER_BREAKER_DEVIATION` | 範本由 `load-env.mjs` 把它設成 `oracleMaxDeviationBps`／10000，兩邊一致 |
| 時間窗限速 | keeper 不知道 oracle 的時間窗 | 超過累計上限的寫價被 oracle 以 `WindowDeviationTooLarge` 拒絕，算成一筆寫入失敗（fail-closed）。**長時間停擺之後的大幅跳價**：沒有參考來源時，價格要分幾個時間窗才追得上（每窗最多 `oracleWindowDeviationBps`）；這段期間 exchange 會因價格過期或落後而拒單，這是限速的代價。有參考來源時，與參考一致的寫價直接落地並重設時間窗——這是建議設定 `shared.referenceSource` 的主要理由 |
| 讀不到現價就不寫 | keeper 寫價前先 `getPrice`；讀取 revert 且不是 `AssetNotFound` 時拒寫（`round.ts`） | 這是 `DeployTenant` 把租戶 oracle 的 `maxPriceAge` 設成 0 的原因：否則一次超過上限的中斷之後 `getPrice` 會 `StalePrice`，keeper 就永遠寫不進去。過期仍由 exchange（6 小時）與金庫（6 小時）各自把關。單筆變動的界線由單次上限與時間窗負責，與 `maxPriceAge` 無關 |
| 資產被 guardian 凍結 | `getPrice` 以 `AssetIsFrozen` revert → keeper 拒寫 | 符合預期：凍結是 guardian 的決定，解除後 keeper 自動恢復 |

**上線前的驗證**（都不送交易）：在本機以 `DRY_RUN=1`、`KEEPER_ORACLE_ADDRESS=<租戶 Oracle>`、`KEEPER_RPC_URL=<RPC>` 跑一次 `npx tsx keeper/run.ts`（在 `agent/` 底下），確認 11 檔資產都讀得到現價、摘要行的 `failed=0`。之後由擁有者 dispatch 租戶的 workflow 一次，確認真的寫得進去。

### 1.6 上線順序

0. **前置條件（repo 擁有者，第一個專屬租戶上線前）：master 的 branch protection 或 ruleset 已啟用 required checks**，至少包含：`workflow guards`、`workflow ↔ addresses.ts`、`tenant deploy configs`、`VerifyTenant (public RPC fork)`、`forge build + test`、`npm test`。這些 CI 檢查只有被設成 required 之後才會真的擋合併；目前 master 沒有任何保護，紅燈的 PR 仍然可以合併。另外建議同時把 `KEEPER_PRIVATE_KEY`、`FEE_SETTLEMENT_PRIVATE_KEY` 從 repo 層級搬到各自的 environment，並設定 environment 的分支限制。
1. `DeployTenant` 已廣播、`VerifyTenant` 通過、部署紀錄與前端登記已合併（[`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md)）。
2. 擁有者建立 `keeper-<id>` environment 並放入金鑰（§1.2），替 keeper 地址補 gas。
3. §1.5 的 `DRY_RUN` 驗證。
4. `node scripts/gen-tenant-keeper.mjs <id>` 產生 `keeper-<id>.yml`，以 PR 新增（§1.3）；`consistency.yml` 與 `tenant-verify.yml` 綠燈才合併（第 0 步完成之前，這只是人工紀律，不是 CI 強制）。
5. 擁有者手動 dispatch 一次，確認寫價成功；再把檔名加進觸發器的 `WORKFLOW_FILES`（§1.4）。
6. `VerifyTenant` 再跑一次，最後一段應該是「every registered asset priced and fresh」而不是 WARN。

部署到第一次 keeper 寫價之間，租戶 oracle 上的價格是部署當下從共用來源取的（`DeployTenant` 要求來源在 1 小時內更新過）。這段時間不要對外開放前端。

## 2. signal-api 與 x402 收款

### 2.1 每租戶一個 Vercel 專案

平台的 signal-api 是一個 Vercel 專案（`agent/signal-api`，服務 commit 進 repo 的 `api/index.js`）。租戶要有自己的收款地址，就要有自己的專案：同一個 repo、同一個目錄、同一個 bundle，不同的環境變數。

| 環境變數 | 租戶的值 | 說明 |
|---|---|---|
| `PAY_TO` | 租戶的 x402 收款 EOA | 必須是 `FEE_SETTLEMENT_PRIVATE_KEY` 的地址；不能是合約、Safe 或外洩地址（signal-api 與結算 worker 都會檢查，不過就 fail-closed） |
| `X402_FEE_ROUTER` | 租戶自己的 x402 FeeRouter | 以 `contracts/script/DeployX402Router.s.sol` 部署，`TREASURY`＝租戶的 treasury（`platformTreasury` 是 immutable）。部署後把位址加進前端登記檔的 `contracts.X402FeeRouter` |
| `UPSTASH_REDIS_REST_URL`／`_TOKEN` | 租戶自己的 Redis database | 結算佇列不共用：共用佇列等於讓 A 的 worker 結算 B 的收入 |
| `ORACLE_BENEFICIARY_ADDRESS` | 租戶指定 | `/oracle` 收入的 70% 受益人 |
| `CORS_ALLOWED_ORIGINS`、`SIGNAL_API_PUBLIC_URL`、`SIGNAL_API_URL_ALLOWLIST` | 租戶的網域 | — |

前端這一側：租戶的 Vercel 專案**必須**設 `VITE_SIGNAL_API_URL` 指向租戶的 signal-api。專屬租戶（`kind: "dedicated"`）沒設、或設成平台的 signal-api，`vite build` 直接失敗——不會悄悄退回平台的 signal-api（那會讓租戶的使用者看到平台 exchange 的訊號、funding 與新鮮度）。平台與示範租戶的行為不變。`vite build` 另外檢查這個網址在 `frontend/vercel.json` 的 CSP `connect-src` 裡，不在就讓 build 失敗——所以新增租戶的 signal-api 網域要先改 `vercel.json`。

結算 worker：**租戶的結算 worker 目前不支援。** 目前只有 keeper 有租戶範本與守門支援（§1.3）。**不要複製平台的 `x402-settlement-worker.yml`**：守門檢查會紅燈，而且平台的結算金鑰 `FEE_SETTLEMENT_PRIVATE_KEY` 是 repo 層級的 secret——租戶的 environment 漏放同名 secret 時，GitHub 會退回 repo 層級的那一把，租戶的 worker 就會拿平台的結算金鑰簽章。需要時要先比照 keeper 做完三件事，才能上線：
1. 範本（例如 `ops/tenant-settlement/…`），由產生器代入租戶 id、檢查器逐位元比對、範本本身釘雜湊；
2. `scripts/check-workflow-guards.mjs` 加一個對應的守門類別（environment `settlement-<id>` 只允許範本產生的檔案綁定）；
3. 改名的 secret（例如 `TENANT_FEE_SETTLEMENT_PRIVATE_KEY`），**不可使用**平台的 `FEE_SETTLEMENT_PRIVATE_KEY` 名稱。

不要為了讓租戶的 worker 通過而放寬 `PROTECTED_SECRETS` 或 `ENVIRONMENTS`。這一項列在 ADR-008 的「未完成」。

### 2.2 今天做不到的部分：資料來源

**signal-api 的鏈上讀取位址是編進 bundle 的平台位址。** `agent/shared/src/addresses.ts` 在載入時以 `getAddresses(AGENT_CHAIN_ID)` 讀 `frontend/src/contracts/addresses.ts`，唯一能用環境變數改的是鏈 id。所以租戶的 Vercel 專案今天能隔離的只有**收款**（`PAY_TO`、`X402_FEE_ROUTER`、佇列、結算金鑰）；它回應的訊號、曝險、價格新鮮度、鏈上收入仍然讀**平台的** exchange、oracle 與保險金。

對一個自己的 exchange 上有真實部位的租戶，這是錯的資料。要補上需要改 agent 端（讓 `agent/shared` 接受一組位址覆寫，並重新打包 `api/index.js`），這不在這次的範圍。在那之前：

- 示範租戶（`kind: "platform"`）沒有這個問題——它本來就跑在平台的合約上。
- 專屬租戶不要對外提供 signal-api 的付費端點；前端的 x402 說明頁在 `X402FeeRouter` 未登記時會顯示「未設定」。

MCP server 與 Telegram bot 同樣沒有租戶概念，回應內容與下單目標都是平台的合約。

## 3. SDK：以 `addresses` 指向租戶部署

`@pepelab/sdk` 的 `createReadClient` 接受 `addresses` 覆寫。指向租戶時**六個欄位全部給**，從租戶的前端登記檔照抄：

```ts
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createReadClient } from "@pepelab/sdk";

// 來源：frontend/src/contracts/deployments/<id>.json 的 contracts
const read = createReadClient({
  chainId: 84532,
  publicClient: createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL) }),
  addresses: {
    perpetualExchange: "0x…", // PerpetualExchange
    oracle: "0x…",            // Oracle
    marginToken: "0x…",       // SettlementToken
    strategyRegistry: "0x…",  // StrategyRegistry
    sessionManager: "0x…",    // AgentSessionManager
    guardedOracle: null,      // guarded 租戶的 exchange 就讀 Oracle，沒有第二顆
  },
});
```

**不要只覆寫一部分。** `resolveAddresses` 對沒給的欄位會退回 `addresses.ts`（平台）在同一條鏈的值。只給 `perpetualExchange` 的話，client 會是「租戶的 exchange＋平台的 AgentSessionManager」——session 綁定 exchange，對平台的 manager 簽出的授權在租戶的 exchange 上無效，而且使用者是在對別人的合約簽名。給 `null` 是明確的「這個租戶沒有」，不會退回平台的值。

SDK 原始碼裡這個參數的註解是「只給本機 anvil／測試部署用」。對租戶整合它是目前唯一的做法；之後應該提供 `createReadClient({ tenant })` 之類直接讀部署登記的入口，讓整合方不必手抄位址。

`SignalApiClient` 的 `baseUrl` 給租戶的 signal-api 網址；資料來源的限制同 §2.2。

## 4. 事故時要先分清楚的事

| 症狀 | 範圍 | 第一步 |
|---|---|---|
| 一個租戶的價格過期、keeper 紅燈 | 單一租戶 | 看 `keeper-<id>.yml` 的 run：金鑰核對、gas、nonce、`DeviationTooLarge`／`WindowDeviationTooLarge` |
| `tenant-verify.yml` 紅燈 | 單一租戶 | 鏈上的所有權、接線或參數與設定不符：先確認是不是租戶 admin 有意的變更（同步改設定檔）；不是的話當成事故處理 |
| 一個租戶的 exchange 暫停、某資產凍結 | 單一租戶 | 那是該租戶 guardian 的決定；解除暫停要該租戶的 admin |
| 所有租戶與平台同時價格過期 | **跨租戶**：共用上游價格來源或 GitHub 排程 | 通報所有租戶；看 `AggregatorOracle`、行情 API、Actions 狀態頁 |
| 所有租戶的 keeper 同時以同樣的錯誤失敗 | **跨租戶**：共用的 keeper 程式 | 回滾 `agent/keeper/` 的那次變更 |

一個租戶的 guardian、admin、keeper 對另一個租戶與平台沒有任何權限——合約不同、金鑰不同（`DeployTenant.t.sol` 的 `test_twoTenants_shareNoContractAndNoIncident` 與 fork 測試）。

## 5. 還沒做的事

- 租戶的健檢 workflow（§1.4）。
- 租戶 keeper 範本在真的租戶上 dispatch 驗證（範本只做過靜態檢查與 actionlint）。
- keeper 在 guarded-only 租戶上的實跑驗證，以及讓 keeper 在這種組合下也做 oracle 上限的預檢（§1.5）。
- signal-api、MCP server、Telegram bot 讀租戶的合約（§2.2）。
- SDK 直接讀部署登記的入口（§3）。
- 平台的 keeper workflow 改成讀 JSON（§1.3 的說明）。
- 租戶的 x402 結算 worker：範本、守門類別、改名的 secret（§2.1）。在那之前租戶不能自動結算 x402 收入。
- repo 設定（擁有者）：master 的 required checks（§1.6 第 0 步）、平台私鑰搬到 environment 層級。
- 租戶的價格監控與告警（§1.1：限速只是減速，監控與 guardian 才是防線）。
