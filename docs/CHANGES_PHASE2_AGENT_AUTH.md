# Patch Changes — Phase 2 Step 1: Multi-Agent Authorization (2026-06)

對應 `docs/DESIGN_x402_AI_AGENT.md` 第 4 節「合約改動評估 — Agent registry（多代理授權）」。
在現有 `copyTracker` / `NotCopyTracker` 結構內擴充，讓多個 agent 能呼叫 `*For` 代理進入點，
**不新增業務方法語意、沿用既有 revert/event 慣例**。

**測試基準**：215 → 225（多代理授權）→ **239 passed, 0 failed**（再加 session 委派層 14 個）。

本文件含兩步：**Step 1** 核心多代理授權、**Step 2** session-key 委派代理層。

---

## 改動（`contracts/src/PerpetualExchange.sol`）

1. **新增狀態** `mapping(address => bool) public authorizedAgents`。
   `copyTracker` 保留為「主要 agent」，向後相容。

2. **`setCopyTracker` 與 mapping 同步**：設定新主 tracker 時，自動把舊主 de-authorize、
   新主 authorize（保留「單一主 tracker swap」的既有語意），並各 emit 一筆事件。

3. **新增 `setAgentAuthorized(address agent, bool authorized) onlyOwner`**：授權／撤銷
   主 tracker 以外的額外 agent。純基礎設施，不改變 `*For` 的業務行為。

4. **三處授權檢查改用 mapping**：`depositMarginFor` / `openPositionFor` / `closePositionFor`
   由 `if (msg.sender != copyTracker)` 改為 `if (!authorizedAgents[msg.sender])`，
   沿用同一個 `NotCopyTracker` error。`openPositionFor` 的 `CopyTrackerNotSet` 前置守衛
   保持不變（未設主 tracker 仍回原 error，既有測試不破）。

5. **新增事件** `AgentAuthorizationSet(address indexed agent, bool authorized)`。

ABI 影響：`frontend/src/contracts/abi/PerpetualExchange.json` 已同步（+`authorizedAgents`
getter、`setAgentAuthorized`、`AgentAuthorizationSet`）。

---

## 新增測試（`contracts/test/AgentAuthorization.t.sol`，10 個）

| 測試 | 驗證 |
|------|------|
| `test_setAgentAuthorized_onlyOwner` | 非 owner 不能授權 |
| `test_setAgentAuthorized_emitsEvent` | 授權 emit 事件 + mapping 生效 |
| `test_setCopyTracker_authorizesPrimary` | 設主 tracker 同時授權 |
| `test_setCopyTracker_deauthorizesPrevious` | 換主 tracker 時舊主被撤權 |
| `test_authorizedAgent_canOpenPositionFor` | 額外 agent 可代開倉 |
| `test_authorizedAgent_canDepositMarginFor` | 額外 agent 可代存保證金 |
| `test_authorizedAgent_canClosePositionFor` | 額外 agent 可代平倉 |
| `test_unauthorizedAgent_cannotOpenPositionFor` | 未授權 → `NotCopyTracker` |
| `test_revokedAgent_cannotOpenPositionFor` | 撤權後 → `NotCopyTracker` |
| `test_deauthorizedPrimary_cannotOpenPositionFor` | 被換掉的舊主 → `NotCopyTracker` |

---

## Step 2 — session-key 委派代理層（`contracts/src/AgentSessionManager.sol`）

採**自寫限額委派合約**（非 ERC-4337）：輕、可完整 Foundry 測試、直接接上 Step 1 的
授權路徑。**刻意不汙染核心**——此合約自己被註冊成 exchange 的 `authorizedAgent`，
在呼叫 `openPositionFor` / `closePositionFor` 前強制檢查 session 限制；**agent 永不持有
使用者主錢包私鑰**，且只能操作本協議的 `*For` 進入點（限合約）。

機制：
- 使用者 `createSession(agent, maxMarginPerTrade, totalMarginBudget, maxLeverage, expiry)`
  授權一把有界 session 給 agent key。
- agent 用 session key 呼叫 `openPositionForSession` / `closePositionForSession`，
  合約檢查：呼叫者為該 session 的 agent、未撤銷、未過期、單筆 ≤ per-trade cap、
  累計 ≤ budget、leverage ≤ session cap；通過才代呼叫 exchange（CEI：先記 spend 再外呼）。
- 平倉前用 `getPosition` 驗證該倉位屬於 session 的 user（限合約 + 限對象）。
- 使用者可隨時 `revokeSession`。

部署接線：`script/Deploy.s.sol` 部署 `AgentSessionManager` 並
`exchange.setAgentAuthorized(address(sessionManager), true)`。ABI 置於
`frontend/src/contracts/abi/AgentSessionManager.json`（前端尚未消費；位址待 deploy 腳本
輸出，未來接前端時再併入 `addresses.ts`）。

新增測試（`contracts/test/AgentSessionManager.t.sol`，14 個）：createSession 驗證、
限額內開/平倉、per-trade / budget / leverage 三種上限、非 agent / 過期 / 撤銷 / 跨用戶
倉位拒絕、未授權 manager 仍被 exchange 的 `NotCopyTracker` 擋下。

---

## 尚未處理（Phase 3）

- 預言機接 Chainlink / Pyth（目前 mock，`maxPriceAge` 已擋陳舊）。
- x402 收入併入 FeeRouter（server `payTo` 已指向 FeeRouter，合約零改動）。
- 前端接 `AgentSessionManager`（建立/撤銷 session 的 UI）+ 完整 agent 風控監控面板。
