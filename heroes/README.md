# heroes — 模擬交易者的資料管線

交易者排行榜上的「模擬交易者」從這裡來：真實歷史價格 → 策略排程 → 在本機 Anvil 上以真合約回放 →
由鏈上事件算出績效資料。spec 見 GitHub issue #309。

只在本機鏈（chainId 31337）運作。所有腳本連到別的鏈都會直接中止。

## 一次跑完

```bash
# 第一次：建立 Python 環境（venv 在 repo 內）
cd heroes && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && cd ..

# 每次要更新資料（展示前跑一次，把資料推到最新收盤日）
(cd heroes && . .venv/bin/activate && python fetch_prices.py && python build_schedule.py)
scripts/heroes-replay.sh
(cd heroes && . .venv/bin/activate && python build_analytics.py && python check_pipeline.py)
```

Windows 的 Git Bash 裡 venv 的路徑是 `.venv/Scripts/`：把 `. .venv/bin/activate` 換成
`. .venv/Scripts/activate`，或直接用 `.venv/Scripts/python`。

需要 PATH 上有 `anvil`／`forge`／`cast`。開啟 Smart App Control 的 Windows 機器請在 WSL 裡執行，
並先 `export PATH="$HOME/.foundry/bin:$PATH"`（見 `docs/agents/environment.md`）。

改完程式想快速驗證，用進版控的小規模排程（3 位交易者 × 30 天，一兩分鐘跑完）：

```bash
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
```

同一份排程回放兩次，結果逐筆相同（區塊號碼、交易雜湊、期末淨值）。

## 三個介面

| 介面 | 檔案 | 誰寫 → 誰讀 |
|---|---|---|
| 策略規則 | `herolab/rules.py` 的 `RULES` | 純函式 `(prices, params, seed) -> list[Rebalance]` |
| 回放排程 | `out/schedule.json` | Python → Node（`agent/heroes/replay.ts`） |
| 績效資料 | `../frontend/public/data/heroes/*.json` | Python → 前端 |

回放與分析之間另有 `out/events.json`（Node → Python）：開倉、平倉、清算、策略發布、跟隨、取消、罰沒，
各附區塊時間與交易雜湊；另附每位交易者期末從鏈上讀到的淨值與跟隨者人數。

## 產出

| 檔案 | 進版控 | 用途 |
|---|---|---|
| `prices/<asset>.csv` | 是 | 真實歷史日線收盤價；回放的唯一價格來源 |
| `tests/fixtures/schedule_smoke.json` | 是 | 小規模排程，測試用 |
| `out/schedule.json` | 否 | 逐日價格、每位交易者的策略、虛擬跟隨者的動作 |
| `out/addresses.json` | 否 | 本機鏈上各合約的位址 |
| `out/events.json` | 否 | 回放後從鏈上匯出的事件 |
| `out/chain.json` | 否 | 鏈狀態（含歷史區塊與交易收據）；展示時用 `anvil --load-state` 載入 |
| `../frontend/public/data/heroes/*.json` | 是 | 前端讀取的績效資料 |

## 展示時的價格

載入的鏈狀態停在回放的最後一天。展示時另起一個價格寫入程序，用 keeper 的價格來源定時把即時價格寫進
本機鏈的預言機，開倉與跟單才不會因為報價過期被拒絕：

```bash
anvil --host 0.0.0.0 --load-state heroes/out/chain.json --silent &
cast rpc evm_setNextBlockTimestamp "$(date +%s)"     # 把鏈的時間對到現在
(cd agent && npx tsx heroes/priceTick.ts)             # 預設每 60 秒一次，HEROES_TICK_SEC 可改
```

鏈重新載入後，錢包對這條鏈的 nonce 快取會錯：在錢包裡清掉這個帳號的活動紀錄再送交易。

## 測試

```bash
cd heroes && .venv/Scripts/python -m pytest          # 策略規則、排程、績效指標（Linux 用 .venv/bin/python）
cd agent && npm run test:heroes                      # 保證金拆分、清算判斷、位址寫入
heroes/.venv/Scripts/python heroes/check_pipeline.py # 整條管線對帳（要先跑過回放與分析）
```

`check_pipeline.py` 預設對照 `out/schedule.json`；小規模回放要把排程傳進去：
`python check_pipeline.py out/events.json tests/fixtures/schedule_smoke.json`。它檢查：沒有失敗或被跳過的交易、
平倉筆數、期末淨值與鏈上相差在本金 2% 以內、鏈上的跟隨者人數與排程一致。

## 新增一條策略規則

在 `herolab/rules.py` 寫一個純函式 `(prices, params, seed) -> list[Rebalance]`，加進 `RULES`，
在 `tests/test_rules.py` 的 `CASES` 加一筆。輸出必須通過 `herolab.model.validate`（與鏈上發布規則相同：
至少 3 個資產、單一資產 ≤ 50%、槓桿 1／2／5 且不超過該資產碳分級的上限）。

逐筆策略（馬丁式加倉、網格）不能用這個介面表達：鏈上發布的是一籃子部位，不是下單指令。

## 績效怎麼算

- 淨值 = 可用保證金 + 各未平倉部位的價值。未平倉部位的價值與 `PerpetualExchange.getPositionValue`
  相同：保證金 + 價差損益 − 平倉手續費 − 至今的借款費（費率是開倉時凍結的，從 `getPosition` 讀）。
- 資金費率不估：鏈上的資金費率指數不在事件裡，平倉時才實現、併入取回金額。有造市帳號拉平多空（見下一節）之後
  它幾乎為 0，完整回放的期末淨值與鏈上相差都在 0.01% 以內；`check_pipeline.py` 容許本金的 2%。
- 損益一律報淨額（平倉取回金額 − 保證金 − 開倉手續費），另附毛額（事件裡的價差損益）。

## 造市帳號

合約的資金費率由多空名目的失衡決定（最高每 8 小時 0.75%，人少的一邊最多領 10 倍），而模擬交易者與跟隨者幾乎都做多。
沒有對手方時，兩年下來資金費率會吃掉所有多單：第一次完整回放裡，1 倍持有 BTC 的交易者被清算到 −98.8%，
偶爾做空的反而每兩週領走半個本金——數字反映的是模擬造成的單邊失衡，不是價格。

所以回放裡有一個**造市帳號**（Anvil 索引 1，位址寫在 `events.json` 的 `marketMaker`）：每天換倉與跟單之後，
對每個資產把多空名目拉平（失衡超過 1% 才調整，開 1 倍反向部位；`agent/heroes/plan.ts` 的 `planHedge`）。
它不是模擬交易者，不上排行榜、績效資料也不算它；它承擔所有模擬交易者的反向損益，等於「鏈上真的有對手方」。
畫面上揭露模擬交易者的地方，也要說明有這個帳號。

另外，資金費率的 8 小時結算格線從資產第一次被碰到起算。回放開始前先在第一天 17:00 對每個資產 `settleFunding`
（第一次只啟動時鐘），結算點就落在 01:00／09:00／17:00，不會落在每天 21:00 換倉、多空暫時失衡的那幾秒。

## 規模（2024-10-01 到 2026-10-13）

743 天、24 位交易者、447 次策略調整、60 位跟隨者：約 13,900 筆交易，回放約 45 分鐘，`chain.json` 約 95 MB。
小規模排程（3 位 × 30 天）約 500 筆交易、一兩分鐘。

## 已知行為

- 使用槓桿的交易者會大幅虧損：槓桿借來的部分每小時收借款費（最低級距 0.01%／時），這是合約的費率。
- 績效資料是鏈下檔案，由鏈上事件算出；每個數字都能用 `events.json` 重算。
- 回放結束到展示當天之間，模擬交易者沒有新的交易。展示前重跑一次可以縮短這段空窗。
- 排程的最後一天是「每個資產都有收盤價」的最後一天。Yahoo 會把加密貨幣前一天的日線標成今天（尚未收盤），
  `fetch_prices.py` 把它當成未收盤丟掉，所以排程通常比股票資料少一天。
