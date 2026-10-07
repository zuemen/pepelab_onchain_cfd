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
