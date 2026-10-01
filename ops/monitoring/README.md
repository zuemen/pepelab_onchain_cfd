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
| `HEARTBEAT_URL`（選用） | Worker secret | 有人替我們打心跳，掩蓋 Worker 停擺 |
| KV namespace `MONITOR_STATE` | Cloudflare 帳號內 | 被改寫可造成重複或漏掉的告警；只有帳號擁有者能寫 |

**沒有** GitHub token、**沒有**任何鏈上私鑰；不送交易、不開 issue。它與 `ops/keeper-trigger`（持有 Actions token）完全分開——keeper-trigger 的 token 外洩時能停用 keeper 與 `oracle-health.yml`，但碰不到這個 Worker。

通道憑證不會出現在 log：送失敗時只記通道名與 HTTP 狀態。訊息以純文字送出（Telegram 不設 `parse_mode`、Discord `allowed_mentions` 為空），鏈上資料不會被解讀成格式或 @mention。

## 部署（依序）

1. **【擁有者】決定告警通道與接收者**（ADR-009「待使用者決定」1）。至少要一個通道，否則 Worker 每次 cron 都會失敗（刻意的：沒有通道時寧可大聲失敗）。
2. **【擁有者】建立通道**（需要你本人的帳號）：
   - Telegram：用 @BotFather 建 bot 取得 bot token；把 bot 加進接收群組，取得 chat id。
   - Discord：頻道設定 → 整合 → Webhook → 複製 URL。
   - email：用你選定的轉寄服務建立一個接收 HTTPS POST 的端點（JSON body，含 `severity`、`status`、`ruleId`、`title`、`text`）；設定 `ALERT_WEBHOOK_SECRET` 時，請求帶 `X-Pepelab-Signature: sha256=<HMAC-SHA256(secret, body)>` 供驗證。
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
   npx wrangler secret put HEARTBEAT_URL    # 選用：外部 dead-man's switch
   ```
6. **【擁有者】填公開設定**（`wrangler.toml` 的 `[vars]`，ADR-009「待使用者決定」3）：
   - `EXPECTED_PAY_TO`：signal-api Vercel 環境變數 `PAY_TO` 的值。不設時以第一次觀察到的 `payTo` 為基準。
   - `EXTRA_GAS_WALLETS`：x402 結算錢包等其他需要 gas 的地址，逗號分隔。keeper 錢包不用填（執行期讀 `MockOracle.owner()`）。
7. **【擁有者】部署**：
   ```bash
   npx wrangler deploy
   ```
8. **驗證**：
   - Cloudflare → Workers → `pepelab-chain-monitor` → Logs：每 5 分鐘一行 `tick: findings=… notes=… sent=… pending=0 errors=0`。
   - **送一則測試告警**：在 `[vars]` 暫時加 `GAS_MIN_ETH = "1000"` 並 `npx wrangler deploy`，下一輪應收到「keeper 錢包 gas 過低」（SEV-3）；移除後再部署，下一輪應收到「恢復」。
   - **部署當下預期會收到的告警**（2026-10-01 唯讀試跑結果）：
     - `x402-payto:unsafe`（SEV-3）——x402 treasury 是已知待換的地址，收款守門 fail-closed（見 `frontend/src/contracts/x402.ts`）。換新 treasury 並更新 signal-api 後會自動恢復。
     - `oracle-deviation:no-reference`（SEV-3）——參考來源 AggregatorOracle 對所有資產 revert（NoLiveSource），**價格偏離目前沒有被監控**；參考來源恢復後自動解除並開始比對。

## 第一次執行

KV 沒有檢查點時，事件掃描從 `head - INITIAL_LOOKBACK_BLOCKS`（約 10 分鐘）開始，**不會**補掃更早的歷史。`x402-payto` 沒設 `EXPECTED_PAY_TO` 時以第一次觀察值為基準。保險金的「24 小時高點」從部署後開始累積。

## 日常

- **改規則或門檻**：改 `monitors.json` → `--write` → PR（CI 的 `monitoring` job 檢查）→ 合併後 **【擁有者】** `npx wrangler deploy`。Worker 不會自動跟著 master 更新。
- **合約 cutover 後**（新 exchange、Timelock、GuardedOracle／AssetVaultV2_5 上線）：
  1. 依 cutover 文件更新 `frontend/src/contracts/addresses.ts` 與 `abi/*.json`。
  2. 把對應的 `pending-deploy` 規則改成 `"status": "active"`，`contracts[].source` 換成 `contracts[].abi`（Timelock 需要先把位址加進前端設定）。
  3. `--write`、PR、重新部署 Worker。`check-monitoring.mjs` 偵測到 pending 規則的事件已出現在前端 ABI 時會印 `::notice::` 提醒。
  4. 現行 exchange 的位址一旦換掉，舊位址的規則會自動跟著 `addresses.ts` 換到新位址；CI 會擋下沒跟上的設定。
- **通道憑證輪替**：建立新 bot token／webhook → `npx wrangler secret put …` 覆寫 → 確認下一輪測試告警送達 → 撤銷舊的。
- **清除基準**（例如預期中的 `payTo` 變更、沒設 `EXPECTED_PAY_TO` 時）：設定 `EXPECTED_PAY_TO` 為新值最簡單；或在 Cloudflare dashboard 刪除 KV 鍵 `state:v1`（所有狀態重置，事件從當下重新開始掃）。

## 狀態與限制

- KV 鍵 `state:v1`：事件檢查點、開啟中的告警、累計提領視窗、保險金每小時高點、HTTP 連續失敗次數、送不出去的 outbox（最多 100 則）。每輪讀 1 次、寫 1 次（每日 288 次寫入）。
- 告警狀態機：事件型每筆送一次；狀態型首次「觸發」、嚴重度升級或超過 `REMIND_SEC`（6 小時）「持續」、條件解除「恢復」。**規則讀取失敗時不會發恢復**。
- 所有通道都送失敗時，通知留在 outbox 下一輪重送，該次 cron 記為失敗，也不打心跳。
- 延遲：cron 5 分鐘＋`CONFIRMATIONS`（3 塊）。落後超過 `LAG_ALERT_BLOCKS` 時發監控自身告警。
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
