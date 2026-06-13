# Design Doc — x402 付費層 + AI Agent 自主交易整合

**專案：** PepeLab On-Chain CFD（NCCU Capstone 2026）
**狀態：** Draft v0.1（技術設計，尚未實作）
**作者：** Zuemen
**最後更新：** 2026-06

---

## 0. TL;DR

把這個永續型 CFD 協議從「人類用 MetaMask 點按鈕」升級成「AI agent 可以自主交易/跟單，
並用 x402 在 HTTP 層付費取得策略訊號與數據」。三層架構：

1. **x402 付費 API 層** — 把策略訊號、預言機數據、agent 跟單服務包成 HTTP 402 付費端點，
   用 USDC 在 Base 上結算。
2. **AI Agent 自主交易層** — LLM agent 監控鏈上 trader 績效 → 決策跟單/平倉 → 簽署交易。
3. **MCP Server 層** — 把協議包成 MCP tools，讓 Claude 這類 agent 直接操作 CFD 協議。

本文件先把架構、資料流、合約改動、安全邊界講清楚；實作分階段，先做 1 + 3 的 PoC。

---

## 1. 背景與動機

### 1.1 為什麼是現在

- x402 由 Coinbase 於 2025-05 開源，2026-04 捐給 Linux Foundation 旗下 x402 Foundation
  （Coinbase + Cloudflare 共治）。截至 2026-03 已在 Base 處理超過 1 億筆交易，協議零手續費。
- 支援鏈：Base、Ethereum、Arbitrum、Polygon、Solana。本專案選 **Base**（USDC 原生、費用低、
  x402 生態最成熟）。
- 與本專案契合點：CFD 協議天然產生「有價值的訊號」（trader 績效、策略、預言機數據），
  這些正是 AI agent 願意付費購買的東西。x402 提供 machine-native 的收費介面。

### 1.2 與既有架構的關係

現有合約已具備 agent 友善的基礎：

- `openPositionFor` / `closePositionFor` / `depositMarginFor` 已有 `copyTracker` 代理路徑，
  agent 跟單可沿用同一套授權模型，不需重寫核心。
- `StrategyRegistry` + `CopyTracker` 已把「策略發布 → 跟隨者鏡像」標準化，agent 只是另一種
  跟隨者。
- 上一輪安全修復（funding 自動結算、stale-price 保護、清算獎勵）讓「無人值守」的 agent
  操作變得安全 —— 這正是 agent 場景的前提。

---

## 2. 系統架構

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          AI Agent (買方 / Client)                          │
│  Claude / AgentKit / 自寫 LLM loop                                          │
│  ├─ 持有 Base 上的 agent 錢包 (CDP smart wallet 或 EOA)                      │
│  └─ 決策：監控績效 → 跟單/平倉 → 付費取得訊號                                  │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ (A) HTTP + x402                │ (C) MCP (JSON-RPC)
                │     PAYMENT-SIGNATURE          │     tool calls
                ▼                                ▼
┌──────────────────────────────┐   ┌──────────────────────────────────────┐
│   Signal API (Resource Srv)  │   │         MCP Server                    │
│   Express/Hono + x402 中介層  │   │   把協議包成 tools:                    │
│   GET /signals/:trader  402  │   │   - get_trader_performance            │
│   GET /oracle/:asset    402  │   │   - get_funding_rate                  │
│   POST /copy/quote      402  │   │   - open_position / close_position    │
│   └─ facilitator 驗證 USDC    │   │   - follow_strategy                   │
└──────────────┬───────────────┘   └──────────────┬───────────────────────┘
               │ 讀鏈上狀態 / 組交易               │ ethers.js → Base RPC
               ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              PepeLab CFD 合約 (Base Sepolia → Base mainnet)                 │
│  PerpetualExchange · CopyTracker · StrategyRegistry · FeeRouter            │
│  InsuranceVault · TraderStake · MockOracle(→ Chainlink/Pyth)               │
└──────────────────────────────────────────────────────────────────────────┘
               ▲
               │ (B) x402 facilitator 在鏈上結算 USDC (EIP-3009 transferWithAuthorization)
               └──────────────────────── Base USDC ─────────────────────────
```

三條資料流：
- **(A)** Agent 呼叫付費 API → 收到 402 → 簽 USDC 授權 → 重送 → 拿到訊號。
- **(B)** facilitator 把簽章在鏈上結算（USDC EIP-3009，一筆轉帳一個 round-trip）。
- **(C)** Agent 透過 MCP 直接呼叫協議的讀寫 tools（交易本身仍走鏈上）。

---

## 3. 元件設計

### 3.1 x402 付費 API 層（Resource Server）

技術選型：Node + Hono（或 Express）+ x402 官方中介層（`x402-hono` / `x402-express`）。
結算走 facilitator（自架或用 Coinbase CDP facilitator），免自己處理鏈上 ops。

付費端點規劃：

| 方法 + 路徑 | 賣什麼 | 定價（USDC） | 備註 |
|-------------|--------|--------------|------|
| `GET /signals/:trader` | 某 trader 的即時績效摘要 + 開倉建議 | 0.01 | 高頻、低單價 |
| `GET /oracle/:asset` | 聚合後的價格 + funding rate 快照 | 0.005 | 比直接讀鏈快、含衍生指標 |
| `POST /copy/quote` | 給定資金額度，回傳最佳跟單組合 | 0.05 | 含風險計算，較貴 |
| `GET /strategies/top` | 排行榜 + 鏈上驗證的歷史績效 | 0.02 | |

x402 流程（標準三步）：

1. Agent `GET /signals/0xabc...` → server 回 `402 Payment Required`，
   `PAYMENT-REQUIRED` 標頭含 `{ network: "base", asset: "USDC", amount, payTo, ... }`。
2. Agent 用錢包簽 USDC `transferWithAuthorization`（EIP-3009），把證明放進
   `PAYMENT-SIGNATURE` 標頭重送同一個請求。
3. Server 把證明交給 facilitator 驗證 + 結算，確認後回傳 200 + 訊號 JSON。

**收入流向**：付費端點的 `payTo` 指向協議金庫（或 `FeeRouter`），可把 x402 收入併入既有
70/20/10 分潤，讓 LP / trader / 協議共享 agent 經濟的收入。

### 3.2 AI Agent 自主交易層

Agent loop（虛擬碼）：

```
loop every N seconds:
    perf   = GET /strategies/top         # 付 0.02 USDC，拿鏈上驗證排行
    for trader in perf.top_k:
        quote = POST /copy/quote {budget} # 付 0.05 USDC，拿跟單建議
        if quote.expected_sharpe > threshold and risk_ok(quote):
            tx = build_follow_tx(quote)    # 走 CopyTracker.follow / openPositionFor
            sign_and_send(tx)              # agent 錢包簽名
    for pos in my_open_positions():
        if should_exit(pos):               # 績效轉差 / 風控觸發
            close(pos)                      # closePositionFor
```

授權模型（重要）：
- Agent **不該**直接持有使用者主錢包私鑰。建議用 **session key / smart wallet 委派**：
  使用者授權一把限額、限時、限合約的 session key 給 agent，agent 只能在額度內操作
  本協議的 `openPositionFor` / `closePositionFor`。
- 這對應現有的 `copyTracker` 授權路徑：把 agent 註冊為授權代理，沿用既有 `NotCopyTracker`
  防線，不需新增信任假設。

風控（agent 必須內建）：
- 單筆 / 總額度上限（session key 強制）。
- 只用 ≤ 某槓桿（合約已有 `MAX_LEVERAGE = 5` 硬上限兜底）。
- 開倉前讀 `getFundingRate` 與 `pendingFunding`，避免逆勢付高 funding。
- 讀 `oracle` 的 `isStale`，陳舊就不交易（合約端 `StalePrice` 已是最後防線）。

### 3.3 MCP Server 層

把協議包成 MCP tools，讓 Claude 這類 agent 直接操作（與你之前玩 `notebooklm-py` 的方向一致）。
x402 與 MCP 是天然搭配：MCP 負責 tool discovery，x402 負責 machine-to-machine 付費，
兩者組合不需互相感知。

規劃的 MCP tools：

| Tool | 型別 | 對應合約呼叫 |
|------|------|--------------|
| `get_trader_performance(trader)` | read | `StrategyRegistry` + 鏈上 PnL 聚合 |
| `get_funding_rate(asset)` | read | `PerpetualExchange.getFundingRate` |
| `get_position(id)` | read | `PerpetualExchange.getPosition` |
| `open_position(asset, isLong, margin, lev)` | write | `openPositionFor`（agent 代理） |
| `close_position(id)` | write | `closePositionFor` |
| `follow_strategy(id, budget)` | write | `CopyTracker.follow` |

付費版 tool 可在 MCP 回應裡回 402，agent 付費後才執行（Cloudflare 已有此 pattern 範例）。

---

## 4. 合約改動評估

好消息：**核心不需大改**，現有代理路徑可重用。需要的是小範圍增補：

| 改動 | 必要性 | 說明 |
|------|--------|------|
| Agent registry（多代理授權） | 中 | 現在 `copyTracker` 是單一地址。要支援多個 agent，需把單一地址改為 `mapping(address => bool) authorizedAgents` + onlyOwner 管理。**在現有 `NotCopyTracker` 結構內擴充，不新增方法語意**。 |
| Session-key / 限額 | 高（安全） | 建議在「代理合約 / smart wallet」層做，**不**汙染核心 `PerpetualExchange`。核心只認授權地址。 |
| Oracle → Chainlink/Pyth | 高（生產） | 上一輪已加 `maxPriceAge` 擋陳舊資料；接真預言機是 mainnet 前提。 |
| x402 收入接 FeeRouter | 低 | 純鏈下 server 把 `payTo` 設為 FeeRouter 即可，合約零改動。 |

> 設計原則延續：**修改時不新增新方法，在現有結構內調整**。多代理授權會沿用
> `copyTracker` 既有的 revert / event 慣例，而非另立一套。

---

## 5. 安全與信任邊界

| 風險 | 緩解 |
|------|------|
| Agent 私鑰外洩 → 盜用使用者資金 | session key 限額 + 限時 + 限合約；agent 永不持有主錢包私鑰 |
| 付費 API 被刷 / DoS | x402 本身即付費牆，每次呼叫先付費，天然抗刷 |
| Facilitator 信任 | 可自架 facilitator；或用 CDP，settlement 仍在鏈上可驗證 |
| Agent 在陳舊價格上亂交易 | 合約 `StalePrice` 兜底 + agent 端讀 `isStale` 雙重防線 |
| 跟單虧損 | 沿用 `TraderStake` slash（虧損 > 30% 罰質押） + `InsuranceVault` 兜底 |
| 重入 | 上一輪已全面 `nonReentrant` + CEI |

---

## 6. 實作階段規劃

**Phase 0（本文件）** — 技術設計 + 架構圖。✅

**Phase 1（PoC，建議先做）**
- x402 Signal API：1～2 個付費端點（`/signals/:trader`、`/oracle/:asset`），用 x402-hono +
  Base Sepolia testnet USDC。
- MCP server：先做 read-only tools（`get_trader_performance`、`get_funding_rate`）。
- Demo：一個腳本化 agent 付費讀訊號 → 印出決策（先不真的下單）。

**Phase 2（Agent 下單）**
- 核心加 `authorizedAgents` 多代理授權（在現有結構內擴充）。
- session-key 代理合約 / smart wallet。
- Agent 真的走 `openPositionFor` / `closePositionFor` 下單（限額）。

**Phase 3（生產化）**
- Oracle 接 Chainlink/Pyth on Base。
- x402 收入併入 FeeRouter 分潤。
- 完整 agent 風控 + 監控面板。

---

## 7. 對 Capstone / 履歷的敘事價值

- **時機**：x402 是 2025–2026 最熱的 agent 經濟敘事，剛進 Linux Foundation，履歷上具前瞻性。
- **完整性**：從鏈上合約（已強化安全）→ HTTP 付費層 → AI agent → MCP，串成完整 agent-native
  DeFi stack，正好落在 Web3 × AI × fintech 三者交集，貼合你的研究方向。
- **可 demo**：Phase 1 就能跑出「AI agent 付 0.01 USDC 買訊號並做決策」的端到端 demo。

---

## 8. 待你決定的開放問題

1. Phase 1 PoC 要先做哪一條？建議 **x402 Signal API（read-only）+ MCP read tools**，
   風險最低、最快看到 demo。
2. Agent 錢包用 **CDP smart wallet** 還是自管 EOA + session key？前者整合快，後者更可控。
3. 付費 API 要不要一開始就接 FeeRouter 分潤，還是先單純收進金庫？
