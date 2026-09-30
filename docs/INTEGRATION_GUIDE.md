# 整合說明（給持牌金融機構）

> **草案**（2026-09-30）。對象是評估 PepeFi 白標方案的期貨商、槓桿交易商與有衍生品業務的銀行。
> 本文依 repo 內的程式碼與 Base Sepolia 唯讀查詢撰寫。PepeFi 目前是**測試網研究原型**，
> 沒有第三方稽核，**不是生產系統**。標示「**規劃中**」的內容尚未實作；標示「**需客戶確認**」或
> 「**需律師確認**」的內容，需要客戶或其法律顧問決定。

## 1. 元件總覽

| 元件 | 位置 | 狀態 | 客戶會怎麼用 |
|---|---|---|---|
| 永續 CFD 引擎 `PerpetualExchange` | `contracts/src/PerpetualExchange.sol` | 已上線（測試網） | 客戶的終端客戶開平倉；客戶設定風險參數 |
| 保險金庫 `InsuranceVault` | `contracts/src/InsuranceVault.sol` | 已上線 | 吸收超過保證金的虧損 |
| 代幣化配置金庫 `AssetVaultV2`（2.4.0） | `contracts/src/v2/AssetVaultV2_4.sol` | 已上線 | 以 USDC mint／redeem 合成資產代幣（無槓桿現貨） |
| 碳分級登錄 `ESGRegistryV2` + `CarbonTiers` | `contracts/src/ESGRegistryV2.sol`、`contracts/src/CarbonTiers.sol` | 已上線 | 決定逐資產費率與槓桿上限；見 [`CARBON_METHODOLOGY.md`](CARBON_METHODOLOGY.md) |
| Agent session `AgentSessionManager` | `contracts/src/AgentSessionManager.sol` | 已上線 | 讓終端客戶授權 AI agent 在限額內代為交易 |
| `KYCRegistry` | `contracts/src/KYCRegistry.sol` | 已上線 | 對標記為 RWA 的資產做鏈上 KYC 閘門（客戶自己的 KYC 仍需在鏈下完成） |
| 價格 keeper | `agent/keeper/`、`.github/workflows/base-sepolia-keeper.yml` | 已上線 | 餵價與熔斷；見 [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md) |
| x402 付費資料 API | `agent/signal-api/` | 已上線（Vercel `sin1`） | 讓 agent 以 USDC 按次付費取得資料；規格見 [`api/openapi.yaml`](api/openapi.yaml) |
| x402 結算 worker | `agent/signal-api/src/settlement-worker.ts`、`.github/workflows/x402-settlement-worker.yml` | 已上線 | 非同步執行 70/20/10 分潤 |
| MCP server | `agent/mcp-server/` | 原始碼（stdio，本機執行） | 讓 LLM agent 以工具形式讀取與下單 |
| Telegram bot | `agent/tg-bot/` | 原始碼 | 白名單使用者以確認碼下單的範例 |
| 前端 | `frontend/` | 已上線（Vercel） | 白標前端範本；功能旗標見 [`../README.md`](../README.md) |

現行位址見 [`../README.md`](../README.md) 第 2 節，唯一來源是 `frontend/src/contracts/addresses.ts`、
`frontend/src/contracts/sessionManager.ts`、`frontend/src/contracts/x402.ts`。

## 2. 合約介面（現行部署版）

以下只列整合方最常用的函式。完整 ABI 在 `frontend/src/contracts/abi/`。資產以
`keccak256(symbol)` 的 `bytes32` 識別（例如 `keccak256("sBTC")`），見 `addresses.ts` 的 `ASSET_IDS`。

### 2.1 `PerpetualExchange`

| 函式 | 說明 |
|---|---|
| `depositMargin(uint256 amount)` | 存入保證金（MockUSDC，18 位小數）到 `freeMargin` |
| `withdrawMargin(uint256 amount)` | 從 `freeMargin` 提領；exchange 餘額不足時 revert |
| `openPosition(bytes32 asset, bool isLong, uint256 margin, uint256 leverage)` `payable` | 開倉；需附 `executionFee`（ETH）；槓桿受碳分級與逐資產上限限制 |
| `closePosition(uint256 positionId)` | 平倉 |
| `liquidatePosition(uint256 positionId)` | 任何人可清算低於維持保證金的部位 |
| `settleFunding(bytes32 asset)` | 每 8 小時可結算一次 funding（keeper 會呼叫） |
| `getPosition`、`getUserPositions`、`getUnrealizedPnL`、`pendingFunding`、`getFundingRate`、`getMarkPrice`、`getAccountHealth` | 讀取 |
| `maxLeverageForAsset`、`tradingFeeBpsForAsset`、`maintenanceMarginBpsForAsset` | 逐資產風險參數讀取 |

所有會改變狀態的呼叫都會檢查價格新鮮度：價格超過 `maxPriceAge`（現行 6 小時）時 revert `StalePrice`。
owner 可設定的參數（費率、逐資產槓桿上限與維持保證金、ADL、KYC registry、RWA 標記等）見原始碼的
`onlyOwner` 函式。**現行部署沒有暫停或逐資產停單功能**；原始碼版（PR #191，未部署）才有，
見 [`RISK_WATERFALL.md`](RISK_WATERFALL.md) 第 3 節。

### 2.2 `AgentSessionManager`

| 函式 | 誰呼叫 | 說明 |
|---|---|---|
| `createSession(address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 maxLeverage, uint256 expiry)` | 終端客戶 | 建立 session；`session.user = msg.sender` |
| `createSessionWithAssets(..., bytes32[] allowedAssets)` | 終端客戶 | 同上，並設定資產白名單 |
| `setSessionAssets(uint256 sessionId, bytes32[] assets)` | 終端客戶 | 修改白名單（agent 無法自行放寬） |
| `revokeSession(uint256 sessionId)` | 終端客戶 | 立即撤銷 |
| `openPositionForSession(sessionId, asset, isLong, margin, leverage, copiedFrom)` | agent | 在限額內開倉 |
| `closePositionForSession(sessionId, positionId)` | agent | 只能平這個 session 自己開的倉 |
| `isAssetAllowed`、`allowedAssets`、`sessionOfPosition` | 任何人 | 讀取 |

### 2.3 `AssetVaultV2`（2.4.0）

| 函式 | 說明 |
|---|---|
| `previewMint(bytes32 assetId, uint256 usdcAmount)` / `previewRedeem(bytes32 assetId, uint256 tokenAmount)` | 試算 |
| `mint(bytes32 assetId, uint256 usdcAmount)` | 以 USDC 買入合成資產代幣；費率依碳分級；準備率低於門檻或已鎖住時拒絕 |
| `redeem(bytes32 assetId, uint256 tokenAmount)` | 贖回；固定費率；不受準備率門檻限制，但金庫 USDC 不足時會失敗 |
| `reserveRatioBps()`、`reserveStatus()` | 準備率與其可信度 |

金庫為**非足額抵押**的合成曝險，見 [`RISK_WATERFALL.md`](RISK_WATERFALL.md) 第 5 節與 [`RISK_MODEL.md`](RISK_MODEL.md)。

## 3. signal-api 端點

實作：`agent/signal-api/src/app.ts`。完整規格：[`api/openapi.yaml`](api/openapi.yaml)。

| 方法與路徑 | 價格 | 說明 |
|---|---|---|
| `GET /healthz` | 免費 | liveness，回 `ok` |
| `GET /` | 免費 | 服務目錄：網路、結算代幣、收款地址與其安全檢查結果、端點清單 |
| `GET /revenue` | 免費 | 鏈上 x402 FeeRouter 的 70/20/10 累計；可帶 `?trader=` |
| `GET /candles/:symbol` | 免費 | K 線；`interval`（1m/5m/15m/1h/4h/1d）、`limit`（上限 500）、`end` |
| `GET /benchmarks` | 免費 | S&P 500、公債（TLT）、黃金、比特幣對照；可帶 `?date=YYYY-MM-DD` |
| `GET /agent/:did/verification` | 免費 | ERC-8126 風格的 agent 驗證結果（verifier 簽章） |
| `POST /demo/buy-signal` | 免費 | 訪客試用；不付款、不結算；有 per-IP 冷卻與總量上限 |
| `GET /signals/:trader` | 0.01 USDC | trader 績效摘要與開倉建議 |
| `GET /oracle/:asset` | 0.005 USDC | 價格、funding、OI 失衡、預估清算價與建議 |

免費端點（`/healthz` 除外）有 per-IP 節流（預設每 60 秒 60 次，回 429）。付費端點不另外節流。

## 4. x402 付費流程

1. agent 不帶 `X-PAYMENT` 呼叫付費端點。
2. 伺服器在發出付款要求**之前**依序檢查，任何一項不通過都**不會**要求付款：
   - 輸入驗證：未知資產、非法地址、零地址、已知外洩地址 → 400。
   - **收款地址守門（fail-closed）**：收款地址必須是 EOA，不可在外洩清單、不可有 EIP-7702 委派、
     不可是合約；不通過就回 **503 `payto_unsafe`**（`Retry-After: 600`）。
   - `/signals`：trader 必須已在 `StrategyRegistry` 註冊（未註冊 400；讀不到 registry 503）。
   - `/oracle`：鏈上價格若已超過交易所的 `maxPriceAge` → 503 `price_stale`。
3. 通過後回 **402**，本文含 `accepts`（x402 `exact` scheme、Base Sepolia、Circle USDC、金額、
   `payTo`、`maxTimeoutSeconds` 60）。
4. agent 以 EIP-3009 `transferWithAuthorization` 簽名，放入 `X-PAYMENT` 標頭重送。
5. 伺服器向 facilitator（預設 `https://x402.org/facilitator`）驗證，執行 handler，再請 facilitator 結算。
   結算成功才會帶 `X-PAYMENT-RESPONSE` 標頭。handler 回 4xx 時不結算、不扣款。
6. 結算成功後，伺服器以冪等鍵（facilitator 結算 tx hash，其次為付款人加 EIP-3009 nonce）把分潤排入
   Upstash Redis 佇列；回應中的 `settled: true` 代表「已排入佇列」，**不代表已上鏈**。
7. 結算 worker（GitHub Actions，每 10 分鐘，單一簽署金鑰）取出佇列，對每筆送出
   `FeeRouter.routeExternalRevenue(trader, fee)`：trader 70%、平台 20%、保險金庫 10%。
   這筆分潤與買方的付款是**兩筆不同的交易**，不是原子操作。

**現況（2026-09-30）**：
- 正式 signal-api 的收款地址未通過守門，付費端點回 503。需要使用者更換收款設定。
- x402 FeeRouter `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` 的 treasury 仍是已外洩的舊地址，
  需重新部署；在此之前結算 worker 的出金前檢查會拒跑。
- facilitator 不強制 `maxTimeoutSeconds` 上限、公用 facilitator 的限流未知，見
  [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) 第 14–20 項。

## 5. Agent session 授權流程

```
終端客戶（錢包）                 AgentSessionManager（鏈上）            agent（鏈下程式）
     │ 1. createSession(agent, 單筆上限, 總預算, 槓桿上限, 到期[, 資產白名單])
     │───────────────────────────────▶│
     │ 2. 以 EIP-712 簽發授權 VC（issuer = 客戶、holder = agent）
     │──────────────────────────────────────────────────────────────▶│
     │                                │ 3. agent 下單前驗證 VC 與鏈上 session 一致
     │                                │◀──────────── 4. openPositionForSession(...)
     │                                │ 5. 合約檢查：呼叫者 = agent、未撤銷、未過期、
     │                                │    資產在白名單、單筆 ≤ 上限、累計 ≤ 預算、槓桿 ≤ 上限
     │ 6. revokeSession(id)（隨時）    │
     │───────────────────────────────▶│
```

- **鏈上強制**：agent 身分、到期、撤銷、單筆保證金上限、總保證金預算、槓桿上限、資產白名單、
  只能平自己開的倉、RWA 資產的 KYC（檢查的是部位持有人，即終端客戶）。限額以**保證金**計，不是名目。
- **只在鏈下檢查**：授權 VC（`frontend/src/contracts/agentAuth.ts` 定義的 EIP-712 結構，
  驗證在 `agent/shared/src/write.ts`）。合約**不驗 VC**。VC 預設必填，但測試旗標可以關閉。
- **已知缺口**：VC 沒有 nonce／audience／防重放；MCP server 沒有傳輸層認證；沒有 KYA／KYT。
  見 [`AGENT_IDENTITY_VC_SSI.md`](AGENT_IDENTITY_VC_SSI.md) 與 [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)。
- AgentSessionManager 本身必須被 exchange 的 owner 授權（`setAgentAuthorized`）。撤銷這個授權會讓所有 session
  既無法開倉、也無法由 agent 平倉；終端客戶仍可用自己的錢包直接 `closePosition`。
- MCP server 提供 7 個工具：5 個唯讀（`get_trader_performance`、`get_funding_rate`、`get_position`、
  `get_session`、`get_agent_verification`）與 2 個會送交易的（`open_position`、`close_position`，需要 session 與 VC）。

**需客戶確認**：終端客戶授權 AI agent 代為交易，是否構成客戶所在法域的全權委託或代客操作，
以及需要的揭露與同意程序。**需律師確認**。

## 6. 租戶部署模型（規劃中）

目前只有**單一共用部署**（所有測試網使用者共用同一組合約與 keeper）。以下是規劃的白標模型，**尚未實作**：

| 項目 | 規劃 | 目的 |
|---|---|---|
| 合約 | 每個租戶一組獨立的 exchange、保險金庫、代幣化金庫與 session manager | 資金池、損失吸收與風險參數互不影響 |
| keeper | 每個租戶獨立的 keeper 與餵價金鑰 | 一個租戶的價格事故不影響其他租戶 |
| 金鑰 | 每個租戶獨立的 owner、guardian、risk、keeper、結算金鑰；owner 與 guardian 規劃改為客戶控制的 multisig | 權限隔離；客戶保有治理權 |
| 前端 | 以功能旗標與品牌設定產生客戶版本，部署在客戶的網域與雲端帳號 | 資料駐留與品牌 |
| signal-api | 每租戶獨立部署與收款地址，區域依客戶要求 | 資料駐留、收入隔離 |
| 資料源 | 客戶可指定授權的價格與 ESG 資料源 | 取代目前的公開免費來源 |

**需客戶確認**：部署在哪條鏈（目前只有 Base Sepolia 測試網）、雲端區域、誰持有哪些金鑰。

## 7. 責任分工

| 項目 | PepeFi（我方） | 持牌客戶 |
|---|---|---|
| 合約與 agent 程式碼 | 開發、測試、修補、文件 | 決定是否採用、委託第三方稽核（**需客戶確認**：稽核由誰出資與選任） |
| 部署與 cutover | 提供腳本與程序 | 規劃中：由客戶或客戶授權的人員持有金鑰並執行 |
| 風險參數 | 提供預設值與說明 | 由客戶的風險委員會決定並設定 |
| 價格來源 | 提供 keeper 與熔斷 | 決定可接受的資料源並取得授權 |
| 終端客戶的 KYC／AML、適合度、揭露 | 不負責 | 負責 |
| 事故應變 | 依 [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) 協助 | 對主管機關與終端客戶的通報 |

完整的合規責任邊界見 [`COMPLIANCE_BOUNDARY.md`](COMPLIANCE_BOUNDARY.md)，損失吸收見
[`RISK_WATERFALL.md`](RISK_WATERFALL.md)。
