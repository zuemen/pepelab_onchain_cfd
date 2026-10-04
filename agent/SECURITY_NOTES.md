# Agent / x402 / VC-SSI 安全與設計備註

本檔記錄 agent 授權層（VC/SSI）、x402 付費分潤與金鑰運維的設計取捨，供報告與維運參考。

> ## ⚠️ 這份文件的結論已被推翻（2026-08-06）
>
> 本節先前寫「code review 結論為『無可被利用的嚴重漏洞』（最終把關在合約）」。
> **那個結論不再成立。** 2026-08-06 的全面稽核在 agent 層找到多個可被利用的問題，
> 包含兩個 Critical：
>
> - **A-1** `examples/x402-autonomous.ts` 的 `decide()` 把 API 錯誤回應當成「做空
>   訊號」→ 送出**真實下單**（503 / 402 的 body 都會得到 `{"action":"short"}`）
> - **A-2** Telegram bot 在 `TELEGRAM_ALLOWED_CHAT` 未設時**對全世界開放下單**
> - **A-3 / A-4** 開倉的 VC 閘門是可選的且三個呼叫端都沒帶；平倉端**完全沒有授權層**
> - **A-5** keeper 寫 MockOracle **沒有偏離上限**
>
> 「最終把關在合約」這個論述本身也需要修正 —— 合約層同時被查出多個 Critical
> （mark price 同區塊套利、壞帳無處理、authorizedAgents 可平任何人的倉）。
>
> **完整清單與處置順序：[`../docs/audit/AUDIT_2026-08-06.md`](../docs/audit/AUDIT_2026-08-06.md)。**
> 在該報告的第 1–3 項（金鑰輪替、keeper 修復合併、重部署 exchange）完成前，
> 請不要引用本文件作為安全性佐證。

以下為原有的一致性與運維強化說明（設計取捨部分仍然有效）。

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
  `verifyAuthorizationVC`（單一來源），不要各自複製驗簽邏輯。已核：`agent/examples/*`
  皆 import 自 shared，無自寫 EIP-712 驗簽。

## 6. session 預算為「累計」而非「淨未平倉」

`AgentSessionManager.spentMargin` 目前**只增不減**：每次開倉 `+margin`，平倉／清算
**不退還**額度。因此 `totalMarginBudget` 是該 session 的**終生累計保證金上限**，不是
「同時在倉的淨上限」。含意：一個 budget=1000 的 session，開→平→開… 累計用滿 1000 後
即不能再開，即使當下淨未平倉為 0。

- 這是**保守**設計（額度不會被反覆開平「回收」放大曝險），對安全有利。
- 若要改為「平倉後退還額度」（記淨未平倉保證金：開倉 +margin、平倉/清算 −margin），
  需改 `AgentSessionManager` 並補 `forge test`（含開平往返守恆）後**重部署** session
  manager。非必要；目前以本文件明示語意即可。

## 7. 合約償付 / 預言機 / 資金費 現況（對應 docs/RISK_NOTES.md）

- **ADL 已於 live 開啟**（owner tx `setAdlEnabled(true)`）：償付三層（輸家保證金 →
  InsuranceVault → ADL haircut）全部生效。組合保證金已自合約移除（2026-09-30，只有逐倉）、
  `markPremiumCapBps=0`（mark==index）。
- **資金費守恆**：正式版（新部署）已改 per-side 雙索引、多空間等額轉移；live demo
  交易所仍舊版單索引。詳見 RISK_NOTES。
- **去中心化預言機**：`DeployWithPyth`(Aggregator: Pyth+Chainlink) 已 dry-run 通過、
  等手動 broadcast；live 仍 MockOracle（合成資產 demo）。RWA 正式定價走 Pyth。

## 8. 依賴弱點：x402 0.5.3 帶進來的錢包樹（2026-10-02，Dependabot #2／#3／#4／#103）

**結論：線上 signal-api 不受影響；mcp-server、keeper、tg-bot、SDK 執行期也碰不到。**
`agent/package.json` 的 `overrides` 只是把 lockfile 裡的副本換成修補版，避免日後有人
真的載入這棵樹。

- **來源只有一條**：`signal-api → x402@0.5.3 → wagmi@2.19.5 → @wagmi/connectors@6.2.0`，
  底下再分到 `@walletconnect/*`、`@reown/appkit*`、`@metamask/*`。弱點副本：
  ws 8.18.0（viem@2.23.2，在 `@walletconnect/utils` 底下）、uuid 8.3.2／9.0.1
  （`@metamask/sdk*`、`@metamask/utils`）、`query-string@7.1.3 → decode-uri-component@0.2.2`
  （`@walletconnect/utils` 2.21.x）。
- **為什麼碰不到**：x402 只在發版時用 wagmi 預先打包 paywall 頁面，存成字串
  （`PAYWALL_TEMPLATE`）。它的 dist 沒有任何 `import "wagmi"`。逐一載入 `x402/*` 各子路徑、
  `x402-hono`、`x402-fetch`、MCP SDK、node-telegram-bot-api、`@x402/*` 並記錄實際載入的
  檔案，弱點相關套件只出現根目錄的 ws 8.21.0（已修補，ethers／viem 使用）。esbuild
  metafile 也證實 Vercel bundle 只內聯 `node_modules/ws`（8.21.0），沒有 wagmi、
  walletconnect、metamask、uuid、query-string。bundle 裡的 `WalletConnect` 字樣是
  viem 的錯誤類別名稱，以及 paywall 字串裡的 OnchainKit 程式碼。
- **唯一的殘留**：x402-hono 0.5.3 對「沒帶 X-PAYMENT 的瀏覽器請求」會回 paywall HTML，
  裡面那份預先打包的 MetaMask SDK 含 uuid 8.x 程式碼，在**買方瀏覽器**執行，不在伺服器。
  它用的是 `v4()`／`validate()`，不是有弱點的「v3／v5／v6 帶 buf 參數」路徑。這份字串是
  上游發版時產生的，overrides 改不到，只能等升 x402 或改走 v2。
- **overrides 與相容性**：
  - `ws@^8 → ^8.21.0`：只抓 8.x 副本，viem 2.23.2 原本鎖 8.18.0，同主版本。
    `@walletconnect/jsonrpc-ws-connection` 的 ws 7.5.11 本身就是 7.x 的修補版
    （#4 的 7.x 修補線；#2 只影響 8.x），所以不動，也不需要 7→8 的 API 遷移。
  - `uuid → ^11.1.1`：@metamask/* 只用具名匯出 `v4`、`validate`，11.x 兩者都有，並且
    同時提供 CJS（`require`）與 ESM。12 版以後是 ESM-only，所以停在 11。
  - `@walletconnect/utils > query-string → ^9.5.1`：@walletconnect/utils 2.21.x 宣告了
    query-string，但 dist 從未 import（2.25 已移除這個依賴）。decode-uri-component 0.5.0
    是 ESM-only，query-string 7 用 `require()` 呼叫它會壞，所以要換成依賴 0.5.0 的
    query-string 9，而不是只覆寫 decode-uri-component。
- **npm 的坑**：npm 10／11／12 在「已有 lockfile + workspaces」下都不會把新加的 overrides
  套到 workspace 的依賴上（scratch 最小重現已確認）。這次的 lockfile 是比照全新解析的
  結果，只調整弱點相關的條目。用 npm 11 跑 `npm ls` 會誤報 `invalid`，npm 12 的
  `npm ls` 則正確。之後若要調整這幾個 overrides，同樣要手動對照全新解析的結果。

## 9. dotenv 16 → 18 與 x402／x402-hono 留在 0.5.x（2026-10-04，Dependabot #234／#235／#236）

**dotenv 18 升級，但 `loadEnv()` 的每個選項都寫死。** 唯一的載入點是
`shared/src/env.ts` 的 `loadEnv()`（`x402_agent.ts` 也改成呼叫它）；keeper 不載入 dotenv。

- dotenv 17 起 `config()` 預設 `quiet: false`，18 起在 stderr 印
  `◇ injected env (N) from <path>`。只印數量與路徑，不印值，但 CI、Vercel 的 log 會多出
  .env 相關的輸出。
- dotenv 17.2 起 `config()` 會從 process.env 以及剛讀進來的 .env 讀
  `DOTENV_{QUIET,DEBUG,OVERRIDE,FAST,ENCODING,PATH}`（以及 `DOTENV_CONFIG_*`）當預設值。
  16.6.1 只有 `dotenv/config` 會讀這些變數。不寫死的話，環境裡出現 `DOTENV_OVERRIDE=true`，
  .env 就會蓋過平台注入的 secret；出現 `DOTENV_DEBUG=true`，每個 key 名都會印到 stdout。
- `dotenvLoadOptions()` 明確給 `quiet: true, override: false, debug: false, fast: false,
  encoding: "utf8"`，程式碼給的選項優先於上述環境變數。18 的預設 parser 與 16.6.1 用同一條
  regex，`populate` 的覆寫規則也一樣。`examples/env-load.test.ts` 會把所有 `DOTENV_*` 開關
  打開（包括寫在 .env 檔裡的），驗證載入時不輸出任何東西、不覆寫既有變數、parser 結果不變。
- 18 移除了 `.env.vault`／`DOTENV_KEY`，也移除了 `-r dotenv/config` 預載。本 repo 兩者都沒用到。

**x402 與 x402-hono 維持 0.5.3，dependabot 的 major 與 minor 都 ignore**（理由寫在
`.github/dependabot.yml`）：

- x402-hono 0.8.0（#234 的 group 裡）已帶有 1.x 的行為改動。實測結果：
  `x402DefaultGolden` 紅（paywall HTML 長度從 2821006 變成 3548823），
  `facilitatorErrors` 紅（facilitator 503 從 502 變成 402）。另外它依賴 x402 ^0.8，
  typecheck 也紅。
- 單升 x402 1.2.0（#235）時 golden 與 facilitator 測試仍綠，原因是付費牆用的是
  x402-hono 底下的 0.5.3。代價是 npm 會裝兩份 x402：app.ts 的 `findMatchingRoute` 改用
  1.2.0，與付費牆不再同源。實測 `/signals/%zz` 這個路徑，0.5.3 判為「不匹配」，
  1.2.0 判為「匹配」。目前 app.ts 會在更前面的 `normalizeRequestPath` 先回 400，所以碰不到，
  但「與付費牆完全一致」的前提已經不成立。此外 bundle 會多出 40 個 @solana 套件。
