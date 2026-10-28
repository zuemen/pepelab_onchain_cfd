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
- keeper 改用 Cloudflare 觸發（OWNER_ACTIONS 第 2 步），需要 Cloudflare 帳號。部署後也會補觸發 `copy-sync-executor.yml`（自動同步實際間隔從 3.5–5.5 小時縮到約 20 分鐘）。

## 公開站實測（2026-10-26～28）

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
- 可寫入的 token 在設定過程中曝光過；2026-10-27 擁有者決定不重設（測試網資料庫，接受風險）。日後要重設時，三處要一起更新：agent 的 `UPSTASH_*`、GitHub secret、租戶專案的 `KV_*`。

### agent 的三種執行方式與 AI 工具（MCP）（10/27～28）

新錢包（都只放少量測試網 ETH）：
- personal-agent `0x5AA2…1269`：跟隨者 1 自己的 agent 熱錢包。
- mcp-follower `0x1E5b…e339`：由 MCP 準備跟單的跟隨者。

MCP 都用真的 stdio 協定呼叫 `agent/mcp-server`，連 Base Sepolia。MCP 只回未簽名交易，簽名在跟隨者自己的錢包。

| # | 動作 | tx | 結果 |
|---|---|---|---|
| 1 | MCP `prepare_copy_sync_tx`（set-executor）：跟隨者 1 指定只讓 personal-agent 同步 | `0x1a2babb679f1e42a0b5452b7620e159b7f0d558b8dcabe23c5027bea8494a9aa` | — |
| 2 | MCP `prepare_copy_follow_tx`：mcp-follower 跟單 60 USDC＋自動同步（2×、冷卻 1h、油箱 0.0005） | approve `0x4a64ddfc07ebf683425ac5a1a989220d366a7573d0105e5f67cf90d4db0b1d0b`、follow `0xd4ce4c9c46c685f9485f5e882d80f4833873cb04d46d04ffa02caa9c254e5b17` | — |
| 3 | 交易者發 v3 | `0x38eba298668b91ba3fd637ef173463e33723f74d891046abe8ad5dae8a4200b0` | — |
| 4 | public 執行者（run 40460884073） | 跟隨者 2 v2→v3 `0x635ac3d0e011c559747410fa062a49b0c177762d11818c5d4c59e7347a955254` | 跟隨者 1 已指定執行者 → 沒被碰；mcp-follower 冷卻中被擋 |
| 5 | personal 模式（`--mode personal --followers`）同步跟隨者 1 v2→v3 | `0x6706399d35e7ccdb89301e093ef4f74e06e7eee6fefb5054b9a041ffa66095c3` | MCP 讀回 v3/v3、designatedExecutor＝personal-agent |
| 6 | notify-only（`--notify-only --notify-webhook`，不讀金鑰） | — | 跟隨者的 webhook 收到 `new-version`（mcp-follower，v2→v3） |
| 7 | 交易者發 v4 | `0xcfe2998962d70c61cf83de65373dcc935982a66a315f028b4cb8afb97727a19b` | — |
| 8 | public 執行者（run 40611311910） | 跟隨者 2 v3→v4 `0x067fefbf1a3fa9a9284e317ba7a97afdb87145c55124e55a7d7439cf3e490a30` | mcp-follower：`InsufficientSyncGas`（油箱 0.0002 < 0.0003）被擋 |
| 9 | personal 模式同步跟隨者 1 v3→v4 | `0xe7cb680714263f61f11a48323773e008200e64ab0bfbfa3f1b3410f13a05e042` | MCP 讀回 v4/v4、syncCount 3 |
| 10 | MCP `copy_sync_status` 指出油箱不足 → `prepare_copy_sync_tx`（deposit 0.0006 ETH） | `0x2ff3f890643e16b8bfa1f8396fb067192b398a1f7ae62dc800af5356bdbe6911` | — |

### 一般使用者只用網頁（10/28）

全新錢包 web-user `0x4Cd8…5710`，只用網頁操作（本機執行 master `f2d7006` 前端，連同一條 Base Sepolia）：

| # | 動作 | tx | 結果 |
|---|---|---|---|
| 1 | 「入金與兌換」領測試 USDC | `0x6cd437d89ca8f4e73f6b55bd6c39d233ae67b6691c8d8d63888fa7b29e5fa775` | — |
| 2 | 跟單頁勾選自動同步（2×、冷卻 1 小時），步驟 1 批准、步驟 2 跟隨 100 USDC | approve `0xe5ea6132208822b09753093dac68848c32c4975495dddeab3539da90aec482a1`、follow `0x5f424d51c631c8e0ad56ff0511900e129854e9925713d403643bd9ae79e9505c` | 一筆交易附 0.00205 ETH（開倉執行費 0.0003＋油箱 0.00175） |
| 3 | 冷卻 1 小時過後，交易者發 v5（ETH 34% 空、BTC 33% 多 2×、XAU 33% 多） | `0x01a4bf81ee4decb92c12588d10a749a06a80a0156b26c4ade3a3d969f4476eb1` | — |
| 4 | public 執行者（run 40620716014，手動觸發） | web-user v4→v5 `0x5e0a31620c36cbc73648c220c02f364d0476c909d8fd2e44e448a71a75ee0eec` | 跟隨者自己沒有簽任何交易；同一輪也同步跟隨者 2 `0x8e852934ef963cd2b79e6392aef716aea9be0f3b52b190c284d0247ead95e1f8`、mcp-follower（補油箱後 v3→v5）`0xbb2304807f581714c3a188e3c6d53d7262a781ee66980ea9199de242b41dbb95` |
| 5 | personal 模式同步跟隨者 1 v4→v5 | `0x506d85eece74434861d1fe69ae9d2c9228487ab7660e40b9c7b44c54325cc842` | — |
| 6 | 正式站唯讀檢視 web-user | — | 投資組合「第 5 版（最新）・自動同步：開・已同步 1 次」，油箱 0.00175 → 0.0014 ETH；動態牆「4 筆跟單的部位已同步到第 5 版」 |

第一次按「跟隨」時錢包只有 0.0018 ETH，不夠付 0.00205 ETH；網頁跳出紅色錯誤提示（ETH 不足），沒有送出交易。補 ETH 後重按就成功了。

**排程實測**：`copy-sync-executor.yml` 的 cron 名目每 15 分鐘，但 10/26–28 實際的 schedule run 只出現在 20:42、00:06、04:54、10:21、15:55、20:34、23:57（UTC），間隔 3.5–5.5 小時。本節的同步都是手動觸發。`ops/keeper-trigger` 的 `WORKFLOW_FILES` 已加入 `copy-sync-executor.yml`，Worker 部署後每 20 分鐘會補觸發一次（OWNER_ACTIONS 第 2 步）。

### 證明影片

`PepeFi_自動同步_證明影片_20261027.mp4`（5:17）：動畫解說，加上正式站、真終端機（`gh run view --log`、`cast call`）與 Blockscout 的真實畫面。檔案放在專題資料夾，不進 repo。

`PepeFi_agent跟單_使用教學_20261028.mp4`（1:45，給組員測試用）：一般使用者從網頁跟單並開啟自動同步，冷卻後交易者發 v5，平台 agent 自動同步；使用 Blockscout 與正式站的真實畫面。
