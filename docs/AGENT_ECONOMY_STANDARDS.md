# PepeLab 與代理經濟標準（ERC-8004 / 8126 / 8183）

把本專案定位進新興的「代理經濟」三層標準堆疊：**身分（identity）→ 驗證（verification）
→ 商務（commerce）**。以下說明每層對應到 PepeLab 的哪個既有元件，以及缺口/後續。

> 註：ERC-8004 / 8126 / 8183 為新興/草案編號，本文件用以**對標定位**，非聲稱已正式合規。

---

## 三層對應總表

| 層 | 標準 | 主題 | PepeLab 對應 | 狀態 |
|----|------|------|--------------|------|
| 商務 | **ERC-8183** | agent 付費購買服務 | **x402 付費訊號 API**（端點即商品，官方 USDC、70/20/10 上鏈分潤） | ✅ 上線 |
| 驗證 | **ERC-8126** | agent 的可驗證性（WV / SCV / WAV） | 合約 BaseScan 驗證、x402 API HTTPS、session 錢包 + VC 驗簽 | ✅ 多數具備 |
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

ERC-8126 關注 agent 的多面向可驗證性。PepeLab 現況：

| 面向 | 含義 | PepeLab 證據 |
|------|------|--------------|
| **SCV** (Smart-Contract Verified) | 合約原始碼已驗證 | 核心合約已於 **BaseScan 驗證**（Base Sepolia） |
| **WAV** (Web-Accessible / API Verified) | 服務經 HTTPS 可達且可驗 | x402 Signal API 走 **HTTPS**（Vercel），`/healthz`、可發現 `/` |
| **WV** (Wallet Verified) | agent 錢包/授權可驗證 | **agent session 錢包**（自管 EOA）+ **授權 VC 驗簽**（見下） |

- **WV 強化（Track 3）**：agent 身分 = `did:pkh`；授權 = 使用者簽發的 **W3C VC**，verifier
  在下單前 `verifyAuthorizationVC` + 鏈上 `getSession` 交叉比對。竄改 VC / 換 agent → 驗證失敗、
  拒絕下單。詳見 `docs/AGENT_IDENTITY_VC_SSI.md`。

## 3. 身分層 — ERC-8004（agent 身分註冊）

- **現況（鏈下）**：每個 agent 有 `did:pkh:eip155:84532:<address>` DID；使用者用 VC 授權該 DID。
- **對應 ERC-8004**：ERC-8004 設想 agent 身分的鏈上註冊/解析。本專案的 DID + VC 是其**鏈下對應**，
  可平滑升級——未來把 agent DID + 授權狀態錨定到鏈上 registry（或撤銷清單上鏈）即為 8004 級。
- **本輪範圍**：不改合約；鏈上錨定列為 roadmap。

---

## 缺口與後續（roadmap）

1. **ERC-8004 鏈上錨定**：agent DID registry / 授權撤銷上鏈（目前撤銷靠 `AgentSessionManager.revoke`
   + VC 鏈上比對，已可擋；註冊解析尚未上鏈）。
2. **ERC-8126 形式化**：把 SCV/WAV/WV 整理成機器可讀的 verifiable presentation。
3. **ERC-8183 擴充**：更多付費端點與動態定價、跨 agent 結算。

_最後更新：2026-06-19（Track 2C / 3）。_
