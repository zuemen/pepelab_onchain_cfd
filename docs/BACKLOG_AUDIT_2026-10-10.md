# 未完成事項盤點（2026-10-10）

以 `origin/master` @ `44e0a9b`（#297）為準。全程唯讀查證：`gh`、`cast call`、`curl`、各狀態文件。
主鏈＝Base Sepolia（84532），見 `docs/RELEASE_STATUS.md:20`。

RWA PoC 的 S0–S8 全部完成（`docs/HANDOFF_RWA_POC.md`）。下面列的是還沒做完的事。

## 1. 要擁有者動手（金鑰、儀表板、決策）

| 優先 | 項目 | 依據 |
|---|---|---|
| 高 | OWNER_ACTIONS 第 1 步還沒做：repo 層級仍有 `KEEPER_PRIVATE_KEY`、`FEE_SETTLEMENT_PRIVATE_KEY`，另有一支名稱奇怪的 secret 叫 `BASE`；master 沒有 branch protection；沒有 `admin-base-sepolia` environment | `docs/OWNER_ACTIONS.md:20,45` |
| 中 | #207：Vercel signal-api 的 production 別名仍跑 `main`（`/risk/exposure` 回 404，master 預覽回 200）。要在 dashboard 把 Production Branch 改成 master | issue #207 |
| 中 | keeper-trigger、monitoring 兩支 Cloudflare Worker 從來沒部署過，要等第 1 步完成 | `docs/RELEASE_STATUS.md:167-168` |
| 中 | 平台 cutover（OWNER_ACTIONS 第 3–5、7 步）：Base Sepolia 有 18 個元件落後原始碼、5 個仍指向外洩地址。現役 owner `0x27C2…A585` 的金鑰不在手上，所以全部擋住 | `docs/OWNER_ACTIONS.md:22-26`、`docs/HANDOFF_RWA_POC.md:161-162` |
| 中 | #169 / #102：PepeIncentives 原始碼已改成記點數（#219），但鏈上 `0xEBfA…3c12` 仍是舊版，還綁著已退役的 exchange。要排在 cutover 第 5 步第 5 項 | `contracts/src/PepeIncentives.sol:268-289`、`docs/RELEASE_STATUS.md:46` |
| 中 | #129 驗收沒走完：真錢包的 Expert Mode 走查、預言機失效顯示；`maxPriceAge` 仍是 30 天的暫時值；每檔資產的碳評等都只有 1 個見證者 | `docs/RUNBOOK_KEEPER.md:112` |
| 中 | 學校交付：PoC 成片 mp4 不進版控，本機 `scripts/poc/video/out/` 是空的，要確認已另存或已繳交 | `docs/HANDOFF_RWA_POC.md:211` |
| 低 | BaseScan 驗證：自己設 `ETHERSCAN_API_KEY` 後跑 `rwa-poc-verify.sh`（Blockscout 與 Sourcify 已由 #294 完成） | `docs/HANDOFF_RWA_POC.md:248` |
| 低 | #156：先決定金鑰代管算不算白標範圍 | issue #156 |

## 2. agent 可以直接做

| 優先 | 項目 | 依據 |
|---|---|---|
| 中 | 收錄三個未追蹤的廣播目錄 `contracts/broadcast/{RotateOwnership,SeedESG,SeedWhales}.s.sol/84532`（08-07 金鑰輪替當天的紀錄，裡面沒有私鑰）。commit 後要跑 `check-addresses`、`check-tenant-deploy` | `.gitignore:14`、`contracts/.gitignore:9` |
| 中 | 修正過期文件：HANDOFF 還把 #293 列為開著的 PR、還寫「gh 登入待使用者」；`docs/tenants/rwa-poc/README.md` 的 keeper 寫法前後矛盾；`POC_SCRIPT.md:110` 叫人開本機 keeper，會和線上 GitHub Actions keeper 撞 nonce | `docs/HANDOFF_RWA_POC.md:45-61`、`POC_SCRIPT.md:110,122,211` |
| 中 | 線上 signal-api：撤銷狀態改存 Upstash 共享儲存，現在每個 Vercel 實例各一份；結算佇列沒有 worker 處理。程式由 agent 寫，Vercel 設定要人做 | `docs/tenants/rwa-poc/ONLINE.md:49-56` |
| 低 | #103：付費端點加賣碳資料和儲備快照（現在只有 `/signals`、`/oracle`） | `agent/signal-api/src/app.ts:1531,1552` |
| 低 | #104：行為模擬與敏感度分析。可以 `risk_model/` 為基礎，但碳級距要接回 `CarbonTiers`，不能照抄 | `risk_model/params.py:33-37` |
| 低 | #105：碳權退役（MockCarbonCredit、CarbonRetirement），全庫都還沒有 | issue #105 |
| 低 | `KNOWN_LIMITATIONS` 中仍為 Open 的項目：#21、#24、#33 與 #34（金庫缺少 KYC 和休市閘門）、#35、#37、#38（Pyth 從未呼叫 `updatePriceFeeds`） | `docs/KNOWN_LIMITATIONS.md:45-62` |
| 低 | RWA 透明度：每日帶雜湊的快照、`BadDebt` 和 `ReserveBreached` 事件歷史 | `docs/RWA_ALIGNMENT.md:191,207` |
| 低 | #129 關閉後，刪掉舊版金庫的前端分支 | `frontend/src/pages/pepefi/TokenizedAssetsPage.tsx:141-145` |

## 3. 雜項

- #93 是總表：13 個子 issue 已關 9 個，剩 #102–#105。
- dependabot PR #271、#272 還開著。
- `contracts/lib/openzeppelin-contracts` 顯示 `m`：巢狀子模組沒有 checkout 完成，不影響建置。要清掉就在該目錄跑 `git submodule update --init --force`。
- #103 有一則 09-10 的站外推廣留言，看起來像垃圾留言。
