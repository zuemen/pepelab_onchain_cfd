# copy-sync — 跟單自動同步的執行者

對應 [`docs/ADR-024-copy-auto-sync.md`](../../docs/ADR-024-copy-auto-sync.md)。交易者在 StrategyRegistry 發布新版策略後，
這個程式找出「開了自動同步、還停在舊版」的跟單紀錄，先模擬、會成功才送出 `CopyTracker.resyncFor(follower, recordIdx)`，
把跟隨者的部位調成交易者鏈上最新版。

它**不是**平台代下單：`resyncFor` 沒有任何內容參數（資產、方向、權重來自 StrategyRegistry；槓桿是「策略、交易所上限、
跟隨者上限」三者取小；保證金只用這次平倉釋出的金額），呼叫者唯一能決定的是「何時」，而且受跟隨者設定的冷卻限制。
所以任何人都可以跑這個程式，跟隨者不需要信任跑它的人——與無需許可的清算同一個道理。

## 誰能做什麼

| 動作 | 誰 | 由什麼保證 |
|---|---|---|
| 開啟／關閉自動同步、設定槓桿上限、冷卻（≥ 1 小時，`MIN_SYNC_INTERVAL`）、小費 | 只有跟隨者本人（`setAutoSync`） | 合約 |
| 別人代為同步時的執行費率 | 不高於跟隨者開啟自動同步時**簽名帶入**的每腿上限（`setAutoSync`／`followTraderAtVersionWithAutoSync` 的 `maxExecFeePerLeg`，記為 `syncExecFeeCap`），否則 revert `ExecutionFeeAboveCap`；交易所 owner 搶先調費只會讓跟隨者那筆交易失敗，不會被記成同意值 | 合約 |
| 存入／提領油箱（付執行費與小費的 ETH） | 存：任何人；提領：只有跟隨者本人，隨時 | 合約 |
| 指定唯一的執行者（例如自己的 agent 熱錢包），或解除指定 | 只有跟隨者本人（`setSyncExecutor`）；跟單結束時清除 | 合約 |
| 把部位調成交易者**鏈上最新版** | 開啟後任何人（指定了執行者時只有那個地址，其他人 revert `NotSyncExecutor`）；跟隨者本人隨時（不收小費、不受冷卻） | 合約 |
| 選資產、方向、槓桿、保證金 | **沒有人**（全部來自鏈上策略與跟隨者設定） | 合約 |
| 新版有一條腿開不起來（RWA 未 KYC、休市、OI 上限…） | 整筆 revert，部位維持舊版 | 合約 |
| 已是最新版時重送 | revert `AlreadySynced`（防重放） | 合約 |
| 執行者金鑰只簽得出 `resyncFor` | 本程式（`src/guard.ts` 白名單） | 程式自律（第二道防線） |
| 先模擬才送、被擋就退避重試、同一原因只通知一次 | 本程式 | 程式自律 |

## 兩種模式

| | public | personal |
|---|---|---|
| 服務對象 | 所有開了自動同步、沒有指定別的執行者的跟隨者 | 只有 `--followers` 列出的地址 |
| 怎麼找人 | 監聽 `StrategyPublished`，用 `followersByTrader` 找跟隨者（去重）；另外監聽 tracker 的 `AutoSyncSet`／`SyncExecutorSet`／`TraderFollowed`／`SyncGasDeposited`／`Resynced` | 只看自己的地址（getLogs 以 topic1 過濾），不掃 `followersByTrader` |
| 小費 | 拿跟隨者設定的 `tipWei`；`--min-tip-wei` 可以拒絕不划算的 | 跟隨者可以把小費設 0，自己的 agent 自己付 gas |
| 沒開自動同步、或指定了別的執行者的跟單 | 不追蹤 | 不送交易；交易者每發一版就通知本人一次（`new-version`），本人到投資組合檢視新版內容後手動同步 |
| 典型使用者 | 平台或任何第三方，賺小費 | 跟隨者自己（或他的其他 agent） |

personal 模式仍然要用**另一把**執行者熱錢包，跟隨者主錢包的私鑰永遠不交給程式。不論 public 或 personal 模式，載入的
執行者金鑰只要在 tracker 上有任何跟單紀錄（含已結束的）或油箱餘額，程式就拒絕啟動——那是某位跟隨者的主錢包，持有 USDC 部位
與油箱，不是只放 gas 的熱錢包（personal 模式下執行者位址等於 `--followers` 裡的地址時，另有更直接的訊息）。這把熱錢包對合約來說
是「別人」：要它能同步，跟隨者必須開啟自動同步（受冷卻限制）。

**只讓自己的 agent 同步、別人都不行**：跟隨者在投資組合的「自動同步設定」（或跟單頁）把「只讓這個地址代為同步」填成這把熱錢包的地址
（合約 `setSyncExecutor(recordIdx, executor)`，也可以在 BaseScan 的 Write Contract 直接送）。之後除了跟隨者本人，只有這個地址
能呼叫 `resyncFor`，平台的 public 執行者與任何第三方一律 revert `NotSyncExecutor`——第三方挑時機的空間收回到自己手上。
冷卻、小費、執行費上限照舊適用於這把熱錢包；它外洩的最壞情況仍只是「觸發合約本來就允許的同步」，換一把再設定一次即可。
從 `followTraderAtVersionWithAutoSync` 跟單到送出 `setSyncExecutor` 之間不會被別人搶先同步：冷卻從跟單當下起算、至少 1 小時。

**完全不開自動同步**：personal 模式照樣追蹤自己的跟單，交易者發布新版時送出 `new-version` 通知，不送任何交易；
本人收到通知後到投資組合「立即同步」（`resyncAtVersion` 釘住畫面上看過的那一版）。

### 只通知、不送交易（`--notify-only`，不需要任何金鑰）

webhook 是設在執行者那支程式上的：平台或第三方的 public 執行者，通知送到**執行者營運方自己**，不會送到跟隨者。想在交易者發版、
或自己的跟單被擋（油箱不足、執行費被調高、新版含 RWA 而還沒 KYC…）時收到通知，又不想（或還沒）準備執行者熱錢包的跟隨者，用
只通知模式：

```bash
COPY_SYNC_RPC_URL=<RPC> COPY_SYNC_NOTIFY_WEBHOOK=https://example.com/hooks/me npm run copy-sync -- \
  --once --notify-only --followers 0xYourFollowerAddress
```

- 不讀任何金鑰、不送任何交易；只讀鏈、模擬、通知。
- **會寫狀態檔**（預設 `agent/.state/copy-sync/<chainId>-<tracker>-notify-<hash>.json`，與真正執行者的狀態分開）：掃描游標、
  「已通知到第幾版」與「被擋原因」都記在裡面，所以掛 cron 用 `--once` 一輪一輪跑時，**同一版只通知一次、同一個被擋原因也只通知
  一次**。`--dry-run` 不寫狀態檔，每次都從 `--lookback-blocks` 重掃、每次都重發通知——只適合手動試跑，排程請用 `--notify-only`。
- 只限 personal 模式（`--followers` 你自己的地址），不能與 `--dry-run` 同時用。
- 通知內容：交易者發新版時送 `new-version`（自動同步開著時說明冷卻到什麼時候、或「模擬同步會成功，等執行者代為同步」；沒開時說明要
  自己同步）；模擬被擋時送 `blocked`（附分類與下次重試時間）。`executor` 欄位是 `null`。
- 沒有跑任何 agent 的人，網頁也會在任何內頁頂端提醒「交易者發布了新版、你有紀錄還停在舊版」，並指出哪些要本人處理（沒開自動同步、
  油箱不足、執行費被調高）。

## 金鑰模型（自託管的重點）

- **跟隨者的私鑰永遠不離開自己的錢包**。跟隨者只用自己的錢包簽兩類交易：跟單（`followTraderAtVersionWithAutoSync`
  或 `followTrader` ＋ `setAutoSync`）與油箱（`depositSyncGas`／`withdrawSyncGas`）。這個程式不需要、也不接受跟隨者的私鑰。
- **執行者金鑰是一把獨立、只放少量 gas ETH 的熱錢包**（建議 0.01 ETH 上下；公開鏈上餘額超過 0.05 ETH 會出警告）。
- **執行者金鑰外洩的最壞情況**：有人用它觸發「合約本來就允許任何人觸發」的同步，再加上用掉熱錢包裡那點 gas ETH。
  沒有任何跟隨者資金風險——拿到這把金鑰能做的事，任何陌生人本來就能做。換一把新的即可，不必走完整的金鑰輪替流程。
- 程式另外用簽章白名單（`src/guard.ts`）限制這把金鑰：只能簽對指定 CopyTracker 的 `resyncFor`、`value` 必須是 0
  （`resyncFor` 是 payable，附帶的 ETH 會存進跟隨者油箱，執行者永遠不該附帶）、`chainId` 必須相符；
  EIP-712、任意訊息、EIP-7702、轉帳、approve 一律拒絕。程式被改壞或相依套件被植入時，熱錢包不會被一筆交易掃走。

金鑰來源（比照 `keeper/keySource.ts`，變數前綴 `COPY_SYNC`）：

| 方式 | 設定 | 用在 |
|---|---|---|
| 加密 keystore（建議） | `COPY_SYNC_KEYSTORE`＝檔案路徑，或 `~/.foundry/keystores` 下的名稱 | 公開鏈 |
| └ 密碼 | `COPY_SYNC_KEYSTORE_PASSWORD_FILE`（檔案）、`COPY_SYNC_KEYSTORE_PASSWORD`（環境變數，例如 CI secret），都沒設就在終端機互動輸入（不回顯） | |
| 明文私鑰 | `COPY_SYNC_PRIVATE_KEY` | 只限本機 Anvil（31337）；其他鏈必須明確加 `--allow-plaintext-key` |

- Anvil 公開的十把測試金鑰在 31337 以外的鏈一律拒絕。
- keystore 與密碼檔必須放在 repo 目錄外：路徑落在 repo 裡（例如 `COPY_SYNC_KEYSTORE=./exec.json`）就拒絕啟動，因為
  `git add -A` 會把加密 keystore 與明文密碼一起收進版本庫。根目錄 `.gitignore` 另外擋了常見檔名（`*.keystore`、
  `keystore*.json`、`.copy-sync-*`、`*password*.txt`…），但沒有副檔名的 keystore 擋不住，所以以拒絕啟動為準。
- 日誌與錯誤訊息不印私鑰、密碼、RPC 網址（含指令列給的）、webhook 網址；ethers 錯誤裡的 `requestUrl` 一併遮掉。
- 把私鑰誤貼進只填地址或數字的欄位（`--followers`／`COPY_SYNC_FOLLOWERS`／`--tracker`／`--registry`、位置參數、數值旗標）：
  拒絕，錯誤訊息寫「看起來像私鑰（32 bytes），已拒絕且不顯示」，不帶出任何片段；其他不合法的值只顯示前 6 碼與長度。
  跟隨者的私鑰不在環境變數裡，通用的遮蔽認不得它，所以在解析參數時就擋下（錯誤訊息會進 stderr、cron 日誌與 CI 日誌）。
- 載入的執行者金鑰在 tracker 上有跟單紀錄或油箱餘額 → 不論模式都拒絕啟動（見上面「兩種模式」）；讀不到就不啟動。
- `--dry-run` 與 `--notify-only` 完全不讀金鑰。

建立 keystore：

```bash
cast wallet new ~/.foundry/keystores pepelab-copy-sync     # 互動設定密碼；印出地址，只轉入少量 ETH
export COPY_SYNC_KEYSTORE=pepelab-copy-sync
```

## 使用

```bash
cd agent
npm run copy-sync -- --help

# 先看會做什麼：只模擬、不送交易、不寫狀態檔、不需要金鑰
COPY_SYNC_RPC_URL=<RPC> npm run copy-sync -- --once --dry-run

# 只通知本人、不送交易、不需要金鑰（會寫狀態檔：每一版只通知一次，可以掛 cron）
COPY_SYNC_RPC_URL=<RPC> npm run copy-sync -- --once --notify-only --followers 0xYourFollowerAddress \
  --notify-webhook https://example.com/hooks/me

# public 模式常駐（每 30 秒一輪，每 10 分鐘全面重掃一次追蹤中的紀錄）
COPY_SYNC_RPC_URL=<RPC> COPY_SYNC_KEYSTORE=pepelab-copy-sync npm run copy-sync

# personal 模式：只服務自己的跟隨地址；結果 POST 到自己的 webhook
COPY_SYNC_RPC_URL=<RPC> COPY_SYNC_KEYSTORE=my-sync-bot npm run copy-sync -- \
  --followers 0xYourFollowerAddress --notify-webhook https://example.com/hooks/copy-sync
```

- CopyTracker 預設讀 `frontend/src/contracts/addresses.ts` 該鏈的位址；`--tracker` 可以覆寫。啟動時會確認它是自動同步版
  （讀得到 `totalSyncGas()`），舊版 tracker 直接拒絕啟動並指向 `docs/OWNER_ACTIONS.md` 的部署步驟。
- StrategyRegistry 一律以 `tracker.registry()` 為準；`--registry` 與它不同時拒絕啟動（監聽錯的 registry 會漏掉發版）。
- 選項都可以用環境變數給（見 `agent/.env.example` 的 `COPY_SYNC_*`）；RPC 與 webhook 建議只用環境變數，指令列參數會出現在 `ps` 與 shell history。

### 一輪做什麼

1. **掃事件**：`eth_getLogs` 每段 ≤ 200 個區塊（`sepolia.base.org` 2026-10-25 實測上限；節點回「範圍太大」會依錯誤訊息切小，
   判斷邏輯與前端 `chainLogs.ts` 共用）。同一段只發一次 getLogs（address 陣列＋topic0 OR）。只掃到 `head − confirmations`
   （Anvil 0、其他 2）。
2. **找出該檢查的紀錄**：新版 → 跟隨者；`AutoSyncSet`／`SyncExecutorSet`／`SyncGasDeposited` → 立刻重試（不管退避）；
   每 `--rescan-sec` 全面重掃。
3. **逐筆檢查**：跟單仍 active、自動同步開著、沒有指定別的執行者（`syncExecutor`）、鏈上最新版 > 紀錄版本、冷卻已過
   （先讀 `syncReadyAt`，冷卻中不模擬）、小費 ≥ 門檻 → `eth_call` 模擬 `resyncFor` → 成功才估 gas、送出、等確認，並從收據解出
   `Resynced`。不先呼叫 `pendingSync`：它只看 tracker 與 registry 的條件，交易所端的條件（KYC、市場模式、OI 上限）本來就要靠
   模擬才知道，模擬一次就涵蓋全部。personal 模式在冷卻中第一次看到某一版時，先送 `new-version` 通知（附預計同步時間）。
4. **被擋就分類、排重試**（`src/errors.ts`）：

| 合約回的錯誤 | 分類 | 下次重試 | 通知本人 |
|---|---|---|---|
| `AlreadySynced` | 已是最新版 | 等下一次發版 | 否 |
| `AutoSyncDisabled`、`RecordAlreadyInactive` | 停止追蹤 | 等下一次 `AutoSyncSet` | 否 |
| `NotSyncExecutor(executor)` | 跟隨者指定了別的執行者：停止追蹤 | 等下一次 `SyncExecutorSet` | 否 |
| `SyncCooldown(readyAt)` | 冷卻中 | `readyAt` | 否 |
| `InsufficientSyncGas` | 油箱不足 | 30 分鐘起指數退避；存入油箱立刻重試 | 是 |
| `ExecutionFeeAboveCap(fee, cap)` | 交易所執行費高於跟隨者開啟自動同步時同意的費率（`syncExecFeeCap`） | 1 小時起；本人看過新費率、帶入新上限重新 `setAutoSync` 立刻重試 | 是 |
| `NotKycVerified` | RWA 未 KYC | 1 小時起 | 是 |
| `AssetNotActive`、`AssetHalted`、`EnforcedPause`、`StalePrice`、`PositionStillOpen`… | 休市／暫停／報價過期 | 10 分鐘起 | 是 |
| `OpenInterestCapExceeded`、`NothingToRedeploy`… | 容量 | 30 分鐘起 | 是 |
| `TraderNotEligible` | 交易者資格 | 1 小時起 | 是 |

退避上限 6 小時。同一筆紀錄的同一個原因只通知一次。

### 冪等與中斷續跑

- 狀態檔預設在 `agent/.state/copy-sync/<chainId>-<tracker>-<模式>.json`（`agent/.gitignore` 已忽略），綁定 chainId、tracker、
  registry 與服務範圍，任何一項不同就拒絕使用（請換 `--state-file`）。檔案權限 0600、目錄 0700。
- 狀態檔不含秘密：寫進 `lastReason` 的錯誤文字一律先遮蔽再截斷（ethers 的 RPC 錯誤遇到 HTTP 429／503 時，訊息會帶含
  API 金鑰的 `requestUrl`）；通知的 `message` 也一樣。被竄改的狀態檔最多讓執行者晚一點或略過某些同步（每筆送出前都重新讀鏈、
  模擬，合約也會擋），不會讓它送出合約不允許的交易。
- 游標只在「那一段事件完整讀到、而且寫進待辦」之後才往前推；中途被殺掉，下一輪從上一個完整的區塊與待辦清單接著做。
- 重送是安全的：已是最新版時合約 revert `AlreadySynced`。等確認逾時的交易標成 `unconfirmed`，10 分鐘內不重送，先查收據。
- 同一份狀態檔同時只允許一個行程（pid 鎖）。
- Ctrl-C／SIGTERM：處理完手上這一筆就存檔結束；再按一次立即結束。

### 結束碼（`--once`）

讀取失敗（getLogs 某段、RPC）、交易上鏈後 revert、或交易狀態未知 → exit 1（讓 cron／CI 變紅）。
被合約擋下（KYC、休市、冷卻、油箱不足）不算錯誤，exit 0——那是跟隨者那一側要處理的事，已經經由通知告知。

### 通知格式（`--notify-webhook`）

只接受 https（本機測試可用 `http://localhost`）、不跟隨轉址、5 秒逾時，失敗只記 warning。

```json
{
  "source": "pepefi-copy-sync",
  "kind": "resynced | blocked | new-version | tx-failed | tx-unconfirmed",
  "chainId": 84532,
  "copyTracker": "0x…",
  "follower": "0x…",
  "recordIdx": 0,
  "trader": "0x…",
  "fromVersion": 3,
  "toVersion": 4,
  "category": "kyc",
  "autoSync": true,
  "message": "NotKycVerified(user=0x…)：新版含 RWA 資產，跟隨者尚未通過 KYC",
  "txHash": null,
  "executor": "0x…",
  "retryAt": "2026-10-26T10:00:00.000Z",
  "at": "2026-10-26T09:00:00.000Z"
}
```

`new-version`（只在 personal 模式，每一版一次）：`autoSync` 為 true 時本執行者會在 `retryAt`（冷卻結束）之後代為同步；
false（或 `message` 說指定了別的執行者）時要本人手動同步。`category` 為 null。`--notify-only` 送出的 `new-version`
`executor` 為 null：它不送交易，`message` 會說明冷卻到什麼時候、或「模擬同步會成功，等執行者代為同步」。

`fromVersion`／`toVersion` 是合約的 `versionId`（從 0 起算）；`message` 與日誌裡給人看的版本號和前端一致從 1 起算，
並在括號附上 versionId，例如 `已同步 v1 → v2（versionId 0 → 1）`：Portfolio 顯示的「第 2 版」就是 versionId 1。

## 經濟

- 每次第三方同步，跟隨者的油箱付 `exchange.executionFee() × 新版腿數 ＋ tipWei`；執行者自己付這筆交易的 L2 gas，拿 `tipWei`。
- 日誌會印出預估 gas 成本與小費。Base Sepolia 的 gas 很便宜，0.0001 ETH 的小費通常足以覆蓋；本機 Anvil 預設 gas 價格較高，
  小費會小於 gas（只是展示）。`--max-gas-gwei` 在 gas 價格過高時延後，`--max-sends-per-round` 限制一輪最多送幾筆。

## 本機 Anvil

**一鍵驗證**（需要 Foundry；自己起隨機埠的 Anvil，forge 產物放暫存目錄，不動 repo 的 `contracts/out` 與 broadcast 紀錄）：

```bash
cd agent && npm run e2e:copy-sync
```

兩支本機端對端都設 `AGENT_SKIP_DOTENV=1`（CLI 平常一啟動就載入 `agent/.env`，這個變數讓它完全不讀），並清掉 shell 繼承來的
`COPY_SYNC_*`：開發者 `.env` 裡正式的 webhook 或 keystore 設定不會被用到。部署 `DeployLocalDemo` 加 `--slow`（一筆上鏈再送
下一筆），並由 `scripts/lib/forge-broadcast-guard.sh` 看門：廣播停滯 90 秒或總時長超過 20 分鐘就印出 `txpool_status`／
`txpool_inspect` 後失敗（`FORGE_DEPLOY_STALL`／`FORGE_DEPLOY_TIMEOUT` 可調），不會空轉到 CI 的 job 逾時。

它部署 `DeployLocalDemo`（含自動同步版 CopyTracker），讓交易者質押、發版，跟隨者以 `followTraderAtVersionWithAutoSync`
一筆完成跟單＋開啟自動同步，然後逐項驗證：沒有新版不送、dry-run 只模擬、發新版後同步成功（油箱扣「執行費 × 腿數＋小費」、
跟隨者其他 freeMargin 不減少）、冪等、新版含 RWA 而跟隨者未 KYC 時整筆被擋且部位不動、KYC 後 personal 模式同步成功、
把跟隨者私鑰當執行者金鑰時拒絕啟動。

**展示版**：`scripts/demo-autosync.sh`（repo 根目錄）把完整故事跑一遍並逐步斷言——public 模式執行者同步、執行者淨收小費、
陌生人被 `SyncCooldown`／`AlreadySynced`／`AutoSyncDisabled` 擋下、RWA 未 KYC 被擋時 webhook 收到 `kyc` 通知、KYC 後
同一個 public 執行者到了重試時間就同步成功、`--notify-only`（沒有金鑰）連跑兩次只通知一次、跟隨者全額提領油箱、跟隨者私鑰在
personal／public 模式都被拒絕，最後由 agent 經 MCP 工具 `prepare_copy_follow_tx` 準備跟單、第二位跟隨者用自己的錢包簽名完成。它用 repo 現有的 `contracts/out`（不必另外編譯一份），
broadcast 紀錄寫到暫存目錄。

**手動展示**（配合 `docs/DEMO_SCRIPT.md`「自動同步跟單」一段的本機鏈）：執行者用 Anvil 帳號 (8)：

```bash
cd agent
export COPY_SYNC_RPC_URL=http://127.0.0.1:8545
export COPY_SYNC_PRIVATE_KEY=$(cast wallet private-key "test test test test test test test test test test test junk" 8)
npm run copy-sync -- --once --dry-run --from-block 0     # 看它找到哪些待同步紀錄
npm run copy-sync -- --from-block 0                      # 常駐；交易者發新版後 30 秒內同步
```

本機鏈重建過（新的 tracker 位址）就換一個 `--state-file`，或刪掉 `agent/.state/copy-sync/31337-*`。

## 掛 cron／GitHub Actions

`--once` 跑一輪就結束，適合排程。狀態檔要放在持久的位置（cron 用本機路徑；GitHub Actions 用 cache 或 artifact 保存，
沒保存也能跑——每次從 `--lookback-blocks` 往回掃，只是比較慢）。

crontab（每 5 分鐘，keystore 密碼放在只有自己讀得到的檔案）：

```cron
*/5 * * * * cd /path/to/repo/agent && COPY_SYNC_RPC_URL=… COPY_SYNC_KEYSTORE=pepelab-copy-sync COPY_SYNC_KEYSTORE_PASSWORD_FILE=$HOME/.copy-sync-pw npm run copy-sync --silent -- --once >> $HOME/copy-sync.log 2>&1
```

只想收通知（沒有執行者金鑰）：

```cron
*/10 * * * * cd /path/to/repo/agent && COPY_SYNC_RPC_URL=… COPY_SYNC_NOTIFY_WEBHOOK=https://… npm run copy-sync --silent -- --once --notify-only --followers 0xYourFollowerAddress >> $HOME/copy-sync-notify.log 2>&1
```

GitHub Actions（片段；金鑰放 repository secret，熱錢包只放少量 ETH）。持有金鑰的 job 比照
`.github/workflows/base-sepolia-keeper.yml`：第三方 action 一律 pin 到 commit SHA（tag 可以被重指到惡意 commit）、
checkout 不留 token、`npm ci --ignore-scripts`（不讓依賴樹在有金鑰的 job 裡執行安裝腳本）、最小權限：

```yaml
on:
  schedule: [{ cron: "*/10 * * * *" }]
permissions:
  contents: read
concurrency: { group: copy-sync, cancel-in-progress: false }   # 同一把金鑰不要兩個 job 同時送
jobs:
  sync:
    # 只在預設分支跑：cache 只由這個 job 在預設分支寫入，PR 的 run 寫不進預設分支的 cache 範圍
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: 20 }
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: agent/.state/copy-sync
          # key 綁定 workflow 與分支：其他 workflow 或分支的 cache 不會被還原成這裡的狀態檔
          key: copy-sync-state-${{ github.workflow }}-${{ github.ref_name }}-${{ github.run_id }}
          restore-keys: copy-sync-state-${{ github.workflow }}-${{ github.ref_name }}-
      - run: cd agent && npm ci --ignore-scripts --no-audit --no-fund
      - run: cd agent && npm run copy-sync -- --once --allow-plaintext-key
        env:
          COPY_SYNC_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}
          COPY_SYNC_PRIVATE_KEY: ${{ secrets.COPY_SYNC_PRIVATE_KEY }}
```

- 私鑰只放在最後一個 step 的 `env`，`npm ci` 那一步拿不到。
- 狀態檔不含秘密（上面「冪等與中斷續跑」），所以 cache 被同 repo 其他 workflow 讀到不會洩漏金鑰；cache 被竄改的最壞情況
  是執行者晚一點同步或略過某些紀錄，不會送出合約不允許的交易。損害上限仍只是熱錢包裡的少量 gas ETH，跟隨者資金不受影響。
- 能用 keystore 就用 keystore：把 keystore JSON 放進 secret、密碼放另一個 secret，在 step 裡把 JSON 寫到 `$RUNNER_TEMP`
  （repo 目錄外；寫在 checkout 目錄裡會被拒絕）再設 `COPY_SYNC_KEYSTORE`＝那個檔案路徑、`COPY_SYNC_KEYSTORE_PASSWORD`＝密碼，
  就不需要 `--allow-plaintext-key`。

## 測試

```bash
cd agent
npm run test:copy-sync     # 離線：ABI 對照合約原始碼、參數、錯誤分類、簽章白名單、遮蔽、通知、金鑰、狀態檔、分段 getLogs、
                           # 以及對記憶體假鏈（ethers 真的編碼／簽章／廣播路徑）跑完整流程
npm run typecheck          # 含 tsc -p copy-sync
npm run e2e:copy-sync      # 需要 Foundry：本機 Anvil 端對端
```

兩支本機端對端（`npm run e2e:copy-sync` 與 repo 根目錄的 `scripts/demo-autosync.sh`）在 CI 由
`.github/workflows/copy-sync-e2e.yml` 執行：改到合約原始碼、`DeployLocalDemo`、`agent/copy-sync/**` 或 MCP 的
`copyTools.ts` 時自動觸發，只連自己起的 Anvil、只用公開測試金鑰、不引用任何 secret。

`src/abi.test.ts` 直接解析 `contracts/src/CopyTracker.sol`、`StrategyRegistry.sol`、`PerpetualExchange.sol` 的宣告，逐一核對
`src/abi.ts` 的函式、事件（含 indexed 位置）與錯誤；合約改了而這裡沒跟上，測試就失敗。

## 檔案

| 檔案 | 內容 |
|---|---|
| `src/run.ts` | CLI 進入點：解析參數、確認鏈與 tracker、載入金鑰、狀態檔、主迴圈 |
| `src/engine.ts` | 一輪的流程（不碰網路，經由 `ChainReads`／`Executor` 介面） |
| `src/chain.ts` | 上面兩個介面的 ethers v6 實作 |
| `src/logs.ts` | 有游標的分段 getLogs |
| `src/errors.ts` | revert 解碼、分類、重試排程 |
| `src/guard.ts` | 執行者金鑰的簽章白名單 |
| `src/keys.ts` | 金鑰來源與政策 |
| `src/state.ts` | 狀態檔、行程鎖 |
| `src/notify.ts` | webhook 通知 |
| `src/log.ts` | 遮蔽秘密的日誌 |
| `src/abi.ts` | 合約介面（集中一處） |
| `src/fakeChain.ts` | 測試用的記憶體假鏈 |
| `anvil-e2e.sh` | 本機 Anvil 端對端驗證 |

## 已知限制

- 交易者可以看到等待中的 `resyncFor` 後在同一個區塊搶先再發一版，同步就會到那一版（`docs/KNOWN_LIMITATIONS.md` #41）。
  指定執行者只決定「誰能按」，交易者發版的時機仍由交易者決定。
- 即時性取決於有沒有人執行；沒有人執行時部位停在舊版，跟隨者可以在 Portfolio 按「立即同步」（#40）。
- `followersByTrader` 會重複記錄同一位跟隨者，public 模式已去重；一位交易者最多讀 2,000 筆（每筆一個 `eth_call`），
  超過的跟隨者靠 tracker 事件與定期重掃找到（#43）。
- public 模式第一次啟動沒有狀態檔時，只從 `--lookback-blocks`（預設約 24 小時）或 `--from-block` 開始掃。在那之前就已經落後的
  紀錄，要等交易者下一次發版（會經由 `followersByTrader` 找到）或該跟隨者的下一個 tracker 事件。新 tracker 部署後第一次啟動請用
  `--from-block <部署區塊>`。personal 模式不受影響（第一輪就直接讀自己的跟單紀錄）。
