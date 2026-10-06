# 使用者流程可用性稽核（2026-10-06）

> 範圍：主鏈 Base Sepolia（84532）上「使用者實際會走的流程」。基準是 master `0dd25e3`
> 與當日的鏈上部署（位址見 `frontend/src/contracts/addresses.ts`、狀態見 [`RELEASE_STATUS.md`](RELEASE_STATUS.md)），
> 展示站當日的建置是 `ebd26a3`（與 `0dd25e3` 只差文件）。
> 目的：12/7 發表會現場 Demo 前，找出壞掉的地方，修掉程式面能修的，其餘列出原因。
>
> 方法與限制：
> - 公開鏈只做唯讀（`eth_call`／`eth_getCode`／`eth_getLogs`），**沒有對任何公開鏈送交易，沒有使用任何私鑰**。
> - 寫入流程在本機 anvil fork（fork 自 Base Sepolia 區塊 47,752,451）上以「冒充帳戶」模擬：全新地址當使用者，
>   MockUSDC owner 只用來加發測試幣，MockOracle owner 只用來模擬價格下跌。
> - 頁面走查用 headless Chromium 開線上展示站；錢包是測試用 EIP-1193 shim：只回一個公開地址（展示交易員 `0x27C2…A585`），
>   RPC 轉給公開節點，所有簽章與送交易一律拒絕。shim 的 RPC 是逐筆轉送，頁面載入比真錢包慢，所以每頁等 15 秒、慢的頁面再等 75 秒。
> - 本文件不含漏洞重現細節、金鑰或個資。

## 1. 結果總表

| # | 流程 | 結果 | 證據／說明 |
|---|---|---|---|
| 1 | 領測試幣（MockUSDC `faucet()`）→ 存保證金 → 提領 | ✅ 能用 | fork：新地址 faucet 拿到 1,000 USDC；`depositMargin`／`withdrawMargin` 成功。公開鏈 `eth_call` 模擬 faucet 也成功。 |
| 2 | 加密 sBTC／sETH 多空開平倉 | ✅ 能用 | fork：四筆開倉、全部平倉成功。**sBTC 鏈上槓桿上限是 1×**（sETH 5×），前端從鏈上讀 `maxLeverageForAsset`，不會讓人選超過上限。 |
| 3 | 黃金 sGOLD 多空 | ✅ 能用 | 鏈上上限 1×。 |
| 4 | 股票 sAAPL／sTSLA、債券 sBOND、ESG ETF sICLN／sESGU：未 KYC | ✅ 如預期被拒 | 這五檔在鏈上 `rwaAsset = true`，未 KYC 開倉一律 `NotKycVerified`。前端的 `regulated` 標記與鏈上一致。 |
| 5 | 同上：KYC 後開倉 | ✅ 能用 | 線上的 KYCRegistry 是**舊版自助驗證**：`submitKYC` 當下就 `isVerified = true`，沒有審核步驟。KYC 後十筆開平倉全部成功（sTSLA 上限 1×、sESGU 2×）。 |
| 6 | 價格下跌觸發清算 | ✅ 能用 | sETH 多 5×：價格未跌時 `liquidatePosition` 被拒（`PositionIsHealthy`），oracle 下跌 25% 後第三方清算成功。 |
| 7 | agent session：建立 → agent 下單 → 超額／超槓桿／白名單外／非指定 agent 被拒 → agent 平倉 → 撤銷後被拒 | ✅ 能用 | 每一個「應被拒」都是預期的錯誤（`MarginExceedsPerTradeCap`、`LeverageExceedsSessionCap`、`AssetNotAllowed`、`NotSessionAgent`、`SessionIsRevoked`）。 |
| 8 | 跟單：交易員註冊 → 質押 MIN_STAKE → 發布策略 → 跟單 → 取消並平倉 | ✅ 合約能用／⚠️ 線上 UI 關閉 | fork 全程成功（策略至少 3 檔、單檔 ≤ 50%）。跟單展示交易員（策略含 sNVDA 等受管制資產）在跟單者未 KYC 時被拒，KYC 後成功。**但線上展示站 `/copy/:addr` 顯示「此功能未啟用」**——跟單旗標在該部署關閉（Vercel 環境變數，見 §4）。 |
| 9 | AssetVaultV2 mint／redeem 合成資產（/tokens、配置市集「採用」） | ✅ 能用 | sBTC、sAAPL 各 100 USDC mint 後全數 redeem，取回 98.70／99.60 USDC（含贖回費與價差）。金庫未暫停、未停鑄，價格上限 30 天。 |
| 10 | InsuranceVault 存入／提領 | ✅ 能用 | `deposit(100)`、`withdraw(全部份額)` 成功。 |
| 11 | 展示站 27 條路由 | ✅ 全部 200 | SPA 殼與 5 個 JS／CSS 資產皆 200。 |
| 12 | 未連錢包可看的頁面（`/`、`/x402`、`/marketplace`） | ✅ 能用 | 無 console error、無未捕捉例外。其他頁面未連錢包會導回 `/`（設計如此：前端只用錢包的 provider 讀鏈）。 |
| 13 | 連錢包後的讀取頁（投資組合、交易、/tokens、/terminal、ESG、Sessions、Agent 監控、金庫、配置市集、交易員後台、/stake） | ✅ 能讀到鏈上資料 | 無 console error、無未捕捉例外、無空白頁。投資組合載入較慢（約 140 筆讀取），有「1 筆餘額無法讀取」提示，總額照常顯示。 |
| 14 | **事件日誌類頁面（歷史記錄、鯨魚追蹤、交易員個人頁動態、金庫近期活動、KYC 審核佇列、Treasury）** | ❌ **壞（已修，待部署）** | 公開節點把 `eth_getLogs` 範圍上限**降為 500 塊**，前端每段查 800 塊，**每一段都被拒**。線上實測：歷史記錄頁 75 秒後 144 次 RPC 有 138 次失敗，仍顯示「尚無活動——過去 9,000 個區塊內找不到事件」；交易員個人頁「掃描中 35/220」、鯨魚頁「掃描中 24/55」。修正見 §3。 |
| 15 | 前端呼叫鏈上舊版沒有的函式 | ✅ 已有降級 | 以 `eth_getCode` 的 selector 比對前端 29 份 ABI：前端沒有在 UI 直接呼叫任何鏈上不存在的函式；`assetMode`、`isPending`、`verifiers`、PepeAMM v3、`achievementPoints` 都先探測再呼叫或有 fallback。`guardian`／`marketOperator` 前端完全沒有呼叫。 |
| 16 | signal-api 免費端點 | ✅ 能用 | `/healthz`、`/`、`/revenue`、`/candles/:symbol`、`/benchmarks`、`/risk/exposure`、`/agent/:did/verification`、`POST /demo/buy-signal` 皆 200（`/demo/buy-signal` 同一 IP 15 秒冷卻）。 |
| 17 | signal-api 付費端點 `/signals/*`、`/oracle/*` | ⏸ 需擁有者 | 503 `payto_unsafe`（payTo 指向已知外洩地址，fail-closed）。已知，屬擁有者待辦。 |
| 18 | MCP server 啟動與唯讀工具 | ✅ 能用 | 只設公開 RPC 即可啟動，列出 7 個工具；`get_funding_rate`、`get_trader_performance` 正常。`get_session` 需設 `SESSION_MANAGER_ADDRESS`（`.env.example` 已寫好值）。 |
| 19 | SDK | ✅ 能用 | `npm run test:sdk`（離線）與 `npm run test:sdk:live`（唯讀連線，6 項）全過；11/11 資產價格新鮮。 |
| 20 | demo-agent（無金鑰唯讀模式） | ✅ 能用 | 讀 oracle、讀交易員訊號、逐腿決策都正常；未設金鑰時只印出「本來會下的單」。 |

## 2. 合約流程證據（anvil fork）

- fork 區塊：47,752,451（2026-10-06 15:5x 台灣時間）；第一輪（區塊 47,751,322）用了錯的槓桿假設，見下。
- 最終一輪：**74 個步驟全部符合預期**（含 23 個「應被拒」的步驟都以預期錯誤被拒）。
- 第一輪有 14 個失敗，全部是走查腳本的假設錯誤，不是產品 bug：
  - 以 2× 開 sBTC／sTSLA／sGOLD → `InvalidLeverage`：這三檔的鏈上上限是 1×。
  - 發布 2 檔的策略 → `TooFewAssets(2)`：合約要求至少 3 檔；前端 `strategyValidation` 已先擋。
  - 跟單展示交易員 → `NotKycVerified`：策略含受管制資產，跟單者要先 KYC；CopyPage 有 KYC 視窗。
- 讀到的鏈上參數（Base Sepolia，2026-10-06）：

| 資產 | rwaAsset（需 KYC） | maxLeverageForAsset |
|---|---|---|
| sBTC | 否 | 1× |
| sETH | 否 | 5× |
| sAAPL | 是 | 5× |
| sTSLA | 是 | 1× |
| sGOLD | 否 | 1× |
| sBOND | 是 | 5× |
| sICLN | 是 | 5× |
| sESGU | 是 | 2× |

- 鏈上狀態補充：線上 exchange（`0x827e…124D`）的 `nextPositionId` 是 0——**公開鏈上從來沒有人在這個 exchange 開過倉**。
  所以交易相關頁面（鯨魚、歷史、排行榜的部位部分）在真鏈上本來就是空的，不是讀取失敗。

## 3. 這次修了什麼（PR 見本文件所在的 PR）

| 修正 | 問題 | 做法 | 測試 |
|---|---|---|---|
| `chainLogs`：段長 800 → 400、可設定、範圍錯誤自動對半重試 | 公開節點 2026-10-06 起 `toBlock − fromBlock ≤ 500` 才收，超過回 HTTP 413 + `-32614 "eth_getLogs is limited to a 500 range"`；800 塊一段全數被拒 | `CHUNK_SIZE = 400`（實測上限八成）、`MAX_CHUNKS = 110`（24 小時視窗不變）、`ChunkScanOptions.chunkSize` 可覆寫（介面只增不改）、`isRangeLimitError` 認得各家措辭與 HTTP 413，收到就把那一段對半切開重抓（深度有界） | `chainLogs.test.ts` 新增 6 項：模擬 500／100 上限節點、413 錯誤形狀、`chunkSize` 覆寫、非範圍錯誤不切、單塊仍被拒時有界放棄 |
| 歷史記錄頁：日誌還在掃時不顯示「尚無活動」 | 部位讀完 0 筆、日誌還在掃時就顯示空狀態，對使用者說「找不到事件」 | 抽出 `historyBodyState`：任一讀取進行中且尚無資料 → 骨架；掃完有錯 → 讀取失敗；掃完無錯 → 空狀態 | `historyBodyState.test.ts` 6 項 |
| KYC 視窗：送出後顯示「已通過」 | 線上 KYCRegistry 是自助驗證舊版，送出當下就通過，視窗卻停在「已送出、等待審核」，使用者以為還不能交易 | 送出確認後讀一次 `isVerified`，確定為 true 才顯示已通過；讀不到維持待審 | `kycOutcomeAfterSubmit` 3 項 |
| KYC 視窗：送出前的說明 | 送出前寫「這是送出申請，不是即時通過」，與線上實際行為矛盾 | 開啟時探測 `isPending`：確定不存在才改用自助驗證說明；限流／逾時維持保守說法。只影響文字，不影響任何閘門 | `kycRegistryModeFromProbe` 3 項 |

全部前端測試（83 檔、1,134 項）與 `tsc --noEmit` 在本機通過；CI 結果見 PR。

## 4. 剩下的問題與原因（程式面無法修）

| 項目 | 影響 | 為什麼不在這裡修 | 誰能處理 |
|---|---|---|---|
| 價格 keeper 的排程間隔不穩 | 近一週 39 個間隔中有 4 個超過 6 小時（最長 8.7 小時）。交易所 `maxPriceAge = 6 小時`，超過時**所有開倉都會 revert**，前端顯示價格過期 | GitHub 排程（cron `*/15`）實際上每 2–9 小時才跑一次；keeper-trigger Worker 尚未部署 | 擁有者：Demo 前 30 分鐘手動觸發 `base-sepolia-keeper.yml`（workflow_dispatch），或部署 keeper-trigger（Cloudflare） |
| 公開 repo 60 天無提交會停用排程 | 10/6 → 12/7 是 62 天；若期間沒有任何提交，keeper 排程會被 GitHub 自動停用 | GitHub 設定 | 擁有者：期間保持提交，或 Demo 前到 Actions 頁確認排程仍啟用 |
| 跟單 UI 在線上展示站關閉 | `/copy/:addr` 顯示「此功能未啟用」 | 由 Vercel 環境變數（`VITE_FEATURE_COPY_TRADING`）決定；合約流程本身可用 | 擁有者：若 Demo 要展示跟單，在 Vercel 開啟旗標後重新部署 |
| 線上合約多數是舊版（「原始碼較新」） | KYC 是自助驗證、沒有 guardian／assetMode 等；前端已全部降級處理 | 重新部署需要擁有者金鑰；主合約 EIP-170 餘裕 0 B | 擁有者（見 `OWNER_ACTIONS.md`） |
| signal-api 付費端點 503 | x402 付費流程無法現場展示 | payTo 仍指向已知外洩地址，需擁有者換 payTo 與 FeeRouter | 擁有者 |
| `/admin/oracle` 改價 | 舊 Demo 腳本 Step 4（管理員改價）在 Base 上做不到：MockOracle owner 是 keeper 位址，不是展示錢包 | 不應把 keeper 金鑰匯入展示錢包 | 改用本機 anvil 或預錄 |
| 本修正上線 | §3 的修正要等 PR 合併、Vercel 重新部署後才生效 | 不在本次權限內合併 | 擁有者合併 PR |

## 5. Demo 建議：避開或預錄的流程

1. **Demo 前 30 分鐘**：手動觸發 keeper workflow，並在 `/terminal` 確認沒有「價格過期」提示；signal-api `/risk/exposure` 的各資產 `ageSec` 都應小於 21,600。
2. **開倉時選對槓桿**：sBTC、sTSLA、sGOLD 只能 1×（UI 會鎖住，但口頭講解別說「BTC 10 倍槓桿」）。
3. **股票／債券／ESG ETF**：先在投資組合頁送出 KYC（線上為自助驗證，送出即通過；本 PR 合併前視窗會誤寫「等待審核」，關掉視窗重新整理即可）。
4. **跟單**：線上 UI 關閉；要展示就預錄 fork 走查或本機 anvil 版。
5. **清算、管理員改價**：需要 oracle owner，真鏈做不到——預錄（本機 anvil 或 `forge script script/DemoE2E.s.sol`）。
6. **歷史記錄、鯨魚、交易員動態**：本 PR 部署前在公開節點上讀不到事件；部署後也只有近 24 小時，而且線上 exchange 沒有任何真實倉位——現場要看到內容，Demo 前先用展示錢包開平倉幾筆。
7. **x402 付費訊號**：付費端點 503，只展示 `POST /demo/buy-signal`（免費、不結算；同一 IP 15 秒冷卻，別連點）。
8. **agent session 由 agent 下單**：需要 agent 金鑰與 `npm run vc-status:init`；現場只建議展示「建立 session」與合約拒絕超額，agent 下單用預錄。
9. 公開 RPC 偶有 DNS／限流失敗（本次稽核期間遇到兩次），現場網路建議備援（手機熱點）與一份全程預錄。
