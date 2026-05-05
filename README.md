# PepeLab Onchain CFD — 鏈上 CFD 衍生品跟單系統

## 專題簡介

本專題為政治大學資管系大學部個人專題，目標是在區塊鏈上實作一套 **差價合約（CFD, Contract for Difference）跟單交易系統**。

使用者可選擇跟單特定的「領單交易員」，自動複製其在鏈上開立的合成資產倉位（多/空），無需自行判斷行情。系統透過智能合約管理保證金、計算 PnL、執行清算，全程去中心化、透明可驗證。

### 核心概念

- **合成資產（Synthetic Asset）**：以超額抵押穩定幣模擬標的資產（如 BTC、ETH）價格曝險，無需持有真實資產
- **CFD 倉位**：記錄開倉價、方向（多/空）、槓桿、抵押品，到期或平倉結算差額
- **跟單（Copy Trading）**：追蹤者存入資金後，鏈上合約自動按比例複製領單者的開倉與平倉操作
- **去中心化預言機**：價格來源使用 Chainlink / 自建 Mock Oracle，確保公平

---

## 技術棧

| 層次 | 技術 |
|------|------|
| 智能合約 | Solidity ^0.8, Foundry（forge / cast / anvil） |
| 前端框架 | React 19 + Vite + TypeScript |
| 樣式 | Tailwind CSS v3 |
| 路由 | React Router DOM v7 |
| 圖表 | Recharts |
| 鏈上互動 | ethers.js v6 |
| 測試 | Forge 單元測試 + Invariant Tests |
| 版本控制 | Git / GitHub |

---

## 目錄結構

```
pepelab_onchain_cfd/
├── contracts/                  # Foundry 專案（Solidity 智能合約）
│   ├── src/                    # 合約原始碼
│   │   ├── CFDEngine.sol       # 核心 CFD 引擎（保證金、開倉、平倉、清算）
│   │   ├── CopyTrading.sol     # 跟單邏輯合約
│   │   ├── SyntheticAsset.sol  # 合成資產 ERC-20 token
│   │   └── MockOracle.sol      # 測試用價格預言機
│   ├── test/                   # Forge 測試
│   ├── script/                 # 部署腳本
│   ├── lib/                    # 依賴（forge-std、openzeppelin）
│   └── foundry.toml
│
├── frontend/                   # React + Vite 前端
│   ├── src/
│   │   ├── components/         # 共用 UI 元件
│   │   ├── pages/              # 頁面（Dashboard、Trading、Leaderboard）
│   │   ├── hooks/              # 自訂 React Hooks（useContract、usePrices…）
│   │   ├── abis/               # 合約 ABI JSON
│   │   └── main.tsx
│   ├── public/
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── package.json
│
├── README.md
└── .gitignore
```

---

## 快速啟動

### 合約（本地測試網）

```bash
cd contracts
forge build
forge test
anvil                          # 啟動本地節點
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast
```

### 前端

```bash
cd frontend
npm install
npm run dev                    # 啟動開發伺服器 http://localhost:5173
```

---

## 開發進度

- [ ] CFDEngine 合約設計與測試
- [ ] CopyTrading 合約
- [ ] MockOracle 整合
- [ ] 前端 Dashboard（倉位總覽、PnL 圖表）
- [ ] 跟單 UI 流程
- [ ] Testnet 部署（Sepolia）

---

*政治大學資管系 · 2025–2026 個人專題 · PepeLab*
