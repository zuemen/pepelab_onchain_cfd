# 交接：RWA ＋ SSI 正式 PoC（2026-10-06 18:00 台灣時間）

給下一台電腦／下一個 session 接手用。目標是把 PepeLab 做成**標準的 RWA 衍生品平台 PoC**：SSI（可驗證憑證）真正接上 RWA 准入與 AI 代理人委託，部署到 Base Sepolia 新的一套合約，達到**可以錄 PoC 影片**的程度。

文末「接續 prompt」可以直接貼給新的 Claude Code session。

---

## 1. 目前狀態

- **master**：#268 合併後（2026-10-06 19:00）。CI 全綠，Dependabot 警示 0。
- **展示站**：<https://pepelab-onchain-cfd-djot.vercel.app>（Base Sepolia 84532，舊版合約；主鏈設定 `PRIMARY_CHAIN_ID = 84532`）。
- **鏈上現役合約是舊版**：交易所 `0x827e…` 沒有 guardian、休市停單（asset mode）；owner 是 `0x27C2…A585`，**金鑰不在手上**，所以現役合約的設定改不了。PoC 要用**新金鑰重新部署一整套**（使用者已同意）。

### 2026-10-05～06 已合併

| PR | 內容 |
|---|---|
| #253 | x402 結果未知交易的自動對帳（唯一入帳路徑：同一 receipt 的 AuthorizationUsed＋Transfer→payTo；授權層級入帳標記） |
| #254 | 保險金庫重部署腳本 RedeployInsuranceStack |
| #255 | GuardedOracle：admin 解除暫停不再清掉 guardian 暫停紀錄 |
| #256 | 租戶部署經 InsuranceSeeder 單筆交易存保險金庫種子 |
| #257 | VerifyTenant 權限事件掃描在 CI 實跑 |
| #258 | actions 升級（取代 #183），更新釘選雜湊 |
| #259 #264 #261 #265 #260 | 風險模型＋Besu 計畫 Phase 0–4（`docs/PARAMS_INVENTORY.md`、`risk_model/`、`docs/RISK_MODEL_CFD.md`、`besu/`、`docs/BESU_CALIBRATION.md`、`docs/DESIGN_BESU.md`） |
| #266 | `docs/RWA_ALIGNMENT.md`：RWA 判準與 PepeLab 評分、補強方案 |
| #267 | **SSI → RWA 准入**：`VCKycRegistry`（實作 IKyc，鏈上驗 EIP-712 合格投資人證明、信任 epoch、撤銷、不存個資）、發證服務、前端提交憑證、`DeployVCKycRegistry.s.sol`、PoC 腳本 `scripts/poc/rwa-ssi-demo.*`、`docs/SSI_RWA_ACCESS.md` |
| #268 | RWA 資產卡 `/rwa`、參考價見證看板 `/oracle`、儲備與償付能力頁 `/solvency`、signal-api 免費端點 `/reference-prices`（審查 6 項已修） |
| #269 | 可用性稽核與修正：公開節點 eth_getLogs 上限降為 500 塊，chainLogs 改 400 塊＋自動對半重試；`docs/USABILITY_AUDIT_2026-10-06.md` |

### 還開著的 PR

| PR | 分支 | 狀態 | 接手要做的事 |
|---|---|---|---|
| #270 | `feat/ssi-delegation-kya` | **SSI 委託授權**：AgentDelegationCredential v3（W3C VC 2.0、did:pkh、EIP-712）、新合約 `SessionCredentialAnchor`、x402 KYA（`X402_KYA_MODE`，預設 off；付款前驗 VP＝憑證主體＝付款人、撤銷、鏈上 session、錨定、重放、依憑證累計花費）、前端 `/sessions`、PoC 腳本 `scripts/poc/agent-delegation-demo.sh`、`docs/SSI_AGENT_DELEGATION.md`。CI 15 項綠，**尚未審查** | 先合 master（和 #267 在 `agent/package.json` test 行、`frontend/vitest.pinnedEnv.ts` 有相鄰新增，手動合併）。做一次對抗式審查（合約權限、VP 重放與綁定、花費累計的原子性與退回、x402 v1／v2 兩條路徑、fail-closed、揭露），修正後合併 |

---

## 2. 計劃表

預估是「AI 實際工作時數」，不含等使用者入金或設定的時間。每個階段做完才進下一個；驗收沒過不能往下。

| 階段 | 做什麼 | 驗收標準（全部成立才算完成） | 預估 | 需要使用者 | 狀態 |
|---|---|---|---|---|---|
| **S0 環境** | clone、`git submodule update --init --recursive`、裝相依（frontend `yarn install`、agent `npm ci`）、讀交接與相關文件 | `forge build` 成功；`yarn --cwd frontend test` 與 `npm test`（agent）各跑一次全過；`gh auth status` 是 zuemen | 0.5–1 h | 裝工具、`gh auth login`（見第 3 節） | 未開始 |
| **S1 #270** | 合 master 解衝突 → 另一個 agent 對抗式審查（合約權限、VP 重放與綁定、花費累計原子性與退回、x402 v1／v2、fail-closed、揭露）→ 修正 → 複審 | CI 全綠、審查無未解的高中風險、已合併 | 2–4 h | 無 | 未開始 |
| **S2 部署金鑰** | 已在舊電腦建立加密 keystore `pepelab-rwa-deployer`（`0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE`）並跨鏈入金 0.8 ETH。新電腦只要確認使用者已把 keystore 與密碼檔放好（第 3.0 節） | `cast wallet address --account pepelab-rwa-deployer --password-file ~/.foundry/pepelab-rwa-deployer.password` 等於 `0xF52D…49eE`；餘額 ≥ 0.5 ETH | 0.1 h | **複製 keystore 與密碼檔**（第 3.0 節） | 舊電腦已入金，待新電腦確認 |
| **S3 部署整套** | 用 `DeployTenant.s.sol` 部署 master 版整套到 Base Sepolia；部署 `VCKycRegistry`、`SessionCredentialAnchor`；接 `setKycRegistry`、`setRwaAsset`（含黃金）、marketOperator、guardian；寫入碳分級見證；先模擬再廣播 | 部署紀錄 JSON 進 repo；`post-deploy-smoke.mjs` 對新部署無 FAIL（外洩地址檢查必須全 PASS）；合約在 BaseScan 驗證原始碼（有 API key 時） | 3–5 h | 可選：BaseScan API key | 未開始 |
| **S4 推價與休市** | 本機跑 keeper 以新金鑰推價；跑休市切換（ReduceOnly）；寫一鍵啟動腳本 | 11 檔價格都在 5 分鐘內更新；休市時新開倉被拒、平倉可行（實際交易 hash） | 1–2 h | 無 | 未開始 |
| **S5 前端接新部署** | 以租戶設定或環境變數切換「RWA PoC」位址，**不弄壞現有展示站**；本機 `yarn dev` 可用；有權限時開 Vercel preview | 本機頁面讀到新部署的資料；`/rwa`、`/oracle`、`/solvency`、`/sessions`、KYC 憑證面板都能用；現有展示站的測試仍全過 | 3–4 h | 可選：Vercel 權限（見第 3 節） | 未開始 |
| **S6 x402 KYA** | 本機跑 signal-api：`PAY_TO`＝新收款地址、`X402_KYA_MODE` 開啟；代理人錢包用測試 USDC 實付 | 一筆真的 x402 付款成功（有 tx hash）；不帶 VP 被拒；超過憑證花費上限被拒 | 1–2 h | **代理人錢包的測試 USDC**（見第 3 節） | 未開始 |
| **S7 PoC 劇本與實跑** | 寫 `docs/POC_SCRIPT.md`（每步：操作、預期畫面、要說的話、交易 hash、BaseScan 連結、預錄備援）；照劇本在 Base Sepolia 從頭跑一遍 | 劇本每一步都有實際 tx hash；整條故事線一次跑通；只用真實截圖 | 3–4 h | 無 | 未開始 |
| **S8 文件收尾** | 更新 `RWA_ALIGNMENT.md` 方案狀態、`RELEASE_STATUS.md`（新部署）、README 部署段落、本交接文件狀態 | 文件與鏈上一致；CI 綠；推上 GitHub | 1–2 h | 無 | 未開始 |
| **合計** | | | **約 15–24 h** | | |

### 各階段細節

1. ~~合併 #268~~（已於 10/6 合併）。
2. **審查並合併 #270**（見上表）——**從這裡開始**。
3. **新部署金鑰（已完成）**：keystore `pepelab-rwa-deployer`（`0xF52D…49eE`）已在舊電腦建立並跨鏈入金 0.8 ETH；使用者用隨身碟把 keystore 與密碼檔放到新電腦（第 3.0 節）。新電腦先驗證地址與餘額，再進 S3。
4. **部署新的一整套到 Base Sepolia**（master 版，含 guardian、休市 asset mode、GuardedOracle、InsuranceVault virtual shares）：
   - 先決定用哪支腳本：`contracts/script/DeployTenant.s.sol`（會接 ESGRegistryV2，碳定價啟用；新資產預設 Unrated＝1x，要用部署者當 attestor 寫入碳分級，並在文件照實說明「見證者是自己」）或 `Deploy.s.sol`（esgRegistry＝0，碳定價停用）。**建議 DeployTenant**，因為碳強度定價是題目主軸。
   - 部署 `VCKycRegistry`（`DeployVCKycRegistry.s.sol`，`VC_KYC_CHAIN_ID=84532`）、`SessionCredentialAnchor`；在新交易所 `setKycRegistry`、`setRwaAsset`（股票、債券、ESG ETF、**黃金也要標**）；設 marketOperator 與 guardian。
   - 每一步先 `--simulate`／不廣播跑一次，再 `--account pepelab-rwa-deployer --broadcast --slow`；完成後用 `scripts/post-deploy-smoke.mjs` 與 `scripts/check-deployment-status.mjs` 讀回驗收。
   - **嚴禁**用舊電腦 `contracts/.env` 的 `PRIVATE_KEY`：那把是外洩地址 `0xE80A…Eb93`。
5. **價格與 keeper**：新部署要有人推價。錄影期間可在本機跑 keeper（`agent/` 的 keeper 程式，以新部署者或另一把新 keeper 金鑰），並跑休市切換（ReduceOnly）。若要 GitHub Actions 自動推價，需要使用者把新 keeper 私鑰放進 GitHub environment——那是使用者的操作。
6. **前端接新部署**：不要弄壞現有展示站。做法建議：以租戶設定或環境變數切換一組「RWA PoC」位址（參考 `deploy/tenants/` 與前端既有的租戶／位址機制），新增文件說明怎麼切。
7. **x402 收費**：PoC 錄影時在本機跑 signal-api（`X402_KYA_MODE` 開啟、`PAY_TO`＝新的收款地址），Vercel 線上的環境變數由使用者改。
8. **PoC 錄影劇本** `docs/POC_SCRIPT.md`：一條完整的故事線——
   發證者簽發「合格投資人」VC → 投資人提交、鏈上驗證 → 開 sAAPL 部位（未持證先示範被拒）→ 投資人簽發委託 VC v3 給 AI 代理人並錨定 → 代理人出示 VP 付 x402 取得訊號 → 代理人在 session 上限內下單、超額被拒 → 休市時 ReduceOnly 拒絕新開倉 → 撤銷憑證後代理人與投資人都被拒、既有部位可平倉 → `/rwa`、`/oracle`、`/solvency` 三頁展示揭露與償付能力。每一步附交易 hash 與 BaseScan 連結、要說的話、預錄備援。
9. **文件收尾**：更新 `docs/RWA_ALIGNMENT.md` 各方案狀態、`docs/RELEASE_STATUS.md`（新部署）、README 的部署段落。

### Demo 風險（`docs/USABILITY_AUDIT_2026-10-06.md`）

- keeper 排程不穩（GitHub cron 最長延遲到 8.7 小時），價格超過 maxPriceAge 會擋開倉——錄影前手動推價。
- 公開 RPC 偶爾 DNS 失敗——準備備援 RPC 或網路。
- 新部署沒有歷史資料，事件頁是空的——錄影前先開平倉幾筆。

---

## 3. 使用者要準備給新電腦的東西

### 3.0 從舊電腦複製到新電腦（使用者親自用隨身碟，**絕不經過 GitHub 或對話**）

| 舊電腦來源 | 新電腦放置位置 | 用途 | 必要性 |
|---|---|---|---|
| `C:/Users/sanketsu/.foundry/keystores/pepelab-rwa-deployer` | `~/.foundry/keystores/pepelab-rwa-deployer`（Windows：`C:/Users/<你的帳號>/.foundry/keystores/`） | 新部署者的**加密**私鑰檔 | **必要** |
| `C:/Users/sanketsu/.foundry/pepelab-rwa-deployer.password` | `~/.foundry/pepelab-rwa-deployer.password`（只有自己可讀） | 解開上面 keystore 的密碼 | **必要** |
| `C:/Users/sanketsu/pepelab_onchain_cfd/agent/.env` | 新電腦 repo 的 `agent/.env`（已被 `.gitignore` 排除） | 舊的 agent／結算明文金鑰與 API 設定 | 可選；PoC 會用新部署者另建錢包，不需要它 |
| `C:/Users/sanketsu/pepelab_onchain_cfd/contracts/.env` | 新電腦 repo 的 `contracts/.env`（已被 `.gitignore` 排除） | **外洩地址 `0xE80A…` 的私鑰**，只用於「凍結舊部署」（`docs/RUNBOOK_FREEZE_LEGACY.md`）或從它轉出剩餘測試幣 | 可選；**絕不可用來部署新合約** |

放好後在新電腦驗證（只印地址，不印私鑰）：

```bash
cast wallet address --account pepelab-rwa-deployer --password-file ~/.foundry/pepelab-rwa-deployer.password
# 應輸出 0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE
cast balance 0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE --rpc-url https://sepolia.base.org --ether
```

部署時一律用 `--account pepelab-rwa-deployer --password-file ~/.foundry/pepelab-rwa-deployer.password`，不要把私鑰放進指令列或任何檔案。新的 keeper、代理人、收款、發證者錢包，由新電腦用 `cast wallet new` 建成加密 keystore（密碼檔同樣放 `~/.foundry/`），再由部署者轉 ETH 給它們；建立後把**地址**（不是私鑰）寫進下方錢包表。

### 錢包一覽（只列公開地址）

| 地址 | 角色 | 私鑰在哪 | 2026-10-06 20:10 餘額 | 能不能用 |
|---|---|---|---|---|
| `0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE` | **PoC 新部署者**（新合約的 owner） | 加密 keystore，使用者以隨身碟搬移 | Base Sepolia 0.8 ETH（從 Sepolia 跨鏈，L1 tx `0x8f5d12fa09f24e605b9a96269ef4ca9acc441abe169dccca5cf3404e685ca0e7`，已入帳） | **用這把部署 PoC** |
| `0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585` | 現役舊合約 owner | 不在任何一台電腦上（使用者自己的錢包） | Base Sepolia 0.090 | PoC 不需要 |
| `0x540aecd37e7a7885824e7b7e996ebddfb842ef17` | 現役 keeper（推價） | 只在 GitHub secret `KEEPER_PRIVATE_KEY` | Base Sepolia 0.147、Sepolia 0.424 | 由 GitHub Actions 使用，PoC 不動它 |
| `0xE80A81360608C1342e66743F70a00f75d792Eb93` | **已外洩**的舊部署者 | 舊電腦 `contracts/.env` | Base Sepolia 0.0099、Sepolia 約 1.4（已轉出 0.8） | **只能用來凍結舊部署或轉出測試幣**；新合約絕不可用它 |

### 3.1 開始前就要準備好

| # | 項目 | 怎麼做 | 用在 |
|---|---|---|---|
| 1 | 安裝工具 | Git、GitHub CLI（`gh`）、Foundry（`curl -L https://foundry.paradigm.xyz \| bash` 後 `foundryup`；Windows 用 Git Bash）、Node.js 20 以上、yarn（`corepack enable`）、Python 3.10 以上。Docker 不需要 | S0 |
| 2 | 登入 GitHub | 在新電腦終端機執行 `gh auth login`，帳號 **zuemen**，權限要有 `repo` 與 `workflow` | S0 起全部 |
| 3 | Claude Code 權限 | 讓 Claude 可以執行 `gh`、`forge`、`cast`、`anvil`、`yarn`、`npm`、`node`、`python`、`git`；要讓它合併 PR，也要允許 `gh pr merge` | 全部 |
| 4 | 電腦不休眠、網路穩定 | 電源設定關閉睡眠；準備備援網路（公開 RPC 偶爾 DNS 失敗） | 全部 |

### 3.2 進行中會被要求的

| # | 項目 | 什麼時候 | 怎麼做 |
|---|---|---|---|
| 5 | ~~Base Sepolia ETH~~ | 已完成 | 舊電腦已從 Sepolia 跨鏈 0.8 ETH 到 `0xF52D…49eE`；新部署者可再轉給新建的 keeper／代理人錢包 |
| 6 | **Base Sepolia 測試 USDC 約 10** | S6 開始時，Claude 給你代理人錢包地址 | 到 Circle 水龍頭 <https://faucet.circle.com>，選 Base Sepolia，領 USDC 到該地址（合約 `0x036CbD53842c5426634e7929541eC2318f3dCF7e`） |
| 7 | BaseScan API key（可選） | S3，要在 BaseScan 顯示已驗證原始碼時 | 到 etherscan.io 申請 API key（V2 一把可用於 Base）；**自己**在新電腦設定環境變數 `ETHERSCAN_API_KEY`，不要貼進對話 |
| 8 | Vercel 權限（可選） | S5，要做線上 preview 或改 signal-api 線上環境變數時 | 在新電腦 `npx vercel login`，或由你自己在 Vercel 網頁改；不做的話 PoC 用本機前端與本機 signal-api 錄影 |

### 3.3 搬移金鑰的注意事項

- 第 3.0 節的檔案**只能**用隨身碟或你自己控制的加密管道搬，**不可**推上 GitHub、貼進對話、放進雲端共享。repo 是公開的，網路上有機器人專門掃 GitHub 上的私鑰。
- `.env` 與 keystore 都已被 `.gitignore` 排除；新電腦的 Claude 不得讀出或印出其中的私鑰內容，只能透過 `--account`／`--password-file` 使用。
- 舊電腦本機的 `docs/commercial/` 含未公開弱點細節，不要放進 repo。

### 3.4 只有使用者能做、但不擋 PoC 的事

- GitHub environment／secret、branch protection、Cloudflare Worker（`docs/OWNER_ACTIONS.md`）。
- Vercel 線上環境變數（signal-api 的 `PAY_TO`、`X402_KYA_MODE`、新位址）。
- 舊部署：外洩地址仍控制 Sepolia 舊合約與 Base 的 3 顆 adapter（keeper 已不用）；凍結腳本 `docs/RUNBOOK_FREEZE_LEGACY.md` 要使用者明確授權才能用外洩金鑰執行。
- 現役舊合約的 owner `0x27C2…A585` 金鑰（找到才能升級現役合約；PoC 不需要）。

---

## 4. 工作規則（新電腦一定要遵守）

- 一律用**繁體中文**回答與寫文件。
- 直接執行，不詢問確認；**例外**：刪除、force push、覆寫既有檔案、對公開鏈送交易、改 GitHub／雲端設定——這些先確認或照使用者明確授權。
- **憑證只回報，不動手**：發現明文私鑰／token 只指出位置，不要撤銷、不要改設定檔、不要拿來用。
- 不碰 Claude Desktop 的設定（`claude_desktop_config.json`），不擴大它的檔案存取範圍。
- **PR 流程**：實作 → 另一個 agent 對抗式審查 → 修 → 複審 → CI 全綠 → 合併。補丁一再開新洞時改用結構性做法。
- **合約限制**：`PerpetualExchange` runtime 23,911 B 是 repo 自訂上限（`scripts/contract-size-budget.json`），距 EIP-170 的 665 B 保留給安全修正；**不新增既有合約的方法**，新功能放新合約或鏈下；UUPS 合約 storage 只能尾端新增。
- **公開文件**不寫漏洞重現細節（觸發門檻、時機、獲利數字、步驟）、私鑰、email。
- 改到 signal-api bundle import graph 的檔案要 `npm run bundle:vercel -w signal-api` 並一起 commit；`bundle:check` 要一致。
- frontend 用 **yarn**，agent 用 **npm**。
- git worktree：若把 OpenZeppelin 子模組用 junction／symlink 指回主目錄，**絕對不可 `git worktree remove --force`**（會刪掉主目錄的子模組內容）；先刪 junction 再刪資料夾，或每個 worktree 自己 `git submodule update --init`。
- 不要用裸的 `git stash`（多個 session 共用 stash）。
- 專題的 1P／20P 文件使用者已定稿，**不要改**。
- `docs/commercial/` 只存在舊電腦本機（git 排除），新電腦沒有，不影響工作。

---

## 5. 接續 prompt（貼到新電腦的 Claude Code）

```
你要接手 PepeLab（repo https://github.com/zuemen/pepelab_onchain_cfd）的「RWA ＋ SSI 正式 PoC」，不休息地持續做到完成。一律用繁體中文回答。

第一步：
1. 若本機還沒有 repo：`gh repo clone zuemen/pepelab_onchain_cfd`，進入資料夾後 `git submodule update --init --recursive`。
2. 讀 docs/HANDOFF_RWA_POC.md 全文。第 2 節是計劃表（S0–S8），第 3 節是我要準備的東西，第 4 節是工作規則——全部照做。
3. 先回報 S0 的檢查結果：哪些工具已裝、哪些缺（缺的列給我，我自己裝），`gh auth status` 是否為 zuemen。

接著照計劃表 S0 → S8 依序做，每個階段都要達到「驗收標準」才能進下一個：
- S1 審查並合併 #270 → S2 確認我用隨身碟放好的部署 keystore（地址應為 0xF52D…49eE、已有約 0.8 ETH，見第 3.0 節）→ S3 用 DeployTenant 部署整套＋VCKycRegistry＋SessionCredentialAnchor 到 Base Sepolia（先模擬再廣播）→ S4 本機 keeper 推價與休市切換 → S5 前端接新部署（不弄壞現有展示站）→ S6 本機 signal-api 開 x402 KYA，用測試 USDC 實付（我會把 USDC 打到你給的代理人地址）→ S7 寫 docs/POC_SCRIPT.md 並照劇本在 Base Sepolia 從頭跑一遍、每步記錄 tx hash 與 BaseScan 連結 → S8 文件收尾。

規則：
- 每個 PR：實作 → 另一個 agent 對抗式審查 → 修正 → 複審 → CI 全綠 → 合併。
- 絕不使用舊電腦 contracts/.env 的 PRIVATE_KEY（外洩地址 0xE80A…）；發現任何明文私鑰只回報位置、不使用。
- 對公開鏈送交易前先模擬；刪除、force push、改 GitHub／Vercel／Cloudflare 設定需要我明確授權。
- 需要我本人做的事（測試 USDC、API key、Vercel、GitHub 設定）一次集中列給我，並寫清楚地址與步驟；其餘不要停下來問。
- 每完成一個階段：更新 docs/HANDOFF_RWA_POC.md 的計劃表狀態欄並推上 GitHub，再用三句話跟我回報做了什麼、驗收結果、下一步。
```
