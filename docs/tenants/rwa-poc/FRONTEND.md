# RWA PoC 前端（本機）

預設展示站（沒設 `VITE_TENANT`）連的是平台部署，不受影響。要看 rwa-poc 專屬部署：

```bash
scripts/poc/rwa-poc-frontend.sh            # 產生 frontend/.env.rwa-poc.local（.gitignore 已排除）
cd frontend && yarn dev --mode rwa-poc
```

- 合約位址來自 `frontend/src/contracts/deployments/rwa-poc.json`（`check-tenant-deploy.mjs --print-frontend`
  產生的 dedicated 登記，CI 對帳）。部署前它是 `kind: "platform"` 佔位，腳本會拒絕產生設定。
- `SessionCredentialAnchor` 不在部署紀錄裡：腳本讀本目錄 `DEPLOYMENT.md` 中那一行的位址，或用 `--anchor 0x…`。
  覆寫只套用到 Base Sepolia（`VITE_SESSION_ANCHOR_CHAIN_ID=84532`）。
- signal-api 預設 `http://localhost:4021`（`--signal-api` 可改）；專屬部署不會退回平台的 signal-api。

## 專屬部署下前端的行為

| 項目 | 做法 |
|---|---|
| KYC 登錄種類 | 登記不記種類，前端對 `contracts.KYCRegistry` 探測 `requiredType()`：成功＝VC 准入登錄（schema v4 `kycRegistry: "vc"`），函式不存在＝allowlist，讀不到＝無法確認（不當成任何一種）。`VITE_VC_KYC_REGISTRY` 在專屬部署只能等於登記那一顆，不同就忽略並在 console 警告（腳本寫成空值）。平台部署不探測。 |
| 「去取得資格」 | 交易所的 KYC 登錄是 VC 登錄時，終端機下單提示、Portfolio 的 KYC 卡、跟單頁都改為前往 `/credentials`（合格投資人憑證），不打開舊登錄的 `submitKYC` 表單；種類還在確認（探測中、讀不到、沒連錢包）時只顯示確認中，也不給舊表單。平台部署照舊。 |
| RWA 閘門 | 開倉前的 KYC 提示＝靜態表的 `regulated` **或** 鏈上 `exchange.rwaAsset(id)`。部署時追加的 RWA（`additionalRwa`，例如 sGOLD）因此也會先擋；鏈上讀不到不放寬靜態表。只在專屬部署讀鏈上旗標，平台部署不多打 RPC。 |
| `/rwa`、`/oracle`、`/solvency`、`/sessions` | 位址一律走 `src/contracts/deployment.ts` 與 `sessionManager.ts`，專屬部署讀租戶自己的 exchange、oracle、保險金、金庫與 AgentSessionManager。 |

已知限制：終端機標的列的鎖頭圖示仍只看靜態表（sGOLD 不顯示鎖頭，但下單提示會擋）。

## 驗收紀錄（S5，2026-10-07）

`yarn dev --mode rwa-poc`，以注入的投資人錢包（`0xebAF…0194`）唯讀巡覽（`scripts/poc/video/scenes/s5-verify.mjs`）：

| 頁面 | 讀到的新部署資料 |
|---|---|
| `/rwa` | 11 檔資產卡；sGOLD 鏈上 `rwaAsset` 已標記；碳分級為 attestor 寫入的分級；美股收盤時段顯示「只能減倉」 |
| `/oracle` | 鏈上價格（本機 keeper 寫入）；鏈下參考價需要本機 signal-api（S6） |
| `/solvency` | 保險金庫 1.00 USDC（部署時的種子）、金庫儲備 0、ADL 開啟 |
| `/sessions` | 租戶 AgentSessionManager 的委任流程 |
| `/credentials` | 探測到 VC 准入登錄，顯示合格投資人憑證面板（不是舊的 submitKYC 表單） |
| `/portfolio` | 交易帳戶 $199.92，與鏈上 `freeMargin(investor)` 相同；KYC 卡導向憑證頁 |
| `/terminal` | 正常載入，資產列含 sGOLD |

現有展示站不受影響：預設 build 與 frontend 全部測試照常通過（CI）。
