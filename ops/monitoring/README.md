# 鏈上監控 Worker（`pepelab-chain-monitor`）

每 5 分鐘對 Base Sepolia 做一輪**唯讀**檢查，條件成立時送 Telegram／Discord／webhook 告警。
為什麼選這個方案、不開 GitHub issue、與 OZ Monitor／SaaS 的比較：[`docs/ADR-009-monitoring.md`](../../docs/ADR-009-monitoring.md)。
規則清單：[`rules.md`](rules.md)。收到告警後怎麼做：[`docs/INCIDENT_RESPONSE.md` §10](../../docs/INCIDENT_RESPONSE.md#10-監控與告警)。

> 標 **【擁有者】** 的步驟需要你本人的帳號或決定，agent 不會代做（不建立外部帳號、不建立 token、不部署）。

## 檔案

| 檔案 | 用途 |
|---|---|
| `monitors.json` | 規則與參數的唯一真相。手寫欄位＋由 `node scripts/check-monitoring.mjs --write` 產生的欄位（位址、topic0、selector…） |
| `rules.md` | 由 `monitors.json` 渲染的人讀清單，**不要手改** |
| `deployed.json` | 以唯讀 RPC 抓下的已部署 runtime bytecode 與鏈上快照（釘在單一區塊）。CI 離線用它確認「規則監控的事件真的在部署版合約裡」；合約重新部署、升級或加規則後用 `node scripts/check-monitoring.mjs --refresh-deployed` 重抓 |
| `params.mjs` | 可調參數的型別、上下限與組合限制（CI 與 Worker 執行期共用的單一來源），以及環境變數的唯一存取點 |
| `engine.mjs` | 規則引擎：事件掃描、狀態檢查、HTTP 檢查、告警狀態機（觸發／持續／恢復） |
| `notify.mjs` | 通道與訊息格式 |
| `tick.mjs` | 一輪：KV 狀態 → 引擎 → 送通知（含 outbox 重送）→ 心跳 |
| `worker.mjs` | Cloudflare 入口（`scheduled`；HTTP 一律 404） |
| `keccak.mjs` | 零依賴 Keccak-256，只在產生／檢查設定時用 |
| `wrangler.toml` | Worker 設定；**只放公開設定**，秘密用 `wrangler secret put` |
| `monitor.test.mjs` | 引擎與通知的離線測試（假 RPC、假 KV、假通道） |

## 權限面與威脅模型

Worker 持有的東西只有：

| 憑證 | 放哪 | 外洩的最壞情況 |
|---|---|---|
| 告警通道（`TELEGRAM_BOT_TOKEN`＋`TELEGRAM_CHAT_ID`、`DISCORD_WEBHOOK_URL`、`ALERT_WEBHOOK_URL`＋`ALERT_WEBHOOK_SECRET`） | Worker secret | 有人往我們的頻道送假告警，或讀到告警內容（只含公開的鏈上資料）。撤換 bot token／webhook 即可 |
| `RPC_URL`（選用，付費 RPC 才需要） | Worker secret | RPC 額度被盜用 |
| `HEARTBEAT_URL`（強烈建議） | Worker secret | 有人替我們打心跳，掩蓋 Worker 停擺 |
| KV namespace `MONITOR_STATE` | Cloudflare 帳號內 | 被改寫可造成重複或漏掉的告警；只有帳號擁有者能寫 |

**沒有** GitHub token、**沒有**任何鏈上私鑰；不送交易、不開 issue。它與 `ops/keeper-trigger`（持有 Actions token）完全分開——keeper-trigger 的 token 外洩時能停用 keeper 與 `oracle-health.yml`，但碰不到這個 Worker。

通道憑證不會出現在 log：送失敗時只記通道名與 HTTP 狀態，例外訊息裡的 URL 一律遮蔽（`RPC_URL`／`HEARTBEAT_URL`／通道 URL 可能帶金鑰）。所有 URL 設定都必須是 `https://`。**一項設定格式不對時只停用那一項**（某個通道、心跳，或改用公開 RPC），其餘照常運作，並透過還能用的通道發不可靜音的 `monitor-self:config`（只寫名稱與原因，不帶值）；全部通道都不可用時這次 cron 記為失敗。每次對外請求都有逾時（RPC 15 秒；通知與 HTTP 檢查 10 秒），卡住的端點不會拖垮整輪。訊息以純文字送出（Telegram 不設 `parse_mode`；Discord 沒有純文字模式，所以跳脫 Markdown、`allowed_mentions` 為空、不展開連結預覽），鏈上或外部回應的文字不會被解讀成格式、遮罩連結或 @mention。

## 部署（依序）

1. **【擁有者】決定告警通道與接收者**（ADR-009「待使用者決定」1）。至少要一個通道，否則 Worker 每次 cron 都會失敗（刻意的：沒有通道時寧可大聲失敗）。
2. **【擁有者】建立通道**（需要你本人的帳號）：
   - Telegram：用 @BotFather 建 bot 取得 bot token；把 bot 加進接收群組，取得 chat id。
   - Discord：頻道設定 → 整合 → Webhook → 複製 URL。
   - email：用你選定的轉寄服務建立一個接收 HTTPS POST 的端點（JSON body，含 `id`、`severity`、`status`、`ruleId`、`key`、`title`、`text`、`occurredAt`、`firstAt`、`sentAt`）。設定 `ALERT_WEBHOOK_SECRET` 時，請求帶 `X-Pepelab-Timestamp: <unix 秒>` 與 `X-Pepelab-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<body>")>`。接收端要：
     1. 對**收到的原始 body bytes** 驗簽（不要先 JSON.parse 再序列化——鍵的順序或空白一變，簽章就對不上，或被迫放寬比對）；
     2. 用**常數時間比較**（例如 Node 的 `crypto.timingSafeEqual`）比對簽章，不要用 `===`；
     3. **拒絕時間差超過 5 分鐘**的請求；
     4. 以 body 的 `id` **去重**：通知是 at-least-once（逾時但對方其實收到了，下一輪會重送；5 分鐘內也可能被重放），同一則通知的 `id` 不論重送幾次都相同。
     `occurredAt` 是這則通知描述的事發生的時間（事件是區塊時間），`firstAt` 是首次發生（狀態型告警開啟的時間）。訊息內文也帶「時間：…（首次 …）」。
3. **【擁有者】確認門檻**（ADR-009「待使用者決定」2）：編輯 `monitors.json` 的 `params.*.default`，執行
   ```bash
   node scripts/check-monitoring.mjs --write   # 重新產生 monitors.json 產生欄位與 rules.md
   node scripts/check-monitoring.mjs           # 應回「一致 ✓」
   node --test ops/monitoring/monitor.test.mjs
   ```
   走 PR 合併。只想在 Worker 端覆寫而不改 repo，也可以在 `wrangler.toml` 的 `[vars]` 加同名鍵（CI 只允許已知參數名）。
4. **【擁有者】登入 Cloudflare 並建立 KV**：
   ```bash
   cd ops/monitoring
   npx wrangler login
   npx wrangler kv namespace create MONITOR_STATE
   ```
   把回傳的 `id` 填進 `wrangler.toml` 的 `[[kv_namespaces]]`，取代 `<KV_NAMESPACE_ID>`（id 不是秘密，可以 commit）。
5. **【擁有者】設定秘密**（只設你選用的通道）：
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put DISCORD_WEBHOOK_URL
   npx wrangler secret put ALERT_WEBHOOK_URL
   npx wrangler secret put ALERT_WEBHOOK_SECRET
   npx wrangler secret put RPC_URL          # 選用：付費 RPC；不設則用 monitors.json 的公開 RPC
   npx wrangler secret put HEARTBEAT_URL    # 強烈建議：外部 dead-man's switch——「Worker 自己壞了」唯一的外部訊號
   ```
6. **【擁有者】填公開設定**（`wrangler.toml` 的 `[vars]`，ADR-009「待使用者決定」3）：
   - **`EXPECTED_PAY_TO`（必填）**：signal-api Vercel 環境變數 `PAY_TO` 的值（公開地址）。不設時以第一次觀察到的 `payTo` 為基準——那麼「payTo 被改＋KV 基準被清」只會留下一則「基準已設定」（SEV-2、不可靜音），收款地址變更的 SEV-1 下一輪就恢復了。**請先換掉目前已知不安全的 x402 treasury（見 `frontend/src/contracts/x402.ts`），再把新地址填在這裡**；目前的首次觀察值就是那個不安全的地址。
   - `EXTRA_GAS_WALLETS`：x402 結算錢包等其他需要 gas 的地址，逗號分隔。keeper 錢包不用填（執行期讀 `MockOracle.owner()`）。
7. **【擁有者】部署**：
   ```bash
   npx wrangler deploy
   ```
8. **驗證**：
   - Cloudflare → Workers → `pepelab-chain-monitor` → Logs：每 5 分鐘一行 `tick: findings=… notes=… sent=… pending=0 errors=0`。
   - **送一則測試告警**：在 `[vars]` 暫時加 `GAS_MIN_ETH = "1000"` 並 `npx wrangler deploy`，下一輪應收到「keeper 錢包 gas 過低」（SEV-3）；移除後再部署，下一輪應收到「恢復」。
   - **部署當下預期會收到的告警**（2026-10-01 唯讀試跑結果）：
     - `x402-payto:unsafe`（SEV-3）——x402 treasury 是已知待換的地址，收款守門 fail-closed（見 `frontend/src/contracts/x402.ts`）。換新 treasury 並更新 signal-api 後會自動恢復。不想每 6 小時被提醒，在 `[vars]` 設 `MUTE_KEYS = "x402-payto:unsafe"`——這是目前**唯一**可以靜音的 key（`monitors.json` 的 `mutableKeys` 白名單，CI 與執行期都只認它）；`x402-payto:changed` 等 SEV-1 在任何設定下都會送。**不要**用 `MIN_SEVERITY = "SEV-2"` 來壓——那會把所有 SEV-3 一起關掉。
     - `x402-payto:baseline:…`（SEV-2）——沒設 `EXPECTED_PAY_TO` 時才會有；設了就不會出現。
     - `oracle-deviation:no-reference`（SEV-3）——參考來源 AggregatorOracle 對所有資產 revert（NoLiveSource），**價格偏離目前沒有被監控**；參考來源恢復後自動解除並開始比對。

## 第一次執行

KV 沒有檢查點時，事件掃描往回看 `INITIAL_LOOKBACK_BLOCKS`（預設 1,800 塊約 1 小時；範圍 150–10,000，執行期也夾住，設成 0 不會變成「從現在開始」），**不會**補掃更早的歷史，並送出一則 SEV-3「**監控狀態重置**：往回看 N 個區塊，從區塊 M 重新開始；更早的事件未掃描」。剛部署時收到是正常的；**之後再收到代表 KV 狀態遺失或被清除**，那段期間的事件要到區塊瀏覽器人工補查。

`x402-payto` 沒設 `EXPECTED_PAY_TO` 時以第一次觀察值為基準，並送出一則「基準已設定：payTo = 0x…」（SEV-2，比照 monitor-self 不可被 `MUTE_KEYS`／`MIN_SEVERITY` 擋掉）供確認；基準被重建的那一輪，原本開著的「收款地址變更」不會被當成恢復。保險金、交易所與 PepeIncentives 餘額的「24 小時高點」從部署後開始累積。

## 日常

- **改規則或門檻**：改 `monitors.json` → `--write` → 改了規則內容時，CI 會要求更新 `REQUIRED_RULES` 的雜湊；改了參數預設值、`network`、`repoBlobBase` 時要求更新 `GLOBAL_CONFIG_HASH`（兩者都要**審過 diff 再貼**）→ PR（CI 的 `monitoring` job 檢查）→ 合併後 **【擁有者】** `npx wrangler deploy`。Worker 不會自動跟著 master 更新。
- **合約升級或 `monitoring-fixture` 排程變紅**：確認是預期的變更 → `node scripts/check-monitoring.mjs --refresh-deployed` → `--write` → 審過 `deployed.json`／`monitors.json` 的 diff（新實作的 bytecode 是否仍發同樣的事件、接線預期值是否仍正確）→ PR → 重新部署 Worker（`proxy-implementation` 才會恢復）。
- **合約 cutover 後**（新 exchange、Timelock、GuardedOracle／AssetVaultV2_5 上線）：
  1. 依 cutover 文件更新 `frontend/src/contracts/addresses.ts` 與 `abi/*.json`。
  2. 把對應的 `pending-deploy` 規則改成 `"status": "active"`，`contracts[].source` 換成 `contracts[].abi`（Timelock 需要先把位址加進前端設定）。
  3. `--write`、PR、重新部署 Worker。`check-monitoring.mjs` 偵測到 pending 規則的事件已出現在前端 ABI 時會印 `::notice::` 提醒。
  4. 現行 exchange 的位址一旦換掉，舊位址的規則會自動跟著 `addresses.ts` 換到新位址；CI 會擋下沒跟上的設定。
- **通道憑證輪替**：建立新 bot token／webhook → `npx wrangler secret put …` 覆寫 → 確認下一輪測試告警送達 → 撤銷舊的。
- **清除基準**（例如預期中的 `payTo` 變更、沒設 `EXPECTED_PAY_TO` 時）：設定 `EXPECTED_PAY_TO` 為新值最簡單。否則**只刪基準那一個鍵**：
  ```bash
  npx wrangler kv key delete "baselines:v1" --binding MONITOR_STATE --remote
  ```
  （或在 Cloudflare dashboard 的 KV 頁面刪 `baselines:v1`。）下一輪會以當下的 `payTo` 重新建立基準並送出「基準已設定」供確認。
  **不要刪 `state:v1`**：那會連事件檢查點、開啟中的告警、累計視窗一起清掉，Worker 會從當下重新開始掃並發「監控狀態重置」，重置前還沒掃到的事件就漏了。

## 狀態與限制

- KV 鍵 `state:v1`：事件檢查點、開啟中的告警、累計提領視窗、保險金每小時高點、HTTP 連續失敗次數、送不出去的 outbox（非關鍵最多 100 則；SEV-1 與 monitor-self 最多 200 則，超過時最舊的合併成摘要）。KV 鍵 `baselines:v1`：首次觀察到的基準（`payTo`）。每輪各讀 1 次；`state:v1` 每輪寫 1 次（每日 288 次寫入），`baselines:v1` 只在基準變動時寫。
- 告警狀態機：事件型每筆送一次；狀態型首次「觸發」、嚴重度升級或超過 `REMIND_SEC`（6 小時）「持續」、條件解除「恢復」。接線、實作位址與 x402 `payTo` 的告警開著時，**觀察值又變成另一個值會立刻再通知**（「值再次變更」，去重 id 含新值），不等 `REMIND_SEC`。**規則讀取失敗時不會發恢復**。
- 同一條規則一輪內超過 5 則事件通知時，合併成一則摘要（筆數、首末時間、前 5 筆明細），不讓爆量把同一段時間的 SEV-1 擠掉。
- 通道各自送、各自重送：某個通道失敗時，通知只對「沒送到的那個通道」留在 outbox，下一輪重送。送出順序是 SEV-1 與 monitor-self 優先、其次依發生時間（同一個 key 的觸發一定先於恢復）；每輪的通知數受 Cloudflare subrequest 上限約束，額度先給關鍵通知。outbox 滿了先丟最低嚴重度、最舊的；**SEV-1 與 monitor-self 不因容量或時間被丟**（只有已送到至少一個通道的才在 24 小時後過期）。有丟棄或合併時發一則不可靜音的 `monitor-self:outbox`（數量、涉及的 key、時間範圍）。通道從設定移除或被停用後，一個通道都還沒送到的通知改送現有通道。有通知沒送達時該次 cron 記為失敗、不打心跳；同一通道連續 `CHANNEL_STUCK_ROUNDS` 輪以上送不出去時，透過其他通道發 `monitor-self` 告警。
- 延遲：cron 5 分鐘＋`CONFIRMATIONS`（3 塊）。落後超過 `LAG_ALERT_BLOCKS` 時發監控自身告警。
- 事件掃描：公開 RPC 的 `eth_getLogs` 一次最多 1,000 塊（超過回 HTTP 413／-32614），所以 `MAX_BLOCK_RANGE` 上限 1,000（CI 與執行期都強制）。停機後積欠的區塊**分段追趕**：每輪最多 `MAX_SCAN_REQUESTS` 段、每段一個檢查點；範圍被拒時自動減半重試，不會卡死在同一個檢查點。
- RPC 讀取：限流（429／-32007）與 5xx 以退避重試；`monitor-self:errors` 要**連續 `SELF_ERRORS_BEFORE_ALERT` 輪**讀取失敗才告警，公開 RPC 偶發抖動不會觸發／恢復輪流洗版。部分資產讀取失敗時，已算出的告警照送，但該規則不算成功評估（不發恢復）。
- 靜音：`MUTE_KEYS` 只接受 `monitors.json` 的 `mutableKeys` 白名單（完全相同的 key，沒有前綴比對；白名單也釘在檢查器的 `MUTABLE_KEYS`，要加一項必須改程式碼並經人工審查）。白名單以外的值——包括在 Cloudflare dashboard 或 `--var` 設、不經 CI 的——執行期一律忽略，並發一則不可靜音的 `monitor-self:config`（SEV-2）。**SEV-1、`monitor-self`、「基準已設定」在任何設定下都送**；`MIN_SEVERITY` 只能設 SEV-2～SEV-4。
- 參數範圍：**每一個**參數的型別與上下限都在 `params.mjs`（CI 與 Worker 執行期共用同一張表，範圍列在 `rules.md` 的參數表）。範圍的原則是「範圍內的任何值都不等於關掉告警」，例如 `CONFIRMATIONS` ≤ 64、`INITIAL_LOOKBACK_BLOCKS` ≥ 150、`REMIND_SEC` ≤ 1 天、`ORACLE_DEVIATION_CRIT_BPS` ≤ 3,000、`GAS_*` ≥ 0.001、`HTTP_FAILS_BEFORE_ALERT`＋`SELF_ERRORS_BEFORE_ALERT` 讓持續故障在 6 輪（約 30 分鐘）內告警。CI 擋 `monitors.json` 與 `wrangler.toml`；Cloudflare dashboard 或 `--var` 設的值不經 CI，執行期照表夾值（格式不對用預設值）並發 `monitor-self:config`。引擎只能透過只認這張表的存取器讀參數，測試會掃原始碼，擋下沒定義範圍的新參數。
- 累計提領視窗以**區塊時間**計算（不是 Worker 執行時間）。停機後追趕時才掃到的提領，若在發生當時的視窗內累計達門檻，另發一則一次性「（累計，過去發生）」告警，訊息標明發生時間——即時視窗看不到它們，但它們正是停機期間被拆單抽走的情境。只有本輪真的掃到「發生時間已在即時視窗之外」的提領（也就是落後追趕）時才評估，正常運作的穩定提領流量不會觸發。
- 部分事件在部署版合約裡不存在（前端 ABI 比部署版新）：這些規則在 `rules.md` 標「部署版不發此事件」，改由接線狀態規則輪詢 getter；CI 以 `deployed.json` 確認每條 active 事件規則的 topic0 都在部署版 bytecode 裡。CI 也從部署版的 **selector** 出發：受監控合約裡每個像管理操作的函式（set／withdraw／grant…），都要在 `adminFunctions` 指定涵蓋它的規則或寫明理由——不發事件的 setter（例如 PepeIncentives 的 `withdraw`、`setEsgRegistry`）由狀態規則涵蓋。
- **接線檢查只證明「位址沒被換掉」，不證明「位址是安全的」**：預期值來自前端設定或部署當時的鏈上快照。目前 FeeRouter／X402FeeRouter 的 `platformTreasury()` 預期值、以及 x402 收款的首次基準，都等於 `frontend/src/contracts/x402.ts` 列為不安全、待換的地址；換掉之後要重抓 `deployed.json` 並更新預期值（`EXPECTED_PAY_TO`）。
- `deployed.json` 過期偵測：Worker 每輪讀受監控 UUPS proxy 的 EIP-1967 實作 slot（規則 `proxy-implementation`），與 `deployed.json` 不同就發 SEV-1「實作被升級」（同一次升級已由 `vault-upgraded` 的 Upgraded 事件以 SEV-1 通報時降為 SEV-3，不重複叫人），直到重抓、重新部署 Worker 為止。另有每週排程的 `.github/workflows/monitoring-fixture.yml` 以公開 RPC 唯讀執行 `node scripts/check-monitoring.mjs --verify-deployed`：bytecode、實作或快照與 repo 不同就讓 job 失敗（不使用 secret、不寫檔、不 commit）。
- 必要規則的定義都釘了 sha256（`scripts/check-monitoring.mjs` 的 `REQUIRED_RULES`）：改任何一條規則的內容——合約、讀取、預期值來源、**參照哪個門檻參數**、事件、嚴重度、甚至說明文字——CI 都會紅並印出新雜湊，要人工確認沒有削弱監控後再更新雜湊。**門檻參數的值**不在規則雜湊裡，而在另一個全域雜湊 `GLOBAL_CONFIG_HASH`（參數預設值、`network`、`repoBlobBase`、`deployment`）；`wrangler.toml` 的覆寫值只受範圍限制。告警連結的網域也有白名單：`network.explorer` 只能是 Base Sepolia 的 Basescan，`repoBlobBase` 只能指向本 repo。
- 只監控 Base Sepolia（84532）；Ethereum Sepolia 的價格新鮮度仍由 `oracle-health.yml` 負責。
- Cloudflare 免費方案的單次 CPU 時間有上限；規則與網路等待不算 CPU，但若 Logs 出現超出 CPU 限制的錯誤，需升級 Workers Paid 或拆分 Worker（**部署後觀察**）。
- 白標租戶：每個租戶複製一份 `monitors.json`（`deployment.tenant` 與位址來源改成該租戶）與一個 Worker，各自的通道與 KV。產生器目前只認得正式站的前端設定；依 ADR-008 階段 2 把 `addresses.ts` 擴成依租戶後一併擴充。

## 測試

```bash
node --test ops/monitoring/monitor.test.mjs     # 引擎、通知、tick（離線）
node --test scripts/check-monitoring.test.mjs   # 設定檢查器的自我測試
node scripts/check-monitoring.mjs               # 檢查 repo 本身
```

CI：`consistency.yml` 的 `monitoring` job 會跑上面三個（checkout 帶 submodules，因為 Timelock 規則的事件宣告在 OpenZeppelin 原始碼裡）。
