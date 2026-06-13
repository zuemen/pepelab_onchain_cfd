# PepeLab Agent — x402 + AI Agent Phase 1 PoC

對應 `docs/DESIGN_x402_AI_AGENT.md` 第 6 節 Phase 1。**全部 read-only，先不真下單。**

三個 workspace：

| 目錄 | 角色 | 說明 |
|------|------|------|
| `shared/` | 共用層 | ethers v6 provider、最小 read-only ABI、鏈上聚合邏輯。合約位址從 `frontend/src/contracts/addresses.ts` 讀取（**不寫死**）。 |
| `signal-api/` | x402 付費 API | Hono + `x402-hono`。`GET /signals/:trader`(0.01 USDC)、`GET /oracle/:asset`(0.005 USDC)。 |
| `mcp-server/` | MCP read tools | `get_trader_performance` / `get_funding_rate` / `get_position`（stdio）。 |
| `demo-agent/` | 腳本化 agent | 自管 EOA 付 x402 → 讀訊號 → 印出決策（不下單）。 |

## 架構重點

- **合約讀取**走 **Ethereum Sepolia**（chainId 11155111），位址見 `addresses.ts` 的 `SEPOLIA` 區塊。
- **x402 USDC 結算**走 **Base Sepolia**（設計如此：HTTP 付費層與合約鏈分離）。
- **收款 `payTo`** 預設指向 `addresses.ts` 的 **FeeRouter**（專案決策：x402 收入接 70/20/10 分潤）。

> ⚠️ **跨鏈 caveat**：FeeRouter 部署在 Ethereum Sepolia，Base Sepolia 上未同址部署。
> 若要在 Base Sepolia 真的收到 USDC，請把 `.env` 的 `PAY_TO` 改成你在 Base Sepolia
> 控制的地址，或先把 FeeRouter 部署到 Base。Phase 1 demo 預設沿用 FeeRouter 位址以對齊架構。

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

> ⚠️ **目前是鏈下帳務，尚未真的上鏈分潤**。原因：FeeRouter 的拆分入口
> `distributeCopyFee` / `receivePerformanceFee` 是 `onlyAuthorized`（限 copyTracker /
> exchange）且從 `msg.sender` pull USDC，server 無法直接呼叫；加上 x402 在 Base
> Sepolia 結算、FeeRouter 在 Ethereum Sepolia，跨鏈也擋住「raw 轉帳即分潤」。
> 要真正上鏈結算，需 FeeRouter 新增一個 permissionless 入口（例如
> `routeExternalRevenue(address trader, uint256 fee)` → `transferFrom` + 既有 `_split`），
> 這會「新增方法」，需先拍板再做。`payTo` 已預設指向 FeeRouter，待該入口就緒即可串接。

## MCP server（給 Claude 等 agent）

```bash
npm run mcp-server            # stdio transport
```
在 MCP client 設定中以 `tsx agent/mcp-server/src/index.ts` 啟動，提供三個 read-only tools。

## 型別檢查

```bash
npm run typecheck             # tsc --noEmit（涵蓋所有 workspace）
```

## 環境變數

見 `.env.example`。關鍵項：

| 變數 | 用途 |
|------|------|
| `SEPOLIA_RPC_URL` | Ethereum Sepolia RPC（讀合約狀態） |
| `X402_NETWORK` | x402 結算網路，預設 `base-sepolia` |
| `X402_FACILITATOR_URL` | x402 facilitator，預設 `https://x402.org/facilitator` |
| `PAY_TO` | 收款地址；留空則回退到 FeeRouter |
| `AGENT_PRIVATE_KEY` | demo agent 自管 EOA（付 x402 費用，僅限測試錢包） |
