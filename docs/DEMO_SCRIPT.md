# Demo Script — On-Chain CFD Copy Trading PoC

> **歷史快照（2026-06-14）**：本文件是當時的展示腳本，其後未隨部署更新；
> 位址、流程與功能（例如跟單在商業版已預設關閉）可能已過期。現況見 [`README.md`](../README.md)。

> **已上鏈 Base Sepolia (chainId 84532)** — 位址見 `docs/CAPSTONE_DELIVERABLES.md`。
> 前端連 Base Sepolia 錢包即可走真鏈 demo；下方一鍵腳本則為本機 deterministic 版。
> Anvil 區段（最底下）保留作純本機演練。

## ⚡ One-command end-to-end（P3-3，最快路徑）

整個鏈上故事一行跑完，不需 anvil / 前端 / 錢包，**deterministic 並印出每步關鍵數字**：

```bash
cd contracts && forge script script/DemoE2E.s.sol:DemoE2E -vv
```

依序展示：① 上架 RWA 標的 XAU（KYC + 2x 槓桿上限 N3）→ ② 未 KYC 開倉被擋、KYC 後成功（G2）
→ ③ LP 注入做市金庫（N1）→ ④ 使用者委派有界 agent session（Phase 2）→ ⑤ agent **經 session 自主下單**
→ ⑥ mark vs index 價（OI 失衡溢價 G6）→ ⑦ 交易費推升金庫 share price＝LP 收益（N1）
→ ⑧ 崩盤清算：**保險金庫優先兜底、再 ADL 對獲利方減倉**（N2）。

要在本機鏈上產生真實 tx hash，改跑：
```bash
anvil   # terminal 1
cd contracts && forge script script/DemoE2E.s.sol:DemoE2E --broadcast --rpc-url http://localhost:8545
```

**x402「付費讀訊號 → 決策」那段**是鏈下 agent 棧，見 `agent/README.md`：
`npm run signal-api` + `npm run demo-agent`（本腳本涵蓋 agent 下單最終落地的鏈上半邊）。

> **展示前必做（一次）**：agent 真的下單前，先在 `agent/` 跑 `npm run vc-status:init`（初始化 VC 撤銷狀態目錄，ADR-016）。
> 沒做的話 demo-agent、MCP、tg-bot 的開倉與平倉都會被拒（`VC_STATUS_UNVERIFIED`，訊息「狀態清單目錄未初始化」）。
> 只在持久儲存上跑一次，不要放進啟動腳本。

前端互動式 demo 走訪見下方「五分鐘展示腳本」。

---

## 自動同步跟單（2026-10-26 新增，ADR-024，本機 Anvil）

> 這一段是新寫的，對應現行原始碼，不屬於上方的歷史快照。設計見
> [`ADR-024-copy-auto-sync.md`](ADR-024-copy-auto-sync.md)。Base Sepolia 上的 CopyTracker 還是快照版
> （部署步驟見 `OWNER_ACTIONS.md` 第 8 步），所以這段只在本機鏈展示。

**要講的一句話**：跟隨者在鏈上同意一次之後，任何人都能、也只能把他的部位調成交易者鏈上最新版；
沒有人拿到跟隨者的私鑰，執行者也不能選資產、方向或槓桿。

### 一鍵版（不開前端，約 1 分鐘；展示前先跑一次確認環境）

```bash
scripts/demo-autosync.sh
```

它自己起一條乾淨的本機 Anvil、部署 `DeployLocalDemo`，用真的 `agent/copy-sync` 執行者把下面步驟 1–6 從頭到尾跑一遍，
每一步都有斷言、逐行印出結果：跟單＋開啟自動同步＋預存油箱一筆完成 → 交易者發第 2 版、冷卻中陌生人被 `SyncCooldown` 擋下 →
時間前進 1 小時、public 模式執行者同步（sETH 5× 被跟隨者上限夾到 2×、sBTC 被交易所上限夾到 1×；執行者淨收小費；
油箱剛好扣「執行費 × 3＋小費」；跟隨者自己的 1000 USDC freeMargin 沒被動用）→ 陌生人再呼叫被 `AlreadySynced` 擋下、
領不走別人的油箱 → 第 3 版含 sAAPL、跟隨者未 KYC：整筆擋下、webhook 收到 `kyc` 通知 → KYC 後同一個執行者同步成功 →
跟隨者用 `setSyncExecutor` 指定自己的 agent（帳號 (6)）為唯一執行者：第 4 版發布後陌生人被 `NotSyncExecutor` 擋下、public 執行者
不送，跟隨者的 agent（personal 模式）同步成功 → 跟隨者關閉自動同步、交易者再發一版：agent 不送交易、webhook 收到 `new-version` 通知；
不需要任何金鑰的只通知模式（`--notify-only`）連跑兩次只通知一次 → 全額提領油箱 → 把跟隨者私鑰交給執行者時，personal 與 public 模式都
拒絕啟動，私鑰誤貼進 `--followers` 被拒且不顯示 → 由 agent 發起跟單：MCP 工具 `prepare_copy_follow_tx` 只產生未簽名交易
（approve 剛好金額＋`followTraderAtVersionWithAutoSync`），第二位跟隨者用自己的錢包依序簽名，紀錄釘在最新版、自動同步設定與油箱
都與預覽相同 → 所有日誌都沒有任何私鑰。最後一行是「全部斷言通過」，Anvil 自動關閉。
它也會核對前端 `addresses.ts` 的 ANVIL 區塊與 `DeployLocalDemo` 的位址一致。下面是配合前端的手動版。

### 準備（約 5 分鐘）

```bash
export PATH="$HOME/.foundry/bin:$PATH"
# 1. 用含自動同步的原始碼重建本機鏈（DeployLocalDemo 部署的就是新版 CopyTracker；
#    小規模排程一兩分鐘跑完，writeAddresses.ts 會更新 addresses.ts 的 ANVIL 區塊）
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
# 2. 載入鏈狀態、持續寫入價格（另一個終端機，保持開著）
scripts/heroes-demo.sh
# 3. 前端（另一個終端機）
cd frontend && yarn dev --mode heroes
```

角色（都是公開的 Anvil 測試金鑰，只能用在本機鏈）：

| 角色 | 帳號 | 取得私鑰 |
|---|---|---|
| 跟隨者（瀏覽器錢包） | Anvil 預設帳號 (9) | `cast wallet private-key "test test test test test test test test test test test junk" 9` |
| 交易者 Whale Alpha | 助記詞 index 10（小規模排程裡的交易者，已質押、已發布過策略） | 同上，最後的 `9` 換成 `10` |
| 執行者（copy-sync agent） | Anvil 預設帳號 (8)，只當付 gas 的熱錢包 | 同上，換成 `8` |
| KYC 審核者 | Anvil 預設帳號 (0)（本機部署者） | 同上，換成 `0` |

```bash
RPC=http://127.0.0.1:8545
MNEMONIC="test test test test test test test test test test test junk"
A=heroes/out/addresses.json
REG=$(jq -r .StrategyRegistry $A); CT=$(jq -r .CopyTracker $A); KYC=$(jq -r .KYCRegistry $A)
TRADER_PK=$(cast wallet private-key "$MNEMONIC" 10)
FOLLOWER=$(cast wallet address --private-key $(cast wallet private-key "$MNEMONIC" 9))
```

錢包若之前連過本機鏈，先清掉帳號 (9) 的活動紀錄（nonce 快取）。

### 步驟

1. **跟單並開啟自動同步（跟隨者，1 分鐘）**。Expert Mode → `/marketplace` → Whale Alpha → 跟單。
   在 `/copy/<交易者>` 勾選「自動同步」，設定最大槓桿 2×、冷卻改成 1 小時（預設是最保守的 24 小時；1 小時是合約允許的最短冷卻，
   展示用）、執行者小費 0.0001 ETH、油箱預存 0.01 ETH；畫面顯示「約可同步 N 次」。指出揭露文字：「開啟後，任何人都能在交易者發布
   新版時把你的部位調成鏈上最新版；他們不能選資產、方向或槓桿；你可以隨時關閉、提領油箱」，以及下面那一段成本：每次同步全平再開、
   各付一次交易費，獲利的部位先結算 10% 績效費，同步時間點由交易者與執行者決定。「只讓這個地址代為同步」先留空（步驟 7 再示範）。送出——`followTraderAtVersionWithAutoSync` 一筆完成
   （最後一個參數是畫面上顯示的每檔執行費，作為你同意的上限：交易所在你送出前調高費率，這筆會整筆退回）。
   讀回：
   ```bash
   cast call $CT "syncConfig(address,uint256)(bool,uint8,uint32,uint96)" $FOLLOWER 0 --rpc-url $RPC   # true, 2, 3600, 1e14
   cast call $CT "syncExecFeeCap(address,uint256)(uint256)" $FOLLOWER 0 --rpc-url $RPC   # 你同意的每腿執行費（≤ 你簽名帶入的上限）
   cast call $CT "syncGasBalance(address)(uint256)" $FOLLOWER --rpc-url $RPC
   ```
   （跟隨者若已有其他跟單紀錄，把 `0` 換成這一筆的索引，Portfolio 的跟單列表看得到順序。）
2. **陌生人亂按沒有用（30 秒）**。交易者還沒發新版，任何人呼叫都 revert：
   ```bash
   cast call $CT "resyncFor(address,uint256)" $FOLLOWER 0 --rpc-url $RPC \
     --from $(cast wallet address --private-key $(cast wallet private-key "$MNEMONIC" 8))   # revert AlreadySynced
   ```
3. **交易者發布新版（30 秒）**。策略至少三檔、單檔不超過 50%：改成 sETH 多 50%（5 倍）、sBTC 多 30%（2 倍）、sGOLD 空 20%（1 倍）：
   ```bash
   cast send $REG "publishStrategy((bytes32,uint256,bool,uint256)[])" \
     "[($(cast keccak sETH),5000,true,5),($(cast keccak sBTC),3000,true,2),($(cast keccak sGOLD),2000,false,1)]" \
     --private-key $TRADER_PK --rpc-url $RPC
   ```
   Portfolio 的「同步」欄顯示「第 N 版／最新第 N+1 版」與「冷卻中，… 之後可以同步」：別人替你同步之間至少隔你設定的冷卻
   （合約下限 1 小時，擋交易者在同一個區塊反覆發版、自己同步來磨你的手續費）。本機鏈直接把時間往前推 1 小時：
   ```bash
   cast rpc evm_increaseTime 3601 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC
   ```
4. **執行者同步（1 分鐘）**。啟動 `agent/copy-sync`（public 模式；明文私鑰只因為這是本機 Anvil 才被允許，公開鏈要用加密
   keystore），先 `--dry-run` 看它找到這筆待同步紀錄與模擬結果，再拿掉 `--dry-run` 跑一輪：
   ```bash
   cd agent
   export COPY_SYNC_RPC_URL=$RPC
   export COPY_SYNC_PRIVATE_KEY=$(cast wallet private-key "$MNEMONIC" 8)   # 執行者 (8)：只付 gas 的熱錢包
   npm run copy-sync -- --once --dry-run --tracker $CT --from-block 0   # 「[dry-run] 模擬成功：vN → vN+1（versionId …）」
   npm run copy-sync -- --once --tracker $CT --from-block 0             # 「✓ 已同步 vN → vN+1（versionId …）：3 條腿…」
   ```
   日誌的版本號與 Portfolio 一致從 1 起算，括號裡是合約的 versionId。Portfolio 的部位換成新版三檔，**sETH 的槓桿是 2× 不是 5×**（跟隨者的上限），sBTC 是 1×（高碳資產的
   交易所上限）——三者取小；同步次數 1；油箱少了「執行費 × 3 條腿＋小費」，小費進了執行者帳號 (8)。鏈上動態牆出現 `Resynced`。
5. **RWA 的原子性（選用，1–2 分鐘）**。回放時展示帳號 (9) 已經 KYC 過，先撤銷它來模擬「還沒 KYC 的跟隨者」，
   再讓交易者發一版含 sAAPL（標記為 RWA，需要 KYC）的策略：
   ```bash
   ADMIN_PK=$(cast wallet private-key "$MNEMONIC" 0)
   cast send $KYC "revokeKYC(address)" $FOLLOWER --private-key $ADMIN_PK --rpc-url $RPC
   cast send $REG "publishStrategy((bytes32,uint256,bool,uint256)[])" \
     "[($(cast keccak sETH),4000,true,1),($(cast keccak sBTC),3000,true,1),($(cast keccak sAAPL),3000,true,1)]" \
     --private-key $TRADER_PK --rpc-url $RPC
   cast rpc evm_increaseTime 3601 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC   # 距上次同步滿 1 小時
   ```
   執行者這一輪模擬就失敗、不送交易，日誌寫出被擋的原因（KYC）；部位維持上一版，一條腿都沒有動。恢復 KYC 之後下一輪同步成功
   （`approveKYC` 只收待審的申請，撤銷後要重新 `submitKYC`；展示時直接用 owner 的 `batchVerify`）：
   ```bash
   cast send $KYC "batchVerify(address[])" "[$FOLLOWER]" --private-key $ADMIN_PK --rpc-url $RPC
   ```
   （sAAPL 若因休市被 keeper 切成 ReduceOnly，同樣是整筆擋下、開市後重試；本機的 `priceTick.ts` 不切換市場模式。）
6. **跟隨者隨時收回控制（30 秒）**。Portfolio 上關閉自動同步、提領油箱；也可以按「立即同步」自己同步（不付小費）。
   「立即同步」先跳出確認視窗：新版每一檔的資產、方向、比重、槓桿（新版 → 實際，被上限夾住的會標出來；沒設上限時明白警告）、
   要從油箱扣的 ETH 執行費、預計釋出的保證金、獲利部位的績效費與依新版開倉的交易費。按「確認同步」才送出 `resyncAtVersion`，
   釘住**視窗裡那一版**與畫面上的執行費：交易者在你按下之前又發一版，這筆會整筆退回（`StrategyVersionMismatch`），不會換成你沒看過的
   版本；交易所在你按下之前調高執行費也一樣（`ExecutionFeeAboveCap`，油箱不動）。Simple Mode 不提供「立即同步」（它會依新版開新部位），
   狀態欄提示切到專家模式檢視後再同步；跟單頁在 Simple Mode 也不給自動同步的勾選框，只說明要到專家模式開啟。關閉後再發新版，執行者的 `resyncFor` 會被拒。
7. **只讓自己的 agent 同步（選用，1–2 分鐘）**。Portfolio →「設定」→「只讓這個地址代為同步」填 Anvil 帳號 (6) 的地址
   （跟隨者自己 agent 的熱錢包，不是主錢包）→ 儲存（`setSyncExecutor`，自動同步要開著）。交易者再發一版、時間前進 1 小時後：
   ```bash
   AGENT_PK=$(cast wallet private-key "$MNEMONIC" 6)
   cast call $CT "syncExecutor(address,uint256)(address)" $FOLLOWER 0 --rpc-url $RPC        # 帳號 (6)
   cast call $CT "resyncFor(address,uint256)" $FOLLOWER 0 --rpc-url $RPC \
     --from $(cast wallet address --private-key $(cast wallet private-key "$MNEMONIC" 7))     # revert NotSyncExecutor
   cd agent
   npm run copy-sync -- --once --tracker $CT --from-block 0                                    # public 執行者 (8)：停止追蹤，不送
   COPY_SYNC_PRIVATE_KEY=$AGENT_PK npm run copy-sync -- --once --tracker $CT --from-block 0 \
     --mode personal --followers $FOLLOWER --state-file /tmp/copy-sync-personal.json          # 跟隨者的 agent：同步成功
   ```
   Portfolio 的同步欄出現「限定執行者 0x976E…0aa9」。再到「設定」關閉自動同步、讓交易者再發一版，同一個 personal agent 跑一輪只送出
   `new-version` 通知（加 `--notify-webhook` 可以看到 JSON），不送交易——等你自己按「立即同步」。
   這時切到 Portfolio 以外的任何頁面（例如 `/marketplace`），頂端出現提醒：「交易者發布了新版策略：你有 1 筆還停在舊版。其中 1 筆
   要你處理（沒有開啟自動同步）」——沒有跑 agent 的人也會知道。完全沒有執行者熱錢包、只想收推播，用不讀任何金鑰的只通知模式：
   ```bash
   npm run copy-sync -- --once --notify-only --followers $FOLLOWER --tracker $CT --from-block 0 \
     --state-file /tmp/copy-sync-notify.json --notify-webhook http://127.0.0.1:<你的 webhook 埠>/hook    # 再跑一次不會重複通知
   ```
8. **讓 agent 替你準備跟單（選用，1 分鐘）**。agent 只產生未簽名交易，你的錢包簽：MCP 工具 `prepare_copy_follow_tx`
   （`{ follower, trader, amountUsdc: "500", autoSync: true, maxLeverage: 2 }`）回傳 approve（剛好金額）與
   `followTraderAtVersionWithAutoSync` 兩筆 `to`／`data`／`value`、各腿預覽（實際槓桿三者取小）、費用與 KYC 檢查；授權足夠後再呼叫一次
   只剩一筆、附 eth_call 模擬結果。`scripts/demo-autosync.sh` 第 10 步就是這個流程（第二位跟隨者用 `cast send` 原樣簽名送出）。
   開啟自動同步一定要跟隨者自己給槓桿上限，agent 不替你決定。

### 要強調的點

| 問題 | 回答 |
|---|---|
| 平台拿到我的私鑰了嗎？ | 沒有。跟隨者只用自己的錢包簽了跟單與油箱兩種交易；執行者用的是自己的熱錢包 |
| 執行者可以亂調我的部位嗎？ | 不行。`resyncFor` 沒有任何內容參數，只能調成交易者鏈上最新版，而且受你設定的槓桿上限與冷卻限制 |
| 執行者金鑰被偷了會怎樣？ | 最壞是有人觸發合約本來就允許的同步，沒有任何跟隨者資金風險 |
| 交易者能一直發版、磨掉我的手續費嗎？ | 別人替你同步至少隔你設定的冷卻，合約下限 1 小時：同一個區塊反覆發版、自己同步，只會成功一次。冷卻限制的是頻率，不是每一輪的金額；看到交易者異常頻繁發版就關閉自動同步（KNOWN_LIMITATIONS #41） |
| 平台調高執行費，會把我的油箱扣光嗎？ | 不會。別人代為同步時只能按你開啟自動同步時同意的費率扣；費率被調高，代為同步就暫停，直到你重新儲存設定同意新費率 |
| 交易者能靠一直改版洗掉虧損嗎？ | 不能。每次同步平掉的腿都累計計分，取消跟單時一起算 |
| 沒有人執行怎麼辦？ | 部位停在舊版，畫面顯示落後幾版，本人按「立即同步」即可（見 KNOWN_LIMITATIONS #40） |
| 我沒跑 agent，怎麼知道交易者改版了？ | 網頁任何內頁頂端會提醒落後的紀錄，並指出要你處理的原因（沒開自動同步、油箱不足、執行費被調高）；想收推播就跑不需要金鑰的 `copy-sync --notify-only` |
| agent 能替我跟單嗎？ | 能準備、不能簽：`prepare_copy_follow_tx` 產生 approve＋釘版本跟單的未簽名交易與預覽，由你的錢包簽；agent 從頭到尾拿不到你的私鑰 |
| 我按「立即同步」的同時交易者又發了新版呢？ | 確認視窗列出你要同步到的那一版的每一檔與費用；送出時釘住這一版（`resyncAtVersion`），版本不符整筆退回、部位不動；重新打開視窗看過新版再按 |
| 我不想讓平台或陌生人挑時機同步，只信自己的 agent？ | 在「設定」指定自己 agent 的熱錢包為唯一執行者（`setSyncExecutor`）：除了你本人，只有它能同步，其他人被合約拒絕；agent 的金鑰外洩也只能觸發合約本來就允許的同步 |
| 每次同步要付多少？ | ETH：執行費 × 新版檔數（加上給別人的小費）。USDC：全平再開、各付一次交易費（例如 5 倍、0.10% 約保證金的 1%），獲利部位先付 10% 績效費。冷卻預設 24 小時，越短交易者能讓你付的越多 |
| 我用的是不能收 ETH 的合約錢包，油箱領得出來嗎？ | 可以。`withdrawSyncGasTo` 把你自己的油箱領到你指定的地址，別人無法用它動你的油箱 |

---

## 5-Minute Walkthrough · 五分鐘展示腳本

> **Prerequisites 前置條件**
> - Anvil running: `anvil` (terminal 1)
> - Deploy + Seed: `bash deploy-anvil.sh && bash seed-anvil.sh` (terminal 2)
> - Frontend: `cd frontend && npm run dev` (terminal 3)
> - MetaMask: import **two** Anvil accounts
>   - Account A (Trader / oracle owner): `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
>   - Account B (Follower): `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`
> - MetaMask network: Anvil Local (chainId 31337, RPC http://localhost:8545)
>
> **Note:** `seed-anvil.sh` pre-creates **Demo Alpha** (Account A) and **Demo Beta** (Account B) with strategies already published — you can skip Steps 1–4 and jump straight to Step 2 to experience copy-trading immediately.

---

## Step 1 — Trader registers & publishes strategy (1 min)

**Switch to Account A in MetaMask**

1. Open `http://localhost:5173` → Click **Connect Wallet**
2. Nav → **Trader**
3. **A. Register Trader**
   - Enter name: `AlphaTrader`
   - Click **Register** → confirm tx → toast ✓

4. **B. Publish Strategy** — click "+ Add Asset" three times:

| Asset | Direction | Leverage | Weight |
|-------|-----------|----------|--------|
| sBTC  | Long ↑    | 2×       | 50     |
| sETH  | Short ↓   | 1×       | 30     |
| sAAPL | Long ↑    | 1×       | 20     |

   - Progress bar shows **100.00%** (green)
   - Click **Publish Strategy** → confirm → toast ✓

5. **C. Strategy History** — expand `v0` to verify allocations

---

## Step 2 — Follower copies the strategy (1.5 min)

**Switch to Account B in MetaMask**

6. Reconnect wallet (Header → Disconnect → Connect Wallet → select Account B)
7. Nav → **Exchange**
8. **Faucet** → Click **Get 1 000 mUSDC** → wait for tx ✓
9. Nav → **Marketplace**
   - See `AlphaTrader` in the table
   - Click **Copy** → taken to `/copy/<trader-address>`

10. On **CopyPage**:
    - Verify strategy badges: `↑ sBTC 50% 2×`, `↓ sETH 30% 1×`, `↑ sAAPL 20% 1×`
    - Total margin: `1000` mUSDC (default)
    - Preview shows margin split: BTC 500, ETH 300, AAPL 200
    - **Step 1**: Click **Approve mUSDC** → confirm → `✓ Approved`
    - **Step 2**: Click **Follow Trader** → confirm → redirected to **Portfolio**

---

## Step 3 — View portfolio (30 sec)

11. **Portfolio** page loads automatically:
    - **A. Copy Positions**: 1 active record, `AlphaTrader`, initial = 1 000 mUSDC
    - **B. Open Positions**: 3 rows (sBTC long, sETH short, sAAPL long)
      - All PnL = ±0 (just opened at current oracle prices)
    - **D. Performance chart**: flat line (Initial ≈ Current)

---

## Step 4 — Admin updates oracle prices (1 min)

**Switch back to Account A** (oracle owner)

12. Nav → **Admin** (append `/admin/oracle` manually or add to nav)
13. Update prices to simulate market movement:

| Asset | New Price | Change |
|-------|-----------|--------|
| sBTC  | 55000     | +10%   |
| sETH  | 2700      | −10%   |
| sAAPL | 210       | +5%    |

    - For each row: type new price → **Update Price** → confirm → ✓

---

## Step 5 — Observe PnL change (30 sec)

**Switch back to Account B**

14. Nav → **Portfolio** → Click **↺ Refresh**
15. **B. Open Positions** PnL column:
    - sBTC LONG: **+green** (+10% price × 2× lev × 500 margin = **+100 USDC**)
    - sETH SHORT: **+green** (price fell 10% × 1× lev × 300 margin = **+30 USDC**)
    - sAAPL LONG: **+green** (+5% × 1× × 200 = **+10 USDC**)
    - **Total unrealized PnL ≈ +140 USDC** (+14% on 1 000 USDC)
16. **D. Performance chart**: line rises above initial reference (yellow dashed)

---

## Step 6 — Unfollow & close all positions (30 sec)

17. **A. Copy Positions** → Click **Unfollow** next to AlphaTrader
    - Confirms tx → `unfollowAndCloseAll` closes all 3 positions
    - PnL realized, margin + profit returned to freeMargin
18. **C. Free Margin** shows ≈ **1 140 mUSDC** (initial 1 000 + 140 profit)
    - Click **Withdraw** to retrieve funds

---

## Key Talking Points 核心說明要點

| Topic | Detail |
|-------|--------|
| 合成衍生品 | 無實際資產，以 USDC 保證金模擬 CFD 損益 |
| 跟單機制 | 一鍵複製交易者策略，按配置比例自動開倉 |
| 價格預言機 | MockOracle，生產版可接 Chainlink / Pyth |
| 槓桿 | 1× / 2× / 5×，最大 5× |
| 策略版本 | 每次發布產生新版本，跟單鎖定當時版本 |
| 平倉 | Unfollow 一鍵關閉所有跟單倉位 |
| Gas | Anvil 免費；Sepolia 需少量 test ETH |

---

## Sepolia Demo (if deployed)

Replace step 1–6 with Sepolia network in MetaMask.

```bash
bash deploy-sepolia.sh   # deploys + writes addresses.ts SEPOLIA block
bash seed-sepolia.sh     # creates Demo Alpha trader on Sepolia
git push                 # Vercel redeploys automatically
```

All contract addresses are written to `frontend/src/contracts/addresses.ts` by the deploy script.

---

*Research prototype · Capstone project 2026*
