---
status: accepted
date: 2026-10-16
issue: "#331（#309 之後的系統改動之一）"
amended_by: "ADR-024（2026-10-26）：決定第 5 點的「不做持續跟單」"
---

# 專題主軸改為 Web3 版 eToro：給一般投資人的社交交易，只支援使用者自管；B2B 白標降為未來延伸

> **2026-10-26 修訂**：決定第 5 點的「不做持續跟單」由 [ADR-024](./ADR-024-copy-auto-sync.md) 取代——跟隨者可以在鏈上
> 同意「自動同步」，之後任何人都能、也只能把他的部位調成交易者鏈上最新版。自動停損仍然不做。其餘決定不變。

README、首頁與搜尋結果裡的介紹，原本把 PepeFi 定位成「給持牌金融機構的 B2B 白標基礎設施」。評審要的是給一般投資人用的
Web3 版 eToro：社交交易、鏈上透明、ESG、GameFi。兩套說法並存時，簡報與文件無從下筆。評審也直接問過「資產該由平台託管、
使用者自管，還是兩者都支援」，平台沒有任何地方回答。

另一個矛盾：公開展示站的跟單預設是關的（#192 為商業版關掉）。以社交交易為主軸、卻在首頁看不到跟單，說法自相矛盾。

## 決定

2026-10-14 擁有者決定，本 ADR 正式記錄：

1. **對外主軸是 Web3 版 eToro。** 首頁以「平台特色」六張卡依序介紹社交交易、整合四大資產、鏈上透明、ESG、GameFi、
   Agent 原生（x402 與 agent session）；每張卡寫「痛點 → 我們的做法」，要解決的問題與功能在同一處講完，不分兩段重複。首頁一開始就說
   「跟著透明的交易者投資」。README 第一章、meta 標題與描述同步改寫。
2. **只支援使用者自管，不提供託管帳戶。** 平台不持有使用者私鑰、沒有代管錢包。理由見下一節。
3. **B2B 白標保留，降為「未來延伸」。** 租戶隔離（[ADR-008](./ADR-008-tenant-isolation.md)）與白標設定層
   （[frontend ADR-0009](../frontend/docs/adr/0009-tenant-config-layer.md)）的架構一行都不變，只是不再是主軸。
   跟單旗標關閉的租戶（`demo-bank`、`rwa-poc`）的功能上限與預設值不變，主視覺、標題與 meta 沿用原本代幣化資產的說法；
   跟單旗標關閉的租戶不放社交交易卡，整合四大資產排第一；GameFi 未授權的租戶也不放 GameFi 卡。
4. **AI agent 與 x402 功能維持現狀**，首頁合成一張「Agent 原生」卡介紹，功能不動。
5. **不做持續跟單、不做自動停損。** 跟單維持快照式：複製交易者當下那一版策略、開倉一次。
   （2026-10-26 被 [ADR-024](./ADR-024-copy-auto-sync.md) 修訂：持續跟單改為跟隨者在鏈上同意的自動同步；自動停損仍不做。）

被取代的說法：README 舊版的「**定位**：PepeFi 規劃以 B2B 白標形式……提供給持牌金融機構」、首頁「RWA 現貨排第一是為了
來評估的機構」的排序理由、`web/index.html` 的「Target customer: Licensed institutions (white-label)」。

## 「你的資產在哪裡」：只陳述合約上驗證得到的事實

這段說明在首頁，Simple 與 Expert 模式都看得到，各用自己的詞彙（Simple 不出現槓桿、清算、交易者、跟單）。
文字在 String Catalog 的 `custody`，選句子的規則在 `frontend/src/lib/pepefi/custody.ts`。

**使用者自己掌握的：**

| 事實 | 合約依據 |
|---|---|
| 保證金存在交易所合約、記在使用者名下，只有本人能提領 | `PerpetualExchange.freeMargin[user]`；`withdrawMargin` 只扣 `msg.sender` 的餘額 |
| 開平倉只能由本人，或經授權的代理合約（跟單合約、agent session）代為執行 | `openPositionFor`／`closePositionFor` 只收 `authorizedAgents`；`closePositionFor` 只能平自己開的那一筆（`positionAgent`） |
| agent session 有額度上限，本人隨時可撤銷 | `AgentSessionManager.revokeSession` 只有 `s.user` 能呼叫 |
| 跟單開出的部位在跟隨者自己名下，取消只有本人能按；交易者只依合約收跟單費與獲利分成，不能動用保證金 | `CopyTracker._follow` 以 `openPositionFor(msg.sender, …)` 開倉；`unfollowAndCloseAll` 只看 `copyRecords[msg.sender]` |
| 例外：保證金不足時任何人都能依規則清算；owner 開啟自動減倉（ADL）時，獲利部位可能被強制平倉並扣一部分獲利 | `liquidatePosition` 沒有呼叫者限制；`setAdlEnabled` |
| 現貨代幣在使用者自己的錢包；贖回只能由本人發起，但金庫非足額抵押，USDC 不夠時贖回失敗 | `AssetVaultV2` 的 `mint` 把代幣鑄給呼叫者；`redeem` 燒呼叫者自己的代幣，金庫餘額不足時 revert `VaultDry` |
| 平台不持有使用者私鑰 | 前端只透過使用者錢包簽名，沒有任何代管錢包或伺服器端簽名路徑 |

**營運方仍然保有的權限（照實列出，「自管」不等於「完全不需信任」）：**

- 合約 owner 是**單一金鑰**，沒有多簽、沒有 timelock（與 README §5 一致）。
- owner 與 guardian 都能暫停交易所（guardian 的暫停會到期，owner 的不會），金庫的 `PAUSER_ROLE` 能暫停金庫。暫停期間
  `closePosition`、`withdrawMargin`、`redeem` 都會被擋（都是 `whenNotPaused`）。
- owner 可以把單一標的設成 `Halted`（`setAssetMode`），凍結期間開倉、平倉、清算都停；也可以開啟自動減倉（`setAdlEnabled`）。
- 可以調整費率、槓桿上限等參數，也決定哪些代理合約能代使用者開平倉（`setCopyTracker`、`setAgentAuthorized`）。
- `AssetVaultV2` 是 UUPS proxy，`DEFAULT_ADMIN_ROLE` 可以升級實作；`SyntheticAssetV2` 的 `MINTER_ROLE` 可以 `burn(from, …)`，
  管理者可以授權這個角色。
- 交易所讀取的價格由受信任的 keeper 寫入 `MockOracle`，不是去中心化預言機。

### 為什麼不提供託管帳戶

託管代表營運方能動用使用者的資金，使用者只能相信營運方的帳本；那需要牌照、稽核與隔離帳戶，本專案一項都沒有。
自管讓每一筆保證金與部位都在鏈上看得到，與「鏈上透明」這個特色是同一件事。這是設計選擇，不是缺功能。

### 與 eToro 的差別

- **跟單是快照，不是持續跟隨。** `CopyTracker` 在跟單當下讀交易者最新一版策略、依比例開倉一次；交易者之後改版，
  跟隨者的部位不會跟著變（Portfolio 會標示「策略已更新」，#309）。
- **沒有自動停損。** 有停損提醒（#324），只存在使用者的瀏覽器，到了不會自動平倉。

兩者都需要改合約、或由營運方代使用者下單：持續跟隨要讓某個合約在使用者不在場時替他開新部位，自動停損要有人在價格到達時
替他平倉。前者擴大代理合約的權限，後者讓營運方成為下單者，都與「使用者自管」的取捨衝突。

> **2026-10-26 修訂（ADR-024）**：持續跟隨改用「改合約」的方式做到，而且不擴大任何人的裁量：跟隨者在鏈上同意後，
> `CopyTracker.resyncFor` 任何人都能呼叫，但只能把部位調成交易者鏈上最新版，呼叫者沒有任何參數可選，營運方也不替任何人簽名。
> 第一點因此改為「跟單可以持續跟隨（需跟隨者同意、由任何人觸發）」；第二點不變。更新後的差異見 ADR-024「與 eToro 的差別」。

## 畫面與設定的改動

- `frontend/src/tenant/tenants/default.json`：`copyTrading` 改為 `{ allowed: true, default: true }`，比照 2026-10-12
  把 GameFi 改回預設開的做法。`demo-bank`、`rwa-poc` 的上限與預設值不動（`allowed: false`）。環境變數
  `VITE_FEATURE_COPY_TRADING=0` 仍可關閉。
- 首頁「平台特色」卡的順序由 `frontend/src/lib/pepefi/landingFeatures.ts` 決定，文字（標題、痛點、做法）在 `landing.features.<key>`。
- meta 標題與描述依跟單旗標選用（`meta.title`／`meta.titleNoCopy`、`meta.description`／`meta.descriptionNoCopy`）。
- 跟單文案守門（`copyWording.test.ts`）原本在跟單旗標開啟時整組跳過；平台站改為預設開之後它會永遠不跑，所以改成
  不論當前旗標一律檢查。

## Considered options

- **維持 B2B 白標為主軸，另外寫一份 eToro 版簡報。** 否決：文件、首頁、meta 會跟簡報講兩套話，正是這次要解決的問題。
- **同時支援託管與自管。** 否決：託管需要牌照、KYC／AML 與帳本稽核，本專案沒有；做一個「看起來像託管」的模式會讓
  使用者以為有人替他保管資產。
- **做持續跟單與自動停損，讓功能對齊 eToro。** 否決：需要改合約或由營運方代為下單，與自管衝突；列為與 eToro 的差別
  誠實寫出。（持續跟單的部分已由 ADR-024 以合約強制、無需信任的方式重新決定。）
- **公開站維持跟單預設關。** 可行但否決：主軸是社交交易，首頁卻看不到跟單。若日後希望公開站回到保守設定，只要把
  `default.json` 的 `copyTrading.default` 改回 `false`，本 ADR 其他部分不受影響。

## 後果

- Base Sepolia 上只有少量種子交易者，公開站開啟跟單後排行榜會很空。展示一律用本機鏈；公開站的空狀態照實顯示，
  不放假資料。
- 白標租戶的功能上限與預設值不變（首頁功能卡的組合跟著平台站調整，見「決定」第 3 點）；`frontend/src/tenant/branding.test.ts` 的 default 租戶快照只有 `copyTrading` 一欄改變。
