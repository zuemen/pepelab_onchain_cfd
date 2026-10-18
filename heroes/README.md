# heroes — 模擬交易者的資料管線

交易者排行榜上的「模擬交易者」從這裡來：真實歷史價格 → 策略排程 → 在本機 Anvil 上以真合約回放 →
由鏈上事件算出績效資料。spec 見 GitHub issue #309。

預設只在本機鏈（chainId 31337）運作，連到別的鏈會直接中止。公開站（Base Sepolia，84532）的時間壓縮回放要明確帶
`--public-chain`，見下面「公開鏈（Base Sepolia，#344）」。

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

在 WSL 裡對 Windows 那份 checkout（`/mnt/c/...`）執行時，`agent/node_modules` 是在 Windows 上裝的，
只有 Windows 版的 esbuild，`npx tsx` 會報「You installed esbuild for another platform」。在 WSL 的家目錄
另放一份同版本的 Linux 版，讓 esbuild 改用它（只要做一次；agent 的 esbuild 升版後要重裝）：

```bash
# 在 repo 根目錄執行
V="$(node -p "require('./agent/node_modules/esbuild/package.json').version")"
mkdir -p ~/esbuild-linux && (cd ~/esbuild-linux && npm install --no-save "@esbuild/linux-x64@$V")
# 之後每個 WSL 終端機都要有這一行（可以加進 ~/.bashrc）
export ESBUILD_BINARY_PATH="$HOME/esbuild-linux/node_modules/@esbuild/linux-x64/bin/esbuild"
```

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
| 績效資料 | `../frontend/public/data/heroes/<chainId>/*.json` | Python → 前端 |

回放與分析之間另有 `out/events.json`（Node → Python）：開倉、平倉、清算、策略發布、跟隨、取消、罰沒，
各附區塊時間與交易雜湊；另附每位交易者期末從鏈上讀到的淨值與跟隨者人數，以及每個模擬日落在哪些區塊（`days`）。

## 產出

| 檔案 | 進版控 | 用途 |
|---|---|---|
| `prices/<asset>.csv` | 是 | 真實歷史日線收盤價；回放的唯一價格來源 |
| `tests/fixtures/schedule_smoke.json` | 是 | 小規模排程，測試用 |
| `out/schedule.json` | 否 | 逐日價格、每位交易者的策略、虛擬跟隨者的動作 |
| `out/addresses.json` | 否 | 本機鏈上各合約的位址 |
| `out/events.json` | 否 | 回放後從鏈上匯出的事件（含碳權退役的 `CarbonRetired` 與鏈上的累計退役噸數） |
| `out/chain.json` | 否 | 鏈狀態（含歷史區塊與交易收據）；展示時用 `anvil --load-state` 載入 |
| `../frontend/public/data/heroes/31337/*.json` | 是 | 本機展示讀的績效資料 |
| `../frontend/public/data/heroes/84532/*.json` | 是 | 公開站讀的績效資料（cutover 後產生，時間壓縮） |
| `keys/84532.json` | 否（被忽略） | 公開鏈回放的帳號金鑰，加密；擁有者保存 |

## 展示時的價格

載入的鏈狀態停在回放的最後一天。展示時另起一個價格寫入程序，用 keeper 的價格來源定時把即時價格寫進
本機鏈的預言機，開倉與跟單才不會因為報價過期被拒絕：

```bash
anvil --host 0.0.0.0 --load-state heroes/out/chain.json --silent &
cast rpc evm_setNextBlockTimestamp "$(date +%s)"     # 把鏈的時間對到現在
(cd agent && npx tsx heroes/priceTick.ts)             # 預設每 60 秒一次，HEROES_TICK_SEC 可改
```

鏈重新載入後，錢包對這條鏈的 nonce 快取會錯：在錢包裡清掉這個帳號的活動紀錄再送交易。

## 公開鏈（Base Sepolia，#344）

評審上公開站看模擬交易者、到 BaseScan 查證、跟單，所以同一份排程也要在 Base Sepolia 的新合約上回放一次。
公開鏈不能把時間撥回過去：兩年的交易在幾小時內跑完，**時間是壓縮的**。部署與上線的步驟只有擁有者能做，
完整流程在 `docs/OWNER_ACTIONS.md` 第 5 步「#344」；這裡說明程式怎麼做。

```bash
cd agent
HEROES_RPC_URL=<Infura/Alchemy> npx tsx heroes/chainAddresses.ts <新 exchange> ../heroes/out/addresses-84532.json
HEROES_RPC_URL=<Infura/Alchemy> npx tsx heroes/replay.ts --public-chain \
  ../heroes/out/schedule.json ../heroes/out/addresses-84532.json ../heroes/out/events-84532.json \
  --progress ../heroes/out/progress-84532.json --keystore ../heroes/keys/84532.json --deployer-account <Foundry keystore 名稱>
cd ../heroes && .venv/bin/python build_analytics.py out/events-84532.json && .venv/bin/python check_pipeline.py out/events-84532.json out/schedule.json
```

- **只允許 chainId 84532**，而且要明確帶 `--public-chain`、執行前輸入 `replay on 84532`；交易所讀的必須是部署者持有的
  專用 MockOracle（cutover 用 `ORACLE_KIND=fresh` 部署），KYC 與 MockUSDC 的 owner 必須是部署者，否則不送任何交易。
- **不用 Anvil 專屬的 RPC**（設區塊時間、設餘額）：部署者依當天要動的帳號轉 gas（`agent/heroes/gas.ts`），
  開倉付的執行費由 exchange 的 owner（部署者）每天領回再發。
- **帳號金鑰是新產生的**（`agent/heroes/keystore.ts`）：交易者、虛擬跟隨者、造市帳號與本機回放同樣的 index，
  但助記詞是第一次執行時隨機產生、加密寫進 `keys/84532.json`（被 git 忽略；放在 repo 裡沒被忽略的地方會拒絕寫入），
  絕不用 Anvil 的測試金鑰。
- **可以中斷續跑**（`agent/heroes/journal.ts`）：每個動作在進度檔裡有一個鍵，廣播前就記下交易雜湊；中斷之後原指令
  再跑一次，從最後完成的那一天接著跑，已經送出的不會再送（不確定有沒有上鏈的那幾筆先問節點）。
- **記下每一天的區塊範圍**：`events.json` 的 `days`；分析用它還原模擬日期。
- **同一天裡不同帳號平行送出**（`agent/heroes/sender.ts`）：同一個帳號依序排 nonce、在本機簽名，不每筆向節點問 nonce。
  `HEROES_CONCURRENCY`（預設 32）、`HEROES_LOG_CHUNK`（`eth_getLogs` 每段區塊數，預設 1000）可調。
- 每個模擬月份的最後一天照樣觸發一次 #333 的分流與退役。

時間壓縮的代價（畫面上的揭露都寫了）：借款費照鏈上持有時間計算、資金費率每 8 小時才結算，回放只有幾小時，
兩者幾乎是 0，槓桿交易者的績效比本機回放好很多；BaseScan 上的時間全是回放當天，頁面同時標示模擬日期與上鏈時間；
回放結束後模擬交易者不再換倉。

績效分析在壓縮模式（`events.json` 的 `timeCompressed`）下，交易與策略的日期用區塊範圍還原的模擬日，
不用區塊時間；未平倉部位的借款費照鏈上時間算，與 `getPositionValue` 一致。資料檔是 schema 3：`timeCompressed`，
每筆交易有 `openDate`／`closeDate`（模擬日期）與 `openTime`／`closeTime`（上鏈時間），每個策略版本有 `date`（模擬）與
`time`（上鏈）。

**fork 演練**（不需要任何金鑰，擁有者動手之前先跑）：

```bash
PY=heroes/.venv/bin/python node scripts/heroes-fork-rehearsal.mjs    # PATH 上要有 anvil／forge／cast
```

在 Base Sepolia 實況的 anvil fork 上照第 5 步部署（含新 MockOracle、#333、PepeIncentives、EsgRewardDistributor），
讀回核對；確認不帶 `--public-chain` 會拒絕 84532、確認字句不對不送交易；以公開鏈模式回放小規模排程、中途砍掉一次再續跑，
核對鏈上事件數與排程相同（沒有重複送出）、共用 MockOracle 沒被碰到；最後跑績效分析與對帳。部署者由 anvil 假冒
（`--impersonate-deployer`，只在節點自稱 anvil 時可用）。結果寫在 `out/fork-rehearsal/summary.md`。

## 碳權退役（#333）

本機部署的平台手續費收款人是分流合約（docs/ADR-022-carbon-retirement-splitter.md）：跟單費與跟單部位的績效費，
平台 20% 份額裡固定四分之一撥入退役預算，用來買入並銷毀**模擬碳權**。分配與退役都不需權限即可觸發：

- 回放：每個模擬月份的最後一天觸發一次，退役紀錄因此帶著模擬月份的時間。
- 展示：`priceTick.ts` 每一輪寫完價格順帶觸發，跟單之後下一輪就在 ESG 頁看得到這筆退役。
- 兩者用的是 keeper 同一份實作（`agent/keeper/carbon.ts`）。

## 本機展示

前置：跑過一次完整回放（上面的「一次跑完」），`heroes/out/chain.json` 存在。

```bash
scripts/heroes-demo.sh                 # 終端機一：本機鏈 + 即時價格（就是上一節那三行，加上結束時一起收掉）
cd frontend && yarn dev --mode heroes  # 終端機二：前端（Windows 上在 Windows 這一側跑也可以）
```

`--mode heroes` 會讀 `frontend/.env.heroes`，只在這次展示打開跟單、永續與槓桿；公開展示站不讀這個檔。

錢包設定只要做一次：新增網路（RPC `http://127.0.0.1:8545`、chain ID 31337），匯入 Anvil 預設帳號 (9)。
這個帳號在回放時已經拿到 100,000 測試穩定幣並通過 KYC，可以跟單任何一位交易者。
模擬錢包（Mock Wallet）讀不到鏈上資料，不能用於這個展示。

每次重新啟動 `heroes-demo.sh`，鏈都回到回放剛結束的樣子，所以錢包裡這個帳號的 nonce 快取會對不上：
到錢包的進階設定清除該帳號的活動紀錄，再送第一筆交易。

展示路線：`/marketplace`（Expert Mode）→ 依累積報酬排序 → 點一位交易者 → 看淨值曲線、點一筆部位的
交易雜湊（鏈上讀回）→ 按「跟單」→ 批准、跟隨 → `/portfolio` 看到自己的跟單與部位 → 取消跟單。

要說明的兩件事：
- 這些是模擬交易者：由程式依公開規則操作，價格是真實歷史價格，交易是真的鏈上交易，但不是真人。
- 跟單複製的是交易者目前這一版策略，不是持續跟隨。

## 測試

```bash
cd heroes && .venv/Scripts/python -m pytest          # 策略規則、排程、績效指標、策略實驗室的回測與預測（Linux 用 .venv/bin/python）
cd agent && npm run test:heroes                      # 保證金拆分、清算判斷、位址寫入；公開鏈模式的守門、續跑、送出、gas、金鑰
heroes/.venv/Scripts/python heroes/check_pipeline.py # 整條管線對帳（要先跑過回放與分析）
```

`check_pipeline.py` 預設對照 `out/schedule.json`，讀 `frontend/public/data/heroes/<events.json 的 chainId>/`；小規模回放要把排程傳進去：
`python check_pipeline.py out/events.json tests/fixtures/schedule_smoke.json`（`--data <dir>` 指定別的資料目錄）。它檢查：沒有失敗或被跳過的交易、
平倉筆數、期末淨值與鏈上相差在本金 2% 以內、鏈上的跟隨者人數與排程一致、匯出的退役事件總噸數等於鏈上的累計退役噸數；
時間壓縮的回放另查每個模擬日都有區塊範圍、依序不重疊。

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

## 策略實驗室（issue #332）

Expert 模式的 `/lab`：選一種策略、一組參數與標的，看回測與未來 90 天的淨值區間。資料全部預先算好，
前端只讀檔、不計算、不讀鏈，所以不需要本機鏈，公開展示站也看得到。

```bash
cd heroes && .venv/Scripts/python build_lab.py   # 只讀 prices/*.csv；16 核約 4 分鐘
```

輸出到 `../frontend/public/data/lab/`（進版控）：`index.json`（策略、參數格點、資產與費率、一籃資產、資料期間、格式版本）
加上每一組（策略、參數、標的）一個 `<策略>__<標的>__<參數值以 _ 串起>.json`，共 294 個、約 4.6 MB。同樣的價格檔跑兩次，輸出相同。

| 類別 | 策略 | 參數格點 | 標的 |
|---|---|---|---|
| 逐筆 | 定期定額 `dca` | 頻率 7／30 天 × 槓桿 1／2 | 11 個資產 |
| 逐筆 | 馬丁加倉 `martingale` | 加倉倍數 1.5／2 × 加倉間距 5／10% × 停利 5／10% | 11 個資產 |
| 逐筆 | 網格 `grid` | 間距 3／6／10% × 格數 5／10 | 11 個資產 |
| 持倉組合 | 動量、均值回歸、均線趨勢（`rules.py` 的規則） | 回看或均線 × 換倉頻率 × 槓桿 1／2 | 4 籃 |

回測（`herolab/lab.py`）：
- 每一筆都是交易所的一個部位：開倉、平倉各收「名目 × 碳分級手續費」，槓桿借來的部分每小時收借款費，
  價值不到名目的 5% 就清算、只退回剩下的 75%（扣清算獎勵 5% 與罰金 20%）。槓桿超過碳分級上限時用上限。資金費率與滑價不模擬。
- 日收盤價、每天先清算再下單，在收盤價成交。
- 馬丁加倉每一輪先買本金的 2%；錢不夠買下一筆就不加倉。網格一格同時只持有一筆；沒有持倉而價格漲過基準一格時，基準上移。
- 持倉組合類換倉日全平再照新版開，拆分方式與 `agent/heroes/plan.ts` 的 `planOpens` 相同。
- 對照線是第一天以 1 倍全部買進同一個標的（一籃時等權重）、之後不動。指標與排行榜相同（`analytics.py`）。

預測（`herolab/forecast.py`）：把回測期間所有資產的日報酬每 10 天一段（同一段日子）隨機抽樣，接成 1,000 條 90 天的路徑，
固定種子；每條路徑都讓策略從最後一天的收盤價、全新本金開始跑一次，取第 5／25／50／75／95 百分位與期末虧損、虧掉一半以上的機率。
這是根據歷史波動的模擬，不是預測模型。

「相近的模擬交易者」由前端依 `index.json` 每位交易者的 `rule` 對應，只有持倉組合類有；只在連線的鏈有本機鏈的績效資料時顯示。

## 規模（2024-10-01 到 2026-10-13）

743 天、24 位交易者、447 次策略調整、60 位跟隨者：約 13,900 筆交易，回放約 45 分鐘，`chain.json` 約 95 MB。
小規模排程（3 位 × 30 天）約 500 筆交易、一兩分鐘。

## 已知行為

- 使用槓桿的交易者會大幅虧損：槓桿借來的部分每小時收借款費（最低級距 0.01%／時），這是合約的費率。
- 績效資料是鏈下檔案，由鏈上事件算出；每個數字都能用 `events.json` 重算。
- 回放結束到展示當天之間，模擬交易者沒有新的交易。展示前重跑一次可以縮短這段空窗。
- 排程的最後一天是「每個資產都有收盤價」的最後一天。Yahoo 會把加密貨幣前一天的日線標成今天（尚未收盤），
  `fetch_prices.py` 把它當成未收盤丟掉，所以排程通常比股票資料少一天。
