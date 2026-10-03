# 繁中介面修正紀錄（2026-10，分支 `frontend/zh-ui-polish`）

2026-10-02 截圖時發現的七個介面問題，各自的決定與理由。截圖與原始問題描述不在 repo 內。

## 1. 漏翻

- 首頁「Connect Wallet」、錢包選單（連線中／已連線錢包／切換帳號／中斷連線）、首頁徽章「Live on Base Sepolia · 84532」、版面外殼（側欄開合、設定抽屜、搜尋無結果、404）全部改走 catalog（`common.wallet.*`、`common.shell.*`、`landing.liveOn`）。
- 終端機副標「SYNTHETIC ETHEREUM」：`assetMeta.ts` 的英文原名直接上畫面。改成 catalog `tokens.assetName`（`lib/pepefi/assetName.ts`），代號 sETH 不譯。
- K 線「ETH SPOT」：signal-api 回的 `underlying`。代號 ETH 不譯，「Spot」換成「現貨」（`underlyingLabel`）；股票代號與產品名（`GC=F (COMEX Gold Futures)`）原樣保留。
- **保留**「PAPER TRADING · 測試網模擬交易」：刻意沿用 TradingView 的模式名稱（commit bfa2939、`PaperTradingBadge.tsx` 註解），同一個徽章裡已有中文；頂列精簡版本來就是「模擬交易」。
- **保留**「PEPELAB·TERMINAL」：品牌字樣（`tenant.brand.name` 大寫＋TERMINAL 的 lockup），不是說明文字。
- 掃描工具：`node scripts/scan-hardcoded-english.mjs [路徑前綴]`，列出 JSX 文字節點、顯示屬性與大括號字串裡的英文。修正前 105 處，修正後 65 處；剩下的見下表。

| 剩下的 | 理由 |
|---|---|
| `SessionsPage` 的 `AGENT_PRIVATE_KEY`、`mcpServers`、`did:pkh` 等 | 設定檔鍵名與識別碼（ADR-0002 第 3 類） |
| `TokenizedAssetsPage` / `VaultPage` / `AdminOraclePage` 的 `fundVault()`、`docs/RISK_MODEL.md`、`immutable` | 函式名、檔案路徑、Solidity 關鍵字 |
| `X402DocsPage` 的 curl / 程式碼片段 | 程式碼 |
| `HeroKpiStrip`、網路不符橫幅的 `chainId 84532` | 技術識別碼 |
| `PepeLabPage` 的 `Lv.`、`XP`、`EVOLUTION` | GameFi 頁，功能旗標預設關閉，另案處理 |
| `components/pepefi/ErrorBoundary.tsx` | 沒有任何地方 import（死碼） |
| `routes/components/error-boundary.tsx` | 開發用錯誤頁（顯示 stack trace） |
| `auth/*`、`layouts/auth-split`、`account-button`、`sign-out-button` | Minimal UI 範本的 JWT 登入頁，導覽沒有入口 |
| `layouts/*/layout.tsx` 的「This is an info Alert.」 | `display: none` 的範本插槽 |

## 2. 我的 Session 表格

`SessionsPage` 的 Container 由 `md`（900px）改 `lg`；表頭與數字不換行、儲存格左右 padding 縮小；撤銷欄 `position: sticky; right: 0`，表格比容器寬時橫向捲動，撤銷鈕永遠可見可點。

## 3. 未實現損益不一致

- 根因：終端機（`TerminalView` 的持倉表、帳戶區，與市場動態面板）用**鏈下參考價**（CoinGecko／Coinbase）自己重算 (現價 − 進場價) × 數量；投資組合用合約 `getUnrealizedPnL`（mark 價毛損益，不含任何費用；fork 上 oracle 沒動 = 0），「目前價值」用 `getPositionValue`（扣平倉手續費、借貸費、資金費 = 797.60）。三個數字三個來源。持倉表標成「標記價」的欄位其實也是鏈下參考價。
- 統一定義（`lib/pepefi/positionPnl.ts`）：**未實現損益 = `getPositionValue` − 保證金**，也就是現在平倉會比投入多拿或少拿多少；mark 價、資金費、手續費都由合約自己算，前端不重算費率。兩頁都經 `readOpenPosition` 讀同一組合約 view；終端機「標記價」欄改顯示合約 `getMarkPrice`。
- 淨值卡的帶號金額改成 `-$2.40`（原本 `$-2.40`）。
- 結果：剛開倉、價格沒動的部位在兩頁都是 −2.40（800 × 3 × 10 bps 的平倉費），與紅字的 797.60 一致。
- `positionConsistency.test.ts` 用同一組假合約讀數餵兩頁的資料路徑，釘住數字相同。

## 4. 歷史紀錄

- 「交易」欄寫「儲存」：那一列是從合約儲存（`getPosition`）重建的，storage 不記交易雜湊；要等日誌掃描（最近 9,000 塊、十幾段 getLogs）跑完才會被帶雜湊的事件取代。現在部位顯示後，立刻用 openedAt / closedAt 反推區塊、以 indexed `positionId` 做一次窄範圍查詢補上雜湊（`lib/pepefi/positionTxLookup.ts`）；連結改顯示縮寫雜湊＋↗。真的找不到才顯示「合約儲存」。
- 「載入中…」不消失：日誌掃描每段 getLogs 沒有逾時，一個不回應的節點會讓掃描永遠不結束。`chainLogs.ts` 加每段逾時（預設 20 秒，逾時算失敗段並照常重試／回報）；部位顯示後 loading 就結束，背景同步日誌時按鈕顯示「同步鏈上日誌…」。

## 5. demo-bank 白標殘留

租戶設定新增 `brand.mascot`（省略 = true；demo-bank 設 false）。首頁徽章改用 `brand.mark` 且 mascot = false 不顯示；首頁光暈、底色改用色票變數與 `brand.themeColor`，不再寫死 PepeLab 綠；`PepeAvatar` 在 mascot = false 時改成不帶圖的中性識別圓。投資組合淨值卡、側欄 logo 光暈、全域 Card 邊框、金庫管理頁裡寫死的 PepeLab 綠 `rgba(124,193,74,…)` 也一併改成 `rgba(var(--palette-primary-mainChannel) / …)`（default 租戶色值不變）；GameFi 頁（`PepeLabPage`）旗標關閉，未動。`branding.test.ts` 新增「PepeLab brand elements do not leak into another tenant」守門測試。default 租戶的設定快照不變。

## 6. tooltip 蓋住 K 線

行情列說明框改往上開（`top-start`，沒空間才翻右側／下方）、停 400ms 才開、可用 Esc／移開游標／右上角 × 關閉。

## 7. ADL 狀態

揭露框原本寫死「本測試網部署目前預設關閉」。2026-10-02 以公開 RPC 唯讀呼叫 Base Sepolia `PerpetualExchange`（`0x827e…124D`）：`adlEnabled()` = true、`portfolioMarginEnabled()` = false、`markPremiumCapBps()` = 0。改成頁面載入時讀鏈上兩個旗標代入文案（`lib/pepefi/solvencyFlags.ts`），catalog 不再含任何開關狀態。
