# RWA＋SSI PoC（租戶 `rwa-poc`，Base Sepolia）

這個目錄是「RWA ＋ SSI 正式 PoC」的總覽與索引。PoC 以專屬租戶 `rwa-poc` 部署在 **Base Sepolia 測試網（84532）**，
與現有展示站使用的平台部署是兩套獨立的合約（結算幣除外，見下）；展示站不受影響。

## 目的

示範一個「參照真實世界資產（RWA）的合成衍生品平台」如何把**可驗證憑證（SSI／VC）**接到鏈上的准入與 AI 代理人委託：

- **合格投資人准入**：發證者簽發「合格投資人」VC，投資人提交後由鏈上合約驗證；沒有資格不能開 RWA 部位，撤銷後不能再開新倉、既有部位仍可平倉。
- **AI 代理人委託**：投資人以鏈上 session 設定代理人的額度與標的，並簽發委託憑證（AgentDelegationCredential v3）、鏈上錨定；代理人只能在上限內下單。
- **x402 Know-Your-Agent**：代理人付費取用訊號時必須出示委託憑證的 VP，服務端在付款前驗證身分、撤銷狀態、鏈上 session、錨定與花費上限。
- **市場時段**：美股休市時資產切成 ReduceOnly，拒絕新開倉、平倉照常。
- **揭露**：資產卡、參考價見證與償付能力三頁直接讀鏈上資料。

定位與判準見 [`docs/RWA_ALIGNMENT.md`](../../RWA_ALIGNMENT.md)；PepeLab 是**參照** RWA 的合成衍生品，不發行、不託管任何實體資產。

## 架構

部署的是 master 版整套合約（`contracts/script/DeployTenant.s.sol`，設定檔 `deploy/tenants/rwa-poc.json`，schema v4）：
`PerpetualExchange` 讀租戶自己的 `GuardedOracle`（單次偏離與時間窗上限）；准入接 admin 擁有的 `VCKycRegistry`（鏈上驗 EIP-712 合格投資人憑證、
支援撤銷、不存個資）；9 檔參照真實資產的標的（8 檔美股／ETF 與 sGOLD）在鏈上標成 RWA；逐資產模式 Active／ReduceOnly／Halted 由 keeper 以
marketOperator 身分依行事曆切換。代理人委託由租戶的 `AgentSessionManager` 執行鏈上上限，另部署 `SessionCredentialAnchor` 把委託憑證雜湊錨定到 session。
保證金結算幣沿用平台既有的測試幣 MockUSDC（`deploy/tenants/rwa-poc.json` 的 `shared.settlementToken`），與現役部署共用，不受 PoC 金鑰控制。
鏈下部分有兩種跑法：本機（signal-api、前端 `yarn dev --mode rwa-poc`），或線上 Vercel（[`ONLINE.md`](ONLINE.md)）。推價由租戶的 GitHub Actions keeper 負責。

設計細節：[`docs/SSI_RWA_ACCESS.md`](../../SSI_RWA_ACCESS.md)（VC 准入）、[`docs/SSI_AGENT_DELEGATION.md`](../../SSI_AGENT_DELEGATION.md)（委託憑證與 KYA）、
[`docs/RWA_TRANSPARENCY.md`](../../RWA_TRANSPARENCY.md)（`/rwa`、`/oracle`、`/solvency`）、[`docs/TENANT_DEPLOYMENT.md`](../../TENANT_DEPLOYMENT.md)（租戶部署流程）。

## 文件索引

| 文件 | 內容 |
|---|---|
| [`WALLETS.md`](WALLETS.md) | 10 把角色錢包（deployer、admin、risk、guardian、keeper、issuer、attestor、investor、agent、payto）的公開位址、入金交易、角色分離 |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 合約位址與建立交易、部署後設定、碳分級見證、S4 推價與休市示範的交易 |
| [`RUNBOOK.md`](RUNBOOK.md) | keeper 推價、休市切換、時段注意事項 |
| [`FRONTEND.md`](FRONTEND.md) | 本機前端切換到租戶部署的方式、行為差異、S5 驗收紀錄 |
| [`X402_KYA.md`](X402_KYA.md) | 本機 signal-api 開啟 x402 KYA、三個案例的實測結果、撤銷狀態清單 |
| `POC_SCRIPT.md` | 錄影劇本（10 景、每景的操作者、旁白、交易、備援）、錄影前檢查、重跑、後製與補拍流程、實跑紀錄。在 #286（`feat/rwa-poc-recording`），合併後出現在本目錄 |

完整位址只寫在本目錄、`deploy/tenants/`、前端的部署登記（`frontend/src/contracts/deployments/rwa-poc.json`）與廣播紀錄
（`contracts/broadcast/tenants/rwa-poc/`）。其他文件只寫縮寫，原因見 [`docs/HANDOFF_RWA_POC.md`](../../HANDOFF_RWA_POC.md) 第 2 節。

## 如何重現

前提：加密 keystore 放在 `~/.foundry/keystores/pepelab-rwa-<角色>`，密碼檔在 `~/.foundry/pepelab-rwa-<角色>.password`（見 [`WALLETS.md`](WALLETS.md)）；
Foundry、Node.js 20 以上、yarn 已安裝，`agent/` 已 `npm ci`、`frontend/` 已 `yarn install`。所有指令在 repo 根目錄執行。

| 服務 | 指令 | 說明 |
|---|---|---|
| keeper（推價＋休市切換） | `bash scripts/poc/rwa-poc-keeper.sh` | 先乾跑一輪 `failed=0` 才進迴圈；每 60 秒一輪。`--once` 只跑一輪，`--no-market-operator` 不自動切休市（[`RUNBOOK.md`](RUNBOOK.md)） |
| 手動切休市 | `bash scripts/poc/rwa-poc-market-mode.sh <資產> 0\|1` | 0＝Active、1＝ReduceOnly；先模擬再送 |
| 前端 | `scripts/poc/rwa-poc-frontend.sh` 後 `cd frontend && yarn dev --mode rwa-poc` | 產生 `frontend/.env.rwa-poc.local`（已被 gitignore）；錄影時加 `--status-url http://localhost:8787/vc` 並以 `--port 4173` 起（[`FRONTEND.md`](FRONTEND.md)） |
| signal-api（x402 KYA） | `bash scripts/poc/rwa-poc-x402.sh server` | port 4021；`X402_KYA_MODE=on`、錨定 required；要在沒有 `agent/.env` 的 checkout 執行（[`X402_KYA.md`](X402_KYA.md)） |
| 撤銷狀態清單主機（#286 合併後） | `node scripts/poc/rwa-poc-status-server.mjs --mount investor=… --mount vc=…` | 只綁 127.0.0.1、port 8787；掛載路徑見 `POC_SCRIPT.md` §2 |
| 錄影（#286 合併後） | `cd scripts/poc/video && node record.mjs --scenes scenes/rwa-poc-full.mjs --base http://localhost:4173 --allow-tx` | 後製 `node postprocess.mjs --main out/<完整版>.json --frames`；前提與重置見下 |

錄影前提：

- 錄影工具第一次使用：`cd scripts/poc/video && npm ci && npx playwright install chromium`，另需 `ffmpeg`（轉 mp4 與後製）。
- 重跑整片前先 `bash scripts/poc/rwa-poc-rehearsal-reset.sh`（#286 合併後），把投資人恢復成「沒有資格、沒有部位」。它要知道哪些 session 是 x402 用的、
  不能撤銷：以 `X402_ROOT` 指向含 `agent/.state/rwa-poc/x402/*.json` 的 checkout，或直接給 `KEEP_SESSIONS="0 1"`；兩者都沒有時腳本會停下。
- 成片 `PepeLab-RWA-SSI-PoC-final.mp4` 由後製產生在 `scripts/poc/video/out/`，**不進版控**，直接交付給使用者。

讀回驗收（唯讀）：

```bash
node scripts/check-tenant-deploy.mjs
node scripts/post-deploy-smoke.mjs --tenant rwa-poc --skip-http          # 只做鏈上檢查
node scripts/post-deploy-smoke.mjs --tenant rwa-poc --signal-api http://localhost:4021   # 本機 signal-api 在跑時，連 HTTP 一起查
cd contracts && TENANT=rwa-poc forge script script/VerifyTenant.s.sol:VerifyTenant --rpc-url https://sepolia.base.org -vv
```

S3 上線當下那次 `VerifyTenant` 是加 `TENANT_PRIVILEGE_SCAN_REQUIRED=true` 跑的（[`docs/TENANT_DEPLOYMENT.md`](../../TENANT_DEPLOYMENT.md) 的規定：權限歷史事件掃描不得略過，否則整體失敗）。
日常讀回可不加；部署區塊距今超過 `TENANT_PRIVILEGE_SCAN_MAX_BLOCKS`（預設 50,000）時，不加的話權限歷史掃描會以 NOTE 略過。

## 驗收結果摘要（2026-10-07）

| 階段 | 結果 | 紀錄 |
|---|---|---|
| S3 部署 | `DeployTenant` 164 筆交易全部成功；真鏈 `VerifyTenant` 131 項 ok、0 FAIL，權限歷史掃描通過；smoke 32 PASS；發證者、attestor、11 檔碳分級、`SessionCredentialAnchor` 完成 | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| S4 推價與休市 | keeper 一輪寫入 11 檔、`failed=0`；sETH 示範 ReduceOnly 時開倉被拒（`AssetNotActive`，鏈上 status 0）、平倉成功 | [`DEPLOYMENT.md`](DEPLOYMENT.md)「營運驗收」 |
| S5 前端 | 本機 `/rwa`、`/oracle`、`/solvency`、`/sessions`、`/credentials`、`/portfolio`、`/terminal` 讀到租戶部署；展示站測試照常通過 | [`FRONTEND.md`](FRONTEND.md) |
| S6 x402 KYA | 不帶 VP → `403 kya_presentation_required`；超過憑證花費上限 → `403 kya_spend_limit_exceeded`；帶 VP 真 USDC 實付兩筆各 0.01 成功（2026-10-08，[`0x2b9fa83c…`](https://sepolia.basescan.org/tx/0x2b9fa83cccf278fa6fa7d70314eca68461a84304b3ad19798da91fe4d9283911)、[`0xba9d7d2e…`](https://sepolia.basescan.org/tx/0xba9d7d2ea945d0ef24ba2cd0fe13da6fad796888bf8e416c4eedf158a43e7d27)），累計到上限 0.02 後再付被拒 | [`X402_KYA.md`](X402_KYA.md) |
| S7 劇本與實跑 | 10 景一次跑通（2026-10-07 03:01 UTC），第 6 景 2026-10-08 以實付補拍替換；成片 7 分 41 秒、1920×1080 | [`POC_SCRIPT.md`](POC_SCRIPT.md) §7、§8 |

成片的 10 景：

1. 發證者簽發「合格投資人」VC（離線簽名）。
2. 未持證開 sGOLD 被拒（前端停用並提示；鏈上 `NotKycVerified`，status 0）。
3. 投資人在 `/credentials` 提交 VC，鏈上驗證後具資格。
4. 持證後開 sGOLD 多單成功。
5. 投資人為代理人開 session、簽發委託憑證 v3、錨定。
6. x402 KYA：不帶 VP 被拒；帶 VP 用真測試 USDC 實付兩筆（BaseScan 可查）；累計超過憑證上限後被拒、不扣款。
7. 代理人在 session 上限內下單成功；超過單筆上限的模擬回 `MarginExceedsPerTradeCap()`。
8. 休市：sAAPL 在 ReduceOnly，新開倉被拒（鏈上 `AssetNotActive`，status 0）。
9. 撤銷資格後投資人與代理人新開倉都被拒（模擬回 `NotKycVerified`），既有部位兩筆平倉成功。
10. `/rwa`、`/oracle`、`/solvency` 揭露頁。

## 已知限制（展示時照實說明）

- **測試網**：全部在 Base Sepolia。保證金是沿用平台既有的測試幣 MockUSDC（與現役部署共用，不受 PoC 金鑰控制），不是真錢；保險金庫只有部署時的 1 USDC 種子。部位是合成 CFD 曝險，背後沒有任何實體股票或黃金。
- **發證者與見證者是自己的測試錢包**：合格投資人 VC 的發證者、ESG 碳分級的 attestor 都由 PoC 團隊控制，不是持牌 KYC 機構或第三方驗證機構；「合格投資人」只是示範身分，沒有做真實的身分審查。
- **參考價**：價格由本機 keeper 從公開行情寫入；oracle 沒有獨立參考來源（`referenceSource: none`），寫價只受 `GuardedOracle` 的單次上限與時間窗限制。
- **KYA 花費帳在記憶體**：`X402_KYA_SPEND_STORE=memory`，signal-api 重啟後歸零；VP 防重放集合同樣在記憶體（舊付款仍會被 EIP-3009 nonce 擋下）。
- **x402 第 6 景是補拍**：實付在 2026-10-08 另錄後插回成片（其餘 9 景是 2026-10-07 的一次完整錄影）；實付過程中有一次 facilitator 回 402、未扣款，片中照實呈現。結算走公開 facilitator `x402.org`，不是自己營運的結算服務。
- **sAAPL 交易時段**：keeper 在美股正規盤以外、以及收盤前 3 小時就切 ReduceOnly，台灣白天 sAAPL 不能開新倉。成片主線改用 sGOLD（只在週末切），sAAPL 用來示範休市（[`RUNBOOK.md`](RUNBOOK.md)）。
- **sGOLD 槓桿 1 倍**：sGOLD 碳分級 3 級，交易所槓桿上限 1 倍。
- **signal-api 綁所有網卡**：`index.ts` 沒有 hostname 設定，會監聽 `*:4021`，同一區網的機器也連得到。錄影時用可信任的網路，或以本機防火牆擋掉 4021 的對外連線。
- **線上版與本機版並存**：線上前端與 signal-api 在 Vercel（[`ONLINE.md`](ONLINE.md)，撤銷狀態清單放在本 repo 的 `vc-status/`）；本機版照 [`RUNBOOK.md`](RUNBOOK.md)。推價由 GitHub Actions keeper（`keeper-rwa-poc.yml`）負責，本機 keeper 腳本不要同時跑。
- **未在 BaseScan 驗證原始碼**：需要 BaseScan API key，尚未設定。
- **合約未經外部稽核**：`VCKycRegistry`、`SessionCredentialAnchor` 是新合約，只經過 repo 內的對抗式審查與測試。
- **前端小限制**：終端機資產列的鎖頭圖示只看靜態表，sGOLD 不顯示鎖頭，但下單面板仍會擋（[`FRONTEND.md`](FRONTEND.md)）。
- **金庫代幣可轉讓**：本租戶 `deployVault: true`，AssetVaultV2 的合成代幣是一般 ERC-20（[`docs/RWA_ALIGNMENT.md`](../../RWA_ALIGNMENT.md) C4）。
- **金庫繞過 KYC 與休市**：金庫的 `mint` 不查合格投資人憑證，也不看休市，交易所擋下的錢包可以改從金庫鑄出同樣的合成曝險，週末也能用週五收盤價鑄贖（[`docs/KNOWN_LIMITATIONS.md`](../../KNOWN_LIMITATIONS.md) #33、#34）。示範不用金庫時，可由 `guardian` 暫停金庫；下次部署 PoC 建議改成 `deployVault: false`。
