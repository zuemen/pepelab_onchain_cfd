# x402-loop — 完全自主的 x402 交易迴圈

agent 每隔一段時間對一組資產各跑一次決策：**x402 付費買決策級資料 → 自己判斷 long/short/skip → 該進才經 session #6 下單**。同資產「已有未平倉部位」或「冷卻期內已開過」會自動跳過，避免堆倉。

```bash
cd agent
# .env 需：X402_API_URL, AGENT_PRIVATE_KEY(持官方 USDC + ETH), BASE_SEPOLIA_RPC_URL,
#          SESSION_MANAGER_ADDRESS, DEMO_SESSION_ID=6
# 可調：ASSETS=sBTC,sETH ・ INTERVAL_MIN=15 ・ COOLDOWN_MIN=30 ・ LOOP_MARGIN=50 ・ LOOP_LEVERAGE=3
npx tsx examples/x402-loop.ts
```

決策政策（透明、可調）見 `x402-autonomous.ts` 頂部常數與 `aggregate.ts` 的 `EDGE_DEFAULTS`/`computeEdge`。

## 四種掛法（完全自主）
1. **node 常駐**：`npx tsx examples/x402-loop.ts`（程式自身已有 INTERVAL 迴圈）。
2. **pm2**：`pm2 start "npx tsx examples/x402-loop.ts" --name x402-loop`（斷線自動重啟）。
3. **系統 cron**：把 INTERVAL 交給 cron、每次只跑單一資產一輪 —— 用 `x402-autonomous.ts`：
   ```cron
   */15 * * * * cd /path/agent && /usr/bin/npx tsx examples/x402-autonomous.ts sBTC 50 3 >> /tmp/x402.log 2>&1
   ```
4. **GitHub Actions 定時**：`on: schedule: - cron: "*/15 * * * *"`，step 跑 `npx tsx examples/x402-autonomous.ts sBTC 50 3`，金鑰放 repo secrets（`AGENT_PRIVATE_KEY` 等）。

## 限制
- x402 付款用**官方 Base Sepolia USDC**（Circle, EIP-3009）—— 錢包要有官方 USDC + 一點 ETH。下單保證金是 session.user 存的模擬 USDT。
- 加密 sBTC/sETH 免 KYC；RWA 需先 KYC 否則開倉 revert。
- session #6 到期 2027-06-22（單筆≤50/預算1000/槓桿≤5）；`.env` 設 `DEMO_SESSION_ID=6`。
