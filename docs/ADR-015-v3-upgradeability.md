---
status: proposed
date: 2026-10-02
plan-item: D2（選項卡）
---

# V3 核心改成 GMX 式：持資金與存狀態的合約不可變，邏輯合約以 Timelock 授權替換；每個租戶各自升級

> 2026-10-02。本文只是設計，**沒有任何程式或部署變動**。外部資料的查詢日期都是 2026-10-02；標 **未查證** 的項目沒有找到可靠來源。
> 結算幣小數位數（6 位 USDC）由 ADR-011 處理，本文只交叉引用。分層金庫見 [ADR-012](ADR-012-junior-buffer-tranches.md)，
> pull oracle 見 [ADR-013](ADR-013-pull-oracle.md)，金鑰託管見 [ADR-014](ADR-014-signer-custody-kms-mpc.md)，租戶隔離見 [ADR-008](ADR-008-tenant-isolation.md)。
> 標 **【待擁有者決定】** 的項目本 ADR 不替擁有者做決定。

## 1. 背景

### 1.1 exchange 不能升級，而且已經沒有空間

- `PerpetualExchange` 是 `Ownable, ReentrancyGuard`，沒有 proxy（`contracts/src/PerpetualExchange.sol:41`）。`usdc`、`oracle`、`esgRegistry` 是 immutable（`:151-152`、`:163`）。交易者的保證金存在 exchange 本身（`:1040-1042`）。
- runtime 23,911 B，EIP-170 上限 24,576 B（`docs/KNOWN_LIMITATIONS.md:902-904`），只剩 665 B（`docs/DEPLOY_130_CUTOVER.md:264`）。
- 2026-09-30 曾長到 28,054 B 而無法部署；組合保證金模式因此被移除。合約大小是**兩個原因之一**，另一個是 H3 缺口（#24）在沒有帳戶層級淨額清算的情況下無法關閉（`docs/KNOWN_LIMITATIONS.md:871-875`）。
- 為了擠空間已經做過的事：Lens 拆成 library（`contracts/src/PerpetualExchangeLens.sol:6-7`）、`ExchangeOpsLib` 外部化（`PerpetualExchange.sol:397`、`:2101`）、拿掉 16 欄 getter（`:217`）、改用自訂 error（`:599`）；編譯已開 `via_ir`、optimizer runs 200（`contracts/foundry.toml:5-7`）。
- CI 只執行 `forge build --sizes`（`.github/workflows/contracts-ci.yml:64`），沒有「保留餘裕」的門檻；人工核對表寫「全合約 < 24576 B」（`docs/VERIFICATION_REPORT.md:25`）。

### 1.2 每次換 exchange 都是一次連鎖重部署

- 依賴 exchange 的合約把它存成 immutable：`CopyTracker`（`contracts/src/CopyTracker.sol:34`，它另外把 `StrategyRegistry` 也存成 immutable，`:35`）、`AgentSessionManager`（`contracts/src/AgentSessionManager.sol:20`）；`EsgRewardDistributor` 與 `PepeIncentives` 也是（`docs/DEPLOY_130_CUTOVER.md:159`）。#130 換了 exchange、`CopyTracker`、`StrategyRegistry`、`AgentSessionManager` 四顆。其中 `StrategyRegistry` **沒有任何 exchange 參照**，唯一的 immutable 是 `stakeContract`（`contracts/src/StrategyRegistry.sol:47`）；它被重部署只是因為 #130 腳本選擇新建（`contracts/script/Redeploy130Hardened.s.sol:400`），而新的 `CopyTracker` 綁新的 registry。`DEPLOY_130_CUTOVER.md:18` 與 `Redeploy130Hardened.s.sol` 檔頭註解原本寫它也存 exchange，已在本 PR 一併更正。
- Base Sepolia 已經換過三代 exchange（`docs/LEGACY_EXCHANGES.md:13-15`），#130 會是第四代，也是「第三次連鎖重部署」（`DEPLOY_130_CUTOVER.md:4`）。
- #130 的經驗：
  - 有未平倉部位就 revert，舊保證金不搬、讓使用者自己提領；強行帶倉位 cutover 會讓清算與平倉卡住（`DEPLOY_130_CUTOVER.md:41`、`:81-95`）。
  - 共 10 步，第 9 步把 `InsuranceVault` 與 `FeeRouter` 改指新 exchange，是不可逆點（`:125-137`、`:241`）。
  - 模擬 50 筆交易、約 16.09M gas，要有 RESUME 機制防止重跑產生孤兒合約（`:28`、`:111`、`:207-230`）。
  - 舊 exchange 之後只剩提領，但仍要有人持有它的 owner（`docs/GOVERNANCE_HANDOVER.md:67`）。
- #219（GuardedOracle 凍結加到期）只有原始碼。GuardedOracle 不可升級，要以 `RedeployGuardedOracle.s.sol` 部署新的一顆；而 exchange 的 oracle 是 immutable，**exchange 不重部署就一直讀舊 oracle**（`docs/KNOWN_LIMITATIONS.md:926-932`；`DEPLOY_130_CUTOVER.md:75`、`:249`、`:261`）。一個 oracle 的修補就這樣綁上了整個 exchange 的 cutover。
- 小數位數：exchange 把 18 位小數寫死（`MIN_MARGIN = 10e18`、價格乘 `1e10`），建構子拒絕非 18 位的結算幣（`PerpetualExchange.sol:52`、`:639-647`）；Base 主網的 USDC 是 6 位。這件事由 **ADR-011** 處理，本文不重複；但 V3 的資料模型必須照 ADR-011 的結論設計（§4.6）。

### 1.3 現有的可升級合約與治理

- 唯一用 UUPS 的是 `AssetVaultV2` 家族（`contracts/src/v2/AssetVaultV2_5.sol:87-88`），`_authorizeUpgrade` 限 `DEFAULT_ADMIN_ROLE`（`:394`），以 `__gap` 保留儲存空間（V2.5 是 41 格，`:190`）。已有 4 支升級腳本（`UpgradeVaultToV2_2` 到 `V2_5`）。
- 儲存佈局檢查 `contracts/script/check-vault-storage-layout.sh` 以 `forge inspect` 比對新舊版（`:2-9`、`:17-19`），**只在 runbook 裡人工執行，CI 沒有呼叫**（`DEPLOY_130_CUTOVER.md:196`）。
- Timelock 移交（P1-15）：`TimelockController` 延遲 48 小時、下限 1 小時，`admin = 0`（自己管理自己），proposer／executor 是 Safe（`docs/GOVERNANCE_HANDOVER.md:1`、`:75`、`:82`；`contracts/script/DeployGovernance.s.sol:30-31`、`:61`）。分兩階段 grant／renounce（`contracts/script/HandoverToTimelock.s.sol:31-35`），`VerifyHandover` 要求 guardian 不能是 timelock（`contracts/script/VerifyHandover.s.sol:59-65`）。**鏈上尚未執行**（`GOVERNANCE_HANDOVER.md:6`、`:161`）。
- 分權現況：exchange 的 guardian 只能暫停（72 小時到期、24 小時冷卻，`PerpetualExchange.sol:350`、`:359`）、資產模式最多收緊到 ReduceOnly（`:327`），`unpause` 只有 owner（`:867-871`）。`KEY_MANAGEMENT.md` 寫明 multisig 什麼都能做（包括升級金庫），timelock 只是爭取反應時間（`docs/KEY_MANAGEMENT.md:154`）；exchange 仍是單一 owner key（`:156-157`）。
- 租戶：`DeployTenant.s.sol` 在部署結束時把所有權交給租戶 admin、部署者不留角色（`docs/ADR-008-tenant-isolation.md:100`；`contracts/script/DeployTenant.s.sol:280-285`），**租戶版 Timelock 還沒有**，租戶 admin 可以立即升級它的金庫（ADR-008 `:98`、`:103`）。

## 2. 外部參考（查證）

| 項目 | 事實 | 來源 |
|---|---|---|
| GMX v2（gmx-synthetics）職責拆分 | 只有 Bank 類合約持有代幣（`Bank`、`StrictBank`、`MarketToken`、`DepositVault`、`OrderVault`、`WithdrawalVault`、`ShiftVault`、`GlvVault`）；狀態在 `DataStore`、`RoleStore`、`OracleStore`；Handler 與 Router 不存狀態 | <https://docs.gmx.io/docs/api/contracts/architecture> |
| GMX 換邏輯 | 部署新合約、在 `RoleStore` 授予角色；Bank 與 DataStore 不動、不搬資金。`RoleStore` 與 `DataStore` 部署後不能換。參數經 `ConfigTimelockController`（繼承 OZ `TimelockController`） | 同上 |
| GMX 權限規則 | 只有 Timelock 持有 RoleAdmin；EOA 不得持有 CONTROLLER；CONTROLLER 可以寫 DataStore | <https://github.com/gmx-io/gmx-synthetics/blob/main/README.md> |
| Synthetix v3 router（SIP-307，Implemented） | Router 以 selector→module 對照表把多個 module 合成一個合約，繞過合約大小限制；搭配 UUPS 與儲存衝突檢查 | <https://sips.synthetix.io/sips/sip-307/> |
| ERC-2535 Diamond（Final） | 文件寫明可解決 24KB 限制；實例：Gains Network 的 `GNSMultiCollatDiamond` | <https://eips.ethereum.org/EIPS/eip-2535>、<https://docs.gains.trade/developer/technical-reference/contracts/core/gnsmulticollatdiamond.md> |
| EIP-170／EIP-3860 | runtime 上限 24,576 B；initcode 上限 49,152 B（皆 Final） | <https://eips.ethereum.org/EIPS/eip-170>、<https://eips.ethereum.org/EIPS/eip-3860> |
| 提高上限的提案 | EIP-7907 已不在 Fusaka（EIP-7607）清單，現為 Draft；提高上限拆到 **EIP-7954**（合約 64 KiB、initcode 128 KiB；狀態 Review），列在 Glamsterdam（EIP-7773）的 Scheduled for Inclusion。Glamsterdam 只有 Sepolia 排定 2026-10-06，**主網日期未定** | <https://eips.ethereum.org/EIPS/eip-7607>、<https://eips.ethereum.org/EIPS/eip-7907>、<https://eips.ethereum.org/EIPS/eip-7954>、<https://eips.ethereum.org/EIPS/eip-7773> |
| Base 的態度 | Base 2025-11-18 的文章表態支持 7907；**Base／OP Stack 是否、何時跟進 EIP-7954：未查證** | <https://blog.base.dev/glamsterdam-proposals> |
| OZ UUPS／Timelock | UUPS 必須覆寫 `_authorizeUpgrade`；`TimelockController` 有 proposer、executor、canceller、admin 與 minDelay，文件把「Timelock 當合約 owner、multisig 當唯一 proposer」列為常見用法（「A common use case is…」）；建構子的 `proposers` 參數會同時取得 proposer 與 canceller 角色 | <https://docs.openzeppelin.com/contracts/5.x/api/proxy>、<https://docs.openzeppelin.com/contracts/5.x/api/governance> |
| 升級安全工具 | `openzeppelin-foundry-upgrades` 檢查 UUPS／Transparent／Beacon 的升級安全與儲存佈局（`@custom:oz-upgrades-from`） | <https://github.com/OpenZeppelin/openzeppelin-foundry-upgrades> |
| 暫停與升級分權的實例 | Aave：Emergency Guardian（4/7）持有 EMERGENCY_ADMIN，Governance Guardian（5/9）可否決 payload。Arbitrum：Security Council 12 人，緊急 9/12 立即執行，非緊急也要 9/12 且至少延遲 18 天。Optimism：Security Council 10/13，L2 升級需 Security Council 與 Foundation 雙方同意 | <https://aave.com/help/governance/aave-community>、<https://docs.arbitrum.foundation/dao-faqs>、<https://gov.optimism.io/t/final-protocol-upgrade-8-guardian-security-council-threshold-and-l2-proxyadmin-ownership-changes-for-stage-1-decentralization/8157> |
| L2BEAT Stage 1 | 非 Security Council 發起的升級須給使用者至少 7 天退出窗口 | <https://l2beat.com/stages> |

## 3. 方案比較

| | A. 維持不可變單體＋每版 cutover | B. 整個 exchange 改 UUPS | C. Diamond／router-module | **D. GMX 式：資金與狀態不可變、邏輯可替換（建議）** |
|---|---|---|---|---|
| 解決 EIP-170 | ✗（665 B，下一個功能就要砍別的功能） | ✗：proxy 不改變實作合約的大小上限 | ✓：邏輯分散在多個 facet／module | ✓：邏輯分散在多個 handler |
| 升級時資金要不要動 | 要：排空、使用者自己提領、重新存入（#130） | 不用 | 不用 | 不用：Bank 不換 |
| 升級時依賴者要不要換 | 要：`CopyTracker` 等全部換 | 不用（位址不變） | 不用 | 不用（依賴者綁 Bank／DataStore 或經 Router） |
| 被盜或惡意升級的影響 | 只能做 owner setter 能做的事（但 owner 能改接保險金庫與 FeeRouter） | **升級權限＝能拿走全部保證金** | 同 B，而且 facet 之間共用一塊儲存，衝突更難查 | 新 handler 拿到 CONTROLLER 就能從 Bank 轉出資金——**信任程度與 B 相同**，保護來自 Timelock 延遲與退出窗口 |
| 儲存佈局風險 | 無 | 高：2,000 多行合約的單一佈局，每次升級都要逐格比對 | 高：多個 facet 共用 diamond storage | 低：狀態在 DataStore（鍵值），handler 無狀態；新增欄位＝新增鍵 |
| 可稽核性 | 好（每版是一顆新合約） | 中 | 差：selector 表、facet 交互；工具支援較少 | 中：合約數多，但每顆職責單一；GMX 是公開的先例 |
| 改寫成本 | 0 | 中：仍要拆合約才能塞得下 | 高 | **高**：等於重寫核心 |
| oracle 更換 | 換 exchange | 升級 | 升級 | 改 DataStore 裡的 oracle 位址，經 7 天的 `UpgradeTimelock`（§4.2）；#219 這類修補不再綁 exchange |
| gas | 基準 | 每次呼叫多一次 delegatecall | 多一次 delegatecall＋selector 查表 | 鍵值讀寫比直接 storage 貴；**多貴未量測** |

**否決 A**：exchange 的空間只剩 665 B，合約大小已經是移除功能的理由之一（組合保證金，另一個理由是 H3 缺口），上主網後每一次修補都要重演 #130——而主網上的 cutover 是真錢排空，使用者會流失。

**否決 B**：它不解決 EIP-170，卻把「能拿走全部保證金」的權力集中成一個升級鍵；我們仍然得拆合約。

**C 與 D 的取捨**：兩者都解決大小限制。D 勝在三點：(1) 資金永遠在同一顆不可升級的 Bank，升級只能「換掉有權轉出的人」，而那個動作在 RoleStore 留下事件、受 Timelock 延遲；(2) 狀態以鍵值存放，新增欄位不需要儲存佈局檢查；(3) 有 GMX 這個在主網長期運作的公開先例可以對照。C 的 diamond storage 讓「這次升級會不會覆寫別的 facet 的狀態」成為每次升級都要回答的問題。

**不等 EIP-7954**：就算 Glamsterdam 提高了 L1 的上限，Base 是否與何時跟進未查證；而且大小只是問題之一，資金不動的升級才是主要目的。

## 4. 決定（建議）

**V3 採 D。** 細節如下；名稱是暫定的。

### 4.1 合約邊界

| 類別 | 合約 | 可否替換 | 持有什麼 |
|---|---|---|---|
| **持資金（不可變）** | `MarginBank` | 否 | 交易者保證金與 `freeMargin` 對應的 USDC |
| | `TranchedInsuranceVault`（ADR-012）；V3 的對手方金庫（ADR-012 方案 C） | 否 | junior／senior 資本 |
| | `FeeBank` | 否 | 尚未分配的費用 |
| **存狀態（不可變）** | `DataStore` | 否 | 部位、參數、oracle 位址、暫停旗標、資產模式——全部以鍵值存放 |
| | `RoleStore` | 否 | 角色（CONTROLLER、GUARDIAN、KEEPER、MARKET_OPERATOR…） |
| | `EventEmitter` | 否 | 統一發事件，handler 換了事件位址不變（ADR-009 的監控不用改位址） |
| **邏輯（可替換）** | `OrderHandler`（開平倉）、`LiquidationHandler`、`AdlHandler`、`FundingHandler`、`ConfigHandler`（風險參數） | 是 | 無；持有 CONTROLLER 才能寫 DataStore、從 Bank 轉出 |
| | `Router`（使用者入口；`CopyTracker`、`AgentSessionManager` 改呼叫它） | 是 | 無；只把使用者的 USDC 轉進 Bank |
| | `OracleRouter`（ADR-013 的 pull oracle 驗證） | 是 | 無 |
| | `Reader`（view，取代 Lens） | 是 | 無 |

規則：

1. **Bank 只有一個轉出函式**，限 CONTROLLER；Bank 自己不含任何業務邏輯。
2. DataStore 的鍵名集中在一個 `Keys` library；handler 不得用自己拼的鍵。
3. 每個 handler 的 runtime 大小在 CI 設門檻（例如 ≤ 22,000 B，**數字待定**），超過就紅燈——現在的 `forge build --sizes` 沒有這個門檻。
4. 依賴者（`CopyTracker`、`AgentSessionManager`、獎勵合約）存 DataStore 或 Router 的位址，不存 handler 的位址。Router 換掉時它們要能改指（經 Timelock），不能再寫成 immutable。

### 4.2 升級權限：兩個 Timelock、一個 Safe

**分類原則**：能決定「成交價格」「資金去向」或「誰能從 Bank 轉出資金」的設定，效果等同換邏輯，一律走 7 天；只在程式碼寫死的硬上下限內調整的數值，走 48 小時；只會收緊、不會放寬的保護動作可以立即執行。硬上下限本身寫在 handler 程式碼裡，改它就是換 handler（7 天）。

| 類別 | 項目 | 經過 | 延遲 | 理由 |
|---|---|---|---|---|
| **換邏輯或等同換邏輯** | 授予／撤銷 CONTROLLER（換 handler、Router） | `UpgradeTimelock`（持有 RoleStore 的 ROLE_ADMIN） | **≥ 7 天**【待擁有者決定】 | 新 handler 能轉出 Bank 的資金；使用者需要看得到、來得及退出（L2BEAT Stage 1 的退出窗口是 7 天） |
| | oracle 位址、`OracleRouter` 位址、每個資產的價格來源與 feed ID、價格精度設定、交叉比對來源 | `UpgradeTimelock` | ≥ 7 天 | 能換價格來源就能餵假價格，以「獲利」的形式把 Bank 的 USDC 轉走，效果等同取得 CONTROLLER |
| | 新增資產（含它的價格來源） | `UpgradeTimelock` | ≥ 7 天 | 同上：新資產帶進一個新的價格來源 |
| | 資金去向：treasury、`FeeBank` 的分配對象、保險金庫（分層金庫）位址、結算幣位址 | `UpgradeTimelock` | ≥ 7 天 | 直接決定錢流向哪裡 |
| | 授予任何角色（GUARDIAN、KEEPER、MARKET_OPERATOR、CANCELLER 相關） | `UpgradeTimelock` | ≥ 7 天 | 授權是擴權；撤銷見下方「立即」 |
| **硬上限內的數值** | OI 上限、獲利上限、費率（≤ 程式碼上限）、維持保證金（≥ 程式碼下限）、新鮮度與信賴區間門檻（在程式碼區間內）、funding 參數 | `ConfigTimelock` | 48 小時（沿用 P1-15） | 最大影響由程式碼裡的硬上下限界定 |
| | 解除暫停、設 Halted、ReduceOnly → Active、下架（轉 ReduceOnly） | `ConfigTimelock` | 48 小時 | 不改變價格與資金去向 |
| **立即（只收緊）** | 全域暫停（72 小時到期）、資產收緊到 ReduceOnly | guardian | 無 | 見 §4.3 |
| | **撤銷**（不能授予）GUARDIAN、KEEPER、MARKET_OPERATOR | 提案者 Safe，直接對 RoleStore | 無 | 讓被盜的線上角色可以立即移除，而且這條路徑不經 Timelock、不能被取消（§4.3） |

| 角色 | 由誰擔任 |
|---|---|
| 提案者 | 同一個 Safe（每個租戶自己的 Safe，見 §4.4）；`GOVERNANCE_HANDOVER.md` 的 Safe 要求照用：至少 2/3、分散裝置、冷備份 |
| 執行者 | Safe 或任何人（`executor = address(0)`）【待擁有者決定】；任何人執行可避免 Safe 簽署人不在時卡住已排定的修補 |
| 取消者 | 提案者 Safe（OZ `TimelockController` 的建構子會讓 proposers 自動取得 CANCELLER）；可選的 Security Council（§4.3）。**guardian 不是取消者** |

- 兩個 Timelock 都 `admin = 0`（自己管理自己），沿用 P1-15 的做法。
- RoleStore 的 ROLE_ADMIN **只能**是 `UpgradeTimelock`；提案者 Safe 在 RoleStore 只有「撤銷」上述三種線上角色的權限。部署後的驗證腳本（比照 `VerifyHandover`）要讀回「沒有任何 EOA 持有 CONTROLLER 或 ROLE_ADMIN」「guardian 不持有任何 Timelock 角色」（GMX README 的同一條規則，加上本文的分權）。
- **沒有快速升級通道**作為預設。若擁有者要一個「緊急修補」的快速路徑，必須是更高門檻的 Safe（例如 Security Council 式的 3/5 以上）而且只能做預先定義的動作（換掉某個 handler 為「只能平倉」的版本），不能任意授予 CONTROLLER【待擁有者決定】。

### 4.3 緊急暫停與升級分權

| 角色 | 能做 | 不能做 |
|---|---|---|
| guardian（溫錢包或小 Safe） | 全域暫停、資產收緊到 ReduceOnly | 解除暫停、授予或撤銷任何角色、排程或**取消**任何提案、放寬資產模式 |
| marketOperator（keeper；V3 改成 RoleStore 的角色，可多人持有，見 ADR-014 §4.4） | Active ↔ ReduceOnly | Halted、暫停 |
| 提案者 Safe | 排程提案、取消提案、立即撤銷 GUARDIAN／KEEPER／MARKET_OPERATOR | 繞過 Timelock 授予任何角色 |
| Security Council（可選，門檻更高、簽署人不同） | 經一顆 `CancelGate` 合約取消提案（`CancelGate` 持有 CANCELLER） | 排程提案、授予角色 |
| `ConfigTimelock` | 硬上限內的參數、解除暫停、Halted | 授予 CONTROLLER、價格來源、資金去向 |
| `UpgradeTimelock` | 授予／撤銷 CONTROLLER 與其他角色、價格來源、資金去向 | — |

- 暫停旗標、資產模式、guardian 的到期時間都存在 DataStore，**換 handler 不會重設暫停狀態**。
- guardian 暫停沿用現在的 72 小時到期＋24 小時冷卻（`PerpetualExchange.sol:350`、`:359`、`:2109-2110`；GuardedOracle 同一模式，`contracts/src/v2/GuardedOracle.sol:51`、`:57`），超過 72 小時由 Timelock 接手（比照 GuardedOracle 的 `takeOverPause`）。
- **為什麼 guardian 不能取消提案**：撤換 guardian 若必須經 Timelock，而 guardian 又能取消，被盜的 guardian 就能無限次取消「撤換它自己」的提案，同時每 96 小時（72 小時暫停＋24 小時冷卻）重新暫停一次——治理永久停擺。所以 guardian 不持有 CANCELLER，撤換 guardian 走提案者 Safe 的「立即撤銷」路徑，不經 Timelock、不能被取消。
- **Security Council 的取消權也要可以被關掉**：它若被盜，同樣能無限次取消。所以它的取消權經 `CancelGate` 行使，提案者 Safe 可以**立即、單向**關閉 `CancelGate`；重新開啟或更換 Council 走 `UpgradeTimelock`（7 天）。

**被盜時的最壞情況（重算）：**

| 被盜者 | 能做什麼 | 最壞情況 | 止損 |
|---|---|---|---|
| guardian | 暫停、收緊到 ReduceOnly | Safe 在冷卻結束前撤銷它：只有一次暫停；暫停在 72 小時到期，或在 Safe 提出解除暫停後 48 小時（`ConfigTimelock`）結束，取較早者。Safe 遲遲不回應：每 96 小時停機 72 小時，直到撤銷。**不能阻止治理、不能動資金**；若採本節末的「暫停不擋提領」，使用者仍可提領 `freeMargin` | Safe 立即撤銷 GUARDIAN |
| Security Council | 取消提案 | 治理延遲到 Safe 關閉 `CancelGate` 為止；已被取消的提案要重排一次完整延遲 | Safe 立即關閉 `CancelGate` |
| keeper／marketOperator | 轉送價格（ADR-013）、Active ↔ ReduceOnly | 延遲價格、錯誤切換 ReduceOnly（不能 Halted、不能放寬到超出 Active） | Safe 立即撤銷 |
| 提案者 Safe | 排程任何提案、關閉 `CancelGate` | 惡意的換邏輯或換價格來源在 7 天後生效。Council 可取消，但 Safe 能先關閉 `CancelGate`；**最後的保護是 7 天退出窗口**，合約內沒有救援路徑 | 使用者在 7 天內提領；監控（ADR-009）把任何 `UpgradeTimelock` 排程列為 SEV-1 |

- 暫停期間提領保證金是否放行：原始碼版的全域暫停會擋提領（`docs/RISK_WATERFALL.md:104`）。V3 建議**暫停不擋 `MarginBank` 的提領 `freeMargin`**，讓使用者在升級爭議期間能退出【待擁有者決定】。

### 4.4 和租戶隔離的關係：共用程式碼版本，各自部署、各自升級

| 方案 | 優點 | 缺點 |
|---|---|---|
| 所有租戶共用同一組 handler 實例 | 一次升級全部生效；部署成本低 | 一個 handler 同時是多個租戶 RoleStore 的 CONTROLLER——一個漏洞或一次錯誤升級就是跨租戶事故，違反 ADR-008；租戶無法拒絕或延後升級 |
| **每個租戶自己的 handler 實例，同一份經稽核的 bytecode（建議）** | 隔離與 ADR-008 一致；每個租戶的 Timelock 自己決定何時升級；可以先在一個租戶上線觀察 | 每次升級要對 N 個租戶各排一次 Timelock；版本可能分歧 |

建議第二種，並加上：

- 平台發佈「版本」＝一組 handler 的 bytecode 雜湊＋稽核報告＋儲存鍵變更清單。`VerifyTenant` 擴充為讀回每個 handler 的 code hash，與版本清單比對。
- 平台支援最新版與前一版；租戶落後超過【待擁有者決定】天，平台不再提供 keeper／監控支援。
- 租戶的 Safe 由誰簽（只有租戶，或平台＋租戶）沿用 ADR-008 的待決事項；它決定的是「平台能不能替租戶升級」。

### 4.5 不改的東西

- `AssetVaultV2` 家族維持 UUPS（已有使用者；有 4 支升級腳本 `UpgradeVaultToV2_2`～`V2_5`，但 Base Sepolia 的主 proxy 是 #129 直接部署在 V2.4、**尚未升級過**，Sepolia 的 proxy 升到 V2.2，V2.5 尚未上鏈：`docs/VAULT_VERSIONS.md:9-12`、`:24-30`；`contracts/script/check-vault-storage-layout.sh:2`）。但 `check-vault-storage-layout.sh` 或 `openzeppelin-foundry-upgrades` 必須進 CI（現在只有人工），並把它的 `DEFAULT_ADMIN_ROLE` 交給 `UpgradeTimelock`（7 天）而不是 48 小時的那一個【待擁有者決定】。
- 是否把 AssetVault 也改成 Bank／邏輯分離：不在本 ADR 範圍。

### 4.6 與 ADR-011 的交界

V3 的資料模型（DataStore 的數值單位、`MIN_MARGIN`、價格精度）**依 ADR-011 的結論設計**，本文不決定。唯一的要求是：單位轉換只存在於 Bank 的入口與出口（以及 `Keys` 裡的常數），handler 內部不得自行假設結算幣的小數位數——這正是現行 `PerpetualExchange.sol:639-647` 必須在建構子擋下非 18 位幣的原因。

## 5. V1 到 V3 的遷移路徑

現行 exchange 不可升級，**沒有原地遷移**；V1→V3 和 #130 一樣是排空與重新部署，只是這次之後不會再有下一次。

| 階段 | 內容 | 工作量（單人估計，**未經驗證**） |
|---|---|---|
| 0. 前置決定 | ADR-011（小數位數）、ADR-012（金庫）、ADR-013（oracle）定案；本 ADR 的待決事項 | — |
| 1. 骨架 | `MarginBank`、`FeeBank`、分層金庫（ADR-012 的會計搬入 V3，入帳帶來源參數）、`DataStore`、`RoleStore`、`EventEmitter`、`Keys`、兩個 Timelock、`CancelGate`、提案者 Safe 的「只能撤銷」權限；CI 大小門檻；部署與 `Verify` 腳本（讀回 code hash、角色、無 EOA CONTROLLER、guardian 無 Timelock 角色） | 12–18 人日 |
| 2. 移植邏輯 | 把 `PerpetualExchange` 拆成 handler；**現有 forge 測試當行為規格**（`contracts/test` 下遞迴 85 個 `.t.sol` 測試檔、約 1,086 個 `test` 函式）逐一移植 | 20–35 人日 |
| 3. 升級演練 | fork 測試：部署新版 handler → `UpgradeTimelock` 排程 → 授權新、撤銷舊 → Bank 餘額與部位不變、暫停狀態不變、舊 handler 呼叫 revert；Council 經 `CancelGate` 取消、Safe 關閉 `CancelGate`、Safe 立即撤銷 guardian；§4.2 分類表裡每一項都確認走對的 Timelock | 5–8 人日 |
| 4. 依賴者改接 | `CopyTracker`（連同它的 `StrategyRegistry` 參照）、`AgentSessionManager`、獎勵合約、keeper、signal-api、前端、監控規則（事件改由 `EventEmitter` 發） | 8–12 人日 |
| 5. 外部稽核 | — | **未查證**（要詢價） |
| 6. 測試網並行 | V3 以新部署上 Base Sepolia（等同一個新租戶），V1 照常；之後 V1 所有資產改 ReduceOnly，使用者自行平倉與提領（不搬部位，#130 的教訓） | 3–5 人日＋觀察期 |
| 7. 主網 | **只部署 V3**（含 ADR-012 的分層金庫）；V1 不上主網 | 依租戶 |
| 8. V3 第二階段：對手方金庫（ADR-012 方案 C） | 金庫成為每筆部位的對手方：平倉、清算、funding 的結算改為對金庫記帳；淨曝險上限與 ADL 觸發改以金庫淨值計；對應的 invariant 與監控 | 15–25 人日＋另一次稽核 |

合計：第一階段（階段 1–6）約 50–80 人日；第二階段（階段 8）另約 15–25 人日。都不含稽核與觀察期。

不搬部位的理由：搬部位等於替使用者以某個價格平倉再開倉，價格、費用、funding 都要有人決定，而且一旦中途失敗就是兩邊都有半套部位。#130 已經證明「排空＋自行提領」雖然慢，但每一步都可驗證。

## 6. 上主網前必須成立的條件

1. **主網只上 V3。** 若擁有者決定先以 V1 上主網，就必須接受：每一次修補都是一次真錢的 #130 式排空。
2. RoleStore 的 ROLE_ADMIN 只在 `UpgradeTimelock`，沒有任何 EOA 持有 CONTROLLER 或 ROLE_ADMIN；部署後驗證腳本讀回並寫進部署紀錄。
3. 升級演練（§5 階段 3）在測試網實際做過一次完整的 Timelock 流程，不只是 fork 測試。
4. 每個 handler 的大小門檻在 CI，且留有餘裕。
5. 仍是 UUPS 的合約（AssetVault）的儲存佈局檢查在 CI。
6. guardian 不能授予或撤銷角色、不能排程或取消提案，只能暫停與收緊；提案者 Safe 能立即撤銷 guardian，且這條路徑不經 Timelock。§4.2 分類表的每一項都走對應的 Timelock。全部由驗證腳本讀回，並在測試網演練過一次「撤銷被盜 guardian」。
7. 租戶版 Timelock 腳本存在（ADR-008 列為未完成），租戶部署時就在 Timelock 後面，而不是部署後由租戶自行決定。
8. Bank 的 **USDC 守恆** invariant 測試：任何 handler 序列下，每顆 Bank 的 USDC 餘額＝存入 − 提領 ± 金庫撥款與注資 ± 轉入／轉出 `FeeBank` 等**可對帳流量**的累計值，也就是沒有任何不經記帳的轉出。**這不是償付性保證**：資金池是所有部位的對手方，交易者整體淨賺時，獲利直接記進 `freeMargin` 而不發 `BadDebt`，Bank 餘額可以低於 `freeMargin` 總和（ADR-012 §1.2 的淨曝險風險；`docs/RISK_WATERFALL.md:31-33`、`:73`「不保證恆償付」）。償付性以監控（ADR-012 §5 階段 0）與 ADR-012 方案 C（本文階段 8）處理，不寫成 invariant。
9. 外部稽核完成，報告公開。
10. ADR-011 的結算幣小數位數已在 V3 的資料模型落實。

## 7. 待擁有者決定

1. 是否接受 D（重寫核心）。不接受時，要選 A（主網上反覆 cutover）還是 C（diamond）。
2. 換邏輯（以及 §4.2 中等同換邏輯的項目）的延遲：7 天（建議，符合 L2BEAT Stage 1 的退出窗口），或其他。
3. 是否要緊急升級通道；要的話，Security Council 的組成與門檻，以及它能做的預先定義動作。
4. Timelock 的 executor：只有 Safe，還是任何人。
5. 租戶升級：租戶可以落後幾版、多久；平台是否在租戶的 Safe 上有簽署權。
6. 暫停期間是否放行提領 `freeMargin`。
7. 主網是否等 V3，還是先以 V1 上線。
8. AssetVault 的升級權交給 7 天還是 48 小時的 Timelock。
9. §4.2 的分類表：是否同意「價格來源、資金去向、授予角色」一律 7 天；哪些數值參數放進 48 小時，以及各自的硬上下限。
10. 是否設 Security Council（及其 `CancelGate`）；不設時，取消權只在提案者 Safe 手上。

## 8. Consequences

- 核心等於重寫，合約數從一顆 exchange 變成十顆左右；稽核範圍與費用增加，但之後每次修補只換一顆無狀態的 handler，不必排空。
- oracle 不再是 exchange 的 immutable，#219 這類修補只需要一次 7 天的 `UpgradeTimelock` 提案，不必排空與重部署。
- 「能升級＝能拿走資金」的本質不變，保護改由 Timelock 延遲（換邏輯與價格來源 7 天）、退出窗口、Security Council 的取消權（若設）與公開事件提供；這些要寫進對租戶與終端使用者的揭露。
- 監控（ADR-009）改成看 `EventEmitter` 與 RoleStore 的角色事件；「有人被授予 CONTROLLER」是 SEV-1。
- 每個租戶每次升級都要走一次自己的 Timelock，營運成本隨租戶數增加。

## 9. 參考

- 本 repo：[`DEPLOY_130_CUTOVER.md`](DEPLOY_130_CUTOVER.md)、[`GOVERNANCE_HANDOVER.md`](GOVERNANCE_HANDOVER.md)、[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md)、[`LEGACY_EXCHANGES.md`](LEGACY_EXCHANGES.md)、[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)、[`ADR-008`](ADR-008-tenant-isolation.md)
- GMX v2：<https://docs.gmx.io/docs/api/contracts/architecture>、<https://github.com/gmx-io/gmx-synthetics/blob/main/README.md>
- Synthetix SIP-307：<https://sips.synthetix.io/sips/sip-307/>
- EIP：<https://eips.ethereum.org/EIPS/eip-170>、<https://eips.ethereum.org/EIPS/eip-2535>、<https://eips.ethereum.org/EIPS/eip-3860>、<https://eips.ethereum.org/EIPS/eip-7907>、<https://eips.ethereum.org/EIPS/eip-7954>、<https://eips.ethereum.org/EIPS/eip-7773>
- OpenZeppelin：<https://docs.openzeppelin.com/contracts/5.x/api/proxy>、<https://docs.openzeppelin.com/contracts/5.x/api/governance>、<https://github.com/OpenZeppelin/openzeppelin-foundry-upgrades>
- 分權實例：<https://aave.com/help/governance/aave-community>、<https://docs.arbitrum.foundation/dao-faqs>、<https://l2beat.com/stages>
