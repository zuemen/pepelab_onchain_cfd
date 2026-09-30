## 摘要

<!-- 這個 PR 改了什麼、為什麼。連結相關 issue。 -->

## 性質

- [ ] 只改原始碼／測試，不 broadcast（已部署的 bytecode 不變）
- [ ] 包含鏈上部署或設定變更（需列出每一筆交易與執行者）
- [ ] 只改文件

## 檢查清單

### 測試
- [ ] `contracts/`：`forge test` 全過（列出新增或修改的測試）
- [ ] `frontend/`：`yarn test` 與 `yarn build` 通過（只用 yarn）
- [ ] `agent/`：`npm test` 通過（只用 npm）
- [ ] 新增的風險或資金路徑有對應的回歸測試或不變量測試

### ABI 同步
- [ ] 沒有改動任何合約的對外介面
- [ ] 有改動，且已同步 `frontend/src/contracts/abi/` 與 `agent/shared/src/abis.ts`（若適用）
- [ ] 有改動，但刻意等 cutover 時才同步（說明原因）

### 位址一致性
- [ ] 沒有改動任何合約位址
- [ ] 有改動，且 `frontend/src/contracts/addresses.ts`、`sessionManager.ts`、`x402.ts` 與 workflow 的位址一致（`Consistency` workflow 通過）
- [ ] 文件中的位址（README 等）已同步更新

### 正式站影響
- [ ] 不影響正式站（前端、signal-api、keeper、結算 worker）
- [ ] 會影響正式站：說明影響範圍、回滾方式（見 `docs/INCIDENT_RESPONSE.md` 的 Vercel 回滾）
- [ ] 改動功能旗標預設值或新增環境變數（列出變數與預設值）

### Cutover
- [ ] 不需要 cutover
- [ ] 需要 cutover：已寫明部署腳本、執行順序、需要的金鑰與角色、既有部位與資金的處理方式
- [ ] 文件已明確區分「已上線」與「僅原始碼」

### 安全與文件
- [ ] 沒有提交任何私鑰、token、RPC 金鑰或使用者個資
- [ ] 沒有在公開文件寫入未修補漏洞的細節
- [ ] 若新增或解決已知限制，已更新 `docs/KNOWN_LIMITATIONS.md`

## 驗證方式

<!-- 審查者要怎麼確認這個 PR 是對的：指令、截圖、鏈上唯讀查詢等。 -->
