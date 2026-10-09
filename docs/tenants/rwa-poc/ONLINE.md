# RWA PoC 線上部署（Vercel）

本機版見 [`RUNBOOK.md`](RUNBOOK.md)。線上版與本機版跑同一份程式，差別只在設定。平台的展示站與平台 signal-api 不受影響。

| 服務 | Vercel 專案 | 網址 | Root Directory |
|---|---|---|---|
| 前端（`VITE_TENANT=rwa-poc`） | `pepelab-rwa-poc` | <https://pepelab-rwa-poc.vercel.app> | `frontend` |
| signal-api（x402 KYA） | `pepelab-rwa-poc-signal-api` | <https://pepelab-rwa-poc-signal-api.vercel.app> | `agent/signal-api` |

兩個專案都連到本 repo；`vercel.json` 的 `git.deploymentEnabled` 讓 master 自動部署。

**只改環境變數時**，git 觸發的部署會被 `scripts/vercel-ignore-build.sh` 判定「沒有變更」而取消，`vercel redeploy` 也會
（而且 redeploy 沿用舊 commit）。要讓新環境變數生效，從 master 匯出乾淨檔案，用 CLI 直接部署：

```bash
D=$(mktemp -d) && git archive origin/master | tar -x -C "$D" && cd "$D"
vercel link --yes --project pepelab-rwa-poc-signal-api && vercel deploy --prod --yes
rm -rf .vercel && vercel link --yes --project pepelab-rwa-poc && vercel deploy --prod --yes
```

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

## 驗收紀錄（2026-10-09）

master `e7140b7`，兩個專案以上面的 CLI 方式部署，皆 Ready。

| 項目 | 結果 |
|---|---|
| 前端 `/`、`/rwa`、`/oracle`、`/solvency`、`/credentials` | HTTP 200 |
| signal-api `/healthz` | `ok` |
| 無效輸入 `/signals/` | 400，在付費牆之前擋下、未收費 |
| 新憑證 `main2` | session #7 [`0xbec5…c132`](https://sepolia.basescan.org/tx/0xbec53f1f995866d9e71f257f55aebccc2f4e6943ed2adde598d207e063e1c132)、錨定 [`0xd36d…2087`](https://sepolia.basescan.org/tx/0xd36de0a7d52e028f860cfd105cb81375c77699d73b8e2a6bf121b3feb9202087) |
| 不帶 VP | 403 `kya_presentation_required` |
| 帶 VP 付 0.01 測試 USDC | 200，結算 [`0xe2cd…f55a`](https://sepolia.basescan.org/tx/0xe2cd099618cc81037c81afe25418734ae8fb27c2d56e6d9b937b64d9e1d4f55a)；`X-Agent-KYA-Spend: total=10000`（花費帳寫入 Upstash） |

driver 指向線上：在 s6 worktree 的 `agent/` 以 `RWA_POC_SIGNAL_API=https://pepelab-rwa-poc-signal-api.vercel.app`
`RWA_POC_RPC_URL=https://base-sepolia-rpc.publicnode.com` 跑 `npx tsx examples/rwa-poc-x402.ts call <label> <vp|novp> 1`
（`rwa-poc-x402.sh pay` 只檢查本機 `localhost:4021`）。
