# 監控規則清單

> **由 `node scripts/check-monitoring.mjs --write` 從 [`monitors.json`](monitors.json) 產生，不要手改。**
> CI（`consistency.yml` 的 `monitoring` job）會檢查本檔、`monitors.json` 與前端設定／ABI 三者一致。
>
> - 位址一律由 `frontend/src/contracts/**` 解析（下表「位址來源」），不手抄。
> - 嚴重度定義與處置見 [`docs/INCIDENT_RESPONSE.md`](../../docs/INCIDENT_RESPONSE.md)。
> - 決策與方案比較見 [`docs/ADR-009-monitoring.md`](../../docs/ADR-009-monitoring.md)；部署步驟見 [`README.md`](README.md)。
> - 「待部署」規則的事件只存在於 master 原始碼，對應合約尚未部署；Worker 不載入，部署後改為 `active`。
> - 「**部署版不發此事件**」：合約已部署，但鏈上那一版不發這個事件（前端 ABI 來自 master 原始碼，比部署版新）。
>   這些事件**現在不會響**；有對應 setter 的由「狀態」規則每輪讀 getter 比對。依據是 [`deployed.json`](deployed.json)（唯讀 RPC 抓的 runtime bytecode，CI 離線比對 topic0）。

共 **43** 條規則：運作中 32 條（事件 21、狀態 9、HTTP 2），部署版不發此事件 10 條，待部署 1 條。鏈：base-sepolia（84532）。
已部署 bytecode 快照：區塊 47536389（2026-10-01）。

## 總表

| 規則 | 分類 | 類型 | 嚴重度 | 狀態 | 門檻 | 處置 |
|---|---|---|---|---|---|---|
| [`owner-transferred`](#owner-transferred) 合約 owner 變更 | 權限 | 事件 | SEV-1 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§8](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911) |
| [`access-role-changed`](#access-role-changed) AccessControl 角色變更 | 權限 | 事件 | SEV-1 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§8](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911) |
| [`vault-upgraded`](#vault-upgraded) 代幣化金庫升級或改接 oracle | 權限 | 事件 | SEV-1 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§8](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911) |
| [`exchange-agent-authorization`](#exchange-agent-authorization) 交易所 agent 授權變更 | 權限 | 事件 | SEV-1 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`kyc-verifier-changed`](#kyc-verifier-changed) KYC 驗證者變更 | 權限 | 事件 | SEV-2 | 部署版不發此事件 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`exchange-wiring-changed`](#exchange-wiring-changed) 交易所資金接線變更 | x402／FeeRouter 設定 | 事件 | SEV-1 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`insurance-wiring-changed`](#insurance-wiring-changed) 保險金庫接線變更 | x402／FeeRouter 設定 | 事件 | SEV-1 | 部署版不發此事件 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`feerouter-config-changed`](#feerouter-config-changed) FeeRouter 設定變更（含 x402 分潤路由） | x402／FeeRouter 設定 | 事件 | SEV-2 | 部署版不發此事件 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`insurance-wiring`](#insurance-wiring) 保險金庫接線被改 | x402／FeeRouter 設定 | 狀態 | SEV-1 | 運作中 | 任一 getter 的讀值 ≠ 預期位址 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`feerouter-wiring`](#feerouter-wiring) FeeRouter 接線被改（含 x402 分潤路由） | x402／FeeRouter 設定 | 狀態 | SEV-1 | 運作中 | 任一 getter 的讀值 ≠ 預期位址 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`core-wiring`](#core-wiring) 核心合約接線與前端設定不一致 | x402／FeeRouter 設定 | 狀態 | SEV-1 | 運作中 | 任一 getter 的讀值 ≠ 預期位址 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`x402-payto`](#x402-payto) x402 收款地址 | x402／FeeRouter 設定 | HTTP | SEV-1 | 運作中 | `payTo` ≠ `EXPECTED_PAY_TO`（未設時為首次觀察值）→ SEV-1；`payToSafety.safe == false` → SEV-3 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§6](../../docs/INCIDENT_RESPONSE.md#6-vercel-回滾前端與-signal-api) |
| [`exchange-risk-params`](#exchange-risk-params) 交易所風險參數變更 | 風險參數 | 事件 | SEV-3 | 運作中 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`vault-pause-changed`](#vault-pause-changed) 代幣化金庫暫停／mint 停止解除 | 暫停與資產模式 | 事件 | SEV-2 | 運作中 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§7](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整) |
| [`vault-risk-params`](#vault-risk-params) 代幣化金庫風險參數與資產登記變更 | 風險參數 | 事件 | SEV-3 | 運作中 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`vault-reserve-breached`](#vault-reserve-breached) 代幣化金庫儲備率跌破下限（鏈上事件） | 保險金與儲備 | 事件 | SEV-2 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`guarded-oracle-guardian`](#guarded-oracle-guardian) GuardedOracle 暫停／凍結／參數變更 | 暫停與資產模式 | 事件 | SEV-2 | 運作中 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`guarded-oracle-price-rejected`](#guarded-oracle-price-rejected) GuardedOracle 拒絕價格更新 | Oracle | 事件 | SEV-3 | 運作中 | 每一筆 | [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`mock-oracle-config`](#mock-oracle-config) 交易所 oracle 設定變更 | Oracle | 事件 | SEV-2 | 運作中 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`aggregator-oracle-config`](#aggregator-oracle-config) Chainlink/Pyth 聚合 oracle 設定變更 | Oracle | 事件 | SEV-2 | 運作中 | 每一筆 | [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`exchange-bad-debt`](#exchange-bad-debt) 交易所壞帳或自動減倉 | 保險金與儲備 | 事件 | SEV-2 | 運作中 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§7](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整) |
| [`large-margin-withdrawal`](#large-margin-withdrawal) 交易所大額提領 | 大額提領 | 事件 | SEV-2 | 運作中 | 單筆 ≥ `LARGE_WITHDRAWAL_USDC`（預設 10000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`insurance-withdrawal`](#insurance-withdrawal) 保險金庫大額贖回 | 大額提領 | 事件 | SEV-2 | 運作中 | 單筆 ≥ `INSURANCE_WITHDRAW_USDC`（預設 5000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`insurance-bailout`](#insurance-bailout) 保險金 bailout | 保險金與儲備 | 事件 | SEV-2 | 運作中 | 每一筆（`BAILOUT_MIN_USDC`（預設 0 USDC（MockUSDC）））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`vault-large-redeem`](#vault-large-redeem) 代幣化金庫大額 redeem | 大額提領 | 事件 | SEV-2 | 運作中 | 單筆 ≥ `LARGE_REDEEM_USDC`（預設 10000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`fee-withdrawals`](#fee-withdrawals) 平台手續費提領（V1 FeeRouter） | 大額提領 | 事件 | SEV-3 | 運作中 | 每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) |
| [`x402-fee-withdrawals`](#x402-fee-withdrawals) x402 分潤路由手續費提領 | x402／FeeRouter 設定 | 事件 | SEV-3 | 運作中 | 每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 6 位小數（USDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) |
| [`vault-fees-withdrawn`](#vault-fees-withdrawn) 代幣化金庫手續費提領 | 大額提領 | 事件 | SEV-3 | 運作中 | 每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 18 位小數（MockUSDC） | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) |
| [`oracle-stale`](#oracle-stale) 交易所價格過期 | Oracle | 狀態 | SEV-2 | 運作中 | 加密資產：≥ `ORACLE_STALE_WARN_SEC`（預設 14400 秒） → SEV-3；≥ 鏈上 `maxPriceAge()` → SEV-2。其他資產：≥ `NONCRYPTO_STALE_SEC`（預設 259200 秒） → SEV-3 | [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`oracle-deviation`](#oracle-deviation) 交易所價格偏離參考價 | Oracle | 狀態 | SEV-2 | 運作中 | 偏離 ≥ `ORACLE_DEVIATION_BPS`（預設 300 bps） → SEV-2；≥ `ORACLE_DEVIATION_CRIT_BPS`（預設 1000 bps） → SEV-1；參考價超過 `REFERENCE_MAX_AGE_SEC`（預設 7200 秒） 不比對 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`guarded-oracle-paused`](#guarded-oracle-paused) GuardedOracle 暫停中 | 暫停與資產模式 | 狀態 | SEV-3 | 運作中 | `paused() == true` | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`insurance-fund`](#insurance-fund) 保險金下降 | 保險金與儲備 | 狀態 | SEV-2 | 運作中 | `totalAssets()` < `INSURANCE_MIN_USDC`（預設 100 USDC（MockUSDC）），或較 24 小時高點下降 ≥ `INSURANCE_DROP_BPS`（預設 2000 bps） → SEV-2 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) [§7](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整) |
| [`vault-reserve`](#vault-reserve) 代幣化金庫儲備率 | 保險金與儲備 | 狀態 | SEV-2 | 運作中 | 儲備率 < `minReserveRatioBps()` → SEV-2；< 下限 + `RESERVE_WARN_MARGIN_BPS`（預設 500 bps） → SEV-3；mint 自動停止 → SEV-2；無法定價或暫停 → SEV-3 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`keeper-gas`](#keeper-gas) keeper 錢包 gas 過低 | keeper | 狀態 | SEV-3 | 運作中 | < `GAS_MIN_ETH`（預設 0.02 ETH） → SEV-3；< `GAS_CRIT_ETH`（預設 0.005 ETH） → SEV-2 | [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`signal-api-health`](#signal-api-health) signal-api 健康檢查失敗 | 服務健康 | HTTP | SEV-3 | 運作中 | 非 200 或內容不是 `ok`，連續 `HTTP_FAILS_BEFORE_ALERT`（預設 2 次） | [§6](../../docs/INCIDENT_RESPONSE.md#6-vercel-回滾前端與-signal-api) |
| [`exchange-pause`](#exchange-pause) 交易所全域暫停 | 暫停與資產模式 | 事件 | SEV-1 | 部署版不發此事件 | 每一筆 | [§4](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼) [§7](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整) |
| [`exchange-asset-mode`](#exchange-asset-mode) 交易所資產模式變更 | 暫停與資產模式 | 事件 | SEV-2 | 部署版不發此事件 | 每一筆 | [§4](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼) [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`exchange-guardian-roles`](#exchange-guardian-roles) 交易所 guardian／marketOperator 變更 | 權限 | 事件 | SEV-1 | 部署版不發此事件 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§4](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼) |
| [`exchange-exposure-caps`](#exchange-exposure-caps) 交易所 OI／獲利上限變更與觸發 | 風險參數 | 事件 | SEV-3 | 部署版不發此事件 | 每一筆 | [§4](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼) |
| [`timelock-operations`](#timelock-operations) Timelock 排程與執行 | 權限 | 事件 | SEV-2 | 待部署 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) [§2](../../docs/INCIDENT_RESPONSE.md#2-角色) |
| [`vault-unpriced-exemption`](#vault-unpriced-exemption) 金庫定價豁免變更（V2.5） | 保險金與儲備 | 事件 | SEV-2 | 部署版不發此事件 | 每一筆 | [§3](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼) |
| [`guarded-oracle-window`](#guarded-oracle-window) GuardedOracle 時間窗偏離上限變更 | Oracle | 事件 | SEV-3 | 部署版不發此事件 | 每一筆 | [§5](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置) |
| [`copytracker-slash-reserve`](#copytracker-slash-reserve) CopyTracker 罰沒準備金提領 | 大額提領 | 事件 | SEV-2 | 部署版不發此事件 | 每一筆 | [§1](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級) |

「嚴重度」是規則的預設等級；狀態規則依門檻在 SEV-1～SEV-3 之間升降（見各規則）。恢復通知固定標為 SEV-4，但依原嚴重度決定是否送出。

## 參數（門檻）

預設值在 `monitors.json`；可用 Worker 的 `[vars]` 覆寫（見 README）。標「待使用者決定」的是佔位值。

| 參數 | 預設 | 單位 | 說明 |
|---|---|---|---|
| `CONFIRMATIONS` | `3` | 區塊 | 只掃 head 往前這麼多塊之前的區塊，降低 reorg 造成的假告警 |
| `INITIAL_LOOKBACK_BLOCKS` | `300` | 區塊 | 第一次執行（KV 沒有檢查點）往回掃的區塊數（Base 約 2 秒一塊，300 塊約 10 分鐘） |
| `MAX_BLOCK_RANGE` | `1000` | 區塊 | 每個 eth_getLogs 的最大範圍。公開 RPC（sepolia.base.org）實測上限 1,000 塊，超過回 HTTP 413／-32614；CI 限制此值 ≤ 1000。節點拒絕範圍時引擎會自動減半重試 |
| `MAX_SCAN_REQUESTS` | `10` | 個請求 | 每輪最多幾個 eth_getLogs（含範圍減半後的重試）。落後時一輪內分多段追趕：10 × 1000 塊 ≈ 5.5 小時的積欠；受 Cloudflare 免費方案每次執行 50 個 subrequest 限制，不要調高到擠壓狀態規則與通知 |
| `LAG_ALERT_BLOCKS` | `3000` | 區塊 | 一輪掃完後仍落後超過這個值時發監控自身告警（代表一輪追不完，或 eth_getLogs 持續失敗） |
| `REMIND_SEC` | `21600` | 秒 | 狀態型告警持續未解除時的重複提醒間隔（6 小時） |
| `MIN_SEVERITY` | `SEV-4` | 嚴重度 | 低於此嚴重度的通知不送（恢復通知以原嚴重度判斷） |
| `LARGE_WITHDRAWAL_USDC` | `10000` | USDC（MockUSDC） | 交易所單筆提領保證金的告警門檻【待使用者決定】 |
| `LARGE_WITHDRAWAL_WINDOW_USDC` | `50000` | USDC（MockUSDC） | 同一規則在 WITHDRAWAL_WINDOW_SEC 內累計提領的告警門檻【待使用者決定】 |
| `WITHDRAWAL_WINDOW_SEC` | `3600` | 秒 | 累計提領的視窗長度 |
| `INSURANCE_WITHDRAW_USDC` | `5000` | USDC（MockUSDC） | 保險金庫單筆贖回的告警門檻【待使用者決定】 |
| `BAILOUT_MIN_USDC` | `0` | USDC（MockUSDC） | 保險金 bailout 的告警門檻；0 表示每一筆都告警 |
| `LARGE_REDEEM_USDC` | `10000` | USDC（MockUSDC） | 代幣化金庫單筆 redeem 的告警門檻【待使用者決定】 |
| `FEE_WITHDRAW_ALERT_USDC` | `0` | USDC | 平台手續費提領的告警門檻；0 表示每一筆都通知（稽核用） |
| `ORACLE_STALE_WARN_SEC` | `14400` | 秒 | 加密資產價格超過此時間未更新即預警（交易所硬上限 maxPriceAge 由鏈上讀取，現行 6 小時） |
| `NONCRYPTO_STALE_SEC` | `259200` | 秒 | 股票／ETF／商品的過期門檻（72 小時，涵蓋一般週末與連假；精確的休市判斷仍由 oracle-health.yml 負責） |
| `ORACLE_DEVIATION_BPS` | `300` | bps | 交易所 oracle 與 Chainlink/Pyth 聚合價偏離的告警門檻（3%） |
| `ORACLE_DEVIATION_CRIT_BPS` | `1000` | bps | 偏離達此值視為「價格明顯錯誤且交易仍在進行」，升為 SEV-1（10%） |
| `REFERENCE_MAX_AGE_SEC` | `7200` | 秒 | 參考價本身超過此時間未更新就不拿來比對（避免拿舊的參考價誤報） |
| `INSURANCE_MIN_USDC` | `100` | USDC（MockUSDC） | 保險金庫 totalAssets 的絕對下限【待使用者決定】；2026-10-01 唯讀查詢現值約 150 |
| `INSURANCE_DROP_BPS` | `2000` | bps | 保險金較 24 小時內高點下降超過此比例即告警（20%） |
| `RESERVE_WARN_MARGIN_BPS` | `500` | bps | 儲備率低於 minReserveRatioBps + 此值即預警 |
| `GAS_MIN_ETH` | `0.02` | ETH | keeper 錢包 gas 餘額預警門檻【待使用者決定】 |
| `GAS_CRIT_ETH` | `0.005` | ETH | keeper 錢包 gas 餘額嚴重門檻【待使用者決定】 |
| `SIGNAL_API_URL` | `https://agent-git-master-zuemens-projects.vercel.app` | URL | signal-api 的基底網址；預設值必須等於 agent/sdk/src/signalApi.ts 的 SIGNAL_API_TESTNET_URL（CI 檢查） |
| `HTTP_FAILS_BEFORE_ALERT` | `2` | 次 | 健康檢查連續失敗幾次才告警（避免單次抖動） |

## 規則明細

### owner-transferred

**合約 owner 變更**｜權限｜事件｜SEV-1｜運作中

Ownable 合約的 owner 被轉移。未經排程的轉移等同特權金鑰外洩或誤操作；即使是預期中的移交（例如移交 Timelock），也要人工核對新 owner。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |
| InsuranceVault（ABI `InsuranceVault`） | addresses.ts BASE_SEPOLIA.InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |
| FeeRouter（ABI `FeeRouter`） | addresses.ts BASE_SEPOLIA.FeeRouter | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` |
| X402FeeRouter（ABI `FeeRouter`） | x402.ts X402_FEE_ROUTER[84532] | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` |
| MockOracle（ABI `MockOracle`） | addresses.ts BASE_SEPOLIA.MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |
| AggregatorOracle（ABI `AggregatorOracleAdapter`） | addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.AggregatorOracle | `0x8215158642350a3f329aB9597186d21f957A813D` |
| ChainlinkAdapter（ABI `ChainlinkOracleAdapter`） | addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.ChainlinkAdapter | `0x37DC7b70899BFfB17949366a5b6a86203C428E2f` |
| PythAdapter（ABI `PythOracleAdapter`） | addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.PythAdapter | `0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5` |
| KYCRegistry（ABI `KYCRegistry`） | addresses.ts BASE_SEPOLIA.KYCRegistry | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` |
| TraderStake（ABI `TraderStake`） | addresses.ts BASE_SEPOLIA.TraderStake | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` |
| AssetVault（ABI `AssetVault`） | addresses.ts BASE_SEPOLIA.AssetVault | `0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5` |

- 事件：`OwnershipTransferred(address,address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「8. 外部協助：SEAL 911」](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911)
- 相關：[RUNBOOK_KEY_ROTATION.md「1.1 合約 ownership」](../../docs/RUNBOOK_KEY_ROTATION.md#11-合約-ownership)

### access-role-changed

**AccessControl 角色變更**｜權限｜事件｜SEV-1｜運作中

金庫、GuardedOracle、碳分級登錄、徽章與 V2 合成資產代幣的角色授予／撤銷／admin 變更。授予 MINTER、PAUSER、GUARDIAN、KEEPER 或 DEFAULT_ADMIN 都能直接影響資金或價格。訊息會把已知角色雜湊翻成名稱。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |
| GuardedOracle（ABI `GuardedOracle`） | addresses.ts V2_STACK[84532].GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` |
| ESGRegistryV2（ABI `ESGRegistryV2`） | addresses.ts V2_STACK[84532].ESGRegistryV2 | `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` |
| SustainabilityBadge（ABI `SustainabilityBadge`） | addresses.ts V2_STACK[84532].SustainabilityBadge | `0x0a4aE14a413a03c20ccF43E8134BfbD7bCB89820` |
| V2_STACK.tokens.sBTC（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sBTC | `0x0aF44425ADC54fdBcB084611Ca82beFb91DDb1b6` |
| V2_STACK.tokens.sETH（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sETH | `0xc81Bc66656E7d32A570895B7ba8a3Fc9aa9997f1` |
| V2_STACK.tokens.sAAPL（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sAAPL | `0x4f36CBc3321b47327407C0eD116188A21ec4da28` |
| V2_STACK.tokens.sTSLA（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sTSLA | `0xD816E621849eb8849D032dc39dD37e39cd668144` |
| V2_STACK.tokens.sGOLD（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sGOLD | `0xd74aE712B412488Bb18F604052B232fea22270DA` |
| V2_STACK.tokens.sBOND（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sBOND | `0x14496785f82F691656691486C49c3b8fB78BF770` |
| V2_STACK.tokens.sNVDA（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sNVDA | `0x881a8B8b4eacf7103078d6d5e81bfB4E344f3003` |
| V2_STACK.tokens.sMSFT（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sMSFT | `0x893a8F9Fd92110EBcAbB8855223CF184B54a7166` |
| V2_STACK.tokens.sGOOGL（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sGOOGL | `0xaD7348198fdbb89eEeAC4E607E917DE8A91CD834` |
| V2_STACK.tokens.sICLN（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sICLN | `0xcb3069C32188Fd92376d1ba53F08D733451e9175` |
| V2_STACK.tokens.sESGU（ABI `SyntheticAssetV2`） | addresses.ts V2_STACK[84532].tokens.sESGU | `0x510D59b33C04164596D2601B57a154dF31914C23` |

- 事件：`RoleGranted(bytes32,address,address)`、`RoleRevoked(bytes32,address,address)`、`RoleAdminChanged(bytes32,bytes32,bytes32)`（**部署版不發此事件**；這些合約都沒有呼叫 _setRoleAdmin，編譯器沒有把這個事件編進 bytecode；角色的 admin 無法被改）
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「8. 外部協助：SEAL 911」](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911)
- 相關：[RUNBOOK_KEY_ROTATION.md「1.3 身分／角色」](../../docs/RUNBOOK_KEY_ROTATION.md#13-身分角色)

### vault-upgraded

**代幣化金庫升級或改接 oracle**｜權限｜事件｜SEV-1｜運作中

AssetVaultV2 是 UUPS proxy：Upgraded 代表實作合約被換掉；OracleChanged／EsgRegistrySet 代表定價來源被改接。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`Upgraded(address)`、`OracleChanged(address,address)`、`EsgRegistrySet(address,address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「8. 外部協助：SEAL 911」](../../docs/INCIDENT_RESPONSE.md#8-外部協助seal-911)

### exchange-agent-authorization

**交易所 agent 授權變更**｜權限｜事件｜SEV-1｜運作中

setAgentAuthorized：被授權的地址可以代使用者開平倉。新增未知的 agent 等同新增一個可動用部位的特權地址。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 事件：`AgentAuthorizationSet(address,bool)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### kyc-verifier-changed

**KYC 驗證者變更**｜權限｜事件｜SEV-2｜部署版不發此事件

KYCRegistry 的驗證者名單變更；驗證者可以讓任意地址通過 RWA 資產的 KYC 門檻。**已部署的 KYCRegistry 是舊版：沒有 setVerifier／verifiers，也不發 VerifierSet**（只有 owner 能 batchVerify，owner 變更由 owner-transferred 監控），所以部署版沒有這個攻擊面，也沒有東西可以輪詢。新版部署並更新 deployed.json 後改為 active。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| KYCRegistry | addresses.ts BASE_SEPOLIA.KYCRegistry（`0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d`）；部署版不發此事件，事件宣告於 `contracts/src/KYCRegistry.sol` | — |

- 事件：`VerifierSet(address,bool)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### exchange-wiring-changed

**交易所資金接線變更**｜x402／FeeRouter 設定｜事件｜SEV-1｜運作中

交易所的 FeeRouter、保險金庫、CopyTracker、KYC 登錄被改指向其他合約：手續費與 bailout 的去向因此改變。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 事件：`FeeRouterSet(address)`、`InsuranceVaultSet(address)`、`CopyTrackerSet(address)`、`KycRegistrySet(address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### insurance-wiring-changed

**保險金庫接線變更**｜x402／FeeRouter 設定｜事件｜SEV-1｜部署版不發此事件

InsuranceVault 的 exchange（唯一能呼叫 bailout 的地址）或 FeeRouter 被改。**已部署的 InsuranceVault 有 setExchange／setFeeRouter，但不發這兩個事件**（事件是 master 原始碼後來才加的），所以這條事件規則現在不會響；接線變更由狀態規則 insurance-wiring 每輪讀 getter 比對。重新部署 InsuranceVault 並更新 deployed.json 後改為 active。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| InsuranceVault | addresses.ts BASE_SEPOLIA.InsuranceVault（`0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812`）；部署版不發此事件，事件宣告於 `contracts/src/InsuranceVault.sol` | — |

- 事件：`ExchangeSet(address)`、`FeeRouterSet(address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### feerouter-config-changed

**FeeRouter 設定變更（含 x402 分潤路由）**｜x402／FeeRouter 設定｜事件｜SEV-2｜部署版不發此事件

V1 FeeRouter 與 x402 FeeRouter（官方 USDC）的 exchange／copyTracker 被改。**已部署的兩顆 FeeRouter 有 setExchange／setCopyTracker，但不發這兩個事件**，所以這條事件規則現在不會響；接線變更由狀態規則 feerouter-wiring 每輪讀 getter 比對。重新部署並更新 deployed.json 後改為 active。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| FeeRouter | addresses.ts BASE_SEPOLIA.FeeRouter（`0x00f6cf0113399a7A451c7f85fe094a28092d3e0c`）；部署版不發此事件，事件宣告於 `contracts/src/FeeRouter.sol` | — |
| X402FeeRouter | x402.ts X402_FEE_ROUTER[84532]（`0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d`）；部署版不發此事件，事件宣告於 `contracts/src/FeeRouter.sol` | — |

- 事件：`ExchangeSet(address)`、`CopyTrackerSet(address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)
- 相關：[RUNBOOK_KEY_ROTATION.md「6.2 x402 payTo / platformTreasury」](../../docs/RUNBOOK_KEY_ROTATION.md#62-x402-payto--platformtreasury)

### insurance-wiring

**保險金庫接線被改**｜x402／FeeRouter 設定｜狀態｜SEV-1｜運作中

每輪讀 InsuranceVault.exchange()（唯一能呼叫 bailout 的地址）與 feeRouter()，必須等於前端設定的 PerpetualExchange 與 FeeRouter。已部署的 InsuranceVault 的 setter 不發事件，只能靠輪詢（最長延遲一輪）。合約 cutover 時 addresses.ts 與 deployed.json 一起更新，預期值會跟著換。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| InsuranceVault（ABI `InsuranceVault`） | addresses.ts BASE_SEPOLIA.InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |

- 預期：`InsuranceVault.exchange()` = `PerpetualExchange`（`0x827eA0c62a32e995927101259042F8A27D99124D`）
- 預期：`InsuranceVault.feeRouter()` = `FeeRouter`（`0x00f6cf0113399a7A451c7f85fe094a28092d3e0c`）
- 門檻：任一 getter 的讀值 ≠ 預期位址
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### feerouter-wiring

**FeeRouter 接線被改（含 x402 分潤路由）**｜x402／FeeRouter 設定｜狀態｜SEV-1｜運作中

每輪讀 V1 FeeRouter 與 x402 FeeRouter 的 exchange()／copyTracker()／insuranceVault()／platformTreasury()。V1 必須指向前端設定的 PerpetualExchange／CopyTracker／InsuranceVault；x402 那顆部署時 exchange 與 copyTracker 都是零位址（只走 routeExternalRevenue），任何一個被設成非零都代表有人接上了能分配手續費的合約。已部署的 FeeRouter 的 setter 不發事件，只能靠輪詢。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| FeeRouter（ABI `FeeRouter`） | addresses.ts BASE_SEPOLIA.FeeRouter | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` |
| X402FeeRouter（ABI `FeeRouter`） | x402.ts X402_FEE_ROUTER[84532] | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` |

- 預期：`FeeRouter.exchange()` = `PerpetualExchange`（`0x827eA0c62a32e995927101259042F8A27D99124D`）
- 預期：`FeeRouter.copyTracker()` = `CopyTracker`（`0xC9e91f7D36e910C58042164032c625427b23CCB2`）
- 預期：`FeeRouter.insuranceVault()` = `InsuranceVault`（`0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812`）
- 預期：`FeeRouter.platformTreasury()` = 鏈上快照 `0xe80a81360608c1342e66743f70a00f75d792eb93`（platformTreasury 是 immutable，前端設定沒有這個位址；快照只用來確認這顆 FeeRouter 沒有被換成另一顆）
- 預期：`X402FeeRouter.exchange()` = 零位址
- 預期：`X402FeeRouter.copyTracker()` = 零位址
- 預期：`X402FeeRouter.insuranceVault()` = 鏈上快照 `0xc7afe2064106a608e0e21bfbf9aff89b0ead7b9f`（x402 FeeRouter 部署時指定的保險金收款地址（immutable），前端設定沒有這個位址）
- 預期：`X402FeeRouter.platformTreasury()` = 鏈上快照 `0xe80a81360608c1342e66743f70a00f75d792eb93`（immutable；x402.ts 註明這是待更換的 treasury，重新部署 X402FeeRouter 時位址與快照一起換）
- 門檻：任一 getter 的讀值 ≠ 預期位址
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### core-wiring

**核心合約接線與前端設定不一致**｜x402／FeeRouter 設定｜狀態｜SEV-1｜運作中

每輪讀交易所的 oracle()／feeRouter()／insuranceVault()／kyc()、TraderStake.copyTracker()（唯一能 slash 的地址）、AssetVaultV2 的 oracle()／esgRegistry()，必須等於前端設定。這些 setter 在部署版有事件（另有事件規則），這條是第二道：事件漏掉或 addresses.ts 與鏈上脫鉤時仍會持續告警，直到兩邊一致。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |
| TraderStake（ABI `TraderStake`） | addresses.ts BASE_SEPOLIA.TraderStake | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` |
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 預期：`PerpetualExchange.oracle()` = `MockOracle`（`0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3`）
- 預期：`PerpetualExchange.feeRouter()` = `FeeRouter`（`0x00f6cf0113399a7A451c7f85fe094a28092d3e0c`）
- 預期：`PerpetualExchange.insuranceVault()` = `InsuranceVault`（`0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812`）
- 預期：`PerpetualExchange.kyc()` = `KYCRegistry`（`0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d`）
- 預期：`TraderStake.copyTracker()` = `CopyTracker`（`0xC9e91f7D36e910C58042164032c625427b23CCB2`）
- 預期：`AssetVaultV2.oracle()` = `GuardedOracle`（`0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842`）
- 預期：`AssetVaultV2.esgRegistry()` = `ESGRegistryV2`（`0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf`）
- 門檻：任一 getter 的讀值 ≠ 預期位址
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### x402-payto

**x402 收款地址**｜x402／FeeRouter 設定｜HTTP｜SEV-1｜運作中

讀 signal-api 的 GET /（公開服務目錄）裡的 payTo 與 payToSafety。payTo 與基準（EXPECTED_PAY_TO，未設時為首次觀察值）不同 → SEV-1；守門判定不安全（付費端點會回 503）→ SEV-3。payTo 是 Vercel 環境變數，鏈上看不到，只能這樣監控。

- 端點：`{SIGNAL_API_URL}/`
- 門檻：`payTo` ≠ `EXPECTED_PAY_TO`（未設時為首次觀察值）→ SEV-1；`payToSafety.safe == false` → SEV-3
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「6. Vercel 回滾（前端與 signal-api）」](../../docs/INCIDENT_RESPONSE.md#6-vercel-回滾前端與-signal-api)
- 相關：[RUNBOOK_KEY_ROTATION.md「6.2 x402 payTo / platformTreasury」](../../docs/RUNBOOK_KEY_ROTATION.md#62-x402-payto--platformtreasury)

### exchange-risk-params

**交易所風險參數變更**｜風險參數｜事件｜SEV-3｜運作中

槓桿上限、維持保證金、maxPriceAge、各項費率、ADL、組合保證金、RWA 標記的變更。正常營運也會改，所以是 SEV-3 稽核通知；非預期的變更應升級處理。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 事件：`MaxLeverageSet(bytes32,uint256)`、`MaintenanceMarginSet(bytes32,uint256)`、`MaxPriceAgeSet(uint256)`、`TradingFeeBpsSet(uint256)`、`LiquidationPenaltyBpsSet(uint256)`、`MarkPremiumCapBpsSet(uint256)`、`VaultFeeShareSet(uint256)`、`ExecutionFeeSet(uint256)`、`BorrowFeeBpsPerHourSet(uint256)`、`AdlEnabledSet(bool)`、`PortfolioMarginEnabledSet(bool)`、`RwaAssetSet(bytes32,bool)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### vault-pause-changed

**代幣化金庫暫停／mint 停止解除**｜暫停與資產模式｜事件｜SEV-2｜運作中

AssetVaultV2 被 PAUSER 暫停或解除（mint 與 redeem 一起停），或 RISK 角色手動解除儲備率造成的 mint 停止。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`Paused(address)`、`Unpaused(address)`、`MintingHaltCleared(address,uint256,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「7. 對外溝通與客戶通報（目標值，可調整）」](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整)

### vault-risk-params

**代幣化金庫風險參數與資產登記變更**｜風險參數｜事件｜SEV-3｜運作中

費率、最低儲備率、maxPriceAge、逐資產上限、資產登記／移除。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`RiskParamsUpdated(uint256,uint256,uint256,uint256)`（**部署版不發此事件**；部署版的實作在 setRiskParams 發的是三個參數的 RiskParamsChanged（同一條規則已涵蓋）；四個參數的版本屬於 V2.5）、`RiskParamsChanged(uint256,uint256,uint256)`、`AssetCapUpdated(bytes32,uint256)`、`AssetRegistered(bytes32,address)`、`AssetUnregistered(bytes32)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### vault-reserve-breached

**代幣化金庫儲備率跌破下限（鏈上事件）**｜保險金與儲備｜事件｜SEV-2｜運作中

observeReserve 記錄到儲備率跌破 minReserveRatioBps 並鎖住 mint。與狀態規則 vault-reserve 互補：事件是鏈上留痕，狀態規則不依賴有人呼叫 observeReserve。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`ReserveBreached(uint256,uint256,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### guarded-oracle-guardian

**GuardedOracle 暫停／凍結／參數變更**｜暫停與資產模式｜事件｜SEV-2｜運作中

guardian 暫停價格更新、凍結單一資產，或偏離上限、maxPriceAge、參考來源、資產清單被改。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| GuardedOracle（ABI `GuardedOracle`） | addresses.ts V2_STACK[84532].GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` |

- 事件：`PausedSet(bool)`、`AssetFrozen(bytes32,bool)`、`RiskParamsUpdated(uint256,uint256)`、`ReferenceSourceSet(address)`、`AssetAdded(bytes32,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)

### guarded-oracle-price-rejected

**GuardedOracle 拒絕價格更新**｜Oracle｜事件｜SEV-3｜運作中

keeper 送出的價格超過偏離上限被拒。單次可能是真實跳空；連續出現代表來源異常或偏離上限死鎖。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| GuardedOracle（ABI `GuardedOracle`） | addresses.ts V2_STACK[84532].GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` |

- 事件：`PriceRejected(bytes32,uint256,uint256,string)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)
- 相關：[RUNBOOK_KEEPER.md「偏離上限死鎖」](../../docs/RUNBOOK_KEEPER.md#偏離上限死鎖)

### mock-oracle-config

**交易所 oracle 設定變更**｜Oracle｜事件｜SEV-2｜運作中

交易所讀的 MockOracle 的資產清單被改（部署版的過期門檻是常數，不能改）。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| MockOracle（ABI `MockOracle`） | addresses.ts BASE_SEPOLIA.MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |

- 事件：`StaleThresholdSet(uint256,uint256)`（**部署版不發此事件**；部署版的 MockOracle 沒有 setStaleThreshold／staleThreshold()，過期門檻是常數 STALE_THRESHOLD，無法被改）、`AssetAdded(bytes32,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)

### aggregator-oracle-config

**Chainlink/Pyth 聚合 oracle 設定變更**｜Oracle｜事件｜SEV-2｜運作中

keeper 的中繼來源（AggregatorOracle）偏離上限被改；放寬等於降低 keeper 拒寫錯誤價格的能力。部署版沒有熔斷門檻與「允許單一來源」這兩個參數。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AggregatorOracle（ABI `AggregatorOracleAdapter`） | addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.AggregatorOracle | `0x8215158642350a3f329aB9597186d21f957A813D` |

- 事件：`MaxDeviationBpsSet(uint256,uint256)`、`HaltDeviationBpsSet(uint256,uint256)`（**部署版不發此事件**；部署版的 AggregatorOracle 沒有 setHaltDeviationBps／haltDeviationBps()，沒有這個參數）、`AllowSingleSourceSet(bool)`（**部署版不發此事件**；部署版的 AggregatorOracle 沒有 setAllowSingleSource／allowSingleSource()，沒有這個參數）
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)

### exchange-bad-debt

**交易所壞帳或自動減倉**｜保險金與儲備｜事件｜SEV-2｜運作中

清算後保證金不足以覆蓋虧損（BadDebt），或觸發 ADL。代表保險金已不足以吸收、或價格出現極端跳動。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 事件：`BadDebt(uint256,bytes32,uint256)`、`AutoDeleveraged(uint256,uint256,uint256,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「7. 對外溝通與客戶通報（目標值，可調整）」](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整)

### large-margin-withdrawal

**交易所大額提領**｜大額提領｜事件｜SEV-2｜運作中

單筆提領保證金達門檻，或一小時內累計達門檻（防拆單）。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 事件：`MarginWithdrawn(address,uint256)`
- 門檻：單筆 ≥ `LARGE_WITHDRAWAL_USDC`（預設 10000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### insurance-withdrawal

**保險金庫大額贖回**｜大額提領｜事件｜SEV-2｜運作中

LP 從保險金庫贖回達門檻，或一小時內累計達門檻。保險金是清算缺口的最後一道。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| InsuranceVault（ABI `InsuranceVault`） | addresses.ts BASE_SEPOLIA.InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |

- 事件：`Withdrawn(address,uint256,uint256)`
- 門檻：單筆 ≥ `INSURANCE_WITHDRAW_USDC`（預設 5000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### insurance-bailout

**保險金 bailout**｜保險金與儲備｜事件｜SEV-2｜運作中

交易所動用保險金補清算缺口。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| InsuranceVault（ABI `InsuranceVault`） | addresses.ts BASE_SEPOLIA.InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |

- 事件：`Bailout(address,uint256)`
- 門檻：每一筆（`BAILOUT_MIN_USDC`（預設 0 USDC（MockUSDC）））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### vault-large-redeem

**代幣化金庫大額 redeem**｜大額提領｜事件｜SEV-2｜運作中

單筆 redeem 取回的 USDC 達門檻，或一小時內累計達門檻。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`Redeemed(address,bytes32,uint256,uint256,uint256)`
- 門檻：單筆 ≥ `LARGE_REDEEM_USDC`（預設 10000 USDC（MockUSDC））；`WITHDRAWAL_WINDOW_SEC`（預設 3600 秒） 內累計 ≥ `LARGE_WITHDRAWAL_WINDOW_USDC`（預設 50000 USDC（MockUSDC））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### fee-withdrawals

**平台手續費提領（V1 FeeRouter）**｜大額提領｜事件｜SEV-3｜運作中

owner 提領平台手續費。正常營運也會發生，作為稽核通知；收款地址為 immutable treasury。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| FeeRouter（ABI `FeeRouter`） | addresses.ts BASE_SEPOLIA.FeeRouter | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` |

- 事件：`PlatformFeesWithdrawn(address,uint256,uint256)`
- 門檻：每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)

### x402-fee-withdrawals

**x402 分潤路由手續費提領**｜x402／FeeRouter 設定｜事件｜SEV-3｜運作中

x402 FeeRouter（官方 USDC）的平台手續費提領，稽核通知。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| X402FeeRouter（ABI `FeeRouter`） | x402.ts X402_FEE_ROUTER[84532] | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` |

- 事件：`PlatformFeesWithdrawn(address,uint256,uint256)`
- 門檻：每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 6 位小數（USDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)
- 相關：[RUNBOOK_KEY_ROTATION.md「6.2 x402 payTo / platformTreasury」](../../docs/RUNBOOK_KEY_ROTATION.md#62-x402-payto--platformtreasury)

### vault-fees-withdrawn

**代幣化金庫手續費提領**｜大額提領｜事件｜SEV-3｜運作中

AssetVaultV2 累積的 mint／redeem 手續費被提出，稽核通知。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 事件：`FeesWithdrawn(address,uint256)`
- 門檻：每一筆（`FEE_WITHDRAW_ALERT_USDC`（預設 0 USDC））；金額 18 位小數（MockUSDC）
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)

### oracle-stale

**交易所價格過期**｜Oracle｜狀態｜SEV-2｜運作中

讀 MockOracle.getPrice 的 updatedAt 與交易所 maxPriceAge()。加密資產超過 ORACLE_STALE_WARN_SEC 為 SEV-3、超過 maxPriceAge 為 SEV-2；其他資產超過 NONCRYPTO_STALE_SEC 為 SEV-3。與 oracle-health.yml 重疊是刻意的：這一條不依賴 GitHub Actions。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| MockOracle（ABI `MockOracle`） | addresses.ts BASE_SEPOLIA.MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |
| PerpetualExchange（ABI `PerpetualExchange`） | addresses.ts BASE_SEPOLIA.PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` |

- 讀取：`oracle.getPrice(bytes32)`、`exchange.maxPriceAge()`
- 資產：sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT、sGOOGL、sICLN、sESGU（加密：sBTC、sETH）
- 門檻：加密資產：≥ `ORACLE_STALE_WARN_SEC`（預設 14400 秒） → SEV-3；≥ 鏈上 `maxPriceAge()` → SEV-2。其他資產：≥ `NONCRYPTO_STALE_SEC`（預設 259200 秒） → SEV-3
- 處置：[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)
- 相關：[RUNBOOK_KEEPER.md「症狀:交易所對所有資產 revert `StalePrice`」](../../docs/RUNBOOK_KEEPER.md#症狀交易所對所有資產-revert-staleprice)

### oracle-deviation

**交易所價格偏離參考價**｜Oracle｜狀態｜SEV-2｜運作中

比較交易所讀的 MockOracle 與 Chainlink/Pyth 聚合價（AggregatorOracle）。參考來源沒有該資產的 feed（呼叫 revert）或參考價本身過期時略過。偏離達 ORACLE_DEVIATION_BPS 為 SEV-2，達 ORACLE_DEVIATION_CRIT_BPS 為 SEV-1。兩者皆為 8 位小數。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| MockOracle（ABI `MockOracle`） | addresses.ts BASE_SEPOLIA.MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |
| AggregatorOracle（ABI `AggregatorOracleAdapter`） | addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.AggregatorOracle | `0x8215158642350a3f329aB9597186d21f957A813D` |

- 讀取：`primary.getPrice(bytes32)`、`reference.getPrice(bytes32)`
- 資產：sBTC、sETH、sAAPL、sTSLA、sGOLD
- 門檻：偏離 ≥ `ORACLE_DEVIATION_BPS`（預設 300 bps） → SEV-2；≥ `ORACLE_DEVIATION_CRIT_BPS`（預設 1000 bps） → SEV-1；參考價超過 `REFERENCE_MAX_AGE_SEC`（預設 7200 秒） 不比對
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)
- 相關：[RUNBOOK_KEEPER.md「價格熔斷(keeper 拒寫大幅變動)」](../../docs/RUNBOOK_KEEPER.md#價格熔斷keeper-拒寫大幅變動)

### guarded-oracle-paused

**GuardedOracle 暫停中**｜暫停與資產模式｜狀態｜SEV-3｜運作中

GuardedOracle.paused() 為 true（事件規則可能因掃描中斷漏掉，狀態規則補一道）。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| GuardedOracle（ABI `GuardedOracle`） | addresses.ts V2_STACK[84532].GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` |

- 讀取：`oracle.paused()`
- 門檻：`paused() == true`
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### insurance-fund

**保險金下降**｜保險金與儲備｜狀態｜SEV-2｜運作中

InsuranceVault.totalAssets() 低於 INSURANCE_MIN_USDC，或較 24 小時內高點下降超過 INSURANCE_DROP_BPS。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| InsuranceVault（ABI `InsuranceVault`） | addresses.ts BASE_SEPOLIA.InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |

- 讀取：`vault.totalAssets()`
- 門檻：`totalAssets()` < `INSURANCE_MIN_USDC`（預設 100 USDC（MockUSDC）），或較 24 小時高點下降 ≥ `INSURANCE_DROP_BPS`（預設 2000 bps） → SEV-2
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)、[INCIDENT_RESPONSE「7. 對外溝通與客戶通報（目標值，可調整）」](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整)

### vault-reserve

**代幣化金庫儲備率**｜保險金與儲備｜狀態｜SEV-2｜運作中

reserveStatus()：儲備率低於 minReserveRatioBps 為 SEV-2、低於下限＋RESERVE_WARN_MARGIN_BPS 為 SEV-3；mint 自動停止為 SEV-2；有資產無法定價（儲備率不可信）或金庫暫停為 SEV-3。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2（ABI `AssetVaultV2`） | addresses.ts V2_STACK[84532].AssetVaultV2 | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |

- 讀取：`vault.reserveStatus()`、`vault.minReserveRatioBps()`、`vault.paused()`
- 門檻：儲備率 < `minReserveRatioBps()` → SEV-2；< 下限 + `RESERVE_WARN_MARGIN_BPS`（預設 500 bps） → SEV-3；mint 自動停止 → SEV-2；無法定價或暫停 → SEV-3
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### keeper-gas

**keeper 錢包 gas 過低**｜keeper｜狀態｜SEV-3｜運作中

keeper 錢包＝MockOracle.owner()（keeper 以 MockOracle owner 身分寫價，執行期讀取，不手抄位址）；其他需要 gas 的錢包（例如 x402 結算錢包）以 Worker 變數 EXTRA_GAS_WALLETS 補。低於 GAS_MIN_ETH 為 SEV-3、低於 GAS_CRIT_ETH 為 SEV-2。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| MockOracle（ABI `MockOracle`） | addresses.ts BASE_SEPOLIA.MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |

- 讀取：`oracle.owner()`
- 門檻：< `GAS_MIN_ETH`（預設 0.02 ETH） → SEV-3；< `GAS_CRIT_ETH`（預設 0.005 ETH） → SEV-2
- 處置：[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)
- 相關：[RUNBOOK_KEEPER.md「復原程序」](../../docs/RUNBOOK_KEEPER.md#復原程序)

### signal-api-health

**signal-api 健康檢查失敗**｜服務健康｜HTTP｜SEV-3｜運作中

GET {SIGNAL_API_URL}/healthz 應回 200 與 "ok"；連續 HTTP_FAILS_BEFORE_ALERT 次失敗才告警。

- 端點：`{SIGNAL_API_URL}/healthz`
- 門檻：非 200 或內容不是 `ok`，連續 `HTTP_FAILS_BEFORE_ALERT`（預設 2 次）
- 處置：[INCIDENT_RESPONSE「6. Vercel 回滾（前端與 signal-api）」](../../docs/INCIDENT_RESPONSE.md#6-vercel-回滾前端與-signal-api)

### exchange-pause

**交易所全域暫停**｜暫停與資產模式｜事件｜SEV-1｜部署版不發此事件

guardian／owner 暫停交易所、暫停自動失效、owner 清除失效時間。暫停本身就代表事故處置中。新 exchange 部署並更新 addresses.ts 與前端 ABI 後改為 active。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange | addresses.ts BASE_SEPOLIA.PerpetualExchange（`0x827eA0c62a32e995927101259042F8A27D99124D`）；部署版不發此事件，事件宣告於 `contracts/src/PerpetualExchange.sol` | — |

- 事件：`Paused(address)`、`Unpaused(address)`、`PauseLapsed(uint256)`、`PauseExpiryCleared(address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「4. 原始碼版（PR #191，未部署）多了什麼」](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼)、[INCIDENT_RESPONSE「7. 對外溝通與客戶通報（目標值，可調整）」](../../docs/INCIDENT_RESPONSE.md#7-對外溝通與客戶通報目標值可調整)

### exchange-asset-mode

**交易所資產模式變更**｜暫停與資產模式｜事件｜SEV-2｜部署版不發此事件

逐資產 Active／ReduceOnly／Halted 切換與 guardian 鎖定。keeper 休市切換也會觸發，訊息帶 by 地址以區分。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange | addresses.ts BASE_SEPOLIA.PerpetualExchange（`0x827eA0c62a32e995927101259042F8A27D99124D`）；部署版不發此事件，事件宣告於 `contracts/src/PerpetualExchange.sol` | — |

- 事件：`AssetModeSet(bytes32,uint8,address)`、`AssetGuardianLockSet(bytes32,bool)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「4. 原始碼版（PR #191，未部署）多了什麼」](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼)、[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)

### exchange-guardian-roles

**交易所 guardian／marketOperator 變更**｜權限｜事件｜SEV-1｜部署版不發此事件

能暫停交易所或切換資產模式的地址被更換。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange | addresses.ts BASE_SEPOLIA.PerpetualExchange（`0x827eA0c62a32e995927101259042F8A27D99124D`）；部署版不發此事件，事件宣告於 `contracts/src/PerpetualExchange.sol` | — |

- 事件：`GuardianSet(address)`、`MarketOperatorSet(address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「4. 原始碼版（PR #191，未部署）多了什麼」](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼)

### exchange-exposure-caps

**交易所 OI／獲利上限變更與觸發**｜風險參數｜事件｜SEV-3｜部署版不發此事件

OI 上限、獲利上限的設定變更，以及平倉獲利被上限截斷。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| PerpetualExchange | addresses.ts BASE_SEPOLIA.PerpetualExchange（`0x827eA0c62a32e995927101259042F8A27D99124D`）；部署版不發此事件，事件宣告於 `contracts/src/PerpetualExchange.sol` | — |

- 事件：`MaxOpenInterestSet(bytes32,uint256,uint256)`、`MaxProfitBpsSet(bytes32,uint256)`、`ProfitCapped(uint256,int256,int256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「4. 原始碼版（PR #191，未部署）多了什麼」](../../docs/INCIDENT_RESPONSE.md#4-原始碼版pr-191未部署多了什麼)

### timelock-operations

**Timelock 排程與執行**｜權限｜事件｜SEV-2｜待部署

治理移交後，所有 owner／admin 操作都經 TimelockController（48 小時）。每一筆排程都要人工核對；不認得的排程要在延遲期間內取消。部署 timelock 並把位址加進前端設定後改為 active。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| TimelockController | 尚未部署；事件宣告於 `contracts/lib/openzeppelin-contracts/contracts/governance/TimelockController.sol` | — |

- 事件：`CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)`、`CallExecuted(bytes32,uint256,address,uint256,bytes)`、`Cancelled(bytes32)`、`MinDelayChange(uint256,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)、[INCIDENT_RESPONSE「2. 角色」](../../docs/INCIDENT_RESPONSE.md#2-角色)
- 相關：[GOVERNANCE_HANDOVER.md「6. 移交後的日常操作」](../../docs/GOVERNANCE_HANDOVER.md#6-移交後的日常操作)

### vault-unpriced-exemption

**金庫定價豁免變更（V2.5）**｜保險金與儲備｜事件｜SEV-2｜部署版不發此事件

V2.5 允許把無法定價的資產豁免於儲備率計算；豁免會讓儲備率看起來比實際好。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| AssetVaultV2 | addresses.ts V2_STACK[84532].AssetVaultV2（`0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a`）；部署版不發此事件，事件宣告於 `contracts/src/v2/AssetVaultV2_5.sol` | — |

- 事件：`UnpricedExemptionSet(bytes32,bool,address)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「3. 暫停與凍結：現行部署能做什麼」](../../docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼)

### guarded-oracle-window

**GuardedOracle 時間窗偏離上限變更**｜Oracle｜事件｜SEV-3｜部署版不發此事件

原始碼版 GuardedOracle 新增的累計偏離時間窗參數被改。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| GuardedOracle | addresses.ts V2_STACK[84532].GuardedOracle（`0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842`）；部署版不發此事件，事件宣告於 `contracts/src/v2/GuardedOracle.sol` | — |

- 事件：`WindowLimitUpdated(uint256,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「5. keeper 熔斷處置」](../../docs/INCIDENT_RESPONSE.md#5-keeper-熔斷處置)

### copytracker-slash-reserve

**CopyTracker 罰沒準備金提領**｜大額提領｜事件｜SEV-2｜部署版不發此事件

原始碼版 CopyTracker 的罰沒準備金被提出。

| 合約 | 位址來源 | 位址 |
|---|---|---|
| CopyTracker | addresses.ts BASE_SEPOLIA.CopyTracker（`0xC9e91f7D36e910C58042164032c625427b23CCB2`）；部署版不發此事件，事件宣告於 `contracts/src/CopyTracker.sol` | — |

- 事件：`SlashReserveWithdrawn(address,uint256)`
- 門檻：每一筆
- 處置：[INCIDENT_RESPONSE「1. 嚴重度分級」](../../docs/INCIDENT_RESPONSE.md#1-嚴重度分級)
