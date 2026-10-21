# #344 cutover 執行紀錄（2026-10-20 ～ 10-21）

依 `contracts/script/cutover-344.sh`（PR #350 的精靈）執行。所有交易由擁有者在本機（WSL Ubuntu）以 keystore
`pepelab-owner`（部署者 `0x27C2…A585`）送出；讀回、數據集與 repo 同步由 agent 以唯讀 RPC 完成。
上一次 cutover 見 [`CUTOVER_LOG_2026-10-10.md`](CUTOVER_LOG_2026-10-10.md)。

## 結果

| 合約 | 新位址 | 取代 |
|---|---|---|
| PerpetualExchange | `0xbF3074C98e17d88B4127899C98C81AE94c9fC979` | `0x827eA0c6…124D`（#129） |
| ExchangeOpsLib（exchange 連結的 library） | `0xe77655017c63a8CFc21cCa3af83d713D529a1941` | — |
| MockOracle（`ORACLE_KIND=fresh`） | `0x9Cf4E05B08F6cC53be2e04752F2c32A79132deEA` | `0xeD90…0Aa3`（退役：沒有合約再讀它，keeper 不再寫） |
| AgentSessionManager | `0x4875966ACA052A38d80ddD2aaE80995A98EAd2AF` | `0xdF9C…d14B` |
| StrategyRegistry | `0xe8d807C3BaFB4D3AeCbA094322eE8dD7Ca16C20c` | `0xA103…4b95` |
| CopyTracker | `0x15A9Cbf803a3EEee2794B74Ad78252d27Ccd347C` | `0xC9e9…CCB2`；中間版 `0x5434…B2A5`（第 1 步部署、第 5 步換掉） |
| InsuranceVault | `0x899263e34107a36a5216499F9CC7fb7a5afc7aaF` | `0xB364…D812` |
| FeeRouter（MockUSDC） | `0x89Aa6799b2CdAa43FF7985ff706456Ca6F0e5d29` | `0x00f6…3e0c` |
| PepeIncentives（#219 點數版） | `0xc257Dd9b9eb392893a89d307664713E8660672F0` | `0xEBfA…3c12` |
| EsgRewardDistributor | `0x4C9232eE2caAe2B065eb1Ca9AD966Ef69A0D2433` | `0x44a8…609F` |
| CarbonRetirement | `0x93B72Dd20913107aC9eEe4e9420D9C8aB802Fd28` | 新增 |
| PlatformFeeSplitter | `0xe5b1B4009c41dd5C02e216F42f33b3a8d4EE0a0C` | 新增（FeeRouter 的 treasury） |
| guardian | `0x1A5E03Ab2c96Dbc8A6E9CA80a3396eEa9e71EC6f` | — |

沿用：TraderStake `0x01aE…28Fe`（`setCopyTracker` 指向新 CopyTracker）、KYCRegistry、MockUSDC、V2 金庫堆疊。
部署紀錄：`contracts/broadcast/{Redeploy130Hardened,DeployCarbonRetirement,RedeployInsuranceStack,DeployPepeIncentives,Deploy102RewardDistributor}.s.sol/84532/`。

2026-10-21 唯讀讀回：`exchange.oracle()`＝新 MockOracle、`feeRouter()`／`insuranceVault()` 為新的兩顆、
`FUNDING_INTERVAL` 8h、`maxPriceAge` 6h、`adlEnabled` true、`vaultFeeShareBps` 0、`authorizedAgents(新 manager)` true；
新 manager 的 `exchange()`＝新 exchange、`nextSessionId` 0（還沒有 session）。exchange 的 owner 仍是部署者（timelock 移交另議）。

## 各階段

1. **Redeploy130Hardened**：exchange、registry、中間版 CopyTracker、session manager、專用 MockOracle（以共用 oracle 的現價為種子）。`Verify130` 讀回通過。
2. **CarbonRetirement**、**RedeployInsuranceStack**（InsuranceVault、FeeRouter、最終版 CopyTracker）。
3. 4 筆 `cast send` 接線：exchange `setInsuranceVault`（`0x37b9627e…`）、`setFeeRouter`（`0x4d42166b…`）、
   `setCopyTracker`（`0xa5ed3a0a…`）、TraderStake `setCopyTracker`（`0xc04bfb77…`）。
4. **DeployPepeIncentives**、**Deploy102RewardDistributor**；2024 價格寫入新 oracle。
5. **公開鏈回放**（`agent/heroes/replay.ts --public`）：2024-10-01 → 2026-10-18 共 748 天，
   **14,375 筆交易、0 失敗**、5,582 個事件（`heroes/out/events-84532.json`）。
6. **84532 數據集**：24 位交易員、1,339 筆平倉、24 筆碳權註銷（9.36 t，模擬額度）→ `frontend/public/data/heroes/84532/`。
7. **oracle 移交**：新 MockOracle 的 owner 轉給 keeper `0x540a…ef17`（`0x1fb39b892000de34bfd58e733f25c17bc9770a9938e5f700cb352a71828a5381`），已讀回。

## 過程中的問題與修正

| 問題 | 處理 |
|---|---|
| 第一次在 Git Bash 執行（Smart App Control 擋 forge） | 改在 WSL Ubuntu 跑 |
| 回放等不到收據就逾時 | #354：收據輪詢改為公開鏈的等待時間 |
| 負載平衡 RPC 的節點落後：approve 剛上鏈，下一個 `estimateGas` 讀到授權 0，判定會 revert | #356：`eth_call`／`estimateGas` 釘在看過的最新區塊。被這個弄壞的那一輪作廢（金鑰檔改名為 `heroes/keys/84532.aborted-20261020.json`），換新帳號重跑 |
| Alchemy 免費方案限流（compute units per second），兩種錯誤包法 | #357、#359：兩種包法都認得，指數退避重送 |
| 部署者發 gas 發太多（帳號裡留太多 ETH） | #358：補到需要量的 1.25 倍；新增 `agent/heroes/sweep.ts` 取回作廢那一輪帳號的 ETH |
| Alchemy 免費方案 `eth_getLogs` 只准 10 個區塊，回放最後掃事件失敗 | 換 `base-sepolia-rpc.publicnode.com`（允許 1 萬區塊）重跑該步，回放本身不用重做 |
| 第 12 步讀回比送出快，讀到移交前的 owner | 人工讀回確認 owner＝keeper 後在 `cutover-344.env` 記 `ORACLE_HANDED_OVER=yes` |

結束時（2026-10-21）部署者餘額約 0.043 ETH、keeper 約 0.146 ETH。

## repo 同步（本 PR）

- `frontend/src/contracts/`：`addresses.ts`、`sessionManager.ts`、三份 ABI（PerpetualExchange、CopyTracker、InsuranceVault）、
  `legacyExchanges.ts`（#129 exchange 列入 `/legacy`）、`retiredPlatformAddresses.json`（10 顆退役位址，含舊 MockOracle）。
- keeper、`oracle-health`、`admin-base-sepolia` workflow 改指新 oracle 與新 exchange（keeper 已是新 exchange 的 marketOperator，
  休市切換與熔斷時的 ReduceOnly 從此做得到）；keeper workflow 的 sha256 已重新釘選。
- 舊的 `0xeD90…0Aa3` 退役：2026-10-21 讀回，平台 GuardedOracle 與 rwa-poc 的 oracle `referenceSource` 都是 0，
  rwa-poc 的 exchange 讀自己的 oracle；`deploy/tenants/rwa-poc.json` 的 `priceSource` 只在部署時取初始價，改指新 oracle。
- 監控：`deployed.json` 重抓；`--refresh-deployed` 學會找連結的 library（exchange 的 pause／資產模式事件從 ExchangeOpsLib emit）；
  7 條 pending-deploy 規則改 active（insurance 接線、exchange 暫停／資產模式／guardian／曝險上限、CopyTracker 罰沒準備金、PepeIncentives 簽到參數），
  移除過期的 `notDeployed`、組合保證金事件與 setter，CopyTracker 納入 owner-transferred。
- agent：`.env.example`、`x402_agent.ts`、examples、SDK `SESSION_MANAGER_BY_CHAIN`、`create-session.sh`；signal-api bundle 重建。
- `docs/RELEASE_STATUS.md`／`release-status.json` 重跑：Base Sepolia 鏈上＝原始碼 19、指向外洩地址 0。
- 回放價格表 `heroes/prices/*.csv` 與部署 broadcast 紀錄。

## 待擁有者

- 合併本 PR 後 Vercel 重新部署前端與 signal-api，照 #322／#323／#324 的清單驗收公開網站
  （BaseScan、KYC 後用新錢包跟單股票交易員、#333 碳權註銷、#334 成就、排行榜載入速度）。
- 舊 exchange `0x827e…124D` 還有 **500 USDC** 使用者保證金，從 `/legacy` 取回。
- 合併 #355（GameFi 的 PepeIncentives 設定）後 `git pull`、再跑一次 `cutover-344.sh`，第 9 步答 y 套用設定。
- **輪替 Alchemy API key**：回放用的 RPC URL（含 key）出現在擁有者的截圖裡。repo 與本紀錄都沒有它。
- 新 session manager 上還沒有 session：要跑 x402 範例或 demo agent 先用 `create-session.sh` 建一個。
- 決定是否把新 exchange 等合約移交 timelock（`HandoverToTimelock.s.sol` 的位址常數仍是舊的，移交前要更新）。
- 回放帳號（`heroes/keys/84532.json`）裡剩的 ETH 之後可用 `sweep.ts` 取回；展示「策略已更新」前先保留交易員的 gas。
- 驗收後關閉 #344、#309、#169。
