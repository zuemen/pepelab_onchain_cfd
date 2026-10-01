# 舊版 PerpetualExchange 盤點與 /legacy 取回頁（P0-08）

> 盤點時間：2026-10-01 05:40 UTC 前後（Base Sepolia 區塊約 47,532,559）。
> 方法：全部是**唯讀**——`eth_getCode`、`eth_call`（含 `from` = 持有人的模擬呼叫）、
> Blockscout 的 logs API。修正方案只在**本機 anvil fork** 上驗證過。沒有對任何公開鏈送出交易。
> 數字是當下的快照，之後會隨使用者提領或 keeper 餵價而變；要重跑請照 §6。

## 1. 結論先講

| 鏈 | 舊合約 | 合約 USDC | 帳上可用保證金合計 | 未平倉 | 使用者能自己取回？ |
|---|---|---:|---:|---:|---|
| Base Sepolia | `0xEf75ECA6…C072`（2026-06-14 → 09-04） | **48,500.00** | **418,459.33** | 0 | 個別可以，但**整體資不抵債**，而且最大債權人是**已外洩的舊部署者金鑰**（§3.1） |
| Base Sepolia | `0xfAEf549C…55cf`（2026-09-04 → 09-10） | 99.70 | 0.0016 | 4（1 人） | 4 筆中 **2 筆平倉必定 revert**，需 owner 改設定（§3.2） |
| Sepolia | `0x00f6cf01…3e0c`（05-06 → 05-11） | 3,000.00 | 2,900.00 | 1 | 可以；持有人是外洩金鑰 |
| Sepolia | `0xb3e978E9…bd1d`（05-11 → 05-12） | 498.50 | 0 | 3 | 可以；持有人是外洩金鑰 |
| Sepolia | `0xdc5cc6ab…06b4`（只在 broadcast，從未接上前端） | 0 | 0 | 0 | 不適用（頁面不列） |
| Sepolia | `0xc100f942…a49c`（05-12 → 05-18） | 1,003.00 | 1,003.00 | 0 | 可以；持有人是外洩金鑰 |
| Sepolia | `0x4cC711AE…31Eb`（05-18 → 05-21） | 920.00 | 719.60 | 1 | 可以（`0xC9B8eB…2f77`，非外洩金鑰） |

先前估的「約 48,500 USDC」就是 `0xEf75` 的合約餘額，數字對；但它**不等於使用者能領回的總額**——
帳上欠使用者 418,459 USDC，合約只有 48,500（§3.1）。

## 2. 位址從哪裡來

- `frontend/src/contracts/addresses.ts` 的 git 歷史（`git log -p -- frontend/src/contracts/addresses.ts`）
  每一次 `PerpetualExchange` 被換掉的舊值。
- `contracts/broadcast/*/84532/` 與 `*/11155111/` 中 `contractName == PerpetualExchange` 的 CREATE。
  Base Sepolia 只有三次（`Deploy.s.sol` → `0xEf75`、`Redeploy102Exchange.s.sol` → `0xfAEf`、
  `Redeploy129Exchange.s.sol` → 現行 `0x827e`），與 addresses.ts 的歷史一致。
- Sepolia 的現行 exchange `0x0c6459d3…c32b` 仍是 addresses.ts 的 Sepolia 值，**不算舊合約**，不列入。

## 3. 每個合約的實測

共同條件（Base 兩顆）：`usdc` = MockUSDC `0x69fd…b035`（18 位小數）、`oracle` = MockOracle
`0xeD90…0Aa3`（與現行 exchange 同一顆，**仍在被 keeper 餵價**：盤點時 4 個標的的 `updatedAt`
約 5.0 小時前）、`maxPriceAge` = 21600（6 小時）、`vaultFeeShareBps` = 0、`insuranceVault`
= `0xB364…D812`、`feeRouter` = `0x00f6…3e0c`（與 Sepolia 第一顆 exchange 位址相同，是不同鏈上的巧合）、owner = `0x27C2…A585`（現任部署者）。
兩顆都**沒有** pause 機制（`paused()` 不存在），所以不會被暫停擋住，也**無法**被暫停。

### 3.1 `0xEf75ECA6514cE96B18382E921aC6190a0cF8c072`（Base，2026-06-14 → 09-04）

- **ABI 來源**：`9f4de1f:frontend/src/contracts/abi/PerpetualExchange.json`（76 個函式）。bytecode
  的 PUSH4 掃描對上 76/76；對 2026-09 版 ABI 只有 75/90 → 這顆就是 6 月版。
- `nextPositionId` = 86，**0 筆未平倉**。
- 可用保證金持有人 15 個（以 Blockscout `MarginDeposited` 16 筆 / 15 個地址交叉核對，加上全部
  position owner，涵蓋完整；USDC 轉入此合約的 15 個 sender 與之相符）：

| 持有人 | 可用保證金 | `withdrawMargin(全額)` 模擬 |
|---|---:|---|
| `0xE80A8136…Eb93`（**2026-08-07 已外洩、被 sweeper 接管的舊部署者**） | 371,947.77 | revert `ERC20InsufficientBalance(…, 48500e18, 371947e18)`；但領 48,500 會成功 |
| `0xfccf06b5…5d77` | 25,242.08 | 成功 |
| `0xd44c744a…c72a` | 10,405.77 | 成功 |
| `0x858b36C7…a972` | 2,793.46 | 成功 |
| `0x77e527e4…580a` | 1,496.50 | 成功 |
| `0x70997970…79C8`（**Anvil／Hardhat 預設帳號 #1，私鑰公開**） | 1,493.00 | 成功 |
| `0x0bdd9454…b97c` | 1,493.00 | 成功 |
| `0x5def0dff…fdd4` | 1,492.68 | 成功 |
| 其餘 7 個 | 各約 299 | 成功 |

- 合計 418,459.33；扣掉外洩金鑰後 **46,511.55 ≤ 48,500**——只要外洩金鑰不先動手，其他 14 個
  持有人**都能全額領回**，頁面也就照這樣提供按鈕。
- **風險（最嚴重）**：外洩金鑰的 freeMargin 來自 whale 種子部位的未實現獲利入帳（沒有現金支撐），
  它單獨就能用 `withdrawMargin(48500e18)` 把合約抽乾（`eth_call` 模擬成功；該地址在 Base Sepolia
  上仍有約 0.00996 ETH，足夠付 gas）。這顆合約**沒有 pause、沒有 owner 提款函式**，owner 擋不住。
- `0x7099…79C8` 的私鑰是公開的測試金鑰，任何人都能把那 1,493 領到該地址（錢仍在那個地址，
  但等於沒有主人）。

### 3.2 `0xfAEf549C687C37064cEaB5728989a839B08955cf`（Base，2026-09-04 → 09-10）

- **ABI 來源**：`680cce2:frontend/src/contracts/abi/PerpetualExchange.json`（90 個函式，PUSH4 對上 90/90）。
- 合約 USDC 99.70；4 筆未平倉，全部屬於 `0x858b…a972`，每筆保證金 24.8253，1×，`copiedFrom`
  = `0x27C2…A585`（策略交易者）。
- `closePosition` 以 owner 身分 `eth_call`：

| id | 標的 | 估值（getPositionValue） | 模擬結果 |
|---:|---|---:|---|
| 0 | sAAPL | 25.16（獲利） | **revert `0x82b42900` = FeeRouter `Unauthorized()`** |
| 1 | sESGU | 24.35（虧損） | 成功 |
| 2 | sGOLD | 22.69（虧損） | 成功 |
| 3 | sETH | 26.53（獲利） | **revert `0x82b42900`** |

- **原因**：獲利的跟單部位平倉時要付 10% 績效費，舊合約呼叫 `feeRouter.receivePerformanceFee`；
  但 FeeRouter 的 `exchange` 已在 #129 改成現行 `0x827e…124D`，`onlyAuthorized` 拒絕舊合約。
  這與價格無關——預言機在盤點時是新鮮的。
- 可用保證金 0.0016，提領模擬成功。

### 3.3 Sepolia 四顆

- 都沒有 `maxPriceAge`、也不檢查價格時效（盤點時預言機已 3,200–3,550 小時未更新，平倉模擬**仍成功**）
  → 平倉會以幾個月前的舊價結算。頁面在這種情況下顯示「以該價格結算」的警告而不是擋下。
- 各自用自己的 MockUSDC 與 MockOracle（每次 Sepolia 部署都重部署一組）。
- `0x00f6`、`0xb3e9`、`0xc100` 上的資產全屬外洩金鑰 `0xE80A…`；`0x4cC7` 上 `0xC9B8…2f77`
  有 719.60 可用保證金與 1 筆 200 保證金的部位，提領與平倉模擬都成功。
- ABI：這幾版的 `positions(uint256)` 只有 11 或 13 個欄位；頁面一律只解共同的前 11 欄（§4）。

## 4. ABI 相容性的處理

Position struct 從第一版（`597eff3`，11 欄）到 2026-09 版（16 欄）**一直是尾端追加**，前 11 欄
`id, owner, asset, isLong, entryPrice, margin, leverage, openedAt, closedAt, realizedPnL, isOpen`
的位置從未變過。所有版本的 `positions` 都是 public mapping（全靜態欄位 → getter 攤平成連續 word），
所以頁面不帶任何一版的完整 ABI，只：

1. `eth_getCode` 後掃 PUSH4，確認 `freeMargin / getUserPositions / positions / withdrawMargin /
   closePosition` 存在（缺任何一個讀取函式就標成 unsupported，不會誤報「沒有資產」）；
2. `positions(id)` 回傳只切前 11 個 word 解碼；
3. `usdc()`、`oracle()`、`maxPriceAge()` 有才讀，沒有就略過（Sepolia 早期版沒有 `maxPriceAge`）。

測試以兩顆真實舊合約的 runtime bytecode（`frontend/src/lib/pepefi/__fixtures__/legacyBytecode.json`）
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

## 6. 需要合約 owner（`0x27C2…A585`）處理的事項

> 這裡只列**現有合約邏輯下**可做的操作與風險，不涉及任何合約修改。執行者需要持有 Base Sepolia
> 部署者金鑰（見 `docs/DEPLOY_129_CUTOVER.md` §金鑰在哪）。

### 6.1 `0xfAEf` 的兩筆獲利部位無法平倉（id 0、3）

- **建議操作**：在舊合約上 `setFeeRouter(address(0))`。
  ```bash
  cast send 0xfAEf549C687C37064cEaB5728989a839B08955cf "setFeeRouter(address)" 0x0000000000000000000000000000000000000000 \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"
  ```
- **已在 anvil fork 驗證**（fork Base Sepolia 47,532,559，impersonate owner 與使用者）：設定前 id 0 平倉
  revert `0x82b42900`；設定後 id 0–3 四筆平倉全部成功，平倉後可用保證金 98.74，全額提領成功
  （合約餘額 99.70 足夠）。
- **效果與風險**：`feeRouter == 0` 時舊合約略過績效費，策略交易者 `0x27C2…`（即部署者本人）收不到這兩筆
  的績效費（獲利的 10%，依盤點時估值合計約 0.2 USDC）；不影響現行 exchange（FeeRouter 本身不動）。
- **不建議的替代方案**：把 FeeRouter 的 `exchange` 暫時改回 `0xfAEf`——那會讓現行 exchange 的所有獲利跟單
  平倉同時失敗。

### 6.2 `0xEf75` 資不抵債，且外洩金鑰可以一次抽乾

- 現有邏輯下 **owner 沒有任何能保護使用者資金的操作**：沒有 pause、沒有 owner 提款、`withdrawMargin`
  只看 `freeMargin[msg.sender]`。owner 能動的參數（fee、maxPriceAge、insuranceVault…）都不影響提領。
- 能做的只有營運面：
  1. **通知 14 個非外洩持有人盡快提領**（他們合計 46,511.55 < 48,500，現在都領得到）。頁面已提供按鈕。
  2. 若外洩金鑰先把合約抽乾，剩下的持有人只能由營運方**另外以現行合約之外的方式補償**（例如從 treasury
     轉 MockUSDC 給受影響地址）。這是營運決策，本次不處理。
  3. 外洩金鑰帳上 371,947.77 的 freeMargin 不是真實存款（whale 種子部位的帳面獲利），補償計算時應排除。
- `0x7099…79C8`（公開測試金鑰）的 1,493 任何人都能代領到該地址；若它代表某位真實使用者的種子資金，
  也需要營運方另行處理。

### 6.3 Sepolia 舊合約

- 不需要 owner 操作即可提領／平倉；但幾乎全屬外洩金鑰，且平倉以數月前的舊價結算。是否值得處理由營運方決定。

## 7. 限制

- 頁面只掃**錢包目前所在的鏈**；Sepolia 的資產要把錢包切到 Sepolia 才看得到（Portfolio 在 Sepolia 上仍可開啟，
  入口提示也會出現）。
- 價格新鮮度會隨時間變：Base 的舊合約與現行合約共用同一顆 MockOracle，keeper 停擺時舊合約的平倉也會
  `StalePrice`——頁面會照實顯示並請使用者稍後重試，超過 7 天則改列為需要營運方。
- 提領是先到先得；頁面不能、也不嘗試替使用者之間分配不足的餘額。
- 若之後又有重部署，必須把被換下來的位址加進 `legacyExchanges.ts`，否則那批資產不會出現在頁面上。

## 8. 重跑盤點

唯讀即可，不需要金鑰：

```bash
# 合約餘額與設定
cast call 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035 "balanceOf(address)(uint256)" 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 --rpc-url https://sepolia.base.org
# 某持有人的可用保證金與提領模擬（eth_call，不送交易）
cast call 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 "freeMargin(address)(uint256)" <holder> --rpc-url https://sepolia.base.org
cast call 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 "withdrawMargin(uint256)" <amount> --from <holder> --rpc-url https://sepolia.base.org
# 平倉模擬
cast call 0xfAEf549C687C37064cEaB5728989a839B08955cf "closePosition(uint256)" 0 --from 0x858b36C788296051b09512fC6cE9EdBEeF0bA972 --rpc-url https://sepolia.base.org
# 存款人清單（Blockscout，MarginDeposited topic0）
curl "https://base-sepolia.blockscout.com/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072&topic0=0xb304afd20907e7dbaaffb07ac380853fbc6233b4bd4c9e1b46af07bc5f4ca9e2"
```
