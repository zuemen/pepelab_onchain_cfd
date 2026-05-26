# INTEGRATION PLAN — Minimal UI Kit × PepeLab On-Chain CFD
> Phase 0 Gap Report（產出於 2026-05-25）

---

## 一、Commit Hash（Rollback 基準）

| Repo | HEAD commit |
|------|------------|
| `pepelab_onchain_cfd` (真相來源) | `7c3fa71a58790f8acb83565902c57f4692d4b7cc` |
| `pepefi_frontend` (工作區) | `2300a448488dea231ab8863a9d4014da87aab1e2` |

---

## 二、工作區「接合改寫」模式（已有，Phase 3 所有頁面統一沿用）

工作區在 `cb6017e minimal UI 初版` 已做過一輪接合，以下模式在全部 15 頁統一：

| 項目 | pepelab 寫法 | 工作區接合後寫法 |
|------|------------|----------------|
| React Router | `react-router-dom` | `react-router` |
| 取得 wallet | `{ wallet }: Props` prop 傳入 | `usePepefiWallet()` hook (outlet context) |
| hooks import | `'../hooks/x'` | `'src/hooks/x'` |
| contracts import | `'../contracts/x'` | `'src/contracts/x'` |
| lib import | `'../lib/x'` | `'src/lib/pepefi/x'` |
| components import | `'../components/x'` | `'src/components/pepefi/x'` |

---

## 三、Gap 報告逐項

### 3-A. 合約層（contracts/）

| 項目 | 工作區 | pepelab | 狀態 |
|------|--------|---------|------|
| addresses.ts 合約數 | 11 | **15** | ❌ 需同步 — 缺 PepeAMM / PepeToken / PepeClaim / EsgRewardDistributor |
| addresses.ts 資產數 | 6 | **11** | ❌ 需同步 — 缺 sNVDA / sMSFT / sGOOGL / sICLN / sESGU |
| KYCRegistry (Sepolia) | `0x000...0` | `0x7d40A2D3e39cDD1...` | ❌ 需同步 |
| ABI 數量 | 11 | **15** | ❌ 需同步 — 缺 PepeAMM.json / PepeToken.json / PepeClaim.json / EsgRewardDistributor.json |
| useContracts.ts (合約實例數) | 11 | **15** | ❌ 需同步 — 缺 pepeAMM / pepeToken / pepeClaim / esgRewardDistributor |

**Phase 1 動作**：
1. 整份覆蓋 `addresses.ts`（pepelab 版，一字不差）
2. 補齊 4 個 ABI JSON 檔到工作區 `src/contracts/abi/`
3. 更新 `useContracts.ts` — 加 4 個合約，import 路徑保持 `src/contracts/...`

---

### 3-B. Hooks（8 個）

| 文件 | 工作區行數 | pepelab行數 | 差異 | 狀態 |
|------|-----------|-----------|------|------|
| `useContracts.ts` | 41 | 49 | 38 行 | ❌ 需同步（缺 4 合約，Phase 1 處理）|
| `useESG.ts` | 46 | **68** | 65 行 | ❌ 需同步（pepelab 多 22 行新邏輯）|
| `useFundingData.ts` | 61 | 63 | 44 行 | ❌ 需同步（import 路徑 + 小幅內容）|
| `useKYC.ts` | 24 | 20 | 36 行 | ❌ 需同步（import 路徑差異）|
| `useLivePrices.ts` | 60 | **67** | 22 行 | ❌ 需同步（pepelab 多 7 行，涵蓋 11 資產）|
| `usePriceHistory.ts` | 84 | 85 | 8 行 | ❌ 需同步（import 路徑 + 微調）|
| `useWallet.ts` | 115 | 115 | 6 行 | ⚠️ 需同步（import 路徑差）|
| `useWhaleAlerts.ts` | 65 | 65 | 6 行 | ⚠️ 需同步（import 路徑差）|

**Phase 2 動作**：覆蓋所有 8 個 hook，以 pepelab 內容為準，import 路徑改成 `src/` alias。

---

### 3-C. Lib（3 個）

| 文件 | 工作區行數 | pepelab行數 | 差異 | 狀態 |
|------|-----------|-----------|------|------|
| `assetMeta.ts` | 61 | **106** | 127 行 | ❌ 需同步（缺 5 個新資產 sNVDA/sMSFT/sGOOGL/sICLN/sESGU 的 meta 定義）|
| `errorMessages.ts` | 52 | 52 | 0 | ✅ 相同 |
| `notify.ts` | 6 | 6 | 0 | ✅ 相同 |

**Phase 2 動作**：覆蓋 `assetMeta.ts`，lib 路徑為 `src/lib/pepefi/`。

---

### 3-D. Components（9 個）

| 文件 | 差異行數 | 狀態 | 備註 |
|------|---------|------|------|
| `EmptyState.tsx` | 10 | ❌ 需同步 | import 路徑差 |
| `ErrorBoundary.tsx` | 0 | ✅ 相同 | — |
| `ESGBadge.tsx` | 0 | ✅ 相同 | — |
| `KYCModal.tsx` | 10 | ❌ 需同步 | import 路徑差 |
| `Layout.tsx` | 31 | ⚠️ 特殊處理 | 見下方備註 |
| `Skeleton.tsx` | 2 | ❌ 需同步 | import 路徑差 |
| `StatCard.tsx` | 0 | ✅ 相同 | — |
| `WalletButton.tsx` | 44 | ✅ 工作區保留 | 工作區版更豐富（有 spinner、綠點指示燈、hover 選單），不覆蓋 |
| `WhaleAlertBanner.tsx` | 12 | ❌ 需同步 | import 路徑差 |

**Layout.tsx 特殊說明**：
- pepelab 的 `Layout.tsx` 是舊外框（含側邊欄），Phase 2 不當頁面外層使用
- 但其中的「WalletButton、KYC狀態 badge、WhaleAlertBanner」邏輯需保留，並在 Phase 4 接進 Minimal DashboardLayout 的 header `rightArea`

---

### 3-E. Pages（15 頁）

| 頁面 | 工作區行數 | pepelab行數 | 差異 | 狀態 | 主要差異說明 |
|------|-----------|-----------|------|------|------------|
| `AdminOraclePage.tsx` | 453 | 456 | 69 | ❌ 需同步 | import 路徑 + 小幅內容 |
| `AdminTreasuryPage.tsx` | 401 | 401 | 36 | ❌ 需同步 | import 路徑 + 小幅內容 |
| `CopyPage.tsx` | 560 | 557 | 49 | ❌ 需同步 | import 路徑 + 小幅 |
| `DashboardPage.tsx` | 596 | **894** | 788 | ❌ **重大更新** | pepelab 多 298 行新內容（更豐富的資產分類顯示、圖表、持倉計算邏輯）|
| `ESGPage.tsx` | 310 | **367** | 508 | ❌ **重大更新** | pepelab 版涵蓋 11 資產（+sNVDA/sMSFT/sGOOGL/sICLN/sESGU）、7 級評級系統、雷達圖顯示 |
| `ExchangePage.tsx` | 871 | **1003** | 432 | ❌ **重大更新** | pepelab 多 132 行（新增 EsgRewardDistributor 整合：高 ESG 分數倉位可領 PEPE 獎勵）|
| `HistoryPage.tsx` | 456 | 454 | 26 | ❌ 需同步 | import 路徑 + 微調 |
| `LandingPage.tsx` | **122** | 58 | 170 | ✅ 工作區版保留 | 工作區版更豐富（FEATURES / STEPS 區塊、中英雙語、Minimal Kit 樣式），不覆蓋 |
| `MarketplacePage.tsx` | 485 | 488 | 53 | ❌ 需同步 | import 路徑 + 小幅 |
| `PortfolioPage.tsx` | 601 | 576 | 70 | ⚠️ 需確認 | 工作區版反而更長（+25 行），需逐行確認工作區是否有額外改進邏輯 |
| `TraderDashboard.tsx` | 518 | 518 | 48 | ❌ 需同步 | import 路徑差異 |
| `TraderProfilePage.tsx` | 405 | 399 | 41 | ❌ 需同步 | import 路徑 + 小幅 |
| `TraderStakePage.tsx` | 301 | 300 | 24 | ❌ 需同步 | import 路徑 + 微調 |
| `VaultPage.tsx` | 313 | 305 | 40 | ❌ 需同步 | import 路徑 + 小幅 |
| `WhaleTrackerPage.tsx` | 567 | **725** | 674 | ❌ **重大更新** | pepelab 多 158 行（新增 DEPLOY_BLOCK 分塊抓鏈上事件、CHUNK_SIZE 機制、Macro Trader 第 3 個鯨魚地址）|

**Phase 3 原則**：
- 重大更新頁面（Dashboard / ESG / Exchange / WhaleTracker）：以 pepelab 內容為準完整覆蓋，再做接合改寫
- 其他頁面：以 pepelab 內容為準覆蓋，做接合改寫（react-router / usePepefiWallet / src/ alias）
- LandingPage 例外：保留工作區版（更好），只確認接合改寫已完成

---

### 3-F. 路由 / 導覽

| 項目 | 工作區現況 | 目標（pepelab App.tsx） | 狀態 |
|------|-----------|----------------------|------|
| 路由前綴 | `/pepefi/*`（巢狀在 `path:'pepefi'` 下）| `/`、`/dashboard`、`/exchange`... | ❌ **需調整** |
| 15 條路由都有 | ✅ 全部都有 | ✅ 全部都有 | ✅ 相同 |
| nav-config-dashboard PepeFi 選單 | 有完整 15 個頁面連結 | 需與路徑一致 | ❌ 需對齊路徑前綴 |
| paths.ts PEPEFI section | `/pepefi/...` | 需改為 `/`... | ❌ 需調整 |

**Phase 4 最重要缺失**：
1. **路由前綴對齊**：將 `pepefi.tsx` 的 `path: 'pepefi'` 改為根層路由（`path: ''` 或移到 root section）
2. **WalletButton 在 Header 中缺席**：`DashboardLayout` 的 `rightArea` 目前沒有 WalletButton，需加入。這是整個 app 能不能用的關鍵。
3. **WhaleAlerts 傳遞**：pepelab 的 DashboardPage 接收 `whaleAlerts` prop，工作區改用 `usePepefiWallet()` 後需確認 whaleAlerts 能取得

---

## 四、Phase 執行摘要

| Phase | 動作 | 複雜度 |
|-------|------|--------|
| Phase 1 | 合約層同步（addresses / ABI / useContracts） | 低（直接覆蓋）|
| Phase 2 | hooks / lib / components 同步 | 中（8+1+7 個文件，以 pepelab 為準 + src/ alias）|
| Phase 3 | 15 頁同步（重大：Dashboard/ESG/Exchange/WhaleTracker） | 高（4 頁重大更新）|
| Phase 4 | 路由前綴調整 + WalletButton 接進 header | 中高（架構改動）|
| Phase 5 | yarn build 修 0 error | 視 Phase 3-4 改動而定 |
| Phase 6 | 複製進 pepelab repo + push | 低（機械性操作）|

---

## 五、已知風險點

1. **ExchangePage 的 EsgRewardDistributor 整合**：pepelab 版 ExchangePage 新增了 `claimEsgReward`、`esgRewardedMap`、`hasEsgRewardDistributor` 等邏輯，依賴新合約——addresses 和 ABI 必須在 Phase 1 先同步完成。
2. **WalletButton in Header**：dashboard layout 的 `rightArea` 需要引入 `WalletButton`，而 `WalletButton` 需要 `wallet` prop。需要在 layout 層呼叫 `useWallet()` 並傳入——類似 `PepefiLayout` 的做法。
3. **PortfolioPage 逆差**：工作區 PortfolioPage 比 pepelab 多 25 行，Phase 3 需逐行確認工作區版是否包含額外改進邏輯。若是，保留工作區版；若是舊版，以 pepelab 為準。
4. **路由前綴改動**：修改路徑前綴後，nav-config-dashboard 的 `paths.pepefi.*` 也要同步更新。

---

*此文件為 Phase 0 調查產出，Phase 1-6 執行前以此為依據。*
