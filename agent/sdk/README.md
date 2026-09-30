# @pepelab/sdk

> 給機構客戶整合 PepeFi（Base Sepolia 鏈上 CFD）用的 TypeScript SDK。
> **狀態**：測試網研究原型的整合層，`private: true`，尚未發布到 npm。

四個部分，彼此獨立：

| 模組 | 做什麼 | 不做什麼 |
|---|---|---|
| `read` | 以 viem 讀帳戶、部位、保證金、市場（oracle 價與新鮮度、OI、資產模式、暫停）、session；**每次讀取鎖定同一個區塊** | 不送交易 |
| `write` | 建構未簽交易 `{ to, data, value, request }` | **不簽、不送、不持有金鑰** |
| `signalApi` | signal-api 的型別化 client：逾時、只對冪等 GET 重試、型別化錯誤、x402 付款由呼叫端注入 | 不持有付款私鑰 |
| `vc` | Agent 授權 VC v2（EIP-712）的 typed data 建構、驗證、與鏈上 session 交叉比對 | 不收 v1；不做 nonce 一次性（有狀態） |

需求：Node ≥ 20（用到 `fetch`、`AbortController`、`Buffer`、`crypto.getRandomValues`）。

---

## 1. 安裝（workspace）

SDK 是 `agent/` 的 npm workspace（`agent/` 只用 npm，見 `docs/agents/environment.md`）。

```bash
cd agent
npm ci
npm run test:sdk          # 離線單元測試（CI 會跑）
npm run test:sdk:live     # 只讀的 live 測試：Base Sepolia 公共 RPC + 正式 signal-api 免費端點
```

同一個 workspace 內的程式直接 import：

```ts
import { createReadClient, SignalApiClient, buildOpenPosition } from "@pepelab/sdk";
// 或只取一部分
import { verifyAuthorizationVCv2 } from "@pepelab/sdk/vc";
```

位址**不寫在 SDK 裡**：核心合約直接 import `frontend/src/contracts/addresses.ts`（前端、agent、SDK 同一份）。
唯一的例外是 AgentSessionManager（位址在 `frontend/src/contracts/sessionManager.ts`，該檔 import 了
ethers 與路徑別名，agent 端無法直接 import），SDK 保留一份對照表，並由 `test/addresses.test.ts`
以 `scripts/check-addresses.mjs` 的解析器逐鏈比對 —— 前端改了位址而 SDK 沒跟上，Agent CI 會紅燈。

## 2. 快速開始

```ts
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createReadClient, SignalApiClient } from "@pepelab/sdk";

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL) });
const read = createReadClient({ chainId: 84532, publicClient, latestBlockLag: 3 });

const btc = await read.getMarket("sBTC");
console.log(btc.blockNumber, btc.oracle.price.formatted, btc.oracle.freshness.fresh, btc.mode);

const api = new SignalApiClient(); // 預設正式 signal-api
const exposure = await api.getRiskExposure();
```

## 3. 讀取

```ts
const ctx = await read.getBlockContext();                    // { blockNumber, blockTimestamp }
const at = { blockNumber: ctx.blockNumber };                 // 讓多次呼叫對齊同一區塊

const acct = await read.getAccount(user, at);                // freeMargin、health、未平倉部位（含 uPnL、pending funding）
const all  = await read.getAccount(user, { ...at, includeClosed: true });
const pos  = await read.getPosition(7n, at);
const mkts = await read.getMarkets(["sBTC", "sETH"], at);    // 省略 = 全部 11 個資產
const s    = await read.getSession(0, at);                   // user/agent/額度/剩餘預算/到期/撤銷/資產白名單
```

- **同一區塊**：每個方法只決定一次區塊（你給的 `blockNumber`，或 `latest − latestBlockLag`），
  所有 `eth_call` 都帶這個區塊；價格年齡、session 是否過期都以**該區塊的 timestamp** 計算，不用本機時鐘。
  預設有 Multicall3 時合併讀取（`multicall: false` 可關），兩條路徑都鎖定區塊。
- **數值**：每個金額都是 `{ raw: bigint, formatted: string, decimals }`；`formatted` 用 viem `formatUnits`，
  不經過浮點數。保證金／PnL／名目／OI 上限 18 位小數；oracle 價 8 位；`executionFee` 是 wei。
- **新鮮度**：`oracle.freshness` 以交易所的 `maxPriceAge` 判斷（與鏈上開倉／平倉／清算同一判準，
  重用 `agent/shared/src/freshness.ts`），不是 MockOracle 的 24 小時 `isStale`。
- **P1 欄位**（`mode` = Active/ReduceOnly/Halted、`paused`、`longOpenSize`、`maxLongOI`…）：master 的合約原始碼有，
  **現行部署版沒有**。讀不到時回 `{ supported: false, value: null }`，而不是猜一個值；
  只有「合約 revert」會被當成不支援，RPC／網路錯誤一律丟出。
- `openLikelyAllowed` 只是參考（價格新鮮 + Active + 未暫停），不含 KYC、槓桿、OI 上限、保證金等條件。
  **不要拿它擋平倉。**
- `getUnrealizedPnL` 在價格過期時可能 revert；此時該部位的 `unrealizedPnL` 為 `null`，不拖垮整份帳戶讀取。
- `session.unrestricted === true` 代表**沒有資產白名單**（agent 可交易所有資產），請在介面上明示。

## 4. 建構交易

所有 builder 回傳：

```ts
interface UnsignedTx {
  to: Address; data: Hex; value: bigint;           // 交給 HSM／MPC／Fireblocks／錢包簽
  request: { address, abi, functionName, args, value? };  // 直接給 viem
}
```

```ts
import { buildApproveMargin, buildDepositMargin, buildOpenPosition, buildClosePosition,
         buildCreateSessionWithAssets, buildRevokeSession } from "@pepelab/sdk";

const A = read.addresses;
const approve = buildApproveMargin(A, { amount: 100n * 10n ** 18n });
const deposit = buildDepositMargin(A, { amount: 100n * 10n ** 18n });

const mkt  = await read.getMarket("sBTC");
const open = buildOpenPosition(A, { asset: "sBTC", isLong: true, margin: 50n * 10n ** 18n, leverage: 3,
                                    executionFee: mkt.executionFee.raw });
await publicClient.simulateContract({ ...open.request, account });   // 先模擬（eth_call）
// 簽與送由你的簽署端負責：walletClient.writeContract({ ...open.request, account })

const close = buildClosePosition(A, { positionId: 7n });

const session = buildCreateSessionWithAssets(A, {
  agent, maxMarginPerTrade: 50n * 10n ** 18n, totalMarginBudget: 1000n * 10n ** 18n,
  maxLeverage: 3, expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  allowedAssets: ["sBTC", "sETH"],                 // 不可為空，見第 8 節
});
const revoke = buildRevokeSession(A, { sessionId: 3 });
```

另有 `buildWithdrawMargin`、`buildSetSessionAssets`（同樣拒絕空陣列）、`buildOpenPositionForSession`、
`buildClosePositionForSession`（agent 的 session key 用）。

## 5. Signal API

```ts
import { SignalApiClient } from "@pepelab/sdk";

const api = new SignalApiClient({
  // baseUrl: 預設 https://agent-git-master-zuemens-projects.vercel.app
  timeoutMs: 15_000,
  retry: { retries: 2, baseDelayMs: 300, maxDelayMs: 5_000, maxRetryAfterSec: 10 },
});

await api.healthz();                       // "ok"
await api.discover();                      // Discovery（含 payToSafety）
await api.getRevenue({ trader });
await api.getCandles("sBTC", { interval: "1h", limit: 100 });
await api.getBenchmarks({ date: "2026-09-01" });
await api.getRiskExposure();               // 同一區塊的協議曝險報表
await api.getAgentVerification("did:pkh:eip155:84532:0x…");
```

型別依 `docs/api/openapi.yaml` 手寫；`test/openapi-schema.test.ts` 逐一比對每個 schema 的欄位集合與必填集合、
每個端點的路徑／`operationId`／是否付費（`security: x402`），任何一邊改了另一邊沒跟上就紅燈。
`OracleSnapshot`、`TraderPerformance`、`AgentVerification` 直接重用 `agent/shared` 的型別。

### 付費端點（x402）

SDK **不持有私鑰**。付費端點由你注入 `X402PaymentClient`：

```ts
import { createPaymentHeader } from "x402/client";
import { guardViemAccount } from "@pepelab/shared";  // 選用：agent 的簽章守門

const account = guardViemAccount(yourAccount);       // 你的 HSM／MPC／本地帳戶
const api = new SignalApiClient({
  payment: {
    createPaymentHeader: ({ requirements, x402Version }) =>
      createPaymentHeader(account, x402Version, requirements as never),
  },
  maxPaymentAtomic: 20_000n,        // 單筆上限（USDC 6 位小數），預設 0.02 USDC
  maxTotalSpendAtomic: 1_000_000n,  // 此 client 的累計上限，預設 1 USDC
  payToAllowlist: ["0x…"],          // 建議：只付給已知的收款地址
});

const { body, payment } = await api.getOracleSnapshot("sBTC");
console.log(body.data.recommendation, payment?.paidUsdc, payment?.settlement);
```

流程：不帶付款先請求 → 伺服器的付款前守門（400、`payto_unsafe`、`price_stale`）直接以型別化錯誤丟出，
不會要求你簽任何東西 → 402 時挑出 `scheme=exact`、`network=base-sepolia`、幣別 = Circle 官方 USDC、
（若設定）`payTo` 在白名單內的要求 → 檢查單筆與累計上限 → 呼叫你的簽署端 → 從 `X-PAYMENT` 解出
`authorization.value` 再檢查一次（簽出金額不得大於要求或上限）→ **只送一次**。

預設上限沿用 agent 端（`agent/shared/src/x402Client.ts`）的 `X402_DEFAULT_MAX_PAYMENT_USDC` 與
`X402_DEFAULT_MAX_TOTAL_SPEND_USDC`，但 **SDK 不讀環境變數**，一律以建構參數為準。

> **現況（2026-09-30）**：正式 signal-api 的收款地址未通過守門，付費端點回 `503 payto_unsafe`
> （`PayToUnsafeError`）。在營運方更換收款設定之前，付費端點無法使用。

## 6. VC（Agent 授權 v2）

```ts
import { buildAuthorizationTypedData, finalizeAuthorizationVC, verifyAuthorizationVCv2,
         crossCheckWithSession } from "@pepelab/sdk";

// 簽發端（終端客戶的錢包簽）
const draft = buildAuthorizationTypedData({
  issuer: user, agent, sessionId: 3,
  caps: { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 3, expiry },
  verifyingContract: read.addresses.sessionManager!,
});
const signature = await walletClient.signTypedData({ account: user, ...draft.typedData });
const vc = finalizeAuthorizationVC(draft, signature);   // 內含驗證；簽錯人會丟錯

// 驗證端
const r = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: read.addresses.sessionManager! });
const s = await read.getSession(r.sessionId!);
const check = crossCheckWithSession(r, s);              // { ok, mismatches[] }
```

- schema、domain、typed value 全部重用 `frontend/src/contracts/agentAuth.ts`；驗簽重用
  `agent/shared/src/identity.ts`（ethers），SDK 沒有另寫一套密碼學。測試確認 viem 簽 ↔ ethers 驗雙向相容。
- **v1 一律拒絕**（`reasonCode: "VC_V1_REJECTED"`）。agent 端在 2026-12-31 前仍帶警告接受 v1，SDK 不接受。
- `expectedVerifyingContract` 必填：避免把另一顆 session manager 的授權當成本部署的。
- **nonce 一次性不在 SDK 裡**：它需要持久狀態。驗證端必須自己記錄已用過的 nonce
  （agent 的做法見 `agent/shared/src/vcNonce.ts`）。

## 7. 錯誤處理

| 錯誤 | 何時 | 建議處理 |
|---|---|---|
| `PaymentRequiredError`（402） | 沒注入 payment client；或 `afterPayment: true` = 付款後驗證／結算失敗 | 注入 payment client；`afterPayment` 時先對帳再決定 |
| `RateLimitedError`（429） | 免費端點節流、facilitator 限流 | 依 `retryAfterSec` 等待；付款後的 429 不會自動重試 |
| `PayToUnsafeError`（503） | 收款地址未通過伺服器守門 | **不要付款**；聯絡營運方 |
| `PriceStaleError`（503） | 鏈上價格超過 `maxPriceAge` | 等 keeper 更新 |
| `ServiceUnavailableError`（502/503） | 上游或內部錯誤 | 免費端點已自動重試；付費請求不重試 |
| `PaymentLimitExceededError` | 要求金額超過單筆或累計上限 | 未簽、未付 |
| `PaymentRejectedError` | 付款要求的網路／幣別／payTo 不符，或簽署端回了無法解析的 X-PAYMENT | 未付 |
| `PaymentOutcomeUnknownError` | 已送出 X-PAYMENT 但逾時／斷線 | **款項可能已結算**；以 facilitator／鏈上紀錄對帳，SDK 不重送 |
| `SignalApiTimeoutError` / `SignalApiNetworkError` | 未帶付款的請求重試用盡 | 稍後重試 |
| `ReadCallError` | 必要的鏈上讀取 revert | 檢查位址與部署 |
| `TxBuildError` / `EmptyAssetListError` | builder 參數不合法 | 修正參數 |
| `InvalidAuthorizationError` | `finalizeAuthorizationVC` 驗證失敗 | 檢查簽署者 |

所有 HTTP 錯誤都繼承 `SignalApiError`（`status`、`code`、`body`、`url`）。

## 8. 安全注意事項

1. **SDK 不持有、不讀取任何金鑰**。交易只建構不簽；x402 付款與 VC 簽署都由呼叫端的簽署端完成。
   SDK 自己的程式碼不讀環境變數；唯一的例外來自重用：`vc` 模組載入的 `agent/shared/src/identity.ts`
   會在載入時讀 `AGENT_CHAIN_ID`（未設定時為 84532；設成 `addresses.ts` 沒有的鏈會在 import 時丟錯）。
2. **平倉永不受 SDK 限制**。`buildClosePosition`／`buildClosePositionForSession` 是純函式，不接收 client，
   不查資產模式、暫停、價格新鮮度、VC 或任何政策；測試會檢查它們的原始碼不引用這些檢查。
   合約本身在全域暫停或資產 Halted 時會拒絕平倉 —— 那是鏈上的決定，`simulateContract` 會告訴你。
3. **Session 資產陣列不可為空**。`AgentSessionManager` 把空陣列視為「全部資產都允許」。
   `buildCreateSessionWithAssets`／`buildSetSessionAssets` 收到空陣列會丟 `EmptyAssetListError`。
   SDK 刻意不提供不限資產的 `createSession` builder。
4. **付款上限是 client 層級、記憶體內**：`maxTotalSpendAtomic` 只在同一個 `SignalApiClient` 實例內累計，
   程序重啟就歸零。需要跨程序的總額控管，請在你的簽署端（例如 `guardViemAccount` 的累計上限）另外做。
5. 帶付款的請求**永不自動重試**；x402 沒有退款機制。
6. `latestBlockLag`：公共 RPC 背後是負載平衡的多個節點，最新區塊可能尚未同步；建議設 2–3。
7. 測試網研究原型：沒有第三方稽核，不是生產系統，不提供投資建議。

## 9. 測試

| 指令 | 內容 | 連網 |
|---|---|---|
| `npm run test:sdk` | addresses／abi／read／write／openapi-schema／signalApi／vc，外加 live（預設略過） | 否 |
| `npm run test:sdk:live` | 位址互相指向、11 個資產同一區塊、session／帳戶讀取、`simulateContract`（eth_call）、signal-api 免費端點、付費端點在無 payment client 下的錯誤 | 是（只讀） |

`test:sdk` 已接進 `agent` 的 `npm test`；SDK 的型別檢查在 `npm run typecheck`（`tsc -p sdk`）。
SDK 自帶 `tsconfig.json`：`agent/tsconfig.json` 是 signal-api Vercel bundle 指紋的建置設定之一，不能為了 SDK 改它。
