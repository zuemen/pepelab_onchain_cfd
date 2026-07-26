# x402-autotrade — 真正用到 x402 的自主交易 agent

證明 **x402 不是擺著沒用的側功能**：agent 先付官方 USDC 向公開 API 買資料（x402，402→簽 EIP-3009→200）、用那份資料決定方向、再經 session 在限額內上鏈下單。一次執行印出**兩筆 BaseScan 可查的 tx**：① x402 收入結算 `settlementTx`、③ 開倉 tx。

## 跑法
```bash
cd agent
# .env 需含（見 .env.example Track D）：
#   X402_API_URL, AGENT_PRIVATE_KEY(持官方 USDC + ETH), BASE_SEPOLIA_RPC_URL,
#   SESSION_MANAGER_ADDRESS, DEMO_SESSION_ID=6
npx tsx examples/x402-autotrade.ts sBTC 50 3      # <symbol> <margin> <leverage>，預設 sBTC 50 3
```

## 流程
1. **x402 付費取資料**：`GET /oracle/<symbol>`（$0.005，拿 funding）+ `GET /signals/<trader>`（$0.01，拿 `settlementTx`）。每次 402→200，付款用 viem + `x402-fetch`（與 `buy-signal.ts` 同環境）。
2. **判斷方向**（透明規則）：`fundingRateBps ≤ 0 → 做多`、`> 0 → 做空`（funding>0=多方擁擠 longs_pay，反向做空）。
3. **session 下單**：`openPositionForSession(#6, ethers.id(symbol), isLong, parseUnits(margin,18), leverage)`，印開倉 tx + positionId。

## 前置 / 限制
- **付款用官方 Base Sepolia USDC**（Circle, EIP-3009），不是平台模擬 USDT — 跑這支的錢包要先到 Circle 測試網水龍頭領官方 USDC + 一點 ETH 付 gas。
- 下單保證金是 session.user 在交易所存的模擬 USDT；兩種幣用途不同。
- 加密 sBTC/sETH 免 KYC；RWA 需先 KYC 否則開倉 revert。
- session 限額/到期由合約強制；**用 #6 不會過期**（到 2027-06-22，單筆≤50/預算1000/槓桿≤5）。#0 已過期。
