# RWA PoC 線上部署（Vercel）

本機版見 [`RUNBOOK.md`](RUNBOOK.md)。線上版與本機版跑同一份程式，差別只在設定。平台的展示站與平台 signal-api 不受影響。

| 服務 | Vercel 專案 | 網址 | Root Directory |
|---|---|---|---|
| 前端（`VITE_TENANT=rwa-poc`） | `pepelab-rwa-poc` | <https://pepelab-rwa-poc.vercel.app> | `frontend` |
| signal-api（x402 KYA） | `pepelab-rwa-poc-signal-api` | <https://pepelab-rwa-poc-signal-api.vercel.app> | `agent/signal-api` |

兩個專案都連到本 repo；`vercel.json` 的 `git.deploymentEnabled` 讓 master 自動部署。

## 前端環境變數（Production）

`VITE_TENANT=rwa-poc`、`VITE_SIGNAL_API_URL=https://pepelab-rwa-poc-signal-api.vercel.app`、`VITE_SHOW_PERPETUALS=1`、
`VITE_SHOW_LEVERAGE=1`、`VITE_SESSION_ANCHOR_CHAIN_ID=84532`、`VITE_SESSION_ANCHOR_ADDRESS`（`DEPLOYMENT.md` 的 SessionCredentialAnchor）。

build 會檢查：專屬租戶必須有自己的 signal-api，且該網址要在 `frontend/vercel.json` 的 CSP `connect-src` 裡（已加入）。

## signal-api 環境變數（Production）

與 `scripts/poc/rwa-poc-x402.sh server` 相同的設定，另加：

| 變數 | 值 | 說明 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL`／`TOKEN` | Vercel Marketplace 的 Upstash `pepelab-rwa-poc-kya`（sin1、免費、不淘汰） | **獨立 DB，不是平台的**。KYA 花費帳與防重放跨實例共用 |
| `VC_STATUS_URL` | `https://raw.githubusercontent.com/zuemen/pepelab_onchain_cfd/master/docs/tenants/rwa-poc/vc-status` | 撤銷狀態清單（本目錄 `vc-status/`，有簽章的公開資料） |
| `VC_STATUS_STATE_PATH` | `/tmp/vc-status-state.json` | 驗證端狀態（見下方限制） |
| `BASE_SEPOLIA_RPC_URL`、`KYA_RPC_URL` | `https://base-sepolia-rpc.publicnode.com` | `sepolia.base.org` 會擋雲端機房 IP |
| `CORS_ALLOWED_ORIGINS` | `https://pepelab-rwa-poc.vercel.app` | |
| `SIGNAL_API_PUBLIC_URL` | `https://pepelab-rwa-poc-signal-api.vercel.app` | |
| `PAY_TO` | `payto` 錢包（`WALLETS.md`） | 必須是純 EOA |

刻意不設：`X402_KYA_SPEND_STORE`（不設＝Upstash）、`X402_FEE_ROUTER`、`FEE_SETTLEMENT_PRIVATE_KEY`、`ORACLE_BENEFICIARY_ADDRESS`。

## 撤銷憑證

撤銷後把新的狀態清單（`agent/.state/rwa-poc/vc-status/<issuer>.json`）複製到本目錄 `vc-status/`，commit 進 master。
GitHub raw 的 CDN 快取約 5 分鐘，加上 checker 預設 60 秒快取，**線上生效最多延遲約 6 分鐘**。repo 必須保持 public。

## 已知限制（PoC 可接受）

- **撤銷驗證端狀態是每個 Vercel 實例各自一份**（`/tmp`，signal-api 沒有注入共享的 `setVcStatusStateStore`）。
  防回滾（sequence 高水位）與 sticky 撤銷只在同一個暖實例內成立；冷啟動的實例會接受任何仍在 `validUntil` 內、簽章正確的舊版清單。
  撤銷的保證因此等於「master 上目前的清單」。正式上線前要注入共享儲存（Upstash）。
- **`settled:true` 只代表「已排入佇列」**：Upstash 一設，記帳 ledger 也啟用，付費 `/signals` 會入列到獨立 DB 的
  `x402:settlement:queue`，但沒有結算 worker 處理它（平台 worker 用平台的 DB），所以不會有分潤上鏈。付款本身照常直接付到 `PAY_TO`。
- `/oracle` 等唯讀端點讀的是平台合約位址（與本機版相同）。
