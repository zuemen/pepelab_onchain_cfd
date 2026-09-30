# 新增一個白標租戶

> **草案**（2026-09-30）。隔離模型與理由見 [`ADR-008-tenant-isolation.md`](ADR-008-tenant-isolation.md)，
> 前端設定層見 [`frontend/docs/adr/0009-tenant-config-layer.md`](../frontend/docs/adr/0009-tenant-config-layer.md)。
> 本文件裡**沒有任何會 broadcast 的指令**；會送交易的步驟一律由持有金鑰的人依既有程序執行。

一個租戶有兩份設定，都是 JSON、都進版本控制、都**不含任何秘密**：

| 設定 | 位置 | 決定什麼 | 誰檢查 |
|---|---|---|---|
| 前端租戶設定 | `frontend/src/tenant/tenants/<id>.json` | 品牌、色票、語系、資產白名單、揭露追加、客服與法律連結、功能授權 | `vite build`（驗證不過就失敗）、`frontend/src/tenant/*.test.ts` |
| 部署設定 | `deploy/tenants/<id>.json` | 角色地址、共用元件、金庫註冊資產、收費（待決）、keeper 排程、已部署合約位址 | `node scripts/check-tenant-deploy.mjs`（CI：`consistency.yml` 的 tenant-deploy job） |

`<id>` 是小寫英數與連字號，兩份設定用同一個 id。`default` 保留給現行正式站。

## 1. 前端租戶設定

1. 複製 `frontend/src/tenant/tenants/demo-bank.json` 成 `<id>.json`，把 `id` 改成 `<id>`。
2. 品牌素材放 `frontend/public/tenants/<id>/`，設定裡用站內路徑（例如 `/tenants/<id>/logo.svg`）。
   外部圖片網址會被拒絕——正式站的 CSP 只允許站內圖片。
3. `assets.enabled` 只能填 `frontend/src/contracts/addresses.ts` 的 `ASSET_IDS` 已有的代號，或 `"all"`。
4. `features` 每個功能有兩個值：`allowed`（這個租戶被授權使用嗎）與 `default`（環境變數沒設時開不開）。
   部署面板上的 `VITE_*` 旗標只能把已授權的功能關掉或打開，打不開 `allowed: false` 的功能。
5. 驗證與建置：

   ```bash
   cd frontend
   VITE_TENANT=<id> yarn build     # 設定不合法、id 不符、檔案不存在都會讓 build 失敗
   yarn test
   ```

6. 部署到租戶自己的 Vercel project（或其他靜態主機），環境變數設 `VITE_TENANT=<id>`。
   沒設 `VITE_TENANT` 就是 `default`——所以正式站那個 project 不需要任何改動。

## 2. 部署設定

1. 複製 `deploy/tenants/_template.json` 成 `deploy/tenants/<id>.json`，填 `tenantId` 與 `frontendTenant`（兩者必須相同，
   也與檔名相同）。`network.chainId` 只接受 84532（Base Sepolia）或 8453（Base）。
2. `secretsEnv` 只寫**環境變數名稱**（例如 `BANK_A_DEPLOYER_PRIVATE_KEY`），值放在部署者自己的 secret store
   或 GitHub Actions secrets。私鑰（64 位十六進位，帶不帶 `0x` 都算）、助記詞、RPC 網址寫進這個檔案
   會被檢查腳本擋下。
   - `$comment` 要引用部署交易，請貼**區塊瀏覽器的交易連結**（`https://sepolia.basescan.org/tx/0x…`）：
     只有緊接在 `/tx/` 之後的 `0x`＋64 位會放行，裸貼的 tx hash（不論帶不帶 `0x`）一律視為私鑰擋下。
   - 助記詞的判定是「連續 12 個以上、每個 3–8 個英文字母的單字，以空白或逗號分隔」，**大小寫不敏感**，
     所有欄位（含 `$comment`）都檢查，字串陣列會先 join 再測。
   - ⚠️ **一般英文長句可能被誤判為助記詞**：例如 `Keeper runs every fifteen minutes using the shared oracle feed
     plus its own wallet only` 剛好是 14 個 3–8 字母的單字，會被擋。這是刻意的取捨（寧可誤擋說明，也不放過
     助記詞）。被擋時把說明改寫成中文、加標點、或放進 docs 而不是設定檔即可，不要放寬檢查。
3. `roles` 先用 `<...>` 佔位值（`status: "template"`）。金鑰由持有人產生；地址確定後填入並把 `status`
   改成 `ready`。檢查腳本要求：
   - admin／keeper／guardian／risk 兩兩不同（6 組配對），keeper 不兼 treasury，部署者與 keeper 不是同一把金鑰；
   - 任何專屬地址不得與現行正式站（`addresses.ts`）或其他租戶重複；
   - `ready` 以上不得留佔位值。
4. `shared` 是允許與其他租戶共用的元件：結算幣與參考價格來源（ADR-008 的建議方案）。
5. `assets.registered` 是這個租戶的金庫要註冊的資產，必須涵蓋前端 `assets.enabled`——前端不能開一檔金庫
   沒註冊的資產。
6. `fees` 在收費模式定案前固定是 `{"status": "pending-decision", "baseFeeBps": null, "tenantMarkupBps": null}`。
7. 檢查：

   ```bash
   node scripts/check-tenant-deploy.mjs                             # 全部租戶
   node scripts/check-tenant-deploy.mjs deploy/tenants/<id>.json    # 單一租戶
   ```

## 3. 由部署設定到既有腳本（dry-run）

```bash
node scripts/check-tenant-deploy.mjs --print-env deploy/tenants/<id>.json
```

會先跑完整檢查，通過才印出既有部署腳本要的**位址類**環境變數對照（`ADMIN_ADDRESS`、`KEEPER_ADDRESS`、
`GUARDIAN_ADDRESS`、`RISK_ADDRESS`、`HandoverRoles` 的 `NEW_*`、`TREASURY` 等），不含任何秘密，也不執行任何東西。
持有金鑰的人拿這份對照，依 [`DEPLOY_129_CUTOVER.md`](DEPLOY_129_CUTOVER.md) 的階段順序，**先以不加
`--broadcast` 的模擬**跑過一次，核對輸出後才由本人決定是否廣播。`HandoverRoles.s.sol` 的
`HANDOVER_DRY_RUN` 預設就是 true。

部署完成後：

1. 把合約位址填進 `deployed`，`status` 改成 `deployed`（收費模式必須已定案，檢查腳本才會通過）。
2. 依 [`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md) 移交角色、撤銷部署者權限；exchange 的 guardian 與
   marketOperator 由 owner 設定。
3. 為這個租戶建立 keeper 排程，使用 `secretsEnv.keeperPrivateKey` 指定的 secret 名稱。

## 4. 已知缺口（尚未能完整部署一個新租戶）

- **永續交易所腳本未參數化**：`contracts/script/Redeploy129Exchange.s.sol` 把 USDC、oracle、FeeRouter、
  保險金、KYC 等位址寫成常數，不能直接用於新租戶。需要先改成讀環境變數（ADR-008 遷移路徑階段 1）。
- **前端還不能指向租戶自己的合約**：位址唯一來源 `addresses.ts` 目前只有一套；需要擴充成依租戶的多組
  位址並同步擴充 `consistency.yml`（階段 2）。在那之前，前端租戶只能換品牌與政策。
- **keeper workflow 未依租戶展開**：現有 workflow 只服務現行部署。
- **收費模式待決**：base fee＋租戶 markup 的數字與收取方式（鏈上需要新版 FeeRouter）。
- **agent 端（signal-api、MCP server、Telegram bot）沒有租戶概念**：回應內容與 x402 收款地址仍是單一平台的。
