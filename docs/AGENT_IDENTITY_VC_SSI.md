# Agent 身分與授權：Verifiable Credentials (VC) + Self-Sovereign Identity (SSI)

讓「AI agent 代你交易」不只是握有一把 session key，而是**有可驗證的身分與授權憑證**。
本文件說明設計；輕量實作在 `agent/shared/src/identity.ts`，可跑 demo 見
`agent/examples/agent-identity.ts`。

---

## 1. 為什麼要做（問題）

現況：使用者用 `AgentSessionManager.createSession` 在鏈上授權一把 agent session key
（限額/預算/槓桿/到期）。這已經很安全，但**授權的「意圖」只存在鏈上**，agent 對外
無法用一份可攜、可離線驗證的憑證證明「我被誰、授權做什麼」。

VC/SSI 補上這層：把鏈上授權**憑證化**成一份 W3C Verifiable Credential，任何 verifier
（MCP server、demo-agent、第三方）都能**離線驗簽**並與鏈上 session 交叉比對。

## 2. SSI 三角與 W3C 概念對應

```
        issues (簽發)                    presents (出示)
 ┌───────────┐  ───────────►  ┌──────────┐  ───────────►  ┌────────────┐
 │  Issuer   │   授權 VC       │  Holder  │   授權 VC       │  Verifier  │
 │ = 使用者   │                │ = AI agent│                │ = MCP/agent │
 │ (EOA)     │  ◄───────────  │ (session  │  ◄───────────  │  下單前驗證  │
 └───────────┘   信任錨=簽章    │  key EOA) │   驗簽+鏈上比對  └────────────┘
                               └──────────┘
```

- **DID（去中心化識別碼）**：用 W3C `did:pkh`，直接由 EVM 位址導出，**免額外身分基礎設施**：
  `did:pkh:eip155:84532:<address>`。使用者與 agent 各有一個 DID。
- **VC（可驗證憑證）= 授權憑證**：使用者（issuer）簽發給 agent（holder），內容 =
  「授權此 agent DID 在 session #N 限額內代為交易」。本質是鏈上 `AgentSessionManager`
  授權的**憑證化視圖**。
- **Verifier**：下單前 `verifyAuthorizationVC(vc)` 驗簽，再與鏈上 `getSession` 交叉比對
  （issuer==session.user、agent==session.agent、sessionId 相符、未撤銷），全部通過才執行。

## 3. 憑證格式（W3C VC + EIP-712 proof）

簽章用 **EIP-712 typed data**（沿用既有 ethers 堆疊，不引入重量級 DID/JSON-LD 套件）。
`proof.type = EthereumEip712Signature2021`，`proofValue` = issuer 對下列 typed data 的簽章：

```
domain = { name: "PepeLabAgentAuthorization", version: "1", chainId: 84532 }
AgentTradingAuthorization = {
  issuer, agent (address);
  sessionId, maxLeverage, expiry, issuedAt (uint256);
  maxMarginPerTrade, totalBudget (string)
}
```

範例 VC JSON（節錄自 `agent-identity.ts` 實跑輸出）：

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1",
               "https://pepelab.xyz/credentials/agent-authorization/v1"],
  "type": ["VerifiableCredential", "AgentTradingAuthorization"],
  "issuer": "did:pkh:eip155:84532:0x<user>",
  "issuanceDate": "2026-06-19T…Z",
  "expirationDate": "2026-06-20T…Z",
  "credentialSubject": {
    "id": "did:pkh:eip155:84532:0x<agent>",
    "sessionId": 7,
    "authorization": { "maxMarginPerTrade": "1000", "totalBudget": "5000",
                       "maxLeverage": 5, "expiry": 1781926272 }
  },
  "proof": {
    "type": "EthereumEip712Signature2021",
    "created": "2026-06-19T…Z",
    "proofPurpose": "assertionMethod",
    "verificationMethod": "did:pkh:eip155:84532:0x<user>#blockchainAccountId",
    "proofValue": "0x<eip712-signature>"
  }
}
```

## 4. 驗證邏輯（正反對照）

`verifyAuthorizationVC(vc)`：
1. 從 `vc.issuer` / `credentialSubject.id` 解出 issuer / agent 位址（did:pkh）。
2. 用 VC 內欄位重建 EIP-712 typed value，`ethers.verifyTypedData` 還原簽章者。
3. 還原位址 **必須等於 issuer**，否則 `valid:false`。
4. 檢查未過期。

下單時 `openPositionForSession({ …, authVc })` 再做**鏈上交叉比對**（`verifyVcAgainstChain`）：
sessionId 相符、holder==本 session key、issuer==鏈上 `session.user`、agent==`session.agent`、未撤銷。

| 情境 | 結果 |
|------|------|
| 正常 VC | ✓ 驗證通過 → 在 session 限額內下單 |
| 竄改授權上限（如 maxLeverage 5→50） | ✗ 簽章不符 → 拒絕 |
| 換掉 holder agent 位址 | ✗ 簽章不符 → 拒絕 |
| VC 的 agent ≠ 實際 session key | ✗ holder 不符 → 拒絕 |
| 鏈上 session 已撤銷 / issuer≠session.user | ✗ 鏈上比對不符 → 拒絕 |

跑 `cd agent && npx tsx examples/agent-identity.ts` 可看到 ①簽發 ②驗證✓ ③竄改✗ ④換 agent✗。

## 5. 對應代理經濟標準（見 `AGENT_ECONOMY_STANDARDS.md`）

- **ERC-8004（代理身分註冊）**：本設計的 `did:pkh` + 授權 VC 是其鏈下對應；未來可把 agent DID
  錨定到鏈上 registry（列為 roadmap，本輪不改合約）。
- **ERC-8126（代理驗證）**：VC 驗簽 + 鏈上 session 交叉比對，強化 `WV`（錢包驗證）面向。

## 6. 為什麼授權憑證放在 tool arguments，而不是傳輸層

MCP 規範把授權放在傳輸層（HTTP transport 用 OAuth 2.1 / `Authorization` header），
而且 Authorization 整章是 OPTIONAL。常見的做法（例如某金控 AI 支付 PoC 的 Secure
Broker）是把 API key 放在 transport header，並明文要求「不要放在 tool arguments」。

本專案的 `open_position` / `close_position` 反其道而行：**必填** `authVcJson`
參數（`agent/mcp-server/src/index.ts`），在 `agent/shared/src/write.ts` 的
`verifyVcAgainstChain` 驗簽並與鏈上 session 交叉比對。這不是疏忽，是因為兩種憑證的
威脅模型不同。

### 6.1 bearer token：拿到就是你

API key / OAuth access token 是 **bearer** 憑證：伺服器只檢查「這串字對不對」，
不檢查「是誰拿著」。放進 tool arguments 會大幅擴大外洩面——arguments 會進 LLM 的
context window、對話紀錄、tool call log、trace、錯誤回報，甚至被模型複述進回答。
任何一處外洩，拿到的人就能直接冒用。所以 bearer token 放 transport header、
不讓模型看見，是正確的。

### 6.2 授權 VC：自證、綁定、複製到別處沒用

授權 VC 不是 bearer token，它是**簽過名的聲明**，綁定了具體的主體與範圍：

- issuer = 使用者 EOA（EIP-712 簽章，改任何欄位都會驗簽失敗）
- `credentialSubject.id` = 特定 agent 的 did:pkh
- `sessionId` = 特定鏈上 session，caps 必須與鏈上**完全一致**
- 下單時要求 VC 的 agent == 本伺服器持有的 session key（holder 綁定）

所以把一份 VC 複製到**另一個 agent / 另一台伺服器**，它無法使用：對方沒有那把
session key，holder 比對過不了；就算有 key，鏈上 `AgentSessionManager` 也只接受
那個 session 的 agent 位址，並受 per-trade cap / budget / leverage / 資產白名單 /
到期約束。VC 外洩的最壞情況被鏈上限額框住，而且 VC 的內容本身（誰授權誰、上限多少）
並不是秘密。

它放在 arguments 還有一個正面理由：**授權是逐筆呈現的**。每一次寫操作都帶著
「這筆動作依據哪一份授權」，verifier 可以對那份授權做完整檢查並記進 audit trail；
transport header 表達的是「這條連線是誰」，粒度是連線，不是動作。

### 6.3 誠實邊界：沒做到的

- **VC 沒有 per-request 的 nonce / audience / 防重放。**（2026-09-30 起 v2 有 credential 層級的 `nonce`／`validUntil`
  與取代規則，2026-10-02 起可撤銷，見 §8；但仍不是 per-request。）holder 綁定讓它在
  「別的伺服器」上無效，但在**本伺服器**（持有 session key 的那一台）上，一份外洩的
  VC 在過期或 session 撤銷前可以被重複使用。實際防線是鏈上限額，不是 VC 本身。
- **MCP server 沒有傳輸層認證。** 目前只走 stdio；依 MCP 規範，stdio 本來就不走
  HTTP Authorization 流程，信任邊界是「誰能啟動這個 process」。在這個邊界內：
  - read tools（`get_trader_performance`、`get_funding_rate`、`get_position`、
    `get_session`、`get_agent_verification`）**完全開放**——讀的都是鏈上公開資料，
    對 demo 可接受；
  - write tools 的保護只有 VC + 鏈上限額。能啟動 process 的人，拿到一份有效 VC
    就能在限額內下單。
- **生產化需要補：** 若改成 Streamable HTTP 對外提供，必須加上傳輸層認證
  （OAuth 2.1 或至少 mTLS / API key in header）來回答「這條連線是誰」，
  VC 繼續回答「這筆動作被誰授權」。兩層並存，而不是二選一。另需在 VC 或請求層加入
  nonce / 短時效，關閉同一伺服器上的重放窗口。

## 7. VC 管主體，KYA 管位址

VC 回答「**誰**授權了這個 agent、授權範圍多大」。它**不**回答「這個位址本身有沒有
問題」——受制裁、與混幣器或已知攻擊有關聯。一個持有完全合法 VC 的 agent，照樣可以
把錢付給一個受制裁的位址；反過來，一個乾淨的位址也無法證明操作它的 agent 被授權。

| | 驗證對象 | 回答的問題 | 本專案現況 |
|---|---|---|---|
| VC / SSI（本文件） | 主體（使用者 → agent 的授權關係） | 這個動作有沒有被授權？範圍多大？ | 已實作 |
| KYA / KYT | 位址（對手方的鏈上風險） | 這個位址能不能往來？ | **未實作**，見 `KNOWN_LIMITATIONS.md` §17 |

兩者互補而非互相取代：生產化的付款路徑應該是「VC 驗授權 → KYA 驗對手方位址 →
簽章/送出」。

## 8. 撤銷（2026-10-02，ADR-016）

簽發者（使用者錢包）可以用**同一把金鑰、同一個 EIP-712 domain** 簽一份狀態清單，撤銷個別 VC（以 jti；v2 的 jti 就是
簽進去的 `nonce`，v1 是 EIP-712 digest），或以 `revokedBefore` 撤銷某時間點之前簽發的全部 VC。下單與平倉前
（`write.ts`）一律檢查：被撤銷、或拿不到／驗不過狀態 → 拒絕（`VC_REVOKED`／`VC_STATUS_UNVERIFIED`）。清單有
單調 `sequence`、`issuedAt`、`validUntil`，驗證端記住最高 sequence 與看過的所有撤銷，舊清單不能讓撤銷復活。
設計、取捨、操作步驟：[ADR-016](ADR-016-vc-credential-status.md)。

## 9. 範圍與後續

- 本層為**鏈下身分層**，**不改合約**（VC/SSI 不需要鏈上新方法）。
- 鏈上錨定（ERC-8004 註冊、撤銷登記上鏈）為後續工作；8004 註冊工具與 Base Sepolia registry 查證見
  `AGENT_ECONOMY_STANDARDS.md` §3。
- 前端 Agent Sessions / Agent Monitor 顯示每個 agent 的 DID 與「可發授權憑證」狀態；前端撤銷按鈕尚未做。

_最後更新：2026-06-19（Track 3）；§6–§7 於 2026-09-17 新增；§8 撤銷於 2026-10-02 新增。_
