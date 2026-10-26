# PepeFi — Web3 社交交易：跟著鏈上透明的交易者投資（測試網研究原型）

> **定位**：PepeFi 是給**一般投資人**的 Web3 版 eToro：**社交交易**（看清交易者的每一筆部位、
> 每一版策略再決定跟不跟）、**鏈上透明**（部位、策略版本、手續費分潤、金庫儲備率都在鏈上）、
> **ESG**（交易者 ESG 分數、有來源的碳強度與碳分級定價）、**GameFi**（Pepe 養成與不可轉讓的成就）。
> 決策與理由見 [`docs/ADR-023-web3-etoro-positioning.md`](docs/ADR-023-web3-etoro-positioning.md)。
> 本專案與 eToro 沒有任何關聯，提到它只是說明定位。
>
> **你的資產在哪裡**：只支援**使用者自管**，不提供託管帳戶，平台不持有使用者私鑰。保證金記在使用者名下、
> 只有本人能提領；跟單開出的部位在跟隨者自己名下；現貨代幣在使用者自己的錢包。營運方仍保有暫停與凍結市場、調整參數（含自動減倉）、
> 升級金庫與指定代理合約的權限，價格由受信任的 keeper 寫入（見 §5），所以自管不等於「完全不需信任」。
> 跟單預設是快照式（複製交易者當下那一版策略）；跟隨者可以在鏈上開啟**自動同步**，之後任何人都能、也只能把他的部位
> 調成交易者鏈上最新版，平台不替任何人簽名（[ADR-024](docs/ADR-024-copy-auto-sync.md)，**僅原始碼、Base Sepolia 尚未部署**）。
> 沒有自動停損。
>
> **未來延伸：B2B 白標**。同一套合約與前端可以租戶形式提供給**持牌金融機構**（租戶隔離見 ADR-008、
> 前端白標設定見 [`frontend/docs/adr/0009-tenant-config-layer.md`](frontend/docs/adr/0009-tenant-config-layer.md)）；
> 對終端客戶的合規責任由持牌客戶承擔，分工見 [`docs/COMPLIANCE_BOUNDARY.md`](docs/COMPLIANCE_BOUNDARY.md)。
>
> **現況**：本 repo 是 2026 年 Capstone 專題出身的**研究原型**，只部署在 **Base Sepolia 測試網
> （chainId 84532）**。沒有真實資產、沒有第三方安全稽核、沒有任何監理許可，**不是生產系統**。

- 名稱：產品名為 **PepeFi**。PepeLab 是早期名稱，也是 demo 主題（因此 repo、網址與部分舊文件仍使用 PepeLab）。
- 正式展示站（測試網）：<https://pepelab-onchain-cfd-djot.vercel.app>
- 事實基準日：2026-10-26（位址與部署狀態以 #344 cutover 之後的唯讀讀回為準，見
  [`docs/CUTOVER_LOG_2026-10-20.md`](docs/CUTOVER_LOG_2026-10-20.md)）。本文所有位址與參數以程式碼與鏈上唯讀查詢為準。

---

## 1. 架構：四層與各自職責

| 層 | 元件 | 職責 |
|---|---|---|
| **① 鏈上合約層** | `PerpetualExchange`、`InsuranceVault`、`AssetVaultV2`（UUPS proxy）+ `SyntheticAssetV2`、`ESGRegistryV2` + `CarbonTiers`、`AgentSessionManager`、`KYCRegistry`、`StrategyRegistry`／`CopyTracker`／`TraderStake`、`FeeRouter` | 保證金、開平倉、funding、清算與損失吸收；代幣化資產 mint／redeem；以見證的碳分級決定費率與槓桿上限；agent 的限額授權；費用分潤 |
| **② 預言機與營運層** | `MockOracle`（交易所讀取）、`GuardedOracle`（V2 金庫讀取）、keeper（`agent/keeper`，GitHub Actions）、監控與告警 workflow | 餵價、價格熔斷、來源後備、oracle 新鮮度告警、位址一致性檢查 |
| **③ Agent 與資料服務層** | `agent/signal-api`（x402，Vercel）、x402 結算 worker、`agent/mcp-server`、`agent/tg-bot`、`agent/demo-agent`、`agent/copy-sync`（跟單自動同步的執行者）、`agent/sdk`（TypeScript SDK，workspace，未發布到 npm） | 付費資料 API、分潤結算佇列、讓 LLM agent 在 session 限額內讀取與下單、無需許可地替開啟自動同步的跟隨者執行同步、給機構整合用的型別化 client |
| **④ 呈現層** | `frontend/`（React + Vite，Vercel）、`web/`（靜態介紹頁） | 白標前端範本、商業版功能旗標、揭露文字 |

整合介面細節見 [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md)，signal-api 規格見
[`docs/api/openapi.yaml`](docs/api/openapi.yaml)。

## 2. 現行部署位址（Base Sepolia 84532）

唯一來源：[`frontend/src/contracts/addresses.ts`](frontend/src/contracts/addresses.ts)、
[`frontend/src/contracts/sessionManager.ts`](frontend/src/contracts/sessionManager.ts)、
[`frontend/src/contracts/x402.ts`](frontend/src/contracts/x402.ts)。本表是人工抄錄，若與上述檔案不一致，以檔案為準。

| 合約 | 位址 | 備註 |
|---|---|---|
| PerpetualExchange | `0xbF3074C98e17d88B4127899C98C81AE94c9fC979` | #344 cutover（2026-10-20）。`FUNDING_INTERVAL` 8h、`maxPriceAge` 6h、`adlEnabled` true（2026-10-21 鏈上讀取）。上一顆 `0x827e…124D` 的保證金從 `/legacy` 取回 |
| AgentSessionManager | `0x4875966ACA052A38d80ddD2aaE80995A98EAd2AF` | `exchange()` 指向上列 exchange，且已被 exchange 授權 |
| AssetVaultV2（proxy） | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` | `version()` = 2.4.0；`minReserveRatioBps` 11000 |
| GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` | V2.4 金庫的價格來源 |
| MockOracle | `0x9Cf4E05B08F6cC53be2e04752F2c32A79132deEA` | **交易所實際讀取的價格來源**（#344 回放寫入 2024–2025 價格，之後由 keeper 寫入） |
| ESGRegistryV2 | `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` | 碳分級見證登錄（`addresses.ts` 的 `ESGRegistry` 欄位與 `V2_STACK.ESGRegistryV2` 為同一位址） |
| InsuranceVault | `0x899263e34107a36a5216499F9CC7fb7a5afc7aaF` | 保險金庫（LP 份額 pIV） |
| FeeRouter（MockUSDC） | `0x89Aa6799b2CdAa43FF7985ff706456Ca6F0e5d29` | 分配跟單績效費與 copy fee。交易費不經過 FeeRouter，留在 exchange（`vaultFeeShareBps` = 0）。平台收款人（`platformTreasury`）是下列 PlatformFeeSplitter |
| PlatformFeeSplitter | `0xe5b1B4009c41dd5C02e216F42f33b3a8d4EE0a0C` | #344 cutover 新增：平台份額的一部分撥給 CarbonRetirement（§3.3） |
| CarbonRetirement | `0x93B72Dd20913107aC9eEe4e9420D9C8aB802Fd28` | #344 cutover 新增：買入並銷毀**模擬碳權**（§3.3） |
| FeeRouter（x402，Circle USDC） | `0x780E18146Bc77E50c3e5EcaED913FC31F62c0f6A` | 分配 x402 收入的 70/20/10（trader／平台／保險金庫）。2026-10-10 重新部署（[`docs/CUTOVER_LOG_2026-10-10.md`](docs/CUTOVER_LOG_2026-10-10.md)），取代 treasury 為外洩地址的舊 router `0x29e5…B57d` |
| StrategyRegistry | `0xe8d807C3BaFB4D3AeCbA094322eE8dD7Ca16C20c` | |
| CopyTracker | `0x31297044a7b3A0F57e7CDa7fE619E996da1c64A9` | 自動同步版（ADR-024），2026-10-26 部署並改接（[`docs/CUTOVER_LOG_2026-10-26.md`](docs/CUTOVER_LOG_2026-10-26.md)）；快照版 `0x15A9…347C` 上的跟單照算進跟隨人數 |
| TraderStake | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` | |
| KYCRegistry | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` | 只擋標記為 RWA 的資產 |
| MockUSDC（保證金，測試幣） | `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035` | 已部署的是舊版，`mint` 無限制（任何人可鑄）；原始碼已限制為 owner／swapRouter，需重新部署才生效。僅限測試網 |
| AssetVault（V1，舊路徑） | `0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5` | 對照用；商業路徑為 V2.4 |

x402 付款使用 Circle 官方測試網 USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`（EIP-3009），
與保證金用的 MockUSDC 是不同代幣。11 顆代幣化資產的位址見 `addresses.ts` 的 `V2_STACK[84532].tokens`。

Sepolia（11155111）仍有舊部署與價格 keeper 在跑，但只作為 V2 金庫的對照展示，不是產品路徑；
Sepolia 的合約**未做金鑰輪替**（見 [`docs/RUNBOOK_KEY_ROTATION.md`](docs/RUNBOOK_KEY_ROTATION.md)）。

### RWA＋SSI PoC 專屬租戶（Base Sepolia，`rwa-poc`）

2026-10-07 以新的部署金鑰（`0xF52D…49eE`）另外部署了一整套 master 版合約，作為 RWA＋SSI PoC 的專屬租戶 `rwa-poc`
（交易所 `0xbB7f…A96B`）。它和上表的現役部署是**兩套獨立的位址**（結算幣除外：保證金沿用上表的測試幣 MockUSDC，與現役部署共用、不受 PoC 金鑰控制），上表與展示站不受影響。這套部署帶有合格投資人 VC 准入
（`VCKycRegistry`）、逐資產休市模式、`GuardedOracle`、AI 代理人委託憑證錨定（`SessionCredentialAnchor`）與 x402 KYA，
已在鏈上實跑驗證並錄成 PoC 影片；前端、keeper、signal-api 都在本機執行。
限制：只在測試網、保證金是測試幣；合格投資人憑證的發證者與碳分級見證者是 PoC 自己的錢包，沒有真實身分審查；新合約未經外部稽核；x402 帶憑證的實付已在 2026-10-08 用測試 USDC 完成（兩筆結算 tx 見 `docs/tenants/rwa-poc/X402_KYA.md`）。完整位址、錢包、重現指令、驗收結果與已知限制見
[`docs/tenants/rwa-poc/README.md`](docs/tenants/rwa-poc/README.md)。

## 3. 功能現況

### 3.1 已上線（Base Sepolia，2026-09-30）

- **永續 CFD 引擎**：逐倉保證金、1–5× 槓桿（實際上限依資產碳分級）、OI 失衡驅動的 funding
  （每 8 小時一期、每期上限 0.75%）、無許可清算（清算人獎勵 5%）、`maxPriceAge` 6 小時的過期價格保護。
- **損失吸收**：保證金 → `InsuranceVault` → ADL（自動減倉，已啟用）→ `BadDebt` 事件。
  完整順序與限制見 [`docs/RISK_WATERFALL.md`](docs/RISK_WATERFALL.md)。
- **碳強度定價**：交易所與 V2.4 金庫都讀 `ESGRegistryV2.medianCarbonTier`；未評等資產落到最保守等級。
  方法論見 [`docs/CARBON_METHODOLOGY.md`](docs/CARBON_METHODOLOGY.md)。
- **代幣化配置**：`AssetVaultV2` 2.4.0 的 mint／redeem，11 顆合成資產。**非足額抵押**：金庫是所有多頭的對手方，
  以準備率門檻、逐資產上限與暫停來限制曝險，而不是 1:1 準備。
- **Agent session**：使用者在鏈上建立 session，由合約強制單筆保證金上限、總預算、槓桿上限、到期、
  資產白名單與撤銷；授權 VC（EIP-712）由鏈下 agent 驗證。
- **x402 付費資料 API**（`agent/signal-api`）：`/signals/:trader` 0.01 USDC、`/oracle/:asset` 0.005 USDC。
  已上線的保護（#180）：收款地址守門（fail-closed，不安全時回 503，不發出 402）、結算佇列冪等。
  **截至 2026-09-30，正式 signal-api 的收款地址未通過守門，付費端點回 503**。x402 FeeRouter 已在 2026-10-10 以新的 treasury
  重新部署（§2）；signal-api 的 Vercel 環境變數（`PAY_TO`、`X402_FEE_ROUTER`）換成新值並重新部署是擁有者待辦
  （[`docs/CUTOVER_LOG_2026-10-10.md`](docs/CUTOVER_LOG_2026-10-10.md) 第 4 步）。
- **營運**（#178、#182、#190）：keeper 指向現行 exchange、GuardedOracle 恢復餵價、keeper 熔斷與來源後備、
  位址一致性 CI、oracle 告警。處置見 [`docs/RUNBOOK_KEEPER.md`](docs/RUNBOOK_KEEPER.md)。
- **前端**（#181、#192）：移除假價、改為誠實的鏈上讀取；KYC 改送雜湊；商業版功能旗標；CSP 與安全標頭；
  合成資產揭露。之後合併到 master 的有：白標租戶設定層（#197，見
  [`docs/TENANT_DEPLOYMENT.md`](docs/TENANT_DEPLOYMENT.md)）、`/legacy` 舊版 exchange 資產取回頁
  （#214，2026-10-01 合併，見 [`docs/LEGACY_EXCHANGES.md`](docs/LEGACY_EXCHANGES.md)）。

### 3.2 PR #191、#198 的原始碼：#344 cutover（2026-10-20）已部署的與仍未部署的

PR #191、#198 合併時只改了原始碼。2026-10-20 的 #344 cutover（`Redeploy130Hardened` 等腳本，紀錄見
[`docs/CUTOVER_LOG_2026-10-20.md`](docs/CUTOVER_LOG_2026-10-20.md)）重新部署了交易所與周邊合約，
[`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md)（2026-10-21 產生）比對為「鏈上＝原始碼」。**已部署**：

- `PerpetualExchange` 的 guardian 全域暫停（72 小時自動失效、24 小時冷卻，只有 owner 能解除）。
- 逐資產模式 Active／ReduceOnly／Halted（keeper 是 marketOperator，休市的股票、債券、ESG 標的自動切成 ReduceOnly）。
- 逐資產 OI 上限（cutover 設為每資產單邊 250,000 USDC）與單筆獲利上限（腳本預設：保證金的 5 倍）。
- 多項核心修正（`copiedFrom` 限制、mark 溢價上限、零價格檢查延伸到讀取路徑）、CopyTracker slash 款項改入準備金、
  InsuranceVault 零份額存款 revert 與虛擬份額。
- **組合保證金模式已從原始碼移除**（EIP-170 合約大小上限，以及未完成的帳戶層級清算；見 `docs/KNOWN_LIMITATIONS.md`），
  新交易所只有逐倉。舊交易所 `0x827e…124D` 的保證金從 `/legacy` 取回。

**仍只在原始碼、尚未部署**（RELEASE_STATUS 的「原始碼較新」）：

- `AssetVaultV2_5`（鏈上仍是 2.4.0）與 `GuardedOracle` 的時間窗累積偏離上限、凍結期限（鏈上仍是舊版）。
- 移交給 Timelock 的治理腳本（[`docs/GOVERNANCE_HANDOVER.md`](docs/GOVERNANCE_HANDOVER.md)）：未執行，exchange 的 owner 仍是部署者。
- `TraderStake`（M2：申請取回質押即喪失資格）、`KYCRegistry`、`PepeAMM`、`MockUSDC` 的原始碼修正。
- 相關限制見 `docs/KNOWN_LIMITATIONS.md` #27–#29。

### 3.3 碳權退役（#105／#333，#344 cutover 已部署）

**被銷毀的碳權是模擬的。** `MockCarbonCredit` 是本專案在測試網自行鑄造的代幣，不是任何碳權登錄機構
核發的碳權，不對應任何真實的減碳或移除量，銷毀它不抵銷任何真實排放；買入款項付給本專案控制的模擬賣方
地址，沒有流向任何真實的碳權專案。真實的是**架構**：`FeeRouter` 的平台收款人換成 `PlatformFeeSplitter`
（`0xe5b1…0a0C`，鏈上讀回 `platformTreasury()` 即為它），平台份額中合約寫死的比例自動撥給 `CarbonRetirement`
（`0x93B7…Fd28`），它用這筆預算買入碳權並在同一筆交易裡銷毀，發出 `CarbonRetired(amount, tonnesCO2e, timestamp)`。
`FeeRouter` 原始碼與 70/20/10 不變。合約的 `name()`、`SIMULATED`、`DISCLOSURE` 與 ESG 頁的退役區塊都帶同一句聲明。
設計見 [`docs/ADR-022-carbon-retirement-splitter.md`](docs/ADR-022-carbon-retirement-splitter.md)。
2026-10-20 部署（`DeployCarbonRetirement.s.sol`）；分流與退役由 keeper 每次執行順帶觸發，前端從
`exchange → feeRouter() → platformTreasury()` 找到退役合約，不需另外設定位址。公開鏈回放的資料集含 24 筆退役（9.36 公噸，模擬額度）。

### 3.4 跟單自動同步（ADR-024，僅原始碼、尚未部署）

跟單原本是快照式：交易者發布新版策略後，跟隨者的部位不會變。自動同步讓跟隨者在鏈上同意一次，之後**任何人**
（跟隨者自己的 agent、平台 keeper、第三方 bot）都能呼叫 `CopyTracker.resyncFor`，但它**只能**把部位調成交易者鏈上最新版：
資產、方向、權重、槓桿全部由合約從 `StrategyRegistry` 讀取，呼叫者沒有任何參數可選，所以跟隨者不需要信任呼叫者（與無許可清算同一個邏輯）。

- **跟隨者自己設定上限**：最大槓桿（1–5×，同步時取策略、資產上限與它三者的最小值）、別人代為同步的最短間隔（合約下限 1 小時，
  擋交易者在同一區塊反覆發版、自己同步來磨手續費；前端預設 24 小時；本人手動同步不受限）、執行者小費（≤ 0.001 ETH）。
  開啟前畫面揭露每次同步「全平再開」的交易費、績效費與時機風險。
- **只讓自己的 agent 同步**：跟隨者可以用 `setSyncExecutor` 把「任何人」收窄成一個指定地址（例如自己 agent 的熱錢包），
  其他人（含平台的執行者）一律被合約拒絕；agent 以 personal 模式執行，沒開自動同步的跟單則只在交易者發新版時通知本人。
- **油箱是跟隨者自己的 ETH**：預存的 ETH 支付每次同步的執行費與小費，本人隨時可提領（不能收 ETH 的合約錢包可指定收款地址），
  只有本人能提領。油箱只按跟隨者**簽名帶入**的每腿執行費上限付款（跟單、開啟自動同步、立即同步都把畫面上顯示的費率當成上限帶入），
  交易所 owner 調高費率（包括在同一個區塊搶先調高）只會讓那筆交易整筆退回，不能多扣。
- **本人手動同步先看內容、再釘版本與費率**：Portfolio 的「立即同步」先開確認視窗，列出新版每一檔的資產、方向、比重、實際槓桿與
  預估費用，確認後送 `resyncAtVersion`；交易者在跟隨者按下之前又發的版本、或交易所在按下之前調高的執行費，都會讓它整筆退回，
  不會直接換成跟隨者沒看過的版本或費率。
- **LLM agent（MCP）也能發起跟單**：`prepare_copy_follow_tx` 依使用者的指示（交易者、金額、要不要開自動同步、槓桿上限）產生
  「USDC approve＋釘版本跟單」的未簽名交易並附預覽與模擬；`copy_sync_status` 查同步狀態，`prepare_copy_sync_tx` 產生同步、設定、
  油箱的未簽名交易。全部交給跟隨者自己的錢包簽；agent 不簽名、不送出、不需要私鑰。
- **沒跑 agent 也會知道**：交易者發新版而你的紀錄還停在舊版時，網頁任何內頁頂端都會提醒，並指出哪些要你處理（沒開自動同步、
  油箱不足、執行費被調高）；想收推播的人可以跑不需要金鑰的只通知模式（`copy-sync --notify-only`，webhook）。
- **原子同步**：新版任何一條腿開不起來（RWA 未 KYC、休市 ReduceOnly、Halted、OI 已滿）就整筆 revert，部位維持舊版，之後重試；
  只重新部署這次平倉釋出的保證金，不動用其他可用保證金。
- **交易者不能靠改版洗掉虧損**：每次同步平掉的腿跨版本累計計分，取消跟單時一起判斷是否罰沒。
- **私鑰**：跟隨者的私鑰永遠不離開自己的錢包；執行者 `agent/copy-sync` 用一把只放少量 gas 的獨立熱錢包，
  外洩的最壞情況只是有人觸發合約本來就允許的同步。

Base Sepolia 上的 CopyTracker 自 2026-10-26 起是自動同步版（[`docs/CUTOVER_LOG_2026-10-26.md`](docs/CUTOVER_LOG_2026-10-26.md)），
public 執行者由 GitHub Actions `copy-sync-executor.yml` 排程執行（即時性見 KNOWN_LIMITATIONS #40）。
`scripts/demo-autosync.sh` 一條指令在本機 Anvil 上用真的合約與真的執行者跑完整個流程並逐步斷言
（跟單＋開啟自動同步 → 交易者發新版 → public 執行者同步、拿小費 → 陌生人重放被擋 → RWA 未 KYC 整筆擋下、KYC 後同步成功 →
指定自己的 agent 為唯一執行者、public 執行者與陌生人被擋、agent 同步成功 → 關閉後 agent 只通知新版 → 提領油箱）。
設計、權限模型與取捨見 [`docs/ADR-024-copy-auto-sync.md`](docs/ADR-024-copy-auto-sync.md)，限制見 `docs/KNOWN_LIMITATIONS.md` #39–#45。

## 4. 功能旗標（前端）

定義在 [`frontend/src/lib/pepefi/featureFlags.ts`](frontend/src/lib/pepefi/featureFlags.ts)。旗標只控制畫面，
**不改任何鏈上行為**。值為 `1`／`true`／`on` 才算開啟，其他值（例如 `0`）算關閉，未設定時用租戶的預設值。
下表的預設是平台站（`default` 租戶，[`frontend/src/tenant/tenants/default.json`](frontend/src/tenant/tenants/default.json)）的值，
五個功能旗標都是授權且預設開。機構租戶：`demo-bank` 五個都不授權；`rwa-poc` 不授權 GameFi 與 PEPE 獎勵，
跟單、槓桿、永續入口有授權但預設關。未授權的功能環境變數也打不開。

| 環境變數 | 預設 | 關閉時 |
|---|---|---|
| `VITE_FEATURE_GAMEFI` | 開（2026-10-12 起） | 收起 `/pepe` 養成與扭蛋與首頁的 GameFi 功能卡，路由顯示「此功能未啟用」 |
| `VITE_FEATURE_PEPE_REWARDS` | 開（2026-10-20 起，GameFi 的 PEPE 來源） | 收起 `/rewards`、PEPE 平台幣獎勵與水龍頭卡片 |
| `VITE_FEATURE_COPY_TRADING` | 開（#331 起，見 ADR-023） | 收起 `/copy/*`、Expert 的交易者排行榜與跟單入口，首頁與 meta 改用代幣化資產的說法；既有跟單仍可在 Portfolio 取消 |
| `VITE_SHOW_LEVERAGE` | 開（#344 起） | 不顯示槓桿選擇器，前端一律送 1× |
| `VITE_SHOW_PERPETUALS` | 開（#344 起） | 收起永續入口（`/terminal` 路徑仍可到達；既有部位可在 Portfolio 平倉） |
| `VITE_ENABLE_MOCK_WALLET` | 關（正式 build） | 不顯示免錢包的簡報通道 |

## 5. 安全狀態

- 回報漏洞：見 [`SECURITY.md`](SECURITY.md)。
- 已知限制：見 [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)。
- 事故處置：見 [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)。
- 重點事實（不含細節）：
  - 合約**沒有第三方安全稽核**。`docs/audit/` 內是內部審查與靜態分析紀錄，不等於稽核。
  - 合約 owner 為**單一 EOA**，沒有 multisig，也沒有 timelock。owner（與 guardian）可以暫停交易所（暫停期間無法平倉、提領保證金），owner 也能凍結單一標的、開啟自動減倉、
    決定哪些代理合約能代使用者開平倉（`setCopyTracker`、`setAgentAuthorized`）。
  - `AssetVaultV2` 是 UUPS proxy，管理者可以升級實作、暫停（暫停期間無法贖回）；合成代幣的 `MINTER_ROLE` 可以銷毀任何持有者的代幣，
    管理者可以授權這個角色。使用者自管的範圍與這些權限的關係見 ADR-023。
  - 交易所讀取的價格由 keeper 金鑰寫入 `MockOracle`，屬於受信任的中繼，不是去中心化預言機。
  - 碳權退役（#105／#333，已部署）銷毀的是本專案自行鑄造的模擬碳權，不是真實碳權，不抵銷任何真實排放。
  - `AssetVaultV2` 為非足額抵押的合成曝險。
  - 跟單自動同步（ADR-024，未部署）：任何人都能執行同步，但只能調成交易者鏈上最新版；別人代為同步之間至少隔 1 小時，
    執行費只按跟隨者同意的費率扣。冷卻限制的是頻率，不是每一輪的金額：交易者每個冷卻期都能發一版，讓跟隨者「全平再開」付交易費，
    績效費也沒有高水位線（`docs/KNOWN_LIMITATIONS.md` #39、#41、#42）。

## 6. 開發

```bash
# Contracts（Foundry；子模組：forge-std、openzeppelin-contracts、openzeppelin-contracts-upgradeable）
git submodule update --init --recursive
cd contracts
forge build
forge test

# Frontend — 只用 yarn（package.json 有 "packageManager": "yarn@1.22.22"）
# 用 npm 會產生一份沒有任何流程驗證的 package-lock.json，且 npm 會忽略
# package.json 裡的 "resolutions"（安全 pin 就在那裡）。
cd frontend
yarn install --frozen-lockfile
yarn dev        # 本機開發
yarn test       # vitest
yarn build

# Agent — 只用 npm（npm workspaces）
cd agent
npm ci
npm test                # 全部離線可跑、不需金鑰
npm run signal-api      # 本機啟動 x402 signal-api
npm run mcp-server      # 本機啟動 MCP server（stdio）
```

環境與工具鏈細節見 [`docs/agents/environment.md`](docs/agents/environment.md)。部署與 cutover 程序見
[`docs/DEPLOY_129_CUTOVER.md`](docs/DEPLOY_129_CUTOVER.md)（現行部署）與
[`docs/DEPLOY_130_CUTOVER.md`](docs/DEPLOY_130_CUTOVER.md)（3.2 節原始碼的下一輪，已由 #344 cutover 執行，紀錄見
[`docs/CUTOVER_LOG_2026-10-20.md`](docs/CUTOVER_LOG_2026-10-20.md)）；
任何廣播交易的步驟都需要持有金鑰的使用者執行。

匿名審查護欄：`frontend/src/anonymity.test.ts`（隨 `yarn test` 執行）檢查展示站來源、`web/`、`docs/`、本檔
與 build 產物不含可辨識所屬機構的字樣。**它不涵蓋 git 歷史與 commit metadata**（舊 commit 的內容、
作者與提交者信箱、貢獻者帳號名稱），那些要另外處理。

## 7. 文件索引

| 文件 | 內容 |
|---|---|
| [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md) | 發布狀態：每個元件的已合併／已部署／鏈上驗證（bytecode 比對）／展示驗收。由 `scripts/check-deployment-status.mjs` 以唯讀 RPC 產生，不手寫。**已合併不等於使用者受保護** |
| [`docs/OWNER_ACTIONS.md`](docs/OWNER_ACTIONS.md) | 擁有者操作包：只有擁有者能做的 8 個步驟（GitHub 設定、Worker 部署、凍結舊部署、換收款地址、cutover、VC 清單、部署後重驗、部署自動同步版 CopyTracker），每步附驗證與失敗處置 |
| [`docs/ADR-023-web3-etoro-positioning.md`](docs/ADR-023-web3-etoro-positioning.md) | 專題主軸：Web3 版 eToro、只支援使用者自管（含營運方保有的權限、與 eToro 的差別）；B2B 白標降為延伸 |
| [`docs/ADR-024-copy-auto-sync.md`](docs/ADR-024-copy-auto-sync.md) | 跟單自動同步：跟隨者在鏈上同意、任何人都能（也只能）把部位調成交易者最新版；權限模型、油箱與小費、RWA 原子性、金鑰模型（修訂 ADR-023 第 5 點） |
| [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) | 給持牌機構的整合說明（草案，B2B 白標延伸） |
| [`docs/TENANT_DEPLOYMENT.md`](docs/TENANT_DEPLOYMENT.md) | 白標租戶：前端租戶設定、隔離模型（ADR-008）、部署設定、dry-run 與新增租戶步驟（廣播由擁有者執行） |
| [`docs/TENANT_OPERATIONS.md`](docs/TENANT_OPERATIONS.md) | 白標租戶部署之後：每租戶的 keeper 金鑰與 workflow、signal-api 與收款、SDK 指向租戶部署 |
| [`docs/tenants/rwa-poc/README.md`](docs/tenants/rwa-poc/README.md) | RWA＋SSI PoC 專屬租戶（Base Sepolia）：目的、架構、錢包與合約、重現指令、驗收結果、已知限制 |
| [`docs/COMPLIANCE_BOUNDARY.md`](docs/COMPLIANCE_BOUNDARY.md) | 我方與客戶的合規責任邊界（草案） |
| [`docs/RISK_WATERFALL.md`](docs/RISK_WATERFALL.md) | 損失吸收順序（草案） |
| [`docs/CARBON_METHODOLOGY.md`](docs/CARBON_METHODOLOGY.md) | 碳分級方法與資料品質（草案） |
| [`docs/ADR-022-carbon-retirement-splitter.md`](docs/ADR-022-carbon-retirement-splitter.md) | 碳權退役（#344 cutover 已部署）：平台收款人換成分流合約、FeeRouter 不改；被銷毀的是**模擬碳權** |
| [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) | 事故應變（草案） |
| [`docs/ADR-009-monitoring.md`](docs/ADR-009-monitoring.md)、[`ops/monitoring/rules.md`](ops/monitoring/rules.md) | 鏈上監控方案決策與監控規則清單（部署見 [`ops/monitoring/README.md`](ops/monitoring/README.md)） |
| [`docs/ADR-012-junior-buffer-tranches.md`](docs/ADR-012-junior-buffer-tranches.md) | 上主網前設計（提案）：分層保險金庫（租戶 junior／外部 senior）與鏈下對沖介面 |
| [`docs/ADR-013-pull-oracle.md`](docs/ADR-013-pull-oracle.md) | 上主網前設計（提案）：簽名 pull oracle、交叉比對、休市與新鮮度 |
| [`docs/ADR-014-signer-custody-kms-mpc.md`](docs/ADR-014-signer-custody-kms-mpc.md) | 上主網前設計（提案）：keeper 與結算 signer 移進雲端 KMS、金鑰輪替與稽核 |
| [`docs/ADR-015-v3-upgradeability.md`](docs/ADR-015-v3-upgradeability.md) | 上主網前設計（提案）：V3 核心可升級架構（資金合約不可變、邏輯可替換） |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | signal-api 規格 |
| [`docs/RISK_MODEL.md`](docs/RISK_MODEL.md) | 金庫風險模型 |
| [`docs/VAULT_VERSIONS.md`](docs/VAULT_VERSIONS.md) | 金庫版本與鏈上實作對照 |
| [`docs/RUNBOOK_KEEPER.md`](docs/RUNBOOK_KEEPER.md)、[`docs/RUNBOOK_SITE_HEALTH.md`](docs/RUNBOOK_SITE_HEALTH.md) | 營運手冊 |

## 8. 免責聲明

本專案是測試網上的研究原型，僅供學術與技術評估。所有資產都是測試網代幣或合成曝險，
**不是證券、不代表任何真實資產的所有權或請求權**，也沒有任何價值。本文件不構成投資建議、
法律意見或任何形式的要約。PepeFi 未取得任何司法管轄區的金融業務許可；任何對公眾提供的
衍生品或代幣化資產服務，都必須由取得相應許可的機構自行評估並承擔合規責任。

## 9. 授權

本 repo 採**專有授權、保留所有權利**，全文見 [`LICENSE`](LICENSE)。

> **這份授權文字尚待律師審閱**，目前是維護者自行擬定的暫行版本，不是法律意見。

- **允許**：為了評估（例如技術盡職調查、競賽評審、安全審查）與學術審查（例如論文口試、同儕審查）而檢視原始碼，
  以及為同樣的目的在自己的機器上 clone、build、執行測試。不得部署到公開網路或任何鏈（含測試網）。
- **不授予**：使用、修改、散布、部署（包含把任何合約部署到任何鏈、或營運由本專案建置的服務）的權利。
  需要這些權利請先取得著作權人的書面同意。
  例外：`contracts/` 的 Solidity 檔案檔頭標的是 MIT，見下方「尚未釐清」。
- **著作權人**：zuemen 與 PepeLab 貢獻者。

第三方元件依各自的授權，不適用本專案的授權：

| 元件 | 位置 | 授權 | repo 內是否附授權全文 |
|---|---|---|---|
| OpenZeppelin Contracts、Contracts Upgradeable | `contracts/lib/openzeppelin-contracts*`（git 子模組） | MIT | 有（各目錄的 `LICENSE`） |
| forge-std | `contracts/lib/forge-std` | MIT 或 Apache-2.0 | 有（`LICENSE-MIT`、`LICENSE-APACHE`） |
| Minimal UI 起始範本（`@minimal-kit/starter-vite-ts`） | `frontend/` 的專案骨架 | 依範本發行者的條款 | **沒有**，授權狀態待確認 |
| Roboto 字型 | `frontend/public/fonts/` | 依字型發行者的授權 | **沒有** |
| npm／yarn 套件（含打包進 `agent/signal-api/api/index.js` 的部分） | lockfile 與套件中繼資料 | 各套件自己的授權 | 沒有彙整的第三方聲明檔 |

**尚未釐清、需要一併交給律師的事項**：

- `contracts/` 下的 Solidity 檔案（`src`、`script`、`test`）檔頭都標著 `SPDX-License-Identifier: MIT`，
  與根目錄的專有授權不一致。`LICENSE` 第 6 條寫明本授權不撤回檔案自身聲明已經給出的權利；
  要不要改檔頭、已公開的版本如何處理，尚未決定。
- `LICENSE` 沒有準據法與管轄條款，著作權人也還不是法律實體。
- 其他貢獻者對改採專有授權的同意：這個 repo 有不只一位貢獻者，改採專有授權、以及日後由誰給出書面同意，
  都需要他們同意，目前還沒有取得。
- `frontend/public` 的角色圖像與範本附帶的素材：來源與權利歸屬還沒有逐一確認。`LICENSE` 第 5 條的清單不是窮舉，
  這些素材仍屬各自的權利人。
- 各 `package.json` 的 `license` 欄位是 `SEE LICENSE IN LICENSE`，指的是根目錄這一份。
