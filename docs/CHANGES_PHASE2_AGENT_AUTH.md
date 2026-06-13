# Patch Changes — Phase 2 Step 1: Multi-Agent Authorization (2026-06)

對應 `docs/DESIGN_x402_AI_AGENT.md` 第 4 節「合約改動評估 — Agent registry（多代理授權）」。
在現有 `copyTracker` / `NotCopyTracker` 結構內擴充，讓多個 agent 能呼叫 `*For` 代理進入點，
**不新增業務方法語意、沿用既有 revert/event 慣例**。

**測試基準**：215 → **225 passed, 0 failed**（新增 `AgentAuthorization.t.sol` 10 個）。

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

## 尚未處理（Phase 2 剩餘）

- **session-key / smart-wallet 代理層**（限額、限時、限合約）：依設計屬鏈下代理合約 /
  smart wallet 層，**刻意不汙染核心** `PerpetualExchange`——核心只認授權地址。
  此層需先決定方案（ERC-4337 smart wallet vs. 自寫限額委派合約），待拍板再實作。
- agent 經此代理層在限額內走 `openPositionFor` / `closePositionFor` 真下單。
