# ADR-001 — PepeLab vs Hyperliquid：差距盤點與補強路線

- 狀態：Accepted（P0 已於本輪實作，見各 G 項與 commit）
- 日期：2026-06-14
- 範圍：永續型 CFD 協議的競品對標。對手＝Hyperliquid，定位＝**agent-native + 合規 RWA**
  的差異化超越，而非在純訂單簿撮合上硬拚。

> 本文是「對標 → 計分 → 取捨 → 行動」的決策紀錄。實作守則：不新增業務語意、沿用既有
> pattern（oracle `getPrice/isStale`、權限 `onlyOwner`、代理 `AgentSessionManager` /
> `authorizedAgents` / `NotCopyTracker`）、每步 `forge test` 全綠才前進。

---

## 1. 四戰線計分板

對手 Hyperliquid 的強項是**撮合效能與深度**；我們不在該軸正面對決，改在另外三軸建立護城河。

| 戰線 | Hyperliquid | PepeLab（本輪後） | 判讀 |
|------|-------------|-------------------|------|
| **撮合 / 執行** | 自建 L1 訂單簿、極低延遲、mark-price 永續 | AMM/保證金型 CFD；本輪補上 **mark-price 模型**（G6） | 仍落後，但執行語意已對齊永續慣例 |
| **預言機 / RWA** | 內生預言機、以加密為主 | **多源聚合 + 偏離保護**（G1）、**RWA 上架 + KYC gating**（G2）；crypto→Chainlink、合成→Pyth | **領先**：合規 RWA 是對手弱項 |
| **Agent 原生** | 無一等公民 agent 介面 | x402 付費訊號 + MCP read/**write** tools + **session 限額委派**（G3/G4） | **領先**：agent 能「付費→自主下單」 |
| **資本效率 / LP** | HLP 金庫做市、深度流動性 | `InsuranceVault`（ERC20 share）；社群做市金庫＝**P1 設計**（G5） | 落後，已出設計、待實作 |

結論：把資源押在**預言機/RWA**與**agent 原生**兩軸拉開差距，撮合軸只求「不失分」（mark-price
對齊），資本效率軸補設計、排入下一輪。

---

## 2. 策略取捨：Option A / B / C

- **Option A — 正面對撞撮合**：自建高效訂單簿、拚延遲與深度。
  ✗ 否決：與對手最強處硬拚，工程成本極高、Capstone 週期內無法取勝。
- **Option B — 全 agent 化、棄守 RWA**：只做 agent / x402 敘事。
  ✗ 否決：放棄合規 RWA 這個對手結構性弱項，等於丟掉唯一的非對稱優勢。
- **Option C — 雙護城河（採用）**：在**合規 RWA**與**agent 原生**兩軸建立差異化，撮合軸
  只做務實對齊（mark-price），資本效率排入後續。
  ✓ 採用：投入產出比最高，且每一塊都能用既有結構 drop-in，不汙染核心。

---

## 3. 行動項清單（P0 / P1 / P2）

### P0 —（本輪完成，測試 265 → 290 全綠）

| 編號 | 項目 | 交付 | 對齊戰線 |
|------|------|------|----------|
| **G1** | 多源預言機聚合 adapter | `AggregatorOracleAdapter`（drop-in `IOracle`，雙源中位/取較新、偏離 `maxDeviationBps` fail-closed、單源退化）+ `AggregatorOracle.t.sol` | 預言機/RWA |
| **G2** | RWA 上架 + KYC gating | `PerpetualExchange.rwaAsset` + `setRwaAsset` + `kyc`/`setKycRegistry`，`_openPosition` 對 RWA 標的要求 `isVerified`（kyc=0 時 no-op，向後相容）+ `RwaKycGating.t.sol` + Deploy 接線 | 預言機/RWA |
| **G3** | MCP write tools 經 session | `shared/write.ts` + MCP `open_position`/`close_position`/`get_session`，全走 `AgentSessionManager` 限額；缺金鑰/位址回明確錯誤 | Agent 原生 |
| **G4** | x402 付費下單 e2e | `demo-agent`：付費讀訊號 → 依決策 → 經 session 真開受限部位、印 tx/positionId；無 session 優雅退化 | Agent 原生 |
| **G6** | Mark-price 永續模型 | index（oracle）與 mark（= index ± OI 失衡溢價，`markPremiumCapBps` 上限）分離；PnL/清算取 mark、entry 取 index；`getMarkPrice` + `MarkPrice.t.sol`（cap 預設 0＝零回歸） | 撮合/執行 |

> 守門：每項獨立 commit，改動 ABI 同步 `frontend/src/contracts/abi/*.json`；合約硬閘門
> ≥265 passed 全程維持。

### P1 — 下一輪

- **G5 社群做市 / LP 金庫**：見 §4 設計。
- mark-price premium 上鏈參數治理（目前 owner setter，未來轉 timelock/治理）。
- Deploy 切換真 adapter（mainnet 前才切，會讓 testnet 合成資產 demo 失真）。

### P2 — 願景

- 跨鏈結算統一（x402 在 Base、合約在 Ethereum Sepolia → 同鏈部署或橋接）。
- 撮合層升級（鏈下撮合 + 鏈上結算）以縮小執行軸差距。
- Agent 策略市集（多 agent、多策略訂閱）。

---

## 4. G5 設計 — 社群做市 / LP 金庫（P1，只設計不實作）

**目標**：讓社群 LP 存入 USDC、賺取交易分潤、並作為部位的對手方流動性，縮小對
Hyperliquid HLP 的資本效率差距。**原則：與既有 `InsuranceVault` 的 ERC20 share 模式整合，
不另立平行金庫體系。**

### 4.1 為何複用 InsuranceVault 而非新建

`InsuranceVault` 已是一個 ERC20 share 金庫（`pIV`），具備：
- `deposit/withdraw` 依 `previewDeposit/previewWithdraw` 按 `totalAssets/totalSupply`
  比例計價（首存 1:1）；
- `getSharePrice()` 揭露每股淨值；
- `depositFromProtocol`（FeeRouter slash 分潤 + Exchange 清算殘值）已是**收益入口**；
- `bailout` 為極端虧損兜底。

也就是說，share 計價、收益累積、權限（`feeRouter`/`exchange`）三件事都已具備。G5 不需要新
金庫，只需**把交易分潤導入同一個 `totalAssets`**，LP 的 `pIV` 淨值即自然上升。

### 4.2 收益來源接線（沿用既有入口，不新增業務方法）

1. **交易費分潤**：`PerpetualExchange` 收取的 `TRADING_FEE_BPS` 目前進協議。G5 將其中一部分
   （例如 `lpFeeShareBps`，owner 可設）透過既有 `depositFromProtocol(amount)` 注入金庫，
   計入 `totalAssets` → 全體 `pIV` 持有人按份額受益。**沿用既有 `depositFromProtocol` 入口
   與 `onlyExchange/onlyFeeRouter` 權限，不新增對外方法。**
2. **清算殘值**：`liquidatePosition` 已把 reward 後的殘值 `depositFromProtocol` 進金庫——
   既有行為，LP 已在分享。
3. **funding 溢出 / mark premium**：mark-price（G6）帶來的 OI 失衡溢價，未來可把淨溢出導入
   金庫作為做市報酬（P2）。

### 4.3 做市對手方（流動性）角色

- 當協議需要對手方流動性（保證盈利部位可被支付）時，金庫 `totalAssets` 即是後盾——
  與現行「協議 reserve 支付盈利」同一池子，避免雙重會計。
- 風險上限：沿用既有 `InsufficientVault` 防護，`withdraw`/`bailout` 都不可讓 `totalAssets`
  變負；LP 面對的最大回撤＝兜底支出，已由 share 淨值如實反映。

### 4.4 最小落地清單（待下一輪實作）

- `InsuranceVault`：新增 owner-set `lpFeeShareBps`（純參數，沿用 setter 慣例）。
- `PerpetualExchange`：在既有收費處，把 `tradingFee * lpFeeShareBps / 10000` 經
  `vault.depositFromProtocol` 注入（exchange 已是授權 caller，零權限改動）。
- 測試：LP 存入 → 開平倉產生交易費 → LP `withdraw` 拿回本金 + 分潤（share 淨值上升）。
- 前端：`/vault` 頁顯示 `getSharePrice` 與 LP APR（由分潤流估算）。

> G5 刻意只動「分潤導入比例」一個參數與一條既有入口呼叫，**不新增金庫、不新增業務語意**，
> 與本 ADR 的實作守則一致。
