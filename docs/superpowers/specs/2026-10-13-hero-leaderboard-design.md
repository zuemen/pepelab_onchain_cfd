# 英雄榜（Anvil 重播鏈）設計

> 日期：2026-10-13 · 狀態：設計草稿（第 2 版）。**定案的 spec 是 GitHub issue #309**，用詞與範圍有出入時以 issue 為準；
> 這份草稿把交易者寫成「英雄」、把發布的策略寫成「配置」，issue 已改用 repo 詞彙表的說法（交易者、策略、跟單）。
> 實作計畫：`docs/superpowers/plans/2026-10-13-hero-leaderboard-data-track.md`、`…-ui-track.md`。目標完成日：2026-10-18 核心、2026-10-20 補齊。

## 1. 為什麼做

評審 2026-10 的回饋：平台空洞、缺資料；英雄榜要有投資組合、過去績效、ESG 相關性、
跟單人數、交易證明（參考 eToro）；英雄必須 based on 真實價格資料，鏈上交易可用虛擬
交易代替；從沒看過一鍵跟單。

現況：`CopyTracker`、`/copy/:addr`、交易者排行榜都已存在，但在
`FEATURE_COPY_TRADING` 旗標後（預設關），且排行榜只在 Expert 模式顯示。資料只有
`SeedWhales.s.sol` / `SeedWhaleCloses.s.sol` 塞的 12 位交易者與少量平倉。

## 2. 讀程式後確認的事實（設計的前提）

| # | 事實 | 出處 | 對設計的影響 |
|---|---|---|---|
| F1 | 跟單複製的是交易者**發布的配置**（一籃子部位），不是逐筆交易 | `CopyTracker._follow` | 英雄必須是「定期調整配置」的模型；馬丁、網格這類逐筆策略無法被跟單 |
| F2 | 發布的配置至少 3 個標的、單一標的最多 50%、槓桿只能 1／2／5、權重合計 100% | `StrategyRegistry.publishStrategy` | 策略輸出必須先過同一組驗證 |
| F3 | 跟單紀錄綁定當時的版本；交易者之後重新發布，既有跟隨者**不會**自動跟著調整 | `CopyRecord.versionId` | 與 eToro 的持續跟單不同，列為已知落差（§8） |
| F4 | 槓桿部位每小時收借款費，最低級距 0.01%／時，2 倍槓桿持有一年約付掉本金的 88% | `_borrowFee`、`CarbonTiers` | 長期持有的英雄只能用 1 倍；用槓桿的英雄必須短週期 |
| F5 | 開啟碳定價時，費率與槓桿上限由標的碳分級決定（手續費 0.1%／0.4%／1%，槓桿上限 5／2／1）；未評等落到最嚴一級；見證 180 天過期 | `_carbonParamsFor`、`ESGRegistryV2` | 本機部署要見證 11 個標的，並把過期時間設為 0（不過期） |
| F6 | 清算不會自動發生，要有人呼叫 `liquidatePosition` | `PerpetualExchange` | 重播每天要跑一次清算檢查 |
| F7 | 股票與 ETF 標的需要 KYC | `_openPosition` | 英雄、虛擬跟隨者、demo 用的帳號都要預先核可 |
| F8 | `PositionClosed.pnl` 是未扣費用與資金費的價差損益；淨額是 `closeAmount − margin` | `_closePosition` | 分析一律用淨額；現有排行榜顯示的是毛額 |
| F9 | 現有排行榜用「最近 7 天的區塊數」掃事件，Anvil 上區塊數與時間無關 | `MarketplacePage`、`chainLogs.ts` | 績效欄位改由 JSON 提供，不再靠瀏覽器掃事件（§5.5） |
| F10 | 現有 `Deploy.s.sol` 只註冊 4 個標的、沒有 ESG 登錄；`deploy-anvil.sh` 會把 `addresses.ts` 的 ANVIL 區塊寫回只有 7 個欄位的舊格式 | `contracts/script/`、根目錄 | 需要新的本機部署腳本與位址寫入方式 |
| F11 | 這台開發機 Smart App Control 為強制狀態，Foundry 只能在 WSL 跑；WSL 內 `anvil`／`forge` 1.8.1 已安裝（在 `~/.foundry/bin`，不在 PATH）；Windows 沒有 Python，WSL 有 Python 3.14 但沒有 pip | 實測 2026-10-13 | 鏈與 Python 都在 WSL 執行；pip／venv 需使用者自行安裝 |
| F12 | `sBOND` 追蹤的是 BGRN（綠色債券 ETF），不是 TLT；keeper 已有 Yahoo 與 CoinGecko 的抓價程式 | `agent/keeper/feeds.ts` | 價格代號照 keeper 的對照表；demo 時的即時價格直接重用 keeper |
| F13 | 前端所有讀取都經由已連線的錢包；Mock Wallet 是假位址，不能簽交易 | `useWallet.ts` | demo 用 MetaMask 連本機鏈並匯入 Anvil 帳號 |

## 3. 決定

| 決定 | 選擇 | 理由 |
|---|---|---|
| 歷史資料放哪 | 本機 Anvil 重播鏈 | 活的測試網無法回填歷史時間戳；評審亦建議 Anvil + deployment scripts |
| 部署 | 只在本機 | meeting 與錄影都用筆電 |
| 英雄模型 | 定期調整配置的投資組合（F1、F2） | 英雄的績效與使用者跟單拿到的東西才一致 |
| 碳定價 | 開啟 | 這是平台的 ESG 特色；低碳標的費用較低，英雄的 ESG 分數與績效自然有關聯 |
| 語言分工 | Python 只做資料科學（策略、分析）；鏈的讀寫用 Node + ethers | repo 已有 ethers 與 ABI；避開 Python 3.14 上的 web3 套件風險 |
| 規模 | 24 位英雄、2024-10-01 起至最新收盤日、日線 | 是參數；重播跑不完就縮成一年或減少英雄 |
| 價格來源 | Yahoo Finance 日線收盤價，代號照 keeper | CSV 進版控，重播可重現 |

英雄在 UI 上標示為「模擬交易員（真實歷史價格回放）」。

## 4. 架構

```
Python  prices/*.csv ─┐
Python  strategies ───┼─> schedule.json ─> Node 重播 ─> Anvil（真的合約）
Python  roster ───────┘                                  │
                                                         ├─> events.json + chain.json
Python  analytics <── events.json + prices ──────────────┘
   └─> frontend/public/data/heroes/*.json ─> React
                                             React 另外照舊直接讀鏈（跟單、質押、信譽）
```

新目錄 `heroes/`。中間產物放 `heroes/out/`，不進版控。

## 5. 元件

### 5.1 價格（Python，`heroes/prices/`）

`fetch_prices.py` 存 `<asset>.csv`（`date,close`）。代號：BTC-USD、ETH-USD、AAPL、
TSLA、NVDA、MSFT、GOOGL、GC=F、BGRN、ICLN、ESGU。非交易日沿用前一個收盤價。

### 5.2 策略庫（Python，`heroes/strategies/`）—— 介面一

```python
@dataclass(frozen=True)
class Leg:
    asset: str          # "sBTC"…
    weight_bps: int     # 1..5000
    is_long: bool
    leverage: int       # 1 | 2 | 5，且不得超過該標的碳分級的上限

@dataclass(frozen=True)
class Rebalance:
    date: date
    legs: tuple[Leg, ...]   # 至少 3 個不同標的，weight_bps 合計 10000

def generate(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]: ...
def validate(r: Rebalance, max_leverage: dict[str, int]) -> None: ...  # 違規即 raise
```

純函式，無 I/O，同樣輸入必得同樣輸出。第一批：買入持有、固定比例定期再平衡、
趨勢跟隨（均線）、動量輪動（近 90 日最強的幾檔）、均值回歸（最弱的幾檔）、
風險平價（依波動度反比）、ESG 傾斜、多空配對、短週期槓桿動量。

馬丁式加倉與網格是逐筆策略（F1），不放進英雄；留給之後的「策略選擇 + backtest」，
那個功能會在這個模組旁邊加逐筆策略與回測引擎，共用價格資料。

### 5.3 英雄名冊與排程（Python）

`roster.py`：24 筆 `(name, strategy_id, params, seed, key_index, capital_usd,
stake_usd)`；前 12 位沿用 `SeedWhales.s.sol` 的名字。另有 60 個虛擬跟隨者與其
跟單／取消日期（固定種子產生）。

`build_schedule.py` 輸出 `heroes/out/schedule.json`：逐日的價格、每位英雄的
`Rebalance`、跟隨者動作。

### 5.4 重播（Node + ethers）

對象是剛用 §5.6 腳本部署好的乾淨 Anvil。位址由 Anvil 預設助記詞推導。

1. 初始化：鑄 MockUSDC、KYC 核可、存保證金、質押、註冊英雄。
2. 逐日：設定區塊時間為當日 → 更新 11 個價格 → 檢查並清算不健康的部位（F6）→
   有 `Rebalance` 的英雄：平掉全部部位、`publishStrategy`、依權重用目前可用保證金
   開新部位 → 執行當日的跟隨者跟單與取消。
3. 結束：掃出全部相關事件（開倉、平倉、清算、跟單、取消、罰沒、策略發布，各附區塊
   時間與交易雜湊）存成 `events.json`；`anvil_dumpState` 存成 `chain.json`。

單筆交易 revert 時記錄並跳過；結束時 revert 超過 1% 視為失敗。

### 5.5 分析（Python，`heroes/analytics.py`）—— 介面二

輸入 `events.json` 與價格 CSV，輸出到 `frontend/public/data/heroes/`。所有損益為
淨額（F8）。

`index.json`：

```jsonc
{
  "schemaVersion": 1,
  "chainId": 31337,
  "range": { "from": "2024-10-01", "to": "2026-10-09" },
  "heroes": [{
    "address": "0x…", "name": "ESG Master", "strategyId": "esg_tilt",
    "totalReturnPct": 0, "maxDrawdownPct": 0, "sharpe": 0,
    "winRatePct": 0, "closedTrades": 0, "esgScore": 0,
    "window7d":  { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "window30d": { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "sparkline": [0]                 // 權益曲線取 60 點
  }]
}
```

`<address 小寫>.json`：上述欄位，另加

```jsonc
{
  "equityCurve":    [{ "date": "2024-10-01", "equity": 0 }],
  "monthlyReturns": [{ "month": "2024-10", "returnPct": 0 }],
  "exposure":       [{ "asset": "sBTC", "weightPct": 0 }],
  "esgCorrelation": 0,               // 英雄日報酬與 sESGU 日報酬的相關係數
  "avgHoldDays": 0,
  "allocations": [{ "date": "2024-10-01", "versionId": 0, "tx": "0x…",
                    "legs": [{ "asset": "sBTC", "weightBps": 5000, "isLong": true, "leverage": 1 }] }],
  "trades": [{
    "positionId": 0, "asset": "sBTC", "isLong": true, "leverage": 1, "marginUsd": 0,
    "openTx": "0x…",  "openTime": 0,  "openPrice": 0,
    "closeTx": "0x…", "closeTime": 0, "closePrice": 0,
    "pnlUsd": 0, "grossPnlUsd": 0, "liquidated": false
  }]
}
```

金額是美元浮點數，百分比是 0–100 的數字，時間是 Unix 秒。視窗以重播最後一日往回算。

跟單人數、信譽、質押、罰沒、目前配置**不放進 JSON**，前端照舊直接讀鏈。

### 5.6 本機環境

- 新腳本 `contracts/script/DeployLocalDemo.s.sol`：`Deploy.s.sol` 的內容，加上 11 個
  標的、`ESGRegistryV2`（同時給交易所的碳定價與前端的 ESG 分數）、碳與 ESG 見證、
  `maxAttestationAge = 0`、股票與 ETF 標為需 KYC、保險金庫注資。只允許在 31337 執行。
- 位址寫入：只改 `addresses.ts` 的 ANVIL 區塊且保留全部欄位；不再使用
  `deploy-anvil.sh`（F10），該檔加註已過時。
- 啟動指令（在 WSL 執行）：以 `chain.json` 啟動 Anvil（`--host 0.0.0.0`）→ 啟動
  keeper 指向本機預言機，寫入即時價格（F12）→ 啟動前端，開啟跟單旗標。
- demo 帳號：一個固定的 Anvil 帳號，重播時已鑄幣並核可 KYC，匯入 MetaMask 使用。

### 5.7 前端

- 排行榜從 `MarketplacePage.tsx`（851 行）拆成獨立檔案。績效相關欄位（損益、勝率、
  交易量、權益縮圖、TraderScore 的報酬與勝率輸入）在 `index.json` 可用時改讀 JSON，
  取代瀏覽器掃事件（F9）；新增累積報酬、最大回撤、Sharpe 欄位，皆可排序。跟單人數、
  質押、信譽、配置照舊讀鏈。
- `index.json` 讀不到時退回現有的掃事件路徑（Base Sepolia 展示站行為不變）。
- 英雄頁（`TraderProfilePage`）：權益曲線、持倉分布、配置變更歷史、歷史交易列表
  （每筆附交易雜湊）。該位址沒有 JSON 時這些區塊不顯示；不得把讀不到顯示成 0。
- 跟單：排行榜 → 英雄頁 → `/copy/:addr` → Portfolio 我的跟單 → 取消，在 Anvil 上
  整條走通並修好。
- 圖表用 repo 已有的 `recharts`。

## 6. 分工（兩人）

| | 人一：資料與重播 | 人二：本機鏈與畫面 |
|---|---|---|
| 範圍 | §5.1–5.5 | §5.6–5.7 |
| 目錄 | `heroes/` | `contracts/script/`、`frontend/src/` |
| 週二 | 價格 CSV；`index.json` 假資料檔進 master | `DeployLocalDemo` + 位址寫入；確認 Anvil 在自己機器可跑 |
| 週三 | 策略庫 + 排程；3 位英雄 × 30 天重播跑通 | 排行榜拆檔與新欄位（假資料） |
| 週四 | 24 位 × 全期間重播 | 英雄頁；跟單流程在本機鏈走通 |
| 週五 | 分析輸出真資料 | 接真資料；啟動指令 |
| 週六 | 修問題 | 修問題 |
| 週日 | 緩衝 | 緩衝 |

兩個介面（§5.2、§5.5）與假資料檔先進 master，兩人從那裡開分支。人一週三的小規模
重播需要人二週二的部署腳本。

## 7. 範圍外

延到 10/19–10/20：月報酬熱圖、ESG 相關性的畫面、交易證明詳細展開（從鏈上讀出區塊、
時間、事件內容）、排行榜時間區間切換。資料欄位本次就產出。

不在本 spec：逐筆策略（馬丁、網格）與 backtest／forecast 畫面、GameFi、ESG 深化、
定位與託管說明、簡報與影片。

## 8. 已知落差

- **不是持續跟單**（F3）。使用者跟單後，英雄再調整配置，使用者的部位不會跟著動。
  要做成 eToro 那樣需要改 `CopyTracker`，不在本次範圍；畫面上要講清楚「複製的是
  目前這一版配置」。
- **績效數字是鏈下算的**。每個數字都能由 `events.json` 與鏈上交易重算，但 JSON
  本身是檔案，不是鏈上狀態。
- **重播結束到 demo 當天之間沒有交易**。demo 前重跑一次重播可縮短這段空窗。

## 9. 開工前要驗證的風險

1. **每位組員的機器能否跑 Anvil**。這台已確認要走 WSL 且版本可執行，但還沒實際起過
   節點；Windows 瀏覽器連 WSL 內的 8545 埠也還沒試。
2. **WSL 的 Python 環境**。需要使用者自行安裝 pip 與 venv；Python 3.14 上 pandas 與
   numpy 的版本要另外釘（`risk_model` 釘的 numpy 2.2.6 不支援 3.14）。
3. **費用下英雄的績效是否合理**。碳分級最嚴一級單邊手續費 1%，頻繁調整的英雄可能
   全部虧損。用 3 位英雄 × 30 天先看數字，必要時降低調整頻率。
4. **重播時間與狀態檔大小**。預估數萬筆交易。
5. **MetaMask 與重置後的本機鏈**。鏈重載後錢包的 nonce 快取會錯，需寫進 demo 步驟。

## 10. 測試

- 策略：每個策略一組 pytest，固定種子與小型價格表，斷言輸出；所有輸出都通過
  `validate`。
- 分析：以手算得出的小案例驗證報酬、回撤、Sharpe、勝率、淨額與毛額。
- 重播：3 位英雄 × 30 天的煙霧測試，斷言 revert 數為 0、鏈上平倉筆數與排程一致。
- 部署腳本：Foundry 測試斷言 11 個標的可開倉、碳分級已見證、非 31337 鏈拒絕執行。
- 前端：新增的純函式（JSON 轉排行榜資料、排序、缺資料處理）用 vitest；畫面在瀏覽器
  對著本機鏈實際操作驗證。
