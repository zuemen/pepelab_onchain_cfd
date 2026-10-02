# 白標租戶的營運：keeper、signal-api、SDK

> 2026-10-01。隔離模型見 [`ADR-008-tenant-isolation.md`](ADR-008-tenant-isolation.md)，部署步驟見
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
| keeper 金鑰 | GitHub environment `keeper` | GitHub environment `keeper-<id>` | 擁有者 |
| keeper workflow | `base-sepolia-keeper.yml` | `tenant-<id>-keeper.yml`（複製） | PR，CI 把關 |
| x402 收款地址 | repository variable `PAY_TO` | 租戶自己的 `PAY_TO`（租戶的 Vercel 專案與 `settlement-<id>` environment） | 擁有者 |
| x402 分潤路由 | `frontend/src/contracts/x402.ts` | 登記檔的 `contracts.X402FeeRouter`（`DeployX402Router.s.sol`，`TREASURY`＝租戶的 treasury） | 持有部署者金鑰的人 |
| signal-api | 現行 Vercel 專案 | 租戶自己的 Vercel 專案（**資料來源尚不能隔離**，見 §2.2） | 擁有者 |

共用的只有三樣：程式碼、結算幣、上游價格來源（`AggregatorOracle` 與行情 API）。其餘任何一項與平台或另一個租戶共用，都違反 ADR-008。

## 1. keeper

### 1.1 金鑰與角色

- keeper 的地址就是 `deploy/tenants/<id>.json` 的 `roles.keeper`。`DeployTenant.s.sol` 已經把租戶 oracle 的寫價權給它（guarded：`KEEPER_ROLE`；mock：`owner`），不需要再做任何授權。
- `roles.marketOperator` 可以就是 keeper（平台如此）。它只能在 Active 與 ReduceOnly 之間切換市場。
- 這把金鑰**只屬於這個租戶**。`scripts/check-tenant-deploy.mjs` 會擋下與平台或其他租戶重複的角色地址。金鑰外洩時的影響範圍是這一個租戶的價格，而且受租戶 oracle 的單次偏離上限（10%）限制。
- keeper 地址要有 gas。workflow 的 `Warn before the tank runs dry` 步驟在餘額低於 0.02 ETH 時警告、低於 0.002 ETH 時直接失敗。

### 1.2 建立 GitHub environment `keeper-<id>`

沿用 [`ops/keeper-trigger/README.md`](../ops/keeper-trigger/README.md)「部署前必做」第 2 步的模式，差別只有名稱與裡面放的金鑰：

1. repo → Settings → Environments → New environment → 名稱 **`keeper-<id>`**（必須是這個名稱，CI 會檢查）。
2. Deployment branches and tags：Selected branches → `master`。
3. Environment secrets：新增 `KEEPER_PRIVATE_KEY`，值是**這個租戶的** keeper 私鑰。租戶用自己的 RPC 時，同樣在這裡新增 `BASE_SEPOLIA_RPC_URL`；沒放就沿用 repo 層級的那一個。
4. **不要**設 required reviewers、wait timer 或 custom deployment protection rule：keeper job 用 `deployment: false`，reviewers 與 wait timer 會讓排程卡住，custom rule 會讓 job 直接失敗（理由與出處在上述 README）。
5. **不要**把租戶的私鑰放在 repo 層級。environment secret 只有引用該 environment 的 job 拿得到；repo 層級的 secret 任何 workflow（含舊分支上的）都拿得到。

> 為什麼一定要先建：workflow 引用一個不存在的 environment 時，GitHub 會自動建一個沒有任何保護、也沒有 secret 的同名 environment。那時 `secrets.KEEPER_PRIVATE_KEY` 會退回 repo 層級的同名 secret：
>
> - repo 層級已經沒有這個 secret（`ops/keeper-trigger/README.md` 第 4 步做完之後的狀態）→ job 在 `Fail fast when secrets are missing` 失敗，沒有任何交易；
> - repo 層級還留著 → 租戶的 job 拿到的是**平台的** keeper 金鑰。它在租戶的 oracle 上沒有任何角色，每一筆寫價都會 revert、job 變紅，不會寫錯價；但「租戶的 job 拿到了平台的金鑰」本身就不該發生。
>
> 所以順序是：先建 environment、先放 secret，再合併 workflow。

### 1.3 workflow：複製一支，不用 matrix

**做法**：把 `.github/workflows/base-sepolia-keeper.yml` 複製成 `tenant-<id>-keeper.yml`，只改下面這些地方，其餘步驟（餘額檢查、寫價、熔斷告警、funding crank）一個字都不要動。

| 位置 | 平台的值 | 租戶要改成 | 來源 |
|---|---|---|---|
| `name:` | `Base Sepolia Keeper` | `Keeper (<id>)` | — |
| `concurrency.group` | `keeper-key-base-sepolia` | `keeper-key-<id>` | 不同金鑰＝不同 nonce 序列，不要排在平台後面 |
| `jobs.keep.environment.name` | `keeper` | `keeper-<id>` | §1.2 |
| `env.KEEPER_TENANT` | （沒有） | `<id>` | 讓 CI 以租戶的登記比對位址 |
| `env.KEEPER_ORACLE_ADDRESS` | 平台的 MockOracle | 登記檔的 `contracts.Oracle` | exchange 讀的那一顆 oracle |
| `env.EXCHANGE` | 平台的 exchange | 登記檔的 `contracts.PerpetualExchange` | — |
| `env.KEEPER_GUARDED_ORACLE` | 平台的 GuardedOracle | **刪掉這一行** | 見 §1.5 |
| `env.KEEPER_VAULT_ADDRESS` | 平台的金庫 | 登記檔的 `contracts.AssetVaultV2`；租戶沒有金庫就刪掉這一行 | — |
| `env.KEEPER_RELAY_SOURCE` | `AggregatorOracle` | **不變** | 共用上游價格來源（ADR-008 方案 B） |
| `Alert on price circuit breaker` 的 `ALERT_TITLE` | `[keeper] Base Sepolia 價格熔斷` | `[keeper] <id> 價格熔斷` | 告警 issue 以標題去重，不同租戶不能共用標題 |
| `Crank settleFunding` 的 `for SYM in sBTC sETH sAAPL sTSLA` | 四檔 | 這個租戶 `assets.registered` 裡要結算 funding 的資產 | 清單外的資產在租戶的 exchange 上沒有部位 |
| `on.schedule` | `*/15 * * * *` | 依 `deploy/tenants/<id>.json` 的 `keeper.cron` | — |

**CI 把關**（`scripts/check-addresses.mjs`，`consistency.yml`）。帶 `KEEPER_TENANT: <id>` 的 job：

- 每個位址以 `frontend/src/contracts/deployments/<id>.json` 比對，不以平台的 `addresses.ts`；`EXCHANGE` 填成平台的 exchange 會紅燈，反過來平台的 workflow 填了租戶的位址也會紅燈；
- `run:`／`with:` 裡寫死的位址同樣只能是這個租戶的合約或共用上游價格來源；
- 取用 `secrets.KEEPER_PRIVATE_KEY` 的 job，`environment` 必須是 `keeper-<id>`，`concurrency.group` 必須含 `<id>`（只讀的 job，例如健檢，不需要）；
- `<id>` 必須有部署登記。登記是 `kind: "platform"` 的租戶（示範租戶）沒有自己的合約，它的 keeper 就是平台的 keeper，不需要另一支 workflow。

**為什麼不用 matrix。** 寫得出來（下面是示意），但目前不建議：

```yaml
# 示意，不是 repo 裡的檔案。
jobs:
  keep:
    strategy:
      fail-fast: false            # 一個租戶失敗不能取消其他租戶那一輪
      matrix:
        include:
          - tenant: bank-a
            oracle: "0x…"
            exchange: "0x…"
    concurrency:
      group: keeper-key-${{ matrix.tenant }}
      cancel-in-progress: false
    environment:
      name: keeper-${{ matrix.tenant }}
      deployment: false
    env:
      KEEPER_ORACLE_ADDRESS: ${{ matrix.oracle }}
      EXCHANGE: ${{ matrix.exchange }}
```

1. `check-addresses.mjs` 是逐行解析，只認得 `KEY: 0x…`。位址放進 matrix 之後它看不到哪個位址屬於哪個租戶，**把關就失效了**——而「workflow 指向錯的合約卻全綠」正是這支檢查存在的理由（2026-09-29 的事故）。
2. 一支檔案服務所有租戶，一次改壞就停掉所有租戶的價格。ADR-008 把「共用程式的缺陷」列為跨租戶事故；workflow 檔不必也變成共用的單點。
3. 租戶的排程、funding 清單、告警標題本來就各自不同，matrix 省不了多少。

租戶數量多到複製不可行時，正確的下一步是讓 workflow 讀部署登記的 JSON（位址只有一個來源），並把 `check-addresses.mjs` 改成檢查那份 JSON；那時再換 matrix。

**為什麼這次沒有把 `base-sepolia-keeper.yml` 的位址改成讀 JSON。** 技術上是小改動（加一個步驟把位址寫進 `$GITHUB_ENV`，拿掉 `env:` 裡的五行），但：

- 它是平台價格的活性關鍵路徑，近期已經出過幾次事故；這個改動只能靠實際執行 workflow 來驗證，而執行它就是對公開鏈送交易，這不是寫程式的人可以自己做的事；
- 改完之後行為與現在相同，沒有任何租戶因此受益——租戶用的是複製出來的那一支；
- 位址從 YAML 搬到 JSON 之後，現有的逐行檢查要整個改寫，才能維持同樣強度的把關。

所以這次只做了不碰線上 workflow 的部分：租戶 keeper 的 CI 規則。要做的話應該是一個獨立的 PR，由擁有者 dispatch 一次驗證。

### 1.4 外部觸發器與健檢

- **觸發器**：GitHub 排程的實際間隔是 68–169 分鐘。要讓 [`ops/keeper-trigger`](../ops/keeper-trigger/README.md) 的 Worker 也照顧租戶的 keeper，把檔名加進 `wrangler.toml` 的 `WORKFLOW_FILES`（逗號分隔）後重新 `wrangler deploy`。各支獨立判斷，一支觸發失敗不影響其他支。
- **健檢**：`oracle-health.yml` 目前只看平台的 oracle 與 exchange。**租戶沒有健檢**——keeper 連續失敗時不會有人被通知。試點租戶上線前要為它複製一個健檢 job（同樣帶 `KEEPER_TENANT`，CI 會比對位址），或接受「只有 keeper 自己的紅燈」這個監控水準並寫進租戶的服務條款。

### 1.5 keeper 程式與租戶 oracle 的相容性（上線前要驗證）

keeper 程式（`agent/keeper/`）是為平台的組合寫的：exchange 讀 MockOracle，另有一顆 GuardedOracle 給金庫，兩顆要同步。guarded 租戶只有一顆 oracle，exchange 與金庫都讀它。這次**沒有修改 keeper 程式**，以下是讀程式碼得到的結論，還沒有在真的租戶上跑過：

| 項目 | 現況 | 影響 |
|---|---|---|
| 主 oracle 的介面 | keeper 對 `KEEPER_ORACLE_ADDRESS` 呼叫 `getPrice`／`updatePrice`；GuardedOracle 兩個都有 | 把租戶的 GuardedOracle 填在 `KEEPER_ORACLE_ADDRESS` 即可 |
| `KEEPER_GUARDED_ORACLE` | 設了就會「先寫 Guarded、成功才寫 Mock」。兩個變數填同一顆的話，每檔資產每輪寫兩次 | 不要設。代價見下一列 |
| 熔斷門檻 | 沒設 `KEEPER_GUARDED_ORACLE` 時，keeper 不知道 oracle 的 10% 上限，只用 `KEEPER_BREAKER_DEVIATION`（預設 20%） | 10%–20% 的變動 keeper 會嘗試寫入，被 oracle 以 `DeviationTooLarge` 拒絕，算成一筆寫入失敗。結果仍是 fail-closed，但錯誤訊息不如平台的預檢清楚。可以把租戶 workflow 的 `KEEPER_BREAKER_DEVIATION` 設成 `0.1` 讓兩邊一致 |
| 讀不到現價就不寫 | keeper 寫價前先 `getPrice`；讀取 revert 且不是 `AssetNotFound` 時拒寫（`round.ts`） | 這是 `DeployTenant` 把租戶 oracle 的 `maxPriceAge` 設成 0 的原因：否則一次超過上限的中斷之後 `getPrice` 會 `StalePrice`，keeper 就永遠寫不進去。過期仍由 exchange（6 小時）與金庫（6 小時）各自把關 |
| 資產被 guardian 凍結 | `getPrice` 以 `AssetIsFrozen` revert → keeper 拒寫 | 符合預期：凍結是 guardian 的決定，解除後 keeper 自動恢復 |

**上線前的驗證**（都不送交易）：在本機以 `DRY_RUN=1`、`KEEPER_ORACLE_ADDRESS=<租戶 Oracle>`、`KEEPER_RPC_URL=<RPC>` 跑一次 `npx tsx keeper/run.ts`（在 `agent/` 底下），確認 11 檔資產都讀得到現價、摘要行的 `failed=0`。之後由擁有者 dispatch 租戶的 workflow 一次，確認真的寫得進去。

### 1.6 上線順序

1. `DeployTenant` 已廣播、`VerifyTenant` 通過、部署紀錄與前端登記已合併（[`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md)）。
2. 擁有者建立 `keeper-<id>` environment 並放入金鑰（§1.2），替 keeper 地址補 gas。
3. §1.5 的 `DRY_RUN` 驗證。
4. 以 PR 新增 `tenant-<id>-keeper.yml`（§1.3）；`consistency.yml` 綠燈才合併。
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

前端這一側：租戶的 Vercel 專案設 `VITE_SIGNAL_API_URL` 指向租戶的 signal-api。`vite build` 會檢查這個網址在 `frontend/vercel.json` 的 CSP `connect-src` 裡，不在就讓 build 失敗——所以新增租戶的 signal-api 網域要先改 `vercel.json`。

結算 worker：複製 `x402-settlement-worker.yml`，用 environment `settlement-<id>`（放租戶的 `FEE_SETTLEMENT_PRIVATE_KEY` 與 Upstash 憑證，`PAY_TO`／`X402_FEE_ROUTER`／`SIGNAL_API_URL` 改用 environment 層級的 variables），`concurrency.group` 改成 `x402-settlement-worker-<id>`。其中 `Assert X402_FEE_ROUTER matches frontend config` 那一步目前比對的是平台的 `x402.ts`，租戶的版本要改成比對登記檔的 `contracts.X402FeeRouter`。

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
| 一個租戶的價格過期、keeper 紅燈 | 單一租戶 | 看 `tenant-<id>-keeper.yml` 的 run：gas、nonce、`DeviationTooLarge` |
| 一個租戶的 exchange 暫停、某資產凍結 | 單一租戶 | 那是該租戶 guardian 的決定；解除暫停要該租戶的 admin |
| 所有租戶與平台同時價格過期 | **跨租戶**：共用上游價格來源或 GitHub 排程 | 通報所有租戶；看 `AggregatorOracle`、行情 API、Actions 狀態頁 |
| 所有租戶的 keeper 同時以同樣的錯誤失敗 | **跨租戶**：共用的 keeper 程式 | 回滾 `agent/keeper/` 的那次變更 |

一個租戶的 guardian、admin、keeper 對另一個租戶與平台沒有任何權限——合約不同、金鑰不同（`DeployTenant.t.sol` 的 `test_twoTenants_shareNoContractAndNoIncident` 與 fork 測試）。

## 5. 還沒做的事

- 租戶的健檢 workflow（§1.4）。
- keeper 在 guarded-only 租戶上的實跑驗證，以及讓 keeper 在這種組合下也做 oracle 上限的預檢（§1.5）。
- signal-api、MCP server、Telegram bot 讀租戶的合約（§2.2）。
- SDK 直接讀部署登記的入口（§3）。
- 平台的 keeper workflow 改成讀 JSON（§1.3 的說明）；租戶數量多到要用 matrix 時再做。
- 租戶結算 workflow 的 `X402_FEE_ROUTER` 執行期比對改讀部署登記（§2.1）。
