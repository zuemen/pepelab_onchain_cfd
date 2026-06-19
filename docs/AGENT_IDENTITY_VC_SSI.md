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

## 6. 範圍與後續

- 本層為**鏈下身分層**，**不改合約**（VC/SSI 不需要鏈上新方法）。
- 鏈上錨定（ERC-8004 註冊、撤銷清單上鏈）為後續工作。
- 前端 Agent Sessions / Agent Monitor 顯示每個 agent 的 DID 與「可發授權憑證」狀態。

_最後更新：2026-06-19（Track 3）。_
