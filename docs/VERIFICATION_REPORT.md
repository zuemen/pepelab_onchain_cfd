# Verification Report — Base Sepolia (chainId 84532)

> 本輪目標：x402 真結算可行 + 平台 smoke test。下表分「**自動可驗證（本機/唯讀）**」與
> 「**需注資錢包跑（你執行，貼 tx）**」。後者非程式缺陷，是測試網需要真資金/服務的固有限制。

更新：2026-06-14 · 合約 `forge test` **318 passed** · 前端/agent build 綠。

---

## 1. 自動可驗證（本輪已 PASS，有證據）

| # | 項目 | 證據 | 狀態 |
|---|------|------|------|
| 1 | 合約測試全綠 | `forge test` → 318 passed / 0 failed | ✅ PASS |
| 2 | x402 分潤會計（官方 USDC 6-dec） | `FeeRouterX402Usdc.t.sol` 4 測試：70/20/10 在 6-dec、trader/platform 提領 | ✅ PASS |
| 3 | x402 分潤會計（MockUSDC 18-dec） | `FeeRouterExternalRevenue.t.sol` 6 測試 | ✅ PASS |
| 4 | x402 router 部署腳本 | `DeployX402Router.s.sol` dry-run：settlement USDC = `0x036C…CF7e`（官方） | ✅ PASS |
| 4b | **x402 router 真實上鏈 + 綁定驗證** | 已部署並用 `cast` 鏈上驗證（見 §4） | ✅ PASS |
| 5 | 部署 wiring（live 鏈上 cast） | Phase 4 subagent 15/15 invariant PASS（oracle/usdc/vault/feeRouter/kyc/authorizedAgents/rwa…） | ✅ PASS |
| 6 | 前端 build | `frontend npm run build` 綠（所有頁面編譯） | ✅ PASS |
| 7 | agent build | `agent tsc -b` 綠 | ✅ PASS |
| 8 | EIP-170 合約大小 | 全合約 < 24576 B（optimizer 開） | ✅ PASS |

---

## 2. 需注資錢包跑（你執行，貼 tx hash + BaseScan）

> 前置：agent EOA 持 Base Sepolia ETH（gas）+ 官方測試 USDC（付 x402）。
> ETH faucet：https://docs.base.org/chain/network-faucets ·
> USDC faucet：https://faucet.circle.com （選 Base Sepolia）。

| # | 流程 | 怎麼跑 | 待貼證據 |
|---|------|--------|----------|
| A | 部署 x402 收入路由（官方 USDC） | ✅ **已完成**（見 §4 真實位址 + tx） | DONE |
| B | signal-api 起服務 | `npm run signal-api`；`curl /` `/revenue` | 200 JSON |
| C | x402 付費 402→200 | `npm run demo-agent`（填好 .env） | 402 + 付款 tx + 200 訊號 |
| D | agent 經 session 自主下單 | demo-agent 自動（需 DEMO_SESSION_ID） | open tx + BaseScan + positionId |
| E | x402 收入真上鏈 70/20/10 | server fire `routeExternalRevenue` | settlement tx + `/revenue.settledOnChain` |
| F | MCP write tools 受限額 | MCP client 呼叫 `open_position`/`close_position` | tx + 超 budget/expiry 被擋 |

### B2 核心流程（前端連 Base Sepolia 錢包）
| 流程 | 怎麼驗 | 狀態 |
|------|--------|------|
| KYC gating | `/exchange` 開 sAAPL：未 KYC 擋、`submitKYC` 後過 | ⏳ 待錢包 |
| 永續 mark/funding/清算/ADL | `/terminal` 開平倉、看 mark vs index、funding 自動 settle | ⏳ 待錢包 |
| 做市金庫 | `/vault` LP deposit/withdraw、share price 隨交易上升 | ⏳ 待錢包 |
| 跟單 70/20/10 | 發策略 → 跟隨 → 複製費分潤 | ⏳ 待錢包 |
| keeper | GitHub Actions `base-sepolia-keeper`（需設 secrets + 手動 dispatch） | ⏳ 待 secrets |

---

## 3. 本輪修了什麼（A0）

- **幣別一致性**：診斷出 x402 結算幣（官方 USDC 6-dec）與既有 FeeRouter（MockUSDC 18-dec, immutable）不符。
- **修法（Option 1，不動既有引擎）**：新增 `DeployX402Router.s.sol` 部署一組綁官方 USDC 的
  `FeeRouter`+`InsuranceVault`；`settlement.ts` 改為**動態讀 token decimals** + 可設
  `X402_SETTLEMENT_TOKEN`/`X402_FEE_ROUTER`，官方 USDC 不可 mint 時回明確錯誤不擋回應。
- **付款側本就正確**：x402-hono 以 `$價格`+`base-sepolia` 自動解析官方 USDC；只需把 `PAY_TO`
  指向 treasury EOA（= FEE_SETTLEMENT 帳戶）。
- 加測試 `FeeRouterX402Usdc.t.sol`（6-dec 70/20/10 + 提領）；README/.env.example 寫清楚
  「付款幣別 vs 保證金幣別」設計與 faucet 來源。
- **subagent review 修補**：settlement.ts 加開機/首次結算前的「結算 token == FeeRouter.usdc()」
  一致性守衛，把最常見的 .env 誤配（`X402_FEE_ROUTER` 留空回退 MockUSDC router）從**靜默
  失敗**變成**明確錯誤**；加負向測試 `test_currencyMismatch_revertsLoudly`（幣別不符必 revert）；
  修掉 `/` 端點 stale 的 `network_read: ethereum-sepolia` 標籤。

> ⚠️ **最重要的 .env 守則**：`X402_SETTLEMENT_TOKEN`（官方 USDC）與 `X402_FEE_ROUTER` 必須**配對**——
> 先跑 `DeployX402Router.s.sol` 拿到官方 USDC 的 FeeRouter 再填 `X402_FEE_ROUTER`；`PAY_TO` 設
> treasury EOA（勿留空、勿指 MockUSDC FeeRouter）。守衛會在不符時直接報錯。

---

## 4. x402 收入路由（官方 USDC）— 已上鏈並驗證（2026-06-15）

部署位址（Base Sepolia，`agent/.env.example` 已預填 `X402_FEE_ROUTER`）：

| 合約 | 位址 |
|------|------|
| X402 FeeRouter（綁官方 USDC） | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` |
| X402 InsuranceVault（綁官方 USDC） | `0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f` |
| 結算 token（Circle 官方 USDC, 6-dec） | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| platformTreasury / payTo | `0xE80A81360608C1342e66743F70a00f75d792Eb93` |

部署 tx（BaseScan `https://sepolia.basescan.org/tx/<hash>`）：
- vault deploy : `0xc4eca36da4086257a905981a2026ff7dc6cc49c09d8f26e1e5d9c9285d502b02`
- router deploy: `0xc937363267bef7ab94f44bfef9bfd336818122ec6698d707054a93b805459d19`
- vault.setFeeRouter (wire): `0xf6b00ab78e38a365b837fddb93bae1f57f39d263c02a30e9387a1273bcd5d9c0`

**鏈上綁定驗證（`cast call`，本報告作者執行）**：
- `router.usdc()` = `0x036C…CF7e`（官方 USDC）✓
- `router.insuranceVault()` = `0xc7Af…7B9f` ✓
- `router.platformTreasury()` = `0xE80A…Eb93` ✓
- `vault.usdc()` = `0x036C…CF7e` ✓
- `vault.feeRouter()` = `0x29e5…B57d` ✓

→ 幣別綁定一致、wire 正確；`settlement.ts` 的幣別守衛會放行。**剩餘**：agent/treasury EOA 領官方
USDC + ETH 後，跑 signal-api + demo-agent 產生真實 402→200→下單→分潤 的 tx（B–F）。
