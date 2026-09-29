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

啟用：在 `.env` 設 `FEE_SETTLEMENT_PRIVATE_KEY`，server 每筆 `/signals/:trader` 付費後
fire-and-forget 呼叫 `routeExternalRevenue`（餘額不足且不可 mint 時回明確錯誤、不擋回應），
結果寫回帳務，`GET /revenue` 的 `settledOnChain` 與每筆 `settlement.tx` 可見。

### 付款幣別 vs 保證金幣別（A0 設計）

x402 在 Base Sepolia 結算的是 **Circle 官方測試 USDC（6-dec, EIP-3009）**
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`，而永續引擎的保證金用 **MockUSDC（18-dec,
可自助 mint）**——兩者**用途分離**：

| 用途 | Token | 為何 |
|------|-------|------|
| x402 付費 + 70/20/10 分潤 | 官方 USDC（6-dec） | facilitator 只認官方 USDC（EIP-3009 簽章） |
| 永續部位保證金 | MockUSDC（18-dec） | demo 可自助鑄幣，免 faucet 限額 |

因 `FeeRouter.usdc` 為 immutable，已部署（綁 MockUSDC）的 FeeRouter 不能改幣別，故
**另部署一組 x402 專用 `FeeRouter`+`InsuranceVault`（綁官方 USDC）** 做真結算：

```bash
# 1) 部署 x402 收入分潤路由（官方 USDC）
cd contracts
forge script script/DeployX402Router.s.sol:DeployX402Router \
  --rpc-url base_sepolia --broadcast --verify
# 2) 把印出的 X402_FeeRouter 填進 agent/.env 的 X402_FEE_ROUTER
# 3) PAY_TO 設為 treasury EOA（= FEE_SETTLEMENT 帳戶地址），領官方 USDC + ETH
```

流程：agent x402 付官方 USDC → `PAY_TO`(treasury EOA) → `settlement.ts`（同帳戶）approve +
`routeExternalRevenue` 在官方 USDC 上走 70/20/10，70% 記入該 trader 的 `traderEarnings`。
合約端：`FeeRouterExternalRevenue.t.sol`（18-dec）+ `FeeRouterX402Usdc.t.sol`（6-dec）共覆蓋。
未設 `X402_FEE_ROUTER` 則回退到 MockUSDC FeeRouter（舊行為）。

### 結算 worker 只在 CI 內執行

`signal-api/src/settlement-worker.ts` **只准在 GitHub Actions 內執行**（`x402-settlement-worker.yml`；
沒有 `GITHUB_ACTIONS=true` 就拒跑、非零結束）。理由：CI job 有 20 分鐘 timeout，租約鎖
`x402:settlement:lock`（1500 秒）不會在途中過期；本機 process 可以跑任意久，鎖一過期，CI 的 worker
就能同時進來，兩邊一起送交易就是雙付。本機只能用只讀模式檢視佇列（不取鎖、不佔位、不簽章）：

```bash
cd agent && npx tsx signal-api/src/settlement-worker.ts --dry-run
```

> ⚠ `GITHUB_ACTIONS` 檢查只是**減速帶，不是安全邊界**——任何人都能在本機設這個環境變數。
> 真正的邊界是：`FEE_SETTLEMENT_PRIVATE_KEY` **只存在 GitHub secrets**（本機與其他環境都不該有這把
> 金鑰），加上 workflow 的 `concurrency` group 與 Redis 租約鎖。沒有金鑰的地方跑不了真正的結算。

### 結算交易卡住（STUCK / nonce 不一致）怎麼處理

worker 每一筆 `routeExternalRevenue` 都是「先簽、先把 hash / nonce / 已簽 raw tx 寫進
`settle:<冪等鍵>`、再廣播」，而且**絕不自動重送**。會停下來交給人的情況：

- log 出現 `signer 有未上鏈的交易（nonce latest=L pending=P）`：mempool 裡有這個 signer
  還沒上鏈的交易，worker 不會再送新交易；連續超過 30 分鐘（`x402:settlement:blocked_since`）
  job 會變紅。
- log 出現 `nonce 查詢失敗（RPC）`：這是 RPC 問題、不是交易卡住，另外計時
  （`x402:settlement:nonce_rpc_since`），連續超過 30 分鐘 job 變紅；請檢查 RPC 供應商。
- 另外，worker 啟動時會取 Redis 租約鎖 `x402:settlement:lock`（1500 秒）；取不到代表另一個
  worker 還在跑，這一輪什麼都不做（exit 0）。
- trader 安全檢查連續查不到資料（RPC）超過 30 分鐘（`x402:settlement:nodata_since`）→ job 變紅。
- log 出現 `::error::STUCK … tx=0x… nonce=N`：簽出超過 30 分鐘仍查不到 receipt，該筆已移進
  `x402:settlement:dead`，`settle:<鍵>` 標成 `STUCK`，並設定**全域停機旗標**
  `x402:settlement:halt`（不設 TTL，值記錄原因、鍵、hash、nonce、時間）。旗標存在時每一輪都
  `::error::` 並 exit 1、不處理任何項目，直到人工清除。

處理步驟（`$RPC` 用 Base Sepolia RPC、`$SIGNER` 是結算 signer 地址；需要 Upstash REST 權限）：

1. 讀出卡住那筆的狀態：`curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
   "$UPSTASH_REDIS_REST_URL/get/settle:<鍵>"`，取得 `txHash`、`nonce`、`rawTx`。
2. 確認鏈上狀態：`cast receipt <txHash> --rpc-url $RPC`（有 receipt 就不是卡住，下一輪會自動對帳），
   `cast nonce $SIGNER --rpc-url $RPC`（latest）與 `cast nonce $SIGNER --block pending --rpc-url $RPC`。
3. 二選一，**兩者都用同一個 nonce N**，所以最多只會有一筆上鏈：
   - **讓原交易上鏈**：`cast publish <rawTx> --rpc-url $RPC` 重播（節點丟掉時有用）；若是 gas 太低，
     只能改走下一個選項。
   - **取消**：送一筆同 nonce、較高手續費、0 value 給自己的交易：
     `cast send $SIGNER --value 0 --nonce N --priority-gas-price <高於原交易> --gas-price <高於原交易>
     --rpc-url $RPC --private-key "$FEE_SETTLEMENT_PRIVATE_KEY"`（在持有金鑰的環境執行，不要貼到聊天或 log）。
4. 等它上鏈後：
   - 原交易上鏈了 → **不要** `DEL settle:<鍵>`。把 `settle:<鍵>` 的 `status` 改回 `UNKNOWN`
     （保留 txHash / nonce），再把 dead 裡那筆搬回佇列（`RPUSH x402:settlement:queue <項目>`，
     然後 `LREM x402:settlement:dead 1 <項目>`）；下一輪對帳會標成 DONE，不會重送。
   - 取消成功（原交易永遠不會上鏈）→ `DEL settle:<鍵>`，再用同樣方式把 dead 裡那筆搬回佇列，
     下一輪會重新結算一次。
   - worker **不會**自己依 nonce 推論「原交易已被替換」而重新結算（公共節點會回落後狀態，
     猜錯就是雙付）；尚未標 STUCK 的 UNKNOWN 也一樣，只會等到 30 分鐘後轉 STUCK。取消後請照上面
     的步驟處理，`settle:<鍵>` 裡的 txHash / nonce / rawTx 在確認前不要刪。
5. **halt 期間超過 90 天**（`settle:<鍵>` 冪等狀態的 TTL）：狀態可能已過期消失。清除旗標**之前**，
   先把 `x402:settlement:unconfirmed` 裡的每一筆逐一到 explorer 確認並手動處理（已上鏈的移除、
   確定未上鏈的才搬回佇列）。worker 對「unconfirmed 裡缺少狀態的項目」一律送進死信、不重新結算，
   但 processing / dead 裡的舊項目沒有這層保護，所以一樣要先人工處理。
6. **清除全域停機旗標**（最後一步）。⚠ **清除前必須先確認原交易的最終狀態**：到 explorer
   （`https://sepolia.basescan.org/tx/<txHash>`）查 hash，並確認同一個 nonce 上最終上鏈的是哪一筆；
   第 4 步的 Redis 狀態也要照這個結果改好。**沒確認就清除，worker 可能把同一筆分潤再送一次（雙付）。**
   確認後：`curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
   "$UPSTASH_REDIS_REST_URL/del/x402:settlement:halt"`。先用 `--dry-run` 看一次佇列與各鍵的狀態再清。

## 「付費 → 自主下單」一鍵 demo（北極星）

```bash
# 0) 一次性：部署合約並把 Deploy 印出的 AgentSessionMgr 填到 .env
#    使用者再呼叫 AgentSessionManager.createSession 建一個有界 session，記下 sessionId。
# 1) .env 補三項，啟用真下單：
#    AGENT_PRIVATE_KEY=0x...            # session key（自管 EOA）
#    SESSION_MANAGER_ADDRESS=0x...      # Deploy 印出的 AgentSessionMgr
#    DEMO_SESSION_ID=0                  # 新 manager 上的 session（到 2027-07）
# 2) 跑：
npm run signal-api            # 終端機 1
npm run demo-agent            # 終端機 2：付 x402 讀訊號 → 經 session 開一筆受限部位
```

流程：付費讀 `/oracle` 與 `/signals/:trader` → 決策引擎挑出第一筆順風且淨 PnL≥0 的腿
→ 經 `AgentSessionManager.openPositionForSession` 在 **per-trade cap / budget /
maxLeverage / expiry** 限額內開倉 → 印出 **tx hash 與 positionId**。任一前置缺失
（無 key / 無 session 位址 / 無 sessionId）即優雅退化成只讀，印「本來會下的單」、不 crash。

## 公開部署到 Vercel（agent-native commerce）

把付費 API 公開上線，讓**任何外部 agent/CLI 帶自己的錢包付費購買**（端點即商品）。

- 入口：`signal-api/api/index.ts`（`hono/vercel` 把 `src/app.ts` 的 `createApp()` 包成 serverless handler；端點邏輯與本機完全共用）。
- serverless 調整：x402 結算（`routeExternalRevenue`）在**回應前 await**並把 `settlementTx` 一起回傳（serverless 沒有「回應後背景跑」）；`/revenue` 改**直接讀鏈上** X402 FeeRouter 累計（in-memory 帳務每次 invocation 歸零）。
- CORS 對 GET 開放（瀏覽器 demo + 外部 agent 皆可）。

**在 Vercel 建 signal-api 專案**（我準備好 `vercel.json`，你操作）：
1. New Project → 指向此 repo，**Root Directory = `agent/signal-api`**。
2. Environment Variables（**不要 commit**）：
   `BASE_SEPOLIA_RPC_URL`、`X402_NETWORK=base-sepolia`、`X402_FACILITATOR_URL=https://x402.org/facilitator`、
   `X402_SETTLEMENT_TOKEN=0x036CbD…CF7e`、`X402_FEE_ROUTER=0x29e5732A…B57d`、
   `PAY_TO=<FEE_SETTLEMENT_PRIVATE_KEY 的 EOA 地址>`（**不可**用 Safe／合約，**不可**用 2026-08-06 稽核的外洩
   deployer `0xE80A…Eb93`——它已被 EIP-7702 sweeper 接管，signal-api 會回 503 `payto_unsafe`）、
   `FEE_SETTLEMENT_PRIVATE_KEY=0x…`（新產生的測試金鑰，僅放極少量）、`ORACLE_BENEFICIARY_ADDRESS`（/oracle 收入 70% 歸屬）。
3. Deploy。`vercel.json` 已設 `installCommand: cd .. && npm install`（在 `agent/` 跑、建 `@pepelab/shared` workspace symlink）+ rewrite 全路徑到 function、`api/index.ts` 走 `@vercel/node`（Node runtime）。

> **function 是預打包的自包 ESM**：`src/vercel-entry.ts` 經 `npm run bundle:vercel`（esbuild，
> `build-vercel.mjs`）內聯 handler + `@pepelab/shared` + 所有依賴成單一 ESM `api/index.js`，
> **已 commit 進 repo**（Vercel 的 function 偵測在 build 前掃 git，產物必須已存在）。改了 signal-api
> 原始碼後請重跑 `bundle:vercel` 並 commit 更新後的 `api/index.js`。執行期不需編譯／解析 `.ts`。
> 註：`copyTracker/exchange` 在 x402 router 上為 address(0)（DeployX402Router 不接線），故
> `/revenue` 的 `platformEarnings` 是純 x402 收入。

**前端**：另建一個 Vercel 專案（Root = `frontend`），設 `VITE_SIGNAL_API_URL=https://<signal-api>.vercel.app`。

## 外部 agent 自帶錢包付費（CLI 直接購買）

`examples/buy-signal.ts` 只依賴 **viem + x402-fetch**（不依賴本 monorepo），任何人複製即可跑：

```bash
export X402_API_URL=https://<your-signal-api>.vercel.app   # 或 http://localhost:4021
export AGENT_PRIVATE_KEY=0x...    # 持 Base Sepolia 官方 USDC + 一點 ETH
npx tsx examples/buy-signal.ts
```
流程：探索 `/` →（付費端點）402（accepts: network/asset/payTo/price）→ 官方 USDC 簽 EIP-3009 → 重送帶 `X-PAYMENT` → 200 + 訊號 + `settlementTx`。

## 訪客試買（免錢包）

`POST /demo/buy-signal`：免費 demo，**不付款、不結算**——只回真實訊號；`settlementTx` 永遠為空（在請求內上鏈會讓 serverless 逾時，見 `app.ts` 該路由註解）。真實 70/20/10 分潤只來自付費 x402 端點，累計見 `/revenue`。前端 `/x402` 文件頁接這支（含簡易速率限制 `DEMO_COOLDOWN_MS`，預設 15s/IP）。

> ⚠️ **安全**：`FEE_SETTLEMENT_PRIVATE_KEY` 放公開 serverless = 視為**半公開測試金鑰**，只放極少量測試資產，絕不重用到任何有價值錢包。capstone 後若上 mainnet，改用受控 signer / KMS。x402 付費牆本身天然抗刷；`/demo/buy-signal` 額外加速率限制。

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
| `PAY_TO` | 收款地址；**必須**是 `FEE_SETTLEMENT_PRIVATE_KEY` 的 EOA。外洩清單／EIP-7702 委派／合約（含留空時回退的 FeeRouter）一律 503 `payto_unsafe`，不發 402 |
| `ORACLE_BENEFICIARY_ADDRESS` | `/oracle` 收入 70% 的受益人；未設則該筆收入不排入分潤 |
| `AGENT_PRIVATE_KEY` | demo agent 自管 EOA / session key（付 x402 費用 + 經 session 下單，僅限測試錢包） |
| `SESSION_MANAGER_ADDRESS` | `AgentSessionManager` 位址（Deploy 印出；啟用 write path） |
| `DEMO_SESSION_ID` | demo agent 下單用的 session id（`createSession` 取得） |
| `DEMO_MARGIN` | 每筆下單保證金（USDC，預設 10） |
