# 新增一個白標租戶

> 2026-10-01 更新（合約部署腳本已參數化、前端依租戶切換位址）。隔離模型與理由見
> [`ADR-008-tenant-isolation.md`](ADR-008-tenant-isolation.md)，前端設定層見
> [`frontend/docs/adr/0009-tenant-config-layer.md`](../frontend/docs/adr/0009-tenant-config-layer.md)，
> 部署之後的 keeper／signal-api／SDK 見 [`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md)。
>
> **會送交易的步驟只有 §4 一個，由持有部署者金鑰的擁有者本人執行。** 其餘全部是唯讀檢查與模擬。
> CI 與 AI 助理都不廣播。

一個租戶在版本控制裡有四個檔案，都是 JSON、都**不含任何秘密**：

| 檔案 | 誰寫 | 決定什麼 | 誰檢查 |
|---|---|---|---|
| `frontend/src/tenant/tenants/<id>.json` | 人（常常是客戶提供） | 品牌、色票、語系、資產白名單、揭露追加、客服與法律連結、功能授權。**沒有任何位址欄位** | `vite build`、`frontend/src/tenant/*.test.ts` |
| `deploy/tenants/<id>.json` | 人 | 角色地址、結算幣與價格來源、OI 與獲利上限、oracle 種類、要不要金庫、註冊資產、收費（待決）、keeper 排程 | `node scripts/check-tenant-deploy.mjs`；`DeployTenant.s.sol` 的 preflight |
| `deploy/tenants/<id>.deployed.json` | `DeployTenant.s.sol` 廣播後寫出，人工複製進來 | 這個租戶的整組合約位址 | `check-tenant-deploy.mjs`；`VerifyTenant.s.sol`（對鏈上讀回） |
| `frontend/src/contracts/deployments/<id>.json` | 由部署紀錄產生（`--print-frontend`） | 前端要連哪一組合約 | `vite build`、`node scripts/check-addresses.mjs`、`check-tenant-deploy.mjs`（與部署紀錄對帳） |

`<id>` 是小寫英數與連字號，四個檔案用同一個 id。`default` 保留給現行正式站。

## 1. 前端租戶設定

1. 複製 `frontend/src/tenant/tenants/demo-bank.json` 成 `<id>.json`，把 `id` 改成 `<id>`。
2. 品牌素材放 `frontend/public/tenants/<id>/`，設定裡用站內路徑（例如 `/tenants/<id>/logo.svg`）。
   外部圖片網址會被拒絕——正式站的 CSP 只允許站內圖片。
3. `assets.enabled` 只能填 `frontend/src/contracts/addresses.ts` 的 `ASSET_IDS` 已有的代號，或 `"all"`。
4. `features` 每個功能有兩個值：`allowed`（這個租戶被授權使用嗎）與 `default`（環境變數沒設時開不開）。
   部署面板上的 `VITE_*` 旗標只能把已授權的功能關掉或打開，打不開 `allowed: false` 的功能。
   **專屬租戶的 `gamefi` 與 `pepeRewards` 必須是 `allowed: false`**：那些功能背後的合約
   （PEPE 代幣、AMM、質押…）只存在於平台部署，專屬租戶沒有，授權了 build 會失敗。
5. **部署登記**（沒有這個檔案 build 會失敗，租戶不會悄悄退回平台的合約）。還沒部署之前先放一份
   「沿用平台部署」的登記 `frontend/src/contracts/deployments/<id>.json`：

   ```json
   {
     "schemaVersion": 1,
     "tenant": "<id>",
     "kind": "platform",
     "note": "尚未部署專屬合約；上線前換成 dedicated。"
   }
   ```

   `kind: "platform"` 的租戶與平台共用資金、保險金與暫停鍵，只適合示範與部署前的預覽。部署完成後在 §5 換成 `dedicated`。
6. 驗證與建置：

   ```bash
   cd frontend
   VITE_TENANT=<id> yarn build     # 設定不合法、id 不符、檔案不存在、沒有部署登記都會讓 build 失敗
   yarn test
   ```

7. 部署到租戶自己的 Vercel project（或其他靜態主機），環境變數設 `VITE_TENANT=<id>`。
   沒設 `VITE_TENANT` 就是 `default`——所以正式站那個 project 不需要任何改動。

## 2. 部署設定

1. 複製 `deploy/tenants/_template.json` 成 `deploy/tenants/<id>.json`，填 `tenantId` 與 `frontendTenant`（兩者必須相同，
   也與檔名相同）。`network.chainId` 只接受 84532（Base Sepolia）或 8453（Base）；前端目前只能連 84532 的專屬部署。
2. `secretsEnv` 只寫**環境變數名稱**（例如 `BANK_A_DEPLOYER_PRIVATE_KEY`），值放在部署者自己的 secret store
   或 GitHub Actions secrets。私鑰（64 位十六進位，帶不帶 `0x` 都算）、助記詞、RPC 網址寫進這個檔案
   會被檢查腳本擋下。
   - `$comment` 要引用部署交易，請貼**區塊瀏覽器的交易連結**（`https://sepolia.basescan.org/tx/0x…`）：
     只有緊接在 `/tx/` 之後的 `0x`＋64 位會放行，裸貼的 tx hash（不論帶不帶 `0x`）一律視為私鑰擋下。
   - 助記詞的判定是「連續 12 個以上、每個 3–8 個英文字母的單字，以空白或逗號分隔」，**大小寫不敏感**，
     所有欄位（含 `$comment`）都檢查，字串陣列會先 join 再測。
   - ⚠️ **一般英文長句可能被誤判為助記詞**：例如 `Keeper runs every fifteen minutes using the shared oracle feed
     plus its own wallet only` 剛好是 14 個 3–8 字母的單字，會被擋。這是刻意的取捨（寧可誤擋說明，也不放過
     助記詞）。被擋時把說明改寫成中文、加標點、或放進 docs 而不是設定檔即可，不要放寬檢查。
3. `roles` 先用 `<...>` 佔位值（`status: "template"`）。金鑰由持有人產生；地址確定後填入並把 `status`
   改成 `ready`。檢查腳本與 `DeployTenant.s.sol` 的 preflight 都要求：
   - admin／keeper／guardian／risk 兩兩不同（6 組配對）；
   - guardian 不兼 marketOperator（marketOperator 可以就是 keeper，平台如此）；
   - 熱錢包不收款：treasury 不是 keeper、也不是 guardian；
   - **部署者不持有任何角色**（部署結束時它不留任何權限）；
   - admin 是合約（multisig）。演練時才用 `ALLOW_EOA_ADMIN=true` 放行 EOA；
   - 任何專屬地址不得與現行正式站（`addresses.ts`）或其他租戶重複；`ready` 以上不得留佔位值。
4. `shared` 是允許與其他租戶共用的兩個元件：
   - `settlementToken`：結算幣。**必須是 18 位小數**（`PerpetualExchange` 寫死 18 位，6 位小數的代幣會讓每個部位
     的尺度錯誤且無法修正；preflight 會擋）。
   - `priceSource`：共用的參考價格來源（`getPrice(bytes32)`）。它只在部署當下被讀一次，用來替租戶自己的 oracle
     取初始價；之後租戶的 exchange 只讀租戶自己的 oracle。每一檔註冊資產都必須有 **1 小時內**更新過的報價。
5. `params` 是寫上鏈的參數，`template` 可以留 `null`，`ready` 必須填：

   | 欄位 | 說明 |
   |---|---|
   | `oracleKind` | `"guarded"`（建議，也是主網唯一允許的）：租戶自己的 `GuardedOracle`，單次偏離上限 10%，guardian 可凍結。`"mock"`：租戶自己的 `MockOracle`，keeper 一把金鑰可寫任意價格，只限測試網，而且不能搭配金庫 |
   | `oiCapNonRwaUsdc`／`oiCapRwaUsdc` | 每個資產每一邊的未平倉上限（整數 USDC）。**不可為 0**——合約上 0 代表不設上限。新租戶的保險金是空的，數字由租戶的風險委員會決定；平台的算法與理由見 [`DEPLOY_130_CUTOVER.md`](DEPLOY_130_CUTOVER.md) §3.1 |
   | `maxProfitBps` | 單筆獲利上限，10000–250000（平台用 50000＝5 倍保證金）。0（不設上限）不允許 |
   | `deployVault` | 要不要部署代幣化資產金庫（`AssetVaultV2` proxy＋每檔資產一顆代幣）。需要 `oracleKind: "guarded"` |

   哪些資產是 RWA（要 KYC）**不是租戶設定**：由資產本身決定，腳本內建的分類與平台相同（測試釘住）。
6. `assets.registered` 是這個租戶要上架的資產，必須涵蓋前端 `assets.enabled`——前端不能開一檔沒註冊的資產。
7. `fees` 在收費模式定案前固定是 `{"status": "pending-decision", "baseFeeBps": null, "tenantMarkupBps": null}`；
   這個狀態的租戶不能標成 `deployed`。
8. 檢查：

   ```bash
   node scripts/check-tenant-deploy.mjs                             # 全部租戶（設定＋部署紀錄＋與前端登記對帳）
   node scripts/check-tenant-deploy.mjs deploy/tenants/<id>.json    # 單一租戶
   ```

## 3. dry-run（不帶金鑰、不送交易）

```bash
node scripts/check-tenant-deploy.mjs --print-env deploy/tenants/<id>.json
```

先跑完整檢查，通過才印出下面這幾行指令與這份設定會寫上鏈的角色與參數對照。它不執行任何東西，也不含 `--broadcast`。

```bash
cd contracts
# (a) 只跑唯讀的前置檢查
TENANT=<id> PREFLIGHT_ONLY=true forge script script/DeployTenant.s.sol:DeployTenant \
  --fork-url "$BASE_SEPOLIA_RPC_URL" --sender 0x<部署者位址> -vv
# (b) 完整模擬：部署、接線、移交、讀回驗證，全部在 fork 上
TENANT=<id> forge script script/DeployTenant.s.sol:DeployTenant \
  --fork-url "$BASE_SEPOLIA_RPC_URL" --sender 0x<部署者位址> -vv
```

- `--sender` 是部署者的**位址**，不是金鑰。模擬不需要任何私鑰。
- 成功的模擬最後會印出一長串 `ok`（就是 `VerifyTenant` 的全部斷言）、一份 `mode: dry-run` 的部署紀錄、
  以及 forge 的 `SIMULATION COMPLETE`。紀錄寫到 `contracts/cache/tenants/<id>.dry-run.json`（git-ignored）。
  **dry-run 的位址是模擬出來的**，不要複製到任何地方。
- preflight 會拒絕的常見情況：價格來源超過 1 小時沒更新（先讓平台的 keeper 跑一輪）、admin 沒有 code、
  部署者等於某個角色、`status` 不是 `ready`、`network.chainId` 與連上的鏈不同。
- 腳本讀的是 `deploy/tenants/<id>.json`，**不讀環境變數裡的位址**。`foundry.toml` 的 `fs_permissions` 只允許
  讀 `deploy/tenants/`、只允許寫 `contracts/cache/tenants/`。

2026-10-01 在本機 anvil fork（Base Sepolia）的實測：143 筆交易、約 4,490 萬 gas；以當時的 0.0033 gwei 計約 0.00015 ETH。
2026-10-02 以當日的 Base Sepolia 狀態重跑 fork 測試（`forge test --match-path test/fork/DeployTenantFork.t.sol --fork-url https://sepolia.base.org`，
只在本機 fork 上執行、不送任何交易）：2 支全過，`VerifyTenant` 的斷言全部 `ok`。

### 本機 anvil 演練（選用）

想連 `VerifyTenant` 的獨立執行也演練一次，可以對**自己本機的** anvil fork 廣播（`anvil --fork-url …`，
用 anvil 的公開測試帳號）。注意兩件事：

- 這種演練寫出的紀錄 `mode` 也是 `broadcast`、`chainId` 也是 84532，從檔案本身看不出它是假的。
  分辨的方法是對**真正的鏈**跑 `VerifyTenant`：本機演練的位址在鏈上沒有 code，會以
  `a recorded contract has no code on this chain` 失敗。**永遠不要跳過 §4 的 VerifyTenant。**
- forge 會在 `contracts/broadcast/DeployTenant.s.sol/84532/` 留下 `run-*.json`。那個目錄是進版控的，
  演練完要刪掉，不要 commit。

## 4. 廣播（擁有者本人執行）

前提：§3 的模擬通過；部署者位址有足夠的 ETH；平台的 keeper 剛跑過（價格來源夠新）。

```bash
cd contracts
TENANT=<id> forge script script/DeployTenant.s.sol:DeployTenant \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$<部署者金鑰的環境變數>" --broadcast --slow -vv
```

- 一定要加 `--slow`：後面的交易依賴前面剛部署的合約，公共 RPC 一次收到整批容易丟交易。
- 這次執行**不碰任何既有合約**，沒有不可逆的步驟，也沒有需要「續跑」的共用指標。中途失敗時留下的是一組沒有資金、
  owner 還是部署者的未完成合約：用 `forge script … --resume` 接著送同一批，或直接重來一次（舊的那組作廢）。
- 部署的最後一步把所有權交給 `roles.admin`：`Ownable` 的合約 `transferOwnership`，`AccessControl` 的合約
  先授予、讀回確認、才放棄部署者的 admin。**結束時部署者在任何一顆合約上都沒有權限。** 一步到位的所有權轉移無法復原，
  而這時整組合約還沒有任何資金——admin 填錯的代價是重新部署，不是資產被鎖。
- 執行內建完整讀回驗證，任何一項不符整個 run 就 revert（不會留下「部署了但沒驗證」的狀態）。
- 紀錄寫到 `contracts/cache/tenants/<id>.deployed.json`。

廣播後，對真正的鏈再讀回一次（唯讀）：

```bash
TENANT=<id> TENANT_RECORD=cache/tenants/<id>.deployed.json \
  forge script script/VerifyTenant.s.sol:VerifyTenant --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
```

它檢查：每顆合約有 code 且位址互不相同、也不是共用元件；exchange 的 owner／guardian／marketOperator／oracle／
保險金／FeeRouter／KYC 接線；每檔資產的 RWA 旗標、OI 上限、獲利上限；FeeRouter 的 treasury 是租戶的；
oracle 與金庫的角色各歸其位；**部署者不留任何角色**。價格過期只會 WARN（那是 keeper 的狀態，不是接線）。

## 5. 廣播之後（一個 PR）

1. 把紀錄複製進版控，並把部署設定的 `status` 改成 `deployed`（收費模式必須已定案，檢查腳本才會通過）：

   ```bash
   cp contracts/cache/tenants/<id>.deployed.json deploy/tenants/<id>.deployed.json
   ```

   之後 `VerifyTenant` 不必再給 `TENANT_RECORD`，預設就讀這個路徑。
2. 產生前端部署登記，取代 §1 的 `kind: "platform"`：

   ```bash
   node scripts/check-tenant-deploy.mjs --print-frontend deploy/tenants/<id>.deployed.json \
     > frontend/src/contracts/deployments/<id>.json
   ```

   不要手打位址。租戶另外部署了 x402 分潤路由的話，手動加一行 `contracts.X402FeeRouter`（唯一允許不在部署紀錄裡的欄位）。
3. 檢查與建置：

   ```bash
   node scripts/check-tenant-deploy.mjs      # 部署紀錄只收 mode=broadcast；前端登記必須與紀錄逐欄位相同
   node scripts/check-addresses.mjs          # 除結算幣外，不得與平台或其他租戶共用任何位址
   cd frontend && VITE_TENANT=<id> yarn build
   ```
4. `contracts/broadcast/DeployTenant.s.sol/<chainId>/run-*.json` 是這次部署的機器可讀紀錄，照慣例進版控。
5. 接著做營運面：keeper 的 environment 與 workflow、signal-api、SDK——[`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md)。
   **keeper 第一次寫價成功之前不要對外開放前端。**
6. 租戶 admin 之後要做的事（都經過 multisig，不在部署腳本裡）：
   - 指派 KYC verifier（`KYCRegistry.setVerifier`）。在那之前所有 RWA 市場對所有人關閉。
   - 指派碳分級見證人（`ESGRegistryV2` 的 `ATTESTOR_ROLE`）。在那之前每檔資產都是 Unrated——槓桿 1 倍、費率最高那一級（fail-closed）。
   - 注入保險金（`InsuranceVault.deposit`／`recapitalize`）。新租戶的保險金是 0。
   - 金庫的每檔資產上限預設是 0（關閉鑄造），由 risk 金鑰逐檔開放，並 `fundVault` 注入兌付準備。
   - 若要把所有權放到 Timelock 後面，由 admin 自行部署並轉移；之後跑 `VerifyTenant` 要加 `EXPECTED_OWNER=<timelock>`。

## 6. 已知缺口

- **收費模式待決**：base fee＋租戶 markup 的數字與收取方式（鏈上需要新版 FeeRouter）。在定案前沒有任何租戶能標成 `deployed`。
- **沒有任何專屬租戶真的廣播過**：腳本只在單元測試、Base Sepolia fork 測試與本機 anvil fork 上跑過。
- **前端只能連 Base Sepolia 的專屬部署**；Base 主網需要錢包切換、RPC、CSP、區塊瀏覽器連結的設定。
- **專屬租戶的前端沒有逐頁走查過**（沒有可瀏覽的專屬部署）。見 ADR 0009 增補的 Consequences。
- **ESGRegistryV2 只有「每租戶專屬」一種**；ADR-008 允許租戶明確選擇共用平台登錄的選項沒有實作。
- **keeper**：租戶 workflow 要手動複製；keeper 程式在只有一顆 GuardedOracle 的租戶上沒有實跑過；租戶沒有健檢。見 `TENANT_OPERATIONS.md` §1。
- **agent 端（signal-api、MCP server、Telegram bot）讀的是平台的合約**，每租戶一個 Vercel 專案今天只能隔離收款。見 `TENANT_OPERATIONS.md` §2.2。
- **部署中斷沒有續跑機制**（刻意：不碰共用指標，重來的代價只有 gas）。
