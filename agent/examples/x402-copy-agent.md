# x402-copy-agent：付費確認新版後才同步跟單

交易者發布新版 → `copy-sync --notify-only` 送 `new-version` 通知 → 這支 agent 用 x402 買 `/signals/:trader`，確認 `data.strategyVersion` 等於通知的 `toVersion` → 模擬通過後呼叫 `CopyTracker.resyncFor`。

**同步只有在跟隨者事先開啟自動同步時才會發生。** agent 只能決定「何時按」：內容（資產、方向、權重、槓桿）全部來自鏈上策略與跟隨者的設定，規則見 [`copy-sync/README.md`](../copy-sync/README.md)。

## 跑法

```bash
cd agent

# 終端機 A：agent（先加 --dry-run 看流程：不付款、不送交易、不寫狀態檔、不讀金鑰）
COPY_SYNC_RPC_URL=<RPC> X402_API_URL=<API> AGENT_PRIVATE_KEY=<付款金鑰> COPY_SYNC_KEYSTORE=<執行者 keystore> \
  npx tsx examples/x402-copy-agent.ts --followers 0xFollower

# 終端機 B：交易者發版後跑一輪通知
COPY_SYNC_RPC_URL=<RPC> COPY_SYNC_NOTIFY_WEBHOOK=http://127.0.0.1:8402/webhook \
  npm run copy-sync -- --once --notify-only --followers 0xFollower
```

輸出：`① 收到新版通知`、`② x402 付費買訊號（tx）`、`③ 確認版號`、`④ 同步（tx）`。

| 變數 | 用途 |
|---|---|
| `X402_API_URL` | signal-api 網址，要與 tracker 同一套部署 |
| `AGENT_PRIVATE_KEY` | 付款錢包 |
| `COPY_SYNC_KEYSTORE`（搭配 `COPY_SYNC_KEYSTORE_PASSWORD_FILE`）或 `COPY_SYNC_PRIVATE_KEY`（公開鏈要加 `--allow-plaintext-key`） | 執行者熱錢包，來源規則同 copy-sync；keystore 要放 repo 外，Windows 路徑請用 `/` 或給 `~/.foundry/keystores` 下的名稱 |
| `COPY_SYNC_RPC_URL`、`BASE_SEPOLIA_RPC_URL` | 讀鏈、送交易、x402 簽章與核對授權都用同一個：前者優先，沒設時用後者，都沒設用公開節點（copy-sync 一定要設其中一個）。真跑只接受 Base Sepolia（chainId 84532），因為付款在 Base Sepolia |
| `X402_MAX_PAYMENT_USDC` | 單筆付費上限（預設 0.02；`/signals` 目前 0.01）。累計上限是 `X402_MAX_TOTAL_SPEND_USDC`（預設 1，每個行程） |
| `X402_COPY_AGENT_PORT` 或 `--port` | webhook 埠（預設 8402，只綁 127.0.0.1）。Windows 開機後可能把一段埠保留給 Hyper-V／WinNAT（`netsh int ipv4 show excludedportrange protocol=tcp`），8402 落在裡面會 `EACCES`，換一個埠並同步改 copy-sync 的 `--notify-webhook` |

## 前提

| 角色 | 要準備 |
|---|---|
| 跟隨者（本人錢包） | 跟單並開啟自動同步（`followTraderAtVersionWithAutoSync` 或 `setAutoSync`）、油箱有 ETH（`depositSyncGas`）；若指定執行者（`setSyncExecutor`），要指定這把熱錢包。私鑰不交給 agent |
| 交易者 | 發布新版。新版含 RWA 時跟隨者要先通過 KYC |
| 付款錢包 | Base Sepolia **官方 USDC**。不能是 `--followers` 裡的地址 |
| 執行者熱錢包 | 少量 gas ETH。不能有任何跟單紀錄或油箱餘額（同 copy-sync） |

**冷卻：** 第三方同步要等 `syncReadyAt`＝上次同步（沒同步過就是跟單當下）＋跟隨者設定的間隔，合約下限 1 小時。冷卻中收到通知時，agent 會排程在冷卻結束後（多等 30 秒）自動再試一次，不必重新觸發；agent 要一直開著，關掉就要重新觸發。

## 什麼時候不同步

付費前先做免費檢查（讀鏈、模擬）：已知同步不了就**不付費**。付費後、送交易前會再檢查一次，這時被擋則費用已經發生，會照實印出。

| 情況 | 行為 |
|---|---|
| 自動同步關閉（通知或鏈上任一）、冷卻中、指定了別的執行者、模擬被合約擋下 | 不送交易，印原因與本人該怎麼做 |
| copy-sync 送來 `blocked`（它模擬被擋時只送這種，不送 `new-version`） | 同上，不付費。處理好後下一輪 `--notify-only` 會送 `new-version` |
| 通知與鏈上不符（交易者不對、版本不是鏈上最新） | 不付費、不送交易 |
| 訊號版號與通知不符 | 不同步；費用照實印，同一版不再付 |
| 送出授權後伺服器回 402（例如 USDC 不足） | 不同步。402 不能證明沒扣款，所以先等授權到期（最多約 11 分鐘；`X402_MAX_VALIDITY_SEC` 調到超過 600 秒時一律當作狀態不明），再到 USDC 合約查 `authorizationState`：確定沒被使用才當作沒付，並在約 30 秒後自動重試（每次重新簽一張新授權；同一筆跟單的同一版最多 2 次，用完才請本人補足後重新觸發）；被使用了或查不了，就當作狀態不明，不自動重付 |
| 授權送出後沒拿到明確結果（5xx、斷線） | 不同步；印未結算金額，不自動重付。查過付款紀錄、確認要再付的話，換一個 `--state-file` 重啟再重新觸發 |

webhook 內容不可信，花錢與送交易一律以鏈上讀到的為準。另外拒絕帶 `Origin` 的請求、Host 不是本機的請求，以及 content-type 不是 JSON 的請求（防瀏覽器網頁打本機）。

## 去重

紀錄寫在 `agent/.state/x402-copy-agent/<chainId>-<tracker>.json`（`--state-file` 可改），重啟仍有效，付款前會先寫入。

- 同一 `trader`＋`toVersion` 只付一次；多位跟隨者跟同一位交易者時共用這份訊號，各自同步。
- 同一筆跟單的同一版只同步一次。
- 已付費但被擋（例如油箱不足）：處理好後再觸發，不會再付。

## 重新觸發

`--notify-only` 每一版只通知一次，所以要用新的狀態檔才會再通知同一版：

```bash
COPY_SYNC_RPC_URL=<RPC> COPY_SYNC_NOTIFY_WEBHOOK=http://127.0.0.1:8402/webhook npm run copy-sync -- --once --notify-only \
  --followers 0xFollower --state-file .state/copy-sync/retrigger-$(date +%s).json
```

## 限制

- `resyncFor` 沒有版本參數，一律同步到鏈上最新版。交易者若在最後一次檢查與交易上鏈之間又發版，部位會到更新的版本；此時會照實印出（`docs/KNOWN_LIMITATIONS.md` #41）。
- 冷卻與拒收的自動重試排程只存在記憶體：agent 重啟就沒了，要重新觸發。
- 2026-11-11 實測正式站（Vercel，x402.org facilitator）：閒置幾分鐘後的第一筆付款常被回 402（x402-hono 0.5.3 的錯誤內容序列化成 `{}`，看不出原因），緊接著重試就成功；同一個 facilitator 在本機 signal-api 上沒有這個現象。自動重試就是為了這種情況。
- 等授權到期核對時（最多 10 分鐘），佇列裡其他通知會排在後面。

## 測試

```bash
npx tsx examples/x402-copy-agent.test.ts   # 離線：假鏈＋假付款，不連網、不付款、不送交易
```
