---
status: proposed
date: 2026-10-02
plan-item: P3-09
---

# 價格改用簽名的 pull oracle：Pyth 為主、Chainlink 推送價為交叉比對，keeper 只轉送簽名資料；限速與凍結改為熔斷，新鮮度改看來源時間

> 2026-10-02。本文只是設計，**沒有任何程式或部署變動**。外部資料的查詢日期都是 2026-10-02（標「鏈上實測」的是以唯讀 RPC 查詢，未送交易）；
> 標 **未查證** 的項目沒有找到可靠來源。合約升級架構見 [ADR-015](ADR-015-v3-upgradeability.md)，keeper 金鑰見 [ADR-014](ADR-014-signer-custody-kms-mpc.md)，
> 休市跳空的損失吸收見 [ADR-012](ADR-012-junior-buffer-tranches.md)。標 **【待擁有者決定】** 的項目本 ADR 不替擁有者做決定。

## 1. 背景

### 1.1 現在的價格從哪裡來

- keeper 從 CoinGecko（加密）與 Yahoo chart（其他）抓價（`agent/keeper/feeds.ts:1-4`、`:14-28`），每 15 分鐘或偏離 0.1% 時寫入（`agent/keeper/run.ts:61-62`；`agent/keeper/core.ts:41-63`）。
- 第二來源只有 sBTC、sETH，而且只在大幅變動時才抓（`feeds.ts:30-38`）。偏離超過 20% 時需要 ≥ 2 個新鮮來源、彼此差 ≤ 2%，否則拒寫；**股票只有單一來源，跳空一律要人工處置**（`core.ts:79-101`、`:161-168`）。
- 平台的 keeper 每輪對兩顆 oracle 都寫（`agent/keeper/round.ts:242-243`）：`MockOracle.updatePrice`（owner＝keeper，`contracts/src/MockOracle.sol:64`）與 `GuardedOracle.updatePrice`（KEEPER_ROLE，`contracts/src/v2/GuardedOracle.sol:280`）。兩者都以 `block.timestamp` 當 `updatedAt`（`MockOracle.sol:72`、`GuardedOracle.sol:376`）——鏈上的時間是**寫入時間**，不是行情時間。
- **平台現行的 exchange 讀的是 MockOracle**，它沒有任何偏離上限（`docs/KNOWN_LIMITATIONS.md:116-119` #3；`docs/ROLE_SEPARATION.md:26-31`；`ops/monitoring/rules.md:743`；`agent/keeper/core.ts:70-74`）；GuardedOracle 由 V2 金庫讀取，**租戶**的 exchange 也讀 GuardedOracle（`docs/ADR-008-tenant-isolation.md:36`）。
- sBTC、sETH 另有鏈上 relay 設定：`base-sepolia-keeper.yml` 設了 `KEEPER_RELAY_SOURCE` 指向 AggregatorOracle，有值時先讀鏈上、讀不到退回行情 API（`.github/workflows/base-sepolia-keeper.yml:64-71`；`agent/keeper/round.ts:156-171`）。workflow 的註解自己寫明這是「受信任的中繼」，keeper 金鑰仍可寫任何值。`docs/KNOWN_LIMITATIONS.md:105` 寫「the relay has never been switched on in CI」，與 workflow 不一致，要另外修正（不在本 PR）。
- 排程：GitHub Actions 名目每 15 分鐘，實測間隔 68–169 分鐘，曾 4.5 小時沒跑；另有 Cloudflare Worker 每 20 分鐘補觸發（`.github/workflows/base-sepolia-keeper.yml:25-29`）。
- keeper 持有寫價的權限：價格的正確性依賴「keeper 抓對、沒被盜」。RISK_WATERFALL 把這列為客戶要自己接受的信任假設（`docs/RISK_WATERFALL.md:145`）。keeper 被盜時：
  - **平台（exchange 讀 MockOracle）**：可以寫任意價格，下游全部受影響（KNOWN_LIMITATIONS #3）。
  - **租戶（exchange 讀 GuardedOracle）**：只能在單次與時間窗上限內寫，且 guardian 可凍結。

### 1.2 GuardedOracle 的保護

| 機制 | 行為 | 證據 |
|---|---|---|
| 單次偏離上限 | 預設 10%，上限 50% | `GuardedOracle.sol:91`、`:508-516` |
| 時間窗累計上限 | `windowDuration`／`maxWindowDeviationBps`，預設 0（關），5 分鐘到 7 天 | `:120-121`、`:522-526`、`:330-361` |
| 參考來源 | 與參考價一致時繞過單次上限與時間窗；不一致時只准往參考價收斂；參考來源掛掉時只套單次上限 | `:531`、`:313-331`、`:670-680` |
| guardian 凍結／暫停 | 72 小時到期、24 小時冷卻（#219，只有原始碼） | `:51`、`:57` |
| admin 接手 | `takeOverAssetFreeze`、`takeOverPause`；admin 自己下的凍結沒有期限 | `:495`、`:501`、`:613-619` |
| `maxPriceAge` | 預設 1 小時；設 0 就不檢查（租戶就是 0）；凍結期間 `isStale` 回 true | `:94`、`:186-202`；`docs/ADR-008-tenant-isolation.md` 「oracle 與 keeper」節 |

限速在跳空時的行為（`GuardedOracle.sol:290-335` 的 M-2 註解與實作）：過去「單次上限」與「必須接近參考價」兩個條件在大跳空時無解；M-2 已修正**有參考價時**的矛盾——參考價確認時繞過單次上限，「A real 30% gap lands in one call」。但**參考來源失效時**（現況，§1.3）只剩單次上限（`:315-316`、`:331-335`），加上 keeper 的熔斷是「寫完整價格或不寫」、不分段逼近（`agent/keeper/core.ts:79-96`），超過 10% 的跳空仍會讓 GuardedOracle 停在跳空前的價格。限速對付的是「keeper 被盜亂寫」；換成簽名價格之後這個威脅消失，限速只剩這個副作用。

#219（凍結到期）只有原始碼；GuardedOracle 不可升級，要以 `RedeployGuardedOracle.s.sol` 部署新的一顆。V2 金庫以 `setOracle` 改指新 oracle 即可生效；**讀 GuardedOracle 的 exchange（`ORACLE_KIND=guarded`，也就是租戶的 exchange）**則因為 oracle 是 immutable（`contracts/src/PerpetualExchange.sol:152`），要等 exchange 重部署（`docs/KNOWN_LIMITATIONS.md:926-932`）。

### 1.3 交叉比對目前是壞的

`AggregatorOracleAdapter` 是雙源設計：差距 1% 內取較新者、1–20% 為 degraded、超過 20% fail-closed（`contracts/src/AggregatorOracleAdapter.sol:29-41`、`:91-97`）。2026-10-01 唯讀實測，它**對所有資產都 revert**（`NoLiveSource`），監控的價格偏離規則因此沒有參考價、持續發 SEV-3（`docs/ADR-009-monitoring.md:104`；`ops/monitoring/rules.md:743`）。部署版的 Aggregator 還是舊版（`ops/monitoring/rules.md:577`）。

repo 裡已有 Pyth 與 Chainlink adapter，但都只部署在 Base Sepolia 作展示、沒有接上 live exchange（`docs/CAPSTONE_DELIVERABLES.md:57-66`）：

- `PythOracleAdapter` 用 `getPriceUnsafe`＋自己的 1 小時新鮮度檢查、`maxConfBps = 100` 的信賴區間檢查、expo 正規化成 8 位小數（`contracts/src/PythOracleAdapter.sol:33-39`、`:52`、`:104-114`、`:137`）。**整個 repo 沒有任何程式呼叫 `updatePriceFeeds`**（`PythOracleAdapter.sol:7` 只在註解提到）——也就是說它只會讀到別人推上鏈的價格。
- `DeployWithPyth.s.sol` 寫死的 Base Sepolia Pyth 位址是 `0xA2aa…5729`（`contracts/script/DeployWithPyth.s.sol:96`），不是 Pyth 官方頁列出的升級版位址。依官方頁應改用升級版位址；舊位址是否接受新 payload **未查證**——官方頁同時寫了「Each endpoint's payloads verify only on its own contract generation」與「Your current contract was upgraded in place. It accepts the new data payloads automatically.」，兩句有歧義（§2.1）。
- `ChainlinkOracleAdapter` 以 `latestRoundData` 加 round 完整性與 1 小時新鮮度檢查（`contracts/src/ChainlinkOracleAdapter.sol:32-51`）。

### 1.4 `maxPriceAge` 與 heartbeat

| 讀者 | `maxPriceAge` | 證據 |
|---|---|---|
| exchange（部署版） | 21600 秒（6 小時）；原始碼預設 24 小時、上限 7 天、不收 0 | `docs/RISK_WATERFALL.md:21`；`PerpetualExchange.sol:139`、`:805-806`、`:70` |
| exchange 讀價 | `block.timestamp > updatedAt + maxPriceAge` 就 revert `StalePrice`，開倉、平倉、清算都一樣 | `PerpetualExchange.sol:1718-1735` |
| V2 金庫（部署版） | 30 天；改 6 小時尚未上鏈 | `.github/workflows/base-sepolia-keeper.yml:72-74`；`docs/DEPLOY_130_CUTOVER.md:181` |
| 監控 | 加密 4 小時預警；非加密 72 小時 | `ops/monitoring/rules.md:105-106` |

### 1.5 休市

商業化計畫的 P1-11 是「休市靠價格過期停單」。以下是**截至 master `17ec739` 的行為**；這個問題的修正正在另一個分支（`fix/market-hours-staleness`）進行，`KNOWN_LIMITATIONS.md` 的對應條目也由那個分支補上。在 `17ec739` 上，這條路不會在一般週末觸發：

- keeper 接受 4 天內的 Yahoo 報價，超過才拒寫（`agent/keeper/feeds.ts:76`、`:132-140`）。
- 報價是舊的時候，keeper 只發警告、價格照寫——程式註解寫明「價格照寫（否則週末會全部跳過）」「鏈上 updatedAt 會顯示新鮮，但價格並非即時」（`agent/keeper/round.ts:233-240`）。heartbeat 每 15 分鐘以新的區塊時間重寫**最後收盤價**（`core.ts:60-62`）。鏈上的 `updatedAt` 因此一直是新的，exchange 的 6 小時過期檢查不會觸發。
- 週五收盤到週一開盤約 65.5 小時、三天連假約 89.5 小時，都小於 4 天；只有更長的休市才會讓 keeper 拒寫，再過 6 小時 exchange 才停單。
- 另一條路是 marketOperator 依市場時段把股票類切 ReduceOnly（`agent/keeper/operator.ts:1-10`、`agent/keeper/market.ts:1-35`），預設關閉，而且部署版 exchange 沒有 `setAssetMode`。

也就是說，在 `17ec739` 上週末仍可以對著週五收盤價開倉——`operator.ts` 的檔頭註解把這件事寫得很清楚：「允許新開倉等於讓人對著一個已知過時的價格下注」。**新鮮度要看「行情時間」才有意義**，這正是簽名價格（帶來源的 `publishTime`）能補上的。

### 1.6 資產

11 檔（`agent/keeper/feeds.ts:14-28`；`agent/keeper/market.ts:16-28`）：sBTC、sETH（加密）；sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL（美股）；sBOND（BGRN）、sICLN、sESGU（ETF）；sGOLD（`GC=F`，COMEX 黃金期貨）。沒有 FX；碳權只有分級登記、沒有價格（`contracts/script/Deploy102CarbonRegistry.s.sol:10-28`）。

## 2. 候選方案在 Base 上的實際可用性（查證）

**鏈上實測 A**：2026-10-02 以公開 RPC 唯讀查詢（Base 主網區塊約 52,071,249；Base Sepolia 區塊約 47,581,778），指令形式為
`cast call <位址> 'singleUpdateFeeInWei()(uint256)' --rpc-url https://mainnet.base.org`（另有 `'version()(string)'`、Pro 的 `'verification_fee()(uint256)'`；Base Sepolia 用 `https://sepolia.base.org`）。查詢未指定區塊，結果是當下的 latest。

### 2.1 Pyth

| 事實 | 值 | 來源 |
|---|---|---|
| 2026-08-26 升級 | 「Pyth Core upgraded on August 26, 2026 at 16:00 UTC」；**所有 Hermes 使用者都需要 API key** | <https://docs.pyth.network/price-feeds/core/upgrade/preparing> |
| 介面 | 升級後的合約保留 Core 介面、feed ID 不變。同一頁同時寫了「Each endpoint's payloads verify only on its own contract generation」與「Your current contract was upgraded in place. It accepts the new data payloads automatically.」，兩句有歧義；本文一律以「改用升級版位址」為準 | <https://docs.pyth.network/price-feeds/core/upgrade/contracts> |
| Base 主網位址 | Core（升級版）`0xbC16aee60f64864882BC6C4E428e148Fc0E272F5`；Pro `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | 同上 |
| Base Sepolia 位址 | Core（升級版）`0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83`；Pro 同上 | 同上 |
| 舊合約 | 升級頁的「Core (current)」欄對 Base 是「—」；`0x8250…487a` 在 Base 主網仍有程式碼，`version()` 回 `1.4.6`（鏈上實測 A）。同一個位址在該頁也出現在其他鏈的升級版欄位（Pyth 在多條鏈用同一位址）。**舊合約是否還接受新 Hermes 的 payload：未查證** | 同上；鏈上實測 A |
| 鏈上更新費 | 「The Pyth Core update fee is 0 across all mainnet EVM chains」（OP-PIP-128）。鏈上實測：Base 主網升級版 Core 為 0（`version()` 回 `1.4.5-alpha.1`）；Base Sepolia 舊合約 `0xA2aa…5729` 為 10 wei、升級版 0；Pro 的 `verification_fee()` 在兩條鏈都是 1 wei（鏈上實測 A） | <https://docs.pyth.network/price-feeds/core/current-fees>；鏈上實測 A |
| 價格結構 | `price`、`conf`、`expo`、`publishTime` | <https://github.com/pyth-network/pyth-crosschain/blob/main/target_chains/ethereum/sdk/solidity/PythStructs.sol> |
| Pro 頻道與欄位 | real-time 與 50／200／1000 ms 頻道；payload 有 confidence、exponent、`marketSession`（regular／preMarket／postMarket／overNight／closed）、bid／ask（官方標為實驗性）；Pro 不在鏈上存價格，要在同一筆交易裡驗證 | <https://docs.pyth.network/price-feeds/pro/how-lazer-works>、<https://docs.pyth.network/price-feeds/pro/payload-reference>、<https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/evm> |
| 訂閱費 | Free $0（10 秒、只能檢視）；Starter $500／月（1 秒、只有加密）；Pro $2,500／月起（全部資產）。分項：美股 $5,000／月、FX $5,000／月、全資產 $10,000／月。**這些方案與「鏈上使用 Core 的 Hermes payload」的對應關係：未查證，需洽詢** | <https://app.pyth.com/plans>、<https://www.pyth.network/blog/the-pyth-core-upgrade> |
| 更新頻率 | 升級後 Core 的實際更新頻率：**未查證** | — |
| Hermes 限流 | Pro 依合約約定；升級後 Hermes 的公開限流數字：**未查證** | <https://docs.pyth.network/price-feeds/core/rate-limits> |
| 交易時段 | 美股平日 9:30–16:00 ET（盤前 4:00–9:30、盤後 16:00–20:00）；FX 週日 17:00 到週五 17:00 ET；金屬週日 18:00 到週五 17:00 ET，週一到週四 17:00–18:00 ET 維護；WTI、Brent 也有維護窗口。best-practices 頁：Pyth 依各資產類別的傳統交易時段；SDK 預設有 staleness check；更新停滯或信賴區間過寬時「pause new position openings」。延伸時段美股 2026-06-15 起移到 Pro | <https://docs.pyth.network/price-feeds/core/market-hours>、<https://docs.pyth.network/price-feeds/core/best-practices>、<https://www.pyth.network/blog/extended-hours-us-equity-data-moves-to-pyth-pro> |

### 2.2 Chainlink

| 事實 | 值 | 來源 |
|---|---|---|
| Base 主網 Data Feeds（push） | 188 筆 feed、170 個不重複名稱（BTC、ETH 各有多筆）（2026-10-02 讀取目錄 JSON）。BTC/USD heartbeat 1200 秒、偏離 0.1%；ETH/USD 1200 秒、0.15%；XAU/USD 86400 秒、0.5%；EUR/USD 3600 秒、0.1% | <https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json>（Chainlink 的公開 feed 目錄 JSON；它與 data.chain.link 網頁的關係**未查證**） |
| Base 主網的股票 feed | 名稱是「Coinbase AAPL」「Coinbase TSLA」「Coinbase NVDA」「Coinbase MSFT」「Coinbase GOOGL」等，市場時段 `us_equities_24/5`、heartbeat 86400 秒、偏離 0.5%。目錄中繼資料是 `productTypeCode: "primaryTokenizedPrice"`、`baseAssetEntityId: "crypto-CBAAPL"`（以 AAPL 為例）——**報的是代幣化商品的價格，不是現股價格** | 同上 |
| Base Sepolia Data Feeds | 只有 9 個，全是加密（DAI、BTC、LINK、CBETH、ETH、USDT、USDC 等） | <https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia-base-1.json> |
| Data Streams verifier proxy | Base 主網 `0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a`；Base Sepolia `0x8Ac491b7c118a0cdcF048e0f707247fD8C9575f9` | <https://github.com/smartcontractkit/documentation/blob/main/src/features/feeds/data/StreamsNetworksData.ts> |
| Data Streams 收費 | 「All Data Streams subscriptions are paid. There is no free account tier」；單一 feed $150／月起，30 天週期，不按比例；鏈上驗證不需要 LINK | <https://docs.chain.link/data-streams/sign-up>、<https://docs.chain.link/data-streams/llms-full.txt> |
| 報告欄位 | v3：price／bid／ask，沒有 confidence；v8：midPrice、`marketStatus`（0 未知、1 休市、2 開盤）；v11：mid／bid／ask／volume／lastTradedPrice、`marketStatus`（0–5，休市值是 5，與 v8 的對照不同，實作時不能共用），官方建議用 `marketStatus` 判斷是否開盤、不要看時間戳 | <https://docs.chain.link/data-streams/reference/report-schema-v3>、<https://docs.chain.link/data-streams/reference/report-schema-v8>、<https://docs.chain.link/data-streams/reference/report-schema-v11> |
| Base 上 Data Streams 可用的 stream 清單、測試網是否收費、更新延遲 | **未查證** | — |

### 2.3 其他

| 方案 | 事實 | 來源 |
|---|---|---|
| Stork | Base 主網與 Base Sepolia 都是 `0x647DFd812BC1e116c6992CB2bC353b2112176fD6`；資產覆蓋**未查證** | <https://docs.stork.network/resources/contract-addresses/evm> |
| RedStone Core（pull） | 消費合約繼承 `ConsumerBase`、在合約內驗簽；Base 的資產覆蓋**未查證** | <https://docs.redstone.finance/docs/dapps/redstone-pull/> |
| Chronicle | 讀取要先加入白名單；覆蓋**未查證** | <https://docs.chroniclelabs.org/Developers/Guides/whitelistAddress> |
| Switchboard | 官方 EVM 位址表沒有 Base | <https://docs.switchboard.xyz/docs-by-chain/evm> |

### 2.4 業界做法

- **GMX v2**：兩步執行。使用者先送請求，keeper 再把已簽名的價格與請求一起送上鏈；以 Data Streams 的 bid／ask 作為 min／max 價格，合約端呼叫 verifier 驗證。<https://github.com/gmx-io/gmx-synthetics/blob/main/README.md>、<https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/oracle/ChainlinkDataStreamProvider.sol>
- **Synthetix v3**：repo 裡有 `PythERC7412Wrapper`（<https://github.com/Synthetixio/synthetix-v3/tree/main/auxiliary/PythERC7412Wrapper>），Base 上線文章只寫「low-latency oracles」（<https://blog.synthetix.io/synthetix-v3-on-base/>）。Base 正式環境是否以 Pyth 搭配 keeper 結算：**未查證**。
- **Gains Network**：Medium 文章寫 gTrade 以自建的 DON 做價格驗證，並宣布整合 Data Streams（<https://medium.com/gains-network/gtrade-is-integrating-chainlinks-ccip-data-streams-to-bring-you-the-best-in-on-chain-leveraged-ac3c88b7bb5c>）。熔斷門檻與目前在 Base 正式環境用哪一套：**未查證**。

### 2.5 資產覆蓋率（本專案的 11 檔）

| 資產（keeper 現用來源） | Pyth（Hermes 中繼資料，2026-10-02 查詢） | Chainlink Base 主網 push feed | Data Streams on Base |
|---|---|---|---|
| sBTC、sETH | ✓ `Crypto.BTC/USD`、`Crypto.ETH/USD` | ✓（1200 秒） | 未查證 |
| sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL | ✓ `Equity.US.<代號>/USD` | △「Coinbase <代號>」：代幣化商品價格，不是現股（86400 秒、24/5） | 未查證 |
| sGOLD（`GC=F` 期貨） | 現貨 `Metal.XAU/USD` ✓；COMEX 期貨合約 feed：未查證 | XAU/USD 現貨（86400 秒） | 未查證 |
| sBOND（BGRN）、sICLN、sESGU | **查無**（`/v2/price_feeds?query=` 回 0 筆） | **無** | 未查證 |
| 碳權 | 無（本專案也不交易碳價，ADR-005） | 無 | — |

**覆蓋缺口：3／11 檔 ETF 沒有任何查證得到的簽名來源；sGOLD 換成簽名來源就會從期貨變成現貨，產品定義要跟著改。**

## 3. 方案比較

| | A. 現況（keeper 抓價、寫入 oracle） | B. Pyth Core pull | C. Pyth Pro | D. Chainlink Data Streams | E. Chainlink Data Feeds（push）當主來源 |
|---|---|---|---|---|---|
| 價格的信任 | keeper 金鑰＋行情 API | Pyth 發布者＋簽名驗證 | 同左 | Chainlink DON＋簽名驗證 | Chainlink DON |
| keeper 被盜的影響 | **平台（exchange 讀 MockOracle）：可寫任意價格**；租戶（讀 GuardedOracle）：只能在限速內寫 | **只能選擇送不送、送哪一筆有效簽名**（見下方「選擇性轉送」） | 同左 | 同左 | 不需要 keeper |
| 新鮮度的時間基準 | 寫入時間 | 來源 `publishTime` | 來源時間 | 來源時間＋`marketStatus` | `updatedAt`（heartbeat 最長 86400 秒） |
| 信賴區間 | 無 | `conf` | confidence | 無；以 bid／ask 價差代替（v3／v11） | 無 |
| 休市判斷 | 無（§1.5） | publishTime 停住＋市場行事曆；沒有明確欄位（**未查證**） | `marketSession` | `marketStatus`（v8／v11） | 24/5 標記，但 heartbeat 太長 |
| 覆蓋（11 檔） | 11（但 3 檔只有 Yahoo） | 8（含 sGOLD 現貨） | 預期 ≥ Core（**未查證**） | **未查證** | 8（股票／黃金 heartbeat 1 天） |
| 鏈上費用 | 寫價 gas | 更新費 0；gas 自付 | 1 wei＋gas | 不需 LINK；gas 自付 | 0（讀取） |
| 訂閱費 | 0（Yahoo／CoinGecko 的商業授權：**未查證**） | 加密 $500／月；含美股需 Pro 方案（美股 $5,000／月、全資產 $10,000／月；與 Core 的對應**未查證**） | $2,500／月起 | $150／feed／月起 → 11 檔 ≥ $1,650／月（若都有 stream） | 0 |
| 整合工作 | 0 | 中：repo 已有 adapter，缺 `updatePriceFeeds` 轉送 | 高：價格不存鏈上，每筆交易內驗證 | 高：新 adapter＋報告解碼 | 低（adapter 已有），但不適合當主來源 |
| 測試網 | 可 | Base Sepolia 有升級版合約；Hermes key 是否涵蓋測試網：**未查證** | Base Sepolia 有 | Base Sepolia 有 verifier；stream 是否收費：**未查證** | Base Sepolia 只有 9 個加密 feed |

**選擇性轉送**：keeper 不能改價格，但能在多筆有效簽名裡挑一筆，或延後送出。對策是：(1) 新鮮度門檻以秒計（§4.3）；(2) 價格只能往後（`publishTime` 單調遞增）；(3) 任何人都可以轉送（permissionless），keeper 只是保證有人送；(4) V3 採 GMX 式兩步執行，成交價取「請求之後」的第一個價格（ADR-015）。

## 4. 決定（建議）

**主來源採 Pyth（先用 Core，V3 評估 Pro），交叉比對採 Chainlink Base 的 push feed；keeper 只轉送 Hermes 的簽名資料。Data Streams 列為替代方案，在拿到 Base 上的 stream 清單與報價後重新比較。**

理由：Pyth 是唯一在本文中**查證到** 8／11 檔覆蓋、原生信賴區間、Base 主網與 Base Sepolia 都有升級版合約、而且 repo 已有 adapter 的方案；Chainlink push feed 免費可讀、與 Pyth 是不同的發布者網路，適合當獨立的第二意見，但 heartbeat 太長不能當主來源；而且它在 Base 上的股票 feed 報的是**代幣化商品的價格**（§2.2），與 Pyth 的現股價格定義不同，只能當較寬鬆的合理性檢查。Data Streams 的價格結構（每 feed 計費）在 11 檔時可能比 Pyth 的美股方案便宜，但在 Base 上有哪些 stream 未查證，不能拿未查證的東西當主來源。

### 4.1 和現有機制的關係

| 現有機制 | 改成什麼 | 理由 |
|---|---|---|
| GuardedOracle 單次偏離上限、時間窗累計上限 | **對簽名來源移除**，改成「熔斷」：與交叉比對來源偏離超過門檻 → 該資產自動 ReduceOnly（不是拒收價格） | 限速防的是 keeper 亂寫；簽名來源下它只剩「跳空時停在錯的價格」這個副作用（§1.2 的 M-2）。保留給仍由 keeper 寫價的資產 |
| guardian 凍結（72 小時到期、24 小時冷卻）、admin 接手 | **語意原樣保留**：由 `OracleRouter` 執行凍結與接手的規則，凍結狀態與到期時間存在 DataStore（ADR-015：handler 無狀態），沿用 #219 的邏輯 | 這是治理而不是資料品質：來源本身出錯時，人要能停 |
| 參考來源（`setReferenceSource`） | 第一階段：把 GuardedOracle 的參考來源換成讀 Pyth 的 adapter（不必動 exchange）；第二階段併入 `OracleRouter` 的交叉比對 | GuardedOracle 的讀者（V2 金庫、租戶的 exchange）恢復參考價。**平台 exchange 讀的是 MockOracle，監控規則比對的是 MockOracle 與 AggregatorOracle（`ops/monitoring/rules.md:743`），這一步對它們都沒有影響**；監控要另外改設定（階段 1 已列） |
| `AggregatorOracleAdapter` | 退役 | 雙源角色由「Pyth 主＋Chainlink 比對」取代；部署版是舊版、全部 revert |
| `maxPriceAge` | 依資產類別、以 `publishTime` 計：開倉與清算用秒級門檻（例如 60–120 秒，**數字待定**）；監控與 NAV 用較寬門檻 | 6 小時的依據是「keeper heartbeat＋排程延遲」（`docs/DEPLOY_130_CUTOVER.md:259`；GitHub cron 實測間隔最長約 169 分鐘），不是風險需求 |
| heartbeat | 從「鏈上寫入頻率」變成「轉送服務的服務水準」：轉送者至少每 N 秒送一次；鏈上不再有 heartbeat 的概念 | 新鮮度看來源時間後，重寫舊價格不再能讓價格「看起來新」 |
| 休市（P1-11） | 以來源的休市訊號為準：Pyth Pro `marketSession`／Data Streams `marketStatus`；用 Pyth Core 時以 `publishTime` 停止前進＋市場行事曆判斷。休市時**所有依價格的動作都停**（開倉、平倉、清算），只放行提領 `freeMargin` | 用來源時間之後，「過期停單」才真的會在休市時發生。平倉也停是因為對著已知過時的價格平倉一樣可被利用（例如週末有重大消息時以週五收盤價平掉多單）【待擁有者決定】 |
| `PythOracleAdapter` | 改用升級後的合約位址；新增轉送路徑（`updatePriceFeeds`）；`staleThreshold` 改成依資產類別 | `DeployWithPyth.s.sol:96` 是升級前的合約 |
| AssetVaultV2 | mint／redeem 要求交易內帶入簽名價格（或價格新鮮度以秒計） | 以過時價格 mint 合成資產是經典的套利路徑；金庫現在的 30 天門檻（`base-sepolia-keeper.yml:72-74`）不可上主網 |

### 4.2 keeper 的角色

- keeper 只做兩件事：向 Hermes 取簽名更新（帶 API key）、送上鏈。它**不再持有寫價權限**；`KEEPER_ROLE` 只留給仍由 keeper 寫價的資產（若擁有者決定保留那 3 檔 ETF）。
- 轉送是 permissionless：任何人都可以送更新，keeper 只保證「至少有一個人在送」。
- Hermes 的 API key 是新的秘密，與 keeper 的簽名金鑰分開保管（ADR-014）。key 外洩的影響是有人用我們的額度取資料，不影響價格正確性。
- 轉送不能再跑在 GitHub Actions 的 cron 上（實測 68–169 分鐘）；需要常駐的轉送服務（ADR-014 的 signer 託管一併處理）。

### 4.3 交叉比對與信賴區間

每次讀價（V3 的 `OracleRouter`）：

1. 驗證簽名、`publishTime` 單調遞增、`publishTime` 在該資產的新鮮度門檻內。
2. `conf / price ≤ maxConfBps`（沿用 `PythOracleAdapter` 的檢查，依資產類別設定）。
3. 與 Chainlink push feed 比較：參考價本身在它的 heartbeat 內，且偏離 ≤ 門檻（加密 1–2%、股票與黃金要大於它的 0.5% 偏離觸發門檻，**數字待定**）。股票的參考價是代幣化商品的價格（§2.2），在休市、延伸時段與代幣本身溢折價時會和現股價格分開，門檻要另訂，或把「股票是否要用這個來源交叉比對」列為擁有者決定（§7）。
4. 不通過 2 或 3：該資產 ReduceOnly＋SEV-2 告警；連續不通過超過 N 分鐘：guardian 決定是否凍結。
5. 參考價本身過期或不存在（例如 3 檔 ETF）：只做 1、2，並在監控上標示「無交叉比對」。

## 5. 實作計畫

工作量是單人估計（含測試，不含外部稽核與等待時間），**未經驗證**。

| 階段 | 內容 | 工作量 | 前置 |
|---|---|---|---|
| **0. 資料與授權** | 取得 Pyth API key 與報價（含美股、黃金）；向 Chainlink 詢問 Base 上 Data Streams 的 stream 清單與報價；確認 3 檔 ETF 的來源或下架；確認 sGOLD 改現貨或找期貨 feed；確認資料授權可供租戶商業使用 | 1–2 人日＋擁有者洽談 | 擁有者 |
| **1. 參考來源與轉送（不動 exchange）** | `PythOracleAdapter` 改升級版位址、新增依資產類別的新鮮度與信賴區間；keeper 新增 Hermes 轉送（`updatePriceFeeds`）；GuardedOracle 的 `referenceSource` 改指 Pyth adapter；監控的 `oracle-deviation` 改用 Pyth＋Chainlink 為參考 | 4–6 人日 | 階段 0 |
| **2. 常駐轉送服務** | 離開 GitHub cron；以 ADR-014 的 KMS signer 送交易；轉送服務水準告警 | 3–5 人日 | ADR-014 階段 1 |
| **3. V3 `OracleRouter`** | 簽名驗證、§4.3 的檢查、熔斷 → ReduceOnly、休市判斷、guardian 凍結語意（#219）、兩步執行（ADR-015） | 10–15 人日 | ADR-015 |
| **4. AssetVault** | mint／redeem 帶入簽名價格或秒級新鮮度 | 3–5 人日 | 階段 3 |
| 外部稽核 | `OracleRouter` 與 adapter | **未查證**（要詢價） | 階段 3 |

## 6. 上主網前必須成立的條件

1. 每一檔上架資產都有查證過的簽名來源；沒有的資產（目前 sBOND、sICLN、sESGU）不上主網，或由擁有者明文接受「keeper 寫價」的信任假設並配更嚴的 OI 上限。
2. 新鮮度以來源時間計，開倉與清算的門檻以秒或分鐘計，不是小時。
3. 休市行為已定義並在測試網模擬過一個完整週末（開倉、平倉、清算、提領各自的結果）。
4. 交叉比對有活的參考來源；監控不再持續回報「沒有可用的參考價」。
5. 資料授權書面確認可供白標租戶的商業使用；不再依賴 Yahoo／CoinGecko 的免費端點。
6. 合約與轉送服務使用 Pyth 升級後的位址與端點；舊一代合約不在任何設定裡。
7. 轉送服務不在 GitHub cron 上，且有服務水準告警。
8. 主來源全面中斷的處置寫進 `INCIDENT_RESPONSE.md`：所有資產同時停單是 ADR-008 定義的跨租戶事故。

## 7. 待擁有者決定

1. **供應商與預算**：Pyth（美股 $5,000／月、全資產 $10,000／月，與 Core 的對應待洽詢）、Data Streams（$150／feed／月起，覆蓋待確認），或兩者並用。
2. **3 檔 ETF**：下架、等來源，還是保留 keeper 寫價（並接受信任假設）。
3. **sGOLD**：改追蹤現貨 XAU/USD，還是找期貨來源。
4. **休市時是否放行平倉**：建議全停（只放行提領）；放行平倉則要接受「以過時價格平倉」的套利風險。
5. **各資產類別的新鮮度與信賴區間門檻**。
6. **熔斷的處置**：自動 ReduceOnly（建議），還是只告警。
7. **租戶的資料授權**：平台統一訂閱再分攤，還是每個租戶自己訂閱（ADR-008 的方案 C）。
8. **Pyth Core 或 Pro**：Core 先上（建議），V3 時依延遲需求評估 Pro。
9. **股票的交叉比對來源**：Chainlink Base 的股票 feed 是代幣化商品價格（§2.2）；要不要用它、門檻多寬，或改找其他現股參考來源。

## 8. Consequences

- keeper 從「寫價者」變成「轉送者」。被盜的影響從「平台：可寫任意價格（MockOracle，KNOWN_LIMITATIONS #3）；租戶：在限速內亂寫」降為「延遲或挑選有效價格」。
- 每月多一筆資料訂閱費，金額取決於資產組合；這要進成本模型（`docs/COST_MODEL.md`）與租戶的收費（ADR-008 的待決事項）。
- 休市期間交易會真的停下來；週末事件改由 ADR-012 的 junior 在開盤時吸收跳空。
- `KNOWN_LIMITATIONS.md` 與 `RISK_WATERFALL.md` 目前都沒有「休市期間以最後收盤價成交」這一條；依分工由 `fix/market-hours-staleness` 分支補上 KNOWN_LIMITATIONS，本 PR 不改，補上後兩邊交叉引用。
- 3 檔 ETF 可能要下架，sGOLD 的定義可能要改，這是產品變更，要對使用者公告。
- 單一主來源中斷會讓所有租戶同時停單；交叉比對只負責「發現錯誤」，不負責「代替主來源」。

## 9. 參考

- 本 repo：`contracts/src/v2/GuardedOracle.sol`、`contracts/src/PythOracleAdapter.sol`、`contracts/src/AggregatorOracleAdapter.sol`、`agent/keeper/`、[`ADR-009`](ADR-009-monitoring.md)、[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)、[`CHANGES_PHASE3_ORACLE.md`](CHANGES_PHASE3_ORACLE.md)
- 外部來源見 §2 各表。
