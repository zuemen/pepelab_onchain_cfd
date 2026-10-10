---
status: proposed（原始碼、測試與部署腳本已在 PR；未部署）
date: 2026-10-10
issue: "#105（#93 的可犧牲項）"
---

# 碳權退役：平台收款人換成分流合約，FeeRouter 一行不改；被銷毀的碳權是模擬的，而且這件事寫在鏈上、README 與畫面上

#105 要把平台手續費收入的一部分導向碳權退役——整個系統唯一一處對真實世界宣稱有影響的地方。兩個限制同時成立：

1. **`FeeRouter` 不能改。** `PLATFORM_SHARE_BPS = 2000` 與 `VAULT_SHARE_BPS = 1000` 是 `constant`，
   `platformTreasury` 是 `immutable`，70/20/10 的外觀與既有四份 FeeRouter 測試必須原樣通過；
   `PerpetualExchange.PERFORMANCE_FEE_BPS = 1000`（配置發布者績效費）也不動。
2. **Base Sepolia 上沒有真實碳權。** 跨鏈接主網 Toucan／KlimaDAO 不在期程內。標的只能是我們自己鑄的代幣，
   而 issue 的要求是：這件事必須**同時**寫在合約 NatSpec、README 與使用者畫面上——是實作，不是文件工作。

## 決定

新增三顆合約，`FeeRouter.sol` 與它的測試一個 byte 都不改：

| 合約 | 職責 |
|---|---|
| `MockCarbonCredit` | **模擬碳權**（ERC-20，`1e18`＝標示為 1 公噸 CO2e）。只有 owner（扮演登錄機構）能 `issue`；任何持有者都能 `burn`，`totalBurned` 計入每一筆銷毀，`totalSupply == totalIssued − totalBurned`。 |
| `CarbonRetirement` | `retire(amount)`：用自己持有的結算幣預算，以固定價格向固定賣方買入碳權，**同一筆交易內銷毀**，發出 `CarbonRetired(amount, tonnesCO2e, timestamp)`，並把每一筆存進鏈上清單（`getRecentRetirements` 由新到舊分頁）。 |
| `PlatformFeeSplitter` | 坐在 `FeeRouter` 的平台收款人位置（router 以它為 `platformTreasury` 部署）。`distribute()` 從 router 領出平台份額，固定 `carbonShareBps` 撥給 `CarbonRetirement`、其餘給真正的 treasury。 |

分流靠的是「**平台收款人是誰**」，不是改 router 的比例：router 照舊算 70/20/10，20% 照舊記在
`platformEarnings`，只是 `withdrawPlatformFees` 的唯一收款人換成了分流合約。

### 不可裁量

比照 [ADR-003](./ADR-003-carbon-priced-capital.md)「常數不是參數」的立場：

- 三顆合約都沒有 owner 可以改錢的去向。`carbonShareBps`、`treasury`、`carbonRetirement`、`seller`、
  `pricePerTonne` 全部 `immutable`。要改任何一個就是一次新的、看得見的部署。
- `FeeRouter.withdrawPlatformFees` 只付給 `platformTreasury`，所以 treasury **沒有任何繞過碳權份額**
  拿到平台份額的路徑（測試 `test_treasuryCannotWithdrawPlatformShareDirectly` 釘住）。
- 唯一的特權步驟是 `bindFeeRouter`：router 與 splitter 各需要對方的位址，所以由 splitter 的部署者呼叫
  **一次**，並檢查 router 的 `platformTreasury` 真的是這顆 splitter、結算幣相同。
- `distribute()` 與 `retire()` 都是 permissionless：任何 keeper 或使用者都能觸發，但只能決定**何時**、
  **多少**，不能決定錢去哪裡。
- 買入與銷毀是原子的：`CarbonRetirement` 在交易之間永遠不持有碳權（invariant 釘住），買到的碳權沒有機會
  被轉賣或挪用而不是被退役。

`carbonShareBps` 用 immutable 而不是 `constant`：不同部署（平台、x402 收入 router、租戶）可以在部署時
選不同比例，部署之後就不能動。部署腳本預設 **2500 bps**（平台 20% 的四分之一＝每筆手續費的 5%），
最終數字由擁有者決定。

### 誠實聲明怎麼實作

聲明不是一段散文，而是三層都有、且有測試釘住：

| 位置 | 內容 | 釘住的測試 |
|---|---|---|
| 合約 NatSpec | 兩顆合約的 `@notice` 都以 SIMULATED／模擬碳權開頭，並寫明「賣方是本專案控制的地址，購買款沒有流向真實專案」 | — |
| 鏈上可讀 | `MockCarbonCredit.name()` = `Mock Carbon Credit (SIMULATED, not a real offset)`（每個錢包與區塊瀏覽器都會顯示）；兩顆合約都有 `SIMULATED = true`；`CarbonRetirement.DISCLOSURE` 是一段以 `SIMULATED` 開頭的完整聲明 | `CarbonRetirement.t.sol` 的 `test_disclosure_*` |
| README | §3.3 與 §5 各一句，比照既有「受信任的中繼，不是去中心化預言機」的寫法 | — |
| 畫面 | ESG 頁的「碳權退役紀錄」卡片：標題旁「模擬碳權」chip、標題下方**不可收合、不可關閉**的警示框；讀取中、讀取失敗時一樣顯示，不依賴合約讀數。合約若回報 `SIMULATED() == false`（位址指錯合約），畫面當成讀取異常，而不是拿掉聲明 | `frontend/src/lib/pepefi/carbonRetirement.test.ts` |

## Considered options

**直接改 `FeeRouter`，多切一份碳權份額（例如 70/18/10/2）。** 最直接。否決：比例是 `constant`，
改了就是改 70/20/10 的外觀、改既有測試，而且 `platformTreasury` 是 immutable，router 本來就得重新部署——
改原始碼沒有省下任何部署，只多了一個被改過的已審查合約。

**treasury 自己定期把一部分轉給退役合約。** 不需要任何新合約。否決：那是一個營運方可以某個月忘記、
或悄悄停掉的承諾——正是本專案主張要從「機構的承諾」變成「合約的不變量」的那種東西。

**退役時當場鑄造再銷毀（mint-and-burn）。** 不需要賣方與庫存。否決：碳權憑空出現又憑空消失，
`totalSupply` 永遠不動，「退役讓有限供給減少」這件事在鏈上就看不出來；主網路徑也不是這樣運作。
現在的作法是庫存先發行給賣方、退役時從賣方買入再銷毀，退役會真的讓流通量變少。

**`distribute()` 裡直接呼叫 `retire()`。** 少一步。否決：賣方庫存或授權不足時 `retire` 會 revert，
連帶 treasury 也領不到錢。分開之後，預算先安全地撥進退役合約（`budget()` 公開可讀、畫面顯示為
「待退役預算」），退役由任何人另外觸發。

**分流比例、價格、賣方做成 owner 可設定。** 更靈活。否決，理由同 ADR-003：可以被營運方調整的比例
就是一條可裁量的政策。

## Consequences

- **現行 Base Sepolia 的 FeeRouter 接不上。** 它的 `platformTreasury` 是 immutable、`CopyTracker` 的
  `feeRouter` 也是 immutable，所以分流只能用在**新部署**的 router。兩條路：
  1. **x402 收入 router**（`DeployCarbonRetirement.s.sol` 的預設，`CARBON_DEPLOY_ROUTER=true`）：部署一組
     獨立的 `InsuranceVault` + `FeeRouter`（收款人＝splitter），與 `DeployX402Router.s.sol` 同一個模式。
     要生效只需擁有者把 agent 的 `X402_FEE_ROUTER` 指過去——沒有 immutable 的下游。
  2. **下一次平台或租戶部署**：`CARBON_DEPLOY_ROUTER=false` 只部署三顆新合約，把 splitter 位址當成新
     FeeRouter 的 treasury（例如租戶設定的 `treasury`），部署後由同一個 broadcaster 呼叫 `bindFeeRouter`。
- **測試網上，購買款等於繞一圈回到營運方。** 模擬賣方是本專案控制的地址。這不影響機制的可驗證性
  （份額、時間、銷毀都在鏈上），但「平台為此付出了成本」在測試網上**不成立**——畫面與 NatSpec 都明說。
- **主網路徑**：把 `MockCarbonCredit` + 固定賣方換成真實的碳權池或退役聚合器，`CarbonRetirement` 的
  「買入」那一步要換成一次 swap／退役呼叫；`PlatformFeeSplitter`、預算模型與 `CarbonRetired` 事件不變。
- **捨入**：splitter 的碳權份額向下取整、treasury 拿精確餘數，兩者相加永遠等於總額；退役的公噸數向下取整，
  零頭跟著整筆金額付給賣方，所以 `amount` 就是預算實際減少的數字、也就是事件寫的數字。
- **小數位**：`pricePerTonne` 以結算幣最小單位計，6 位（x402 的 USDC）與 18 位（MockUSDC）同一份程式碼（ADR-011）。
- **鏈上清單**：`retire` permissionless，任何人都能以極小金額新增紀錄（需支付 gas，且金額必須至少買到
  1 個最小單位）。畫面由新到舊分頁讀最近 10 筆，不受清單長度影響。
- **前端**：位址不進 `addresses.ts`。`frontend/src/contracts/carbonRetirement.ts` 讀 `VITE_CARBON_RETIREMENT`
  或 per-chain 表（目前為空）；沒有位址時 ESG 頁的退役區塊**整塊不渲染**，不出現「尚未部署」字樣
  （`frontend/CONTEXT.md` 的 The Vault 詞條）。

## 需要人做的事

1. 決定 `carbonShareBps`、模擬價格與模擬賣方地址。
2. 執行 `DeployCarbonRetirement.s.sol`（先 dry-run）；賣方不是 broadcaster 時，由賣方對 `MockCarbonCredit` 送 `approve`。
3. 走上面兩條路之一接上收入；設定前端 `VITE_CARBON_RETIREMENT`（或把位址填進 per-chain 表，走 PR）。
4. 視需要讓 keeper 定期呼叫 `distribute()` 與 `retire(budget())`；兩者都 permissionless，不需要特權金鑰。
