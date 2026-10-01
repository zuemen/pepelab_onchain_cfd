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
| guardian 熱錢包 | **另外一把 key**。腳本會強制檢查：guardian 不能等於 `MARKET_OPERATOR`、不能等於 keeper `0x540a…`、不能等於 owner。只有單一 key 的演練（anvil、拋棄式 fork）可以設 `ALLOW_GUARDIAN_IS_OWNER=true` 放行 owner 那一項。guardian 只能暫停，最多把資產收緊到 ReduceOnly，不能解除暫停，也不能改參數（SEAL 建議） |
| 凍結時窗 | 挑沒有 demo 的時段，後面要留兩天緩衝 |
| 餘額 | 模擬估算約 16.09M gas，以 0.011 gwei 計約 0.0002 ETH。錢包多備一些 |

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
| 緊急處置 | 無 | guardian 可以凍結單一資產或暫停整個 oracle。鏈上現行版本的凍結沒有期限；新版原始碼（尚未部署，§10）是 72 小時到期加 24 小時冷卻，只有 admin 能下沒有期限的凍結 |
| 過期行為 | 回傳舊價，由 exchange 的 6 小時 maxPriceAge 擋下 | oracle 本身設定 30 天，實際仍由 exchange 的 6 小時擋 |
| 凍結或暫停時 | 不適用 | 凍結時 `getPrice` 會 revert，該資產的開倉、平倉、清算全部 revert（fail-closed）。暫停時 keeper 無法寫價，價格超過 `maxPriceAge` 之後讀取同樣 revert |
| 與金庫共用 | 否 | 是。凍結一個資產會同時停掉 V2 金庫 |
| 累積漂移 | 不適用 | 鏈上現行版本沒有時間窗上限，連續 10 筆更新可以把價格推到約 2.6 倍。本分支新增速率限制（預設每小時最多 25%），但必須先重部署 oracle（§10） |

**取捨：** 在測試網做 demo 時，MockOracle 比較不容易卡住。GuardedOracle 能限制 key 外洩後的損害，代價是凍結時連平倉也會被擋。想用 GuardedOracle 就設 `ORACLE_KIND=guarded`，preflight 會先確認 11 檔都能報價。Oracle 在 exchange 上是 immutable，之後要換只能再重部署一次。

## 5. 執行

### 5.1 清空舊 exchange

腳本會掃描舊 exchange 的倉位：**只要有未平倉就 revert**，除非刻意設定 `ALLOW_OPEN_POSITIONS=true`。舊 exchange 上的保證金（目前 500 USDC）不會被搬走，使用者隨時可以 `withdrawMargin` 領回，然後存進新的 exchange。執行費 ETH 由 owner 呼叫 `withdrawExecutionFees` 取回。

**`ALLOW_OPEN_POSITIONS=true` 的後果（照實寫）：** re-point 之後，InsuranceVault 和 FeeRouter 只認新的 exchange。舊 exchange 呼叫它們時會收到 `NotAuthorized` 或 `Unauthorized`，以下三種情況會 revert：

| 情況 | 結果 |
|---|---|
| 清算 | 殘值 `insuranceVault.depositFromProtocol` 會 revert，所以**無法清算** |
| 虧損超過保證金、需要吸收壞帳（`bailout`） | revert |
| 跟單倉位獲利平倉時的 `feeRouter.receivePerformanceFee` | revert，所以**無法平倉** |

受影響的部位會卡住，直到 owner 在舊 exchange 上執行：

```bash
cast send 0x827eA0c62a32e995927101259042F8A27D99124D "setInsuranceVault(address)" 0x0000000000000000000000000000000000000000
cast send 0x827eA0c62a32e995927101259042F8A27D99124D "setFeeRouter(address)"      0x0000000000000000000000000000000000000000
```

執行之後，清算殘值會留在舊 exchange 內，不再有 bailout，也不再收績效費。所以**不要**在有未平倉的情況下 cutover；如果一定要，先執行上面兩行再 broadcast。

### 5.2 預檢與 fork 模擬（不用 key）

```bash
cd contracts
export GUARDIAN=0x<guardian 熱錢包>
PREFLIGHT_ONLY=true forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
```

完整模擬的最後應該印出 `ok` 清單（就是 `Verify130` 的全部斷言）和 `SIMULATION COMPLETE`。2026-09-30 的模擬結果：50 筆交易，全部斷言通過。

`CREATE_DEMO_SESSION` 預設為 false。設成 true 時必須同時提供 `DEMO_SESSION_AGENT`，而且它不能是 owner key。

### 5.3 正式 broadcast（人工執行）

```bash
forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- 一定要加 `--slow`。加了之後，forge 會等上一筆交易的收據回來才送下一筆，理由有兩個：
  - 本腳本後段的呼叫依賴前段剛部署的合約。公共 RPC 同時收到一整批交易時，容易出現 nonce 競爭、交易被丟棄或替換。
  - 中途失敗時，broadcast JSON 會精確反映已經上鏈的部分，§9 的 RESUME 才有可靠的依據。
- `ExchangeOpsLib` 由 forge 自動以 CREATE2 部署並 link，位址可以在 broadcast JSON 裡查到。
- 執行順序（每一步都是冪等的：先讀狀態，只寫缺少的部分）：
  1. exchange
  2. 全域參數
  3. RWA 旗標、上限、guardian 和 operator
  4. 探測 `closeReasonOf`
  5. TraderStake
  6. StrategyRegistry 和 CopyTracker，以及新 exchange 的 `setCopyTracker`
  7. AgentSessionManager 和它的授權
  8. （選用）demo session
  9. **不可逆**：re-point `InsuranceVault.setExchange`，然後 `FeeRouter.setExchange`
  10. `FeeRouter.setCopyTracker`、`TraderStake.setCopyTracker`，以及在舊 exchange 撤銷舊 manager 的授權

  第 1 到 8 步只動這一輪新部署的合約。第 9 步之前中斷的話，#129 那條鏈完全不受影響。

### 5.4 驗證

```bash
EXCHANGE_NEW=… COPYTRACKER_NEW=… STRATEGY_REGISTRY_NEW=… SESSION_MANAGER_NEW=… GUARDIAN=… \
OI_CAP_NON_RWA_USDC=1499 OI_CAP_RWA_USDC=749 \
forge script script/Verify130.s.sol:Verify130 --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
```

OI 上限在腳本裡已經取整到整數 USDC，所以這裡填的數字就是 cutover 最後印出的 `OI_CAP_*_USDC`；以 2026-09-30 的資料為例是 1499 和 749。fork 測試會用同樣的指令跑一次 `Verify130`，已確認能通過。

oracle 價格新鮮度只會發出警告，不會 revert。如果看到 `WARN … older than 6h`，先 dispatch keeper（`base-sepolia-keeper.yml` → Run workflow），等它寫完價再重跑一次驗證。

`Verify130` 逐項斷言以下內容：owner、guardian、operator、oracle、KYC、FeeRouter、InsuranceVault；11 檔的 RWA 旗標、OI 上限、`maxProfitBps`；新的 manager 和 CopyTracker 有授權；舊的 manager 和 CopyTracker 在新 exchange 上沒有授權；舊 manager 在舊 exchange 上已被撤銷；CopyTracker 和 StrategyRegistry 的所有上游；InsuranceVault、FeeRouter、TraderStake 已經 re-point；oracle 11 檔都有報價（新鮮度只警告）。治理移交之後再跑一次，這次加上 `EXPECTED_OWNER=<timelock>`。

## 6. 影響範圍

- **session id 歸零**：新的 manager 從 0 開始編號；如果有建立 demo session，它就是 `0`。**所有 VC 都要重新簽發**，因為 VC 綁的是 manager 位址和 session id。
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
- **V2 金庫升級到 V2_5**：這一版把 M-7 的 last-good 價格 fallback 加回來，但 last-good 超過 6 小時就視為 unpriced；一個以 last-good 估值的帳本只能觸發停鑄，不能自動解除停鑄。另外有三點：
  - **即時報價的有效期上限是 `min(maxPriceAge, 6h)`**（`effectiveMaxPriceAge`）。鏈上金庫的 `maxPriceAge` 原本是 30 天，會讓 6 小時的保護形同虛設。升級腳本會在同一批交易裡用 RISK_ROLE 呼叫 `setRiskParams`，把它降到 `VAULT_MAX_PRICE_AGE`（預設 21600）。
  - **只要有任何一個資產 unpriced，mint 就 revert `LiabilityUnpriced`**。用 fallback 估值的資產照常放行；redeem 永遠不受這個限制。
  - **某個資產 feed 永久失效時，怎麼解除 mint 閘門（審查 M1）**：這個閘門原本無法由 RISK_ROLE 解除，因為 `clearMintingHalt`、`setAssetCap(0)`、`unregisterAsset` 都解不開（只要還有 dust 未償，`unregisterAsset` 就會拒絕）。現在由 RISK_ROLE 依序執行：
    1. `setAssetCap(id, 0)` 關閉該市場。
    2. `setUnpricedExemption(id, true)`。

    這個豁免有三條限制：
    - 只在 `assetCap == 0` 時有效；cap 一調回大於 0，豁免就自動失效。
    - 被豁免的資產**仍計入負債**，以最後一次記錄的價格計，不論那個價格多舊。
    - 如果該資產完全沒有記錄價格，就只有未償額 ≤ `EXEMPT_DUST_UNITS`（0.001 顆）時才可以豁免。

    被豁免的資產計為 fallbackPriced：儲備率仍標示為過期，已觸發的停鑄不會自動解除。redeem 不受影響。
  - **前提**：所有有未償額的資產，報價都必須不到 6 小時。keeper 要照 heartbeat 刷新，否則升級腳本會拒絕執行。fork 測試 `test/fork/VaultV2_5Fork.t.sol` 驗證過：升級後 mint 和 redeem 都正常；keeper 每 5 小時刷新一次就能持續使用；超過 6 小時沒刷新，mint 會被擋；刷新後恢復。

  步驟：
  1. 在 `contracts` 目錄執行 `bash script/check-vault-storage-layout.sh`。腳本會先 `forge clean`，再用 `forge inspect … storage-layout` 比對，確認只有在尾端追加欄位：`_lastGood` 放在 slot 12，`_unpricedExempt` 放在 slot 13，`__gap` 從 43 變成 41（起點 slot 14），結尾 slot 仍是 55。
  2. 用 fork 模擬 `forge script script/UpgradeVaultToV2_5.s.sol:UpgradeVaultToV2_5 --fork-url https://sepolia.base.org --sender 0x27C2…A585`。
  3. 人工加上 `--broadcast --slow`。
  4. 用 `jq .abi out/AssetVaultV2_5.sol/AssetVaultV2_5.json > ../frontend/src/contracts/abi/AssetVaultV2.json` 更新前端 ABI。

  **這一步要在治理 phase 2 之前做**；phase 2 之後就只能走 timelock 提案。

## 9. 中途失敗：續跑（RESUME）與回滾

broadcast JSON 在 `contracts/broadcast/Redeploy130Hardened.s.sol/84532/run-latest.json`。用下面這行找出已經上鏈的合約：

```bash
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName) \(.contractAddress)"' …/run-latest.json
```

**不要從頭重跑，一律用 RESUME。** 沒有設 `RESUME_*` 時，preflight 會要求 5 個共用指標全部維持 #129 的狀態，否則直接 revert（訊息是 `partial cutover detected`）。但這只擋得住在第 9 步以後中斷的情況。**如果中斷在第 1–8 步**，5 個指標都還沒被動過，不帶 RESUME 重跑會通過 preflight，並部署**另一套**新合約，第一套就成了孤兒合約。這不會有資金風險（孤兒合約沒有接到任何共用合約），但會浪費 gas，也容易填錯位址。`RESUME_EXCHANGE` 也不能填成舊 exchange `0x827e…`，腳本會拒絕。

5 個共用指標是：

- `InsuranceVault.exchange` 和 `FeeRouter.exchange` 都指向舊 exchange
- `FeeRouter.copyTracker` 和 `TraderStake.copyTracker` 都指向舊 CopyTracker
- 舊 exchange 仍然授權舊的 SessionManager

**續跑方式：** 把已經部署的合約位址設成環境變數，重跑同一條 broadcast 指令：

```bash
RESUME_EXCHANGE=0x… RESUME_STRATEGY_REGISTRY=0x… RESUME_COPY_TRACKER=0x… RESUME_SESSION_MANAGER=0x… \
GUARDIAN=0x… forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- 沒部署到的合約就不要設，腳本會補部署。
- 已經寫入的 setter 會被跳過。
- 共用指標只接受兩種值：舊值，或 RESUME 指定的值。
- fork 測試 `test_fork_interruptedCutoverResumes` 模擬了兩個中斷點（第 6 步之後、第 9 步只完成一半），兩次續跑都回到同一個 exchange，而且 Verify130 全部通過。

### 各步驟失敗時的回滾

| 中斷在 | 狀態 | 回滾（放棄這次 cutover） | 或者續跑 |
|---|---|---|---|
| 1–8 | 只動到新合約，#129 那條鏈完整 | 不需要回滾，新合約直接棄用。如果第 8 步已經建立 demo session，session 屬於新 manager，也一併棄用 | RESUME |
| 9a（只有 InsuranceVault 改指向） | 舊 exchange 無法清算或 bailout | `cast send $INS_VAULT "setExchange(address)" 0x827eA0c62a32e995927101259042F8A27D99124D` | RESUME |
| 9b（兩者都已改指向） | 新 exchange 已經是主場 | `cast send $INS_VAULT "setExchange(address)" 0x827e…` 加上 `cast send $FEE_ROUTER "setExchange(address)" 0x827e…`。還沒有人在新 exchange 開倉之前可以回退 | RESUME |
| 10 | FeeRouter／TraderStake 指到新的 CopyTracker | `cast send $FEE_ROUTER "setCopyTracker(address)" 0xC9e91f7D36e910C58042164032c625427b23CCB2` 加上 `cast send $TRADER_STAKE "setCopyTracker(address)" 0xC9e9…`，再加上 `cast send 0x827e… "setAgentAuthorized(address,bool)" 0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B true` | RESUME |

回滾全部由 owner key 執行；治理移交之後就要走 timelock。第 9 步是「不可逆」的界線：一旦新 exchange 上有倉位，就只能往前走，不能再回退。

## 10. 留給下一輪

- **GuardedOracle 速率限制（本分支已完成原始碼與腳本，尚未部署）**：`setWindowLimit(duration, bps)` 限制一個時間窗內相對於窗口起點價格的累積偏離。窗口是 tumbling 的：跨越窗口邊界時，最壞情況是兩個窗口的量。經 reference 確認的價格可以直接通過，並把窗口起點重設為該價格。
  - 因為 oracle 不可升級，要用 `script/RedeployGuardedOracle.s.sol`：部署新的 oracle，逐一搬移 11 檔的現價（只要有任何一檔的價格超過 `min(金庫 maxPriceAge, 6h)` 就拒絕，避免舊價被重新蓋上新的時間戳），複製 risk 參數，設定窗口（1h / 2500 bps，必須非 0），授予 keeper 與 guardian 角色，最後把金庫的 `setOracle` 指向新 oracle。
  - fork 模擬已通過，金庫負債前後一致。
  - 這一步要在治理 phase 2 之前執行；phase 2 之後只能透過 timelock 提案。
  - 如果 exchange 採用 `ORACLE_KIND=guarded`，oracle 是 immutable，無法改指向新的 oracle，keeper 必須同時對兩個 oracle 寫價。
  - **時間窗邊界**：窗口仍然是 tumbling，但每一次寫價同時要通過「本窗口起點」和「上一窗口起點」（上一窗口在兩個窗口長度內才算數）兩項檢查。實際保證是：在約一個窗口長度的任何區間內，單向移動不超過上限，也就是「窗口尾端移滿、下一窗口開頭再移滿」的漏洞被擋下。但**相隔超過一個窗口的兩筆寫價，仍然可以各自用滿上限**（審查探針：兩筆相隔 window+1 秒）。最壞情況約是每 (window + 1 秒) 兩倍上限，而不是每個窗口一倍。來回擺動（例如先 −x 再 +x）不受窗口限制。fork 以外的單元測試 `test_boundaryDoubleMoveIsRejected` 覆蓋了這個情境。
  - **reference 必須是非 keeper 的獨立來源**，例如 Chainlink/Pyth 的 AggregatorOracleAdapter。經 reference 確認的寫價可以繞過步進上限和窗口，所以 keeper 能寫的 reference 等於沒有檢查。重部署腳本會 require `referenceSource != keeper` 而且必須有 code。
  - **寫價被窗口擋下時，guardian 的處置**（`PriceRejected(..., "window")` 或 `"window-prev"` 告警）：
    1. 先判斷是真行情還是 key 外洩。
    2. 如果是 key 外洩：guardian `setAssetFrozen(id, true)`（讀取端 fail-closed），並撤換 keeper（由 admin 或 timelock 執行）。
    3. 如果是真行情：接上獨立的 reference，讓確認後的價格一次到位；或者等下一個窗口，由 keeper 逐步追價。在那之前，exchange 端可以先由 guardian 把該資產設成 ReduceOnly。
- **GuardedOracle 的 guardian 凍結與暫停加上期限（分支 `contracts/oracle-freeze-expiry-checkin`，2026-10-01，只有原始碼與測試，尚未部署）**：和速率限制一樣要靠 `script/RedeployGuardedOracle.s.sol` 換新的 oracle 才會生效，兩者會在同一次重部署一起上線。
  - 規則：guardian 的凍結或暫停在 72 小時後自動失效（`GUARDIAN_HALT_DURATION`），接著同一範圍有 24 小時冷卻（`GUARDIAN_HALT_COOLDOWN`），數值與 exchange 的 guardian 暫停相同。admin 下的沒有期限，也只有 admin 能解除；admin 可以接手 guardian 正在進行的凍結。暫停的時鐘同時約束資產凍結。完整規則、guardian 單獨行動時的上限與代價見 KNOWN_LIMITATIONS #27。
  - 腳本的變動：部署後讀回 `GUARDIAN_HALT_DURATION`／`GUARDIAN_HALT_COOLDOWN`，確認新 oracle 沒有暫停、11 檔都沒有凍結。凍結狀態不會搬移（舊 oracle 有暫停或凍結時 preflight 本來就拒絕執行）。`GUARDIAN` 和 broadcaster 是同一個位址時腳本會警告：同時持有 admin 與 guardian 的帳號視為 admin，它下的凍結不會到期。
  - **重部署時請一併把 oracle 的 `maxPriceAge` 調低**（腳本目前照抄舊值，鏈上是 30 天）。凍結到期只移除凍結，不更新價格；`maxPriceAge` 太長時，到期當下那個和凍結一樣舊的價格在 oracle 這一層會被視為有效，只剩各合約自己的 6 小時上限把關。
  - 舊 oracle 退役時要停掉寫價：鏈上現行的舊版由 guardian `setPaused(true)` 即可（沒有期限）；之後若是從新版再遷移，要由 admin 下，guardian 的暫停 72 小時就失效。
  - `ORACLE_KIND=guarded` 的 exchange 把 oracle 當 immutable，不會跟著換；它讀的 oracle 維持舊行為，直到 exchange 重部署。
  - fork 模擬：`forge test --match-path test/fork/RedeployGuardedOracleFork.t.sol --fork-url https://sepolia.base.org -vv`。
  - guardian 的操作順序（新版）：凍結或暫停之後立刻判斷是否需要超過 72 小時；需要就馬上送 timelock 接手案（48 小時）。確認是誤報就由 guardian 自行解除。到期後確認 keeper 已恢復寫價。
- PerpetualExchange 只剩 665 B 的空間，這一輪完全沒有動它。

## 11. 簽核

- [ ] fork 模擬通過（§5.2）
- [ ] 舊 exchange 0 未平倉
- [ ] broadcast 完成，`Verify130` 全部 ok
- [ ] §7 的 1–9 全部完成，`check-addresses` 綠燈
- [ ] 畫面驗收：開倉、平倉、跟單、agent session 下單各一次
