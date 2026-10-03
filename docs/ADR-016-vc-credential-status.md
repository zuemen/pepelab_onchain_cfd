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
| 信任來源 | 清單內容靠簽發者簽章（主機無法偽造或竄改）；但「這個簽發者**有沒有**清單」靠主機／目錄管理者誠實回答（§7.1） | 鏈上狀態 | 兩者 |
| 需要部署 | 否 | **是**（今天不能） | (a) 部分否 |
| 撤銷成本 | 簽一次 typed data（不花 gas） | 每次撤銷一筆交易（要 gas） | (a) 免費；(b) 自選 |
| 新鮮度 | 取決於清單主機與快取；主機可以**扣住**清單：對看過舊清單的驗證端，上限是舊清單到期；對**從沒看過**的驗證端沒有時間上限（§7.1） | 讀鏈即最新；無法扣住（只能審查） | (b) 上線後取最新 |
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
| 目錄標記 `index.json`（`{"type":"AgentCredentialStatusDirectory"}`）：本機目錄與 HTTP 來源**都**要求；清單檔不存在時**每次**重新確認標記；目錄不存在、標記缺失或不符 → 狀態不明（寫入拒絕） | 路徑／網址打錯、volume 沒掛上、換了部署目錄沒搬清單時，所有簽發者被誤當「沒有撤銷」（審查 M1；設定錯誤變成 fail-open） |
| HTTP 不跟隨轉址（`redirect: "manual"`；3xx 或 `redirected` → 不明）；本文上限 256 KB | 主機或中間人用 302 轉到 404 頁面冒充「沒有清單」（審查 M2）；超大回應耗盡記憶體（審查 L4） |
| 到期預警：清單剩不到 7 天時，檢查結果帶 `warnings` | 清單一過期該簽發者的開倉、平倉全被拒；讓人提早看到（審查 M3，§4.4） |
| 快取新鮮度上限 `VC_STATUS_CACHE_MAX_AGE_SEC`：預設 60 秒、**硬上限 900 秒**、0＝不快取；時鐘倒退不沿用快取；快取中的清單到期一樣擋 | 撤銷發佈後最遲多久生效（在來源可用的前提下：≤ 新鮮度上限） |

驗證端記憶存在 `agent/.state/vc-status-state.json`（`VC_STATUS_STATE_PATH`），MCP、tg-bot、x402 agent 同機共用，
用 `fileLock.ts` 序列化讀改寫（與 `vcNonce.ts` 同一套）。狀態檔讀不到或格式不符 → `STATUS_STATE_UNREADABLE`。
刪除狀態檔＝忘記高水位與 sticky 撤銷：之後只剩清單到期與主機誠實這兩道（見 §7）。

**沒有清單**（來源明確回答這個簽發者沒發佈過：有目錄標記、清單檔不存在／HTTP 直接回 404）＝沒有撤銷。這是大多數使用者的狀態，
也是現有 VC 不必重簽就能繼續使用的原因；但**驗證端必須先有一個已初始化的清單目錄**（`vc-status init`），否則一律狀態不明、寫入拒絕。

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
- **狀態不明期間，agent 自動的保護性平倉也會停擺**（審查 I7）。使用者自己用錢包平倉不受影響。
- **到期預警（審查 M3）**：清單剩不到 7 天（`STATUS_LIST_EXPIRY_WARNING_SEC`）時，`active` 結果帶 `warnings`。
  write.ts 把它放進成功結果的 `warnings`（並寫 stderr），MCP 工具結果原樣帶出，tg-bot 在確認碼訊息與成交訊息後面附上，
  demo-agent、`vc-gate`（x402 agent／範例）印出，SDK 的 `checker.check` 與 `checkCredentialStatusWithList` 也帶同一段文字。

### 4.5 每個驗證點怎麼接

| 驗證點 | 接法 | 順序 |
|---|---|---|
| `write.ts` `verifyVcAgainstChain`（開倉、平倉） | `defaultVcStatusChecker().check(res, { action: "write", verifyingContract: mgr })`；不過 → `reasonCode` `VC_REVOKED`／`VC_STATUS_UNVERIFIED`，`guardStage: "vc"`，寫入 audit | 驗簽、sessionId、holder 之後，**讀鏈之前**（被撤銷的憑證不必花 RPC）；之後才是鏈上比對與 nonce |
| MCP `open_position`／`close_position` | 經 write.ts（同上）；工具回 `VC_REVOKED`／`VC_STATUS_UNVERIFIED` | — |
| tg-bot | `ensureVc()` 改成 async：本地驗證後再查狀態（write）；被撤銷時重讀一次 VC 檔；不發確認碼。`vcStatusProblemForBot` 把結果轉成 chat 訊息 | 下單前、發確認碼前 |
| x402 agent 與範例 | `vc-gate.ts` 新增 `localVerifyVcWithStatus`（write）；四個呼叫端改用它 | 準備下單前 |
| demo-agent | `checkCredentialStatus(v, { action: "write" })` | 驗簽之後、下單之前 |
| SDK | **不強制**（SDK 只建交易、不送；整合方自己簽送時，必須先跑 `verifyAuthorizationVCv2`、`crossCheckWithSession`、`checker.check(..., {action:"write"})`）。新增 `vcStatus` 模組：`buildStatusListTypedData`／`finalizeStatusList`／`issueStatusList`、`checkCredentialStatusWithList`（無狀態，呼叫端傳 `minSequence`）、`createVcStatusChecker`＋`httpStatusSource`＋狀態儲存（常駐服務用） | 由整合方決定 |

預檢只是讓錯誤早一點、清楚一點；**強制點只有 write.ts**，其他入口都會在送單前再經過它。

### 4.6 誰能撤銷、怎麼撤銷

- **誰**：只有 VC 的簽發者（建立 session 的使用者錢包）。清單的簽章還原者必須等於 VC 的 issuer。
  營運方不能替使用者撤銷 VC——營運方要擋某個客戶，用 policy gate（它本來就比 VC 嚴，而且不需要使用者簽名）；
  使用者要立刻、最強地停掉 agent，仍是鏈上 `revokeSession`。
- **金鑰**：與簽 VC 同一把（使用者錢包），同一個 EIP-712 domain，只是 primary type 不同。沒有新增金鑰類型，
  agent 與 SDK 都不持有它。
- **怎麼撤銷**：
  0. （營運方，一次）初始化驗證端的清單目錄：在 `agent/` 執行 `npm run vc-status:init`（= `npx tsx examples/vc-status.ts init`，
     建立 `index.json` 目錄標記）。沒有標記的目錄一律視為狀態不明，**所有寫入都被拒**——這是刻意的：路徑打錯不能變成「沒有任何撤銷」。
     **只在持久儲存上跑一次，不要放進容器啟動腳本**（審查 N3）：沒掛 volume 的容器每次啟動都 init，會在暫存檔案系統建出
     「有標記的空目錄」，等於重新打開 M1。MCP server 與 tg-bot 啟動時只做**預檢**（`preflightVcStatus`），缺標記就印
     `::error::` 與 init 指令，**不會自動建立**。升級說明也寫在 `agent/README.md`、`agent/tg-bot/README.md`、`docs/DEMO_SCRIPT.md`。
  1. 取得要撤銷的 jti：`npx tsx examples/vc-status.ts jti --vc <vc.json>`（或 SDK `credentialJti`）。
     要撤銷全部就用 `--revoke-before now`，不需要 jti：它會填 `revokeAllCutoff(now)` = now + 301 秒，涵蓋時鐘偏快 ≤ 300 秒
     的裝置剛簽的 VC（審查 L2；VC 的 issuedAt 本來就允許比驗證端快 300 秒）。代價是撤銷後約 5–10 分鐘內新簽的 VC 也算被撤銷
     （清單的 issuedAt 本身也可以比驗證端快 300 秒，最壞約 10 分鐘），請等這段時間過後再重簽。被這樣擋下時，檢查結果的
     `revokedBy` 是 `revokedBefore`，訊息與 tg-bot 的拒單訊息都會提醒等待（審查 N4）。驗證端接受的 `revokedBefore` 上限是清單
     `issuedAt` + 301 秒。
  2. 產生待簽 typed data：`npx tsx examples/vc-status.ts typed-data --issuer <使用者> --from <目前清單> --revoke <jti>`
     （`--from` 沿用舊項目、sequence 自動 +1；新清單必須是累積的）。目錄裡已有這個簽發者的清單時**必須**帶 `--from`；
     第一份清單 sequence 預設 1，與 SDK 的 `prev.sequence + 1` 慣例一致（審查 L6）。整合方可改用 SDK `buildStatusListTypedData`。
  3. 使用者用自己的錢包簽（`eth_signTypedData_v4`）。
  4. `assemble` 組成清單（立即驗證，簽錯人就失敗），`install` 放進驗證端的清單目錄（`VC_STATUS_DIR`，
     會檢查 sequence 遞增；新清單少了現有清單的撤銷項目時**拒絕**，除非加 `--allow-drop`；並確保有 `index.json` 目錄標記）。整個目錄可以原樣放上任何靜態主機，驗證端設 `VC_STATUS_URL` 即可。
  5. 清單到期前續簽（同內容、sequence +1）。過期的清單會讓**該簽發者**的寫入被拒。營運方以 `vc-status expiring --days 7`
     排程（cron）檢查目錄裡快到期的清單、通知簽發者；`ops/monitoring` 的 Worker 讀不到驗證端的本機目錄，不負責這一項。
  6. **停用撤銷**：簽發者不能直接把清單拿掉——看過清單的驗證端會判成 `STATUS_LIST_WITHHELD` 並拒絕寫入。正確做法是簽一份
     sequence +1 的空清單（`revoked: []`；`revokedBefore` 照舊，驗證端本來就只取最大值）並持續續簽。要真正移除，營運方必須在
     **每一台**驗證端同時刪掉該簽發者的清單檔與狀態紀錄——這等於忘記他過去的撤銷，只有在那些被撤銷的 VC 都已過了 `validUntil`
     （或鏈上 session 已撤銷）之後才安全。

前端的「一鍵撤銷」按鈕這一版沒有做（§8）。

### 4.7 設定

| 變數 | 預設 | 說明 |
|---|---|---|
| `VC_STATUS_URL` | （無） | 清單目錄的 http(s) base URL；設了就用 HTTP 來源（單次逾時 3 秒、不跟隨轉址、本文 ≤ 256 KB）。主機對缺檔**必須直接回 404**：回 403（例如 S3 沒開 ListBucket）或轉址都算狀態不明，沒發過清單的簽發者寫入會全被拒（審查 L3） |
| `VC_STATUS_DIR` | `agent/.state/vc-status` | 本機清單目錄；檔名 `<issuer 小寫>.json`；**必須**有 `index.json` 目錄標記（`vc-status init`），目錄不存在或沒有標記 → 狀態不明、寫入拒絕 |
| `VC_STATUS_STATE_PATH` | `agent/.state/vc-status-state.json` | 驗證端記憶 |
| `VC_STATUS_CACHE_MAX_AGE_SEC` | 60 | 快取新鮮度上限，最大 900 |
| `VC_STATUS_READ_POLICY` | `allow` | 唯讀動作遇到 unknown 的行為 |

沒有「關閉撤銷檢查」的開關。VC 閘本身仍可用 `AGENT_ALLOW_UNSIGNED_TRADES=true` 整個關掉（只限測試；既有設計，審查 I5），
那時不帶 VC，也就沒有撤銷檢查。

多副本部署（審查 L1）：驗證端狀態（高水位、sticky 撤銷、同號異文偵測）預設是單機檔案，各實例互不相通——實例 2 可能接受
實例 1 已拒絕的舊清單。多副本、serverless 或短暫磁碟部署時，必須在啟動時以 `setVcStatusStateStore(store)` 注入共享的
`StatusStateStore`（`get` 讀、`accept` 以 compare-and-set 寫，例如 Upstash）。本次只提供介面與檔案／記憶體實作；
預設檢查器建立時會在 stderr 印出來源與狀態儲存（含「單機」提示）。

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

### 7.1 信任假設：「有沒有清單」由主機／目錄管理者回答（審查 M2）

清單有簽章，主機**無法偽造或竄改**任何一份清單，也無法讓已撤銷的憑證在**看過**該清單的驗證端復活。
但主機（或本機目錄的管理者）**被信任回答「這個簽發者有沒有發佈清單」**：

- 對**從沒看過**某簽發者清單的驗證端——新上線的 agent、重建的容器、狀態檔遺失、新租戶、多副本中的另一台——
  主機只要回 404，該簽發者就被當成「沒有撤銷」，而且**沒有時間上限**（根本沒有舊清單會到期）。
- 對看過舊清單的驗證端，主機改送舊版會被 sequence 高水位擋下；不送則被判成扣住（`STATUS_LIST_WITHHELD`）。
  主機只能拖到舊清單到期（≤ 90 天，預設 30 天），之後一律拒絕寫入。
- 這一版擋掉的是**設定錯誤**造成的同類問題：目錄標記（本機與 HTTP）、HTTP 不跟隨轉址、只認直接回的 404。
  擋不掉的是**惡意或被入侵的主機／目錄管理者**。

考慮過、這一版**不採用**的補強：

| 做法 | 為什麼不在這一版 |
|---|---|
| VC 帶 `statusRequired`（或清單的承諾值），沒有清單就拒絕 | 要改 EIP-712 struct → v3，現有 v2 VC 全部要重簽；而且首張 VC 簽發時還沒有清單，「必須有清單」會讓所有新 VC 都先被拒 |
| 營運方簽署 `index.json`（列出有發佈清單的簽發者與其 sequence，附有效期） | 把信任從「主機」移到「營運方金鑰」，不是移除；需要新的營運方簽章金鑰類型（本任務限制不新增金鑰類型） |
| 鏈上撤銷登記（§6） | 今天不能部署；它是真正的解：鏈上狀態不能被扣住，「沒有撤銷」也可以被驗證 |

**結論**：在 §6 上線之前，撤銷清單主機與驗證端的清單目錄必須由營運方自己控管（同一個信任範圍），不能交給第三方 CDN 而不加監控；
最強、可立即生效的停止手段仍是鏈上 `revokeSession`。

### 7.2 其他

- **撤銷有延遲**：清單發佈後，最遲 `VC_STATUS_CACHE_MAX_AGE_SEC`（≤ 900 秒）生效；要立即生效仍用鏈上 `revokeSession`。
- **清單過期 → 該簽發者的開倉、平倉全被拒**：一旦發佈過清單，就要在到期前續簽（7 天前開始有預警，§4.4；營運方以
  `vc-status expiring` 排程檢查，§4.6）。這是 fail-closed 的直接後果。停用撤銷的正確步驟見 §4.6 第 6 點。
- **未初始化的清單目錄 → 所有寫入被拒**：新部署必須先跑 `vc-status init`（§4.6 第 0 點）。
- **狀態檔被刪除**：忘記高水位與 sticky 撤銷，該驗證端回到 §7.1 的「從沒看過」狀態。與 `vcNonce.ts` 的狀態檔是同一類風險。
- **單機狀態**：多副本必須注入共享 `StatusStateStore`（§4.7）。
- **「全部撤銷」的時鐘誤差**：`revokeAllCutoff` 涵蓋 ≤ 300 秒的時鐘偏快；偏快超過 300 秒的 VC 在簽出當下就會被 `VC_ISSUED_IN_FUTURE`
  拒絕，但幾分鐘後變成有效時不在撤銷範圍內。
- 清單會透露「某個簽發者撤銷過哪些 jti」。jti 是隨機值，不含 VC 內容；簽發者位址本來就公開在鏈上 session。

## 8. 沒做的事

- 前端撤銷 UI（SessionsPage 的按鈕）：schema 已放在前端可用的 `agentAuthStatus.ts`，UI 列後續。
- signal-api 狀態端點（§5）。
- 鏈上撤銷登記（§6）。
- 付款、開 session 目前不帶 VC，所以沒有接檢查點；檢查器已用 `action: "write"` 表達，將來直接套用。

## 9. 驗證紀錄（2026-10-02）

- `examples/vc-status.test.ts`：21 組（審查修正後；清單本身的 9 種拒絕、jti 對應、撤銷判斷、重放、同號異文、扣住、過期、
  快取新鮮度與 900 秒上限（注入時鐘）、來源不可達的寫入／唯讀行為、跨 process 狀態與壞檔、本機與 HTTP 來源、
  v1 舊憑證、write.ts 開倉與平倉、MCP 工具、tg-bot 與 vc-gate 預檢；審查修正加上：目錄標記（不存在／不符／被移除）、
  HTTP 不跟隨轉址（含真的 HTTP 伺服器 302→404）、403、本文大小上限、到期預警、`revokeAllCutoff`、共享狀態注入、
  `VC_STATUS_DIR` 打錯時開倉與平倉被拒、MCP 工具結果帶出預警）。
- `sdk/test/vcStatus.test.ts`：4 組（viem 簽 ↔ ethers 驗、無狀態判斷的六種拒絕、finalize 防呆、檢查器快取）。
- `frontend/src/contracts/agentAuthStatus.test.ts`：2 組（schema 簽驗、jti 正規化）。
- 全量（本機，Windows／Node 25）：agent `npm run typecheck`、`npm test`（含 `x402DefaultGolden.test.ts`、
  `x402-mock-e2e.ts`）、`bundle:check` 全部 exit 0；前端 `tsc --noEmit` exit 0、`yarn test` 68 個檔案 988 項全過。
  402 golden 未改；signal-api bundle 重打（`vcStatus.ts`、`agentAuthStatus.ts` 進入 import graph），指紋一起 commit。
