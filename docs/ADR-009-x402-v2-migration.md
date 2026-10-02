---
status: accepted（程式已合入分支；正式站仍是 v1，切換由使用者決定）
date: 2026-10-02
plan-item: P2-04
---

# x402 v2 遷移：同一個付費牆、以 `X402_PROTOCOL` 切換，預設 v1 逐位元不變

signal-api 的付費端點（`/signals/:trader`、`/oracle/:asset`）目前用 x402 **v1**（`x402-hono` 0.5.3、`X-PAYMENT`／`X-PAYMENT-RESPONSE`、付款要求在 402 本文）。上游已把主線移到 **v2**（`@x402/*` 2.x、`PAYMENT-REQUIRED`／`PAYMENT-SIGNATURE`／`PAYMENT-RESPONSE`、CAIP-2 網路名稱）。這份 ADR 記錄查證到的事實、這次的設計、使用者切換步驟，以及將來移除 v1 的條件。

## 1. 查證事實（2026-10-01／10-02）

| 事實 | 值 | 來源 |
|---|---|---|
| v2 套件最新版 | `@x402/core`、`@x402/evm`、`@x402/fetch`、`@x402/hono`、`@x402/extensions` 皆 **2.28.0**（npm 發佈 2026-09-29） | `npm view @x402/<pkg> version time.modified`；https://www.npmjs.com/package/@x402/core |
| v1 套件最新版 | `x402`、`x402-hono`、`x402-fetch` 最新 **1.2.0**（2026-04-16）；本 repo 鎖在 `x402` 0.5.3、`x402-hono` 0.5.3、`x402-fetch` 0.5.1（本次不動） | `npm view x402 version`；`agent/package-lock.json` |
| 上游 repo | 已搬到 **x402-foundation/x402**（`@x402/*` 的 `repository` 欄位與 v1 套件的 `repository.url` 皆指向這裡）；本文引用的規格取自 `main` @ `6b6ee91fee027b540faabcb25774e73851006c3b` | https://github.com/x402-foundation/x402 |
| v2 核心規格 | `PaymentRequirements` 欄位改為 `amount`（原 `maxAmountRequired`）、`network` 用 CAIP-2（`eip155:84532`）、`maxTimeoutSeconds` 為必填 | https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md |
| v2 HTTP transport | 402 的付款要求在 **`PAYMENT-REQUIRED`** header（base64 JSON，本文範例為 `{}`）；付款用 **`PAYMENT-SIGNATURE`**；結算結果在 **`PAYMENT-RESPONSE`** | https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md |
| v2 MCP transport | 需付款時工具結果 `isError: true` ＋ `structuredContent` 放 `PaymentRequired`；client 以 `_meta["x402/payment"]` 重呼叫；結算資訊在 `_meta["x402/payment-response"]` | https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md |
| payment-identifier 擴充 | client 自選 id 作為冪等鍵，16–128 字元、`[a-zA-Z0-9_-]`；resource server 與 facilitator 都可用來去重 | https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md |
| 公開 facilitator 支援 | `GET https://x402.org/facilitator/supported`（免費、不需付款）實測含 `[2, exact, eip155:84532]`、`[2, upto, …]`、`[2, batch-settlement, …]`、`[1, exact, base-sepolia]`；extensions 為 `builder-code`、`eip2612GasSponsoring`、`erc20ApprovalGasSponsoring`（不含 payment-identifier → 冪等只在我們這端做） | 2026-10-02 實測 |
| CDP facilitator | 「authenticates with your CDP API key ID and secret」→ 需要 API key（本次不用） | https://docs.cdp.coinbase.com/x402/seller/facilitator |
| v2 伺服器 SDK 不收 `X-PAYMENT` | `@x402/core` 的 `x402HTTPResourceServer` 只讀 `PAYMENT-SIGNATURE` → 要同時收 v1、v2 必須自己分流 | 讀 `@x402/core@2.28.0` tarball 原始碼 |
| v2 exact client 簽的東西 | 預設仍是 EIP-3009 `TransferWithAuthorization`（domain＝asset／`extra.name`／`extra.version`，chainId 取自 CAIP-2）；差別只有 `validAfter = 0`（v1 是 now−600）。`extra.assetTransferMethod = "permit2"` 時改簽 `PermitWitnessTransferFrom` | 讀 `@x402/evm@2.28.0` tarball 原始碼 |

**結論：與假設相符**（v2 套件存在且穩定、公開 facilitator 已支援 Base Sepolia 的 v2 exact、EIP-3009 typed data 不變），可以在不改變正式站行為的前提下加上 v2。

## 2. 決定

### 2.1 伺服器：一個付費牆、三種模式

`agent/signal-api/src/app.ts` 以環境變數 **`X402_PROTOCOL=v1|v2|both`** 分流，**預設 v1**：

| 模式 | 收什麼 | 未付款的 402 | 用途 |
|---|---|---|---|
| `v1`（未設也是） | `X-PAYMENT`；`PAYMENT-SIGNATURE` 被忽略 | 與 master **逐位元相同**（golden 釘住） | 現況 |
| `both` | 依 header 分流；兩個都帶 → 400 `ambiguous_payment_headers`（不送 facilitator） | v1 本文不變，另加 `PAYMENT-REQUIRED` 與 `Cache-Control: no-store`；v2 的 `/supported` 失敗時本次只宣告 v1 | 過渡期 |
| `v2` | 只收 `PAYMENT-SIGNATURE`；`X-PAYMENT` 視同未付款 | 本文 `{}`，付款要求在 `PAYMENT-REQUIRED` | 切換完成後 |

無法辨識的值一律當 v1（stderr 一行錯誤）。`GET /` 只有在 v2／both 才多出 `x402` 區塊（protocol、versions、network、headers）。

**不用 `@x402/hono` 的 `paymentMiddleware`，自寫薄 adapter（`signal-api/src/x402v2.ts`）只依賴 `@x402/core` ＋ `@x402/evm`**，理由：

1. `@x402/hono` 依賴 `@x402/extensions`（ajv、siwe、jose、tweetnacl…），全部會被 esbuild 內聯進 commit 進 repo 的 Vercel bundle。
2. 它的 adapter 實作 `getBody()` → `c.req.json()`；Vercel Node runtime 上讀 request body 會永遠 hang（serverless 坑 1）。我們的 adapter 刻意不實作 `getBody`。
3. 它在建立 middleware 時就背景打 facilitator `/supported`；serverless 冷啟動時背景 promise 不可靠，而且預設 v1 也會多打一次網路。我們延到第一個付費請求才初始化，失敗會重試。
4. facilitator 出錯時它回 402 或通用 500／502，買方分不出「請重付」與「facilitator 掛了」。我們用 hook 拿原始錯誤，轉成與 v1 相同的 429 `facilitator_rate_limited`／502 `facilitator_unavailable`。

流程逐步對照 `@x402/hono` 2.28.0 的 `paymentMiddlewareFromHTTPServer`：`processHTTPRequest`（verify）→ handler → status < 400 才 `processSettlement`（settle）。**升級 `@x402/core` 時要重新對照上游 `typescript/packages/http/hono/src/index.ts`。**

`payment-identifier` 擴充同理不引入 `@x402/extensions`，在 `signal-api/src/paymentIdentifier.ts` 自寫幾十行，常數與 `@x402/extensions` 2.28.0 逐一核對（16／128／`^[a-zA-Z0-9_-]+$`）。

### 2.2 既有保護在 v2 路徑的對應（全部有測試）

| 保護 | v2 的做法 | 測試 |
|---|---|---|
| payTo 守門 fail-closed | 與 v1 同一個 `payToGuard`，在分流**之前**執行：不安全 → 503 `payto_unsafe`，不發 `PAYMENT-REQUIRED`、不碰 facilitator；both 對兩種協定都成立 | `x402v2.test.ts`（付款前閘門、both 守門） |
| `maxTimeoutSeconds` | 宣告 60；付款的 `accepted` 必須與宣告逐欄相同（payTo、amount、maxTimeoutSeconds、asset、network、extra），被竄改 → 402 且不送 facilitator | `x402v2.test.ts`（竄改 accepted） |
| 結算帳本「確定收到錢才入列」 | settle 成功才 enqueue；handler ≥ 400 不 settle、不入列；ledger 未設定 → 資料照給、`settled:false`、`settleError` 點名缺的 env | `x402v2.test.ts` |
| 冪等 | `deriveIdempotencyKeyV2`：`pid:<付款人>:<payment-identifier>` ＞ `tx:<hash>` ＞ `auth:<付款人>:<nonce>`；id **一定綁付款人**（否則 A 可以拿 B 的 id 讓自己那筆被當重複） | `x402v2.test.ts`（payment-identifier 組） |
| facilitator 錯誤對應 | verify 429 → 429＋`Retry-After`；verify 503 → 502；`isValid:false` 限流 → 429；settle 503／429 → 502／429（結果未知、不回資料）；`/supported` 失敗 → 502（phase=supported），恢復後自動重試 | `x402v2.test.ts`（facilitator 錯誤、/supported 失敗） |
| 402 的 resource 用 https | `resource.url` 取自請求 URL，Vercel 上由 `vercel-entry.ts` 補成 https（與 v1 相同） | `x402v2.test.ts`（未付款 402） |
| Vercel serverless 的坑 | 不讀 request body；不在模組載入時打網路；facilitator 單次逾時預設 20 秒、上限 55 秒（Vercel `maxDuration` 60）、`X402_FACILITATOR_TIMEOUT_MS` 可調 | `x402v2.test.ts`（逾時解析）、bundle:check |
| 付款前輸入／registry 閘門、HEAD 405、路徑變形 | 與 v1 相同的閘門在分流前執行 | `x402v2.test.ts` |
| 預設 v1 不變 | 從未改動的 master 擷取 402 golden（`signal-api/src/testing/golden/x402-v1-402.json`），未設與 `v1` 都要逐位元相同、不呼叫 facilitator、`GET /` 不變 | `x402DefaultGolden.test.ts`、`x402v2.test.ts`、`scripts/x402-protocol-smoke.ts` |

### 2.3 客戶端與 SDK

- **`signingGuard`（`shared/src/signingGuard.ts`）不需要為 v2 放寬任何檢查**：v2 exact client 簽的仍是同一份 EIP-3009 typed data，單筆上限、收款白名單、有效期上限（預設 300 秒）、官方 USDC、domain 名稱／版本、累計上限全部原樣適用。v2 新增的其他簽章路徑（Permit2、`upto`、`batch-settlement`、`auth-capture`、EIP-2612／ERC-20 approval gas sponsoring）都不是 `TransferWithAuthorization`，**預設拒絕**，金鑰不會被呼叫。另提供 client 端第一道：`x402V2SpendControls()`（沿用 `X402_MAX_PAYMENT_USDC`）與 `x402V2Eip3009OnlyPolicy`。測試：`examples/signing-guard.test.ts` 的 v2 段。
- **`meteredFetch`（`shared/src/x402Client.ts`）**：計量 `PAYMENT-SIGNATURE` 與 `X-PAYMENT`（兩個都帶時金額相加，保守）；結算證明認 v1 `X-PAYMENT-RESPONSE` 與 v2 `PAYMENT-RESPONSE` 的 `success:true`（v2 結算失敗的 402 也會帶 `PAYMENT-RESPONSE`，要看 `success`）。以結構判斷 `Request` 而非 `instanceof`（`@hono/node-server` 會換掉全域 `Request`，`@x402/fetch` 送的是原生 `request.clone()`）。
- **SDK `signalApi`（`sdk/src/signalApi.ts`）**：`x402Protocol: "auto"`（預設）＝伺服器宣告 v2 且簽署端提供 `createPaymentSignature` 才走 v2，否則 v1。v2 的 `decodeXPayment` 對應逐欄核對（`accepted` 必須等於挑選的付款要求、`authorization.to = payTo`、金額、`validBefore ≤ now + maxTimeoutSeconds + 60`、x402Version、scheme、network），`paymentSent`、累計上限預留、`paymentSignTimeoutMs`、`releaseUnsettled`（只減 unsettled、不減 spent）語意完全相同；只接受 exact／EIP-3009／authorization flow。伺服器宣告 payment-identifier 時 SDK 為每次付款帶一個 id（可由呼叫端指定），回傳在 `PaymentReceipt.paymentId`／`PaymentOutcomeUnknownError.paymentId`。
- **examples**：`agent/examples/x402-mock-e2e.ts` 起真的 signal-api（both）與會真的驗 EIP-712 簽章的本機假 facilitator，依序以 `x402-fetch`（v1）、`@x402/fetch`（v2）與 SDK 付款，離線、不付款、金鑰當場隨機產生。
- **`docs/api/openapi.yaml`**：補上 v2 的 header（`PAYMENT-REQUIRED`、`PAYMENT-SIGNATURE`、`PAYMENT-RESPONSE`）、400 `ambiguous_payment_headers`、`GET /` 的 `x402` 區塊。

## 3. 依賴與供應鏈

**新增**（皆鎖 `~2.28.0`）：

| 套件 | 用在 | 直接依賴 | 新增的間接套件 |
|---|---|---|---|
| `@x402/core` 2.28.0 | signal-api（伺服器）、examples／測試（client） | `zod ^3.24.2` | 無（`zod` 已在樹上） |
| `@x402/evm` 2.28.0 | signal-api、examples／測試 | `@x402/core`、`viem ^2.48.11`、`zod` | 無（`viem` 已在樹上） |
| `@x402/fetch` 2.28.0 | demo-agent（只供 examples） | `@x402/core` | 無 |

- `agent/package-lock.json` 相對分支起點只多 3 個 `node_modules/@x402/*` 條目與 workspace 的依賴宣告（約 +34 行）；合併 master 帶進的 `license` 欄位是 #218 的，與本次無關。**沒有任何套件被升降版、沒有新增間接套件。**
- 三個套件：Apache-2.0；npm registry 簽章（keyid `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`）；有 SLSA provenance v1 attestation（`dist.attestations`）；維護者為 Coinbase 帳號（`carsonroscoe_cb`、`erik_cb`）；`package.json` 無 install／postinstall script；`repository` 指向 x402-foundation/x402。原始碼已從 tarball 讀過。
- **刻意不引入** `@x402/hono` 與 `@x402/extensions`（見 2.1）。Vercel bundle 因此只多 2 個來源檔、2 個 npm 套件（38 來源檔、24 npm 套件）。
- 冷啟動量測（本機、有雜訊）：`import x402-hono`（v1）2.3–7.1 秒；`@x402/core/server` 75 ms；`@x402/evm/exact/server` 31 ms。

## 4. 切換到 v2（使用者要做的事）

本分支**不改正式站任何設定**。要切換時：

1. 合併本分支、Vercel 重新部署（bundle 已 commit，`bundle:check` 綠）。此時 `X402_PROTOCOL` 未設 → 仍是 v1。
2. 在 Vercel 的 signal-api 專案設 `X402_PROTOCOL=both`，重新部署。確認：
   - `GET /` 出現 `x402: { protocol: "both", versions: [2,1], network: "eip155:84532" }`；
   - 未付款打 `/oracle/sBTC`：本文與以前相同，另有 `PAYMENT-REQUIRED`；
   - **用自己的測試錢包、極小金額**以 v2 client 實付一次（這是唯一需要真錢包的步驟，本次 agent 依規定未做），確認 `PAYMENT-RESPONSE.success`、帳本入列、worker 分潤一次。
3. 觀察一段時間（建議至少一週）：v1／v2 付款比例、facilitator 429／502 頻率、帳本是否有重複鍵 log。
4. 外部 client（demo-agent、SDK 使用者、前端 `/x402` 文件頁）都能走 v2 後，再改 `X402_PROTOCOL=v2`。v1 client 此後會拿到 v2 的 402 而付不了款——**這是對外的破壞性變更，需要公告**。
5. 出問題時把 `X402_PROTOCOL` 改回 `v1`（或刪掉）重新部署即可回復，不需要回滾程式。

## 5. 移除 v1 的條件與步驟（本次不移除）

**條件（全部成立才移除）**：

1. 正式站在 `X402_PROTOCOL=v2` 下穩定運作至少 30 天，期間 v2 實付、結算、分潤皆正常。
2. 30 天內沒有任何帶 `X-PAYMENT` 的請求（以 log 確認），或已公告的停用日期已過。
3. repo 內所有 v1 client（`demo-agent/src/run.ts`、`examples/buy-signal.ts`、`examples/x402-autotrade.ts`、`examples/x402-loop.ts`、`examples/x402-autonomous.ts`、SDK 的 v1 路徑、前端 `/x402` 文件頁）都已改用 v2。
4. 公開 facilitator 仍支援 v2 exact on Base Sepolia（`/supported` 再確認一次）。

**步驟**：

1. 移除 `x402-hono`、`x402-fetch`、`x402` 依賴與 app.ts 的 `runV1`、v1 golden 測試；`X402_PROTOCOL` 只剩 v2（或刪掉這個變數）。
2. `meteredFetch`／SDK 移除 `X-PAYMENT` 分支；`signingGuard` 的 v1 註解改寫（EIP-3009 檢查本身保留）。
3. `deriveIdempotencyKey`（v1）在帳本佇列清空、worker 處理完 v1 項目後再刪。
4. `openapi.yaml` 刪 v1 header；重打 bundle、`bundle:check`；`npm test`、`typecheck`。
5. lockfile 預期會縮小（`x402` 0.5.3 直接依賴 `viem`、`wagmi`、`zod`，`wagmi` 帶進大量間接依賴），要看 diff 確認只有刪除、沒有升降版。

## 6. 付費 MCP（只記錄設計，本次不實作）

`agent/mcp-server` 目前**沒有任何付費工具**（只在資訊工具裡列出 USDC 結算代幣地址），所以不實作。將來若要把某個工具改成付費，照 v2 MCP transport：

- 工具未付款時回 `isError: true`，`structuredContent` 放 `PaymentRequired`（與 HTTP 的 `PAYMENT-REQUIRED` 同內容），`content[0].text` 為其 JSON 字串。
- client 以 `_meta["x402/payment"]` 帶 `PaymentPayload` 重呼叫；結算結果放 `_meta["x402/payment-response"]`。
- 沿用本次伺服器的同一套守門：payTo 守門 fail-closed（回 `isError` 而不是付款要求）、`maxTimeoutSeconds` 60、`accepted` 逐欄核對、settle 成功才入帳本、`payment-identifier` 綁付款人的冪等鍵、facilitator 錯誤對應成可重試／不可重試兩類。
- 簽署端一律經 `guardViemAccount`，不放寬任何檢查；MCP client 端由使用者錢包簽，不用 agent 金鑰。
- 只有 v2（MCP transport 沒有 v1 版本），不需要 both 模式。

## 7. 風險與限制

- **v2 從未對真 facilitator 實付過**：所有付款測試都用本機假 facilitator（會真的驗 EIP-712 簽章，但不上鏈）。依規定本次不付款、不送交易；切換步驟 2 的一次小額實付是上線前必要的驗收。
- `both` 模式下 v2 的 `/supported` 失敗時，該次 402 只宣告 v1（v1 client 不受影響，v2 client 會看不到 v2 選項，自動重試）。
- `payment-identifier` 去重以「同付款人＋同 id＝同一筆邏輯付款」為準：同付款人用同一個 id 付了兩筆且兩筆都結算時，只分潤一次，第二筆的款項留在 payTo 未分配（見 `KNOWN_LIMITATIONS.md` §16b）。
- 自寫 adapter 依賴 `@x402/core` 的內部流程順序；升級時必須重新對照上游 hono middleware（已鎖 `~2.28.0`，只收 patch）。
- `v2` 模式是對外破壞性變更（v1 client 付不了款）。

## 8. 驗證紀錄（2026-10-02，合併 origin/master `cfea839` 之後）

- `npm test` exit 0（含 `x402v2.test.ts` 17 組、`x402DefaultGolden.test.ts`、`signing-guard.test.ts` 12 組、`x402-mock-e2e.ts`、SDK `signalApi.test.ts` 27 項）。
- `npm run typecheck` exit 0。
- `npm run bundle:check -w signal-api` 綠。
- `npx tsx signal-api/scripts/x402-protocol-smoke.ts`：以 `SIGNAL_API_PORT` 真的啟動伺服器，在未設／v1／v2／both 下打 `/healthz`、`/`、`/oracle/sBTC`（未付款），結果見第 2.1 節表格；facilitator 只被呼叫 `/supported`（v2、both 各一次），`/verify`、`/settle` 0 次。
