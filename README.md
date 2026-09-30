# PepeFi — 鏈上衍生品與代幣化配置的白標基礎設施（測試網研究原型）

> **定位**：PepeFi 規劃以 **B2B 白標**形式，把鏈上衍生品引擎、代幣化配置、碳強度定價、
> agent session 與 x402 付費資料 API 提供給**持牌金融機構**（期貨商、槓桿交易商、
> 有衍生品業務的銀行）。對終端客戶的合規責任（牌照、KYC／AML、適合度、槓桿上限等）
> 由持牌客戶承擔，分工見 [`docs/COMPLIANCE_BOUNDARY.md`](docs/COMPLIANCE_BOUNDARY.md)。
>
> **現況**：本 repo 是 NCCU Capstone 2026 出身的**研究原型**，只部署在 **Base Sepolia 測試網
> （chainId 84532）**。沒有真實資產、沒有第三方安全稽核、沒有任何監理許可，**不是生產系統**。

- 名稱：產品名為 **PepeFi**。PepeLab 是早期名稱，也是 demo 主題（因此 repo、網址與部分舊文件仍使用 PepeLab）。
- 正式展示站（測試網）：<https://pepelab-onchain-cfd-djot.vercel.app>
- 事實基準日：2026-09-30。本文所有位址與參數以程式碼與鏈上唯讀查詢為準。

---

## 1. 架構：四層與各自職責

| 層 | 元件 | 職責 |
|---|---|---|
| **① 鏈上合約層** | `PerpetualExchange`、`InsuranceVault`、`AssetVaultV2`（UUPS proxy）+ `SyntheticAssetV2`、`ESGRegistryV2` + `CarbonTiers`、`AgentSessionManager`、`KYCRegistry`、`StrategyRegistry`／`CopyTracker`／`TraderStake`、`FeeRouter` | 保證金、開平倉、funding、清算與損失吸收；代幣化資產 mint／redeem；以見證的碳分級決定費率與槓桿上限；agent 的限額授權；費用分潤 |
| **② 預言機與營運層** | `MockOracle`（交易所讀取）、`GuardedOracle`（V2 金庫讀取）、keeper（`agent/keeper`，GitHub Actions）、監控與告警 workflow | 餵價、價格熔斷、來源後備、oracle 新鮮度告警、位址一致性檢查 |
| **③ Agent 與資料服務層** | `agent/signal-api`（x402，Vercel）、x402 結算 worker、`agent/mcp-server`、`agent/tg-bot`、`agent/demo-agent` | 付費資料 API、分潤結算佇列、讓 LLM agent 在 session 限額內讀取與下單 |
| **④ 呈現層** | `frontend/`（React + Vite，Vercel）、`web/`（靜態介紹頁） | 白標前端範本、商業版功能旗標、揭露文字 |

整合介面細節見 [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md)，signal-api 規格見
[`docs/api/openapi.yaml`](docs/api/openapi.yaml)。

## 2. 現行部署位址（Base Sepolia 84532）

唯一來源：[`frontend/src/contracts/addresses.ts`](frontend/src/contracts/addresses.ts)、
[`frontend/src/contracts/sessionManager.ts`](frontend/src/contracts/sessionManager.ts)、
[`frontend/src/contracts/x402.ts`](frontend/src/contracts/x402.ts)。本表是人工抄錄，若與上述檔案不一致，以檔案為準。

| 合約 | 位址 | 備註 |
|---|---|---|
| PerpetualExchange | `0x827eA0c62a32e995927101259042F8A27D99124D` | `FUNDING_INTERVAL` 8h、`maxPriceAge` 6h、`adlEnabled` true、`portfolioMarginEnabled` false（2026-09-30 鏈上讀取） |
| AgentSessionManager | `0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B` | `exchange()` 指向上列 exchange，且已被 exchange 授權 |
| AssetVaultV2（proxy） | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` | `version()` = 2.4.0；`minReserveRatioBps` 11000 |
| GuardedOracle | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` | V2.4 金庫的價格來源 |
| MockOracle | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` | **交易所實際讀取的價格來源**（keeper 寫入） |
| ESGRegistryV2 | `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` | 碳分級見證登錄（`addresses.ts` 的 `ESGRegistry` 欄位與 `V2_STACK.ESGRegistryV2` 為同一位址） |
| InsuranceVault | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` | 保險金庫（LP 份額 pIV） |
| FeeRouter（MockUSDC） | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` | 分配跟單績效費與 copy fee。交易費不經過 FeeRouter，留在 exchange（`vaultFeeShareBps` = 0） |
| FeeRouter（x402，Circle USDC） | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` | 分配 x402 收入的 70/20/10（trader／平台／保險金庫）。⚠ treasury 仍為已外洩的舊地址，**需重新部署**（使用者待辦） |
| StrategyRegistry | `0xA103de184A5C76d7b70fB4e908F252199e004b95` | |
| CopyTracker | `0xC9e91f7D36e910C58042164032c625427b23CCB2` | 跟單在商業版預設關閉 |
| TraderStake | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` | |
| KYCRegistry | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` | 只擋標記為 RWA 的資產 |
| MockUSDC（保證金，測試幣） | `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035` | 已部署的是舊版，`mint` 無限制（任何人可鑄）；原始碼已限制為 owner／swapRouter，需重新部署才生效。僅限測試網 |
| AssetVault（V1，舊路徑） | `0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5` | 對照用；商業路徑為 V2.4 |

x402 付款使用 Circle 官方測試網 USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`（EIP-3009），
與保證金用的 MockUSDC 是不同代幣。11 顆代幣化資產的位址見 `addresses.ts` 的 `V2_STACK[84532].tokens`。

Sepolia（11155111）仍有舊部署與價格 keeper 在跑，但只作為 V2 金庫的對照展示，不是產品路徑；
Sepolia 的合約**未做金鑰輪替**（見 [`docs/RUNBOOK_KEY_ROTATION.md`](docs/RUNBOOK_KEY_ROTATION.md)）。

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
  **截至 2026-09-30，正式 signal-api 的收款地址未通過守門，付費端點回 503**，待使用者更換收款設定。
- **營運**（#178、#182、#190）：keeper 指向現行 exchange、GuardedOracle 恢復餵價、keeper 熔斷與來源後備、
  位址一致性 CI、oracle 告警。處置見 [`docs/RUNBOOK_KEEPER.md`](docs/RUNBOOK_KEEPER.md)。
- **前端**（#181、#192）：移除假價、改為誠實的鏈上讀取；KYC 改送雜湊；商業版功能旗標；CSP 與安全標頭；
  合成資產揭露。

### 3.2 僅原始碼、尚未部署（PR #191，已合併到 master）

以下變更已在 master 的原始碼中，但**已部署的 bytecode 沒有這些功能**。要生效必須由使用者執行 cutover
重新部署（`PerpetualExchange` 需 link 外部 library `ExchangeOpsLib`，forge script 會自動處理），
並同步前端 ABI。

- `PerpetualExchange` 的 guardian 全域暫停（72 小時自動失效、24 小時冷卻，只有 owner 能解除）。
- 逐資產模式 Active／ReduceOnly／Halted。
- 逐資產 OI 上限與單筆獲利上限（預設關閉，由部署腳本設定）。
- 多項核心修正（`copiedFrom` 限制、mark 溢價上限、零價格檢查延伸到讀取路徑——
  現行部署在 oracle 寫入路徑已經檢查零價格）、
  CopyTracker slash 款項改入準備金、InsuranceVault 零份額存款 revert。
- **組合保證金模式已從原始碼移除**（EIP-170 合約大小上限，以及未完成的帳戶層級清算；見 `docs/KNOWN_LIMITATIONS.md`）。
  現行部署仍有這個模式，但為關閉狀態（`portfolioMarginEnabled = false`，逐倉）。

## 4. 商業版功能旗標（前端）

定義在 [`frontend/src/lib/pepefi/featureFlags.ts`](frontend/src/lib/pepefi/featureFlags.ts)。旗標只控制畫面，
**不改任何鏈上行為**。值為 `1`／`true`／`on` 才算開啟，未設定一律關閉。

| 環境變數 | 預設 | 關閉時 |
|---|---|---|
| `VITE_FEATURE_GAMEFI` | 關 | 收起 `/pepe` 養成與扭蛋，路由顯示「此功能未啟用」 |
| `VITE_FEATURE_PEPE_REWARDS` | 關 | 收起 `/rewards`、PEPE 平台幣獎勵與水龍頭卡片 |
| `VITE_FEATURE_COPY_TRADING` | 關 | 收起 `/copy/*` 與跟單入口；既有跟單仍可在 Portfolio 取消 |
| `VITE_SHOW_LEVERAGE` | 關 | 不顯示槓桿選擇器，前端一律送 1× |
| `VITE_SHOW_PERPETUALS` | 關 | 收起永續入口（`/terminal` 路徑仍可到達；既有部位可在 Portfolio 平倉） |
| `VITE_ENABLE_MOCK_WALLET` | 關（正式 build） | 不顯示免錢包的簡報通道 |

## 5. 安全狀態

- 回報漏洞：見 [`SECURITY.md`](SECURITY.md)。
- 已知限制：見 [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)。
- 事故處置：見 [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)。
- 重點事實（不含細節）：
  - 合約**沒有第三方安全稽核**。`docs/audit/` 內是內部審查與靜態分析紀錄，不等於稽核。
  - 合約 owner 為**單一 EOA**，沒有 multisig，也沒有 timelock。
  - 交易所讀取的價格由 keeper 金鑰寫入 `MockOracle`，屬於受信任的中繼，不是去中心化預言機。
  - `AssetVaultV2` 為非足額抵押的合成曝險。
  - x402 FeeRouter 需以新的 treasury 重新部署（使用者待辦）。

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
[`docs/DEPLOY_129_CUTOVER.md`](docs/DEPLOY_129_CUTOVER.md)；任何廣播交易的步驟都需要持有金鑰的使用者執行。

## 7. 文件索引

| 文件 | 內容 |
|---|---|
| [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) | 給持牌機構的整合說明（草案） |
| [`docs/COMPLIANCE_BOUNDARY.md`](docs/COMPLIANCE_BOUNDARY.md) | 我方與客戶的合規責任邊界（草案） |
| [`docs/RISK_WATERFALL.md`](docs/RISK_WATERFALL.md) | 損失吸收順序（草案） |
| [`docs/CARBON_METHODOLOGY.md`](docs/CARBON_METHODOLOGY.md) | 碳分級方法與資料品質（草案） |
| [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) | 事故應變（草案） |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | signal-api 規格 |
| [`docs/RISK_MODEL.md`](docs/RISK_MODEL.md) | 金庫風險模型 |
| [`docs/VAULT_VERSIONS.md`](docs/VAULT_VERSIONS.md) | 金庫版本與鏈上實作對照 |
| [`docs/RUNBOOK_KEEPER.md`](docs/RUNBOOK_KEEPER.md)、[`docs/RUNBOOK_SITE_HEALTH.md`](docs/RUNBOOK_SITE_HEALTH.md) | 營運手冊 |

## 8. 免責聲明

本專案是測試網上的研究原型，僅供學術與技術評估。所有資產都是測試網代幣或合成曝險，
**不是證券、不代表任何真實資產的所有權或請求權**，也沒有任何價值。本文件不構成投資建議、
法律意見或任何形式的要約。PepeFi 未取得任何司法管轄區的金融業務許可；任何對公眾提供的
衍生品或代幣化資產服務，都必須由取得相應許可的機構自行評估並承擔合規責任。
