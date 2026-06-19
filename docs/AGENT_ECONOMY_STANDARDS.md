# PepeLab 與代理經濟標準（ERC-8004 / 8126 / 8183）

把本專案定位進新興的「代理經濟」三層標準堆疊：**身分（identity）→ 驗證（verification）
→ 商務（commerce）**。以下說明每層對應到 PepeLab 的哪個既有元件，以及缺口/後續。

> 註：ERC-8004 / 8126 / 8183 為新興/草案編號，本文件用以**對標定位**，非聲稱已正式合規。

---

## 三層對應總表

| 層 | 標準 | 主題 | PepeLab 對應 | 狀態 |
|----|------|------|--------------|------|
| 商務 | **ERC-8183** | agent 付費購買服務 | **x402 付費訊號 API**（端點即商品，官方 USDC、70/20/10 上鏈分潤） | ✅ 上線 |
| 驗證 | **ERC-8126** | agent 的可驗證性（ETV/MCV/SCV/WAV/WV + 統一風險分數） | **驗證層模組**：五項檢查 → 0–100 風險分數 → verifier 簽名 attestation；`GET /agent/:did/verification` | ✅ 已實作（忠於規格之子集） |
| 身分 | **ERC-8004** | agent 身分註冊 | `did:pkh` agent DID + 授權 VC（鏈下）；鏈上 registry 為 roadmap | 🟡 鏈下已做 |

---

## 1. 商務層 — ERC-8183（= x402 付費層）

- **端點即商品**：`/signals/:trader`（$0.01）、`/oracle/:asset`（$0.005），任何帶 Base
  Sepolia 官方 USDC 的 agent 直接付費購買。
- **結算**：x402 `transferWithAuthorization`（EIP-3009）→ 收入經 `FeeRouter.routeExternalRevenue`
  走 **70/20/10**（trader / platform / vault）真分潤上鏈。
- **可發現性**：`GET /` 回服務目錄（network / asset / payTo / pricing）。
- 對應 ERC-8183「agent-native commerce」：機器可讀定價 + 即時鏈上結算 + 可程式化購買。

## 2. 驗證層 — ERC-8126（agent 可驗證性）

ERC-8126 把 agent 的可信度拆成五類驗證，並彙整成單一 **0–100 風險分數**（越低越安全）。
本專案在 `agent/shared/src/verification.ts` 實作其**忠於規格的子集**，產出 ERC-8126 形狀、
由 verifier EIP-712 簽章的 attestation；端點 `GET /agent/:did/verification` 對外提供查詢。

### 五類驗證（對齊 EIP-8126 命名）

| 代碼 | 名稱 | EIP-8126 用途 | PepeLab 實作 | 分數含義 |
|------|------|----------------|--------------|----------|
| **ETV** | Ethereum Token Verification | 驗證關聯合約之合法/存在 | 結算 USDC + `PerpetualExchange` 之 `eth_getCode` 非空 | 全在鏈上＝0；缺一比例計分 |
| **MCV** | Media Content Verification | 驗證媒體內容 | **N/A**（交易 agent 無 `imageUrl`） | 不適用、排除於平均 |
| **SCV** | Solidity Code Verification | 驗證合約原始碼 | 核心合約（Perp/FeeRouter/SessionMgr）原始碼已於瀏覽器驗證（Etherscan V2 multichain API）+ bytecode 非空 | 已驗證源碼＝0；僅 bytecode（無 API key）＝30；有碼未驗源＝60；無碼＝100 |
| **WAV** | Web Application Verification | agent web 端點可達且安全 | x402 API 為 HTTPS、根路徑 200、付費端點回 402 | 三項等權，全過＝0 |
| **WV** | Wallet Verification | 錢包持有與鏈上風險 | session 錢包為非零 EOA + 鏈上交易史 + （可選）簽 challenge 出示持有證明 | 各子項計分 |

### 統一風險分數（EIP-8126 區間）

`overallRiskScore` ＝適用檢查分數的**平均**。區間：**0–20 低 / 21–40 中低 / 41–60 偏高 /
61–80 高 / 81–100 嚴重**（與規格一致）。

### 防竄改

每項檢查算出 `proofId = keccak256(規範化結果)`，五項彙整為 `summaryProofId`；verifier 用
EIP-712 簽 `{ subject, overallRiskScore, summaryProofId, issuedAt }`。`verifyAgentVerification`
會**重算所有 proofId + 重算分數 + 還原簽章者**，三道一致才算 valid——竄改任一檢查或分數即被擋。

### 簡化處（相對完整 EIP-8126，列為後續工作）

1. **無 ZK**：`proofId`／`summaryProofId` 為 keccak 摘要，**非**規格中的零知識 PDV proof。
2. **單一 verifier**：本程序自身為唯一 verifier（`VERIFIER_PRIVATE_KEY` 或一次性隨機錢包），
   未接 verifier 網路 / 鏈上 Validation Registry。
3. **身分以 did:pkh 取代 ERC-721 `agentId`**：沿用本專案 ERC-8004 風格 DID，未用鏈上 Identity Registry 的 token id。
4. **SCV 源碼驗證需 `ETHERSCAN_API_KEY`/`BASESCAN_API_KEY`**；未設時退為 bytecode-only 並如實標註。

### 與 x402 / 下單的連接

- **查詢**：`GET /agent/:did/verification` 回完整 attestation（免費、可被對手方/marketplace 探索；列於 `GET /` 目錄）。
- **MCP 讀工具**：`get_agent_verification`。
- **下單 gate（旗標，預設關）**：`RISK_GATE_ENABLED=true` 時，`open_position` 在「授權 VC」之外，
  另要求 agent 自身 `overallRiskScore ≤ RISK_SCORE_MAX`（預設 40）才放行；預設關閉以維持向後相容。
- **WV 強化（Track 3）**：agent 身分 = `did:pkh`；授權 = 使用者簽發的 **W3C VC**，verifier
  在下單前 `verifyAuthorizationVC` + 鏈上 `getSession` 交叉比對。竄改 VC / 換 agent → 驗證失敗、
  拒絕下單。詳見 `docs/AGENT_IDENTITY_VC_SSI.md`。
- **Demo**：`agent/examples/agent-verification.ts`（五項結果 + 風險分數 + 正反竄改）。

## 3. 身分層 — ERC-8004（agent 身分註冊）

- **現況（鏈下）**：每個 agent 有 `did:pkh:eip155:84532:<address>` DID；使用者用 VC 授權該 DID。
- **對應 ERC-8004**：ERC-8004 設想 agent 身分的鏈上註冊/解析。本專案的 DID + VC 是其**鏈下對應**，
  可平滑升級——未來把 agent DID + 授權狀態錨定到鏈上 registry（或撤銷清單上鏈）即為 8004 級。
- **本輪範圍**：不改合約；鏈上錨定列為 roadmap。

---

## 缺口與後續（roadmap）

1. **ERC-8004 鏈上錨定**：agent DID registry / 授權撤銷上鏈（目前撤銷靠 `AgentSessionManager.revoke`
   + VC 鏈上比對，已可擋；註冊解析尚未上鏈）。
2. **ERC-8126 強化**：接 ZK PDV proof、verifier 網路 / 鏈上 Validation Registry（取代本輪單一 verifier + keccak 摘要）。
3. **ERC-8183 擴充**：更多付費端點與動態定價、跨 agent 結算。

_最後更新：2026-06-19（ERC-8126 驗證層：五類檢查 + 統一風險分數 + verifier 簽章 + `/agent/:did/verification`）。_
