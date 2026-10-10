# 平台 cutover 執行紀錄（2026-10-10）

依 [`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) 執行。交易由擁有者在本機送出；讀回與驗收由 agent 以唯讀 RPC 完成。

## 第 1 步：GitHub（部分完成）

- 已建 `admin-approval` environment（reviewer＝zuemen、管理員不可繞過、只允許 master）；`keeper`、`settlement` 限定 master。
- master branch protection：必須走 PR、禁止 force push 與刪除、9 項 required checks（清單同 OWNER_ACTIONS 第 1 步第 5 點）；
  `enforce_admins=false`、不要求 approve（單人維護，緊急時管理員可直接 push，例如 vc-status 撤銷清單）。
- `keeper` 私鑰**仍在 repo 層級**：曾嘗試貼入 environment 但貼錯（keeper 回 `Failed to decode private key`），已刪除還原。
  正確的私鑰在本機 `contracts/.env.roles` 的 `KEEPER_PK`（地址 `0x540a…ef17`），日後可從檔案直接導入。
- `settlement` environment 已放入**新的**結算私鑰（見第 4 步）；repo 層級的舊 `FEE_SETTLEMENT_PRIVATE_KEY` 尚未刪除。
- 名稱為 `BASE` 的 repo secret 沒有任何 workflow 引用，未刪除（待擁有者決定）。

## 第 3 步：凍結舊部署（完成）

- 前置：V2_ADMIN `0x2a58…` 0 值自轉帳（Sepolia nonce 2→4，多一筆是重複執行，無害）；owner `0x27C2…` 0 值自轉帳（Base）。
- 本機分叉演練：Base 3 筆、Sepolia 68 筆皆「讀回完成」。
- Base：3 筆（三顆 oracle adapter 移交給 `0x27C2…A585`），一次成功。
- Sepolia：68 筆分四次送完。
  - 第 11 筆 `grantRole` 兩次 out-of-gas（forge 本機估 ~5.4 萬，Sepolia 實際要 ~13.4 萬，gas 計價與 forge 模擬不同）→ 改用 `--gas-estimate-multiplier 500`。
  - 一次在送出 7 筆後以 `NonceMismatch` 停下（公用節點收據不穩，forge 重新模擬時帶的是舊 nonce）；改用 Infura 節點與新 nonce 後完成。
  - 外洩地址 nonce：1232 → 1302 = 68 筆成功 + 2 筆 out-of-gas，**沒有任何計畫外交易**（Blockscout 逐筆核對）。
- Phase 2：V2_ADMIN 對 8 顆 SyntheticAssetV2（sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT）`renounceRole(0x00)`，8/8 成功；讀回外洩地址與 V2_ADMIN 都不是 admin。
- 驗收：兩鏈 `readback.mjs` exit 0、`verify()` 通過；Base 事件掃描可疑 0。
  Sepolia 事件掃描未能執行（公用節點都不支援全區段 `eth_getLogs`，Infura 限 1 萬區塊），以 nonce 對帳＋Blockscout 逐筆核對取代：
  10-04 盤點之後外洩地址只有 10-06 的 0.8 ETH 跨鏈轉出與本次凍結交易。
- 凍結後兩支 keeper（`base-sepolia-keeper`、`price-keeper`）照常成功。
- 剩下的 `platformTreasury`（immutable）：Sepolia 6、Base 2，只能靠重新部署（第 4、5 步）。

## 第 4 步：x402 FeeRouter 重新部署（鏈上完成；Vercel 待擁有者）

| 項目 | 值 |
|---|---|
| 新結算 EOA（`PAY_TO`） | `0x1Bc26292AF4364e22eFa5d0d857E9621ee969F94`（keystore `pepelab-settlement`，已入 0.01 ETH） |
| `TREASURY` | `0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`（owner） |
| 舊 x402 金庫（沿用） | `0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f`：先 `setFeeRouter(0)` 斷開，供給 0 時存入 1 USDC 種子（份額 1,000,000 全在 owner，資產 1,004,000） |
| 新 x402 FeeRouter | `0x780E18146Bc77E50c3e5EcaED913FC31F62c0f6A`：讀回 usdc／platformTreasury／insuranceVault／owner 正確，exchange／copyTracker 為 0；已接上金庫 |
| GitHub variables | `PAY_TO`、`X402_FEE_ROUTER`、`SIGNAL_API_URL=https://agent-zuemens-projects.vercel.app` |

- repo 內同步：`frontend/src/contracts/x402.ts`、`agent/.env.example`、`ops/monitoring/deployed.json`；
  `feerouter-config-changed` 改為 active（新 router 會發 `ExchangeSet`／`CopyTrackerSet`，平台 V1 FeeRouter 以 `notDeployed` 標明）。
- 發布狀態重跑：指向外洩地址的元件 Base 5→1、Sepolia 17→1（剩平台 FeeRouter，第 5 步）。
- **待擁有者**：Vercel 專案 `agent` 的 Production Branch 改 `master`（#207）、`PAY_TO`／`X402_FEE_ROUTER` 換新值後 Redeploy。
  完成前結算 worker 會因線上 payTo ≠ signer 而 fail-closed（預期）。
- 未做：Cloudflare monitoring 的 `EXPECTED_PAY_TO`（第 2 步的 Worker 尚未部署）。

## 安全事項

- owner keystore 密碼在執行過程中多次出現在終端機輸出（Git Bash／mintty 不隱藏 Windows 程式的密碼輸入；`ETH_PASSWORD` 在 Foundry 是密碼**檔**路徑）。
  擁有者應執行 `cast wallet change-password pepelab-owner` 換掉。
- 明文私鑰檔仍在本機：`contracts/.env`（外洩部署者）、`contracts/.env.rotation`（owner）、`contracts/.env.roles`（V2_ADMIN、keeper 等）。
  都已被 `.gitignore` 排除；是否刪除或移到離線媒體由擁有者決定。
