# 交接：RWA ＋ SSI 正式 PoC（2026-10-06 18:00 台灣時間）

給下一台電腦／下一個 session 接手用。目標是把 PepeLab 做成**標準的 RWA 衍生品平台 PoC**：SSI（可驗證憑證）真正接上 RWA 准入與 AI 代理人委託，部署到 Base Sepolia 新的一套合約，達到**可以錄 PoC 影片**的程度。

文末「接續 prompt」可以直接貼給新的 Claude Code session。

---

## 1. 目前狀態

- **master**：`3d4de28`（#267 合併後）。CI 全綠，Dependabot 警示 0。
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
| #269 | 可用性稽核與修正：公開節點 eth_getLogs 上限降為 500 塊，chainLogs 改 400 塊＋自動對半重試；`docs/USABILITY_AUDIT_2026-10-06.md` |

### 還開著的 PR

| PR | 分支 | 狀態 | 接手要做的事 |
|---|---|---|---|
| #268 | `feat/rwa-transparency` | RWA 資產卡 `/rwa`、參考價見證看板 `/oracle`、儲備與償付能力頁 `/solvency`、signal-api 免費端點 `/reference-prices`。**審查結論：修正後可合併**；修正已交給 agent，可能已推上也可能沒有 | 先 `git merge origin/master`（#269 改了 chainLogs）。核對下列審查項都已修：(1) `referencePrices.ts` 每個來源各自快取（成功 60 秒、失敗短 TTL）、CoinGecko 合併請求、`Cache-Control: s-maxage`；(2) `docs/RWA_TRANSPARENCY.md` §2 第三方條款（只即時轉發、不存歷史、標示來源）＋CORS 限縮前端網域；(3) `solvency.ts` 小數位數讀不到時不要默默用 18；(4) `useRwaTransparency.ts` 失敗時不保留舊資料當現值；(5) adlEnabled 改用 `solvencyFlags.ts`；(6) 被碳分級壓住的卡片加註。沒修的補完，CI 綠就合併 |
| #270 | `feat/ssi-delegation-kya` | **SSI 委託授權**：AgentDelegationCredential v3（W3C VC 2.0、did:pkh、EIP-712）、新合約 `SessionCredentialAnchor`、x402 KYA（`X402_KYA_MODE`，預設 off；付款前驗 VP＝憑證主體＝付款人、撤銷、鏈上 session、錨定、重放、依憑證累計花費）、前端 `/sessions`、PoC 腳本 `scripts/poc/agent-delegation-demo.sh`、`docs/SSI_AGENT_DELEGATION.md`。CI 15 項綠，**尚未審查** | 先合 master（和 #267 在 `agent/package.json` test 行、`frontend/vitest.pinnedEnv.ts` 有相鄰新增，手動合併）。做一次對抗式審查（合約權限、VP 重放與綁定、花費累計的原子性與退回、x402 v1／v2 兩條路徑、fail-closed、揭露），修正後合併 |

---

## 2. 接下來依序做

1. **合併 #268**（見上表）。
2. **審查並合併 #270**（見上表）。
3. **新部署金鑰**：舊電腦的 keystore `pepelab-rwa-deployer`（`0xF52D…49eE`）**不會跟著到新電腦**，而且還沒有入金。在新電腦建立新的加密 keystore：
   `cast wallet new ~/.foundry/keystores pepelab-rwa-deployer --unsafe-password "$(cat <密碼檔>)"`（密碼檔放 repo 外、權限 600）。把地址給使用者，請使用者從 Base Sepolia 水龍頭入金約 0.1 ETH（<https://docs.base.org/base-chain/tools/network-faucets>）。**沒入金前不能部署。**
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

## 3. 只有使用者能做的事

- Base Sepolia 水龍頭入金到新部署地址。
- GitHub environment／secret、branch protection、Cloudflare Worker（`docs/OWNER_ACTIONS.md`）。
- Vercel 環境變數（signal-api 的 `PAY_TO`、`X402_KYA_MODE`、新位址）。
- 舊部署：外洩地址仍控制 Sepolia 舊合約與 Base 的 3 顆 adapter（keeper 已不用）；凍結腳本 `docs/RUNBOOK_FREEZE_LEGACY.md` 要使用者明確授權才能用外洩金鑰執行。
- 現役舊合約的 owner `0x27C2…A585` 金鑰。

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
你要接手 PepeLab（repo zuemen/pepelab_onchain_cfd）的 RWA ＋ SSI 正式 PoC，不休息地持續做到完成。

先做：
1. clone repo（若還沒有），`git submodule update --init --recursive`，讀 docs/HANDOFF_RWA_POC.md 全文，並遵守第 4 節的工作規則。
2. 確認工具：gh（已登入 zuemen）、foundry（forge/cast/anvil）、node 20+、yarn、python 3.10+。缺的告訴我，我自己裝。
3. 讀 docs/RWA_ALIGNMENT.md、docs/SSI_RWA_ACCESS.md、docs/USABILITY_AUDIT_2026-10-06.md、docs/PARAMS_INVENTORY.md。

然後依 docs/HANDOFF_RWA_POC.md 第 2 節的順序做：合併 #268（核對審查項）→ 對抗式審查並合併 #270 → 建新的加密部署 keystore 並把地址告訴我（我去水龍頭入金）→ 入金後部署整套到 Base Sepolia（含 VCKycRegistry、SessionCredentialAnchor、guardian、休市模式、碳分級）→ keeper 推價 → 前端接新部署（不弄壞現有展示站）→ 本機 signal-api 開 x402 KYA → 寫 docs/POC_SCRIPT.md 錄影劇本並實際照劇本在 Base Sepolia 跑一遍、記錄每步交易 hash → 文件收尾。

規則：繁體中文；每個 PR 都要經過另一個 agent 的對抗式審查、修正、CI 全綠才合併；需要我本人（入金、GitHub／Vercel／Cloudflare 設定、舊金鑰）的事情集中列給我，其餘不要停下來問。每完成一個階段就更新 docs/HANDOFF_RWA_POC.md 的狀態並推上 GitHub。
```
