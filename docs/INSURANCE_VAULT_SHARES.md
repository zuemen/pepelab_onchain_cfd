# InsuranceVault 份額定價：virtual shares（P1-05）

> 狀態：**原始碼已修正，待部署**（分支 `contracts/insurance-vault-virtual-shares`）。
> 已部署的兩顆 InsuranceVault（Base Sepolia 主金庫 `0xB364…D812`、x402 FeeRouter 的收款金庫 `0xc7af…7b9f`）仍是舊版，見 §5。

## 1. 問題

舊版用 `shares = amount × totalSupply / totalAssets` 定價，沒有任何 offset。供給很小的時候，任何協議流入（`depositFromProtocol`：交易手續費分成、清算殘值、跟單績效費分成）都會把單一份額的價格推得很高，之後的存款因為向下取整而少拿份額，差額歸既有持有人。2026-09-29 起「取整到 0 份額」會 revert（`ZeroShares`），但取整到少量份額時的損失仍在，而且推高價格的一方可以從中獲利。KNOWN_LIMITATIONS #25 記的就是這件事。

## 2. 設計：decimals offset + virtual shares / virtual asset

採用 OpenZeppelin ERC-4626 的 `_decimalsOffset` 構造（不繼承 ERC4626，保留現有的介面、事件、錯誤與 `totalAssets` 明確記帳）：

```
shares = amount × (totalSupply + 10^6) / (totalAssets + 1)    向下取整
assets = shares × (totalAssets + 1) / (totalSupply + 10^6)    向下取整
```

- `DECIMALS_OFFSET = 6`。`decimals() = 資產 decimals + 6`：MockUSDC（18）→ 24；6 位 USDC → 12。資產 decimals 在建構時讀一次，讀不到當 18（與 OZ 相同的容錯）。
- 空金庫時 1 枚完整 USDC 換 1 枚完整 pIV，`getSharePrice()` 仍是「每 1 枚完整 pIV 值多少資產最小單位」，MockUSDC 上仍是 18 位小數，空供給回傳 1.0。
- `totalAssets` 仍是實際記帳餘額。virtual asset 只出現在兩個換算式裡。PerpetualExchange 讀 `totalAssets()` 決定 bailout 能補多少，這個數字不受影響，介面 `IInsuranceVaultPerp` 不變。
- 保留：`ZeroShares`（存款小於一個 share unit 的價值時拒收）、`VaultInsolvent`（H-4：bailout 把資產抽到 0 而份額還在時拒收存款，靠 `recapitalize` 或協議流入恢復）、`InsufficientVault`。

### 為什麼選 virtual offset，不選 dead shares

| | virtual offset（採用） | dead shares（首存時鑄給死地址） |
|---|---|---|
| 保護從何時開始 | 部署起就有，不依賴誰先存 | 要等第一筆存款，且首存者要付死份額的成本 |
| 全部提光後 | 仍有效（virtual 永遠在） | 有效（死份額留著） |
| 供給為 0 時累積的流入 | 下一個存款者拿不走（§3.3） | 首存者可拿走 |
| 對 decimals 的影響 | 份額 decimals +6，顯示端要讀 `decimals()` | 不變 |
| 證明 | 封閉式上界（§3），OZ 有公開分析 | 依死份額數量而定，首存者成本落在使用者身上 |

offset 取 6：virtual 份額數 10^6 讓推高價格的成本是可造成損失的約 10^6 倍（§3.2）。在 18 位 MockUSDC 下份額 24 位、6 位 USDC 下 12 位；1e36 資產單位（10^18 枚 USDC）以內 `Math.mulDiv` 不會溢位，測試涵蓋到這個量級。

## 3. 性質與上界

記 V = 10^6，c = (totalAssets + 1) / (totalSupply + V)，也就是一個 share unit 的贖回價（實數）。

### 3.1 取整方向一律對金庫有利

兩個換算都向下取整，所以任何狀態下（包含 bailout 降價之後）存入 a 再贖回同一批份額，拿回的不超過 a：
`s = ⌊a(S+V)/(A+1)⌋ ⇒ s(A+1) ≤ a(S+V) ⇒ s(A+a+1)/(S+s+V) ≤ a`。
存款與提款也都不會降低其他持有人的 c（向下取整的餘數留在金庫）。單一持有人能拿回的永遠 ≤ `totalAssets`，因為 S/(S+V) < 1。

### 3.2 早期小額持有人 + 協議流入 + 後續存款者

設早期持有人在空金庫存入 x，之後協議流入 D（不論誰付），之後另一人存入 v，最後兩人都贖回。以「拿回 − (x + D)」為早期持有人淨額 P：

- **P ≤ 1 wei**（資產最小單位：MockUSDC 為 1e-18 USDC，6 位 USDC 為 1e-6 USDC）；早期持有人先贖回時 **P ≤ 0**。P = 1 只可能在 D 幾乎為 0（c < 1/(V−1)）時發生，此時沒有任何價格被推高，那 1 wei 是後存者的提款取整餘數。
- 後續存款者的損失 < c + 1 wei，也就是不到一個 share unit 的價格。
- 早期持有人的損失 ≥ (V − 1) × 後續存款者損失 − V。換句話說，要讓別人少拿 1 單位，自己至少要先丟掉約 10^6 單位。

推導：早期持有人的份額價值恆等於 `(A+1) − 其他人份額價值 − V·c`。V·c 是 virtual 份額吸走的部分，且 c 從空金庫開始是 1/V、只會被流入與取整推高（bailout 才會降，但 bailout 由交易所在虧損時觸發，不是可以免費操控的流入）。代入「後存者的取整損失 < 存款當下的 c ≤ 之後的 c」即得上面三條。實際上 D 只能經由交易手續費、清算罰金或跟單績效費進來，付出的成本還高於 D 本身。直接轉帳給金庫的代幣完全不計入 `totalAssets`，不影響價格。

### 3.3 供給為 0 時累積的流入

若 `totalSupply == 0` 而 `totalAssets = A > 0`（全部 LP 退出後的取整殘值，或沒有 LP 時收到的手續費），下一個存入 a 的人拿到 `aV/(A+1)` 份額，可贖回的剛好約 a，拿不走 A。這筆 A 實際上由 virtual 份額持有，仍計入 `totalAssets`，所以仍是 bailout 的保險金。

## 4. 測試

| 檔案 | 內容 |
|---|---|
| `contracts/test/InsuranceVaultShares.t.sol` | 早期持有人＋流入＋後存者的 fuzz（對 x、D、v、贖回順序 fuzz，斷言 §3.2 三條上界）；直接轉帳不改價格的 fuzz；任意狀態下 round trip 不獲利、不稀釋他人的 fuzz（含 bailout 降價）；多人存提、bailout 後存提、全部提光後重來、抽到 0 後 `recapitalize`；0、1 wei、1e36 與溢位邊界；decimals 隨資產變化 |
| `contracts/test/InsuranceVaultInvariant.t.sol` | 隨機序列（存、提、協議流入、bailout、recapitalize、直接轉帳、份額轉讓）下的不變量：份額總值 ≤ `totalAssets`、逐人加總 ≤ `totalAssets`、`totalAssets` 有實際餘額支撐、記帳等式、顯示價不低於實際贖回價 |
| `contracts/test/InsuranceVault.t.sol` 等既有測試 | 份額數量改以 `10^6` 倍的新尺度斷言，見 PR 說明中的逐項對照 |

## 5. 部署與遷移（只寫流程，本分支不部署）

InsuranceVault **不可升級**（`new InsuranceVault(usdc)`，非 proxy），新版要重新部署才生效。參照它的合約：

| 合約 | 參照方式 | 換金庫時要做的事 |
|---|---|---|
| PerpetualExchange | `setInsuranceVault`（owner） | 改指向新金庫 |
| FeeRouter（V1、x402 各一顆） | `insuranceVault` 是 **immutable** | 要換金庫就要重部署 FeeRouter |
| CopyTracker | `feeRouter` 是 **immutable** | 換 V1 FeeRouter 就要重部署 CopyTracker（以及引用 CopyTracker 的 `TraderStake.setCopyTracker`、交易所授權） |

因此建議**併入下一次 exchange／CopyTracker cutover**（同 `DEPLOY_130_CUTOVER.md` 的流程）一起做，不單獨跑一輪。新租戶走 `DeployTenant.s.sol` 會直接部署新版，不需要遷移。

### 5.1 順序（由 owner 執行；治理移交後 owner 是 timelock，每一步 48 小時）

1. 部署新 InsuranceVault（與需要重部署的 FeeRouter／CopyTracker 同一批）。`setFeeRouter`、`setExchange` 指向新的 FeeRouter 與現行 exchange。
2. **先搬錢再改指向。** DEPLOY_130 §3.1 的 OI 上限是按 `InsuranceVault.totalAssets` 算的，新金庫是空的，直接改指向會讓保險金歸零。舊金庫份額由誰持有，就由誰在舊金庫 `withdraw` 再到新金庫 `deposit`。協議自有的部位由部署者（或 timelock）執行。**合約沒有任何一方能替持有人搬份額**，第三方 LP 只能自行搬。若第三方部位短期搬不完，owner 可以用 `recapitalize` 先補保險金（這是贈與，不發份額，見合約註解），或依新的 `totalAssets` 重算 OI 上限。
3. `PerpetualExchange.setInsuranceVault(新金庫)`；V1 FeeRouter 換新之後，`PerpetualExchange.setFeeRouter(新 FeeRouter)`。
4. 舊金庫：不要把 `exchange` 設成 0 位址，舊 exchange 若仍有部位，清算時會 revert，同 DEPLOY_130 §5.1。改指向之後舊金庫不再被 bailout，持有人可以隨時 `withdraw`，不設期限。
5. x402：x402 FeeRouter 的收款金庫也要換成新版（重部署 x402 FeeRouter，並更新 ledger worker 的設定）。

### 5.2 部署後同一個 commit 要更新

- `frontend/src/contracts/addresses.ts`、`frontend/src/contracts/abi/InsuranceVault.json`（從 `out/` 取 `.abi`，同 `deploy-102.sh`）。
- `ops/monitoring/deployed.json`（`node scripts/check-monitoring.mjs --write` 依檢查器流程重產）。規則 `insurance-wiring-changed` 的描述寫明「重新部署 InsuranceVault 後改為 active」，`ignoredEvents` 中 `Recapitalized` 的 `notDeployed` 也要拿掉。這兩項都會改到規則雜湊，要照檢查器印出的新值更新 `REQUIRED_RULES`。
- `docs/KNOWN_LIMITATIONS.md` #25 改為已部署。

### 5.3 顯示端

前端已改成讀 vault 自己的 `decimals()`（`frontend/src/lib/pepefi/vaultShares.ts`），新舊金庫都能正確顯示，部署前合併不影響現行畫面。agent（`agent/signal-api/src/exposure.ts`）與監控只讀 `totalAssets` 與資產 decimals，不讀份額，不需要改。
