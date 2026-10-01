# 舊版 PerpetualExchange 與 /legacy 取回頁（P0-08）

Base Sepolia 與 Ethereum Sepolia 上，歷次重部署換下來的 PerpetualExchange 仍留有使用者的保證金與部位。
`/legacy` 頁讓使用者看到自己在舊合約上的資產，並在鏈上條件允許時自行提領或平倉。

> 這些都是**測試網**合約，結算資產是 MockUSDC，沒有真實價值。
> 詳細的持有人盤點與風險分析只留在內部文件（不進 repo），本文件只描述使用者需要知道的行為與限制。

## 1. 摘要（2026-10-01 唯讀盤點）

| 鏈 | 合約 | 使用期間 | 使用者能否自行取回 |
|---|---|---|---|
| Base Sepolia | `0xEf75ECA6514cE96B18382E921aC6190a0cF8c072` | 2026-06-14 → 09-04 | 可以提領；可能無法全額提領，差額由營運方處理 |
| Base Sepolia | `0xfAEf549C687C37064cEaB5728989a839B08955cf` | 2026-09-04 → 09-10 | 多數部位可平倉與提領；少數跟單獲利部位需營運方先調整設定（見 §3） |
| Ethereum Sepolia | 四顆 2026-05 的早期部署 | 05-06 → 05-21 | 可以；舊合約不檢查價格時效，平倉會以預言機最後一次的價格結算（頁面會警告） |

## 2. 位址從哪裡來

- `frontend/src/contracts/addresses.ts` 的 git 歷史（`git log -p -- frontend/src/contracts/addresses.ts`）
  每一次 `PerpetualExchange` 被換掉的舊值。
- `contracts/broadcast/*/84532/` 與 `*/11155111/` 中 `contractName == PerpetualExchange` 的 CREATE。
  Base Sepolia 只有三次（`Deploy.s.sol` → `0xEf75`、`Redeploy102Exchange.s.sol` → `0xfAEf`、
  `Redeploy129Exchange.s.sol` → 現行 `0x827e`），與 addresses.ts 的歷史一致。
- Sepolia 的現行 exchange `0x0c6459d3…c32b` 仍是 addresses.ts 的 Sepolia 值，**不算舊合約**，不列入。

## 3. 需要營運方處理的事項

1. **`0xfAEf`**：部分部位需營運方先調整設定才能平倉。頁面會在那幾筆部位上說明原因並顯示客服聯絡方式。
2. **`0xEf75`**：可能無法全額提領，差額由營運方處理。頁面只提供合約當下付得出的金額，並列出差額。
3. **Ethereum Sepolia 舊合約**：不需要營運方操作即可提領或平倉，是否另行通知由營運方決定。

## 4. ABI 相容性的處理

Position struct 從第一版（`597eff3`，11 欄）到 2026-09 版（16 欄）**一直是尾端追加**，前 11 欄
`id, owner, asset, isLong, entryPrice, margin, leverage, openedAt, closedAt, realizedPnL, isOpen`
的位置從未變過。所有版本的 `positions` 都是 public mapping（全靜態欄位 → getter 攤平成連續 word），
所以頁面不帶任何一版的完整 ABI，只：

1. `eth_getCode` 後掃 PUSH4（結果以 `chainId:address` 在模組層級快取，舊合約的 code 不會變），確認 `freeMargin / getUserPositions / positions / withdrawMargin /
   closePosition` 存在（缺任何一個讀取函式就標成 unsupported，不會誤報「沒有資產」）；
2. `positions(id)` 回傳只切前 11 個 word 解碼；
3. `usdc()`、`oracle()`、`maxPriceAge()` 有才讀，沒有就略過（Sepolia 早期版沒有 `maxPriceAge`）。

探測只認 PUSH4：selector 以 `0x00` 開頭時 solc 可能改用較短的 PUSHn，這種 selector 會被漏掉、
合約會被誤判成 unsupported（保守方向，不會誤送交易）。頁面需要的 selector 都不以 `0x00` 開頭，有測試釘住。

測試以三顆真實舊合約（`0xEf75`、`0xfAEf`、Sepolia `0x00f6`）的 runtime bytecode（`frontend/src/lib/pepefi/__fixtures__/legacyBytecode.json`）
驗證探測結果。

## 5. /legacy 頁的設計

### 5.1 為什麼是獨立路由 `/legacy`，而不是塞進 Portfolio

- **「沒有舊資產時不顯示入口」**：入口是 Portfolio 頂端的 `LegacyAssetsBanner`，只在錢包確實在
  舊合約上有可用保證金或未平倉部位時出現（讀取中、讀取失敗、全空都不出現）。絕大多數使用者
  永遠不會看到它；側邊欄也不加入口。
- **語意不同**：舊合約不屬於現行帳戶，數字不能混進 Portfolio 的淨值 hero、部位頁籤或「空投資組合」
  判斷；混進去會讓「現行帳戶有多少錢」這個問題的答案變得不可信。
- **Portfolio 已 1,170 行**，舊合約的流程（逐合約預檢、需要營運方的原因、客服聯絡）放在獨立頁比較好
  維護，客服也能直接給使用者 `/legacy` 這個連結。
- 只有新合約上是空的使用者（資產全在舊合約）會落到 Portfolio 的空狀態；提示也放在那個空狀態上方，
  因為那正是最需要看到它的人。

### 5.2 安全與行為

- **位址只來自常數** `frontend/src/contracts/legacyExchanges.ts`；頁面不讀 URL 參數、不接受使用者輸入的位址。
  鏈由錢包目前的鏈決定，只列該鏈登記的舊合約。
- 讀取走錢包的 provider（站台 CSP 的 connect-src 只放行 sepolia.base.org；錢包節點不受 CSP 限制）。
- **每個按鈕在送出前重新預檢**（`eth_call`，`from` = 使用者）。預檢失敗就**不送**，toast 與按鈕下方
  顯示原因；按鈕在掃描時預檢失敗就直接 disabled。分類：

| revert | 顯示 | 需要營運方 |
|---|---|---|
| `StalePrice`（更新於 7 天內） | 報價過期，恢復後重試 | 否 |
| `StalePrice`（超過 7 天） | 預言機看來已停止餵價 | 是 |
| FeeRouter `Unauthorized()` | 收費合約已只接受新合約 | 是 |
| InsuranceVault `NotAuthorized()` | 金庫授權已轉移 | 是 |
| `ERC20InsufficientBalance` / OZ v4 字串 | 舊合約 USDC 不足（不是使用者錢包不足） | 是 |
| `InsufficientFreeMargin` / `PositionAlreadyClosed` / `NotPositionOwner` | 狀態已變，請重新整理 | 否 |
| 其他 | 顯示原始 selector | 是 |

- **提領金額** = min(可用保證金, 合約 USDC 餘額)。合約付不出全額時明講差額並列入「需要營運方」。
  這是先到先得：頁面不替任何人保留額度（合約本身也沒有這種機制）。
- 平倉預檢通過、但預言機年齡超過時效上限（合約沒有時效檢查的 Sepolia 舊版）時，顯示「將以該舊價結算」。
- **部位數上限**：早期版本的 `getUserPositions` 只增不減（含已平倉）。每顆合約最多讀最新的 200 個 id；
  超過時不當成「沒有」，而是標記 truncated、在頁面上說明「可能還有更多部位未列出」並列入需要營運方。
  不選擇全部讀完，是因為那可能是上千次循序 eth_call，而超過上限的帳戶極少。
- **讀取失敗**：整顆合約讀取失敗時退避 800ms 重試一次；仍失敗則 /legacy 顯示讀取失敗，Portfolio 只顯示
  一行低調提示（「舊版合約資料暫時讀不到」＋連結）。確認全空時 Portfolio 什麼都不顯示。
- 有任何需要營運方的項目時，顯示租戶設定的客服（`tenant.support.email` / `url`）；default 租戶兩者皆為
  null，頁面明講「尚未設定客服聯絡方式」而不是編造一個。並附上可複製的錢包、合約、部位編號。

### 5.3 檔案

| 檔案 | 內容 |
|---|---|
| `frontend/src/contracts/legacyExchanges.ts` | 舊合約常數表（位址、使用期間、ABI 來源） |
| `frontend/src/lib/pepefi/legacyExchange.ts` | selector 探測、前綴解碼、revert 分類、掃描與預檢（純邏輯） |
| `frontend/src/hooks/useLegacyAssets.ts` | 以錢包 provider 掃描目前鏈的舊合約 |
| `frontend/src/pages/pepefi/LegacyPage.tsx` | `/legacy` 頁 |
| `frontend/src/components/pepefi/LegacyAssetsBanner.tsx` | Portfolio 上的入口 |
| `frontend/src/locales/{zh-TW,en}/legacy.ts` | 字串（en 無漢字，有測試） |

## 6. 限制

- 頁面只掃**錢包目前所在的鏈**；Sepolia 的資產要把錢包切到 Sepolia 才看得到（Portfolio 在 Sepolia 上仍可開啟，
  入口提示也會出現）。
- 價格新鮮度會隨時間變：Base 的舊合約與現行合約共用同一顆 MockOracle，keeper 停擺時舊合約的平倉也會
  `StalePrice`——頁面會照實顯示並請使用者稍後重試，超過 7 天則改列為需要營運方。
- 提領是先到先得；頁面不能、也不嘗試替使用者之間分配不足的餘額。
- 若之後又有重部署，必須把被換下來的位址加進 `legacyExchanges.ts`，否則那批資產不會出現在頁面上。

