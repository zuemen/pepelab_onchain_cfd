---
status: accepted（原始碼；Base Sepolia 尚未部署，部署步驟見 OWNER_ACTIONS 第 8 步）
date: 2026-10-26
supersedes: "ADR-023 決定第 5 點的「不做持續跟單」（自動停損仍維持不做）"
---

# 跟單自動同步：跟隨者在鏈上同意一次，之後任何人都能、也只能把部位調成交易者鏈上最新版

[ADR-023](./ADR-023-web3-etoro-positioning.md) 把跟單定為快照式：`CopyTracker` 在跟單當下讀交易者最新一版策略、
依比例開倉一次；交易者之後發布新版（`StrategyRegistry.publishStrategy` → `StrategyPublished`），跟隨者的部位不會跟著變，
Portfolio 只標「策略已更新」（#309）。評審回饋要求跟單要即時更新，這也是 eToro 的 CopyTrader 最核心的行為。

當時否決持續跟單的理由是：「要讓某個合約在使用者不在場時替他開新部位」會擴大代理合約的權限，或者讓營運方成為下單者，
兩者都與「使用者自管」衝突。本 ADR 的做法讓這兩件事都不必發生：**權限仍然只在跟隨者自己的同意與合約規則裡，
營運方不持有任何人的私鑰，也不替任何人做決定。**

## 決定

1. **跟隨者在鏈上同意「自動同步」。** `CopyTracker.setAutoSync(recordIdx, enabled, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg)`
   只有那筆跟單紀錄的跟隨者本人（`msg.sender`）能呼叫，紀錄必須仍在跟隨中。同意的範圍逐筆記錄：
   - `maxLeverage`（1–5）：同步時槓桿的上限；
   - `minSyncInterval`：兩次由別人執行的同步之間至少隔多久（秒；開啟時不得低於合約下限 `MIN_SYNC_INTERVAL` = 1 小時；
     本人手動同步不受限）；
   - `tipWei`：每次由別人代為執行時付給執行者的小費，上限 `MAX_TIP_WEI`（0.001 ETH）；
   - `maxExecFeePerLeg`：跟隨者**簽名帶入**的每條腿執行費上限（前端帶入畫面上顯示的 `executionFee`）。交易所現行費率高於它，
     這筆交易整筆 revert `ExecutionFeeAboveCap`、設定維持原狀；成功時記下現行費率（≤ 簽名值）為 `syncExecFeeCap`，
     是油箱代付執行費的同意上限。交易所 owner 之後調高費率，別人就不能代為同步，直到跟隨者看過新費率、帶入新上限再呼叫一次
     `setAutoSync`。同意值來自跟隨者的交易參數，不是執行當下從交易所讀到的費率：owner 在同一個區塊搶先調高費率，
     只會讓跟隨者那筆交易失敗，不會被記成同意值（第一版取執行當下的費率當同意值，審查實測可被搶先交易利用，見「營運方仍保有的權限」）。
     關閉自動同步不看費率，永遠可以成功。
   一筆交易完成跟單＋開啟自動同步：`followTraderAtVersionWithAutoSync(trader, totalMargin, expectedVersion, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg)`，
   交易所現行費率高於 `maxExecFeePerLeg` 就整筆 revert `ExecutionFeeAboveCap`；否則 `msg.value` 先付開倉的執行費，剩下存進油箱，
   不夠付開倉執行費 revert `InsufficientExecutionFee`。
   `maxLeverage` 也套用在這次開倉，預覽用 `previewCopyAllocationWithCap(trader, totalMargin, maxLeverage)`
   （與上鏈的緩衝、實際投入保證金、各腿份額一致；`previewCopyAllocation` 不另設上限）。
2. **同步無需許可。** `resyncFor(follower, recordIdx)` 任何人都能呼叫——跟隨者自己的 agent、平台的 keeper、第三方 bot 都可以。
   但它**只能**把那筆紀錄調成交易者鏈上的最新版：資產、方向、權重、槓桿全部從 `registry.getLatestStrategy(trader)` 讀，
   呼叫者沒有任何參數可以選。跟隨者可以用 `setSyncExecutor(recordIdx, executor)` 把「任何人」收窄成**一個指定的地址**
   （例如自己 agent 的熱錢包）：之後除了本人，只有那個地址能呼叫，其他人 revert `NotSyncExecutor`；`executor` = 0 解除。
   它只收窄「誰能按」——自動同步仍要開啟，冷卻、小費、執行費上限照舊；開關自動同步不會清掉它，跟單結束時清除。
   跟隨者本人可以隨時手動同步（不必開啟自動同步、不受冷卻限制，也不付小費）；
   本人從介面同步走 `resyncAtVersion(recordIdx, expectedVersion, maxExecFeePerLeg)`：最新版必須仍是畫面上那一版，否則 revert
   `StrategyVersionMismatch`（M10 在同步路徑上的對應——沒開自動同步的跟隨者只同意他看過的版本，交易者在他按下之前
   發的新版不會被直接採用）。「看過」指的是內容，不只是版號：Portfolio 的「立即同步」先開確認視窗，讀交易者最新版，
   列出每一檔的資產、方向、比重、實際槓桿（三者取小，沒設上限時明白警告）、要付的 ETH 執行費與預估的 USDC 交易費、績效費，
   按下確認才以**視窗裡那一版**的 versionId 送出；Simple Mode 不提供立即同步（它會依新版開新部位，是交易桌的入口），
   要切到專家模式檢視後再同步。開啟自動同步也一樣只在專家模式：跟單頁與投資組合在 Simple Mode 都只說明要到專家模式開啟、
   不給勾選框與設定（設定含槓桿上限），已開啟的仍可在 Simple Mode 直接關閉（退出不藏）；交易所現行費率必須不高於畫面上顯示的 `maxExecFeePerLeg`，否則 revert `ExecutionFeeAboveCap`、
   油箱不動。本人經 `resyncFor` 同步時，從油箱扣款同樣受 `syncExecFeeCap` 約束；附帶的 `msg.value` 付得清全部成本則不受此限
   （付款的是這筆交易看得到的 ETH，油箱既有餘額不會被動用）。第三方路徑不釘版本：開啟自動同步就是同意「交易者鏈上最新版」。
   `resyncFor`／`resyncAtVersion` 收到的 `msg.value` 一律先存進該跟隨者的油箱（任何人都能替他加油，但不能取走）。
3. **油箱是跟隨者自己的 ETH。** `depositSyncGas()`／`withdrawSyncGas(amount)`：每次同步的執行費與小費從
   `syncGasBalance[follower]` 扣；跟隨者隨時可以提領，只有本人能提領自己的油箱。取消跟單會一併關掉那一筆的自動同步，
   但不會自動退油箱（油箱以跟隨者為單位，不屬於某一筆紀錄）。不能收 ETH 的合約錢包（沒有 receive 的多簽、AA 錢包、
   EIP-7702 委派）用 `withdrawSyncGasTo(to, amount)` 領到別的地址——一樣只扣呼叫者自己的餘額，不會開放代領。
4. **同步是原子的。** 新版的任何一條腿開不起來，整筆 revert，部位維持舊版，執行者之後再試。不做部分同步。
5. **只重新部署這次平倉釋出的保證金**，絕不動用跟隨者在交易所裡的其他可用保證金。
6. **交易者不能靠改版洗掉虧損。** 每次同步平掉的腿的實現損益跨版本累加，取消跟單時以「累計值＋目前的腿」判斷是否罰沒；
   計分基準固定在第一次同步時的基準，換版不能把基準灌大來稀釋虧損比例。
7. **自動停損仍然不做。** 理由與 ADR-023 相同：停損要有人在價格到達時替使用者平倉，平倉的時機是裁量，不是可驗證的規則。

## 權限模型：誰能做什麼

| 角色 | 能做 | 不能做 | 由誰強制 |
|---|---|---|---|
| 跟隨者 | 開關自動同步、改上限／冷卻／小費（同時簽名帶入執行費上限）；指定或解除唯一的執行者（`setSyncExecutor`）；存入與提領自己的油箱（可指定收款地址）；隨時手動同步（不付小費、不受冷卻限制；`resyncAtVersion` 釘住看過的版本與執行費）；取消跟單（`unfollowAndCloseAll`）或放棄計分（`deactivateWithoutScoring`）；在交易所直接平掉自己的任何一條腿 | — | 合約（`msg.sender` 必須是紀錄的跟隨者） |
| 執行者（任何人；跟隨者指定了執行者時只有那個地址） | 在「跟隨者已開啟自動同步、沒有指定別人、交易者有比紀錄更新的版本、冷卻已過、執行費不高於跟隨者同意的費率、油箱夠付」時呼叫 `resyncFor`，收取跟隨者設定的小費 | 選資產、方向、權重、槓桿或金額；同步到不是最新的版本；對同一版本重複同步（`AlreadySynced`）；動用跟隨者的其他保證金；碰油箱裡超過「本次成本」的 ETH；提領任何人的油箱 | 合約 |
| 交易者 | 發布新版策略，決定同步的目標與（間接的）時機 | 動用跟隨者的保證金；超過跟隨者設定的槓桿上限；在冷卻期內讓跟隨者再同步一次（冷卻至少 1 小時，同一區塊反覆發版＋自己同步只會成功一次）；靠改版把已實現的虧損從計分裡洗掉；資格失效（申請取回質押或被罰到低於門檻）後還讓跟隨者同步到新版 | 合約（`isEligibleTrader`、冷卻與其下限、累計計分） |
| 平台營運方 | 跑一個公開執行者賺小費（與任何第三方同等地位）；見下方「營運方仍保有的權限」 | 替任何人簽名；選擇同步內容；提領任何人的油箱；調高（包括搶先交易調高）執行費後按新費率扣跟隨者的油箱或預存的 ETH——每一條扣油箱的路徑都以跟隨者簽名帶入的每腿上限為準，現行費率較高就整筆 revert `ExecutionFeeAboveCap` | 合約；營運方不持有任何使用者私鑰 |

### 為什麼無需許可是安全的

與清算同一個邏輯：`liquidatePosition` 沒有呼叫者限制，因為「該不該清算、清算成什麼樣子」完全由合約狀態決定，
呼叫者只是付 gas 讓它發生。`resyncFor` 也是如此——呼叫者唯一的自由度是**在哪一個區塊**執行，而且只在下列條件全部成立時才有這個自由度：

- 跟隨者已在鏈上開啟自動同步（呼叫者不是跟隨者本人時）；跟隨者指定了執行者時，呼叫者必須是那個地址；
- 交易者鏈上最新版本號大於紀錄的版本號；同步完成後兩者相等，同一個版本不能被同步第二次；
- 交易者仍有資格（`registry.isEligibleTrader`）；
- 距上次同步（從未同步則為跟單當下）已超過跟隨者設定的 `minSyncInterval`，而它不得低於 1 小時（只限制別人，本人手動同步不受限）；
- 交易所現行的 `executionFee` 不高於跟隨者簽名同意的費率（`syncExecFeeCap`；本人經 `resyncFor` 同步、附帶的 ETH 付得清全部成本時例外，
  本人經 `resyncAtVersion` 同步時改用該筆交易帶入的上限）；
- 油箱夠付本次成本。

所以跟隨者不需要信任執行者，也不需要知道執行者是誰。陌生人亂按只會 revert（`AlreadySynced` 或其他條件不成立），
不會改變任何狀態；執行者金鑰外洩，最壞情況也只是有人觸發「合約本來就允許的同步」。

**殘餘的時機選擇權**照實寫出：新版發布、冷卻期滿之後，執行者可以挑區塊，例如等到價格對跟隨者不利的那一刻才送。
跟隨者同意的本來就是「新版一出、任何時間都可能被同步」，而且價格來自交易所的 oracle，不是執行者能決定的。
在意時機的跟隨者有兩條路，都由合約強制：

- **只讓自己的 agent 執行**：開啟自動同步，再用 `setSyncExecutor` 指定 agent 的熱錢包。其他人（含平台的 public 執行者）一律 revert
  `NotSyncExecutor`，挑時機的空間回到跟隨者自己手上。agent 對合約來說仍是「別人」（執行者程式拒絕用跟隨者主錢包的私鑰啟動），
  所以自動同步要開著、冷卻照樣適用。從跟單到送出 `setSyncExecutor` 之間不會被搶先：冷卻從跟單當下起算、至少 1 小時。
- **不開自動同步**：沒有任何別人能同步。personal 模式的執行者照樣追蹤這筆跟單，交易者每發一版就通知本人一次（`new-version`），
  本人看過新版內容後手動同步。

兩條路都改不了的是交易者何時發版——見下方「經濟」與 KNOWN_LIMITATIONS #41。

## 一次同步做了什麼

1. 檢查上面的條件（`AutoSyncDisabled`、`AlreadySynced`、`TraderNotEligible`、`SyncCooldown`、`ExecutionFeeAboveCap`）；附帶的 `msg.value` 先存進油箱；
   成本＝`exchange.executionFee()` × 新版的腿數＋（呼叫者不是跟隨者時的）`tipWei`，從油箱扣，不足 revert `InsufficientSyncGas`。
2. 平掉紀錄裡所有仍開著的腿（`exchange.closePositionFor`；平不掉就整筆 revert `PositionStillOpen`，例如交易所暫停或該資產 Halted）。
   已被清算或自動減倉（ADL）的腿照 `unfollowAndCloseAll` 的規則計分；被跟隨者自己平掉的腿（`CloseReason.Owner`）
   不計分，並把 `followerClosed` 設為 true（黏著旗標，之後不會消失）。
3. 以 `exchange.freeMargin(follower)` 在平倉前後的差額，算出這次釋出的保證金；只拿這筆重新部署。平倉過程若連帶動到跟隨者的
   其他部位（例如壞帳觸發 ADL），差額就混進了別的錢，整筆 revert `SyncDisturbedOtherPositions`；釋出 0（所有腿都已被清算）
   revert `NothingToRedeploy`——這時跟隨者應取消跟單。
4. 每條新腿的槓桿＝min（策略槓桿、`exchange.maxLeverageForAsset(asset)`、跟隨者的 `maxLeverage`）；手續費緩衝用夾過的槓桿計算。
   `_follow` 也套用同樣的「策略槓桿 vs 資產上限」夾值：以前高碳資產配 5 倍槓桿時整筆跟單 revert。
5. 以 `exchange.openPositionFor{value: executionFee}(follower, asset, isLong, portion, lev, trader)` 開新腿，`copiedFrom` 仍是交易者
   （績效費照舊）；任何一條開不起來整筆 revert。
6. 更新紀錄：`positionIds` 換成新腿、`versionId` 換成最新版、`deployedAmount` 更新；`SyncState` 記下同步時間與次數。
7. 最後（checks-effects-interactions）把小費付給 `msg.sender`，發出
   `Resynced(follower, recordIdx, trader, fromVersion, toVersion, executor, redeployedMargin, legs)`。

新狀態放在獨立的 mapping（`syncConfig`、`syncState`、`syncGasBalance`），`CopyRecord` 結構與 `getCopyRecords` 的 ABI 不變，
既有讀取端（前端、`PepeIncentives`、回放分析）不必改。合約不變量：`address(this).balance >= totalSyncGas`（Σ 所有油箱）。

## 計分：交易者不能靠改版洗掉虧損

快照式跟單只在取消時看一次目前的腿。有了同步之後，若每次同步都把舊腿「平掉就算了」，交易者只要在虧損時發一版新策略，
虧損就從計分裡消失。因此：

- 每次同步平掉的每條計分腿的 `_scoredLegPnl`（每條腿虧損以保證金為下限、ADL 用扣減前的損益）累加進 `SyncState.scoredRealized`；
- 計分基準 `SyncState.scoredBasis` 取**第一次同步**時平掉的計分腿的保證金合計，之後不再增加。同一筆錢每次同步都會被重新部署，
  若每輪都把保證金加進基準，交易者換幾次版就能把基準灌大好幾倍，虧損比例被稀釋到永遠碰不到門檻；
- 取消跟單（`unfollowAndCloseAll`）時，有同步過的紀錄以「第一輪基準」對「累計損益＋目前這輪的腿」判斷是否達到 30% 的罰沒門檻；
- `followerClosed` 黏著旗標成立時照舊整筆不計分（跟隨者自己挑過哪些腿要平，計分就不公平）。

## 經濟：油箱、小費、冷卻

- **每次同步的 ETH 成本**＝`executionFee` × 新版腿數＋小費。Base Sepolia 現行交易所的 `executionFee` 是 0.0001 ETH
  （2026-10-26 唯讀讀回），三條腿、小費 0.0001 ETH 時每次 0.0004 ETH，0.01 ETH 的油箱約可同步 25 次。
  前端以 `executionFee` 與策略腿數估算「可同步幾次」。
- **USDC 成本**：同步是「全部平倉、再依新版開倉」，每條腿一出一進各收一次交易費（費率依資產碳分級，0.10%–1.00%），
  平倉時另結借款費與資金費；獲利的腿照舊付 10% 績效費給交易者（`PERFORMANCE_FEE_BPS`）。跟單費（0.3%）只在開始跟單時收一次，
  同步不再收。
- **小費**由跟隨者自己設定（0–0.001 ETH），只付給「不是跟隨者本人」的執行者；設 0 代表只靠自己的 agent、平台 keeper
  或願意免費執行的人。
- **冷卻**（`minSyncInterval`，合約下限 `MIN_SYNC_INTERVAL` = 1 小時）限制的是**頻率**：別人每個冷卻期最多替這筆跟單同步一次。
  沒有下限時，交易者可以在同一個區塊裡反覆「發新版 → 自己呼叫 `resyncFor`」：審查實測 25 輪、價格完全沒動，跟隨者 1,000 USDC
  的部位被交易費磨掉約 7%，小費全進交易者口袋——下限讓這種手法每小時至多一輪。
- **預設冷卻 24 小時**（前端的選項裡最長的一個；合約下限仍是 1 小時，跟隨者要更即時就自己調短）。開啟自動同步之前，跟單頁與
  Portfolio 的設定彈窗固定揭露：每次同步全平再開、各付一次交易費、獲利腿先結算 10% 績效費（沒有高水位線），以及同步時間點由
  交易者發版與執行者送出決定；冷卻欄位的說明寫明「冷卻越短，交易者能讓你付的交易費越多」。
- 冷卻**不限制每一輪的金額**。每輪「全平再開」約付掉 2 ×（份額 × 槓桿 × 交易費率）：5 倍槓桿、0.10% 費率時約為保證金的 1%，
  1 倍槓桿、1.00%（高碳）時約 2%。交易者若每個冷卻期都發一版，冷卻 1 小時一天最多 24 輪（以每輪 1% 計約為保證金的 21%），冷卻 24 小時一天 1 輪。
  另外績效費以單一部位計、沒有高水位線：交易者挑價格高點發版讓獲利腿實現（收 10% 績效費）、低點再發版讓虧損腿實現（不退費），
  價格來回之後跟隨者淨虧、交易者淨收績效費——審查實測三檔資產在 +10% 與原價之間來回 5 次、冷卻 1 小時，跟隨者 1,000 → 約 905 USDC，
  交易者收約 72 USDC 績效費；只要震盪週期比冷卻長，冷卻就擋不住。根本修法是交易所的高水位線（本案不改 PerpetualExchange）。
  跟隨者的防線：較長的冷卻、較低的槓桿上限、在動態牆／Portfolio 看到交易者異常頻繁發版就關閉自動同步（或用 `setSyncExecutor`
  只讓自己的 agent 執行、手動同步）。
  詳見 KNOWN_LIMITATIONS #41、#42。
- **執行費率**：油箱只按跟隨者簽名同意過的每腿執行費扣（第三方與本人經 `resyncFor` 用 `syncExecFeeCap`，`resyncAtVersion` 用該筆交易帶入的上限），
  見下方「營運方仍保有的權限」。

## RWA：KYC 與休市

股票、ETF、債券、黃金等 RWA 資產開倉需要跟隨者通過 KYC（`KYCRegistry.isVerified`），休市時 keeper 把資產切成 ReduceOnly，
熔斷時可能是 Halted，另外還有逐資產 OI 上限。新版只要有一條腿遇到其中任何一項，**整筆同步 revert，部位維持舊版**：

- 跟隨者未 KYC：完成 KYC 後，下一次執行就會成功；
- 休市（ReduceOnly）或 Halted：開市（keeper 切回 Active）後重試；
- OI 已滿：等其他人平倉後重試。

執行者 agent 會定期重掃「交易者有新版、紀錄還沒同步」的紀錄：先讀 `syncConfig`／`syncExecutor`（沒開自動同步或指定了別人就不送）、
交易者最新版（`getStrategyCount`）與 `syncReadyAt`（冷卻中不模擬），再以 `eth_call` 模擬 `resyncFor`，會成功才送交易，revert 時
解碼原因記錄並（可選）通知跟隨者。它不先呼叫 `pendingSync`：`pendingSync` 只看 tracker 與 registry 的條件（外加以 `deployedAmount`
估算的 `MIN_MARGIN` 預判），交易所端的 KYC、市場模式、OI 上限本來就要靠模擬才知道，模擬一次就涵蓋全部；`pendingSync` 留給前端與
其他整合做唯讀預判（例如 MCP 的 `copy_sync_status`）。部分同步被刻意排除：一半新版、一半舊版的組合不是交易者發布過的任何一版策略，
交易者的績效與跟隨者的部位會從此對不上。

## 金鑰模型

- **跟隨者的私鑰永遠不離開自己的錢包。** 跟隨者用錢包簽兩種交易：跟單＋同意自動同步、存入或提領油箱。之後的同步由別人送出，
  但不需要跟隨者的簽名，也不需要任何形式的委託金鑰。執行者程式**不需要也不接受**任何跟隨者的私鑰。
- **執行者金鑰是一把獨立的熱錢包**，只放少量付 gas 的 ETH。外洩的最壞情況：有人用它觸發合約本來就允許的同步（任何人本來就能觸發），
  以及把錢包裡那點 gas 用掉；**沒有任何跟隨者資金風險**。
- 執行者在公開鏈上優先使用加密 keystore（密碼從環境變數指向的檔案或互動輸入），明文私鑰只允許本機 Anvil（chainId 31337）
  或明確的旗標；日誌不印私鑰，也不印含 API 金鑰的 RPC 網址（比照 `agent/keeper/keySource.ts` 與 `agent/heroes/keystore.ts`）。

### 合約強制 vs agent 程式自律

| 保證 | 合約強制 | agent 程式自律 |
|---|---|---|
| 同步內容只能是交易者鏈上最新版 | ✓ | |
| 只有跟隨者能開關自動同步、指定執行者、提領油箱 | ✓ | |
| 指定了執行者時，只有那個地址（與本人）能代為同步 | ✓ | |
| 冷卻（含 1 小時下限）、執行費不高於跟隨者簽名同意的費率、油箱不足、`AlreadySynced`、交易者資格 | ✓ | |
| 槓桿不超過跟隨者上限與資產上限 | ✓ | |
| 只動用這次釋出的保證金、原子性 | ✓ | |
| 先模擬、會成功才送（不浪費自己的 gas） | | ✓ |
| personal 模式只服務 `--followers` 列出的地址 | | ✓ |
| personal 模式在交易者發布新版時通知本人（含沒開自動同步、或指定了別的執行者的跟單） | | ✓ |
| 冪等、可中斷續跑（記錄已處理到的區塊） | | ✓ |
| 通知跟隨者同步結果與被擋原因 | | ✓ |
| 不印私鑰與 RPC 金鑰網址 | | ✓ |

右欄的項目只保護執行者自己（不浪費 gas、不漏金鑰），跟隨者的安全全部在左欄：換成任何不照這份程式跑的執行者，跟隨者的保證不變。

## 營運方仍保有的權限（照實列出）

與 ADR-023 的清單相同，另外有三項與同步直接相關：

- **`setCopyTracker`**：owner 換掉 CopyTracker 時，舊 tracker 立刻失去代為開平倉的授權，舊 tracker 上的同步與取消都會因平不掉腿而 revert；
  跟隨者的出路是 `deactivateWithoutScoring` 之後在交易所自行平倉（部位一直在跟隨者名下）。油箱在舊 tracker 上仍可隨時提領。
- **`setExecutionFee`**：交易所的 `executionFee` 由 owner 調整（合約上限 `MAX_EXECUTION_FEE` = 1 ETH／腿），執行費進交易所、由 owner 提領。
  若同步一律按現行費率扣油箱，owner 調高費率再當執行者，一次同步就能把油箱扣光（審查實測：0.3 ETH 的油箱剩 1 wei）。
  第一版的修法是在跟隨者開啟自動同步時記下「交易執行當下」的費率，本人手動同步則不設上限——第二輪審查實測兩者都能被搶先交易利用：
  owner 在同一個區塊搶先 `setExecutionFee(1 ether)`，跟隨者按下「立即同步」就被扣 3 ETH（3.01 ETH 的油箱剩 0.01）；跟隨者只是改小費而
  呼叫 `setAutoSync`，同意值就被記成 1 ETH／腿；`followTraderAtVersionWithAutoSync` 的預存油箱 ETH 整筆被當成開倉執行費收走。
  `executionFee` 是 owner 的參數，「本人送出時看得到」不成立——看到的是送出前的值，執行的是打包時的值。
  **現在每一條扣油箱（或預存 ETH）的路徑，都以跟隨者交易參數裡簽名帶入的每腿上限為準**：`setAutoSync`／`followTraderAtVersionWithAutoSync`
  的 `maxExecFeePerLeg`（成功時記為 `syncExecFeeCap`，供之後的 `resyncFor` 使用）、`resyncAtVersion` 的 `maxExecFeePerLeg`；現行費率較高就整筆
  revert `ExecutionFeeAboveCap`，油箱一 wei 不動；費率調回同意的水準以下就恢復（按較低的現行費率扣）。唯一不看上限的扣款是本人經 `resyncFor`
  同步且附帶的 `msg.value` 付得清全部成本——付款上限就是本人簽名的 `msg.value`，油箱既有餘額淨額不減。
  仍然存在的部分：owner 能讓跟隨者的交易失敗（搶先調費），也能在費率合法範圍內提高往後每一筆交易的成本；這是交易所參數治理的問題，
  緩解是把交易所 owner 交給有延遲的 timelock（調費提前公開），見 KNOWN_LIMITATIONS #39。舊入口 `followTrader`／`followTraderAtVersion`
  的 `msg.value` 平均分給每條腿，與本案無關、行為不變（搶先調費只會讓它 revert）。
- **暫停交易所、凍結資產**：期間同步全部 revert（平不掉或開不起來），部位維持舊版。

## 與 eToro 的差別（更新 ADR-023）

- **跟單可以持續跟隨，但要跟隨者在鏈上同意，而且同步由「任何人」觸發。** eToro 由平台在自己的帳本上替客戶下單；
  這裡沒有任何人替跟隨者簽名，合約只接受「調成最新版」這一種調整。代價是即時性取決於有沒有人執行（見 KNOWN_LIMITATIONS #40）。
- **調倉是「全平再開」，不是差額調整。** 新版只改一個權重，所有腿也都會一出一進，交易費比 eToro 的差額調倉高；
  跟隨者用冷卻時間控制頻率。
- **只有交易者發布新版時才同步。** 交易者在策略之外自己手動開平倉，跟隨者不會跟著動；跟的是「發布的策略」，不是交易者的帳戶。
- **沒有自動停損**（不變）。

## Considered options

- **專用錢包：跟隨者把一把熱錢包（或其私鑰）交給平台／agent 代為下單。** 否決：這就是託管，只是換個名字；
  金鑰外洩等於資金外洩，與 ADR-023「只支援使用者自管」直接衝突。
- **session 版：用既有的 `AgentSessionManager` session，讓 agent 在額度內依鏈下判斷替跟隨者調倉。** 否決作為主要做法：
  session 限制的是額度、槓桿、到期與資產清單，**不限制 agent 開什麼部位**——agent 可以在額度內開任何方向、任何資產，
  跟隨者必須信任 agent 的程式真的照交易者最新版下單（ADR-016、KNOWN_LIMITATIONS #36 的自律問題）。
  session 仍保留給「agent 依自己的策略下單」的用途。
- **改合約版（本案）：把「調成最新版」寫進合約，呼叫者無選擇空間。** 採用。
- **「只讓自己的 agent 執行」怎麼做：文件建議 vs 合約強制。** 第一版只在文件裡建議「不開自動同步、改用自己的 agent（personal 模式）」，
  審查指出這做不到：agent 是另一把熱錢包，對合約是陌生人，要能呼叫就得開自動同步，一開任何第三方也都能挑時機。改為合約層的
  `setSyncExecutor`（獨立 mapping `syncExecutor`，`SyncConfig`／`syncConfig`／`AutoSyncSet` 的 ABI 不變），+458 B。另一個選項是
  「允許 follower 預先授權一個地址代表本人呼叫 `resyncAtVersion`（釘版本）」——那等於把「選哪一版」的權限交給熱錢包，否決；
  指定執行者只能把部位調成鏈上最新版，與其他執行者的權限相同，只是人數收窄到一個。`followTraderAtVersionWithAutoSync` 沒有加
  executor 參數：冷卻從跟單當下起算、至少 1 小時，另送一筆 `setSyncExecutor` 之前沒有人能代為同步，不需要再改一次已在前端與
  腳本裡使用的簽章。需要重新部署 CopyTracker 並由 owner 改接線
  （`PerpetualExchange.setCopyTracker` 只認一個主要 tracker，`copiedFrom` 也只接受它）。
- **交易者推送：`publishStrategy` 時由交易者的交易順便把所有跟隨者調好。** 否決：gas 隨跟隨者人數無上限成長，
  一個跟隨者的 KYC 或休市就讓交易者發布失敗；也讓交易者決定所有人的同步時機。
- **第三方同步要求新版內容與紀錄版本不同（allocations 雜湊比對）。** 否決：只擋得住「原封不動重發同一版」，交易者把腿換個順序、
  某個權重差 1 bps、或在兩版之間交替就繞過；卻要多一次外部呼叫、多一種錯誤讓執行者與前端處理。真正限制頻率的是合約強制的冷卻下限，
  績效費的根本問題在交易所（沒有高水位線），見「經濟」一節與 KNOWN_LIMITATIONS #41。
- **執行費同意值：執行當下快照 vs 跟隨者簽名帶入。** 第一版在 `setAutoSync` 執行當下快照交易所費率，介面最省，但同意值可以被 owner
  搶先交易改寫（見「營運方仍保有的權限」），已改為函式參數 `maxExecFeePerLeg`（`setAutoSync`、`followTraderAtVersionWithAutoSync`、
  `resyncAtVersion`）。記下的值仍放在獨立 mapping `syncExecFeeCap`，`SyncConfig`、`syncConfig` getter 與 `AutoSyncSet` 事件的 ABI 不變。
  沒有保留規格原本的五參數／六參數簽名做 overload：保留它就保留了可被搶先交易的入口，而且 ethers v6 對同名、參數數量相鄰的 overload
  在帶 `{ value }` 覆寫參數時會判為 ambiguous，前端既有的呼叫方式會直接壞掉；這些函式尚未部署，沒有既有整合需要相容。
  另一個選項是「本人同步只能用這筆交易的 `msg.value` 付、不扣油箱」——對 `resyncFor` 的本人路徑採用了它作為沒有同意上限時的出路，
  但介面的「立即同步」要能用油箱付款，所以 `resyncAtVersion` 改帶簽名上限。
- **差額調倉（只調有變的腿）。** 暫緩：要處理同資產換方向、部分平倉與保證金重算，合約大小與複雜度都大增；
  先以全平再開的原子版本上線，費用以冷卻控制。

## 後果

- 原始碼完成後 Base Sepolia **不會自動有這個功能**：要由擁有者部署新 CopyTracker 並改接線（[`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) 第 8 步）。
  部署之前公開站沒有自動同步，Portfolio 仍顯示「策略已更新」標記。
- 舊 tracker 上的既有跟單不能遷移成自動同步（交易所的 `positionAgent` 綁定開倉的那顆 tracker，新 tracker 平不掉舊腿）：
  跟隨者在舊 tracker 上取消或放棄計分後，在新 tracker 上重新跟單。
- `PepeIncentives.copyTracker` 是 immutable，指向舊 tracker：換 tracker 後，新跟單領不到跟單獎勵，要等 PepeIncentives 重新部署。
- 新增執行者 agent `agent/copy-sync/`（public 模式服務所有開了自動同步、沒有指定別人的跟隨者；personal 模式只服務自己——
  跟隨者用 `setSyncExecutor` 指定它之後只有它能代為同步，沒開自動同步的跟單則只在有新版時通知本人）。
- MCP（`agent/mcp-server/src/copyTools.ts`）：`copy_sync_status`（唯讀：版本、自動同步設定、指定執行者、油箱、冷卻、費率同意、
  下一步建議）與 `prepare_copy_sync_tx`（產生**未簽名**交易：立即同步附新版預覽、開關自動同步、指定執行者、存提油箱，交給跟隨者
  自己的錢包簽），以及 `prepare_copy_follow_tx`（**由 agent 發起跟單**：USDC `approve` 剛好金額＋`followTraderAtVersion`，或開啟
  自動同步時的 `followTraderAtVersionWithAutoSync`——釘住交易者鏈上最新版、以目前執行費為簽名同意的上限、預存油箱；附各腿預覽、
  KYC 檢查與 eth_call 模擬）。LLM agent 能查、能準備、能解釋，但不簽名、不送出，也不需要任何私鑰；背景同步仍由 copy-sync 執行者負責。
  自託管的「agent 下單／跟單」因此是完整的：下單走 AgentSessionManager 的 session 限額，跟單走未簽名交易，兩者都不需要使用者的私鑰。
- 通知：webhook 設在執行者那支程式上，public 執行者的通知送到營運方自己。跟隨者要收到「有新版、被擋原因」有兩條路：
  不需要任何金鑰的 `copy-sync --notify-only --followers <自己>`（寫狀態檔，每一版、每個被擋原因只通知一次，可掛 cron），
  或什麼都不跑——網頁在任何內頁頂端提醒落後的紀錄與需要本人處理的原因（沒開自動同步、油箱不足、執行費被調高）。
- 執行者金鑰的自律：不論 public 或 personal 模式，載入的金鑰在 tracker 上有任何跟單紀錄或油箱餘額就拒絕啟動（那是跟隨者的主錢包）；
  私鑰誤貼進只填地址的參數時拒絕且不顯示任何片段。
- 前端：CopyPage 跟單時可開啟自動同步、預存油箱、選填指定執行者（另送一筆）；不勾自動同步時也用 `followTraderAtVersion`
  釘住畫面上的那一版（M10；只有沒有這個入口的舊 tracker 才退回 `followTrader`）；Portfolio 顯示「已同步到 vN／最新 vM」、同步次數、
  油箱餘額、指定的執行者，提供立即同步（先開確認視窗看新版內容與費用，只在專家模式）、開關自動同步、存入與提領；鏈上動態牆加入
  `Resynced`、`AutoSyncSet`。
- 已知限制見 [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) #39–#45。
