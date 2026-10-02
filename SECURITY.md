# 安全政策（Security Policy）

> **GitHub Private Vulnerability Reporting 目前尚未開啟**（2026-09-30）。開啟之前請使用下方的替代管道。
>
> 狀態：2026-09-30。PepeFi 是部署在 **Base Sepolia 測試網**的研究原型。
> **目前沒有漏洞獎金（bug bounty）、沒有第三方安全稽核，僅限測試網。**

## 1. 如何回報漏洞

**目前（Private Vulnerability Reporting 開啟前）的替代管道**：開一個**不含任何細節**的 issue，
要求私密聯絡管道（可使用 security 範本）。維護者會回覆可用的私密方式。
issue 裡不要描述漏洞、受影響的函式、重現步驟或交易。

**開啟之後**，改用 GitHub 的 **Private Vulnerability Reporting**：

1. 進入本 repo 的 **Security** 分頁。
2. 點選 **Report a vulnerability**，填寫私密報告。

請**不要**在公開 issue、PR、討論區或社群媒體揭露尚未修補的漏洞。

> **維護者待辦**：Private Vulnerability Reporting 需要 repo 管理者在
> *Settings → Code security → Private vulnerability reporting* 手動啟用。

報告建議包含：受影響的元件與檔案、影響說明、重現所需的最小條件、你認為的嚴重度。
請勿附上任何私鑰或他人的個人資料。

## 2. 範圍

| 範圍內 | 說明 |
|---|---|
| `contracts/` | Solidity 合約，包含已部署於 Base Sepolia 的合約與僅存在於原始碼的版本 |
| `agent/` | signal-api（x402）、結算 worker、keeper、MCP server、Telegram bot、TypeScript SDK（`agent/sdk`）、共用函式庫 |
| `frontend/` | 前端應用、建置設定與安全標頭（`frontend/vercel.json`） |
| `.github/workflows/` | 會持有金鑰或寫入鏈上的 CI 流程 |

| 不在範圍內 | 說明 |
|---|---|
| 測試網代幣的價值 | MockUSDC、合成資產與 PEPE 在測試網上沒有價值；「可以領到／鑄出更多測試幣」本身不構成漏洞（例如已部署的舊版 `MockUSDC` 的 `mint` 無限制；原始碼已限制為 owner／swapRouter） |
| 第三方服務 | Base Sepolia 節點、x402.org facilitator、Vercel、GitHub、Upstash、CoinGecko、Yahoo Finance、Coinbase 等服務本身的問題，請回報給各自的維護者 |
| 已記錄的限制 | [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) 已列出的項目；若你發現其影響比文件描述更嚴重，仍歡迎回報 |
| 社交工程、實體攻擊、阻斷服務壓測 | 不接受對維護者或基礎設施的此類測試 |
| `web/` 靜態介紹頁的內容 | 文案問題請開一般 issue |

## 3. 善意研究的安全港（Safe Harbor）

只要你的研究符合以下條件，我們視為善意研究，**對善意研究不主動追訴**（本段文字以律師審閱為準）：

- 只在測試網上測試，不影響其他使用者的資金或資料，並在發現後停止進一步利用。
- 不存取、保留或散布他人的資料；不嘗試取得或使用任何私鑰。
- 不進行阻斷服務、垃圾流量或破壞性測試。
- 在我們修補或雙方同意的揭露日期之前，不公開細節。

本聲明僅代表專案維護者的立場，無法代表第三方（例如雲端服務商）授權你的測試。
如果不確定某項測試是否在範圍內，請先透過私密回報詢問。

## 4. 回應時限（目標值）

以下是目標值，不是承諾；本專案沒有專職安全團隊。

| 階段 | 目標 |
|---|---|
| 確認收到報告 | 3 個工作天內 |
| 初步評估與嚴重度判定 | 10 個工作天內 |
| 修補或緩解（嚴重／高） | 盡力在 30 天內提出修補或緩解，並告知是否需要重新部署合約 |
| 協調揭露 | 修補部署後，或自收到報告起 90 天，以先到者為準；可雙方協商調整 |

合約修補通常需要重新部署與 cutover，由持有部署金鑰的維護者執行；原始碼修補與鏈上生效之間會有時間差，
我們會在文件中明確標示「僅原始碼」與「已上線」。

## 5. 目前的安全狀態（不含細節）

- **沒有第三方安全稽核**。`docs/audit/` 內是內部審查與靜態分析紀錄，不等於稽核。
- **沒有漏洞獎金**。
- 合約 owner 為**單一 EOA**，沒有 multisig，也沒有 timelock。
- 交易所的價格來源是 keeper 金鑰寫入的預言機，屬於受信任的中繼。
- 已知限制與狀態：[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)。
- 事故處置流程：[`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)。

## 6. 支援的版本

只有 `master` 分支與 [`README.md`](README.md) 列出的 Base Sepolia 現行部署在支援範圍內。
舊部署（例如已退役的 exchange、Sepolia 對照部署）不會收到修補。
