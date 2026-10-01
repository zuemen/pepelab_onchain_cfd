# 治理移交：部署者 EOA → TimelockController（48h）

> 腳本：`contracts/script/DeployGovernance.s.sol`、`contracts/script/HandoverToTimelock.s.sol`
> fork 模擬測試：`contracts/test/fork/CutoverGovernanceFork.t.sol`
> 前提：[`DEPLOY_130_CUTOVER.md`](./DEPLOY_130_CUTOVER.md) 已經 broadcast，而且 `Verify130` 通過。**先 cutover，再移交**；順序反過來的話，cutover 的每一筆 setter 都要排隊等 48 小時。
> AI 只做了模擬。所有 `--broadcast` 由人執行。

## 1. 誰拿到什麼

| 合約 | 移交前 | 移交後 | 說明 |
|---|---|---|---|
| PerpetualExchange（#130） | owner = 部署者 | owner = timelock | 參數、`unpause`、放寬資產模式，都要等 48 小時 |
| CopyTracker（#130） | owner = 部署者 | owner = timelock | `withdrawSlashReserve` |
| InsuranceVault | owner = 部署者 | owner = timelock | `setExchange`、`recapitalize`（會從 timelock 自己的餘額拉 USDC） |
| FeeRouter | owner = 部署者 | owner = timelock | `setExchange`、`setCopyTracker` |
| TraderStake | owner = 部署者 | owner = timelock | `setCopyTracker` |
| KYCRegistry | owner = 部署者 | owner = timelock | `setVerifier`。verifier 本身仍然可以即時核准 KYC |
| AssetVaultV2 proxy `0x916D…` | DEFAULT_ADMIN = 部署者 | DEFAULT_ADMIN = timelock | UUPS 升級、`setOracle`、`setEsgRegistry`、`fundVault` |
| GuardedOracle `0x8E9e…` | DEFAULT_ADMIN = 部署者 | DEFAULT_ADMIN = timelock | `addAsset`、`setRiskParams`、`setReferenceSource`、授予或撤銷角色 |
| ESGRegistryV2 `0xBF5B…` | DEFAULT_ADMIN = 部署者 | DEFAULT_ADMIN = timelock | 授予或撤銷 `ATTESTOR_ROLE`、`setMaxAttestationAge`。見證資料決定碳定價，屬於治理事項 |

**刻意保留、預設不移交的合約**（腳本裡是選用目標，預設 0x0 表示跳過；設定位址後重跑 phase 1 和 phase 2 即可納入）：

| 合約 | 現況 | 為什麼先保留 |
|---|---|---|
| EsgRewardDistributor `0x44a8…` | Ownable，owner 是部署者 | 它讀的是舊 exchange，cutover 之後本來就要重部署（§6）。重部署完成後，把新位址設為 `ESG_REWARD_DISTRIBUTOR` 再移交 |
| SustainabilityBadge `0x0a4a…` | AccessControl，admin 是部署者 | 重部署獎勵合約時要授予 `MINTER_ROLE`。先移交的話，這一步就要等 48 小時。獎勵合約接好之後，設定 `SUSTAINABILITY_BADGE` 再移交 |
| PepeIncentives `0xEBfA…` | owner 是 `0x858b…`，**不是**部署者 | 部署者沒有權限轉移它，腳本也無法處理。由持有 `0x858b…` 的人另外處理，或隨 exchange 一起重部署 |
| AssetVault V1 `0xC30D…` | Ownable，owner 是部署者 | 舊版產品路徑，已經被 V2 取代，只保留讓既有持有人贖回。需要時可以設定 `ASSET_VAULT_V1` 再移交 |

**刻意維持熱錢包、不交給 timelock 的角色（依 SEAL 建議：guardian 只能暫停，不能升級）：**

- exchange 的 `guardian`：只能暫停，資產模式**最多只能收緊到 ReduceOnly**（從 Active 收緊，或對已經是 ReduceOnly 的資產再設一次來上鎖），不能設成 Halted（`ExchangeOpsLib` 的權限矩陣）。ReduceOnly 會擋新開倉，但平倉、清算、提領保證金都照常運作。所以**exchange 的 guardian** key 即使外洩，也無法用資產模式把資金鎖在倉位裡。Halted 只保留給 owner，也就是 timelock。
- **例外：GuardedOracle 的 `GUARDIAN_ROLE` 不在上述保證內。** 它的 `setAssetFrozen` 和 `setPaused` 沒有到期時間，而且凍結或暫停會讓 `getPrice` revert。
  - 影響範圍：讀這個 oracle 的 exchange（`ORACLE_KIND=guarded`）會無法平倉與清算；V2 金庫會無法 mint 與 redeem。
  - 這把 key 外洩時，可以無限期卡住出金，但無法改價格，也無法取走資金。已列入 KNOWN_LIMITATIONS #27。
  - 移交後的處理：
    1. 由 timelock（oracle 的 DEFAULT_ADMIN）撤銷被盜 key 的 `GUARDIAN_ROLE`，改授予新的 key（48 小時）。
    2. 新 guardian 呼叫 `setAssetFrozen(id, false)`／`setPaused(false)`。
    3. 在這之前，exchange 的 guardian 可以先把受影響的市場設成 ReduceOnly。
  - **以上是鏈上現行 oracle `0x8E9e…` 的行為。** 分支 `contracts/oracle-freeze-expiry-checkin`（2026-10-01）已在原始碼把 guardian 的凍結與暫停改成有期限，**尚未部署**；GuardedOracle 不可升級，要用 `RedeployGuardedOracle.s.sol` 換一個新的 oracle 才會生效。新版的規則：
    - guardian 的凍結或暫停在該範圍的視窗開啟 72 小時後自動失效，不需要任何交易；失效後同一範圍要等 24 小時才能再開新視窗。guardian 不能延長（已凍結時再凍結會 revert），可以提前解除自己下的凍結，在原視窗內可以再凍結，但到期時間不會往後移。
    - timelock（DEFAULT_ADMIN）下的凍結或暫停沒有期限，只有 timelock 能解除；對 guardian 正在進行的凍結再呼叫一次同一個函式就是接手（清掉期限）。guardian 不能解除、也不能把 timelock 的凍結換成會到期的版本。
    - 暫停涵蓋所有資產，所以 guardian 的資產凍結同時受暫停的時鐘約束：暫停視窗進行中才開的凍結，最晚和暫停一起到期；暫停的冷卻期間不能開新的凍結。
    - 同時持有兩個角色的帳號一律視為 admin（它下的凍結不會到期）。guardian 請用獨立的 key。
    - 這把 key 外洩時，單一資產最長連續被擋 144 小時（先凍結 72 小時、到期前再暫停 72 小時），之後至少有 24 小時完全不受 guardian 影響；timelock 在 48 小時內撤換角色就會更早結束。
    - **到期是 fail-open。** 凍結的原因如果還沒排除（可疑價格、keeper 外洩），必須在 72 小時內由 timelock 接手凍結或完成處置。guardian 一凍結就同時送出 timelock 接手案，48 小時的延遲才趕得上。
    - 到期只移除凍結，不會更新價格。凍結期間 keeper 無法寫價，所以到期當下的價格和凍結一樣舊，仍要等 keeper 下一次寫價，並受各合約的 `maxPriceAge` 限制。細節與代價見 KNOWN_LIMITATIONS #27。
- exchange 的 `marketOperator`：由 keeper 擔任，只能在 Active 和 ReduceOnly 之間切換
- GuardedOracle 的 `GUARDIAN_ROLE` 與 `KEEPER_ROLE`，以及 V2 金庫的 `PAUSER_ROLE`
- MockOracle 的 owner（就是 keeper，它本身就是寫價那把 key）
- V2 金庫的 `RISK_ROLE`：fork 模擬時看到它仍在部署者手上。想把它也放進延遲，請另外用 `HandoverRoles.s.sol`

AgentSessionManager 和 StrategyRegistry 沒有 owner，不需要移交。

**Safe 的要求（非常重要）：** timelock 由自己管理自己（`admin = 0`），部署者在 timelock 上沒有任何角色。**Safe 一旦遺失（簽署人的 key 不見、門檻湊不齊），就再也沒有人能提案或執行，整個協議的治理會永久凍結**，合約裡沒有任何救援路徑。

- 建議門檻：至少 2/3，簽署人分散在不同人、不同裝置。
- 至少一把簽署 key 要冷存備份。
- 門檻必須小於簽署人數，這樣掉一把 key 仍然能運作。
- proposer 和 executor 可以用同一個 Safe。
- 移交之前，先在 Safe 上實際簽一筆交易，確認門檻湊得齊。舊 exchange `0x827e…` 維持由部署者持有：它只剩下讓使用者提領保證金，以及讓 owner 呼叫 `withdrawExecutionFees`。

## 2. 部署 timelock

```bash
cd contracts
export TIMELOCK_PROPOSER=0x<Safe>      # 必填，也會自動拿到 CANCELLER
export TIMELOCK_EXECUTOR=0x<Safe>      # 必填，可以和 proposer 用同一個 Safe
# export TIMELOCK_MIN_DELAY=172800     # 預設 48 小時，下限 1 小時
forge script script/DeployGovernance.s.sol:DeployGovernance \
  --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv   # 先模擬
forge script script/DeployGovernance.s.sol:DeployGovernance \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv          # 人工執行
```

- `admin = address(0)`：timelock 自己管理自己，要增加 proposer 也必須提案並等 48 小時。
- 腳本內建的保護：proposer 或 executor 為空就 revert；沒有 code 也 revert（必須是 Safe，只有測試時能用 `ALLOW_EOA_ROLES=true` 放寬）；proposer 或 executor 不能是部署者；執行完會讀回確認部署者沒有任何 timelock 角色。

## 3. 移交 phase 1：轉 owner 並授予 admin

```bash
export TIMELOCK=0x…  TIMELOCK_PROPOSER=0x<Safe>  TIMELOCK_EXECUTOR=0x<Safe>  EXCHANGE_NEW=0x…  COPYTRACKER_NEW=0x…
HANDOVER_PHASE=1 forge script script/HandoverToTimelock.s.sol:HandoverToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- OZ `Ownable` 的轉移是一步完成、立即生效的，轉錯就救不回來。所以腳本會先確認 `TIMELOCK` 真的是 TimelockController：
  - `getMinDelay` 要大於等於 `MIN_TIMELOCK_DELAY`（預設 24 小時）
  - `TIMELOCK_PROPOSER` 真的是 proposer，而且 **`TIMELOCK_EXECUTOR` 真的是 executor**
  - 部署者不能是 proposer，也不能是 admin
- 每個階段結束後，都用唯讀腳本讀回鏈上狀態：`EXPECT_PHASE=1 forge script script/VerifyHandover.s.sol:VerifyHandover --rpc-url … -vv`（phase 2 之後改成 `EXPECT_PHASE=2`）。
- 如果某個目標已經由 timelock 持有，就略過；如果 owner 不是 broadcaster 就 revert。任一目標設成 `0x0` 代表跳過它。
- 腳本會讀回每一個 `owner() == timelock`，以及 `hasRole(ADMIN, timelock)`。
- **phase 1 結束後，部署者仍然保有金庫和 oracle 的 admin**，這是刻意的，作為退路。

## 4. phase 1 和 phase 2 之間：用真的提案跑一次完整流程

先證明 timelock 真的能操作，再丟掉退路。建議用一筆無害、但會真正寫入鏈上的交易，例如用 Safe 提案把某個資產的 `setMaxProfitBps` 設成現在的值：

```bash
DATA=$(cast calldata "setMaxProfitBps(bytes32,uint256)" $(cast keccak sBTC) 50000)
# 在 Safe 的 Transaction Builder 裡對 $TIMELOCK 呼叫：
#   schedule(target=$EXCHANGE_NEW, value=0, data=$DATA, predecessor=0x0, salt=0x…01, delay=172800)
# 48 小時後：
#   execute(target=$EXCHANGE_NEW, value=0, payload=$DATA, predecessor=0x0, salt=0x…01)
cast call $TIMELOCK "isOperationDone(bytes32)(bool)" $(cast call $TIMELOCK \
  "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" $EXCHANGE_NEW 0 $DATA 0x0 0x…01)
```

## 5. 移交 phase 2：部署者放棄 admin

```bash
HANDOVER_PHASE=2 forge script script/HandoverToTimelock.s.sol:HandoverToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- 前置條件：每個 Ownable 的 `owner() == timelock`，而且兩個 AccessControl 合約都**讀回 `hasRole(ADMIN, timelock)` 為 true**，才會呼叫 `renounceRole(ADMIN, deployer)`。這個檢查就是防止合約變成「沒有 admin、永遠無法再升級」的關鍵。
- 如果先跑 phase 2，會 revert：`PerpetualExchange: owner != timelock - run phase 1 first`（fork 測試已驗證）。
- 最後腳本會列出部署者仍持有的熱角色（PAUSER、RISK、GUARDIAN）。
- 完成後跑 `VerifyHandover`（`EXPECT_PHASE=2`：部署者在 3 個 AccessControl 合約上都不能再是 admin），再跑一次 `Verify130`，加上 `EXPECTED_OWNER=$TIMELOCK`。

## 6. 移交後的日常操作

| 情境 | 做法 |
|---|---|
| 緊急暫停 | guardian 呼叫 `pause()`，立即生效。guardian 暫停 72 小時後自動失效，之後有 24 小時冷卻 |
| 暫停需要延長 | guardian 一暫停，Safe 就馬上提案 owner 的 `pause()`。owner 可以接手正在進行的 guardian 暫停，接手後就沒有期限。48 小時比 72 小時短，所以趕得上 |
| 恢復交易 | Safe 提案 `unpause()`，48 小時後執行。guardian 沒辦法提前恢復，這是刻意的設計 |
| RWA 開休市 | keeper（marketOperator）即時切換 Active 和 ReduceOnly，不需要經過 timelock |
| 調整 OI 上限或獲利上限 | Safe 提案，等 48 小時。要收緊但等不了：guardian 可以先把資產設成 ReduceOnly（它不能設成 Halted） |
| 金庫升級（例如 V2_5） | **建議在 phase 2 之前做完**，否則必須由 timelock 呼叫 `upgradeToAndCall` 並等 48 小時 |
| 取消提案 | proposer（Safe）同時是 canceller，呼叫 `cancel(id)` |

### 應變成本表（移交之後）

| 動作 | 誰能做 | 要等多久 | 備註 |
|---|---|---|---|
| 全域暫停 `pause()` | guardian 或 timelock | guardian 立即生效；timelock 48 小時 | guardian 暫停 72 小時後失效，接著有 24 小時冷卻 |
| 解除暫停 `unpause()` | 只有 timelock | **48 小時**（提案後） | 在那之前 guardian 的暫停可能已經自行失效（72 小時） |
| 資產設成 ReduceOnly | guardian、keeper、timelock | guardian 和 keeper 立即生效 | guardian 設的會上鎖，keeper 不能解除 |
| 解除 ReduceOnly（guardian 上鎖的） | 只有 timelock | **48 小時** | keeper 只能解除它自己設的、沒有上鎖的那種 |
| 資產設成 Halted，或解除 Halted | 只有 timelock | **48 小時** | 會凍結出金，所以 guardian 無權這樣做 |
| `InsuranceVault.recapitalize` | 只有 timelock | **48 小時**，而且 timelock 要先持有 USDC 並 approve | 做法：USDC 轉進 timelock，然後在同一個批次提案 `approve` 加 `recapitalize` |
| 金庫升級、`setOracle` | 只有 timelock | **48 小時** | 建議在 phase 2 之前做完 |
| 撤換 guardian `setGuardian` | 只有 timelock | **48 小時** | guardian 被盜期間最多只能暫停 72 小時（有冷卻）或設 ReduceOnly |
| 暫停 GuardedOracle 或凍結資產（鏈上現行 oracle `0x8E9e…`） | GuardedOracle 的 GUARDIAN_ROLE | 立即生效，**沒有到期時間** | 解除凍結也由 GUARDIAN_ROLE 執行。這把 key 被盜時，要由 timelock 撤換角色（48 小時），期間出金可能卡住（KNOWN_LIMITATIONS #27） |
| 暫停 GuardedOracle 或凍結資產（新版 oracle，**尚未部署**） | GUARDIAN_ROLE 或 timelock | guardian 立即生效；timelock 48 小時 | guardian 下的 72 小時後自動失效，同一範圍接著有 24 小時冷卻；暫停的冷卻期間也不能凍結資產。timelock 下的沒有期限 |
| 讓 guardian 的 oracle 凍結超過 72 小時（新版） | 只有 timelock | **48 小時** | 對同一資產再呼叫 `setAssetFrozen(id, true)`（暫停則是 `setPaused(true)`）即為接手。guardian 凍結後要立刻提案，否則趕不上 72 小時 |
| 提前解除 guardian 的 oracle 凍結（新版） | guardian 或 timelock | guardian 立即生效；timelock 48 小時 | guardian 只能解除 guardian 下的凍結。timelock 解除後，guardian 在原視窗內仍可再凍結，要一併撤換角色 |
| 解除 timelock 下的 oracle 凍結或暫停（新版） | 只有 timelock | **48 小時** | guardian 無權解除 |
| 金庫的資產 feed 永久失效（mint 被 `LiabilityUnpriced` 擋住） | V2 金庫的 RISK_ROLE | 立即生效 | 先 `setAssetCap(id,0)`，再 `setUnpricedExemption(id,true)`；該資產仍以最後記錄的價格計入負債（KNOWN_LIMITATIONS #29） |

## 7. fork 模擬結果（2026-09-30，Base Sepolia fork）

```
forge test --match-path test/fork/CutoverGovernanceFork.t.sol --fork-url https://sepolia.base.org -vv
```

（2026-09-30 修正後重跑。另外新增 `test_fork_interruptedCutoverResumes` 測中斷後續跑，以及用 `VerifyHandover` 在 phase 1 和 phase 2 各讀回一次，含 ESGRegistryV2。）依序模擬了以下流程：Redeploy130 → Verify130（owner 是部署者）→ OI 上限擋下開倉、獲利上限固定在 5 倍保證金 → guardian 能暫停但不能解除 → DeployGovernance（48 小時）→ 在 phase 1 之前跑 phase 2，正確被 revert → phase 1（6 個 owner 轉給 timelock，3 個 AccessControl 合約授予 admin，部署者仍保留 admin；VerifyHandover phase 1 通過）→ Verify130（owner 是 timelock）→ 部署者呼叫 `setMaxProfitBps` 被 revert，guardian 仍然可以暫停 → Safe 批次提案 `unpause` 加上 `setMaxProfitBps`：48 小時內執行被 revert，時間到後成功 → phase 2（部署者失去 admin，timelock 保有 admin，keeper 的 KEEPER_ROLE 沒被動到；VerifyHandover phase 2 通過）。結果：**2 passed**（含續跑測試）。
