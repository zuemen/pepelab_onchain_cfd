---
status: proposed（原型已合入分支；未部署；主網開放待擁有者決定）
date: 2026-10-02
plan-item: P3-04（計畫 v0.3 升為 P2、主網阻擋項）
---

# 主網結算幣：每個租戶一顆 1:1 的 18 位包裝 USDC＋一筆完成的存入 router，V1 合約一行不改；V3 再原生支援 6 位

Base 主網的原生 USDC 是 **6 位小數**。V1 合約（`PerpetualExchange`、`InsuranceVault`、`FeeRouter`、`TraderStake`、`CopyTracker`、`AssetVaultV2_x`）全部以 **18 位**的結算幣記帳，`PerpetualExchange` 的建構子讀 `decimals()`，不是 18 就 revert（`contracts/src/PerpetualExchange.sol:639-646`）；`DeployTenant` 的 preflight 也擋（`contracts/script/DeployTenant.s.sol:138-147`）；租戶設定白名單今天讓所有 `chainId: 8453` 的設定都過不了（`scripts/check-tenant-deploy.mjs:76-86,355-360`，ADR-008 F7）。測試網用的是 18 位的 `MockUSDC`，所以這個問題在測試網上看不到。

這份 ADR 記錄：整個 repo 對「保證金代幣 18 位」的假設在哪裡（附錄 A）、四類方案的比較、建議，以及要擁有者決定的事。建議的方案是純新增（只新增合約、測試與文件，不改任何既有合約），所以這次一併交了原型（§5）。

> 範圍界線：**x402 的付款不受影響**。x402 本來就用 Circle 的 6 位 USDC（`agent/shared/src/x402Client.ts` 的 `USDC_DECIMALS = 6`、`signingGuard` 的官方 USDC domain），平台也已經有一組綁在 6 位 USDC 上的 `FeeRouter`＋`InsuranceVault` 專收 x402 收入（`contracts/script/DeployX402Router.s.sol`、`contracts/test/FeeRouterX402Usdc.t.sol`）。這份 ADR 只處理**保證金／結算幣**。

## 1. 查證事實（2026-10-02，worktree 基於 master 17ec739）

| 事實 | 值 | 來源 |
|---|---|---|
| exchange 的 PnL、資金費率、OI、mark 計算與結算幣小數無關 | `notional = margin × leverage`（代幣單位）；`size = notional × 1e18 / entryPrice`；`pnl = Δprice × size / 1e18`（回到代幣單位）；`funding = notional × indexDiff / 1e18`；`rawPrice × 1e10` 只是 8→18 位**價格**換算，不混入代幣單位 | `PerpetualExchange.sol:1724,1792,1962,1971,2017-2022,2035,2095` |
| exchange 裡真正綁死 18 位的只有兩處 | `MIN_MARGIN = 10e18`（L52）與建構子的 `decimals() != 18` 檢查（L639-646）。`MAX_EXECUTION_FEE`／`executionFee` 是原生 ETH，不受影響 | 同上 L52,71,135,639-646 |
| 但 6 位時 `size` 會掉精度 | 例：10 USDC×1 倍、BTC ≈ 100,123 → `size = 1e7×1e18/1.0012e23 ≈ 99`（截掉 0.87），PnL 少算約 1%；1,000 USDC×5 倍時約 0.002%。修法是把 `size` 多乘一個 `10^(18−d)`，牽動開倉、減倉、OI 上限與 PnL 四處 | 同上 L1792,1962,1971,2020-2022 |
| 周邊合約有的會壞、有的只是單位縮小 | `AssetVaultV2_x`／v1 `AssetVault` 的 mint（`USDC × 1e8 / price`）與 redeem（`token × price / 1e8`）用同一個比例，liability（`Σ outstanding × price / 1e8`）與 `reserve()`（USDC 餘額）同單位：6 位時合成資產的原始數量**一致地縮小 1e12，價值守恆**，mint→redeem 不會多付，準備率也不會失真（初版在這裡的推論有誤，已依 PR #230 審查 M-3 更正）。真正會壞的是以合成資產原始單位寫死的門檻：`EXEMPT_DUST_UNITS = 1e15`（豁免上限形同失效、liability 可被低估）、`assetCap`（若照 18 位語意設定會鬆 1e12 倍）、合成資產 `decimals()=18` 的顯示，以及高價資產的取整精度。會壞的還有：`TraderStake.MIN_STAKE = 100e18`（連帶讓 StrategyRegistry 與 CopyTracker 的資格全部失效）；`PepeAMM`／`MockSwapRouter` 直接拿 USDC 單位比 ETH 單位；`PepeIncentives` 把 USDC 名目 1:1 換成 PEPE。`InsuranceVault` 只有顯示問題（份額以 6 位數量計、`decimals()` 仍報 18） | 附錄 A.1 |
| 自身沒有小數假設的合約 | `AgentSessionManager`（上限由使用者逐 session 給）、`FeeRouter`（只有 bps）、`EsgRewardDistributor`。`CopyTracker`、`StrategyRegistry` 自身沒有常數，但資格經 `TraderStake.isEligible`（`TraderStake.sol:139`）→ `MIN_STAKE` 判斷，6 位時**連帶失效**（`CopyTracker.sol:170` → `StrategyRegistry.sol:112,174-176`） | 附錄 A.1 |
| agent／前端／監控全面寫死 18 | SDK 唯一常數 `MARGIN_DECIMALS = 18`（`agent/sdk/src/format.ts:6`）；`agent/shared/src/write.ts:391` 開倉金額 `parseUnits(marginUsdc, 18)` 直接上鏈；前端約 40 個檔案、約 190 處（`parseEther` 用在 USDC 輸入、`fromUnits(…, 18)` 顯示、`wallet_watchAsset … decimals: 18`）；監控 9 條規則 `"decimals": 18` | 附錄 A.3～A.6 |
| 監控門檻本身已經與小數無關 | `ops/monitoring/params.mjs` 的門檻是整數 USDC，`engine.mjs` 以每條規則的 `decimals` 換算；`check-monitoring.mjs:1243-1259` 會拿規則的 `decimals` 比對鏈上 `decimals()` 快照 | 附錄 A.5 |
| EIP-170 預算（實測） | 在 repo 外的複本裡改 exchange 再編譯（同 solc 0.8.30、via_ir、runs 200）：原樣 **23,911 B**；(b1) `MIN_MARGIN` 改 immutable 並拿掉 18 位檢查 **23,983 B（+72）**；(b2) 再加 `size` 精度修正 **24,187 B（+276，剩 389）** | §3.2 |
| 「D2：V3 採 GMX 式」的公開文件 | repo 內（`docs/`、`frontend/docs`、README、`ops/`）**找不到**；唯一的 GMX 字樣是 `PerpetualExchange.sol:427` 的註解。§3.3 依計畫 v0.3 的描述寫 | `grep -ri "gmx\|D2\|V3" docs frontend/docs` |

## 2. 需求與限制

1. 主網租戶要能用 Circle 的原生 USDC 存入、提領。
2. **硬限制**：`PerpetualExchange` runtime 維持 23,911 B（EIP-170 上限 24,576，餘 665 B）；UUPS 合約（`AssetVaultV2_x`）的 storage 只能在尾端新增。
3. 不削弱 ADR-008／PR #228 的隔離：每個租戶的資金、權限、事故面不與平台或其他租戶共用；共用只限顯式宣告、白名單內的元件。
4. 不擴大已稽核程式碼的變更面；新增的程式碼要小到可以完整稽核。
5. 與 Circle 的發行方控制（黑名單、暫停）相容：包裝幣不能比 USDC 本身更容易繞過凍結（合約內部帳本本來就不在 Circle 的控制範圍內，見 §3.1 ②）。

## 3. 方案比較

### 3.1 (a) 1:1 包裝幣（6→18 位）＋存入 router

每個租戶部署一顆 `WrappedUSDC18`（1 USDC 單位 ⇄ 1e12 包裝單位），整套租戶合約以它作為結算幣；Circle 的 USDC 只在包裝合約進出。`SettlementDepositRouter` 讓使用者一筆交易完成 permit → 拉 USDC → 包裝 → `depositMarginFor`。

| 面向 | 評估 |
|---|---|
| 安全 | 新增程式碼約 100 行（包裝）＋60 行（router），**無 owner、無升級、無暫停、無手續費、無 sweep**。包裝合約持有租戶全部真實 USDC（保證金、池子流動性、保險金、FeeRouter 餘額、質押、金庫準備金、閒置的包裝幣），集中度上升；但 V1 已稽核的合約一行不改，稽核範圍只多這兩支。缺點是不可升級：有 bug 只能換新的包裝合約並遷移，所以程式碼刻意極簡，並以不變量／fuzz 測試鎖住（§5）。 |
| 可升級性／暫停 | 不提供。緊急停止靠各租戶 exchange 自己的暫停與 guardian；USDC 自己暫停時包裝與解包自然停止。加一把暫停鍵等於再多一把能凍結全部資金的金鑰，與 ADR-008 的「每租戶金鑰最少化」相反。 |
| Circle 黑名單 | ① **包裝合約位址被列入黑名單 → 該租戶全部 USDC 凍結**（包裝單位仍可在內部移動，但無法換回 USDC）。這與「exchange 直接持有原生 USDC、exchange 被列入黑名單」是同一個量級的風險，只是多了一個會被點名的位址；**每租戶一顆**把影響限制在單一租戶。exchange 本身被列名時，提領與清算（獎勵由 exchange 轉出）都會 revert，與原生設計相同。② 不鏡像黑名單的包裝幣會變成**繞過凍結的管道**（被列名者把包裝幣轉給乾淨地址再解包）。原型在每一次轉帳、mint、burn 檢查 `from`／`to` 是否在 USDC 的 `isBlacklisted`，與 USDC 行為一致；探測失敗（底層沒有這個函式或 revert）時 **fail-open**，避免上游改名就把所有租戶資金鎖死（擁有者決定 Q2）。**鏡像的邊界**：它只保證「包裝幣不比 USDC 寬鬆」；exchange、FeeRouter 等合約的**內部帳本**（freeMargin、績效費、清算獎勵等記帳）不經過包裝幣轉帳，被列名者仍可能經由交易把價值記到其他帳戶——這與 exchange 直接持有原生 USDC 的設計**完全相同**，Circle 對合約內部記帳本來就沒有控制力，不是包裝幣引入的退化。對策是監控（§6 第 6 項）與 router 的入金檢查：router 對受益帳戶做同一個黑名單探測，不把乾淨資金記到已凍結的帳戶。③ 被列名的交易者：`withdrawMargin` revert（與原生 USDC 相同）。exchange 唯一會**直接付款給部位持有人**的是 bailout floor（虧損超過保證金時，保險金付 10% 保證金給持有人，`PerpetualExchange.sol:1926-1927` → `InsuranceVault.sol:154-160`）；持有人被列名時這筆付款 revert 並被 `try/catch` 略過，平倉照常、保險金不付這筆。清算獎勵付給清算者，**清算不受影響**——兩者都有測試。 |
| USDC 暫停 | 包裝／解包 revert；**包裝單位照常移動**，所以開平倉、清算、資金費率、保險金撥補、提領成包裝幣都繼續，只有「換回 USDC」等 Circle 解除暫停。原生 6 位設計下，USDC 暫停時 exchange 每一筆代幣轉帳（含清算獎勵、保險金撥補）都會 revert。**但這是取捨，不是單純較好**：暫停期間使用者也**無法從錢包的 USDC 補保證金**（包裝與 router 都 revert，只有手上已有包裝幣的人能 `depositMargin`），清算卻照常進行；原生設計下兩者一起停，會累積壞帳，但不會單方面清算使用者。是否在 USDC 暫停期間由 guardian 暫停 exchange，列為營運決策（Q10）；前端要在 USDC paused 時明確提示。暫停**不**在包裝幣鏡像（若鏡像，等於強制選擇「一起停」，而且沒有任何人能在暫停中處理風險）。 |
| 會計 | exchange 內部仍是 18 位，所有已稽核的捨入行為不變。解包**一律向下取整到整數 USDC 單位，只燒掉實際付出的部分**：`amount % 1e12`（< 1e-6 USDC）留在持有人餘額裡，不被銷毀、也不多付。不變量：`totalSupply ≤ USDC 餘額 × 1e12`，且 `totalSupply` 永遠是 1e12 的倍數；所以 N 個持有人加總被卡住的 dust < N 個 USDC 單位，而且永遠有足額 USDC 支撐。直接打進包裝合約的 USDC（誤轉）不支撐任何包裝幣，也取不出來（沒有 sweep，Q3）。包裝**嚴格 1:1**：USDC 實際到帳必須等於請求數量，否則 revert（將來若加收轉帳費，包裝會 fail-closed，而不是靜默少 mint）；包裝與解包都是 `nonReentrant`，USDC 將來若加入轉帳回呼也無法巢狀包裝、重複計入（審查 M-1，有回歸測試）。**無法自保的情況**：發行方以其他方式減少包裝合約的餘額（負向 rebase、扣押）——這是任何 USDC 持有人都有的、對 Circle 的信任前提。 |
| UX | 存入：有 router＋USDC 的 EIP-2612 permit → **1 筆**；沒有 router 是 4 筆（approve、wrap、approve、deposit）。permit 被搶先送出不會讓使用者的交易失敗（try/catch 後照常 `transferFrom`，有測試）。提領：`withdrawMargin` 只付給 `msg.sender`，router 無法代領，所以是 **2 筆**（提領包裝幣、`withdrawTo` 解包；解包不需要 approve）；支援 EIP-5792 批次的錢包可以合成 1 筆。錢包裡會出現一顆包裝幣，前端要顯示成 USDC 並提供「換回 USDC」（ADR-0002 的單一標示規則）。 |
| router 的權限 | `depositMarginFor` 只有 `authorizedAgents` 能呼叫，這個旗標**同時**開放 `openPositionFor`／`closePositionFor`。router 不可升級、無 owner、沒有任意呼叫路徑，唯一呼叫 exchange 的是 `depositMarginFor`，所以授權本身無害（審查以 fuzz 與逐 selector 測試確認：router 沒有任何路徑能代開倉、代平倉、代提領，交易結束時不留餘額或額度）。但 `VerifyTenant` 必須逐位元組比對被授權的 router 與審查過的建置產物，否則管理員誤授權一個外觀相同的合約就等於交出代開倉權；router 也**不得**被設為 `copyTracker`（copyTracker 可以填 `copiedFrom`，`PerpetualExchange.sol:1093`）。租戶的 agent 白名單因此是三個：CopyTracker、AgentSessionManager、router（§6 第 3 項）。 |
| 租戶隔離 | **每租戶一顆包裝幣、一支 router**，兩者都是「專屬」元件；共用的仍只有 Circle 的 USDC 本身（ADR-008：「共用的是程式碼、結算幣、上游價格來源」）。共用一顆包裝幣等於所有租戶的 USDC 放在同一個位址：一次黑名單或一個 bug 就是跨租戶事故，也違反 #228 的位址互斥規則 → 否決。 |
| 對其餘程式的影響 | 因為 exchange 看到的仍是 18 位代幣，**agent、SDK、MCP、keeper、前端的保證金數學與顯示、監控規則全部不用改**（附錄 A 的約 250 處維持原樣）；要新增的只有存入／解包入口與標示。 |
| 遷移成本與時程（估計） | 本 PR：合約、測試、ADR 完成。剩下：外部稽核（約 160 行）、`DeployTenant`／`VerifyTenant`／三支檢查器整合（約 1～2 週）、前端存入與「換回 USDC」流程（約 1 週）、SDK／MCP 加 router 與解包輔助（數天）、監控新增 3 條規則（數天）、Base Sepolia 以 Circle 測試網 USDC 預演一個租戶。合計約 **3～5 週＋稽核排程**。V1 不需重新稽核。 |

### 3.2 (b) 在 V1 合約內加縮放因子

把結算幣小數變成建構子參數，相關常數與換算改成依 `decimals()` 計算。

| 面向 | 評估 |
|---|---|
| 要改的合約 | `PerpetualExchange`（`MIN_MARGIN` 改 immutable、拿掉 18 位檢查、`size` 精度修正）；`PerpetualExchangeLens`（`openSize` 換算，另一支合約、不占 exchange 預算）；`AssetVaultV2_5` → 新的 UUPS 實作（`EXEMPT_DUST_UNITS`、`assetCap` 的語意、合成資產的小數與顯示、高價資產的取整；縮放因子可放在實作的 immutable，不動 storage）；`TraderStake.MIN_STAKE`（連帶修好 StrategyRegistry／CopyTracker 的資格）；`InsuranceVault`（份額的 `decimals()` 與 NatSpec，屬顯示）；`PepeIncentives`（USDC 名目→PEPE）。`PepeAMM`／`MockSwapRouter` 是平台專用，可以不給租戶，但仍是錯的。 |
| EIP-170 | 實測：只做最少的 (b1) +72 B；含精度修正的 (b2) +276 B，**剩 389 B**，約用掉剩餘預算的 42%，而且這還不含任何後續修補的空間（Lens 是另一支合約，不計入）。不做精度修正則 6 位租戶的小額部位 PnL 會有最高約 1% 的系統性低估。 |
| 稽核範圍 | exchange 的開倉、減倉、PnL、OI 上限路徑，金庫的 dust 豁免／上限／精度，質押資格門檻——**等於 V1 資金路徑的主體重新稽核**。新的 `AssetVaultV2_6` 還要走一次 UUPS 升級審查。 |
| 其餘程式 | agent、SDK、前端、監控必須同時支援 18 位（測試網）與 6 位（主網）：附錄 A 的約 25 處 agent 程式碼、前端約 40 個檔案、9 條監控規則、部署腳本的 OI 上限換算全部改成讀 `decimals()`。 |
| 安全／黑名單／暫停 | 不新增合約、不新增持有資金的位址；黑名單與暫停的行為就是原生 USDC 的行為（USDC 暫停時清算獎勵與保險金撥補都會 revert）。 |
| 租戶隔離 | 無影響（每租戶一套合約不變）。 |
| 成本與時程（估計） | 合約 2～3 週＋前端／agent／監控 2～3 週＋**V1 主體重新稽核**；合計約 **8～12 週以上**。 |

結論：技術上可行（預算夠），但為了一個「換單位」的需求，把已稽核的資金路徑主體與所有下游程式重開一次，代價和風險都高於 (a)。

### 3.3 (c) 等 V3 重寫時原生支援

計畫 v0.3 的方向（D2）是 V3 採 GMX 式架構（池子提供流動性、以 oracle 價格成交、多抵押品）。repo 內沒有公開的 D2 文件，這裡依計畫描述寫：在重寫時把「每個抵押品各自的小數」當作一級概念（代幣登記時記錄 `decimals`，內部統一以 18 位或更高精度記帳、只在轉帳邊界換算），成本幾乎為零，也不會有包裝幣。

| 面向 | 評估 |
|---|---|
| 安全／稽核 | 反正要整體稽核，原生支援不額外增加範圍。 |
| 黑名單／暫停 | 與原生 USDC 相同。 |
| 會計 | 可以一開始就設計成高精度內部單位＋邊界換算。 |
| UX | 最好（直接用 USDC，沒有額外代幣）。 |
| 租戶隔離 | 依 V3 設計而定。 |
| 時程 | V3 尚未開工；**無法解除 V1 的主網阻擋**。 |

結論：作為長期方向保留；不能當作 V1 上主網的方案。

### 3.4 (d) 其他查到的做法

| 方案 | 說明 | 判斷 |
|---|---|---|
| (d1) 直接用一顆 18 位的美元穩定幣 | 例如 Base 上的 DAI／USDS 類 18 位代幣（位址、發行方條款、流動性需另行查證）。不新增合約、V1 不改。 | 機構租戶的需求是 USDC；換發行方等於換信用與監理風險，也還是要處理各自的凍結機制。可當備案，不建議為主。 |
| (d2) ERC-4626 份額（`_decimalsOffset() = 12`） | 用 OZ `ERC4626` 包 USDC，份額 18 位。 | 份額與資產的比例會因捐贈而漂移，不再是嚴格 1:1，會計與監控都變複雜；若再接收益型金庫（Aave／Morpho）更是引入第三方風險。比 (a) 差。 |
| (d3) V1 內只在轉帳邊界縮放 | exchange 與周邊合約內部維持 18 位，只在每個 `safeTransfer*` 前後 ×／÷1e12。 | 跨合約的呼叫（保險金撥補、FeeRouter 收費、CopyTracker 代存）以代幣數量傳遞，每個邊界都要一致換算，dust 散落在每支合約，改動面比 (b) 還大。否決。 |
| (d4) Permit2／EIP-5792 批次 | 不是解法本身，是 (a) 的 UX 補強：沒有 router 時也能把 approve＋wrap＋deposit 合成一筆。 | 與 (a) 並用；router 仍然需要給 EOA。 |

## 4. 決定（建議，待擁有者核可）

**V1 上主網採 (a)：每個租戶一顆 `WrappedUSDC18` 與一支 `SettlementDepositRouter`，V1 既有合約一行不改；V3 採 (c) 原生支援多小數抵押品。否決 (b)、(d2)、(d3)；(d1) 留作備案。**

理由：

1. **唯一不碰已稽核程式碼的方案**。V1 的 exchange、金庫、保險金、FeeRouter 原封不動，EIP-170 預算一個位元組都不用；新增的稽核範圍約 160 行、無管理權限。
2. **下游約 250 處 18 位假設不用改**（附錄 A）。(b) 要同時讓 agent、前端、監控支援兩種小數，是最容易出錯也最難測完的部分。
3. **USDC 暫停時風險管理不中斷**：內部清算與結算照常，只有出入金等 Circle。代價是暫停期間使用者無法從 USDC 補保證金（§3.1，Q10）。
4. **可逆**：包裝幣嚴格 1:1、無費用，租戶隨時可以全部解包退出；將來換到 V3 時，包裝幣直接退役。
5. **隔離不變**：每租戶一顆，黑名單或 bug 的影響限於單一租戶；共用的仍只有 Circle 的 USDC 本身。

不做的事：

- 不在包裝合約加 owner、暫停、升級、sweep 或手續費。
- 不共用包裝幣（平台與租戶、租戶之間都不共用）。
- 本次**不改** `DeployTenant`／`VerifyTenant`／三支檢查器，也不放行 8453（理由與後續項目見 §6）。

### 4.1 要擁有者決定的問題

| # | 問題 | 建議 |
|---|---|---|
| Q1 | V1 上主網採 (a)，還是等 V3？ | 採 (a)；V3 照 (c) 設計 |
| Q2 | 包裝幣是否鏡像 Circle 黑名單？探測失敗時 fail-open 還是 fail-closed？ | 鏡像；fail-open（fail-closed 會讓上游一次改名就鎖死所有租戶資金）。若選 fail-closed，要同時接受「沒有任何解鎖手段」 |
| Q3 | 包裝幣無 owner、無暫停、無升級、無 sweep（誤轉進來的 USDC 永久鎖住）——接受嗎？ | 接受；誤轉的金額不影響任何人的兌付 |
| Q4 | router 需要被授權為 exchange 的 agent（同時具備代開／代平倉的能力），接受嗎？還是不用 router、讓使用者走 4 筆或錢包批次？ | 接受，條件是 agent 白名單固定為 {CopyTracker、AgentSessionManager、router}，`VerifyTenant` 逐位元組比對 router、確認 router ≠ copyTracker |
| Q5 | 包裝幣的 `name`／`symbol`（錢包會直接顯示）？ | 名稱寫明「Wrapped USDC」與租戶；**symbol 不要與原生 USDC 完全相同**（降低錢包混淆與釣魚風險）；前端依 ADR-0002 一律顯示 USDC 並標示「可換回」 |
| Q6 | 外部稽核：哪一家、何時？ | 主網開放前必做，範圍 = 兩支新合約＋整合腳本 |
| Q7 | 是否先在 Base Sepolia 用 Circle 的測試網 USDC（6 位）跑一個預演租戶？ | 是；它就是主網設定的完整演練 |
| Q8 | 平台自己（非租戶）上主網是否也走同一條路？ | 是，平台視為一個租戶 |
| Q9 | 何時放行 8453？ | §6 的整合項目合入、Q6 稽核完成、Q7 預演通過之後 |
| Q10 | USDC 暫停期間，使用者無法從 USDC 補保證金、清算卻照常（§3.1）：要不要由 guardian 同時暫停 exchange？ | 營運決策，事故手冊寫明判斷條件（例如暫停超過一定時間或價格大幅波動時暫停）；前端在 USDC paused 時提示 |

## 5. 原型（本次交付，未部署）

| 檔案 | 內容 |
|---|---|
| `contracts/src/settlement/WrappedUSDC18.sol` | 1:1 包裝；`depositFor`（嚴格 1:1：實際到帳必須等於請求數量）、`withdrawTo`（向下取整、只燒付出的部分），兩者 `nonReentrant`；`maxUnwrappable`；`isUnderlyingBlacklisted`（探測，供 router 使用）；`_update` 鏡像黑名單（fail-open）；建構子要求底層 `decimals() == 6` 且有程式碼 |
| `contracts/src/settlement/SettlementDepositRouter.sol` | `depositMargin`、`depositMarginWithPermit`（permit try/catch）；受益帳戶在 USDC 黑名單上時拒絕（`AccountBlacklisted`）；全部 immutable、`nonReentrant`、交易結束時不留任何餘額或額度 |
| `contracts/test/settlement/MockFiatUSDC6.sol` | 測試用的 6 位 USDC：permit、`isBlacklisted`、`paused`、可選轉帳費；「沒有 `isBlacklisted`」與「`isBlacklisted` 會 revert」兩種（驗 fail-open）；`HookedUSDC6`：假想的「升級後有轉帳回呼」的 USDC（回呼失敗可選吞掉或往上拋），用來鎖住 M-1 |
| `contracts/test/settlement/WrappedUSDC18.t.sol` | 單元＋fuzz：建構子、包裝／解包、dust、轉帳費 fail-closed、**重入回歸**（包裝的送出回呼、解包的收款回呼，吞掉與往上拋兩種）、黑名單（持有人、收款人、代轉、包裝合約本身、探測 view）、fail-open、USDC 暫停；fuzz 金額到 1e30 單位：往返無損、dust 上界、任意 18 位分割後總兌付 ≤ 存入 |
| `contracts/test/settlement/WrappedUSDC18Invariant.t.sol` | 兩組不變量。(1) handler 隨機包裝、解包（含低於 1 單位、超過餘額、付給第三方）、18 位轉帳、router 存入未修改的 exchange、直接捐贈、切換暫停／黑名單／轉帳費；每一次呼叫都以獨立模型判斷「應成功或應 revert」並比對（`try/catch`，revert 邊界真的被打到）。不變量：I1、I2、I3（以觀察到的 USDC 流出與燒毀量核對 floor）、行為符合模型、不創造價值（`totalSupply + 已付×1e12 == 存入×1e12`）、USDC 守恆、持有人加總＝供給。(2) `HookedUSDC6` 底層加上會重入的攻擊者：I1、無重複 mint、誠實持有人永遠可足額兌付 |
| `contracts/test/settlement/WrappedSettlementIntegration.t.sol` | **未修改的 `PerpetualExchange`** 以包裝幣為結算幣：router 一筆存入（permit）→ 開倉 → 以非整數價格平倉（PnL 帶 1e-6 以下的精度）→ 提領 → 解包，核對 USDC 到帳＝floor、dust < 1e12；虧損平倉與清算（斷言清算者確實拿到獎勵、保險金確實入帳、獎勵可解包）；bailout floor 付給持有人、持有人被列名時被略過且平倉成功；USDC 暫停時交易照常、出金停在解包；被列黑名單的交易者不能提領但仍可被清算；列名前的入金凍結、解除後可領；exchange 被列黑名單時整個租戶凍結；router：未授權、受益人被列名、permit 被搶先、簽章與額度不可挪用、逐 selector 確認沒有代開／代平／代領路徑、fuzz 確認只記給受益人且不留餘額與額度 |

驗證結果見 §8。

## 6. 後續項目（本次不做）

`DeployTenant`／`VerifyTenant` 的整合**不小**，而且做一半會削弱 #228 的安全性質，所以這次只寫下來：

1. **設定 schema**：`shared.settlementToken` 在 8453／84532 改為「Circle 官方 USDC」（已在 `WELL_KNOWN_NON_PLATFORM` 白名單）並標示為**底層**；新增專屬欄位 `contracts.SettlementWrapper`、`contracts.SettlementDepositRouter`。`scripts/check-tenant-deploy.mjs:76-86`、`scripts/check-addresses.mjs:180,194`、`frontend/src/contracts/tenantDeployment.ts:51,96,196-205` 同步。兩個新位址自動進入「位址全集互斥」的列舉，不能與平台或其他租戶重複。
2. **`DeployTenant`**：先部署包裝幣（底層＝官方 USDC，preflight 改為檢查底層是 6 位、包裝幣是 18 位），以它作為所有合約的結算幣；部署 router；`setAgentAuthorized(router, true)`；交接後部署者不持有任何角色（包裝幣與 router 本來就沒有角色）。
3. **`VerifyTenant`**：逐位元組比對包裝幣與 router 的 runtime（含 immutable：`underlying`、`wrapper`、`exchange`）；讀回 exchange、保險金、FeeRouter、TraderStake、CopyTracker、金庫的 `usdc()` 全部等於該租戶的包裝幣；`authorizedAgents` 只允許 **{CopyTracker、AgentSessionManager、router}** 三者（今天的期望集合是前兩者，`DeployTenant.s.sol:220-221`、`VerifyTenant.s.sol:1253`；漏掉 AgentSessionManager 會讓 agent session 下單失效）；router 必須 ≠ `copyTracker()`；`wrapper.underlying()` 等於官方 USDC。
4. **前端**：錢包 USDC（6 位）餘額、router 存入、「換回 USDC」、包裝幣的標示；`wallet_watchAsset` 的 decimals 依實際代幣。
5. **agent／SDK／MCP**：新增 router 存入與解包的寫入函式（金額以 6 位 USDC 輸入）；既有保證金數學不變。
6. **監控**（ADR-009 的規則格式）：包裝合約 I1（`totalSupply` 對 USDC 餘額）、`isBlacklisted(wrapper)`／`isBlacklisted(exchange)`、USDC `paused()`（同時觸發前端提示與 Q10 的判斷）；以一個已知被列名的位址每天探測 `isBlacklisted` 仍可用（fail-open 的偵測）；**被列名位址在 exchange 上的開倉、平倉與跟單事件**（內部帳本不受 Circle 控制，見 §3.1 ②）；跨租戶事故分類加上「Circle 暫停」。
7. **x402**：不變（已有綁 6 位 USDC 的專用 FeeRouter）。若租戶要把 x402 收入併入以包裝幣記帳的 FeeRouter，結算 worker 要先包裝。
8. **AssetVault 的 USDC 入口**：鑄造合成資產目前要先持有包裝幣；需要時再為金庫加一個同型 router。
9. 8453 放行（Q9）。

## 7. 風險與限制

- 包裝合約不可升級：bug 只能以新包裝幣＋遷移處理。對策是極簡、不變量測試、外部稽核。
- Circle 把某租戶的包裝合約列入黑名單時，沒有鏈上手段可救；只能走發行方的法律程序。每租戶一顆是唯一能做的縮小影響。
- 黑名單鏡像只管包裝幣的轉帳邊界；合約內部帳本（freeMargin、績效費、清算獎勵）與原生 USDC 設計一樣不受 Circle 控制。以監控補足（§6 第 6 項）。
- USDC 暫停期間使用者無法從 USDC 補保證金、清算照常（§3.1，Q10）。
- I1 依賴 Circle 不以轉帳以外的方式減少包裝合約的餘額（負向 rebase、扣押）；這是對發行方的信任前提，合約無從自保。轉帳費與轉帳回呼兩種升級情境已 fail-closed／擋下。
- 黑名單鏡像的 fail-open 意味著：若 Circle 將來把 `isBlacklisted` 改名，鏡像會靜默失效（邊界仍由 USDC 自己把關，但「轉給乾淨地址再解包」的路會打開）。監控要每天以一個已知被列名的位址探測一次（後續項目 6）。
- 每次包裝幣轉帳多兩次對 USDC 的 `staticcall`（冷存取約 1 萬 gas、熱存取數千，Base 上可忽略，數字見 §8）。
- dust：每個持有人每次解包最多留下 < 1e-6 USDC，屬於持有人、可以累積後再解；加總永遠有足額 USDC 支撐。

## 8. 驗證紀錄（2026-10-02；10-03 依 PR #230 審查修正後重跑）

| 項目 | 結果 |
|---|---|
| `forge build --sizes`（`forge clean` 後） | `PerpetualExchange` **23,911 B**（不變，餘 665 B）；`WrappedUSDC18` **3,407 B**（審查前 3,175 B；ADR 初版誤寫 3,181。增加的是 `ReentrancyGuard`、嚴格 1:1 檢查與 `isUnderlyingBlacklisted`）；`SettlementDepositRouter` **1,782 B**（審查前 1,688 B） |
| 全量 `forge test`（`forge clean` 後） | 基準（master 17ec739）1091 passed／4 skipped → 本分支 **1149 passed／0 failed／4 skipped**（＋58：單元＋fuzz 29、整合 19、不變量 7＋3）。不變量每組 64 runs × 500 depth＝32,000 次呼叫；handler 以 `try/catch` 執行每一個呼叫並比對模型，所以呼叫表的 revert 欄為 0，但每輪實際打到約 205～215 次 revert 邊界（黑名單、暫停、轉帳費、低於 1 單位、超過餘額）。注意：`out/` 若留著 slither 產生的含 AST 產物，讀 `out/` 的租戶驗證測試會撞到 gas 上限而失敗（審查記錄 18 個）；先 `forge clean` |
| slither 0.11.6（`--exclude-dependencies --exclude-informational`，與 `contracts-ci.yml` 相同旗標） | 新合約 **0 個 high／medium／low**。10-02：在暫存複本修掉兩個 medium（`divide-before-multiply`、`incorrect-equality`）後，再對整個 `contracts/` 跑一次：本機 81 detectors 220 筆、CI 79 detectors 221 筆（差 1 筆來自 detector 版本），`src/settlement/` 都是 0 筆。10-03 修正後在暫存複本重跑：新增的 `isUnderlyingBlacklisted` 觸發一個 low（`missing-zero-check`，誤報：`account` 只是 view 探測的參數），以 `slither-disable-next-line` 加註理由後為 0。只剩 informational：`pragma`、`solc-version`、`low-level-calls`。CI 的 slither job 是 `continue-on-error` 且 `fail-on: none`，**綠燈不代表 0 筆** |
| gas（`--gas-report`，測試內冷存取） | 包裝幣 `transfer` 中位數約 61k（含兩次 USDC 黑名單探測）；`depositFor` 約 121k；`withdrawTo` 約 65k；router `depositMargin` 中位數約 189k、`depositMarginWithPermit` 約 226k（一筆完成 permit＋拉款＋包裝＋存入；含受益人黑名單探測） |
| gas snapshot | repo 不提交 `.gas-snapshot`；CI 的 gas job 是 `forge snapshot --check || forge snapshot` 且 `continue-on-error`，照慣例不新增檔案 |
| EIP-170 試算（§3.2） | 在 repo 外的暫存複本編譯，不進版控 |
| 審查 PoC（7 個，對修正後程式） | R1「重入雙重 mint」：攻擊失敗（PoC 斷言攻擊者拿到 1,500，實際只拿到 500，I1 成立）；R1 修正版、R2（限 gas 繞過黑名單探測）、R3 router 三項（無代開／代平／代領路徑、簽章與額度不可挪用、fuzz 不留餘額）：PASS；R4（被列名者經內部帳本移轉價值）：PASS，這是 §3.1 ② 已揭露的邊界，與原生 USDC 設計相同。PoC 不進 repo |
| 部署 | 無。沒有廣播、沒有任何鏈上交易 |

## 附錄 A：「保證金代幣 18 位」假設的盤點（master 17ec739）

分類：**金額**＝以結算幣（或合成資產）原始單位寫死的數量；**混單位**＝把結算幣單位與價格／ETH／其他代幣單位直接相乘或比較；**單位縮小**＝6 位時數量一致縮小 1e12、價值守恆，只影響顯示與精度；**顯示**＝數值正確但 `decimals()` 或說明與實際單位不符；**檢查**＝讀 `decimals()` 並要求 18；**腳本**＝部署／種子腳本的金額或上限；**不受影響**＝純定點數（價格、比例）或非結算幣。行號是 master 17ec739 的行號。採用 (a) 時，下列項目**全部維持原樣**；採用 (b) 時，標 ★ 的都要改。2026-10-03 依 PR #230 審查重新檢查了每一列的「會壞／不受影響」判斷（審查抽查 43 處，行號正確；錯在 AssetVault、InsuranceVault、CopyTracker 三處的推論，已更正）。

### A.1 合約（`contracts/src`）

| 位置 | 內容 | 分類 | 備註 |
|---|---|---|---|
| ★ `PerpetualExchange.sol:52` | `MIN_MARGIN = 10e18` | 金額 | exchange 唯一寫死的結算幣數量 |
| ★ `PerpetualExchange.sol:639-646` | `decimals() != 18 → InvalidParam` | 檢查 | 主網 USDC 在這裡被擋 |
| ★ `PerpetualExchange.sol:1792,1971,2020` | `notional * 1e18 / entryPrice` | 不受影響（精度） | `size` 繼承結算幣小數；6 位時截斷誤差見 §1 |
| `PerpetualExchange.sol:1724,2017,2035` | `rawPrice * 1e10` | 不受影響 | 8→18 位價格；L639 的註解說它「綁 18 位」，但數學是同質的 |
| `PerpetualExchange.sol:1962,2022,2095,1477,1515-1517,2075-2077` | OI 名目、PnL、資金費率、imbalance | 不受影響 | 結果都是結算幣單位或比例 |
| `PerpetualExchange.sol:71,135` | `1 ether`／`0.001 ether` | 不受影響 | 原生 ETH 執行費 |
| `PerpetualExchangeLens.sol:23-25` | `rawPrice*1e10`；`openSize*price/1e18` | 不受影響 | |
| ★ `InsuranceVault.sol:123,125` | 首存 1:1 份額，pIV 固定 18 位 | 顯示 | 6 位時份額是 6 位數量、`decimals()` 卻報 18，錢包與前端顯示差 1e12；份額比例與捐贈攻擊的經濟性質以價值計，與小數無關 |
| `InsuranceVault.sol:134-138` | `getSharePrice` 以 1e18 為 1:1 | 不受影響 | NatSpec「18-dec USDC per pIV」在 6 位時不正確 |
| ★ `TraderStake.sol:13` | `MIN_STAKE = 100e18` | 金額 | 6 位時等於 1e14 USDC，沒有人達得到。經 `isEligible`（`TraderStake.sol:139`）連帶讓 `StrategyRegistry.sol:112,174-176`（發布策略）與 `CopyTracker.sol:170`（被跟單資格）全部失效 |
| `MockUSDC.sol:9-10` | OZ 預設 18 位；`FAUCET_AMOUNT = 1_000e18` | 檢查／金額 | 測試網專用 |
| `MockUSDT.sol:9-12` | 註解「18 decimals to match the rest of the system」；`1_000e18` | 檢查／金額 | 測試網專用 |
| ★ `MockSwapRouter.sol:8,35,45,61,65` | `msg.value * RATE`、`usdcAmount / RATE` | 混單位 | wei × 匯率 = USDC 單位，只在 18 位成立（平台專用） |
| ★ `PepeAMM.sol:259,288,340,343,344` | `usdcReserve * 1e18 / ethReserve`、`usdc * 1e8 / eth` 對 oracle | 混單位 | 6 位時池價與 oracle 差 1e12，偏離取整後固定在 10000 bps：預設價帶下**兩個方向的 swap 全部被擋**（`PriceOutOfBand`）；把 `maxOracleDeviationBps` 設到 10000 才能交易，但等於關掉價帶保護（平台專用） |
| ★ `PepeIncentives.sol:120,186-188,220-222,310-312` | `margin*lev*bps` 直接當 PEPE 數量；等級門檻 `10_000e18` | 混單位／金額 | |
| ★ `AssetVault.sol:48-49,56,60` | `usdcAmount * 1e8 / price`／`tokenAmount * price / 1e8` | 單位縮小 | v1；mint 與 redeem 同一比例，合成資產數量一致縮小 1e12、mint→redeem 價值守恆；L48-49 的註解（兩者都 18 位）不再成立 |
| ★ `v2/AssetVaultV2.sol:235,243,308` | mint／redeem／liability | 單位縮小 | 同上；liability 與 reserve 同為 USDC 單位，準備率不失真 |
| ★ `v2/AssetVaultV2_1.sol:235,243,320,325` | 同上＋fallback 價 | 單位縮小 | |
| ★ `v2/AssetVaultV2_2.sol:230,238,310` | 同上 | 單位縮小 | |
| ★ `v2/AssetVaultV2_3.sol:289,297,379` | 同上 | 單位縮小 | |
| ★ `v2/AssetVaultV2_4.sol:348,378,476` | 同上 | 單位縮小 | |
| ★ `v2/AssetVaultV2_5.sol:488,518,651,572,665,802,863` | mint／redeem／liability；`reserve()` 是 USDC 餘額（L572），liability 是 `Σ outstanding × price / 1e8`（L651），同為 USDC 單位 | 單位縮小 | `DeployTenant` 用的版本；`reserveRatioBps`（L665,802,863）**不**失真；`agent/keeper/run.ts:604-605` 對兩者用同一除數，也印證這點。另見下一列真正會壞的地方 |
| ★ `v2/AssetVaultV2_5.sol:127,200,458,468,811,845` | `EXEMPT_DUST_UNITS = 1e15`（L200，用於 L458、L468）、`assetCap`（L127、L811、L845） | 金額 | 以合成資產**原始單位**寫死／設定：6 位時 1e15 個原始單位的價值放大 1e12 倍，dust 豁免上限形同失效，未定價資產的 liability 可被低估；`assetCap` 若照 18 位語意設定會鬆 1e12 倍。合成資產 `decimals()=18` 的顯示差 1e12；高價資產的 mint 取整損失變大 |
| `AgentSessionManager.sol`、`FeeRouter.sol`、`EsgRewardDistributor.sol` | — | 不受影響 | session 上限由使用者給；其餘只有 bps |
| `CopyTracker.sol:170`、`StrategyRegistry.sol:112,174-176` | 資格判斷呼叫 `TraderStake.isEligible` | 連帶失效 | 自身沒有常數，但經 `TraderStake.MIN_STAKE` 在 6 位時全部失效（見 TraderStake 列）；採 (a) 時不受影響 |
| `CarbonTiers.sol:74-81`、`ESGRegistryV2.sol:82`、`PepeStaking.sol:62,67`、各 oracle adapter、`GuardedOracle`、`MockOracle`、`PepeToken`、`PepeClaim` | — | 不受影響 | 定點數、價格或 PEPE |

### A.2 部署腳本（`contracts/script`）

| 位置 | 內容 | 分類 |
|---|---|---|
| ★ `DeployTenant.s.sol:138-147` | `require(dec == 18, "shared.settlementToken must have 18 decimals …")` | 檢查 |
| `DeployTenant.s.sol:179-180,266-267` | OI 上限 `/1e18` 日誌；`setMaxOpenInterest` | 腳本 |
| ★ `VerifyTenant.s.sol:343-351,428,746` | `capNonRwa * 1e18`（實際在 L350-351；L211-212 是欄位宣告）、`MAX_OI_CAP_USDC * 1e18`、`cap / 1e18`（TenantBase，`DeployTenant` 共用） | 腳本 |
| `VerifyTenant.s.sol:153` | `BASE_MAINNET = 8453` | — |
| `Redeploy130Hardened.s.sol:58-59,65-66,173-186,278-288,457-458`；`Verify130.s.sol:137,223-224` | session 上限 `1_000e18`／`3_000e18`；OI 上限 `*1e18` | 腳本（平台 cutover） |
| `RedeployExchange.s.sol:132-133,289`；`Redeploy129Exchange.s.sol:85-86,236`；`Redeploy102Exchange.s.sol:101-102,235` | session 上限 `e18`；`/1e18` 日誌 | 腳本（平台 cutover） |
| `DeployAMM.s.sol:52-53,65,92` | `SEED_USDC 2_300e18`；`seedUsdc * 1e8 / seedEth` | 腳本／混單位 |
| `Seed.s.sol`、`SeedMarket.s.sol:63-67,111-132`、`SeedWhales.s.sol:103-113`、`SeedWhaleCloses.s.sol:79,87`、`DemoE2E.s.sol:137-242` | 種子金額全部 `e18` | 腳本（測試網示範） |
| `Deploy.s.sol:33-59`、`DeployWithPyth.s.sol:184-192` | `new MockUSDC()` 接 exchange | 腳本 |
| `DeployX402Router.s.sol:9-13,29` | FeeRouter＋InsuranceVault 綁 6 位 USDC | 已是 6 位（x402） |

### A.3 agent（`agent/`）

| 位置 | 內容 | 備註 |
|---|---|---|
| ★ `sdk/src/format.ts:6,26` | `MARGIN_DECIMALS = 18`；`margin()` 格式化 | SDK 唯一常數，`index.ts:10` 對外匯出 |
| ★ `sdk/src/read.ts:355-363,392-393,444-447,461-467,505-508` | 部位、PnL、餘額、health、OI、session 上限 | `entryPrice`（L355）與 size 是價格／數量，不該用保證金格式化 |
| ★ `sdk/src/vc.ts:216` | `parseDecimal(s, MARGIN_DECIMALS)` 比對 VC 上限與鏈上 session | 6 位時一律 fail-closed |
| `sdk/src/write.ts:87,130,160`、`sdk/src/addresses.ts:43`、`sdk/README.md:78-121` | JSDoc／範例「18 位小數」 | 文件 |
| `sdk/test/live.test.ts:63` | 斷言 `decimals() == MARGIN_DECIMALS` | 唯一的鏈上小數檢查（在測試裡） |
| ★ `shared/src/write.ts:247,249` | VC 上限 `parseUnits(…, 18)` 比對 | fail-closed |
| ★ `shared/src/write.ts:391` | `margin = parseUnits(String(params.marginUsdc), 18)` | **上鏈的開倉金額**；6 位時大 1e12 倍 |
| ★ `shared/src/write.ts:732-734` | `getSession()` 的 `formatUnits(…, 18)` | MCP `get_session`、x402 範例 |
| ★ `shared/src/format.ts:3-5` | `fmtUsdc18` | `aggregate.ts:271-272,319-328` 全部經過它 |
| `shared/src/policyGate.ts`、`signingGuard.ts:88,179`、`tg-bot/index.ts:92-93,171-177`、`mcp-server/src/writeTools.ts:389` | 人類單位（整數 USDC） | 與小數無關，靠 `write.ts:391` 換算 |
| ★ `mcp-server/src/index.ts:148` | `formatUnits(p.margin, 18)` | |
| ★ `x402_agent.ts:272` | `formatUnits(spentMargin/totalMarginBudget, 18)` | 保證金，不是 x402 |
| ★ `signal-api/src/exposure.ts:195,377-382` | `fmt18` | L20,414 的說明字串會回給 client |
| `signal-api/src/exposure.ts:334-338,456`、`settlement.ts:242-243`、`onchainRevenue.ts:44-52` | 動態讀 `decimals()` | 正確寫法 |
| ★ `keeper/run.ts:604-605` | `Number(reserve) / 1e18`、`Number(liability) / 1e18` | 只有日誌：兩者同一除數，比率正確，6 位時只有印出的絕對金額差 1e12 |
| 測試 fixture：`sdk/test/{read,write,vc}.test.ts`、`examples/fixtures/fakeRpc.ts:49`、`examples/signing-guard.test.ts:48`、`examples/session-events.test.ts:43`、`signal-api/src/exposure.test.ts:23-99` | `E18`、`10n**18n` | |

### A.4 前端（`frontend/src`）

約 40 個非測試檔、約 190 處；代表性位置：

| 類別 | 位置 |
|---|---|
| ★ 輸入 → 上鏈金額（約 13 處） | `sections/terminal/types.ts:51`（`parseEther`，`AccountPanel.tsx:45,52`、`OrderTicket.tsx:124` 共用）；`pages/pepefi/VaultPage.tsx:196,217,373,375,418`；`SessionsPage.tsx:314-315`；`CopyPage.tsx:65`；`PortfolioPage.tsx:150`；`TraderStakePage.tsx:82,99`；`TokenizedAssetsPage.tsx:303,334`；`components/pepefi/AllocationMarketplace.tsx:287`；`AdminTreasuryPage.tsx:245,258`；`lib/pepefi/ammPoolView.ts:344` |
| ★ 顯示（約 30 個呼叫點） | `lib/pepefi/format.ts:58-59`（`f18`，約 12 頁引用）；`AccountPanel.tsx:66,79,82,122`；`OrderTicket.tsx:250,252,282`；`PositionsTable.tsx:101,125`；`FillsTable.tsx:66`；`FundingTable.tsx:88-89`；`MarketActivity.tsx:34-35,99,121`；`TerminalView.tsx:111-112`；`MarketStatsBar.tsx:131,140`；`HeroKpiStrip.tsx:134`；`AgentMonitorPage.tsx:103,287-288`；`ExchangePage.tsx:77`；`HistoryPage.tsx:371,387`；`CopyPage.tsx:68,70,337,563,575,582`；`PortfolioPage.tsx:124,126,555-556`；`leaderboardMetrics.ts:171-213`；`whale.ts:130,140`；`AssetDetailPanel.tsx:203` |
| ★ 常數／設定 | `lib/pepefi/whale.ts:23,41-48`；`TraderStakePage.tsx:48`；`ammPoolView.ts:112,229`；**`ExchangePage.tsx:564` `wallet_watchAsset … decimals: 18`** |
| 租戶登記 | `contracts/tenantDeployment.ts:51,96`（`DEDICATED_CHAIN_ID = 84532`）、`:196-205`（結算幣必須是平台 MockUSDC） |
| 正確寫法 | `lib/pepefi/legacyExchange.ts:42`（讀鏈上 `decimals()`） |
| 不受影響 | 執行費（ETH）、PEPE、合成資產、8→18 位價格 |

### A.5 檢查器、監控、workflow

| 位置 | 內容 |
|---|---|
| `scripts/check-tenant-deploy.mjs:67` | `ALLOWED_CHAIN_IDS = [84532, 8453]`（schema 層允許 8453） |
| ★ `scripts/check-tenant-deploy.mjs:76-86,355-360` | `SHARED_ALLOWED_ROLES.settlementToken = ["MockUSDC"]`——**8453 實際被擋在這裡**（主網沒有平台的對應元件）；`:390,396` 主網 oracle 規則；測試 `check-tenant-deploy.test.mjs:671-677` |
| ★ `scripts/check-addresses.mjs:180,194` | `DEDICATED_CHAIN_IDS = [84532]`；`SettlementToken → MockUSDC`（測試 `:225,305`） |
| `scripts/check-monitoring.mjs:62-68,427-428,1243-1259` | 代幣小數表（MockUSDC 18、USDC 固定 6）；規則小數對鏈上快照 |
| `scripts/verify-dedicated-tenants.mjs:32` | 8453 RPC 對照 |
| ★ `ops/monitoring/monitors.json:2326,2383,2432,2495,2549,2645,2830,2902,2944` | 9 條 MockUSDC 規則 `"decimals": 18`（`:2869` 是 PEPE，`:2598` 是 x402 的 6） |
| `ops/monitoring/deployed.json:231`、`rules.md:52-58,634-719`（12 行） | 快照與產生的說明 |
| `ops/monitoring/params.mjs:50-69`、`engine.mjs` | 門檻是整數 USDC，依規則小數換算——與小數無關 |
| `.github/workflows/*` | 無結算幣小數假設（`cast from-wei` 只用在 ETH） |

### A.6 文件

`docs/TENANT_DEPLOYMENT.md:88-91,317`；`docs/ADR-008-tenant-isolation.md:44,154,174`；`docs/INTEGRATION_GUIDE.md:38`；`docs/RISK_NOTES.md:163-164`；`docs/RISK_MODEL.md:136`；`docs/DEPLOY_129_CUTOVER.md:283`；`docs/RUNBOOK_SITE_HEALTH.md:75`；`docs/RUNBOOK_KEY_ROTATION.md:79-80,194,199`；`docs/CAPSTONE_DELIVERABLES.md:67,74`；`docs/VERIFICATION_REPORT.md:18-19,68,74,95`；`agent/README.md:65-72,88`；`agent/examples/x402-autotrade.md:17`；歷史計畫 `docs/superpowers/plans/2026-07-26-pepefi-professor-requirements.md`（「all use 18 decimals」）。

### A.7 數量摘要

| 類別 | 數量 | (a) 要改 | (b) 要改 |
|---|---|---|---|
| 合約（不含 mock） | exchange 2＋精度 3；周邊：AssetVault 家族 7 版（單位縮小，會壞的是 dust 豁免、cap、顯示與精度）、TraderStake（連帶 StrategyRegistry／CopyTracker）、PepeAMM、MockSwapRouter、PepeIncentives；InsuranceVault 只有顯示 | 0 | 全部 |
| 部署腳本 | `DeployTenant`／`VerifyTenant` 7 處；平台 cutover 5 支；種子／示範約 45 處 | `DeployTenant`／`VerifyTenant` 整合（§6） | 全部 |
| agent | 約 25 處程式碼＋約 10 個測試檔＋文件 | 新增 router／解包函式 | 約 25 處改為讀 `decimals()` |
| 前端 | 約 40 檔、約 190 處 | 新增存入／解包流程與標示 | 約 190 處 |
| 檢查器 | 3 支約 20 處 | §6 的 schema 整合 | 同左＋小數 |
| 監控 | 9 條規則＋快照＋12 行說明 | 新增 3 條 | 9 條改小數 |
| 文件 | 約 15 檔、約 40 行 | 更新結算幣說明 | 同左 |
| x402 | — | 不受影響 | 不受影響 |
