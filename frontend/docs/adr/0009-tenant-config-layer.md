---
status: proposed
---

# 白標租戶設定：建置期選一份資料檔，只能收窄、不能放寬

平台定位是 B2B 白標：機構客戶用自己的品牌上架這套鏈上 CFD 與 agent 付費 API。前端原本只有一套品牌（PepeLab）、一套色票、一份全開的資產清單，品牌字串散在 logo、首頁、終端機標頭與 catalog 裡。要讓第二個機構上架，需要一層「租戶設定」把這些東西收斂到一個地方，並且保證正式站（default 租戶）完全不變。

決定如下。

1. **租戶是建置期選的**（`VITE_TENANT`，沒設 = `default`），跟 [ADR 0001](./0001-build-time-locale-selection.md) 的語系同一個模式：一個 build 一個租戶，沒有執行期切換。設定檔是 `src/tenant/tenants/<id>.json`，`vite.config.ts` 把 `@tenant-config` alias 到被選中的那一份，**bundle 裡只有這一份設定**——白標客戶彼此是競爭者，A 機構的站不該讓人從 JS 讀到 B 機構的上架資產與聯絡方式。
2. **設定是資料（JSON），每個欄位都驗證，失敗就 fail-closed。** `src/tenant/schema.ts` 用 zod strict schema：未知欄位直接拒絕（打錯字不會被靜悄悄忽略）。`vite.config.ts` 在 build／dev 啟動時驗證一次，app 載入時再驗證一次。`VITE_TENANT` 對不到檔案、檔案驗證不過、檔內 `id` 與選用名稱不同，都丟錯——**絕不退回 default**，因為退回的最壞情況是別家機構的網域掛著 PepeLab 的品牌、開著它沒授權的資產。這跟 `pickLocale` 認不出語系就退回預設是刻意相反的：語系錯最壞是語言不對。
3. **功能旗標 = 租戶上限 × 環境變數**：`有效值 = allowed && readFlag(env, default)`（`src/tenant/flags.ts`）。環境變數沒設用租戶預設；環境變數可以把功能關掉（緊急下架不必重審設定檔）；環境變數**打不開**租戶未授權（`allowed: false`）的功能。default 租戶五個旗標都是 `{ allowed: true, default: false }`，結果與改版前的 `readFlag(env, false)` 逐位元相同（測試逐一比對）。另外新增 `PERPETUALS_AUTHORIZED = features.showPerpetuals.allowed`：`SHOW_PERPETUALS` 只收入口、路徑仍到得了；未授權永續的租戶即使有人直接打 `/terminal`，下單面板也不送 `openPosition`，agent session 也不能建立。**平倉與撤銷 session 不看這個值。**
4. **資產白名單只能是 `addresses.ts` 已知資產的子集，用代號指定，設定檔沒有任何放地址的欄位。** `"all"` 代表全部（含日後新增的，default 租戶用這個）。白名單只管**進場**：終端機可選標的與 `openPosition`、`/tokens` 的買進、配置採用（有任何一檔不在白名單就整筆不送，不自動略過以免悄悄改掉發布者的比例）、agent session 可交易資產（濾完為空就不送——合約把空陣列當成「全部允許」）。**出場永遠不看白名單**：Portfolio 與終端機持倉表的平倉、`/tokens` 的贖回都不引用租戶政策；白名單外但有持倉的資產仍列在 `/tokens`，買進關閉、贖回照常。測試用原始碼掃描守住這一條（`src/tenant/assetPolicy.test.ts`）。

   **有白名單的租戶不得授權跟單。** Expert 跟單（`CopyTracker.followTrader`）在鏈上鏡射交易者的全部部位——合約沒有依資產過濾的參數，交易者之後開什麼、跟隨者就跟著開什麼，前端在送單當下也無從得知之後會鏡射哪些資產。它是白名單管不到的進場路徑，所以 schema 規定：`assets.enabled` 不是 `"all"` 時，`features.copyTrading.allowed` 必須是 `false`，否則設定驗證失敗、build 失敗。要讓有白名單的租戶開跟單，前提是合約支援逐資產過濾，那是合約變更，不是設定。
5. **揭露只能追加。** 租戶可以設定營運機構名稱與最多五條附加揭露，顯示在 `SyntheticDisclosure` 核心三條（測試網原型、合成且非足額抵押、非投資建議）之後；schema 沒有任何欄位能改動或拿掉核心揭露。
6. **品牌字串收斂成 catalog 佔位符。** catalog 裡指稱平台本身的地方寫成 `{brand}`、品牌小圖示寫成 `{brandMark}`，`src/locales/index.ts` 載入時用 `brandCatalog()` 一次代換，元件照舊 `t.x.y`。元件裡寫死的 logo 圖、logo 字樣、首頁大字與吉祥物圖、終端機標頭、`CONFIG.appName`、`index.html` 的標題／favicon／theme-color 改讀租戶設定。
7. **色票只開放 primary 與 secondary 兩組**，接到 `theme-config.ts`；租戶沒給就整組沿用原值。圖片只收站內路徑（CSP `img-src 'self'`，外部圖片在正式站會被擋），連結只收 `https:`（與 `mailto:` 由 email 欄位產生），品牌文字不可含 `{ } < >`。

## 收斂了哪些品牌字串、刻意留下哪些

| 收斂到租戶設定 | 刻意保留原樣 |
|---|---|
| `meta.title` / `description` / `descriptionNoCopy`、登入視窗說明、`/exchange` 教學標題、x402 說明頁兩句、側邊欄分組名、首頁標語與「進入 Dashboard」的 🐸 | GameFi 的「PepeLab 扭蛋」、PepeLab Rewards、Pepe 角色設定與蛙頭像（功能名稱，由旗標決定出不出現） |
| logo 圖與字樣、首頁大字與吉祥物、終端機標頭 `PEPELAB·TERMINAL` 與 🐸 | 合約與鏈上名稱：`PepeLabIncentives`、`PepeAMM`、EIP-712 domain `PepeLabAgentAuthorization`、`PEPE` 代幣 |
| `CONFIG.appName`、`index.html` favicon／theme-color | 開發用 Mock Wallet 文案（正式 build 不出現）、`pepefi:` 開頭的 storage key、路徑與檔名 |

## Considered options

**執行期選租戶（依網域或 query string 切換）。** 否決，理由與 ADR 0001 相同：catalog、nav 設定、錯誤表活在 module scope，執行期切換要全部改寫成 hook；而且會把所有租戶的設定打進同一個 bundle。

**租戶設定寫成 TypeScript 模組。** 否決：型別檢查擋得住打錯欄位，但擋不住「非工程人員交來的設定」——白標上線的設定常常來自客戶，它應該是一份會被驗證的資料，不是一段會被執行的程式。JSON 也讓 CI 能用零依賴的腳本交叉檢查部署設定（`scripts/check-tenant-deploy.mjs`）。

**環境變數完全覆寫租戶設定（維持現狀的語意）。** 否決：租戶被授權什麼是合約與法遵層面的決定，不該是部署面板上一個欄位就能打開的東西。

**租戶設定完全取代環境變數。** 否決：失去緊急關閉某功能的開關，每次下架都要改設定檔、重審、重 build。

**白名單外的資產整列隱藏（包括有持倉的）。** 否決：等於用前端設定把使用者的錢鎖在看不到的地方，與 Reserve Ratio 不擋贖回、旗標不擋既有跟單取消是同一個原則。

## Consequences

- 白名單與授權檢查是**顯示層與送單前**的政策，不是安全邊界：合約不知道有租戶，任何人都能繞過前端直接呼叫合約。真正的隔離是每個租戶一套合約，見根目錄 [ADR-008](../../../docs/ADR-008-tenant-isolation.md)。
- 驗證錯誤訊息是英文：`src/` 底下的中文字串會被 `locales.test.ts` 的 ratchet 當成漏搬的顯示字串，而這些是給部署者看的建置錯誤。
- 已知未收斂：約 47 處寫死的品牌綠 `rgba(124,193,74,…)` 光暈、終端機自己的 `terminal-theme` 色票，示範租戶上仍是綠色光暈。改成 CSS 變數是下一步，不影響 default 租戶。
- `public/tenants/<id>/` 的圖檔會出現在每一個租戶的 build 產物裡（Vite 整個複製 `public/`）。logo 本來就是公開的，設定檔（上架資產、聯絡方式）不會；若之後有不能外流的素材，要改成建置期只複製被選中租戶的目錄。
- 新增租戶 = 新增一份 JSON（加 `public/tenants/<id>/` 素材，以及部署登記 `src/contracts/deployments/<id>.json`——見文末增補），不需改程式；`frontend-ci.yml` 會 build 示範租戶，`src/tenant/schema.test.ts` 會驗證所有租戶檔。
- agent 端（signal-api、MCP server、Telegram bot）還沒有租戶概念，回應內容與收款地址仍是單一平台的。部署層的隔離見 ADR-008。

## 增補（2026-10-01）：依租戶切換合約位址——部署登記，沒有登記就 fail-closed

上面第 4 點與 Consequences 寫的「設定檔沒有任何放地址的欄位」不變。這份增補決定的是：**專屬租戶的站要連它自己的合約**（根目錄 [ADR-008](../../../docs/ADR-008-tenant-isolation.md) 階段 2），那些位址從哪裡來。

### 決定

1. **位址來自 checked-in 的部署登記，不來自租戶設定檔。** 每個租戶一份 `src/contracts/deployments/<id>.json`，與租戶設定同名。`vite.config.ts` 把 `@tenant-deployment` alias 到被選中的那一份（`vitest.config.ts` 固定指向 `default.json`），驗證在 `src/contracts/tenantDeployment.ts`（zod strict，未知欄位拒絕）。租戶設定檔是「客戶交來的資料」，部署登記是「工程端由部署紀錄產生、經過審查與 CI 對帳的資料」；兩者分開，客戶交來的設定就沒有任何辦法把使用者導向任意合約。
2. **登記有兩種，都是明確宣告。**
   - `kind: "platform"`：這個租戶跑在平台的現行部署上（`addresses.ts`）。`default` 是這一種；示範租戶 `demo-bank` 也是，而且 default 以外的租戶必須寫 `note` 說明理由——它與平台共用資金、保險金與暫停鍵，只適合示範。
   - `kind: "dedicated"`：租戶自己的整組合約（`DeployTenant.s.sol` 的產出）。內容由 `node scripts/check-tenant-deploy.mjs --print-frontend deploy/tenants/<id>.deployed.json` 產生，不手打。
3. **被選中的租戶沒有登記檔，build 就失敗（fail-closed），不退回 default 部署。** 見下方「為什麼不退回」。
4. **default 租戶的行為逐位元不變。** `addresses.ts` 一個字都沒動（agent 端直接 import 它，signal-api 的 bundle 指紋也涵蓋它）。`platform` 的每個 getter 直接轉呼叫 `addresses.ts` 的原函式，回傳同一個物件；`tenantDeployment.test.ts` 以 `toBe` 逐一比對，並用快照釘住 default build 會連的每一個位址（三條鏈的位址表、V2 stack、V1 代幣、AgentSessionManager、x402 路由、舊合約表）。
5. **依租戶而不同的位址只能從 `src/contracts/deployment` 拿。** `getAddresses`、`getV2Stack`、`hasV2Stack`、`getSynthTokens`、`chainMap`、`x402FeeRouter`、`legacyExchangesFor` 都從那裡 import；AgentSessionManager 照舊走 `sessionManager.ts`（它會看登記）。`src/contracts/` 以外的檔案直接從 `addresses.ts` 拿這些 getter 或表，測試（原始碼掃描）會失敗。與租戶無關的東西（`ASSET_IDS`、`CHAIN_NAMES`、`PRIMARY_CHAIN_ID`、型別）照舊從 `addresses.ts` 拿。
6. **專屬部署只認得它自己的那條鏈。** 換到其他鏈（平台的 Sepolia、本機 Anvil）一律是「不支援的網路」，不會落到平台在那條鏈的合約。目前前端只支援 Base Sepolia（84532）的專屬部署：錢包切換、RPC、CSP、區塊瀏覽器連結都只為它設定過，登記主網部署會讓 build 失敗。
7. **專屬部署沒有的合約是零位址，不是平台的位址。** V1 金庫與代幣、PEPE 系列、swap router 都不屬於專屬部署；既有的「未部署」守衛處理零位址。因此專屬租戶**不得授權** `gamefi` 與 `pepeRewards`（`deploymentFeatureProblems`，build 期檢查），否則頁面會對零位址發請求。
8. **`/legacy` 的舊合約表只屬於平台部署。** 專屬部署的 `legacyExchangesFor` 一律回空陣列——那些是平台歷次重部署留下的 exchange，租戶的使用者從來沒有在上面存過錢。
9. **租戶隔離在三個地方檢查，任何一處不過都不會出貨。**

   | 時機 | 位置 | 檢查 |
   |---|---|---|
   | build | `vite.config.ts` → `loadTenantDeploymentForBuild` | 登記檔存在、格式、`tenant` 與選用的租戶相同、同租戶位址不重複、除結算幣外不得出現平台部署的任何位址、授權的功能有對應合約 |
   | app 載入 | `selectedDeployment.ts`、`sessionManager.ts` | 格式與隔離再驗一次（這裡多比對平台的 AgentSessionManager）；不過就丟錯讓 app 起不來 |
   | CI | `scripts/check-addresses.mjs`、`scripts/check-tenant-deploy.mjs`（`consistency.yml`） | 上述全部，加上：兩個租戶之間不得共用合約、每個前端租戶都有登記檔、已部署的租戶前端必須是 `dedicated` 且與部署紀錄逐欄位相同、尚未部署的租戶不得先登記成 `dedicated` |

### 為什麼不退回 default 部署

兩個選項的最壞情況不對稱。

| | 退回 default 部署 | fail-closed（採用） |
|---|---|---|
| 忘了加登記檔時 | 站照常上線，品牌是 A 機構的，使用者的保證金卻進了平台共用的 exchange 與保險金；A 的 guardian 暫停鍵對它沒有作用。**沒有任何錯誤訊息**，要等對帳或事故才會發現 | build 失敗，訊息指出缺哪個檔案 |
| 示範租戶（只換品牌） | 不必做任何事 | 要寫一份四行的 `kind: "platform"` 登記檔，並說明理由 |

退回的代價是 ADR-008 整個隔離模型可以被一次疏漏靜悄悄地繞過；fail-closed 的代價是示範租戶多一個檔案。與本 ADR 第 2 點（租戶設定驗證不過就 fail-closed、絕不退回 default）是同一個理由。

### Considered options（增補）

**一個以租戶 id 為鍵的 `tenantDeployments.ts`，所有租戶的位址放在同一個物件。** 否決：每個租戶的 bundle 都會帶著全部租戶的 id 與合約位址。位址本來就在鏈上公開，但「平台有哪些機構客戶、各自哪一組合約」不是；這與第 1 點「bundle 裡只有被選中的那一份設定」是同一個考量。JSON 一租戶一檔也讓零依賴的 CI 腳本可以直接讀，不必解析 TypeScript。

**把位址放進租戶設定檔。** 否決，理由已在第 4 點：設定檔常常來自客戶，它不該有能力決定錢往哪裡去。

**直接改 `addresses.ts`，讓它依租戶回傳不同位址。** 否決：`addresses.ts` 被 agent 端 import、被 signal-api 的 Vercel bundle 內聯（改它就要重新打包），也是 `check-addresses.mjs` 解析的對象。讓它保持「平台部署的純資料」，租戶邏輯放在它外面。

### Consequences（增補）

- 新增專屬租戶的前端步驟：部署紀錄進 `deploy/tenants/` → `--print-frontend` 產生登記檔 → `VITE_TENANT=<id> yarn build`。見 [`docs/TENANT_DEPLOYMENT.md`](../../../docs/TENANT_DEPLOYMENT.md)。
- 專屬租戶的 bundle 仍然含有平台部署的位址：隔離檢查要拿它們來比對，而 `addresses.ts` 是整份 import 的。它們不會被用來建立任何合約物件（`resolveDeployment` 的 dedicated 分支不讀 `CHAIN_MAP`），只是資料。若日後要連這份資料也拿掉，需要把平台位址集合改成建置期產生的雜湊清單。
- `chainLogs.ts` 的 `DEPLOY_BLOCK_BY_CHAIN` 還是依鏈、不依租戶：專屬租戶掃事件會從平台的部署區塊開始，結果正確但比較慢。要改的話在登記檔加 `deployBlock`。
- 專屬租戶的頁面行為沒有在真的專屬部署上逐頁點過——目前沒有任何已廣播的專屬租戶。build（以本機 fork 的模擬部署紀錄建一個暫時租戶）與單元測試都過，但「每一頁對零位址的守衛都正確」只有 default 與 Anvil 的既有覆蓋。第一個試點租戶上線前要做一次逐頁走查。
- x402 分潤路由（官方 USDC 的 FeeRouter）不在 `DeployTenant.s.sol` 的產出裡；租戶另外部署後，把位址手動加進登記檔的 `contracts.X402FeeRouter`（CI 允許這一個欄位不在部署紀錄裡，但仍檢查它不是平台的那一顆）。
