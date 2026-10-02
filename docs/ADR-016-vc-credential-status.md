---
status: proposed
date: 2026-10-02
plan-item: P2-11
---

# 授權 VC 的撤銷：由簽發者以 EIP-712 簽章的狀態清單，驗證端快取並防重放；鏈上撤銷登記列為後續

> 2026-10-02，P2-11（身分標準對齊）的撤銷部分。標準對照（ERC-8126 Final、ERC-8004）寫在
> [`AGENT_ECONOMY_STANDARDS.md`](AGENT_ECONOMY_STANDARDS.md)；VC 本身的設計見 [`AGENT_IDENTITY_VC_SSI.md`](AGENT_IDENTITY_VC_SSI.md)。
> `status` 是 `proposed`：接受這份決定是擁有者的事，不是實作進度。本次**沒有部署任何合約、沒有送任何交易**。

## 1. 背景與現況（2026-10-02 讀程式確認）

授權 VC（`AgentTradingAuthorization`）由**使用者錢包**簽發給 agent 的 session key，內容是鏈上
`AgentSessionManager` session 的憑證化視圖。v2（PR #194）已有 `verifyingContract`（domain 綁 session manager）、
`validUntil`、`nonce`。

### 1.1 VC 實際在哪裡被驗、驗不過的後果

| 驗證點 | 程式 | 作用 | 驗不過的後果 |
|---|---|---|---|
| 開倉 | `shared/src/write.ts` `openPositionForSession` → `verifyVcAgainstChain` | **唯一的強制點**：驗簽、sessionId、holder、鏈上交叉比對、nonce | 不簽、不送；`reasonCode` 寫入 policy audit |
| 平倉 | `shared/src/write.ts` `closePositionForSession` → 同上 | 強制點；nonce 狀態檔故障時平倉可降級放行 | 同上，另附「直接在鏈上平倉」指引 |
| MCP `open_position`／`close_position` | `mcp-server/src/writeTools.ts` → `deps.open/close` = 上面兩個函式 | 不自己驗，交給 write.ts | 工具回 `isError` |
| tg-bot | `tg-bot/index.ts` `loadVc`／`ensureVc` | 啟動與下單前的預檢（給 chat 看得懂的原因） | 拒單（不 exit） |
| x402 agent 與範例 | `examples/vc-gate.ts` `localVerifyVc`（`x402_agent.ts`、`x402-autotrade`、`x402-autonomous`、`x402-loop`） | 預檢 | 只研究、不下單 |
| demo-agent | `demo-agent/src/run.ts` | 預檢 | 不下單 |
| SDK | `sdk/src/vc.ts` `verifyAuthorizationVCv2`、`crossCheckWithSession` | 給整合方的無狀態驗證函式 | 由呼叫端決定 |

**不驗 VC 的地方**：signal-api（`/agent/:did/verification` 是 ERC-8126 attestation，與授權 VC 無關）、
policy gate（`policyGate.ts` 在 VC 閘**之後**執行營運方規則，不看 VC）、x402 付款（agent 付自己的 USDC 買訊號，
由 `signingGuard` 管上限，不需要使用者授權）、開 session（使用者在前端自己送 `createSession`，VC 在 session 之後才簽）。
所以目前「寫入類動作」裡真的帶 VC 的只有**開倉與平倉**。本設計的檢查器以 `action: "write"` 表達寫入類，
將來付款或開 session 若改成需要 VC，用同一個入口即可。

### 1.2 既有、但不等於撤銷的機制

| 機制 | 能做到 | 做不到 |
|---|---|---|
| 鏈上 `revokeSession` | 整個 session 失效，合約回 `SessionIsRevoked`；最強 | 只能整個 session；要送交易 |
| 取代（`vcNonce.ts`） | 同 (issuer, sessionId) 重簽後，**這台 agent** 拒收較舊的 VC | 只在已經看過新 VC 的那台機器上成立；不是明確的撤銷聲明 |
| `validUntil` | 到期自動失效（預設 30 天） | 到期前無法提早作廢 |

商業化計畫把「VC 無撤銷」列為付款與 agent 層的結構性缺口：一張外洩或簽錯的 VC，在到期或整個 session 撤銷之前，
沒有辦法只作廢它一張、也沒有辦法讓**所有**驗證端都知道。

## 2. 需求

1. 簽發者可以撤銷單一憑證，也可以一次撤銷全部；撤銷對所有驗證端生效。
2. 撤銷資訊要防竄改、防重放：攻擊者不能拿舊清單讓已撤銷的憑證「復活」。
3. 驗證端要快取，並有新鮮度上限（撤銷最遲多久生效）。
4. **寫入類動作拿不到或驗不過狀態 → 一律拒絕**；唯讀類可設定。
5. 不新增金鑰類型：簽發者的私鑰用法比照現有 VC 簽發。
6. **今天不能部署新合約**：選什麼方案，這一版都要做到「不部署就能用」。
7. 現有 v2（與尚未淘汰的 v1）VC 不重簽就能被涵蓋。

## 3. 方案比較

| | (a) 簽發者簽章的狀態清單（Bitstring Status List 的概念，改用 EIP-712） | (b) 鏈上撤銷登記合約 | (c) 混合：(a) 先上，(b) 之後做權威來源 |
|---|---|---|---|
| 信任來源 | 簽發者簽章（清單放哪裡都行，主機不需被信任） | 鏈上狀態 | 兩者 |
| 需要部署 | 否 | **是**（今天不能） | (a) 部分否 |
| 撤銷成本 | 簽一次 typed data（不花 gas） | 每次撤銷一筆交易（要 gas） | (a) 免費；(b) 自選 |
| 新鮮度 | 取決於清單主機與快取；主機可以**扣住**新清單（只能用清單到期時間與驗證端記憶限制） | 讀鏈即最新；無法扣住（只能審查） | (b) 上線後取最新 |
| 可用性 | 主機掛了 → 寫入拒絕 | RPC 掛了 → 寫入拒絕（但寫入本來就要 RPC） | 同左 |
| 防重放 | 需要 `sequence` ＋ 驗證端記憶 ＋ 清單到期 | 天生沒有 | — |
| 隱私 | 每個簽發者一份清單；抓清單會透露在查哪個簽發者（簽發者位址本來就公開在鏈上 session） | 同左 | 同左 |
| v1/v2 現有 VC | 以簽發者定位清單，不需要 VC 帶指標 → 全部涵蓋 | 以 jti 查 → 全部涵蓋 | 同左 |
| 對使用者的負擔 | 撤銷後要在清單到期前續簽 | 無 | (a) 期間有 |

W3C Bitstring Status List 的原型是「一個發行機構、大量憑證、每張憑證帶 `credentialStatus` 指向清單裡的一個位元」。
我們的簽發者是**每個使用者自己**，每人只有少量憑證，而且已流通的 VC 沒有 `credentialStatus` 欄位。
所以 (a) 取它的**概念**（簽發者簽章、可快取、驗證端自己判斷），清單內容改成「被撤銷的 jti 清單＋時間水位」，
以簽發者定位清單，不需要 v3。

**決定：選 (c) 混合，這一版只做 (a)；(b) 寫成後續（§6）。** 理由：(a) 不部署就能用、撤銷不花 gas、
沿用 VC 的簽發者金鑰與 domain，而且與現有 v1/v2 VC 相容；它真正的弱點是「主機可以扣住新清單」，
這一版用清單到期時間、單調 `sequence`、驗證端的 sticky 記憶把它框住，(b) 上線後由鏈上狀態補成權威來源。
只做 (b) 今天做不到；只做 (a) 長期少一個不可扣住的來源。

## 4. 決定（本次實作）

### 4.1 狀態清單格式

Schema 是單一真相來源，前端與 agent 共用：`frontend/src/contracts/agentAuthStatus.ts`（純函式、無相依），
驗證在 `agent/shared/src/vcStatus.ts`。

```
domain      = authDomainV2(sessionManager)      // 與 v2 VC 相同：name PepeLabAgentAuthorization、version 2、chainId 84532
primaryType = AgentCredentialStatusList(
  address  issuer,
  uint256  sequence,       // 每個簽發者單調遞增
  uint256  issuedAt,
  uint256  validUntil,     // 預設 issuedAt + 30 天，上限 90 天
  uint256  revokedBefore,  // issuedAt < revokedBefore 的憑證全部撤銷；0 = 不用；不得晚於 issuedAt
  bytes32[] revoked)       // 被撤銷的 jti，小寫、嚴格遞增排序、最多 1000 筆
```

同一個 domain、不同 primary type：typed data 的 struct hash 不同，清單的簽章不可能被當成 VC（反之亦然）。
JSON 文件（`CredentialStatusList`）帶 `issuer`（did:pkh）、上述欄位與 `proof`（`EthereumEip712Signature2021`，
`eip712Domain.verifyingContract`）。驗證（`verifyStatusList`）依序拒絕：結構不符／非正規排序（`STATUS_LIST_MALFORMED`）、
項目過多、DID 不在 84532、簽章還原者 ≠ issuer、issuer ≠ VC 的簽發者、domain 綁的 session manager ≠ 本驗證端、
有效期超過 90 天、`issuedAt` 在未來超過 300 秒、已過期。

### 4.2 jti：沿用 v2 的 `nonce`，不新增欄位、不出 v3

| 版本 | jti | 依據 |
|---|---|---|
| v2 | `credentialSubject.nonce`（bytes32，簽進 EIP-712，每張隨機） | `agentAuth.ts` 本來就註明 nonce 是 VC 的 jti；簽進去所以不能被改 |
| v1 | 該 VC 的 EIP-712 digest | v1 沒有 nonce；同一份內容＝同一張憑證，`vcNonce.ts` 也用 digest 當 v1 的 id |

`credentialJti(verifyResult)` 回傳上面的值。沒有把 jti 寫成 W3C 的 `id` 欄位：VC JSON 的 `id` 不在簽章範圍內，
加了反而是一個可以被改的欄位。

### 4.3 新鮮度與防重放

| 機制 | 擋什麼 |
|---|---|
| 清單 `validUntil`（預設 30 天、上限 90 天）、`issuedAt` 不可在未來 | 舊清單無限期被拿來用；給「從未看過新清單的驗證端」一個重放上限 |
| `sequence` 高水位（每個 `${sessionManager}|${issuer}` 記最高的 sequence 與其 digest） | 送比已接受的舊的清單 → `STATUS_LIST_REPLAYED`；同 sequence 不同內容 → `STATUS_LIST_EQUIVOCATION` |
| sticky 記憶：驗證端記下看過的**所有** revoked 與最大 `revokedBefore` | 新清單漏了舊項目、或主機改送舊清單，已撤銷的憑證也不會復活；而且**已知撤銷在來源掛掉時照樣生效** |
| 扣住偵測：接受過某簽發者的清單之後，來源卻回「沒有清單」 | `STATUS_LIST_WITHHELD`，不當成「沒有撤銷」 |
| HTTP 來源的目錄標記：先取 `<base>/index.json` 必須是 `{"type":"AgentCredentialStatusDirectory"}` | 網址設錯時，所有 404 被誤當「沒有撤銷」（設定錯誤變成 fail-open） |
| 快取新鮮度上限 `VC_STATUS_CACHE_MAX_AGE_SEC`：預設 60 秒、**硬上限 900 秒**、0＝不快取；時鐘倒退不沿用快取；快取中的清單到期一樣擋 | 撤銷發佈後最遲多久生效（在來源可用的前提下：≤ 新鮮度上限） |

驗證端記憶存在 `agent/.state/vc-status-state.json`（`VC_STATUS_STATE_PATH`），MCP、tg-bot、x402 agent 同機共用，
用 `fileLock.ts` 序列化讀改寫（與 `vcNonce.ts` 同一套）。狀態檔讀不到或格式不符 → `STATUS_STATE_UNREADABLE`。
刪除狀態檔＝忘記高水位與 sticky 撤銷：之後只剩清單到期與主機誠實這兩道（見 §7）。

**沒有清單**（來源明確回答這個簽發者沒發佈過）＝沒有撤銷。這是大多數使用者的狀態，也是現有 VC 不必任何動作就能繼續使用的原因。

### 4.4 失敗行為

| 狀態 | 寫入類（開倉、平倉；將來的付款、開 session） | 唯讀類 |
|---|---|---|
| `active`（有清單且未撤銷，或沒有清單） | 放行 | 放行 |
| `revoked`（在清單或 sticky 記憶裡） | **拒絕** `VC_REVOKED` | **拒絕** |
| `unknown`（來源不可達、清單過期／簽章錯／簽發者不符／別的部署／重放／同號異文／被扣住、狀態檔壞掉） | **拒絕** `VC_STATUS_UNVERIFIED`（細部原因在訊息裡） | `VC_STATUS_READ_POLICY=allow`（**預設**）：放行，結果標 `status: "unknown"` 並帶警告；`deny`：拒絕；無法辨識的值當 `deny` |

- **平倉也 fail-closed，沒有降級。** 這和 nonce 狀態檔故障時平倉降級放行（`vcNonceDecision`）不同：nonce 檔是 agent
  自己的基礎設施，故障與使用者意圖無關；撤銷狀態是**使用者的意圖**，拿不到就不能假設使用者沒有撤銷。
  使用者不會被鎖在部位裡：合約的 `PerpetualExchange.closePosition` 不需要 VC，拒絕訊息附上這個指引（`CLOSE_ONCHAIN_HINT`）。
- **唯讀預設 allow 的理由**：唯讀動作不動用使用者的錢、也不代表使用者對外做任何承諾；讀的是鏈上公開資料。
  狀態來源短暫不可用時，讓監看、顯示、研究繼續運作比較重要，而且結果明確標成 unknown，呼叫端看得到。
  營運方可以用 `deny` 收緊。已知撤銷不受這個設定影響，一律拒絕。

### 4.5 每個驗證點怎麼接

| 驗證點 | 接法 | 順序 |
|---|---|---|
| `write.ts` `verifyVcAgainstChain`（開倉、平倉） | `defaultVcStatusChecker().check(res, { action: "write", verifyingContract: mgr })`；不過 → `reasonCode` `VC_REVOKED`／`VC_STATUS_UNVERIFIED`，`guardStage: "vc"`，寫入 audit | 驗簽、sessionId、holder 之後，**讀鏈之前**（被撤銷的憑證不必花 RPC）；之後才是鏈上比對與 nonce |
| MCP `open_position`／`close_position` | 經 write.ts（同上）；工具回 `VC_REVOKED`／`VC_STATUS_UNVERIFIED` | — |
| tg-bot | `ensureVc()` 改成 async：本地驗證後再查狀態（write）；被撤銷時重讀一次 VC 檔；不發確認碼。`vcStatusProblemForBot` 把結果轉成 chat 訊息 | 下單前、發確認碼前 |
| x402 agent 與範例 | `vc-gate.ts` 新增 `localVerifyVcWithStatus`（write）；四個呼叫端改用它 | 準備下單前 |
| demo-agent | `checkCredentialStatus(v, { action: "write" })` | 驗簽之後、下單之前 |
| SDK | 新增 `vcStatus` 模組：`buildStatusListTypedData`／`finalizeStatusList`／`issueStatusList`、`checkCredentialStatusWithList`（無狀態，呼叫端傳 `minSequence`）、`createVcStatusChecker`＋`httpStatusSource`＋狀態儲存（常駐服務用） | 由整合方決定 |

預檢只是讓錯誤早一點、清楚一點；**強制點只有 write.ts**，其他入口都會在送單前再經過它。

### 4.6 誰能撤銷、怎麼撤銷

- **誰**：只有 VC 的簽發者（建立 session 的使用者錢包）。清單的簽章還原者必須等於 VC 的 issuer。
  營運方不能替使用者撤銷 VC——營運方要擋某個客戶，用 policy gate（它本來就比 VC 嚴，而且不需要使用者簽名）；
  使用者要立刻、最強地停掉 agent，仍是鏈上 `revokeSession`。
- **金鑰**：與簽 VC 同一把（使用者錢包），同一個 EIP-712 domain，只是 primary type 不同。沒有新增金鑰類型，
  agent 與 SDK 都不持有它。
- **怎麼撤銷**：
  1. 取得要撤銷的 jti：`npx tsx examples/vc-status.ts jti --vc <vc.json>`（或 SDK `credentialJti`）。
     要撤銷全部就用 `--revoke-before now`，不需要 jti。
  2. 產生待簽 typed data：`npx tsx examples/vc-status.ts typed-data --issuer <使用者> --from <目前清單> --revoke <jti>`
     （`--from` 沿用舊項目、sequence 自動 +1；新清單必須是累積的）。整合方可改用 SDK `buildStatusListTypedData`。
  3. 使用者用自己的錢包簽（`eth_signTypedData_v4`）。
  4. `assemble` 組成清單（立即驗證，簽錯人就失敗），`install` 放進驗證端的清單目錄（`VC_STATUS_DIR`，
     會檢查 sequence 遞增並建立 `index.json` 目錄標記）。整個目錄可以原樣放上任何靜態主機，驗證端設 `VC_STATUS_URL` 即可。
  5. 清單到期前續簽（同內容、sequence +1）。過期的清單會讓**該簽發者**的寫入被拒。

前端的「一鍵撤銷」按鈕這一版沒有做（§8）。

### 4.7 設定

| 變數 | 預設 | 說明 |
|---|---|---|
| `VC_STATUS_URL` | （無） | 清單目錄的 http(s) base URL；設了就用 HTTP 來源（單次逾時 3 秒） |
| `VC_STATUS_DIR` | `agent/.state/vc-status` | 本機清單目錄；檔名 `<issuer 小寫>.json`；目錄不存在＝沒有任何清單 |
| `VC_STATUS_STATE_PATH` | `agent/.state/vc-status-state.json` | 驗證端記憶 |
| `VC_STATUS_CACHE_MAX_AGE_SEC` | 60 | 快取新鮮度上限，最大 900 |
| `VC_STATUS_READ_POLICY` | `allow` | 唯讀動作遇到 unknown 的行為 |

沒有「關閉撤銷檢查」的開關。

## 5. 不做 signal-api 端點的理由

清單自帶簽章，任何靜態主機都能當來源，所以這一版**沒有**在 signal-api 新增端點：

1. 只讀的 `GET` 端點沒有意義——signal-api 在 Vercel 上沒有檔案系統，要服務清單就得同時開一個**寫入**端點（讓使用者上傳）
   並存進 Upstash，這是公開 API 上新的寫入面：要做大小上限、每個簽發者的 sequence compare-and-set，
   還要擋「隨手產生新錢包灌爆 KV」（例如只收鏈上確實是某個 session user 的簽發者，需要 RPC）。
2. 不動 signal-api 就不必重打 Vercel bundle 的端點部分、不碰 402 golden、不改 `GET /` 探索文件。
   （`vcStatus.ts` 經 `shared/src/index.ts` 進入 bundle 的 import graph，所以 bundle 仍然重打、指紋一起 commit。）

若之後要做，介面草案：`GET /vc/status/:issuer`（免費；200 清單／404 沒有清單）、`GET /vc/status/index.json`（目錄標記）、
`POST /vc/status`（本文即清單；驗簽、sequence 嚴格遞增才寫入、上限 1000 筆）。

## 6. 後續：鏈上撤銷登記（方案 (b)，本次不部署）

```solidity
// 草案，未實作、未部署
interface IAgentCredentialStatus {
    event CredentialRevoked(address indexed issuer, bytes32 indexed jti);
    event RevokedBefore(address indexed issuer, uint64 timestamp);
    function revoke(bytes32 jti) external;                       // msg.sender = issuer
    function revokeBefore(uint64 timestamp) external;             // 只能往後推
    function isRevoked(address issuer, bytes32 jti, uint64 issuedAt) external view returns (bool);
}
```

- 上線後，`StatusSource` 加一個讀鏈的實作，與清單**取聯集**（任一來源說撤銷就撤銷）。鏈上狀態不能被主機扣住，
  可以把清單有效期放寬、或讓清單只作快取。
- 也可以不另寫合約，改用 `AgentSessionManager` 下一版內建（session 層級已有 revoke）；或在 ERC-8004 Validation Registry
  記錄撤銷（它仍在討論中，見 `AGENT_ECONOMY_STANDARDS.md` §3）。選哪個留到部署時決定。
- 前端「撤銷」按鈕（簽清單＋上傳），以及 §5 的 signal-api 端點。

## 7. 風險與限制

- **主機可以扣住新清單**：對「從未看過新清單」的驗證端，最壞情況是舊清單到期前（≤ 90 天，預設 30 天）看不到新的撤銷。
  看過的驗證端有 sticky 記憶，不受影響。這是 (b) 要補的洞。
- **撤銷有延遲**：清單發佈後，最遲 `VC_STATUS_CACHE_MAX_AGE_SEC`（≤ 900 秒）生效；要立即生效仍用鏈上 `revokeSession`。
- **清單過期 → 該簽發者的寫入被拒**：一旦發佈過清單，就要在到期前續簽。這是 fail-closed 的直接後果，訊息會說明。
- **狀態檔被刪除**：忘記高水位與 sticky 撤銷，退回只靠清單到期與主機。與 `vcNonce.ts` 的狀態檔是同一類風險，同一個目錄。
- **單機狀態**：跨主機部署要把狀態檔換成共享儲存（`StatusStateStore` 是介面，記憶體版與檔案版都有）。
- 清單會透露「某個簽發者撤銷過哪些 jti」。jti 是隨機值，不含 VC 內容；簽發者位址本來就公開在鏈上 session。

## 8. 沒做的事

- 前端撤銷 UI（SessionsPage 的按鈕）：schema 已放在前端可用的 `agentAuthStatus.ts`，UI 列後續。
- signal-api 狀態端點（§5）。
- 鏈上撤銷登記（§6）。
- 付款、開 session 目前不帶 VC，所以沒有接檢查點；檢查器已用 `action: "write"` 表達，將來直接套用。

## 9. 驗證紀錄（2026-10-02）

- `examples/vc-status.test.ts`：17 組（清單本身的 9 種拒絕、jti 對應、撤銷判斷、重放、同號異文、扣住、過期、
  快取新鮮度與 900 秒上限（注入時鐘）、來源不可達的寫入／唯讀行為、跨 process 狀態與壞檔、本機與 HTTP 來源、
  v1 舊憑證、write.ts 開倉與平倉、MCP 工具、tg-bot 與 vc-gate 預檢）。
- `sdk/test/vcStatus.test.ts`：4 組（viem 簽 ↔ ethers 驗、無狀態判斷的六種拒絕、finalize 防呆、檢查器快取）。
- `frontend/src/contracts/agentAuthStatus.test.ts`：2 組（schema 簽驗、jti 正規化）。
- 全量（本機，Windows／Node 25）：agent `npm run typecheck`、`npm test`（含 `x402DefaultGolden.test.ts`、
  `x402-mock-e2e.ts`）、`bundle:check` 全部 exit 0；前端 `tsc --noEmit` exit 0、`yarn test` 68 個檔案 988 項全過。
  402 golden 未改；signal-api bundle 重打（`vcStatus.ts`、`agentAuthStatus.ts` 進入 import graph），指紋一起 commit。
