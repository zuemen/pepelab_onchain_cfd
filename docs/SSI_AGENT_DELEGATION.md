# SSI 委託授權（VC v3）× 鏈上錨定 × x402 Know-Your-Agent

把「AI 代理人的 session key」從「握有一把受限金鑰」升級成**可驗證的委託授權**：使用者以錢包簽發一張
W3C VC 2.0 委託憑證，憑證逐欄對應鏈上 session，並附 x402 付費上限；使用者把憑證雜湊錨定在鏈上；
代理人呼叫付費 API 時出示 Verifiable Presentation，賣方在收錢之前確認「哪一把錢包、授權了這個代理人、授權到哪裡」。
它證明的是**委託關係與上限**，不是委託人的真實身分（見 §8：自我委託）。

相關文件：v1/v2 授權 VC 的設計見 [AGENT_IDENTITY_VC_SSI.md](AGENT_IDENTITY_VC_SSI.md)；撤銷（狀態清單）見
[ADR-016](ADR-016-vc-credential-status.md)；x402 v1/v2 見 [ADR-010](ADR-010-x402-v2-migration.md)；
合格投資人 VC 與 RWA 開倉閘門見 `feat/vc-kyc-registry` 分支的 `docs/SSI_RWA_ACCESS.md`。

---

## 1. 信任鏈

```
 發證者（合格投資人審核方）
   │  簽發「合格投資人 VC」（SSI_RWA_ACCESS.md，VCKycRegistry）
   ▼
 投資人＝使用者（EOA，did:pkh）
   │  ① 鏈上 AgentSessionManager.createSessionWithAssets（額度、槓桿、到期、資產白名單）
   │  ② 錢包 EIP-712 簽發「委託憑證 v3」AgentDelegationCredential（逐欄＝鏈上 session ＋ x402 上限）
   │  ③ SessionCredentialAnchor.anchor(sessionId, credentialHash)   ← 只有 session.user 能做
   ▼
 代理人（session key，did:pkh）＝ holder
   │  ④ 付費呼叫：x402 付款（EIP-3009，付款人＝代理人）＋ X-Agent-Presentation（代理人簽的 VP）
   ▼
 signal-api（x402 賣方）＝ verifier：Know Your Agent
   │  VP 簽者＝憑證主體＝付款人；憑證簽章／期限／撤銷（ADR-016，fail-closed）；
   │  鏈上 session 逐欄一致；錨定存在；依 credentialHash 累計花費 ≤ 憑證上限 → 才把付款交給 facilitator
   ▼
 鏈上下單：AgentSessionManager.openPositionForSession（合約再檢查一次額度）
   │
   ▼
 RWA 開倉閘門：PerpetualExchange 的 KYC 檢查（VCKycRegistry 由合格投資人 VC 准入，另一分支）
```

兩個層次各自成立、互不依賴：

| 層 | 誰強制 | 繞過鏈下程式會怎樣 |
|---|---|---|
| 鏈上 session（額度、槓桿、到期、資產、撤銷） | `AgentSessionManager`（未修改） | 照樣被合約擋 |
| 委託憑證（誰授權、x402 上限、付費端點範圍） | 代理人寫入路徑、signal-api KYA | 付費 API 拒收；下單仍受合約約束 |
| 錨定（使用者目前認可的那一張） | `SessionCredentialAnchor`（新合約，唯讀依賴 session manager） | 未錨定的憑證被 KYA 拒絕（`X402_KYA_ANCHOR=required`） |

## 2. 委託憑證 v3（AgentDelegationCredential）

Schema 單一來源：`frontend/src/contracts/agentDelegation.ts`（純函式、無相依，前端與 agent 共用；
`agentAuth.ts` 末尾 re-export）。簽發／驗證／presentation：`agent/shared/src/delegation.ts`。

```jsonc
{
  "@context": ["https://www.w3.org/ns/credentials/v2", "https://pepelab.xyz/credentials/agent-delegation/v3"],
  "id": "urn:pepelab:agent-delegation:<nonce>",
  "type": ["VerifiableCredential", "AgentDelegationCredential"],
  "issuer": "did:pkh:eip155:<chainId>:<使用者>",
  "validFrom": "…", "validUntil": "…",            // validUntil ≤ 鏈上 session 到期
  "credentialSubject": {
    "id": "did:pkh:eip155:<chainId>:<代理人>",
    "sessionManager": "0x…", "sessionId": 3,
    "session": {                                     // 鏈上原始單位（18 位小數），驗證端以「完全相等」比對
      "maxMarginPerTrade": "100000000000000000000", "totalMarginBudget": "…",
      "maxLeverage": 5, "expiry": 1790000000, "allowedAssets": ["0x…sBTC", "0x…sETH"]
    },
    "x402": {                                        // atomic USDC（6 位小數）
      "maxPerPeriod": "20000", "periodSeconds": 3600, "maxTotal": "30000",
      "endpoints": ["GET /signals/*", "GET /oracle/*"], "currency": "USDC", "decimals": 6
    },
    "nonce": "0x…"                                   // jti
  },
  "credentialStatus": {
    "id": "<清單位置>#<nonce>", "type": "PepeLabCredentialStatusList2026",
    "statusPurpose": "revocation", "statusListIndex": "<nonce>",
    "statusListCredential": "<VC_STATUS_URL>/<issuer>.json 或 urn:pepelab:vc-status:…"
  },
  "proof": {
    "type": "EthereumEip712Signature2021", "proofPurpose": "assertionMethod",
    "verificationMethod": "<issuer DID>#blockchainAccountId", "created": "…", "proofValue": "0x…",
    "eip712": { "domain": { "name": "PepeLabAgentDelegation", "version": "3", "chainId": …, "verifyingContract": "<session manager>" },
                "primaryType": "AgentDelegationCredential", "types": { … } }
  }
}
```

- **簽的內容**：EIP-712 型別 `AgentDelegationCredential`（issuer、agent、sessionManager、sessionId、四個額度、
  `bytes32[] allowedAssets`、巢狀 `X402Allowance`、validFrom、validUntil、nonce）。與 v2 一樣是 JSON 文件的
  **扁平投影**：驗證端從 JSON 重建投影再驗簽，JSON 的每個語意欄位都在簽章範圍內。資產清單以正規形式
  （小寫、去重、排序）簽入，與鏈上 `allowedAssets(id)` 以集合比較。
- **credentialHash** ＝ EIP-712 digest。它是錨定值，也是 x402 花費的累計鍵。改任何一欄＝另一張憑證。
- **jti** ＝ `nonce`（與 v2 相同）。因此 ADR-016 狀態清單、`vcNonce.ts` 的一次性／取代規則**原封不動**
  適用於 v3：`delegationAsVerifyResult()` 把 v3 結果投影成 v2 形狀（version 2 在那兩個模組裡的意思是
  「帶 nonce 的世代」）。`identity.ts`、`vcStatus.ts`、`vcNonce.ts` 都沒有改行為，只在 `identity.ts` 註解與
  re-export 加了 v3。
- **DID 鏈**：v3 的 DID 與 domain 用 session 所在的鏈（anvil 31337、Base Sepolia 84532）。驗證端接受的鏈：
  `DELEGATION_VC_CHAIN_IDS`（預設 `AGENT_CHAIN_ID` 與 84532）。

### 驗證（寫入路徑與 KYA 共用）

`verifyDelegationCredential` → `checkCredentialStatus`（寫入語意：拿不到狀態＝拒絕）→
`compareDelegationWithSession`（`sessions(id)`＋`allowedAssets(id)`：user、agent、四個額度、到期、資產集合、
未撤銷、未到期）→ nonce／取代檢查。原因代碼：`VC_BAD_SIGNATURE`、`VC_WRONG_CHAIN`、
`VC_WRONG_VERIFYING_CONTRACT`、`VC_EXPIRED`、`VC_NOT_YET_VALID`、`VC_VALIDITY_EXCEEDS_SESSION`、
`VC_STATUS_POINTER_MISMATCH`、`VC_X402_ALLOWANCE_INVALID`、`SESSION_*_MISMATCH`、`SESSION_REVOKED`、`SESSION_EXPIRED`。

## 3. 鏈上錨定：`SessionCredentialAnchor`

`contracts/src/SessionCredentialAnchor.sol`（部署：`script/DeploySessionCredentialAnchor.s.sol`，
`SESSION_MANAGER_ADDR=…`；無管理員、無升級）。只讀 `AgentSessionManager.sessions(id)` 的 getter
（user、expiry、revoked），**不修改** `AgentSessionManager` 與 `PerpetualExchange`。

| 介面 | 說明 |
|---|---|
| `anchor(sessionId, credentialHash)` | 只有 `sessions(id).user`；session 必須未撤銷、未到期；取代目前的錨定（舊的不再 `isAnchored`）；同一個 hash 重複錨定 revert |
| `unanchor(sessionId, credentialHash)` | 只有 user；必須是目前那一張；session 撤銷／到期後仍可清理 |
| `isAnchored(sessionId, hash) → bool` | **即時**：是目前錨定的那一張 **且** session 未撤銷、未到期 |
| `anchorStatus(sessionId, hash)` | `(recorded, sessionLive, user, since)`，給驗證端解釋拒絕原因 |
| `currentCredential`、`anchoredAt`、`anchorCount` | 稽核用；撤銷後紀錄保留 |
| 事件 | `CredentialAnchored(sessionId, user, credentialHash, previousHash, version)`、`CredentialUnanchored(…)` |

撤銷 session 之後：`isAnchored` 立即為 false（不需要另一筆交易），`currentCredential` 保留供稽核。

**誰會讀錨定**（2026-10-07 起兩處）：

- signal-api 的 x402 KYA（第 4 節，`X402_KYA_ANCHOR`）。
- 代理人的寫入路徑（`agent/shared/src/write.ts` → `delegation.ts` 的 `checkDelegationAnchor`）：代理人的環境有設
  `SESSION_ANCHOR_ADDRESS` 時，**開倉**要求 `isAnchored(sessionId, credentialHash)`；錨定合約綁的 manager 不是代理人用的那一顆、
  位址打錯、或讀不到，一律拒絕開倉（fail-closed）。**平倉**不看錨定：使用者解除錨定是為了停掉代理人，不能反過來把部位鎖住。
  沒設 `SESSION_ANCHOR_ADDRESS` 時不檢查（與之前相同）。

這兩處都只約束「跑這份程式的代理人」。代理人金鑰外洩時，攻擊者可以直接呼叫 `AgentSessionManager.openPositionForSession`，
鏈上只檢查 session 的額度與白名單，不看憑證或錨定——硬性停止要用 `revokeSession`。

## 4. x402 KYA（signal-api）

`agent/signal-api/src/kya.ts`，接在 `app.ts` 付費牆分流之前，v1（`X-PAYMENT`）與 v2（`PAYMENT-SIGNATURE`）都適用。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `X402_KYA_MODE` | `off` | `on` 才啟用；未設或 `off` 時行為與加入前完全相同。**其他任何值**（`true`、`1`、打錯字）視為設定錯誤：付費端點一律 503 `kya_misconfigured`，不會悄悄關閉 |
| `X402_KYA_ANCHOR` | `required` | `required`／`optional`／`off` |
| `SESSION_MANAGER_ADDRESS` | — | 憑證必須綁定的 session manager；未設 → 付費端點 503 |
| `SESSION_ANCHOR_ADDRESS` | — | 錨定合約；`required` 時未設 → 503。第一次使用時讀它的 `sessionManager()`，不等於 `SESSION_MANAGER_ADDRESS` → 503 |
| `KYA_RPC_URL` | signal-api 的 provider | 讀 session／錨定的 RPC |
| `DELEGATION_VC_CHAIN_IDS` | `AGENT_CHAIN_ID,84532` | 接受的 DID 鏈 |
| `X402_KYA_MAX_SKEW_SEC` | 120 | presentation 時間容忍（上限 600） |
| `X402_KYA_SPEND_STORE` | Upstash | `memory` 只給單機開發 |
| `KYA_FAIL_MAX`／`KYA_FAIL_WINDOW_MS` | 20／60000 | 每個 IP 在視窗內「進行中＋失敗」的 KYA 驗證上限（進入時先計、通過或 503 時退回，所以並行請求也擋得住）；超過 → 429 `kya_rate_limited`（不再做驗證）。必須是正整數，否則用預設並印 `::error::`。每個實例各自計數（best-effort），IP 取自 `x-forwarded-for` 第一段，依賴平台覆寫該 header |

**Presentation**（header `X-Agent-Presentation`，base64url JSON）：W3C `VerifiablePresentation`，`holder`＝代理人
DID，內含一張 v3 憑證；`proof` 用 `EthereumEip712Signature2021`、`proofPurpose: authentication`，
`challenge`＝這次 x402 付款的 EIP-3009 nonce、`domain`＝`METHOD /path`、另簽入 `payer` 與 `credentialHash`
（EIP-712 型別 `AgentX402Presentation`，domain `PepeLabAgentPresentation` v1）。

**流程**（任何一步不過都在付款送進 facilitator 之前回應，買方不被扣款）：

1. 有付款 header 才檢查；未付款的 402 加上 `X-Agent-KYA: required; header=X-Agent-Presentation; …`。
2. 缺 presentation → 403 `kya_presentation_required`。
3. presentation：holder 簽章、±120 秒、綁定本請求（方法＋正規化路徑）與本付款（nonce＋payer）→ 403 `kya_presentation_invalid`。
4. **身分一致**：presentation 簽者 ＝ 憑證主體（代理人 DID）＝ x402 付款人（`authorization.from`）。
5. 憑證簽章／期限／綁定的 session manager → 403 `kya_credential_invalid`；憑證的 chainId 必須等於讀取端 RPC 實際連的鏈
   （`VC_WRONG_CHAIN`；讀取端的鏈本身不在 `DELEGATION_VC_CHAIN_IDS` 裡是伺服器設定錯 → 503 `kya_misconfigured`）；期間、剩餘效期或總額超出花費帳能正確表示的範圍 → 403（`KYA_ALLOWANCE_OUT_OF_RANGE`，請簽較短效期）；
   端點不在 `x402.endpoints` → 403 `kya_endpoint_not_allowed`。
6. 撤銷（ADR-016 狀態清單，fail-closed）：被撤銷 → 403 `kya_credential_revoked`；拿不到狀態 → 503 `kya_status_unverified`
   （回應只帶原因代碼，完整訊息只寫伺服器 log）。
7. 鏈上 session 逐欄比對 → 403 `kya_session_mismatch`（含 `SESSION_REVOKED`）；RPC 失敗 → 503。
8. 錨定 → 403 `kya_not_anchored`（錨定合約綁的 manager 與設定不符 → 503 `kya_misconfigured`）。
9. 防重放：同一 `(payer, payment nonce)` 只接受一次 presentation → 409 `kya_presentation_replayed`。
10. **花費**：以 credentialHash 為鍵，Upstash `EVAL` 一支腳本原子地檢查並遞增「本期」與「總額」
    （與 #253 記帳同一個 Upstash、同樣的腳本風格）；超過 → 403 `kya_spend_limit_exceeded`，回應說明已花／本筆／上限。
11. 付費牆跑完：結算成功 → 保留並回 `X-Agent-KYA-Spend: total=…;period=…;maxTotal=…;maxPerPeriod=…;hash=…`；
    結算失敗（402、handler 錯誤、facilitator 拒絕、**結算之前**的 facilitator 失敗——v1 的 `facilitator_unavailable`／
    `facilitator_rate_limited`、v2 的 verify／supported 階段）→ 退回預留；結算結果不明（v2 settle 階段的 429／502、
    `settlement_pending`）→ 保留（寧可多算）。付費牆丟出例外時：授權還沒送去 settle → 退回，送過了 → 保留。

免費查詢：`GET /kya/spend/:credentialHash?period=<秒>`（前端進度條用；KYA 關閉時 404）。

**付款端**：`kyaFetch`（`@pepelab/shared`／SDK）放在 x402 付款 client 底下當 base fetch，帶付款 header 的重送
自動附上 presentation——**只送給 `allowedOrigins`（必填）列出的服務**：presentation 帶整張憑證（使用者地址、session
條款與額度），付款給其他 x402 服務時照常付款、不附憑證。簽章守門（`signingGuard.ts`）新增白名單 (d)：只放行逐欄合規、holder 與 payer 都是自己、
時間在 ±60 秒內的 `AgentX402Presentation`；它沒有金額語意，不佔 x402 累計額度。

## 5. 代理人、SDK、前端

- `write.ts`：`openPositionForSession`／`closePositionForSession` 接受 v2 或 v3（`AgentCredential`）；v3 另做資產白名單與
  原始單位額度的預檢。demo-agent、MCP server（`authVcJson`）、`vc-status jti` 都接受 v3；demo-agent 在 v3 時自動附 presentation。
- SDK（`agent/sdk/src/delegation.ts`）：`createDelegationCredential`（回 viem typed data、`credentialHash`、`finalize(sig)`）、
  `issueDelegationCredential`、`presentForX402`、`kyaFetch`、`verifyDelegationCredential`。
- 前端 `/sessions`：建立 session 後自動開啟「委託憑證 v3」視窗——設定 x402 上限 → 錢包簽發 → 錨定（一筆交易）；
  顯示代理人／簽發者 DID、session 額度、credentialHash、狀態（有效／已撤銷／過期／session 已撤銷、錨定或已被取代）、
  x402 花費進度（讀 `/kya/spend`）、憑證 JSON 與下載、解除錨定。撤銷（或撤銷 session 時一併撤銷）：先從
  `VITE_VC_STATUS_URL/<issuer>.json` 讀**目前已發佈**的清單並驗簽，接在它之後簽新的 ADR-016 清單（累積、sequence 遞增）；
  讀不到就不簽，請使用者匯入目前的清單（只靠瀏覽器記憶簽出的清單可能比已發佈的舊，驗證端會拒收，撤銷不會生效）；
  從來沒有發佈過清單的簽發者，由使用者明確確認「目前沒有已發佈的清單」後以 sequence 1 簽署。要讓前端讀得到，
  必須設定 `VITE_VC_STATUS_URL`，而且狀態主機要開 CORS 給前端網域。
  設了 `VITE_VC_STATUS_PUBLISH_URL` 就 POST（這個外部 publisher 不在本 repo，**必須套用與 `npm run vc-status install` 相同的拒絕規則**：驗簽、sequence 嚴格遞增、不得少掉既有的撤銷項；否則一份較舊或少了撤銷的清單會蓋掉已發佈的那份）；讀回沒確認到（或沒設）時一律下載一份交給營運方 `npm run vc-status install`；**只有讀回確認新清單已發佈**
  才顯示「已撤銷」，之前顯示「撤銷待發佈（尚未生效）」並提供「確認已發佈」。要立即擋下付費 API 用「解除錨定」（一筆交易）。
  錨定合約位址：`frontend/src/contracts/sessionCredentialAnchor.ts`；`VITE_SESSION_ANCHOR_ADDRESS` 只覆寫
  `VITE_SESSION_ANCHOR_CHAIN_ID`（預設 31337）那條鏈。送 `anchor`／`unanchor` 之前檢查位址有 code、綁的 manager 與憑證相同。

## 6. 與 v2 的相容

- v1／v2 的 schema、簽章、驗證、`AUTH_*` 匯出全部不變；v2 照舊可驗、照舊可下單（不需要錨定）。
- 只有 x402 KYA 要求 v3（KYA 預設關閉）。
- 狀態清單與 nonce 狀態檔格式不變；同一個簽發者的 v2 與 v3 共用同一份清單，v3 重簽會取代同 session 較舊的 v2／v3。

## 7. 標準對照

| 本實作 | 標準 | 來源 |
|---|---|---|
| 憑證結構（`@context` v2、`validFrom`／`validUntil`、`credentialStatus`、VerifiablePresentation／`holder`） | W3C Verifiable Credentials Data Model v2.0 | https://www.w3.org/TR/vc-data-model-2.0/ |
| presentation 的 `challenge`／`domain`、`proofPurpose: authentication` | W3C VC Data Integrity 1.0 | https://www.w3.org/TR/vc-data-integrity/ |
| 撤銷清單（以 jti 為鍵的變形，非 bitstring） | W3C Bitstring Status List v1.0（概念）＋ ADR-016 | https://www.w3.org/TR/vc-bitstring-status-list/ |
| DID | did:pkh（W3C CCG） | https://github.com/w3c-ccg/did-pkh/blob/main/did-pkh-method-draft.md |
| 簽章 | EIP-712 typed structured data | https://eips.ethereum.org/EIPS/eip-712 |
| proof type `EthereumEip712Signature2021`（`eip712` 屬性帶 domain／types／primaryType） | W3C CCG Ethereum EIP712 Signature 2021 草案 | https://w3c-ccg.github.io/ethereum-eip712-signature-2021-spec/ |
| x402 付款授權（`from`／`nonce`） | EIP-3009 transferWithAuthorization | https://eips.ethereum.org/EIPS/eip-3009 |
| x402 v1（`X-PAYMENT`）／v2（`PAYMENT-SIGNATURE`） | x402 protocol | https://github.com/coinbase/x402 ；本 repo ADR-010 |

偏離與理由：簽章對象是 JSON 的扁平 EIP-712 投影而非 JSON-LD 正規化（錢包可直接顯示、驗證端不需 JSON-LD 處理器，與 v1/v2 一致）；
狀態清單以 jti 為鍵而非位元索引（沿用 ADR-016，不新增金鑰類型）。

## 8. 限制

- 花費累計以 signal-api 收到並結算的請求為準；同一張憑證拿去其他賣方，其他賣方必須自己記帳（或共用帳本）。
  鏈上沒有 x402 花費的強制點——代理人端的簽章守門（`X402_MAX_TOTAL_SPEND_USDC`）是另一道獨立上限。
- 每期間上限是滑動窗（2026-10-07 起；之前用固定視窗 `floor(now/period)`，跨視窗邊界最多可花到 2 倍）：期間切成 10 格，
  預留時加總目前這格與前 10 格（`agent/signal-api/src/kya.ts` 的 `kyaWindowKeys`），任何長度為 `periodSeconds` 的時間窗內
  都不會超過 `maxPerPeriod`。代價是保守：一筆花費最多會多算一格（期間的 1/10）才釋出。改版當下舊格式的 key 不會被讀到，
  已在進行中的期間花費會被重新起算一次。
- 撤銷生效延遲：狀態清單受 `VC_STATUS_CACHE_MAX_AGE_SEC`（≤ 900 秒）影響；要立即生效用鏈上 `revokeSession`（KYA 與寫入路徑都即時讀鏈）。
- 狀態清單 domain 綁 84532（沿用 ADR-016）：在 anvil 上 MetaMask 會拒簽清單（鏈不符），本機 PoC 用腳本錢包簽。
- `X402_KYA_SPEND_STORE=memory` 只在單一 process 有效；Vercel 多實例必須用 Upstash。撤銷的 sticky 狀態與「清單被扣住」
  的偵測同樣是每個實例各自記（預設檔案儲存）；多實例部署要讓所有實例共用同一份 VC 狀態儲存，否則某個實例可能還沒看過
  較新的清單。
- **KYA 不證明委託人是誰**：任何錢包都能建 session、把自己設成代理人、自簽並錨定一張憑證（委託人＝代理人）。KYA 保證的
  是「付款的代理人受某把錢包簽下的上限約束、而且那把錢包是鏈上 session 的使用者」；要求委託人是經過 KYC 的人，需要另外
  串接合格投資人 VC（`docs/SSI_RWA_ACCESS.md`），目前沒有。
- presentation 綁定方法＋路徑＋付款（nonce、payer），沒有綁定賣方（`payTo`／origin）。轉送到別的賣方時付款收款人不同，
  facilitator 會拒絕、KYA 退回預留，沒有資金風險；付款端用 `kyaFetch` 的 `allowedOrigins` 限制憑證送給誰。
- x402 v1（x402-hono 0.5.3）把 settle 階段的錯誤一律改成 402，與「facilitator 拒絕」分不開，KYA 只能當成未扣款而退回；
  若那筆結算其實上鏈，花費帳會少算一筆。需要精確累計時用 `X402_PROTOCOL=v2`（settle 階段失敗有 `phase`，結果不明會保留）。
- 花費帳只接受期間 ≤ 200 天、剩餘效期 ≤ 約 399 天、總額 ≤ 2^53−1 atomic USDC 的憑證（key TTL 與 Lua 數字精度）。
- 錨定合約尚未部署到 Base Sepolia（擁有者動作）；部署前前端只能簽發、不能錨定。
- `x402_agent.ts` 與 `examples/vc-gate.ts` 仍只載入 v2；要讓它們走 KYA，改用 `kyaFetch` 包付款 fetch 即可。

## 9. 錄製步驟（本機 PoC）

```bash
bash scripts/poc/agent-delegation-demo.sh
```

腳本自己啟動 anvil（port 8645，結束時關閉）、以既有 `Deploy.s.sol`（`--unlocked`，anvil 帳號 #0，不需要私鑰）部署整套合約、
部署 `SessionCredentialAnchor`，然後執行 `agent/examples/agent-delegation-poc.ts`，每一步印出中文口白：

1. 使用者存入保證金（MockUSDC）
2. 使用者在鏈上建立受限 session（單筆 100、總預算 300、5 倍、24 小時、sBTC／sETH）
3. 使用者以錢包簽發 v3 委託憑證（x402：每小時 0.02、總額 0.03 USDC）
4. 代理人嘗試錨定被拒 → 使用者錨定成功
5. 啟動本機 signal-api（KYA on、錨定必要）
6. 沒出示憑證的付費呼叫 → 403，付款未送出
7. 出示 VP 呼叫兩次 → 200，花費累計 0.02
8. 第三次 → 403 `kya_spend_limit_exceeded`，沒有結算
9. 代理人在額度內下單成功；150 USDC 被憑證閘門拒絕；繞過閘門直接上鏈也被合約拒絕（前端 `addresses.ts` 的 anvil 位址與本次部署相同時走 `openPositionForSession` 寫入路徑；不同時改用同一組 shared 驗證函式＋直接送交易，腳本會印出用的是哪一種）
10. 使用者 `revokeSession` ＋ 簽狀態清單撤銷 jti → `isAnchored` 變 false
11. 撤銷後 VP 被拒、下單被拒

2026-10-06 本機實測：13/13 項符合預期（session #0、錨定、2 次付費 200、第 3 次 403 `kya_spend_limit_exceeded`、
額度內開倉成功、超額被拒、撤銷後 VP 403 `kya_credential_revoked`、下單 `VC_REVOKED`）。

**哪一段是模擬**：x402 facilitator（本機假 facilitator，會驗 EIP-3009 簽章但不上鏈結算、沒有任何錢移動）、
Upstash（本機假 Upstash，Lua 語意相同）、`/signals` 的訊號內容（固定資料）。其餘——合約、session、錨定、下單、撤銷、
憑證與 presentation 的簽驗、KYA 閘門與花費累計——都是真實程式碼與本機鏈交易。不使用公開鏈、公開 facilitator 或真錢。

## 10. 測試

| 檔案 | 內容 |
|---|---|
| `contracts/test/SessionCredentialAnchor.t.sol` | 只有 user 能錨定／取消、session 撤銷與到期後 `isAnchored` 為 false 但紀錄保留、多次錨定取代、fuzz 非 user |
| `agent/examples/delegation-v3.test.ts` | 結構、驗簽、竄改、鏈／期限、逐欄比對、v2 投影（jti、取代）、v2 不受影響、端點比對、presentation 綁定、身分一致、簽章守門 (d)、kyaFetch |
| `agent/signal-api/src/kya.test.ts` | KYA 關閉不變；開啟後 v1／v2、缺 VP、重放、超額、錨定、取代、付款人不符、端點範圍、session／憑證撤銷、結算失敗退回、官方 client＋kyaFetch、花費查詢 |
| `agent/sdk/test/delegation.test.ts` | viem 簽 ↔ ethers 驗、presentation、kyaFetch |
| `frontend/src/lib/pepefi/delegationCredential.test.ts` | 簽發欄位、雜湊、表單錯誤碼、累積撤銷清單、花費讀取、端點比對、header 編碼、錨定位址解析 |
