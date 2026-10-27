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

- ~~公開站實際走一次~~ → 2026-10-27 完成，見下一節。
- keeper 改用 Cloudflare 觸發（OWNER_ACTIONS 第 2 步），需要 Cloudflare 帳號。

## 公開站實測（2026-10-26～27）

全部是 Base Sepolia 上的真實交易。示範錢包是另外新建的測試網錢包，不是平台角色。

### 跟單與自動同步

| # | 動作 | tx | 結果 |
|---|---|---|---|
| 1 | 示範交易者「AutoSync Demo」`0x1B3d…8EcB` 質押、註冊、發布 v1（ETH 40% 多 2×、BTC 30% 多、XAU 30% 多） | v1 `0x30baa20d4fa7033efaac0ee223768443426660d118001e2beb48d3dc77ea82cc` | — |
| 2 | 跟隨者 1 `0x3Ea5…5fE4` 跟單 60 USDC，開啟自動同步（冷卻 3600 秒、槓桿上限 2×） | `0x33d9226867d7458eb9abd602b708dfe09b84880b35e2341129978fbbb9f525cc` | — |
| 3 | 跟隨者 2 `0xA9f4…9CCf`：在**正式站網頁**（專家模式）跟單，同一筆交易開啟自動同步（冷卻 1 小時、槓桿上限 2×） | approve `0xb5f0b38c020599ef448aae332f6ea83e840955d58d5b387e73a863695fcf7e9a`、follow `0xb025439b7fa22a64725a1fdb0ba35bdd818bbaf413718e168a2e47e3f5cc774f` | 網頁顯示「已跟隨交易者並開啟自動同步」 |
| 4 | 跟隨者 2 在 /rewards 領跟單獎勵 | `0x16b7fe1760d44163186a1d792fdd3b27d31f82cc67c371f05baa8105d7ef3cee` | 500 PEPE |
| 5 | 交易者發布 v2（ETH 50% 多 5×、BTC 30% **空**、XAU 20% 多），10/27 04:12 UTC | `0xd9f6a0268f416cac97e7d4867d1dc5c9e2ae60d7f4b6a58b697a8086d4d20101` | — |
| 6 | 手動觸發 `copy-sync-executor.yml`（run 40448475325，master） | `0x961eca40923f6500616ce769a763e27e851cf9c8beafc1caa15d3ec78ad34f88` | 見下方三點 |

第 6 步的結果：
- 跟隨者 1 由 v1 同步到 v2，3 條腿，重新部署保證金 58.84 USDC；執行者 gas 0.0000125 ETH。
- `Resynced` 事件讀回：follower `0x3Ea5…`、trader `0x1B3d…`、版本 0 → 1、executor `0xB534…CcAA`。
- 跟隨者 2 被擋下（剛跟單，冷卻到 05:07 UTC），這是合約規則的保護。

投資組合的同步欄顯示「第 2 版（最新）・自動同步：開・已同步 1 次」。ETH 在 v2 是 5×，但跟隨者的槓桿上限是 2×，所以實際以 2× 開倉。

### Session 與 agent（x402）

- `/sessions` 建立 session #0（使用者 `0x48b0…FbA5`、agent `0x497E…64Da`；單筆 50、總額 100 USDC、槓桿 ≤ 3×、72 小時），交易 `0x7c5e4747…`，並核發授權 VC。
- `examples/x402-autotrade.ts` 實跑：以 x402 付費取資料，再用 `openPositionForSession` 在限額內下單，交易 `0x26ae5861124e8b64e86c0afb2f782e407e4930fac36c5dd62c962ca031fa6882`（position 2635）。

### x402 70/20/10 上鏈（10/27）

1. 線上 signal-api（Vercel 專案 `agent`）原本沒有 `UPSTASH_REDIS_REST_URL/TOKEN`，付費回應是 `settlement disabled`，從來沒有排入佇列；`/oracle` 也缺 `ORACLE_BENEFICIARY_ADDRESS`。
2. 擁有者補上三個變數。`ORACLE_BENEFICIARY_ADDRESS` 設為 keeper `0x540aECD37E7A7885824e7b7e996eBddfb842ef17`：價格是它推的，而且與 x402 FeeRouter 的 treasury、vault 都不重複。
3. 補完變數按 Redeploy，部署被 Ignored Build Step 取消（同一個 commit，diff 為空）。#381 修好後，agent 隨合併 `b9ec364` 重新部署。
4. 付費：`/signals` 0.01 USDC（`0x653ffc92…`）、`/oracle/sETH` 0.005 USDC（`0xe12a3857…`），兩筆回應都是 `settled:true`。
5. 手動觸發 `x402-settlement-worker.yml`（run 40444477948），`settled=2`，其餘計數都是 0：
   - `/signals` 那筆：`0x700677c35aa60f80073060cd73f19dec45a1477c1023ae8c7c9f93bd13daa1e2`
   - `/oracle` 那筆：`0x4cd8054dacc4f12aa301ab13399cf464d242359aec4cec918ee07273e27c2e41`
6. 鏈上讀回（USDC 6 位小數）：`traderEarnings(0x1B3d…)` 7000、`traderEarnings(keeper)` 3500、`platformEarnings` 3000、保險金庫 +1500。這正好是 0.01 與 0.005 的 70/20/10。`/revenue` 顯示 feeUsd 0.015。

**平台與租戶現在共用同一個 Upstash（`pepelab-rwa-poc-kya`）**：Vercel Marketplace 的免費名額已經用完。

- 為什麼可以共用：
  - 租戶設了 `X402_SETTLEMENT_MODE=off`，線上 `GET /` 讀得到，所以租戶不會排入 `x402:settlement:*`；
  - 平台只用 `x402:settlement:*`，與租戶的 `x402:kya:*`、`vc:status:*` 不重疊。
- 共用前清掉了一筆租戶殘留：`x402:settlement:queue` 裡有一筆 10/9 驗收付款（`0xe2cd…f55a`，付給租戶的 payTo），是在租戶設 off 之前排入的。
  - worker 不逐筆核對收款人，若不處理，會拿平台 PAY_TO 的錢去結算它。
  - 已改名封存成 `rwa-poc:archived:x402:settlement:queue:20261009`（`RENAMENX`，可改回）。
- GitHub repo secret `UPSTASH_REDIS_REST_URL/TOKEN` 已換成這個 DB（舊 DB 的佇列實測全 0）。
- 日後租戶若要開分潤（拿掉 off），**必須先拆成兩個 DB**。
- 待辦：可寫入的 token 在設定過程中曝光過，影片錄完後要重設 Upstash 憑證，並同步更新三處：agent 的 `UPSTASH_*`、GitHub secret、租戶專案的 `KV_*`。

### 證明影片

`PepeFi_自動同步_證明影片_20261027.mp4`（5:08）：動畫解說，加上正式站、真終端機（`gh run view --log`、`cast call`）與 Blockscout 的真實畫面。檔案放在專題資料夾，不進 repo。
