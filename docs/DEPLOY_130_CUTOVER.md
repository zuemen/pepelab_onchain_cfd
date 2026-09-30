# #130 — 強化版 PerpetualExchange（PR #191）上線 cutover

> **對象：** 持有 Base Sepolia 部署者金鑰 `0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585` 的組員。
> **這是 #102 → #129 之後第三次同一條連鎖重部署。** 流程沿用 [`DEPLOY_129_CUTOVER.md`](./DEPLOY_129_CUTOVER.md) 的 phase C，差別在：風險參數強制設定、未平倉是硬性門檻、重跑防呆、部署後完整讀回驗證。
> AI 只寫了腳本並在 fork 上模擬（不帶金鑰、沒送交易）。**所有 `--broadcast` 由人執行。**

---

## 1. 為什麼要重部署

PR #191 已合併進 master，但只有原始碼。鏈上現行 exchange `0x827eA0c6…124D` 還是 #129 版本，沒有下列功能：

- guardian 暫停：72 小時自動失效、24 小時冷卻，只有 owner 能解除暫停
- 每個資產的模式：Active / ReduceOnly / Halted，由 marketOperator 切換開休市
- 每個資產的 OI 上限、單筆獲利上限 `maxProfitBps`
- `closeReasonOf` 與 `adlHaircutOf`：CopyTracker 的 slash 評分要靠這兩個欄位

`PerpetualExchange` 不可升級。`CopyTracker`、`StrategyRegistry`、`AgentSessionManager` 都把 exchange 位址存成 `immutable`，所以這四個合約一起重部署。`InsuranceVault` 和 `FeeRouter` 改指向新 exchange，這一步不可逆。

## 2. 前置條件

| 項目 | 檢查 |
|---|---|
| master 含 PR #191 以及本分支（`contracts/p1-cutover-periphery`） | `forge test` 全綠 |
| 部署者金鑰 | `cast wallet address --private-key "$PRIVATE_KEY"` 的結果要等於 `0x27C2…A585` |
| guardian 熱錢包 | **另外一把 key**，不能是 owner，也不能是 keeper。它只能暫停，不能解除暫停，也不能改參數（SEAL 建議） |
| 凍結時窗 | 挑沒有 demo 的時段，後面要留兩天緩衝 |
| 餘額 | 模擬估算約 16.05M gas，以 0.011 gwei 計約 0.0002 ETH。錢包多備一些 |

## 3. 風險參數：強制設定，不能留 0

合約預設值 0 代表「不設上限」。這支腳本不接受 0。

### 3.1 每個資產的 OI 上限（long 和 short 各一個上限）

```
非 RWA（sBTC / sETH / sGOLD）: C = clamp(InsuranceVault.totalAssets × 10, 1,000, 50,000) USDC
RWA（其餘 8 檔）             : C_rwa = C × 50%
```

**計算依據（2026-09-30 鏈上讀值）：** InsuranceVault `totalAssets` = 149.985 USDC，舊 exchange 持有保證金 500 USDC，TraderStake 7,900 USDC（不是保險金，不列入計算）。

- 由此算出 C = **1,499 USDC / 每一邊**，C_rwa = **749 USDC / 每一邊**（fork 模擬實際寫入的值）。
- 為什麼乘 10：一邊 OI 滿載時，只要有利方向走 10%，贏家的帳面獲利就等於整個保險金。這是保險金「剛好撐得住」的邊界，而且只算單一資產。
- 為什麼 RWA 砍半：股票和債券會休市，開盤時的跳空可能跨過清算價。
- 為什麼要設下限 1,000：demo agent 的每筆保證金是 10 USDC，5 倍槓桿下名目 50；TG bot 單筆上限 1,000 保證金會被擋，這是刻意的。
- 為什麼要設上限 50,000：保險金將來增加時，上限不會跟著無限放大。
- 最壞情況：`maxProfitBps` = 5 倍保證金。以 1 倍槓桿滿載一邊計算，最多可以拿走 5 × C。保險金撐不住這個數字，所以 OI 上限只是限制損失的**速度**，真正擋住損失的是獲利上限，再加上 guardian 暫停。MockOracle 沒有偏離上限，見 §4。

要覆寫時設定 `OI_CAP_NON_RWA_USDC`、`OI_CAP_RWA_USDC`（整數 USDC），或 `OI_CAP_MULTIPLIER`、`OI_CAP_RWA_BPS`。

### 3.2 其他參數

| 參數 | 值 | 來源 |
|---|---|---|
| `maxProfitBps` | 50,000（5 倍保證金），11 檔全設 | `MAX_PROFIT_BPS`，範圍 [10,000, 250,000] |
| `guardian` | **必填**，沒設定腳本就 revert | `GUARDIAN` |
| `marketOperator` | 預設 keeper `0x540aECD3…ef17` | `MARKET_OPERATOR` |
| maxPriceAge / executionFee / ADL | 21600 / 1e14 / on | 讀自舊 exchange |
| KYC / RWA 8 檔 / ESGRegistryV2 `0xBF5B…` | 沿用 | 同上 |
| trading fee / borrow / 清算罰金 / mark premium / vault fee share | 跟舊 exchange 不同的才複製 | 腳本在 broadcast 前讀取 |

## 4. Oracle：MockOracle（預設）或 GuardedOracle

| | MockOracle `0xeD90…` | GuardedOracle `0x8E9e…` |
|---|---|---|
| 誰能寫價 | keeper 熱錢包一把 key（它是 `owner`） | `KEEPER_ROLE`（keeper） |
| 單次偏離上限 | **無**。key 外洩時可以寫入任意價格 | 每次最多 10%（`maxDeviationBps` 1000） |
| 緊急處置 | 無 | guardian 可以凍結單一資產或暫停整個 oracle |
| 過期行為 | 回傳舊價，由 exchange 的 6 小時 maxPriceAge 擋下 | oracle 本身設定 30 天，實際仍由 exchange 的 6 小時擋 |
| 凍結或暫停時 | 不適用 | `getPrice` 會 revert，該資產的開倉、平倉、清算全部 revert（fail-closed） |
| 與金庫共用 | 否 | 是。凍結一個資產會同時停掉 V2 金庫 |
| 累積漂移 | 不適用 | 鏈上現行版本沒有時間窗上限，連續 10 筆更新可以把價格推到約 2.6 倍。本分支新增速率限制（預設每小時最多 25%），但必須先重部署 oracle（§10） |

**取捨：** 在測試網做 demo 時，MockOracle 比較不容易卡住。GuardedOracle 能限制 key 外洩後的損害，代價是凍結時連平倉也會被擋。想用 GuardedOracle 就設 `ORACLE_KIND=guarded`，preflight 會先確認 11 檔都能報價。Oracle 在 exchange 上是 immutable，之後要換只能再重部署一次。

## 5. 執行

### 5.1 清空舊 exchange

腳本會掃描舊 exchange 的倉位：**只要有未平倉就 revert**，除非刻意設定 `ALLOW_OPEN_POSITIONS=true`。舊 exchange 上的保證金（目前 500 USDC）不會被搬走，使用者隨時可以 `withdrawMargin` 領回，然後存進新的 exchange。執行費 ETH 由 owner 呼叫 `withdrawExecutionFees` 取回。

### 5.2 預檢與 fork 模擬（不用 key）

```bash
cd contracts
export GUARDIAN=0x<guardian 熱錢包>
PREFLIGHT_ONLY=true forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
```

完整模擬的最後應該印出 `ok` 清單（就是 `Verify130` 的全部斷言）和 `SIMULATION COMPLETE`。2026-09-30 的模擬結果：51 筆交易，全部斷言通過。

### 5.3 正式 broadcast（人工執行）

```bash
forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- 一定要加 `--slow`：Base 會拒絕 7702 帳號預先發出的跳號 nonce。
- `ExchangeOpsLib` 由 forge 自動以 CREATE2 部署並 link，位址可以在 broadcast JSON 裡查到。
- 執行順序：exchange → 參數與上限 → guardian／operator → **探測 `closeReasonOf`** → StrategyRegistry → CopyTracker → AgentSessionManager（加上 demo session）→ 在舊 exchange 撤銷舊 manager 的授權 → **最後** re-point `InsuranceVault.setExchange` 和 `FeeRouter.setExchange`。

### 5.4 驗證

```bash
EXCHANGE_NEW=… COPYTRACKER_NEW=… STRATEGY_REGISTRY_NEW=… SESSION_MANAGER_NEW=… GUARDIAN=… \
OI_CAP_NON_RWA_USDC=1499 OI_CAP_RWA_USDC=749 \
forge script script/Verify130.s.sol:Verify130 --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
```

`Verify130` 逐項斷言以下內容：owner、guardian、operator、oracle、KYC、FeeRouter、InsuranceVault；11 檔的 RWA 旗標、OI 上限、`maxProfitBps`；新的 manager 和 CopyTracker 有授權；舊的 manager 和 CopyTracker 在新 exchange 上沒有授權；舊 manager 在舊 exchange 上已被撤銷；CopyTracker 和 StrategyRegistry 的所有上游；InsuranceVault、FeeRouter、TraderStake 已經 re-point；oracle 11 檔都有新鮮報價。治理移交之後再跑一次，這次加上 `EXPECTED_OWNER=<timelock>`。

## 6. 影響範圍

- **session id 歸零**：新的 manager 從 0 開始編號，demo session 是 `0`。**所有 VC 都要重新簽發**，因為 VC 綁的是 manager 位址和 session id。
- **已發布的策略全部消失**：StrategyRegistry 是新的。demo 前至少重新發布 3 份。
- **TraderStake 保留**：它持有 7,900 USDC 的質押。M2 修正（§8）要等 TraderStake 重部署才會生效，想在這一輪一起做就設 `DEPLOY_NEW_TRADER_STAKE=true`。舊的質押者必須自己到舊合約解除質押（冷卻 1 天）。
- **EsgRewardDistributor `0x44a8…`** 和 **PepeIncentives** 把 exchange 存成 immutable，它們仍然讀舊 exchange。用 `Deploy102RewardDistributor.s.sol` 搭配 `EXCHANGE_NEW` 重部署，再到 badge 把 `MINTER_ROLE` 授給它（做法和 #129 phase D 相同）。

## 7. 部署後必做（一次 commit 完成，而且要在 Verify130 通過之後）

| # | 目標 | 動作 |
|---|---|---|
| 1 | 前端 ABI | 在 `contracts` 目錄執行 `for n in PerpetualExchange CopyTracker StrategyRegistry AgentSessionManager TraderStake; do jq .abi out/$n.sol/$n.json > ../frontend/src/contracts/abi/$n.json; done`。新增的 ABI 項目包括 `pause`、`assetMode`、`maxLongOI`、`closeReasonOf`、`followTraderAtVersion` 等 |
| 2 | `frontend/src/contracts/addresses.ts` | 在 `BASE_SEPOLIA` 換掉 `PerpetualExchange`、`StrategyRegistry`、`CopyTracker`（如果換了 TraderStake 也一起換） |
| 3 | `frontend/src/contracts/sessionManager.ts` | 84532 的 `SESSION_MANAGER_ADDRESS` 改成新的 manager，同時更新註解裡的 exchange 位址 |
| 4 | `agent/.env` 與 `.env.example` | `SESSION_MANAGER_ADDRESS` 改新 manager、`DEMO_SESSION_ID=0`、`PERP_ADDRESS` 改新 exchange。`x402_agent.ts` 和 `examples/*` 的預設位址與註解也要改 |
| 5 | workflows | `admin-base-sepolia.yml:36`（default）、`base-sepolia-keeper.yml:51`（`EXCHANGE`）、`oracle-health.yml:36`（`KEEPER_EXCHANGE_ADDRESS`）。改完跑 `node scripts/check-addresses.mjs`，**位址一致性 CI（consistency.yml）會擋下不一致的地方** |
| 6 | keeper | 在 `base-sepolia-keeper.yml` 設 `KEEPER_MARKET_OPERATOR: "1"`，並把 `KEEPER_EXCHANGE_ADDRESS` 設成新 exchange，由 keeper 負責 RWA 開休市的 Active/ReduceOnly 切換。keeper 地址就是 `marketOperator` |
| 7 | VC | 為新的 manager 和 session 0 重新簽發 |
| 8 | 獎勵發放 | 重部署 EsgRewardDistributor（§6） |
| 9 | 前端 guardian 監控 | `paused()`、`pauseExpiresAt()`、`assetMode(id)` 可以直接讀取 |

## 8. 同一分支的周邊修正（這一輪一起上線的部分）

- 新的 CopyTracker 會一起部署：新增 `followTraderAtVersion`（M10），slash 準備金改成用 `balanceOf` 前後差額入帳，`renounceOwnership` 會 revert。
- TraderStake M2（申請 unstake 之後就喪失資格）：只有在 TraderStake 重部署之後才會生效，見 §6。
- 治理移交：見 [`GOVERNANCE_HANDOVER.md`](./GOVERNANCE_HANDOVER.md)。**先完成 cutover 並驗證，再移交。**
- **V2 金庫升級到 V2_5**：這一版把 M-7 的 last-good 價格 fallback 加回來，但 last-good 超過 6 小時就視為 unpriced；一個以 last-good 估值的帳本只能觸發停鑄，不能自動解除停鑄。步驟：
  1. 在 `contracts` 目錄執行 `bash script/check-vault-storage-layout.sh`，確認只有在尾端追加欄位：`_lastGood` 放在 slot 12，`__gap` 從 43 變成 42，結尾 slot 仍是 55。
  2. 用 fork 模擬 `forge script script/UpgradeVaultToV2_5.s.sol:UpgradeVaultToV2_5 --fork-url https://sepolia.base.org --sender 0x27C2…A585`。
  3. 人工加上 `--broadcast --slow`。
  4. 用 `jq .abi out/AssetVaultV2_5.sol/AssetVaultV2_5.json > ../frontend/src/contracts/abi/AssetVaultV2.json` 更新前端 ABI。

  **這一步要在治理 phase 2 之前做**；phase 2 之後就只能走 timelock 提案。

## 9. 中途失敗

broadcast JSON 在 `contracts/broadcast/Redeploy130Hardened.s.sol/84532/run-latest.json`。

- **不要重跑整個腳本。** preflight 會擋下重跑：只要 InsuranceVault 或 FeeRouter 已經不是指向舊 exchange 就 revert。但如果失敗發生在 re-point 之前，重跑會產生第二個 exchange。
- 找出已經上鏈的交易：`jq -r '.transactions[] | "\(.contractName) \(.contractAddress) \(.function)"' …/run-latest.json`，剩下的 setter 用 `cast send` 手動補上。
- 失敗在 re-point 之前：舊鏈仍然完整可用，新合約可以直接放棄。
- 失敗在兩個 re-point 之間：手動 `cast send $FEE_ROUTER "setExchange(address)" $EXCHANGE_NEW`。

## 10. 留給下一輪

- **GuardedOracle 速率限制（本分支已完成原始碼與腳本，尚未部署）**：`setWindowLimit(duration, bps)` 限制一個時間窗內相對於窗口起點價格的累積偏離。窗口是 tumbling 的：跨越窗口邊界時，最壞情況是兩個窗口的量。經 reference 確認的價格可以直接通過，並把窗口起點重設為該價格。
  - 因為 oracle 不可升級，要用 `script/RedeployGuardedOracle.s.sol`：部署新的 oracle，逐一搬移 11 檔的現價（只要有任何一檔的價格超過金庫的 maxPriceAge 就拒絕，避免舊價被重新蓋上新的時間戳），複製 risk 參數，設定窗口（1h / 2500 bps，必須非 0），授予 keeper 與 guardian 角色，最後把金庫的 `setOracle` 指向新 oracle。
  - fork 模擬已通過，金庫負債前後一致。
  - 這一步要在治理 phase 2 之前執行；phase 2 之後只能透過 timelock 提案。
  - 如果 exchange 採用 `ORACLE_KIND=guarded`，oracle 是 immutable，無法改指向新的 oracle，keeper 必須同時對兩個 oracle 寫價。
- PerpetualExchange 只剩 665 B 的空間，這一輪完全沒有動它。

## 11. 簽核

- [ ] fork 模擬通過（§5.2）
- [ ] 舊 exchange 0 未平倉
- [ ] broadcast 完成，`Verify130` 全部 ok
- [ ] §7 的 1–9 全部完成，`check-addresses` 綠燈
- [ ] 畫面驗收：開倉、平倉、跟單、agent session 下單各一次
