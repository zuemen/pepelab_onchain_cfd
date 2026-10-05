# InsuranceVault 份額定價：virtual shares（P1-05）

> 狀態：**原始碼已修正，待部署**（分支 `contracts/insurance-vault-virtual-shares`）。
> 已部署的兩顆 InsuranceVault（Base Sepolia 主金庫 `0xB364…D812`、x402 FeeRouter 的收款金庫 `0xc7af…7b9f`）仍是舊版，見 §5。
> 與 [ADR-012](ADR-012-junior-buffer-tranches.md)（分層保險金庫，proposed）的關係見 §5.0。

## 1. 問題

舊版用 `shares = amount × totalSupply / totalAssets` 定價，沒有任何 offset。供給很小的時候，任何協議流入（`depositFromProtocol`：交易手續費分成、清算殘值、跟單績效費分成）都會把單一份額的價格推得很高，之後的存款因為向下取整而少拿份額，差額歸既有持有人。2026-09-29 起「取整到 0 份額」會 revert（`ZeroShares`），但取整到少量份額時的損失仍在，而且推高價格的一方可以從中獲利。KNOWN_LIMITATIONS #25 記的就是這件事。

## 2. 設計：decimals offset + virtual shares / virtual asset

採用 OpenZeppelin ERC-4626 的 `_decimalsOffset` 構造（不繼承 ERC4626，保留現有的介面、事件、錯誤與 `totalAssets` 明確記帳）：

```
shares = amount × (totalSupply + 10^6) / (totalAssets + 1)    向下取整
assets = shares × (totalAssets + 1) / (totalSupply + 10^6)    向下取整
```

- `DECIMALS_OFFSET = 6`。`decimals() = 資產 decimals + 6`：MockUSDC（18）→ 24；6 位 USDC → 12。資產 decimals 在建構時讀一次，讀不到當 18（與 OZ 相同的容錯）。
- 空金庫時 1 枚完整 USDC 換 1 枚完整 pIV。
- `getSharePrice()` 仍是「實際總額 ÷ 實際供給」換算成每 1 枚完整 pIV 的資產最小單位：MockUSDC 上是 18 位小數，6 位 USDC 上是 6 位小數；空供給回傳 1.0。它**不含 virtual 份額**，在 §3.3 的狀態下會高估持有人可贖回的金額，所以前端顯示改用 `previewWithdraw` 的同一條公式（§5.3）。
- `totalAssets` 仍是實際記帳餘額。virtual asset 只出現在兩個換算式裡。PerpetualExchange 讀 `totalAssets()` 決定 bailout 能補多少，這個數字不受影響，介面 `IInsuranceVaultPerp` 不變。
- 保留：`ZeroShares`（存款小於一個 share unit 的價值時拒收）、`VaultInsolvent`（H-4：bailout 把資產抽到 0 而份額還在時拒收存款，靠 `recapitalize` 或協議流入恢復）、`InsufficientVault`。

### 為什麼選 virtual offset，不選 dead shares

| | virtual offset（採用） | dead shares（首存時鑄給死地址） |
|---|---|---|
| 保護從何時開始 | 部署起就有，不依賴誰先存 | 要等第一筆存款，且首存者要付死份額的成本 |
| 全部提光後 | 仍有效（virtual 永遠在） | 有效（死份額留著） |
| 供給為 0 時累積的流入 | 下一個存款者拿不走，但也**永久歸 virtual 份額**（§3.3），所以部署時要先存種子（§5） | 首存者可拿走 |
| 對 decimals 的影響 | 份額 decimals +6，顯示端要讀 `decimals()` | 不變 |
| 證明 | 封閉式上界（§3），OZ 有公開分析 | 依死份額數量而定，首存者成本落在使用者身上 |

offset 取 6：virtual 份額數 10^6 讓推高價格的成本是可造成損失的約 10^6 倍（§3.2）。

**溢位的前提。** 在份額價格沒有被 bailout 壓到接近 0 的狀態下（`totalAssets × 10^6 ≥ totalSupply`，也就是 1 個資產最小單位至少換得到 10^6 以內的 share unit），1e36 資產單位（10^18 枚 USDC）以內的存款 `Math.mulDiv` 不會溢位，測試涵蓋到這個量級。若 bailout 兩次都恰好只留下極少量資產（shortfall 剛好等於 `totalAssets − 1` 這類情況），份額價格被壓到接近 0，大額存款的份額數會超過 uint256 而 revert；小額存款仍可用。這時由 owner `recapitalize` 補回資產即可恢復（`test_priceCrushedTwice_largeDepositOverflows_recapitalizeRecovers`）。舊版公式也有同樣的問題，只是多一輪才會發生。

## 3. 性質與上界

記 V = 10^6，c = (totalAssets + 1) / (totalSupply + V)，也就是一個 share unit 的贖回價（實數）。

### 3.1 取整方向一律對金庫有利

兩個換算都向下取整，所以任何狀態下（包含 bailout 降價之後）存入 a 再贖回同一批份額，拿回的不超過 a：
`s = ⌊a(S+V)/(A+1)⌋ ⇒ s(A+1) ≤ a(S+V) ⇒ s(A+a+1)/(S+s+V) ≤ a`。
存款與提款也都不會降低其他持有人的 c（向下取整的餘數留在金庫）。單一持有人能拿回的永遠 ≤ `totalAssets`，因為 S/(S+V) < 1。

### 3.2 早期小額持有人 + 協議流入 + 後續存款者

**單一後續存款者。** 設早期持有人在空金庫存入 x，之後協議流入 D（不論誰付），之後另一人存入 v，最後兩人都贖回。以「拿回 − (x + D)」為早期持有人淨額 P：

- **P ≤ 1 wei**（資產最小單位：MockUSDC 為 1e-18 USDC，6 位 USDC 為 1e-6 USDC）；早期持有人先贖回時 **P ≤ 0**。P = 1 只可能在 D 幾乎為 0（c < 1/(V−1)）時發生，此時沒有任何價格被推高，那 1 wei 是後存者的提款取整餘數。
- 後續存款者的損失 < c + 1 wei，也就是不到一個 share unit 的價格。
- 早期持有人的損失 ≥ (V − 1) × 後續存款者損失 − V。換句話說，要讓別人少拿 1 單位，自己至少要先丟掉約 10^6 單位。

**一般情況（多次他人存提）。** 「≤ 1 wei」只對單一後續存款者成立。其他持有人每做一次存款或提款，取整餘數都會留在金庫、按比例歸所有持有人，所以持有大部分份額的人每次最多收到**不到一個 share unit 的價格加 1 wei**。在正常價格（c ≈ 1/V，沒有人推高）下，N 次他人存提最多讓大持有人累積約 N wei（`test_manyLaterRoundTrips_holderCollectsAtMostOneRemainderEach`：200 次 round trip，約 200 wei）。推高價格仍然虧錢：把 c 推高本身要先付出約 V·c，而之後每次他人存提只帶回 < c + 1 wei（`test_manyLaterRoundTrips_afterPriceRaise_holderStillLoses`；隨機交錯存提、流入、bailout 的 fuzz 斷言早期持有人淨額 ≤ 他人操作次數 + 1 wei）。

推導：早期持有人的份額價值恆等於 `(A+1) − 其他人份額價值 − V·c`。V·c 是 virtual 份額吸走的部分，且 c 從空金庫開始是 1/V、只會被流入與取整推高（bailout 才會降，但 bailout 由交易所在虧損時觸發，不是可以免費操控的流入）。代入「後存者的取整損失 < 存款當下的 c ≤ 之後的 c」即得單一後存者的三條。實際上 D 只能經由交易手續費、清算罰金或跟單績效費進來，付出的成本還高於 D 本身。直接轉帳給金庫的代幣完全不計入 `totalAssets`，不影響價格。

### 3.3 virtual 份額是一個永久、無人控制的 LP

virtual 份額（10^6 個 share unit，對應 1 個資產最小單位）在帳上就像一個永遠不會提領、也沒有人能操作的 LP：

- 它按比例分到**之後所有的**收益，也按比例承擔 bailout。
- 正常情況下它的比例是 V/(S+V)：只要真實 LP 存了正常金額（≥ 0.001 USDC，S ≥ 1e21），這個比例 ≤ 1e-15，可以忽略。
- **供給為 0 時進來的資產全部歸它。** 若 `totalSupply == 0` 而 `totalAssets = A > 0`（全部 LP 退出後的取整殘值、沒有 LP 時收到的手續費、或在沒有份額時呼叫 `recapitalize`），下一個存入 a 的人拿到 `aV/(A+1)` 份額，可贖回的剛好約 a，拿不走 A。從此 virtual 份額持有 A，並按 A 的比例分走之後的收益。例：沒有 LP 時流入 1,000 USDC，之後 LP 存 1,000 USDC、再流入 1,000 USDC，LP 只拿回約 1,500 USDC，另外 500 歸 virtual 份額。
- 這筆 A 仍計入 `totalAssets`。**若金庫有接 exchange**，它仍可被 bailout 用掉，仍是保險金；**若 `exchange == 0`**（沒有 bailout），它永遠無法離開金庫，任何人（包括 owner）都取不回，合約沒有 sweep，`recapitalize` 只能加錢（`test_inflowAtZeroSupply_staysWithVirtualShares_noExchange`）。
- 供給為 0 時 A 越大，一個 share unit 的價格 c ≈ A/V 越高，`ZeroShares` 的門檻也跟著升高。

因此任何新版金庫都要**先存種子資金、讓供給 > 0，才接上任何會流入的來源**（`setFeeRouter`、`setExchange`），而且種子份額要保留到金庫停用為止（§5）。先存種子再流入時，流入歸種子持有人，種子可以隨時提回（`test_seedBeforeInflow_seedHolderEarnsInflowAndCanExit`）。

## 4. 測試

| 檔案 | 內容 |
|---|---|
| `contracts/test/InsuranceVaultShares.t.sol` | 早期持有人＋流入＋單一後存者的 fuzz（對 x、D、v、贖回順序 fuzz，斷言 §3.2 三條上界）；多次他人存提（200 次 round trip、推高後 50 次）與隨機交錯 fuzz；直接轉帳不改價格的 fuzz；任意狀態下 round trip 不獲利、不稀釋他人的 fuzz（含 bailout 降價）；多人存提、bailout 後存提、全部提光後重來、抽到 0 後 `recapitalize`；供給為 0 時流入歸 virtual、先存種子再流入；價格被壓到接近 0 時大額存款溢位與 `recapitalize` 恢復；0、1 wei、1e36 與溢位邊界；decimals 隨資產變化 |
| `contracts/test/InsuranceVaultInvariant.t.sol` | 隨機序列（存、提、協議流入、bailout、recapitalize、直接轉帳、份額轉讓）下的不變量：份額總值 ≤ `totalAssets`、逐人加總 ≤ `totalAssets`、`totalAssets` 有實際餘額支撐、記帳等式、顯示價不低於實際贖回價。handler 對每個金庫呼叫做 try/catch：可預期的拒絕（`VaultInsolvent`、`ZeroShares`、價格被壓到接近 0 時的溢位）事先過濾或分開計數，其餘 revert 記入 `unexpectedReverts` 並由不變量斷言為 0；逐次呼叫的性質（不憑空產生價值、不稀釋他人、結果等於 preview）也以計數器斷言。所有不變量開啟 `fail-on-revert` |
| `contracts/test/InsuranceVault.t.sol` 等既有測試 | 份額數量改以 `10^6` 倍的新尺度斷言，見 PR 說明中的逐項對照 |

## 5. 部署與遷移（只寫流程，本分支不部署）

### 5.0 與 ADR-012 的關係：cutover 只做一次

[ADR-012](ADR-012-junior-buffer-tranches.md)（proposed）規劃以 `TranchedInsuranceVault` 取代 InsuranceVault：新租戶改部署分層金庫，平台的 pIV 持有人轉成 senior 份額；它的份額會計同樣採 ERC-4626 式虛擬份額。本版 InsuranceVault 是**過渡版本**：

- **租戶**：ADR-012 的實作（其 §5 階段 1、2）完成前，`DeployTenant.s.sol` 部署本版 InsuranceVault；之後改部署 `TranchedInsuranceVault`。
  `DeployTenant.s.sol` 在接線前就存入 1 顆完整結算代幣作種子，份額歸租戶 treasury（§3.3；`VerifyTenant` 讀回）。
- **平台（租戶零）**：LP 遷移只做一次。若下一次 exchange／CopyTracker cutover 時 ADR-012 階段 1 已完成，平台直接遷到 `TranchedInsuranceVault`，**不再部署本版**；否則部署本版，之後分層金庫上線時再依 ADR-012 §4.4 轉換。
- `TranchedInsuranceVault` 應沿用本文的 offset、種子與遷移規則（§3.3、§5.1）。

### 5.1 參照與重部署範圍

InsuranceVault **不可升級**（`new InsuranceVault(usdc)`，非 proxy），新版要重新部署才生效。參照它的合約：

| 合約 | 參照方式 | 換金庫時要做的事 |
|---|---|---|
| PerpetualExchange | `setInsuranceVault`（owner） | 改指向新金庫 |
| FeeRouter（V1、x402 各一顆） | `insuranceVault` 是 **immutable** | 要換金庫就要重部署 FeeRouter |
| CopyTracker | `feeRouter` 是 **immutable** | 換 V1 FeeRouter 就要重部署 CopyTracker（以及引用 CopyTracker 的 `TraderStake.setCopyTracker`、交易所授權） |

因此建議**併入下一次 exchange／CopyTracker cutover**（同 `DEPLOY_130_CUTOVER.md` 的流程）一起做，不單獨跑一輪。

### 5.2 種子資金

| 項目 | 主金庫（V1，接 exchange） | x402 金庫 |
|---|---|---|
| 是否換新版 | 換（見 §5.0） | **不換**，理由見下 |
| 種子由誰出 | 平台金庫地址（部署者 EOA 或平台 Safe）。`deposit` 不需要權限，不必經 timelock；若改由 timelock 出資，要提案 `approve` + `deposit`，多等 48 小時 | 平台金庫地址 |
| 金額 | 至少 1 USDC，**用新資金**，不可從舊金庫提領：舊金庫在 `setInsuranceVault` 執行前仍在保護交易（§5.3 第 4 步）。協議在舊金庫的部位等 `setInsuranceVault` 執行後才搬（§5.3 第 5 步的第 3 小步） | 至少 1 USDC |
| 能否取回 | 能。種子就是一般份額，按比例分收益與 bailout，隨時可 `withdraw`。但**要保留到金庫停用**：全部提光會讓供給回到 0，之後的流入又會永久歸 virtual 份額 | 能，同左 |

**x402 金庫不換新版的理由：** 它的 `exchange` 是 0 位址（`DeployX402Router.s.sol` 只呼叫 `setFeeRouter`，ADR-012 §1.3 也寫明它不替 exchange 吸收缺口），不做 bailout，也沒有外部 LP。virtual shares 保護的是「後續存款者」，在這顆金庫上帶不來好處；反而在 `exchange == 0` 時，供給為 0 的流入會永久鎖死（§3.3）。建議維持舊版，由平台存入種子、持有份額，讓 x402 收入的 10% 歸平台份額並可提回。若將來 x402 金庫要開放外部 LP，屆時依 §5.3 的順序換新版（先種子、再 `setFeeRouter`）。

### 5.3 主金庫遷移順序（治理移交後，owner 操作都經 timelock，延遲 48 小時）

前提：
- **OI 上限是 owner 寫入的靜態參數**（`setMaxOpenInterest`，DEPLOY_130 §3.1 離線算好後寫入），不會隨 `totalAssets` 自動變化。保險金減少時，上限不會自己下調。
- V1 FeeRouter 的 `routeExternalRevenue` **不需要任何權限**：新金庫一旦 `setFeeRouter`，任何人都能讓錢流進來。所以接線一定要在存完種子之後（§3.3）。
- `recapitalize` 只在新金庫已有種子份額之後才使用；供給為 0 時呼叫，錢會永久歸 virtual 份額。

前提（續）：
- 本流程用到 `setAssetMode`、`marketOperator`、`setMaxOpenInterest`。現行鏈上 exchange（`0x827e…`）的 bytecode 沒有這些函式，**本流程要等 #130 cutover 之後的新 exchange 才能使用**。
- **部署者金鑰風險**：第 2 步存入種子後、第 3 步移交 timelock 前，新金庫的 owner 是部署者；這段期間部署者金鑰若外洩，可以 `setExchange` 換成自己的地址，再呼叫 `bailout` 提走種子。所以第 1～3 步與 `transferOwnership` 要在**同一次 script broadcast** 內完成，結束後立刻讀回核對 `owner()`、`exchange()`、`feeRouter()`。

步驟：

1. **部署新金庫**（與需要重部署的 FeeRouter／CopyTracker 同一批）。此時 `feeRouter`、`exchange` 都留 0，沒有任何流入來源。新金庫的 owner 先是部署者。
2. **存種子資金**（§5.2）。確認 `totalSupply > 0`。
3. **新金庫接線**（部署者，仍是 owner 時即時生效）：`setFeeRouter(新 FeeRouter)`、`setExchange(現行 exchange)`。之後才把新金庫的 owner 移交給 timelock。
4. **在 timelock 預先排程**：`PerpetualExchange.setInsuranceVault(新金庫)`、`PerpetualExchange.setFeeRouter(新 FeeRouter)`；若要調低 OI 上限，`setMaxOpenInterest` 也一起排程。這段等待期間舊金庫照常保護交易，LP 不要先提領。
5. **遷移窗口**（排程到期當下開始）：
   1. 市場操作員（`marketOperator`，或 guardian）把各資產切到 **ReduceOnly**：不能開新倉，平倉與清算照常。這一步不經 timelock，可以即時執行。或者改用第 4 步排程好的較低 OI 上限。
   2. 執行第 4 步排程的 `setInsuranceVault`、`setFeeRouter`。
   3. **協議自有部位緊接在第 2 小步之後搬**（同一批交易或立即接續）：ReduceOnly 只擋新倉，`setInsuranceVault` 執行後到錢搬過去之前，既有部位出事只有種子能賠。也可以在第 4 步一併排程 `recapitalize`，與 `setInsuranceVault` 同時執行。第三方 LP 的份額由各持有人自行在舊金庫 `withdraw`，再到新金庫 `deposit`。**合約沒有任何一方能替持有人搬份額**，第三方 LP 只能自行搬。若第三方部位短期搬不完，owner 可以在新金庫（已有種子份額）`recapitalize`。這是贈與，不發份額，按比例歸所有持有人。
   4. 新金庫的 `totalAssets` 達到 OI 上限所依據的水準後，才切回 Active（並恢復 OI 上限）。
6. **舊金庫**：不要把 `exchange` 設成 0 位址，舊 exchange 若仍有部位，清算時會 revert，同 DEPLOY_130 §5.1。改指向之後舊金庫不再被 bailout，持有人可以隨時 `withdraw`，不設期限。若 CopyTracker 沒有一起重部署，跟單費仍會經舊 FeeRouter 流進舊金庫（ADR-012 §4.4），舊金庫要長期保留。

### 5.4 部署後同一個 commit 要更新

- `frontend/src/contracts/addresses.ts`、`frontend/src/contracts/abi/InsuranceVault.json`（從 `out/` 取 `.abi`，同 `deploy-102.sh`）。
- `ops/monitoring/deployed.json`（`node scripts/check-monitoring.mjs --write` 依檢查器流程重產）。規則 `insurance-wiring-changed` 的描述寫明「重新部署 InsuranceVault 後改為 active」，`ignoredEvents` 中 `Recapitalized` 的 `notDeployed` 也要拿掉。這兩項都會改到規則雜湊，要照檢查器印出的新值更新 `REQUIRED_RULES`。
- `docs/KNOWN_LIMITATIONS.md` #25 改為已部署。

### 5.5 顯示端

前端讀 vault 自己的 `decimals()`（`frontend/src/lib/pepefi/vaultShares.ts`），新舊金庫都能正確顯示，部署前合併不影響現行畫面。持有人淨值（`useAccountBalances`、VaultPage）與「份額價格」（VaultPage、AgentMonitorPage）都改用 `previewWithdraw` 的同一條公式，也就是合約實際能贖回的金額，不用 `totalAssets / totalSupply` 的比例或 `getSharePrice()`：在 §3.3 的狀態下，比例算法會把 virtual 份額持有的資產算成持有人的錢（例：沒有 LP 時流入 1,000 USDC 後存 1 USDC，比例算法顯示約 1,001 USDC，實際可贖回約 0.999 USDC）。agent（`agent/signal-api/src/exposure.ts`）與監控只讀 `totalAssets` 與資產 decimals，不讀份額，不需要改。
