# 新增一個白標租戶

> 2026-10-01 更新（合約部署腳本已參數化、前端依租戶切換位址）；2026-10-02 依 PR #228 審查修正
> （設定 schema v3：oracle 限速與風控參數、共用元件白名單、平台位址全集、CI 鏈上驗證）；2026-10-06 schema v4
> （`params.kycRegistry`：KYC 閘門可選可驗證憑證登錄；`assets.additionalRwa`：追加要 KYC 的資產）。隔離模型與理由見
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
| `deploy/tenants/<id>.json` | 人 | 角色地址、共用元件（結算幣、價格來源、參考來源）、oracle 種類與限速、exchange 與金庫的風控參數、要不要金庫、註冊資產、收費（待決）、keeper 排程 | `node scripts/check-tenant-deploy.mjs`；`DeployTenant.s.sol` 的 preflight；`VerifyTenant.s.sol` 逐項讀回 |
| `deploy/tenants/<id>.deployed.json` | `DeployTenant.s.sol` 廣播後寫出，人工複製進來 | 這個租戶的整組合約位址 | `check-tenant-deploy.mjs`；`VerifyTenant.s.sol`（對鏈上讀回） |
| `frontend/src/contracts/deployments/<id>.json` | 由部署紀錄產生（`--print-frontend`） | 前端要連哪一組合約 | `vite build`、`node scripts/check-addresses.mjs`、`check-tenant-deploy.mjs`（與部署紀錄對帳）；`dedicated` 的由 CI 的 `tenant-verify.yml` 對鏈上跑 `VerifyTenant` |

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
   - guardian 不兼 marketOperator；admin 也不兼 marketOperator（marketOperator 可以就是 keeper，平台如此）；
   - 熱錢包不收款：treasury 不是 keeper、也不是 guardian；
   - **部署者不持有任何角色**（部署結束時它不留任何權限）；
   - admin 是合約（multisig）。測試網演練時才用 `ALLOW_EOA_ADMIN=true` 放行 EOA；**Base 主網一律不放行**；
   - 任何專屬地址不得出現在**平台位址全集**裡，也不得與其他租戶重複；`ready` 以上不得留佔位值。
     平台位址全集＝repo 裡**每一個被 git 追蹤的文字檔**中出現過的每一個位址（含註解、部署腳本、
     `contracts/broadcast/`、`docs/`、`ops/monitoring/`、workflow、agent 設定；監控設定裡補零成 32 位元組的位址
     也算），加上機器可讀的退役清單 `retiredPlatformAddresses.json`。只排除租戶自己的設定與登記、測試 fixture、
     第三方 `lib/`、lockfile 與產生的 bundle；官方 USDC、Permit2、預編譯合約、Anvil 預設帳號這類眾所周知的
     非平台位址以具名白名單扣除（Anvil 預設帳號的私鑰公開，另外直接擋）。排除清單與白名單逐條寫了理由，見
     `scripts/lib/platform-addresses.mjs`。所以平台的 owner／admin／guardian／risk／keeper EOA 與所有平台
     合約都不能當租戶的角色、部署者或合約。
4. `shared` 是與平台共用的三個元件，而且是**白名單**：每一個只能是平台在同一條鏈上的指定角色
   （`scripts/check-tenant-deploy.mjs` 的 `SHARED_ALLOWED_ROLES`），填別的位址一律擋下。
   - `settlementToken`：結算幣，只能是平台的那一顆（Base Sepolia：`MockUSDC`）。**必須是 18 位小數**
     （`PerpetualExchange` 寫死 18 位，6 位小數的代幣會讓每個部位的尺度錯誤且無法修正；preflight 會擋）。
     **Base 主網的原生 USDC 是 6 位小數，不能直接當結算幣**；平台在主網還沒有任何共用元件，所以今天任何一份
     `network.chainId: 8453` 的設定都過不了白名單——要先決定主網的結算幣（例如 18 位的包裝幣）與共用元件。
     建議方案（每租戶一顆 1:1 包裝幣＋存入 router）與尚未完成的整合項目見 [ADR-011](ADR-011-settlement-token-decimals.md)。
   - `priceSource`：只在部署當下被讀一次，用來替租戶自己的 oracle 取初始價；之後租戶的 exchange 只讀租戶
     自己的 oracle。只能是平台的 `MockOracle`／`GuardedOracle`／`AggregatorOracle`。每一檔註冊資產都必須有
     **1 小時內**更新過的報價。
   - `referenceSource`：租戶 `GuardedOracle` 的參考來源，或字串 `"none"`（不可省略、不可寫零位址）。
     只能是平台的 `AggregatorOracle`／`ChainlinkAdapter`／`PythAdapter`（去中心化行情；keeper 寫得到的 oracle
     不是獨立的參考）。參考來源確認過的寫價不受單次上限與時間窗限制，所以它不得是任何租戶角色或結算幣。
     `"none"` 時 `VerifyTenant` 會印出「無參考來源」：keeper 的寫價只受單次上限與時間窗限制。
     Base 主網的 guarded oracle 必須有參考來源；`oracleKind: "mock"` 必須是 `"none"`。
5. `params` 是寫上鏈的參數（schema v4）。**每一個鍵都要寫出來，沒有預設值**；值是範圍內的整數，或 `null`。
   `null` 只在兩種情況合法：`status: "template"`（數字還沒決定），或這個參數對這份設定不適用——
   `oracleKind: "mock"` 的三個 oracle 參數、`deployVault: false` 的兩個金庫參數，這兩種情況**必須**是 `null`
   （不能寫一個不存在的上限讓讀的人以為有）。範圍在 `scripts/check-tenant-deploy.mjs` 的 `PARAM_RANGES` 與
   `contracts/script/VerifyTenant.s.sol` 的常數，兩邊由測試釘成相同；`DeployTenant` 的 preflight 與 CI 都檢查。

   | 欄位 | 範圍 | 說明 |
   |---|---|---|
   | `oracleKind` | `guarded`／`mock` | `"guarded"`（建議，也是主網唯一允許的）：租戶自己的 `GuardedOracle`，有單次上限與時間窗限速，guardian 可凍結。`"mock"`：租戶自己的 `MockOracle`，**沒有任何限速**，keeper 一把金鑰可寫任意價格，只限測試網，而且不能搭配金庫 |
   | `oracleMaxDeviationBps` | 100–1000 | 單次寫價相對前一筆的最大變動（平台 1000＝10%，也是上限）。有參考來源時，它同時是「與參考一致」的容忍度：參考價 ±這個比例之內的寫價不受時間窗限制。keeper workflow 的熔斷門檻也跟著它 |
   | `oracleWindowSeconds` | 3600–86400 | 限速時間窗長度 d（平台 3600，也是下限） |
   | `oracleWindowDeviationBps` | 100–2500 | 一個時間窗內相對窗口起點的累計最大變動 W（平台 2500，也是上限）。**0（不限速）不允許**。時間窗是複利、不是總上限：T 秒內最多乘 (1+W)^(⌊T/d⌋+1)；預設值下 keeper 金鑰外洩時 1 小時 1.25 倍、6 小時約 3.05 倍、24 小時約 169 倍（`TENANT_OPERATIONS.md` §1.1）。範圍不得比平台寬鬆（PR #228 複審 C1） |
   | `oiCapNonRwaUsdc`／`oiCapRwaUsdc` | 1–10,000,000 | 每個資產每一邊的未平倉上限（整數 USDC）。**不可為 0**——合約上 0 代表不設上限；上界避免「實務上等於不設上限」。新租戶的保險金是空的，數字由租戶的風險委員會決定；平台的算法與理由見 [`DEPLOY_130_CUTOVER.md`](DEPLOY_130_CUTOVER.md) §3.1 |
   | `maxProfitBps` | 10000–250000 | 單筆獲利上限（平台用 50000＝5 倍保證金）。0（不設上限）不允許 |
   | `maxLeverage` | 1–5 | 每檔資產的槓桿上限（`setMaxLeverageFor`）。實際可用的是它與碳分級上限的較小者；ESG 見證人指派之前每檔都是 Unrated＝1 倍 |
   | `liquidationPenaltyBps` | 0–5000 | 清算時沒收進保險金的比例（合約預設 2000） |
   | `markPremiumCapBps` | 0–200 | mark 價相對 index 的溢價上限（0＝mark 等於 index，平台現況） |
   | `vaultFeeShareBps` | 0–10000 | 交易費撥進租戶保險金的比例（0＝不撥） |
   | `deployVault` | `true`／`false` | 要不要部署代幣化資產金庫（`AssetVaultV2` proxy＋每檔資產一顆代幣）。需要 `oracleKind: "guarded"` |
   | `vaultRedeemFeeBps` | 0–300 | 金庫贖回費（合約預設 30）。沒有金庫時必須是 `null` |
   | `vaultMinReserveRatioBps` | 10000–20000 | 鑄造所需的最低準備率（合約預設 11000＝110%）。沒有金庫時必須是 `null` |
   | `kycRegistry` | `allowlist`／`vc` | exchange 的 KYC 閘門（v4，沒有預設值）。`"allowlist"`：`KYCRegistry`，verifier 逐一核准地址（平台現況）。`"vc"`：`VCKycRegistry`（[`SSI_RWA_ACCESS.md`](SSI_RWA_ACCESS.md)），投資人提交受信任發證者簽的「合格投資人」憑證、鏈上驗 EIP-712 簽章，`requiredType` 固定 `QUALIFIED_INVESTOR`。兩種都由部署腳本建好並接上 exchange；`vc` 的登錄從建構子起 owner 就是 `roles.admin`（Ownable2Step，不需要接受步驟）。admin 指派 verifier／發證者之前，所有 RWA 市場對所有人關閉 |

   `executionFee`（0.0001 ETH）、exchange 與金庫的 `maxPriceAge`（6 小時）、oracle 自己的 `maxPriceAge`（0，
   理由見 ADR-008）是腳本常數，不是租戶設定；`VerifyTenant` 一樣逐項讀回。

   哪些資產是 RWA（要 KYC）的**下限不是租戶設定**：由資產本身決定，腳本內建的分類與平台相同（測試釘住，
   8 檔：sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL、sICLN、sESGU、sBOND）。租戶只能用 `assets.additionalRwa`
   **追加**（見下一項），不能把內建的 RWA 改成不要 KYC。
6. `assets.registered` 是這個租戶要上架的資產，必須涵蓋前端 `assets.enabled`——前端不能開一檔沒註冊的資產。
   `assets.additionalRwa`（v4，必填，沒有追加就寫 `[]`）是租戶額外要 KYC 的資產：每一檔都必須在
   `registered` 裡、不能重複、不能是內建 RWA（清單只能加）。例如把 `sGOLD` 也納入合格投資人限制。
   部署當下就寫上 exchange 的 RWA 旗標，OI 上限也用 `oiCapRwaUsdc`；`VerifyTenant` 每天讀回，與設定不符就失敗。
   ⚠️ **前端尚未接上 `kycRegistry: "vc"` 的租戶與 `assets.additionalRwa`**：交易終端的「去做 KYC」仍開舊的白名單
   流程、RWA 標示仍用內建分類。這兩項由 RWA PoC 計劃表的 S5（前端接新部署）處理，在那之前 VC 租戶只能用
   投資人憑證面板與鏈上工具操作。
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

- 前提（(a) 的 `PREFLIGHT_ONLY` 也一樣）：`--sender` 的部署者位址要持有 **1 顆完整的保證金代幣**（目前的結算代幣
  MockUSDC 是 18 位小數，即 `1e18` 個最小單位；腳本依代幣的 `decimals()` 計算）作為保險金庫種子，以及付 gas 的 ETH。
  餘額不足時 preflight 直接拒絕（`deployer holds less than one whole settlement token …`）。
- `--sender` 是部署者的**位址**，不是金鑰。模擬不需要任何私鑰。
- exchange 部署出來的第一件事是 owner `pause()`（沒有到期時間），KYC、RWA 旗標、上限都設好之後、移交所有權之前
  才 `unpause()`。廣播是很多筆交易，中途被打斷時留下的是一顆暫停中的 exchange，不是一顆半設定、可以開倉的。
  `unpause()` 會啟動合約的 30 分鐘清算寬限期：**部署完成後 30 分鐘內不能開倉**（也不會清算），這是預期行為。
- 成功的模擬最後會印出一長串 `ok`（就是 `VerifyTenant` 的全部斷言）、一份 `mode: dry-run` 的部署紀錄、
  以及 forge 的 `SIMULATION COMPLETE`。紀錄寫到 `contracts/cache/tenants/<id>.dry-run.json`（git-ignored）。
  **dry-run 的位址是模擬出來的**，不要複製到任何地方。
- preflight 會拒絕的常見情況：價格來源超過 1 小時沒更新（先讓平台的 keeper 跑一輪）、admin 沒有 code、
  部署者等於某個角色、`status` 不是 `ready`、`network.chainId` 與連上的鏈不同。
- 腳本讀的是 `deploy/tenants/<id>.json`，**不讀環境變數裡的位址**。`foundry.toml` 的 `fs_permissions` 只允許
  讀 `deploy/tenants/`、只允許寫 `contracts/cache/tenants/`。

2026-10-01 在本機 anvil fork（Base Sepolia）的實測：143 筆交易、約 4,490 萬 gas；以當時的 0.0033 gwei 計約 0.00015 ETH。
2026-10-02（PR #228 審查修正後，schema v3、含參考來源與限速）在本機 anvil fork（Base Sepolia 區塊 47,569,483）
只做模擬、不送任何交易：`DeployTenant` 內建的讀回驗證與獨立的 `VerifyTenant.run()`（讀同一份模擬狀態與
`cache/tenants/<id>.dry-run.json`）全部 `ok`（後者 95 項）；約 4,620 萬 gas。有參考來源與 `"none"` 兩種都跑過，
後者印出「無參考來源」的 NOTE。
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

前提：§3 的模擬通過；部署者位址有足夠的 ETH，**以及 1 顆完整的結算代幣**（保險金庫種子，見下）；平台的 keeper 剛跑過（價格來源夠新）。

```bash
cd contracts
TENANT=<id> forge script script/DeployTenant.s.sol:DeployTenant \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$<部署者金鑰的環境變數>" --broadcast --slow -vv
```

- 一定要加 `--slow`：後面的交易依賴前面剛部署的合約，公共 RPC 一次收到整批容易丟交易。
- **保險金庫種子**：第 3 步建出租戶的 InsuranceVault 後，立刻從部署者存入 1 顆完整結算代幣，份額轉給 `roles.treasury`，
  然後才接 fee router 與 exchange。供給為 0 時流進來的錢永遠歸虛擬份額（`INSURANCE_VAULT_SHARES.md` §3.3），種子先關掉
  這個洞。preflight 會擋餘額不足的部署者。
  存入與轉份額由一顆無狀態、無 owner、不持有任何權限的 `InsuranceSeeder`（`contracts/src/InsuranceSeeder.sol`）
  **在同一筆交易**完成：部署者 approve seeder，seeder 拉入 1 顆、`deposit`、把這次實際鑄出的份額全數轉給 treasury，
  自己不留份額、不留代幣（事先被轉入的份額一併給 treasury，代幣退回呼叫者，所以捐贈擋不住種子）。
  若分成 approve／deposit／transfer 三筆交易、轉帳份額在模擬時寫死，任何人在兩筆之間存 1 wei 再提走一部分改變
  份額價格，寫死的 transfer 就在鏈上 revert，`--resume` 重送也一樣（#256 審查）。seeder 鏈上的下限是**價值**：
  鑄出的份額要能贖回至少 99.9% 的種子。不用份額數下限，因為份額價格能被幾 wei 推高、讓份額數下限每次重試都不過，
  而種子的價值不受影響（金庫捨入對自己有利，攻擊者留下的資產歸持有人）。seeder 位址記在部署紀錄的
  `contracts.InsuranceSeeder`，`VerifyTenant` 把它當成這組合約的一員：code 等於本 repo 的 build、由部署者建立、
  不持有任何角色（權限事件掃描到它持有角色就失敗，不當成 admin 的指派）。
  **只在存入當下成立的事在 DeployTenant 裡檢查**：部署者沒有份額、seeder 什麼都不留、treasury 持有全部份額、
  而且值滿 1 顆。這些 `require` **只在模擬時執行**（forge 先在本地跑完整個 script 才送交易），任何一項不符就不會廣播；
  鏈上的保證來自 seeder 合約自己的 `require`。
  之後每天跑、對每個 PR 跑的 `VerifyTenant` 只檢查 `totalSupply() > 0`（§3.3 的保護仍在）——任何人都能存 1 wei
  再把份額轉給部署者，bailout 也會讓份額貶值，這些都不是租戶設定錯，不能讓 required check 變紅。
  treasury 把份額轉走或贖回是租戶自己的決定，只印 NOTE；但若供給因此回到 0，驗證會失敗（那會重新打開 §3.3 的洞）。
- 這次執行**不碰任何既有合約**，沒有不可逆的步驟，也沒有需要「續跑」的共用指標。中途失敗時留下的是一組
  owner 還是部署者的未完成合約（過了第 3 步則保險金庫裡有那 1 顆種子，份額在 treasury）：用 `forge script … --resume` 接著送同一批，或直接重來一次（舊的那組作廢）。
- 部署的最後一步把所有權交給 `roles.admin`：`Ownable` 的合約 `transferOwnership`，`AccessControl` 的合約
  先授予、讀回確認、才放棄部署者的 admin。**結束時部署者在任何一顆合約上都沒有權限。** 一步到位的所有權轉移無法復原，
  而這時整組合約除了那 1 顆保險種子之外沒有任何資金——admin 填錯的代價是重新部署（加上那 1 顆），不是資產被鎖。
- 執行內建完整讀回驗證，任何一項不符整個 run 就 revert（不會留下「部署了但沒驗證」的狀態）。這也是模擬時的
  保證：廣播後的鏈上狀態以事後獨立跑的 `VerifyTenant` 為準。
- 紀錄寫到 `contracts/cache/tenants/<id>.deployed.json`，其中 `deployBlock` 是廣播開始前的區塊高度（`VerifyTenant`
  從這裡起掃角色授予事件）。
- 最後的 `exchange.unpause()` 以固定的 gas 上限（300,000）送出：模擬時所有步驟在同一個 timestamp，估出來的
  gas 不含寫入暫停時間的成本，真的廣播時會 out of gas，exchange 會停在暫停狀態（2026-10-02 本機 anvil 演練發現）。

廣播後，對真正的鏈再讀回一次（唯讀）。**上線當下這一次必須加 `TENANT_PRIVILEGE_SCAN_REQUIRED=true`**，
讓角色事件掃描不能被略過（見下面「角色持有者」的限制）：

```bash
TENANT=<id> TENANT_RECORD=cache/tenants/<id>.deployed.json TENANT_PRIVILEGE_SCAN_REQUIRED=true \
  forge script script/VerifyTenant.s.sol:VerifyTenant --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
```

它檢查（任何一項不符就失敗，訊息指出是哪一項）：

- 每顆合約有 code 且位址互不相同、也不是共用元件；exchange 的 owner／guardian／marketOperator／oracle／保險金／
  FeeRouter／KYC 接線；FeeRouter 的 treasury 是租戶的；`kycRegistry: "vc"` 時另讀 VC 登錄的 `pendingOwner` 必須是零、
  `requiredType` 必須是 `QUALIFIED_INVESTOR`、EIP-712 domain separator 必須對應本鏈與本位址；
- **風控參數與設定逐項相等**：每檔資產的 RWA 旗標（內建分類＋`assets.additionalRwa`）、OI 上限、獲利上限、槓桿上限、維持保證金覆寫（必須是 0）；
  ESG 的 `maxAttestationAge`（合約預設 180 天）；資產模式不是 Active、金庫的 unpriced exemption 生效時印 WARN；清算罰金、mark 溢價上限、
  保險金分成；兩個舊版費率仍是合約預設（接上 ESGRegistry 之後不生效，被改了代表有人動過）；
  exchange 與金庫的 `maxPriceAge`（6 小時）；金庫的贖回費與最低準備率；
- **oracle**：單次上限、時間窗長度與累計上限都非零且等於設定，自身 `maxPriceAge` 是 0，參考來源等於設定（而且不等於
  `priceSource`）；暫停分兩種：有到期時間的（guardian 的）只印 WARN，沒有到期時間的（owner／admin，或部署中斷留下的）
  判失敗，exchange 同一規則；資產凍結印出是 guardian（附到期時間）還是 admin（沒有到期、只有 admin 能解）；
  註冊資產在 oracle 上都有價格（過期或凍結只 WARN——那是 keeper 的狀態，不是接線）；
- **程式碼與編譯產物相同**（PR #228 複審 C2）：每一顆合約（oracle、ESGRegistryV2、KYC、保險金、FeeRouter、
  TraderStake、exchange 與它連結的 `ExchangeOpsLib`、StrategyRegistry、CopyTracker、AgentSessionManager、金庫 proxy
  與實作、每一顆 token）的鏈上 runtime code，與本 repo 的編譯產物（`out/`）長度相同、逐位元組相同。只遮蔽三種位置：
  immutable（依 `immutableReferences`；同一個 immutable 的每個位置必須是同一個值，值另由 getter 讀回驗證；沒有
  getter 的金庫 UUPS `__self` 與 token `assetId` 直接釘值）、library 位址（依 `linkReferences`；該位址的 code 再對
  library 的編譯產物比對）、結尾的 CBOR metadata（原始碼文字的雜湊，只改註解就會變；這一段不會被執行，不同時只印
  NOTE）。帶有多餘函式、改過一個 byte、換過 library 的合約都會失敗。限制：比對基準是執行當下這份 repo 的編譯
  產物——日後 `contracts/src` 改了程式碼，已部署的租戶會驗證失敗（要重新部署或另釘版本）；`foundry.toml` 沒有釘
  solc 版本，編譯器版本不同時是失敗，不是放行；
- **proxy**：每一顆合約都檢查 ERC-1967 的 implementation／admin／beacon 三個 slot。金庫 proxy 的 implementation
  等於紀錄裡的實作、admin 與 beacon 是零（UUPS）；其他合約三個 slot 都必須是零。admin 事後升級到別的實作就會失敗；
- **角色持有者等於預期集合**（PR #228 複審 C4）：合約不是 Enumerable，所以分兩輪。
  (1) 每次都跑：部署者、owner、所有租戶角色、共用元件與整組合約的每一顆，在每個有權限清單的合約上（DEFAULT_ADMIN、
  KEEPER、GUARDIAN、RISK、PAUSER、MINTER、ATTESTOR、exchange 的授權 agent、KYC verifier／VC 發證者）都必須「該有才有」。
  (2) 從紀錄的 `deployBlock` 起以 `eth_getLogs` 掃 `RoleGranted`、`AgentAuthorizationSet`、`VerifierSet`（`kycRegistry: "vc"`
  時改掃 `IssuerSet`）：凡是被授予過、
  現在仍持有的位址都必須在預期集合內（oracle：ADMIN＝owner、KEEPER＝keeper、GUARDIAN＝guardian；金庫：ADMIN＝owner、
  RISK＝risk、PAUSER＝guardian；token：ADMIN＝owner、MINTER＝金庫；ESG：ADMIN＝owner；exchange 的 agent 只能是
  sessionManager 與 copyTracker），不認得的角色也算失敗。ESG 的 ATTESTOR 與 KYC 的 verifier（或 VC 登錄的受信任發證者，
  以 `issuerTypeCount > 0` 判定）是上線後的營運任命：
  允許、印 NOTE，但不得是部署者或任何一顆租戶合約。**限制**：公開 RPC 一次只給 1,000 個區塊，掃描跨度超過
  `TENANT_PRIVILEGE_SCAN_MAX_BLOCKS`（預設 50,000，Base 約 28 小時）時第二輪印 NOTE 略過——之後每天的 CI 只剩第一輪，
  除非換用範圍更大的 RPC 並調高上限；所以上線當下必須以 `TENANT_PRIVILEGE_SCAN_REQUIRED=true` 跑一次（略過即失敗）。
  RPC 拒絕查詢一律失敗。admin 事後在 oracle 上新增、但不在設定裡的資產沒有偵測；
  第二輪在 CI 裡的覆蓋：單元測試的 harness 以 `vm.getRecordedLogs()` 取代它（沒有 RPC），所以真正的分段
  `eth_getLogs` 由 `scripts/tenant-privilege-scan.mjs`（`tenant-verify.yml` 的一步）在本機 anvil 上跑：廣播一個租戶、
  確認掃描有分段且成功；再讓 admin 把 oracle 的 KEEPER 給一個陌生位址——不讀歷史時驗證照樣通過，讀歷史時以
  `unexpected KEEPER_ROLE holder` 失敗；`SCAN_REQUIRED=true` 而跨度超過上限時拒絕；
- **最終歸屬**：Ownable 的 owner、AccessControl 的 admin、guardian／keeper／risk 角色各歸其位；owner 不是任何熱錢包；
  keeper／guardian／risk／marketOperator／treasury 在任何合約上都沒有 admin；
- **部署者是真的**：紀錄裡的 `deployer` 是自報的欄位，所以每一顆合約都必須是這個地址以它用過的某個 nonce
  `CREATE` 出來的（`computeCreateAddress`）。紀錄的 deployer 被改成別人時直接失敗；
- **部署者不留任何權限**：不是任何合約的 owner、guardian、marketOperator、授權 agent、KYC verifier，在任何
  AccessControl 合約上沒有任何角色。

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

   不要手打位址。產生的登記會帶 `"shared": ["contracts.SettlementToken"]`：結算幣是唯一與平台共用的位址，
   登記檔必須**顯式宣告**它，檢查器才放行，而且值必須就是平台在該鏈的結算幣。其餘任何欄位與平台或其他租戶相同
   都會紅燈——檢查器自動列舉登記裡的每一個位址欄位，不靠手寫清單。
   租戶另外部署了 x402 分潤路由的話，手動加一行 `contracts.X402FeeRouter`（唯一允許不在部署紀錄裡的欄位）。
   它只被檢查「不在平台位址全集、不與其他欄位重複」，`VerifyTenant` 不讀它（PR #228 複審 A5）：前端今天只在
   x402 說明頁顯示它，沒有資金流。前端日後若要用它付款，必須先補鏈上驗證（`insuranceVault`、`owner`、
   是否為 `DeployX402Router` 的產出）。
3. 檢查與建置：

   ```bash
   node scripts/check-tenant-deploy.mjs      # 部署紀錄只收 mode=broadcast；前端登記必須與紀錄逐欄位相同
   node scripts/check-addresses.mjs          # 不得出現平台位址全集或其他租戶的位址（顯式宣告共用的結算幣除外）
   node scripts/verify-dedicated-tenants.mjs # 對每個 dedicated 租戶以公開 RPC 的 fork 跑 VerifyTenant
   cd frontend && VITE_TENANT=<id> VITE_SIGNAL_API_URL=<租戶的 signal-api> yarn build
   ```

   檔案層的檢查只擋得到「已知的位址」；所有權、綁定、參數要靠讀鏈。所以 CI 的 `tenant-verify.yml` 對每一個
   `dedicated` 登記跑 `VerifyTenant`（公開唯讀 RPC、不需要 secret、RPC 連不上就失敗）；
   它每天也排程跑一次——租戶 admin 事後改了鏈上參數而設定檔沒跟著改，那裡會紅。這些都是 CI 檢查，
   **只有在 repo 設定 branch protection／required checks 之後才會擋合併**；目前 master 沒有設定，這是
   擁有者的待辦，也是第一個專屬租戶上線的前置條件（`TENANT_OPERATIONS.md` §1.6 第 0 步）。
   專屬租戶的 build **必須**設 `VITE_SIGNAL_API_URL`，而且不能是平台的 signal-api（沒設就 build 失敗，
   不會悄悄退回平台的；`TENANT_OPERATIONS.md` §2）。
4. `contracts/broadcast/DeployTenant.s.sol/<chainId>/run-*.json` 是這次部署的機器可讀紀錄，照慣例進版控。
5. 接著做營運面：keeper 的 environment 與 workflow、signal-api、SDK——[`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md)。
   **keeper 第一次寫價成功之前不要對外開放前端。**
6. 租戶 admin 之後要做的事（都經過 multisig，不在部署腳本裡）：
   - 指派 KYC verifier（`KYCRegistry.setVerifier`），或 `kycRegistry: "vc"` 時信任發證者
     （`VCKycRegistry.setIssuer(issuer, keccak256("QUALIFIED_INVESTOR"), true)`）。在那之前所有 RWA 市場對所有人關閉。
   - 指派碳分級見證人（`ESGRegistryV2` 的 `ATTESTOR_ROLE`）。在那之前每檔資產都是 Unrated——槓桿 1 倍、費率最高那一級（fail-closed）。
     見證人寫入分級用 `contracts/script/AttestTenantCarbon.s.sol`（只做 attest；清單與平台的 `Deploy102CarbonRegistry`
     共用 `CarbonAttestations`；`ESG_REGISTRY`、`ATTEST_CHAIN_ID` 必填，先不加 `--broadcast` 模擬）。建議同時給
     `TENANT=<id>`（讀 `deploy/tenants/<id>.deployed.json`）或 `TENANT_RECORD=cache/tenants/<id>.deployed.json`：
     有給時紀錄的 `contracts.ESGRegistryV2` 與 `chainId` 必須等於 `ESG_REGISTRY` 與目前的鏈，否則什麼都不送
     （`foundry.toml` 的 `fs_permissions` 只允許讀 `deploy/tenants/` 與 `cache/tenants/`）。見證人若是租戶自己的金鑰，
     對外要照實說明分級是營運方自己的聲明，不是獨立機構。
   - 部署後的唯讀粗檢：`node scripts/post-deploy-smoke.mjs --tenant <id> --skip-http`（接線、外洩地址、價格新鮮度；
     租戶的 signal-api 上線後改用 `--signal-api <網址>`）。
   - 保險金：**部署腳本已自動存入 1 顆完整結算代幣作種子，份額交給租戶的 `roles.treasury`**（§4）；
     treasury 要把這份份額保留到金庫停用。1 顆只關掉 §3.3 的零供給問題，不是夠用的保險金：
     admin 視交易規模與風險自行加碼（`InsuranceVault.deposit` 取得份額，或 `recapitalize` 贈與、不發份額）。
     DeployTenant 部署完非 RWA 市場就能交易，沒有另外的「開放交易」步驟。
     P1-05 之後的 InsuranceVault 用 virtual shares：供給為 0 時進來的資產（手續費分成、清算殘值，或在沒有份額時呼叫 `recapitalize`）
     會永久歸 virtual 份額，之後按比例分走 LP 的收益。所以 `recapitalize` 只在已有種子份額之後使用（腳本存的種子已滿足這一點）。
     接線順序：腳本在第 3 步建出金庫後**先存種子**，第 4 步才在 exchange 上 `setFeeRouter`／`setInsuranceVault`，
     第 6 步才在金庫上 `setFeeRouter`／`setExchange`——任何流入來源都接在種子之後（[`INSURANCE_VAULT_SHARES.md`](INSURANCE_VAULT_SHARES.md) §3.3、§5.2）。
   - 金庫的每檔資產上限預設是 0（關閉鑄造），由 risk 金鑰逐檔開放，並 `fundVault` 注入兌付準備。
   - 若要把所有權放到 Timelock 後面，由 admin 自行部署並轉移；之後跑 `VerifyTenant` 要加 `EXPECTED_OWNER=<timelock>`
     （CI 的 `tenant-verify.yml` 目前以 `roles.admin` 為 owner；移到 Timelock 時要同步改設定或腳本）。
   - **沒有 Timelock 時，admin multisig 可以立即升級金庫**（`AssetVaultV2_5._authorizeUpgrade` 只要
     `DEFAULT_ADMIN_ROLE`）。租戶的使用者信任的是機構的 multisig，不是一段延遲；上線前要在服務條款寫清楚，
     或先補上租戶版的 Timelock 腳本（ADR-008 的待決事項）。

## 6. 已知缺口

- **收費模式待決**：base fee＋租戶 markup 的數字與收取方式（鏈上需要新版 FeeRouter）。在定案前沒有任何租戶能標成 `deployed`。
- **沒有任何專屬租戶真的廣播過**：腳本只在單元測試、Base Sepolia fork 測試與本機 anvil fork 上跑過。
- **前端只能連 Base Sepolia 的專屬部署**；Base 主網需要錢包切換、RPC、CSP、區塊瀏覽器連結的設定。
- **專屬租戶的前端沒有逐頁走查過**（沒有可瀏覽的專屬部署）。見 ADR 0009 增補的 Consequences。
- **ESGRegistryV2 只有「每租戶專屬」一種**；ADR-008 允許租戶明確選擇共用平台登錄的選項沒有實作。
- **keeper**：租戶 workflow 由範本產生（`node scripts/gen-tenant-keeper.mjs <id>`），但 keeper 程式在只有一顆 GuardedOracle 的租戶上沒有實跑過；租戶沒有健檢。見 `TENANT_OPERATIONS.md` §1。
- **主網**：平台在 Base 主網沒有共用元件，結算幣也還沒決定（原生 USDC 是 6 位小數，不能用）；設定檢查今天擋下所有主網設定。
- **時間窗限速是整顆 oracle 一組參數**：`GuardedOracle` 每檔資產各有自己的時間窗狀態，但長度與上限只有一組，所以設定檔也只有一組（改成每檔不同要改 `contracts/src`）。
- **agent 端（signal-api、MCP server、Telegram bot）讀的是平台的合約**，每租戶一個 Vercel 專案今天只能隔離收款。見 `TENANT_OPERATIONS.md` §2.2。
- **部署中斷沒有續跑機制**（刻意：不碰共用指標，重來的代價只有 gas）。
