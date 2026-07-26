# 自主 agent：VC/SSI 強制驗證 + 不可否認稽核（Part E）

讓 agent 的每一筆自主交易都「可追溯、可承認、不可否認」：每筆交易綁在一張**使用者簽發的 VC** 之下，並留下可獨立驗證的稽核紀錄。

- **SSI 角色**：issuer = 使用者（`0xE80A`，MetaMask/EIP-712 簽 VC）｜ holder = agent（持 VC）｜ verifier = 下單前 `verifyAuthorizationVC` + 鏈上交叉比對。
- **不可否認鏈**：`VC（誰授權）` + `x402 settlement tx（付費做了什麼功課）` + `開倉 tx（行動）`，以 `sessionId` / `agentDid` 串接。
- agent **不自己建立 VC**（那會破壞 SSI）；VC 一定由使用者本人簽發，agent 只持有並出示。

## 前置（使用者做一次）— 為 session #6 簽發 VC
1. 網站 Sessions 頁 → 連 `0xE80A` → 對 **session #6** 按「Issue Credential / 簽發 VC」→ MetaMask 簽。
2. 匯出 → 存成 `agent/examples/vc.json`（或 `AGENT_AUTH_VC_PATH` 指向處；此檔含簽章、已 gitignore）。
3. VC 須：`issuer = did:pkh:…:0xE80A`、`credentialSubject.id = agent did`、`sessionId = 6`、限額/到期與鏈上 session #6 一致。

> session #0 已過期 → 一律用 **#6**（`.env` 設 `DEMO_SESSION_ID=6`）。

## E1 — 下單一律走 VC（不可繞過）
`x402-autonomous.ts` / `x402-loop.ts` 下單一律 `openPositionForSession({ …, authVc })`（走 `verifyAuthorizationVC` + 鏈上交叉比對）。
- 缺 VC / 解析失敗 → 可研究、**拒絕下單**。
- 每次下單前本地驗 VC：驗章 / `sessionId=6` / holder==本 agent；不符即拒絕並記錄理由（授權無效＝一種「不交易」的自主決策）。

## E2 — 不可否認稽核軌跡
每輪（下單或 skip）附一行 JSONL 到 `agent/audit/trades.jsonl`（gitignore）：
`ts / issuerDid / agentDid / sessionId / vc{id,expiry,verified} / research{resource,priceUsdc,settlementTx} / decision{edgeScore,side,reason} / action{opened,positionId,txHash}`（+ E3 `agentVerification`）。

驗一筆是否「可被承認」：
```bash
cd agent
# 需 AGENT_AUTH_VC_PATH 指向該筆所用的 VC
AGENT_AUTH_VC_PATH=examples/vc.json npx tsx examples/audit-verify.ts [行號]
```
它會：重新 `verifyAuthorizationVC`（誰授權）→ 比對 VC 摘要與紀錄相符 → 鏈上核對 `positionId` 的 owner == `session.user`（= VC issuer）。全過 → ✅ 可被承認；任一不符 → ❌。

## E3 —（加分）ERC-8126 可信度
稽核紀錄可選附 `agentVerification`（呼叫免費 `GET /agent/:did/verification` 拿 overallRiskScore + 風險等級），讓「這個 agent 可不可信」也留痕、可被承認。

## 自測（免鏈免資金）
```bash
npx tsx examples/audit-trail.test.ts   # VC 有效→✅、竄改/換holder/錯session→❌、JSONL roundtrip
```
