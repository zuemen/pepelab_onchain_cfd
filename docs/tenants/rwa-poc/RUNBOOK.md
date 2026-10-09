# RWA PoC 營運手冊：keeper 推價與休市切換

本機跑 RWA PoC 租戶（`rwa-poc`，Base Sepolia）的價格 keeper，以及手動切換休市模式。錢包與角色見 [`WALLETS.md`](WALLETS.md)。
平台的 keeper 是 GitHub Actions 排程；PoC 租戶的 workflow `keeper-rwa-poc.yml` 已由範本產生（見下方「GitHub Actions keeper」），
但要等 environment 與 secret 設好、合併進 master 之後才會排程執行。在那之前，錄影或展示期間在本機跑這裡的腳本。

## 前提

- 已部署：`frontend/src/contracts/deployments/rwa-poc.json` 是 `kind: "dedicated"`，`deploy/tenants/rwa-poc.json` 是 `status: "deployed"`。
  兩支腳本的位址與註冊資產都只從這兩份已審查的檔案讀（經 `ops/tenant-keeper/load-env.mjs`，與租戶 workflow 相同），
  不吃殼層裡的 `EXCHANGE`、`RELAY_SOURCE` 之類變數。部署前執行會直接停下並說明原因。
- keeper keystore 在 `~/.foundry/keystores/pepelab-rwa-keeper`，密碼檔 `~/.foundry/pepelab-rwa-keeper.password`（只有自己可讀）。
- keeper 錢包有 Base Sepolia ETH（每輪約 1e-4 ETH 以下；0.1 ETH 夠跑很多天）。
- Foundry（`cast`）在 PATH 上，`agent/` 已 `npm ci`。

## 啟動 keeper

```bash
bash scripts/poc/rwa-poc-keeper.sh                       # 每 60 秒一輪，Ctrl-C 結束
bash scripts/poc/rwa-poc-keeper.sh --once                # 只跑一輪
bash scripts/poc/rwa-poc-keeper.sh --no-market-operator  # 不自動切休市
```

腳本依序做：

1. 從登記檔載入 oracle、exchange、金庫、註冊資產與 `roles.keeper`。
2. 檢查 RPC 是 Base Sepolia（84532），以及 oracle 鏈上的 `referenceSource()` 等於設定（PoC 是 `none`）。
3. 用 `cast wallet address --account pepelab-rwa-keeper` 推出地址，必須等於 `roles.keeper`，否則不送任何交易。
4. 先 `DRY_RUN=1` 跑一輪（不送交易），摘要行 `failed=0` 才繼續。
5. 以 keystore 模式（`KEEPER_KEYSTORE`＋`KEEPER_KEYSTORE_PASSWORD_FILE`）每輪送交易。私鑰只在 `keeper/run.ts`
   行程的記憶體裡解開（`agent/keeper/keySource.ts`），不經過環境變數、指令列或檔案。

`keeper/run.ts` 以 `env -i` 啟動，環境只有白名單：`PATH`、`HOME`、鏈與 RPC、登記檔給的位址與資產、
`KEEPER_HEARTBEAT=240`、`KEEPER_MARKET_OPERATOR`、`DRY_RUN`（只在乾跑那輪）與 keystore 兩個變數。
殼層裡殘留的 `KEEPER_PRIVATE_KEY`、`RELAY_SOURCE`、`KEEPER_EXCHANGE_ADDRESS`、門檻參數（`KEEPER_DEVIATION` 等）都進不去。

`KEEPER_HEARTBEAT` 預設 240 秒：價格沒變也會在 4 分鐘內重寫一次，所以 11 檔都會在 5 分鐘內更新。
可調的環境變數只有：`KEEPER_RPC_URL`（預設 `https://sepolia.base.org`）、`POC_TENANT`（預設 `rwa-poc`）、
`POC_KEEPER_ACCOUNT`（預設 `pepelab-rwa-keeper`）、`POC_KEEPER_INTERVAL`（預設 60，最少 15）。

## GitHub Actions keeper（`keeper-rwa-poc.yml`）

`.github/workflows/keeper-rwa-poc.yml` 由範本產生（`node scripts/gen-tenant-keeper.mjs rwa-poc`），**不要手改**：
`scripts/check-workflow-guards.mjs` 會重新產生並逐位元比對。位址同樣只由 `ops/tenant-keeper/load-env.mjs` 從登記檔讀，
workflow 裡沒有任何位址。做的事與本機腳本相同（核對參考來源、核對金鑰地址＝`roles.keeper`、餘額檢查、推價、
休市切換），另外多了熔斷告警 issue 與 funding crank（`settleFunding`，本機腳本不做）。

| 項目 | 值 |
|---|---|
| GitHub environment | **`keeper-rwa-poc`**（名稱固定，CI 會檢查；Deployment branches 只允許 `master`；不要設 required reviewers／wait timer） |
| environment secret | `TENANT_KEEPER_PRIVATE_KEY`（keeper 私鑰）、`TENANT_RPC_URL`（Base Sepolia RPC）。**不要**放在 repo 層級 |
| 排程 | 名目 `*/15`（GitHub 實際 68–169 分鐘）；`ops/keeper-trigger` 的 Worker 已把它列進 `WORKFLOW_FILES`（重新 `wrangler deploy` 之後生效），超過 15 分鐘沒跑就補觸發 |
| heartbeat | 用 `keeper/run.ts` 預設 900 秒（本機腳本是 240 秒）；休市切換預設開啟 |
| concurrency | `keeper-key-rwa-poc`（不與平台 keeper 排隊） |

步驟與理由見 [`docs/TENANT_OPERATIONS.md`](../../TENANT_OPERATIONS.md) §1.2–§1.4。**先建 environment、先放 secret，再合併 workflow**：
GitHub 遇到不存在的 environment 會自動建一個沒有保護的同名 environment；secret 沒放時 workflow 第一步就會失敗。

手動觸發一輪（合併進 master 之後才可用；`workflow_dispatch` 只認預設分支上的檔案）：

```bash
gh workflow run keeper-rwa-poc.yml
gh run list --workflow keeper-rwa-poc.yml --limit 3
```

> **本機腳本與 Actions 不要同時跑——兩者是同一把 keeper 金鑰。**
> 兩邊在送交易前都核對金鑰推出的地址必須等於 `deploy/tenants/rwa-poc.json` 的 `roles.keeper`（本機用 keystore
> `pepelab-rwa-keeper`，Actions 用 `TENANT_KEEPER_PRIVATE_KEY`），而 `roles.keeper` 只有一個，所以
> `TENANT_KEEPER_PRIVATE_KEY` 必然就是 keystore `pepelab-rwa-keeper` 裡的那把私鑰。同一個地址從兩個行程同時送交易會撞
> nonce（`nonce too low`／`replacement transaction underpriced`），這一輪就會 `failed>0`。
> 要在本機跑（例如錄影時要 `--no-market-operator`），先到 repo → Actions → Keeper (rwa-poc) → **Disable workflow**
> （或 `gh workflow disable keeper-rwa-poc.yml`），並確認沒有執行中的 run；跑完再 `gh workflow enable keeper-rwa-poc.yml`。
> 停用期間 keeper-trigger Worker 的 dispatch 會被 GitHub 拒絕（Worker log 會出現這支的錯誤，屬預期），不會繞過停用。

## 休市切換

keeper 預設會自動切換（`agent/keeper/operator.ts`）：

- 股票與 ETF：正規盤以外切成 ReduceOnly，**收盤前 3 小時**就先收緊；開盤且報價新鮮時切回 Active。
- sGOLD：只在週末切。
- sBTC、sETH：不切。

ReduceOnly 時新開倉會被拒（`AssetNotActive`），平倉照常可以。

手動切換（先 `cast call --from` 模擬，通過才送）：

```bash
bash scripts/poc/rwa-poc-market-mode.sh sAAPL 1   # ReduceOnly
bash scripts/poc/rwa-poc-market-mode.sh sAAPL 0   # Active
```

exchange 與註冊資產同樣經 `load-env.mjs` 讀；資產必須是 `rwa-poc` 註冊的。只接受 0（Active）與 1（ReduceOnly）。marketOperator 不能切 Halted；guardian 鎖住的資產只有 owner（admin）能放寬，
這時用 `POC_MODE_ACCOUNT=pepelab-rwa-admin`。腳本會印出交易 hash 與 BaseScan 連結，並讀回確認。

## 注意事項

- **台灣白天美股休市**。美股正規盤是美東 09:30–16:00，台灣時間 21:30–04:00（11 月 1 日後冬令時間為 22:30–05:00）。
  keeper 開著自動切換時，白天的股票都是 ReduceOnly，「開 sAAPL 部位」那一步會被拒。白天錄影要示範開倉時，
  用 `--no-market-operator` 跑 keeper，再用上面的手動切換把 sAAPL 設回 Active，並在影片裡說明「示範用，手動開市」。
  休市示範則反過來：手動切成 ReduceOnly → 開倉被拒 → 平倉成功。
- **部署後 30 分鐘內不能開倉**：`DeployTenant` 最後的 `unpause()` 會啟動 30 分鐘清算寬限期，這段時間不能開倉、也不會清算。
- **碳分級寫入之前每檔都是 Unrated**：槓桿上限 1 倍、費率最高那一級（fail-closed）。attestor 用 `AttestTenantCarbon.s.sol`
  寫入分級之後才會放寬（見 `docs/TENANT_DEPLOYMENT.md`）。見證者是 PoC 團隊自己，展示時要照實說明。
- 價格超過 exchange 的 `maxPriceAge`（6 小時）會擋開倉。錄影前先 `--once` 跑一輪確認。
- 公開 RPC 偶爾 DNS 失敗或 nonce 快取不準。換 `KEEPER_RPC_URL` 到另一個 Base Sepolia 節點即可；keeper 每輪自己管 nonce。
- 本機腳本不做 funding 結算（`settleFunding`）。展示不需要；GitHub Actions keeper（`keeper-rwa-poc.yml`）每輪會做。
