# PepeLab On-Chain CFD — Capstone Deliverables

> NCCU Capstone 2026 · agent-native 永續型 CFD 協議，對標 Hyperliquid。
> **Live on Base Sepolia (chainId 84532)** · `forge test` 314 passed · 前端/agent build 綠。

---

## 1. 一頁總結：對標 Hyperliquid 的四戰線

| 戰線 | Hyperliquid | PepeLab（本專案） | 狀態 |
|------|-------------|-------------------|------|
| **執行 / 撮合** | L1 訂單簿、低延遲、mark-price 永續 | mark-price 永續（index/mark 分離 + OI 溢價）、組合保證金、pro 交易終端 | ✅ 對齊執行語意（撮合層列 roadmap） |
| **預言機 / RWA** | 內生預言機、加密為主 | 多源聚合 + 偏離熔斷、RWA 上架 + KYC gating、逐標的風險參數 | 🏆 **領先**：合規 RWA |
| **Agent 原生** | 無一等公民 agent | x402 付費訊號 + MCP read/write tools + session 限額委派 + **付費→自主下單** | 🏆 **領先**：agent 經濟 |
| **資本效率 / LP** | HLP 金庫 | 做市金庫（交易費分潤入 `InsuranceVault` ERC20-share）+ ADL 償付防線 | ✅ 對等 |

**廣度數字**：11 個合成標的（crypto / equity / commodity / bond / ESG ETF）、RWA 經 KYC gating、
做市金庫 LP 收益隨交易上升、agent 經有界 session 自主下單、ADL + 組合保證金雙清算防線。

---

## 2. 已部署位址（Base Sepolia, 84532）

瀏覽器：`https://sepolia.basescan.org/address/<addr>`

### 核心合約
| 合約 | 位址 |
|------|------|
| MockUSDC | `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035` |
| MockSwapRouter | `0xC9b0e5C219AA1B3eB00E92Fd9a883B182F0AE8Ae` |
| MockOracle（live exchange 用） | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` |
| TraderStake | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` |
| InsuranceVault（做市金庫 pIV） | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` |
| FeeRouter（x402 70/20/10 分潤） | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` |
| **PerpetualExchange** | `0xEf75ECA6514cE96B18382E921aC6190a0cF8c072` |
| StrategyRegistry | `0x54e8C43f9Eb151Bb8DD6e61d16a969C4D0e73915` |
| CopyTracker | `0x96357144fE56c5E0e33e8046bE2A63F45528b210` |
| AgentSessionManager | `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8` |
| KYCRegistry | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` |

### 生產級預言機展示（已部署，**未接 live exchange**）
| 合約 | 位址 |
|------|------|
| ChainlinkOracleAdapter | `0x37DC7b70899BFfB17949366a5b6a86203C428E2f` |
| PythOracleAdapter（接 Base Sepolia Pyth） | `0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5` |
| AggregatorOracleAdapter | `0x8215158642350a3f329aB9597186d21f957A813D` |

> exchange 的 `oracle` 是 immutable，故 live exchange 用 MockOracle 保住全合成資產 demo；
> 聚合 adapter 作為「生產就緒、待 mainnet 切換」的展示物（Pyth 已接 BTC/ETH 真 feed）。

### x402 收入路由（官方 USDC, 6-dec — 真結算用）
| 合約 | 位址 |
|------|------|
| X402 FeeRouter（綁 Circle 官方 USDC） | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` |
| X402 InsuranceVault | `0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f` |
| 官方 USDC（結算幣別） | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

> 付款幣別（官方 USDC, 6-dec）與保證金幣別（MockUSDC, 18-dec）**用途分離**；x402 收入經此
> 專用 router 走 70/20/10 真分潤。鏈上綁定已驗證，見 `docs/VERIFICATION_REPORT.md §4`。

### x402 Signal API（已公開上線 · Vercel）
| 項目 | 值 |
|------|----|
| 正式網址 | **`https://agent-git-master-zuemens-projects.vercel.app`** |
| 健康檢查 | `GET /healthz` → `ok` |
| 服務目錄 | `GET /` → JSON |
| 付費端點（402 牆） | `GET /signals/:trader`（$0.01） · `GET /oracle/:asset`（$0.005） |

> 前端 `VITE_SIGNAL_API_URL` 預設即指向此網址（見 `frontend/src/lib/pepefi/signalApi.ts`
> 的 `DEFAULT_SIGNAL_API_URL`），`/x402` 開發者頁的 Base URL 與試買、Marketplace 卡片、
> AgentMonitor 的鏈上 `/revenue` 皆走此線上 API。外部自帶錢包付費見 §4-B 與 `agent/examples/buy-signal.ts`。

---

## 3. 架構與資料流（Phase 4：全程 Base Sepolia 同鏈）

```
                ┌──────────────────────── Base Sepolia (84532) ────────────────────────┐
  React 前端 ───┤  PerpetualExchange ── MockOracle (index/mark, funding, ADL,           │
  (ethers v6)   │       │   │            組合保證金, RWA+KYC gate)                        │
                │       │   └── InsuranceVault (pIV ERC20-share, 做市金庫, bailout/ADL)   │
                │       ├── AgentSessionManager (有界 session 委派)                       │
                │       ├── FeeRouter (70/20/10：trader/platform/vault)                   │
                │       └── KYCRegistry / StrategyRegistry / CopyTracker / TraderStake    │
                │                                                                          │
  Agent 棧 ─────┤  signal-api (x402 付費訊號) ──收款──► FeeRouter.routeExternalRevenue    │
  (Node/ethers) │  demo-agent (付 x402 → 決策 → openPositionForSession 自主下單)          │
                │  mcp-server (read + session-bounded write tools)                        │
                │                                                                          │
  Keeper ───────┤  GitHub Actions (*/30)：refresh prices · settleFunding · vault solvency │
                └──────────────────────────────────────────────────────────────────────┘
```

**關鍵**：x402 USDC 結算與合約讀取/分潤同在 Base Sepolia——舊的跨鏈 caveat 已解。

---

## 4. 期末 Demo 點按順序

### A. 一鍵鏈上故事（最快，deterministic）
```bash
cd contracts && forge script script/DemoE2E.s.sol:DemoE2E -vv
```
RWA+KYC → LP 金庫 → agent session → 自主下單 → mark/index → 金庫收益 → 清算+ADL，逐步印數字。

### B. x402 付費 → 自主下單（agent 經濟，真鏈）
```bash
cd agent && cp .env.example .env   # 已預填 Base Sepolia + SESSION_MANAGER_ADDRESS
npm run signal-api                 # 終端 1
npm run demo-agent                 # 終端 2：付 x402 → 經 session 開受限部位，印 tx hash
```

### C. 前端互動（連 Base Sepolia 錢包）
- `/terminal` Pro 交易終端：下單、mark vs index、funding、OI。
- `/vault` 做市金庫：LP 存提、share price、分潤 banner。
- `/sessions` 建/撤 agent session；`/agent-monitor` 鏈別/金庫償付/預言機新鮮度/x402 收入。
- RWA 標的（sAAPL/sTSLA）未 KYC → 提示導引 KYC。

詳見 `docs/DEMO_SCRIPT.md`。

---

## 5. 測試 / 品質

- 合約：**314 Foundry 測試全綠**（含守恆/邊界/回歸/ADL/組合保證金）。
- 每個動到資金的功能都有「總額守恆」測試；新功能皆預設關閉旗標確保零回歸。
- 三輪皆經 subagent 安全 review（抓到並修掉 N2 ADL 金庫未抽、P3-2 組合保證金 fee-asymmetry 兩個真 bug）。
- 前端 `npm run build`、agent `tsc -b` 皆綠。

---

## 6. Roadmap（capstone 後，需另議）

- Base **mainnet** 部署（需外部 audit + 真實流動性 + 明確同意）。
- 混合鏈下訂單簿 + 鏈上結算（ADR Option C）——真正的撮合層。
- 切換 live exchange 至生產級聚合預言機（須重部署 exchange，會影響合成資產 demo）。
- x402 大招（agent 經濟敘事）公開。
