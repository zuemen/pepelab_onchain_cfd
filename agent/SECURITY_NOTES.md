# Agent / x402 / VC-SSI 安全與設計備註

本檔記錄 agent 授權層（VC/SSI）、x402 付費分潤與金鑰運維的設計取捨，供報告與維運參考。
code review 結論為「無可被利用的嚴重漏洞」（最終把關在合約），以下為一致性與運維強化說明。

## 1. VC 是「常設授權」、無 nonce／不可單獨作廢

使用者簽發的授權 VC（W3C VC，EIP-712 簽章）是「可驗證的常設授權」，本身沒有 nonce、
無法被單獨「撤銷」。要停止某個 agent 的權限，請呼叫鏈上：

```
AgentSessionManager.revokeSession(sessionId)
```

撤銷後，即使 agent 仍持有原 VC，下單時的鏈上 session 交叉比對（`s.revoked`）會擋下。
此外 VC 也受 `caps.expiry` 約束，過期即驗證失敗。換言之，**鏈上 session 才是權限開關**，
VC 只是該授權的可離線驗證表示。

## 2. 金鑰輪換（務必在正式環境前完成）

先前 `.env.example` 曾示範過一把同時用作 owner / keeper / 結算 / agent 的私鑰，
**正式上線前務必輪換**。原則：

- `FEE_SETTLEMENT_PRIVATE_KEY`、`VERIFIER_PRIVATE_KEY`、keeper 私鑰、`AGENT_PRIVATE_KEY`
  只放部署環境變數，**絕不 commit**。
- `VERIFIER_PRIVATE_KEY` 未設時 signal-api 會回退到臨時隨機 verifier（並 `console.warn`），
  正式環境務必固定設定，否則每次重啟 ERC-8126 verifier DID 會變、attestation 身分不穩。
- agent session key 僅放本機 agent 設定 + 少量 ETH 付 gas，勿放主錢包資產。

## 3. x402 分潤為鏈上帳務表示（非逐筆原子轉發）

70/20/10 分潤是**鏈上帳務表示**：x402 付款由 facilitator 結算到 `payTo`，
signal-api 另以結算錢包餘額透過 `FeeRouter` 補上對應金額的分潤紀錄（見
`signal-api/src/settlement.ts` 上方註解）。分潤金額對得上、BaseScan 可查累計，
但**非與該筆 x402 付款原子綁定**（demo 帳務）。正式可改為直接從 `payTo` 收款後原子路由。

## 4. 最終把關在合約

session 的單筆保證金 / 總預算 / 槓桿 / 到期 / 撤銷皆由 `AgentSessionManager` +
`PerpetualExchange` **鏈上強制**。VC/SSI 是「可驗證授權」層（離線可驗、下單前預檢省 gas），
兩者皆通過才下單。即使繞過 VC 層，合約端仍會 revert 超限交易。

## 5. 獨立 bot 的驗證邏輯需與本 repo 同步

本機 `~/pepe-bot` 的獨立 `bot-vc.ts` / `auto-agent.ts` 自行複製了一份 VC 驗簽邏輯
（不在本 repo 內，無法由本 repo 直接維護）。**注意**：

- 若本 repo 的 EIP-712 schema（`frontend/src/contracts/agentAuth.ts`）變更，
  獨立版必須同步，否則既有 VC 會驗證失敗。
- repo 內 `agent/examples/*` 的 VC 驗證應一律 import 自 `@pepelab/shared` 的
  `verifyAuthorizationVC`（單一來源），不要各自複製驗簽邏輯。
