# keeper 外部觸發器（Cloudflare Worker）

## 為什麼要有它

`.github/workflows/base-sepolia-keeper.yml` 名目上每 15 分鐘跑一次，但 GitHub 排程是 best-effort：實測間隔 68–169 分鐘，2026-09-30 甚至 4.5 小時沒有執行。交易所的 `maxPriceAge` 是 6 小時，所以只要一次寫價失敗再遇上排程延遲，資產就會過期、無法交易（當天 sBTC 就是這樣）。

這個 Worker 每 20 分鐘用 Cloudflare 的 cron 檢查一次；keeper 超過 15 分鐘沒有執行、而且目前沒有排隊或執行中的 run，才觸發一次 `workflow_dispatch`。GitHub 排程仍然保留，兩者並存。keeper 在不需要寫價時不會送交易，多跑一次只花 Actions 分鐘數（公開 repo 免費）。

## 安全邊界

- Worker **不持有任何鏈上金鑰**。私鑰仍只在 GitHub Actions secrets。
- 只需要一個 GitHub fine-grained token：
  - Repository access：只選 `zuemen/pepelab_onchain_cfd`
  - Permissions：**Actions: Read and write**，其他全部 No access
  - 建議設定到期日（例如 1 年），到期前換新
- Worker 對任何 HTTP 請求都回 404，公開 URL 不能拿來觸發 keeper。`workers_dev = false`，不會產生 `*.workers.dev` 網址。
- token 外洩的最壞情況：別人能觸發或取消這個 repo 的 workflow，不能讀寫程式碼、不能讀 secrets。發現外洩就到 GitHub 撤銷 token。

## 部署（需要你本人操作）

```bash
cd ops/keeper-trigger
npx wrangler login                       # 用你的 Cloudflare 帳號
npx wrangler secret put GITHUB_TOKEN     # 貼上 fine-grained token
npx wrangler deploy
```

## 驗證

- Cloudflare dashboard → Workers → `pepelab-keeper-trigger` → Logs：每 20 分鐘應看到一行 `decide: dispatch=...`。
- GitHub → Actions → Base Sepolia Keeper：出現 `workflow_dispatch` 觸發的執行，且間隔不超過約 35 分鐘。
- `oracle-health.yml` 的過期告警 issue 應該不再出現。

## 調整

`wrangler.toml` 的 `[vars]`：`MIN_GAP_SEC`（預設 900）、`WORKFLOW_REF`（預設 master）。cron 間隔改 `[triggers] crons`。

## 測試

```bash
node --test ops/keeper-trigger/keeper-trigger.test.mjs
```
CI（consistency.yml）會跑這組測試。
