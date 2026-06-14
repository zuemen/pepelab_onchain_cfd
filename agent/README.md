# PepeLab Agent — x402 + AI Agent PoC

對應 `docs/DESIGN_x402_AI_AGENT.md`。Phase 1 = read-only 訊號層；Phase 2 加入
**經 `AgentSessionManager` session 限額的自主下單**（write path）。

四個 workspace：

| 目錄 | 角色 | 說明 |
|------|------|------|
| `shared/` | 共用層 | ethers v6 provider/signer、最小 ABI、鏈上聚合（`aggregate.ts`）與寫操作（`write.ts`）。合約位址從 `frontend/src/contracts/addresses.ts` 讀取（**不寫死**）。 |
| `signal-api/` | x402 付費 API | Hono + `x402-hono`。`GET /signals/:trader`(0.01 USDC)、`GET /oracle/:asset`(0.005 USDC)。 |
| `mcp-server/` | MCP tools | read：`get_trader_performance` / `get_funding_rate` / `get_position` / `get_session`；write：`open_position` / `close_position`（經 session 限額）。 |
| `demo-agent/` | 腳本化 agent | 自管 EOA 付 x402 → 讀訊號 → **依決策經 session 真下單**（缺 session 時退化成印「本來會下的單」）。 |

## 架構重點（Phase 4：全程 Base Sepolia 同鏈）

- **合約讀取**走 **Base Sepolia**（chainId 84532），位址見 `addresses.ts` 的 `BASE_SEPOLIA` 區塊。
- **x402 USDC 結算**也走 **Base Sepolia**——與合約**同一條鏈**。
- **收款 `payTo`** 預設指向 `addresses.ts` 的 Base Sepolia **FeeRouter**（x402 收入接 70/20/10 分潤）。

> ✅ **跨鏈 caveat 已解**：協議已部署到 Base Sepolia，FeeRouter 與 x402 USDC 結算同鏈，
> `routeExternalRevenue` 70/20/10 分潤直接同鏈完成，不再需要把 `PAY_TO` 改成他鏈地址。
> （要回退到舊的 Ethereum Sepolia 部署：設 `AGENT_CHAIN_ID=11155111` + `SEPOLIA_RPC_URL`。）

## 啟動

```bash
cd agent
cp .env.example .env          # 填入 SEPOLIA_RPC_URL、AGENT_PRIVATE_KEY 等
npm install                   # 安裝所有 workspace 依賴

# 終端機 1：啟動 x402 付費 API
npm run signal-api            # → http://localhost:4021

# 終端機 2：跑 demo agent（付費讀訊號 → 印出決策）
npm run demo-agent
```

### 不付費也能先看
免費端點列出定價表與設定，不需錢包：
```bash
curl http://localhost:4021/
curl http://localhost:4021/revenue   # x402 收入歸屬 + 70/20/10 分潤帳務
```
`demo-agent` 在未提供有效 `AGENT_PRIVATE_KEY` 時，會自動退化成只打免費端點並提示。

## x402 收入 → FeeRouter 70/20/10 分潤

每筆付費呼叫由 `revenue.ts` 按 FeeRouter 的 **70 / 20 / 10**（trader / platform / vault）
歸屬：`/signals/:trader` 的 70% 歸**該 trader**（agent 買誰的訊號、誰賺），`/oracle/:asset`
歸 protocol。`GET /revenue` 可查總額、各方累計與每個 beneficiary 的 70% 累計。

### 真上鏈分潤（已實作）

FeeRouter 新增了 permissionless 入口 `routeExternalRevenue(address trader, uint256 fee)`
（pull USDC → 既有 `_split` 70/20/10），讓 x402 收入能**真的上鏈**走分潤、70% 記到該
trader 的 `traderEarnings`（之後可 `withdrawTraderEarnings` 提領）。

啟用：在 `.env` 設 `FEE_SETTLEMENT_PRIVATE_KEY`（Base Sepolia 上、持少量 ETH 的測試
金鑰）。每筆 `/signals/:trader` 付費後，server 會 fire-and-forget 呼叫
`routeExternalRevenue`（mUSDC 不足會自動 mint、未授權會自動 approve），結果寫回帳務，
`GET /revenue` 的 `settledOnChain` 與每筆 `settlement.tx` 可見。未設金鑰則僅保留鏈下帳務。

> ✅ Phase 4 起 x402 收款與 FeeRouter 結算**同在 Base Sepolia**：收款進 payTo（= FeeRouter），
> server 以 treasury 在同鏈做 70/20/10 結算，金流合一、不再跨鏈。合約端由
> `FeeRouterExternalRevenue.t.sol` 6 個測試覆蓋。

## 「付費 → 自主下單」一鍵 demo（北極星）

```bash
# 0) 一次性：部署合約並把 Deploy 印出的 AgentSessionMgr 填到 .env
#    使用者再呼叫 AgentSessionManager.createSession 建一個有界 session，記下 sessionId。
# 1) .env 補三項，啟用真下單：
#    AGENT_PRIVATE_KEY=0x...            # session key（自管 EOA）
#    SESSION_MANAGER_ADDRESS=0x...      # Deploy 印出的 AgentSessionMgr
#    DEMO_SESSION_ID=0                  # createSession 得到的 id
# 2) 跑：
npm run signal-api            # 終端機 1
npm run demo-agent            # 終端機 2：付 x402 讀訊號 → 經 session 開一筆受限部位
```

流程：付費讀 `/oracle` 與 `/signals/:trader` → 決策引擎挑出第一筆順風且淨 PnL≥0 的腿
→ 經 `AgentSessionManager.openPositionForSession` 在 **per-trade cap / budget /
maxLeverage / expiry** 限額內開倉 → 印出 **tx hash 與 positionId**。任一前置缺失
（無 key / 無 session 位址 / 無 sessionId）即優雅退化成只讀，印「本來會下的單」、不 crash。

## MCP server（給 Claude 等 agent）

```bash
npm run mcp-server            # stdio transport
```
在 MCP client 設定中以 `tsx agent/mcp-server/src/index.ts` 啟動。

**read tools**：`get_trader_performance` / `get_funding_rate` / `get_position` /
`get_session`（唯讀，免金鑰）。

**write tools**（Phase 2）：`open_position` / `close_position`，全部經
`AgentSessionManager.openPositionForSession` / `closePositionForSession`，受 session
限額約束。需 `AGENT_PRIVATE_KEY`（session key）+ `SESSION_MANAGER_ADDRESS`；缺任一時
tool 回明確錯誤、不 crash。輸入含 `sessionId`，agent 永不持有使用者主錢包私鑰。

## 型別檢查

```bash
npm run typecheck             # tsc --noEmit（涵蓋所有 workspace）
```

## 環境變數

見 `.env.example`。關鍵項：

| 變數 | 用途 |
|------|------|
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC（讀合約狀態 + x402 結算同鏈） |
| `X402_NETWORK` | x402 結算網路，預設 `base-sepolia` |
| `X402_FACILITATOR_URL` | x402 facilitator，預設 `https://x402.org/facilitator` |
| `PAY_TO` | 收款地址；留空則回退到 FeeRouter |
| `AGENT_PRIVATE_KEY` | demo agent 自管 EOA / session key（付 x402 費用 + 經 session 下單，僅限測試錢包） |
| `SESSION_MANAGER_ADDRESS` | `AgentSessionManager` 位址（Deploy 印出；啟用 write path） |
| `DEMO_SESSION_ID` | demo agent 下單用的 session id（`createSession` 取得） |
| `DEMO_MARGIN` | 每筆下單保證金（USDC，預設 10） |
