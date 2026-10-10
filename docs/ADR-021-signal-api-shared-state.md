---
status: proposed
date: 2026-10-10
---

# signal-api 的跨實例狀態：撤銷驗證端狀態改存 Upstash（compare-and-set），沒有分潤結算目標的部署不入列

> 起因是 [`docs/tenants/rwa-poc/ONLINE.md`](tenants/rwa-poc/ONLINE.md) 列的兩項已知限制（2026-10-09 線上版上線時）。
> 撤銷機制本身見 [`ADR-016`](ADR-016-vc-credential-status.md)；租戶隔離見 [`ADR-008`](ADR-008-tenant-isolation.md) 與
> [`TENANT_OPERATIONS.md`](TENANT_OPERATIONS.md) §2。本次**沒有部署任何合約、沒有送任何交易、沒有改任何雲端設定**。

## 1. 背景

1. **撤銷驗證端狀態是每個 Vercel 實例各自一份。** signal-api 的 KYA 閘門以 ADR-016 的預設檢查器查撤銷，驗證端狀態
   （每個簽發者接受過的最高 sequence、看過的所有撤銷、同號異文偵測）存在 `VC_STATUS_STATE_PATH`（線上是 `/tmp`）。
   signal-api 從來沒有呼叫 `setVcStatusStateStore`，所以防回滾與 sticky 撤銷只在同一個暖實例內成立：冷啟動的實例會接受
   任何仍在 `validUntil` 內、簽章正確的舊清單（例如 CDN 還在快取的舊版），已撤銷的憑證在那個實例上「復活」。
2. **`settled:true` 只代表「已排入佇列」，而租戶的佇列沒有人處理。** Upstash 一設，`isLedgerEnabled()` 就成立：付費
   `/signals` 把分潤推進**租戶自己那個 DB** 的 `x402:settlement:queue` 並回 `settled:true`。結算 worker
   （`x402-settlement-worker.yml`）只讀平台的 DB，所以這些列永遠不會上鏈，回應卻宣稱已排入結算。

## 2. 決定一：撤銷驗證端狀態存 Upstash（`signal-api/src/vcStatusStore.ts`）

### 2.1 做法

- `StatusStateStore` 的 `get`／`accept` 改成可以回傳 Promise（檔案、記憶體版仍是同步；檢查器與 `issuer/investorVc.ts` 一律 `await`）。
- 新增 `upstashVcStatusStateStore()`：每個 `${verifyingContract}|${issuer}` 兩個 key，
  `vc:status:ver:<key>`（版本號）與 `vc:status:state:<key>`（`IssuerStatusState` JSON）。
- `accept`＝**樂觀並行控制**：`MGET` 兩個 key（單一指令，一致的快照）→ 以 shared 匯出的 `mergeIssuerStatusState`
  合併（與檔案、記憶體版**同一個函式**）→ `EVAL` 腳本「版本號仍是剛才讀到的才寫入」。被別的實例搶先 → 重讀、重新合併，
  最多 8 次；用盡回 `STATUS_STATE_LOCK_FAILED`。
- signal-api 在 KYA 開啟時（`kyaFromEnv`）呼叫 `installVcStatusStateStore()`：有 `UPSTASH_REDIS_REST_URL／TOKEN`
  就注入 Upstash 版，否則維持單機檔案（本機開發、`rwa-poc-x402.sh server`）。`VC_STATUS_STATE_STORE=upstash|file`
  可強制；無法辨識的值印 `::error::` 後照預設。啟動 log 的 KYA 那一行會寫出用的是哪一種。

### 2.2 為什麼這樣就保證跨實例的防回滾與 sticky 撤銷

- **高水位只升不降**：寫入的前提是「讀到的版本號沒變」。過時的寫入者（讀到 seq 4、手上是 seq 5，期間別人寫了 seq 6）
  的 compare-and-set 一定失敗，重讀後合併規則回 `STATUS_LIST_REPLAYED`，不會把 seq 6 蓋回 seq 5。
- **撤銷是聯集**：後寫者一定是以先寫者寫完的狀態重新合併，`revoked` 取聯集、`revokedBefore` 取最大，誰先誰後都不會漏。
- **同號異文**：兩個實例同時拿到同 sequence、不同內容 → 先寫者贏，後寫者重讀後 `STATUS_LIST_EQUIVOCATION`。
- **冷實例**：檢查第一步就從共享狀態讀已知撤銷（來源掛掉也照樣拒絕）；來源送舊清單 → `REPLAYED`；來源說「沒有清單」
  但共享狀態接受過 → `STATUS_LIST_WITHHELD`。三者原本只在同一個實例內成立。
- **故障一律 fail-closed**：KV 連不上、JSON 壞掉、版本號與狀態缺一、寫入結果不明、`VC_STATUS_STATE_STORE=upstash`
  卻沒有 Upstash 設定 → `STATUS_STATE_*`，寫入類（KYA 付款）回 `503 kya_status_unverified`，不會悄悄退回單機。

### 2.3 考慮過、不採用

| 做法 | 為什麼不 |
|---|---|
| 在 Lua 裡做整個合併（`cjson` 解 JSON 或 HASH＋SET 逐欄比較） | 合併規則會有 JS 與 Lua 兩份；離線測試只能測假 Upstash 裡的 JS 模擬，真正跑的 Lua 沒有被測到。compare-and-set 把 Lua 縮到「字串比較＋兩個 SET」，規則只在 JS 一處、與檔案版共用 |
| compare-and-set 比對整份 JSON | 清單最多 1000 筆 jti，每次寫入要把新舊兩份（各約 70 KB）一起送；版本號只要幾個位元組 |
| 版本號用內容雜湊 | 遞增整數一樣能防 ABA（sequence 本身單調），而且不必在 Lua 裡算雜湊 |
| 設 TTL | 刪掉狀態＝忘記高水位與 sticky 撤銷（ADR-016 §7）。key 數量的上界是「在 `VC_STATUS_URL` 發佈過清單的簽發者數」，清單來源由營運方控管，請求方無法憑空製造 key |

代價：KYA 開啟時，每次付費請求的撤銷檢查多 2 次 Upstash 往返（第一步讀已知撤銷、最後讀合併後狀態）；快取過期時再多
2 次（`MGET`＋`EVAL`）。同區域每次約 5–20 ms，與 KYA 本來就有的防重放、花費預留同一個量級。

### 2.4 KYA 花費帳與 VP 防重放：不用改

`kyaFromEnv` 早就是「`X402_KYA_SPEND_STORE` 不設＝Upstash」，線上版已經在用（ONLINE.md 驗收紀錄的
`X-Agent-KYA-Spend: total=10000` 寫在 Upstash）。`docs/tenants/rwa-poc/README.md` 的「花費帳在記憶體」只描述本機
`rwa-poc-x402.sh server`（它刻意清空 `UPSTASH_*`、設 `X402_KYA_SPEND_STORE=memory`）。

## 3. 決定二：沒有分潤結算目標的部署不入列（`X402_SETTLEMENT_MODE=off`）

### 3.1 rwa-poc 有沒有自己的結算目標：沒有

| 事實 | 出處 |
|---|---|
| 租戶的 `FeeRouter`（`0x622a…65df`）是交易手續費用的那一顆，綁的是 MockUSDC（`shared.settlementToken`）；x402 收的是 Circle 的 Base Sepolia USDC（`0x036C…CF7e`）。分潤要用綁官方 USDC 的 x402 FeeRouter（`DeployX402Router.s.sol`），租戶沒有部署 | `deploy/tenants/rwa-poc.json`、`DEPLOYMENT.md`、`X402_KYA.md` §1、`TENANT_OPERATIONS.md` §2.1 |
| 租戶收費模式 0／0（「測試網 PoC 不收租戶費」） | `deploy/tenants/rwa-poc.json` 的 `fees` |
| 線上版刻意不設 `X402_FEE_ROUTER`、`FEE_SETTLEMENT_PRIVATE_KEY`、`ORACLE_BENEFICIARY_ADDRESS` | ONLINE.md |
| `/signals` 的 trader 與資料都來自**平台**的 StrategyRegistry（signal-api 的讀取位址編進 bundle） | `X402_KYA.md` §1、`TENANT_OPERATIONS.md` §2.2 |
| 租戶結算 worker 目前不支援；上線前要先做範本＋檢查器、守門類別、改名的 secret，而且要先部署租戶的 x402 FeeRouter（鏈上交易） | `TENANT_OPERATIONS.md` §2.1 |

所以「做一支租戶結算 worker」在今天沒有對象可以結算：沒有 x402 FeeRouter、沒有結算金鑰、受益 trader 是平台的、租戶也不收費。
**決定：不做租戶 worker；讓沒有結算目標的部署停止入列、停止回報 `settled:true`。**

### 3.2 做法

`X402_SETTLEMENT_MODE`（`signal-api/src/settlementMode.ts`）：

| 值 | 行為 |
|---|---|
| `queue`（預設） | 與以前逐位元相同：入列，`settled:true`＝已排入結算佇列（平台） |
| `off` | 不入列、不記 v2「結算結果不明」的對帳列（只寫 log；那些列只用來補分潤），付費回應 `settled:false`，`settleError` 以 `revenue_sharing_off：` 開頭說明款項已直接付到 `payTo`、不會有分潤上鏈；`GET /` 的 `revenueModel` 只描述實際發生的那一筆 |
| 其他 | 印 `::error::`，照 `queue` |

預設是 `queue` 而不是「沒設 `X402_FEE_ROUTER` 就 off」：signal-api 端看不出平台的 Vercel 專案有沒有設 `X402_FEE_ROUTER`
（worker 用的是 GitHub repository variable；signal-api 的 `settlementRouterAddress()` 沒設時會退回 MockUSDC FeeRouter），
自動判斷一旦誤判，平台就會**靜默丟掉已收款的分潤列**。打錯字時照 `queue` 也是同一個理由：多一筆沒人處理的列可以事後清掉，
丟掉的列找不回來。代價是租戶必須自己把 `off` 設上（§5）。

回應形狀不變（仍是 `ok`／`settled`／`settleError`／`data`），SDK、OpenAPI 的欄位與必填集合不必改，只補了說明文字。

## 4. 沒做的事

- 租戶結算 worker（等租戶有自己的 x402 FeeRouter 與收費模式，照 `TENANT_OPERATIONS.md` §2.1 的三個前置做）。
- signal-api 讀租戶合約（`TENANT_OPERATIONS.md` §2.2）：`/oracle`、`/signals` 的資料仍是平台的。
- 撤銷清單主機的信任假設（ADR-016 §7.1）不受影響：共享狀態只讓「看過」跨實例成立，從沒有任何實例看過的簽發者仍由主機回答。

## 5. 擁有者要做的

只改 Vercel 專案 `pepelab-rwa-poc-signal-api` 的 Production 環境變數，然後照 ONLINE.md 的 CLI 方式重新部署：

1. 新增 `X402_SETTLEMENT_MODE=off`。
2. 不需要新增任何東西就會啟用共享撤銷狀態（已經有 `UPSTASH_REDIS_REST_URL／TOKEN`）。`VC_STATUS_STATE_PATH` 之後不再使用，可留可刪。
3. 部署後看 Vercel log：KYA 那一行應寫「撤銷驗證端狀態 upstash（跨實例共用）」，`[vc-status]` 那一行應寫「共享儲存（upstash）」。
4. （選做）清掉租戶 DB 裡已經入列、永遠不會被處理的列：`x402:settlement:queue`（以及若有的 `x402:settlement:authz:*`）。

平台的 signal-api 不需要任何動作：`X402_SETTLEMENT_MODE` 不設＝`queue`，行為不變；撤銷共享狀態只在 KYA 開啟時注入
（KYA 預設關閉；若之後開啟，有 Upstash 就自動跨實例共用，正是想要的行為）。

## 6. 驗證紀錄（2026-10-10，本機 Windows／Node 25）

- `signal-api/src/vcStatusStore.test.ts`：8 組。合併規則、四種並行交錯（以可暫停的指令傳輸固定讀寫順序：過時寫入者、
  後寫者重新合併、同一份清單只寫一次、同號異文競爭）、競爭不斷 → `LOCK_FAILED`、六種故障 fail-closed、檢查器跨實例
  （真的簽章清單：冷實例拒舊清單、已知撤銷跨實例、被扣住偵測）、依環境變數注入。另做一次突變檢查：把假 Upstash 的
  compare-and-set 改成無條件寫入，並行段落立即失敗。
- `signal-api/src/settlementMode.test.ts`：4 組。解析、`applyLedgerRecording`（v1／v2）、v2 結果不明的對帳列、
  真的 `createApp`＋假 facilitator 的 v1 付費流程與 `GET /`。
- `npm run typecheck`、`npm run bundle:check`（bundle 已重打、指紋一起 commit）、各測試套件見 PR 說明。
