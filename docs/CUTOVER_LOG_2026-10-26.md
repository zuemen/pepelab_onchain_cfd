# 2026-10-26 cutover：自動同步版 CopyTracker、PepeIncentives、PepeAMM、碳分級重寫

依 [`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) 第 8、9、10 步執行。
- 所有交易由擁有者 keystore `pepelab-owner`（部署者 `0x27C2…A585`）在本機送出。
- 執行前，同樣的順序在 Base Sepolia fork 上預演過，全部通過：部署、改接、讀回，並跑過一次真的同步、領跟單獎勵、session 下單與兌換。
- 順序經過對抗式審查。為了讓公開站的停機窗只剩「改接 → CI → Vercel」，三筆改接排在最後。
- 上一次 cutover 見 [`CUTOVER_LOG_2026-10-20.md`](CUTOVER_LOG_2026-10-20.md)。

## 結果

| 合約 | 新位址 | 取代 |
|---|---|---|
| CopyTracker（自動同步版，ADR-024） | `0x31297044a7b3A0F57e7CDa7fE619E996da1c64A9` | `0x15A9…347C`（快照版，列在 `frontend/src/contracts/legacyCopyTrackers.ts`） |
| PepeIncentives（綁新 tracker） | `0x588dda0b1f5c46242fbbb694771dfc30179e21c3` | `0xc257…72F0`（已 `pause()`，1,000,000 PEPE 已收回） |
| PepeAMM（讀交易所的 MockOracle） | `0xb40603df54d0af75f1915106F352672372570d97` | `0x93be…ad63`（讀退役的 `0xeD90…`；0.0472 ETH 已收回） |

三顆的鏈上 bytecode 都與原始碼完全一致（`check-deployment-status.mjs`，區塊 50398268）。部署紀錄在 `contracts/broadcast/` 下面這幾個腳本的目錄：
- `RedeployCopyTrackerAutoSync.s.sol`
- `DeployPepeIncentives.s.sol`
- `ConfigurePepeIncentivesGameFi.s.sol`
- `DeployAMM.s.sol`
- `AttestTenantCarbon.s.sol`

## 各步驟（依實際順序）

| # | 動作 | tx | 讀回 |
|---|---|---|---|
| 1 | 碳分級重寫 sICLN、sESGU（`AttestTenantCarbon`，`ATTEST_ASSETS=sICLN,sESGU`） | `0x5dc304e1af6a2ec2eab61898351649e376cb97ece33fdd5993d8e98068ac4e11`、`0x1ca3c09b6a373cd5714506379ba758a214f8de8c31bf1c00eb374ac46f46a01c` | 兩檔都是 tier 3（High）、`maxLeverageForAsset` 1、手續費 100 bps |
| 2 | 收回舊 PepeAMM 的 ETH：mint 115.59 mUSDC，以舊池的固定 oracle 價換回 | mint `0xcda56759…92f`、approve `0x7ceb2202…ecd1`、swap `0x3f06731c7ab9f27f75a8a385720b5204342acd98c08d4153515d17cdc7d0161f` | 舊池 0.0472 → 0.00005 ETH；部署者 0.043 → 0.090 ETH |
| 3 | 觸發 keeper（run 40287157708），部署新 PepeAMM（種子 0.02 ETH，以 oracle 價開盤），`setMaxOracleAge(21600)` | 部署 4 筆（broadcast）；`setMaxOracleAge` `0x296902ff5c065da42b494a1011042088bad82d74dbcfeedc8875d14ce4420cce` | 價差 0 bps；`maxOracleAge` 21600（與交易所 `maxPriceAge` 一致；預設 1 小時，keeper 實際間隔最長約 5.8 小時） |
| 4 | 只部署 CopyTracker，`VERIFY_ONLY` | `0xeb2510d27d754a719346a358d1035df9a3eccdba8ebec2d161e32bb6dd781447` | 20,026 B；建構參數與現行 registry、USDC、TraderStake、FeeRouter 一致 |
| 5 | PepeIncentives（`COPY_TRACKER`＝新、`ESG_REGISTRY`＝0，與上一版相同），加 `ConfigurePepeIncentivesGameFi` | 部署 `0x846364ad024560cec7816bc5db96f02196212f7be7915f9a48ebf4c845c03688`；設定 4 筆（broadcast） | `copyReward` 500 PEPE、`tradeMiningBps` 200、池子 1,000,000 PEPE |
| 6 | 執行者熱錢包 `0xB534EFb3bcE2D75477c7FCC2E6e09C3cC533CcAA`：GitHub environment `copy-sync`（分支政策只限 master）的 secret `COPY_SYNC_PRIVATE_KEY`，轉入 0.005 ETH | — | `copy-sync-executor.yml` 讀 `addresses.ts` 的 tracker |
| 7 | **改接（07:48 UTC）**：FeeRouter → TraderStake → 交易所 `setCopyTracker` | `0x5f170db2d02a837f46cd80ae0a835fdac8394edc806d481512e72910a9ec1623`、`0x3f7721b06f9b6b0d80aeaa86810a3e575cdd5cd7fc8c339d16f78c55fc75c401`、`0x44ca26128ac97a8d21404a0a11a9a1611366eed77067a7379a76842ce87fe720` | `VERIFY_ONLY EXPECT_WIRED` 通過；交易所 `authorizedAgents`：新的 true、舊的 false |
| 8 | 舊 PepeIncentives `pause()`、`withdraw(1e24)`（新舊兩顆綁同一個交易所，不停掉的話同一個部位可以兩邊各領一次） | `0xe6751701e3700a943b5946a4fc5a98eeaa2a53024c1c58d1c0cce64cccdd27fe`、`0x69e3bd55ce3c39d110450c5526e4c79cea54d811006854147a87d736c2661bbd` | `paused` true、PEPE 0 |

## repo 同步（本 PR）

- `addresses.ts`：三個新位址。舊位址進 `retiredPlatformAddresses.json`；舊 tracker 另進 `legacyCopyTrackers.ts`，排行榜與交易者頁的跟隨人數照算，並分開標示。
- signal-api bundle 重新產生；`tenantDeployment` 快照更新。
- 監控：
  - `deployed.json` 重抓並 `--write`；
  - CopyTracker 自動同步的五個事件、四個跟隨者函式重新分類（跟隨者自己的操作，不是管理操作）；
  - 新增規則 `pepeamm-admin`：oracle 護欄變更與移除流動性，SEV-3。
- 發布狀態以唯讀 RPC 重新產生：Base Sepolia 鏈上＝原始碼 20、原始碼較新 9。
- `copy-sync-executor.yml` 與守門登記（同一個 PR，因為執行者讀 `addresses.ts` 的 tracker）。

## 停機窗與影響

- 從改接（07:48 UTC）到這個 PR 在 Vercel 上線之前，公開站的前端仍指向舊 tracker：
  - 新跟單會失敗：舊 tracker 已不是 FeeRouter 的收費者，也沒有交易所授權；
  - 舊跟單的「取消跟單」會 revert，出路是 `deactivateWithoutScoring`，部位一直在跟隨者名下。
- 舊 PepeIncentives 暫停之後，在舊前端上領獎勵會 revert。
- 新 PepeIncentives 從空狀態開始：已經在舊實例領過的部位，在新實例上還能再領一次（KNOWN_LIMITATIONS 記錄）。

## 待辦

- 公開站實際走一次：示範交易者發版 → 示範跟隨者跟單、開自動同步（冷卻 1 小時）→ 等 1 小時發新版 → 執行者同步 → 投資組合顯示已同步；領跟單獎勵；session 下單；x402 付費。結果補在下方。
- keeper 改用 Cloudflare 觸發（OWNER_ACTIONS 第 2 步），需要 Cloudflare 帳號。
