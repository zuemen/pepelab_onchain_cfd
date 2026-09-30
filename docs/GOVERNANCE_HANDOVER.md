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

**刻意維持熱錢包、不交給 timelock 的角色（依 SEAL 建議：guardian 只能暫停，不能升級）：**

- exchange 的 `guardian`（只能暫停，也能收緊資產模式）與 `marketOperator`（keeper，只能切換 Active 和 ReduceOnly）
- GuardedOracle 的 `GUARDIAN_ROLE` 與 `KEEPER_ROLE`，以及 V2 金庫的 `PAUSER_ROLE`
- MockOracle 的 owner（就是 keeper，它本身就是寫價那把 key）
- V2 金庫的 `RISK_ROLE`：fork 模擬時看到它仍在部署者手上。想把它也放進延遲，請另外用 `HandoverRoles.s.sol`

AgentSessionManager 和 StrategyRegistry 沒有 owner，不需要移交。舊 exchange `0x827e…` 維持由部署者持有：它只剩下讓使用者提領保證金，以及讓 owner 呼叫 `withdrawExecutionFees`。

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
export TIMELOCK=0x…  EXCHANGE_NEW=0x…  COPYTRACKER_NEW=0x…
HANDOVER_PHASE=1 forge script script/HandoverToTimelock.s.sol:HandoverToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
```

- OZ `Ownable` 的轉移是一步完成、立即生效的，轉錯就救不回來。所以腳本會先確認 `TIMELOCK` 真的是 TimelockController：`getMinDelay` 要 ≥ `MIN_TIMELOCK_DELAY`（預設 24 小時）、`TIMELOCK_PROPOSER` 要真的是 proposer、部署者不能是 proposer 也不能是 admin。
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
- 完成後再跑一次 `Verify130`，加上 `EXPECTED_OWNER=$TIMELOCK`。

## 6. 移交後的日常操作

| 情境 | 做法 |
|---|---|
| 緊急暫停 | guardian 呼叫 `pause()`，立即生效。guardian 暫停 72 小時後自動失效，之後有 24 小時冷卻 |
| 暫停需要延長 | guardian 一暫停，Safe 就馬上提案 owner 的 `pause()`。owner 可以接手正在進行的 guardian 暫停，接手後就沒有期限。48 小時比 72 小時短，所以趕得上 |
| 恢復交易 | Safe 提案 `unpause()`，48 小時後執行。guardian 沒辦法提前恢復，這是刻意的設計 |
| RWA 開休市 | keeper（marketOperator）即時切換 Active 和 ReduceOnly，不需要經過 timelock |
| 調整 OI 上限或獲利上限 | Safe 提案，等 48 小時。要收緊但等不了：guardian 可以先把資產設成 ReduceOnly 或 Halted |
| 金庫升級（例如 V2_5） | **建議在 phase 2 之前做完**，否則必須由 timelock 呼叫 `upgradeToAndCall` 並等 48 小時 |
| 取消提案 | proposer（Safe）同時是 canceller，呼叫 `cancel(id)` |

## 7. fork 模擬結果（2026-09-30，Base Sepolia fork）

```
forge test --match-path test/fork/CutoverGovernanceFork.t.sol --fork-url https://sepolia.base.org -vv
```

依序模擬了以下流程：Redeploy130 → Verify130（owner 是部署者）→ OI 上限擋下開倉、獲利上限固定在 5 倍保證金 → guardian 能暫停但不能解除 → DeployGovernance（48 小時）→ 在 phase 1 之前跑 phase 2，正確被 revert → phase 1（6 個 owner 轉給 timelock，2 個合約授予 admin，部署者仍保留 admin）→ Verify130（owner 是 timelock）→ 部署者呼叫 `setMaxProfitBps` 被 revert，guardian 仍然可以暫停 → Safe 批次提案 `unpause` 加上 `setMaxProfitBps`：48 小時內執行被 revert，時間到後成功 → phase 2（部署者失去 admin，timelock 保有 admin，keeper 的 KEEPER_ROLE 沒被動到）。結果：**1 passed**。
