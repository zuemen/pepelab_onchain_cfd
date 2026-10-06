# RWA 透明度三頁：資料來源與限制

> 日期：2026-10-06。對應 [`RWA_ALIGNMENT.md`](RWA_ALIGNMENT.md) §4.3 的方案 ①②③。
> 三頁都是**唯讀**：不簽章、不送交易、不需要任何金鑰。未連錢包也能打開（`frontend/src/layouts/pepefi/index.tsx` 的 `PUBLIC_PATHS`）。
> 本文不是法律意見；監理相關文字一律「需法遵確認」。

| 路由 | 頁面 | 主要程式 |
|---|---|---|
| `/rwa` | RWA 資產卡與法遵揭露 | `frontend/src/lib/pepefi/rwaCards.ts`、`rwaProfile.ts`、`frontend/src/components/pepefi/rwa/RwaAssetCard.tsx`、`ComplianceDisclosure.tsx` |
| `/oracle` | 參考價多源見證看板 | `frontend/src/lib/pepefi/oracleWitness.ts`、`OracleWitnessView.tsx`；鏈下：`agent/signal-api/src/referencePrices.ts`（`GET /reference-prices`） |
| `/solvency` | 儲備與償付能力 | `frontend/src/lib/pepefi/solvency.ts`、`SolvencyView.tsx`、`LossWaterfall.tsx`、`ReserveRatioChart.tsx` |

入口：側邊欄（專家模式）新增「RWA 透明度」區塊；`/tokens` 標題下與專業終端的資產列各有一個「RWA 資產卡與揭露 →」連結；三頁頂端有互相切換的列（簡單模式的側邊欄是固定的 8 個入口，沒有放這三頁）。

## 0. 共通：讀哪條鏈、函式不存在怎麼辦

- **鏈與節點**（`lib/pepefi/readChain.ts`）：目標鏈優先是正式部署鏈 Base Sepolia（84532）。錢包剛好連在這條鏈上就用錢包的節點，
  否則用公開節點 `https://sepolia.base.org`（`vercel.json` 的 CSP `connect-src` 本來就放行）。公開 provider 設 `batchMaxCount: 1`，併發由 `mapLimit` 控制。
- **位址**一律從 `src/contracts/deployment.ts` 取（`getAddresses`、`getV2Stack`），不寫死。
- **鏈上沒有的函式**（`lib/pepefi/contractProbe.ts`）：線上是舊版合約（[`RELEASE_STATUS.md`](RELEASE_STATUS.md)），原始碼有、鏈上沒有的 view 很常見。
  先讀 runtime bytecode 找 PUSH4 selector（UUPS proxy 先讀 EIP-1967 實作槽）：
  - 找不到 → 顯示「此部署沒有這個函式」，**不呼叫**；
  - 找得到或 bytecode 讀不到 → 呼叫；revert／逾時 → 顯示「讀取失敗」。
  - 任何情況都不以 0、false 或預設值代替讀值。
- 2026-10-06 對 Base Sepolia 的唯讀探測：交易所有 `kyc()`、`rwaAsset`、`maxLeverageForAsset`、`maintenanceMarginBpsForAsset`、`adlEnabled`、`getUnrealizedPnL`，
  **沒有** `assetMode`（休市停單）。

## 1. `/rwa`：RWA 資產卡與法遵揭露

每檔一張卡（11 檔，先列 9 檔參照現實世界資產，再列 2 檔加密資產）：

| 欄位 | 來源 | 備註 |
|---|---|---|
| 參照的真實資產、識別碼 | `assetMeta.ts` 的 `provenance.referenceId`；catalog `tokens.provenance.assets[*].underlying` | 靜態 |
| 類別（股票／黃金／債券 ETF／ESG ETF／加密） | `rwaProfile.ts` 的 `RWA_CLASS` | 靜態；比 `AssetCategory` 細 |
| RWA 參照 | 鏈上 `PerpetualExchange.rwaAsset(id)` | sGOLD 鏈上為 false，卡片照實顯示「未標記」並說明（黃金是 RWA，但此部署沒有標記，開倉不查 KYC） |
| 開倉是否需要 KYC | 鏈上 `kyc()` 與 `rwaAsset(id)`，規則同 `PerpetualExchange.sol` 開倉檢查（兩者皆成立才檢查） | `kyc()` 不存在或為零地址 → 「交易所沒有設定 KYC 登錄」；附註現役 KYCRegistry 是舊版、送件與核准未分離，不構成身分審查 |
| 參考價格來源 | keeper 的 `agent/keeper/feeds.ts`（`SOURCES`、`SECONDARY_SOURCES`），排程見 `.github/workflows/base-sepolia-keeper.yml`（每 15 分鐘） | `rwaProfile.keeper.test.ts` 直接載入 keeper 原始檔逐鍵比對。股票／ETF／黃金標「只有單一來源」 |
| 交易時段、目前是否休市 | `marketHours.ts`（keeper 時段規則的複製，PR #250） | 只看排定時段，不含假日 |
| 休市規則 | 交易所 bytecode 有沒有 `assetMode(bytes32)`（沿用 PR #250 的 `assetModeProbe`／`marketStatus`） | 沒有時**一直**顯示「此部署未啟用休市停單，休市時仍以最後收盤價成交」，不只在休市時出現（[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) #31） |
| 碳分級、見證者數量 | 鏈上 `ESGRegistryV2.medianCarbonTier(id)`、`getAttestors(id).length` | 只有一位見證者時照實揭露「由營運方自己上鏈，中位數沒有作用」 |
| 槓桿上限、維持保證金 | 鏈上 `maxLeverageForAsset(id)`、`maintenanceMarginBpsForAsset(id)` | 2026-10-06：sAAPL 5×、500 bps |
| 風險揭露 | catalog `rwa.cards.riskByClass` | 股利不調整、拆股人工處理、黃金期貨換月未處理、下市無最終結算 |

「法遵與定位揭露」區塊（`ComplianceDisclosure.tsx`，靜態）：測試網研究原型、參照真實資產價格的合成衍生品而非代幣化證券、不發行也不持有標的、
結算資產是測試用 MockUSDC、台灣 CFD 屬受監理的槓桿交易業務（法規名稱與連結取自 [`DESIGN_BESU.md`](DESIGN_BESU.md) §5.1）、合約未經第三方稽核。

## 2. `/oracle`：參考價多源見證看板

- **鏈上**：交易所讀的 `MockOracle.getPrice(id)` → 價格（8 位小數）與 `updatedAt`。
  `updatedAt` 是**寫入時間**；MockOracle 不存來源的報價時間——頁面用一則固定的警示說明這件事，報價時間改看鏈下各來源。
- **價格年齡**＝最新區塊 `timestamp` − `updatedAt`（與合約 `_requireFresh` 同一個時鐘）；區塊讀不到才用本機時鐘並標示。超過 `maxPriceAge()` 變紅。
- **鏈下**：signal-api 新增的免費唯讀端點 `GET /reference-prices`（不接 x402、不收費）。瀏覽器直接打 Yahoo／Nasdaq 會被 CORS 擋，所以由 signal-api 代抓。

| 資產 | keeper 主來源 | 其他來源 | 報價時間 |
|---|---|---|---|
| sBTC、sETH | CoinGecko | Yahoo `BTC-USD`／`ETH-USD`（keeper 第二來源）、Coinbase 現貨 | CoinGecko、Yahoo 有；Coinbase 不提供 |
| 5 檔美股 | Yahoo | Nasdaq 公開報價 API（不需金鑰） | Yahoo 有（秒）；Nasdaq 只有日期文字，原樣顯示 |
| sBOND（BGRN）、sICLN、sESGU | Yahoo | Nasdaq（`assetclass=etf`） | 同上 |
| sGOLD | Yahoo `GC=F`（COMEX 近月**期貨**） | gold-api.com `XAU`（**現貨**） | 兩者都有；期貨與現貨有基差（2026-10-06 實測約 35 bps），只作合理性檢查 |

- 端點細節（`agent/signal-api/src/referencePrices.ts`）：每個上游 5 秒逾時；**每個上游 URL 各自快取**（成功 60 秒、失敗 15 秒）、single-flight，
  一個來源失敗不會讓其他來源被重抓；CoinGecko 的多個 id 合併成一次請求。回應帶 `Cache-Control: public, max-age=…, s-maxage=…, stale-while-revalidate=120`
  （s-maxage 最多 60 秒、跟著最先過期的來源走），讓 Vercel CDN 在多個實例之間共用同一份。
  一個來源失敗只讓該格帶短原因（`timeout`、`http 4xx`），不回上游原文、不補假值。沿用既有免費端點的 per-IP 節流。
  keeper 主來源與 `feeds.ts` 一致由 `referencePrices.test.ts` 釘住。
- **CORS**：只放行 `CORS_ALLOWED_ORIGINS`（與 `/demo/*` 同一份白名單，預設是正式前端網域與本機開發埠）；帶其他 `Origin` 的請求直接 403，
  避免其他網站把它當成免費行情來源或放大上游流量的跳板。沒有 `Origin` 的請求（curl、agent）照常可用，受 per-IP 節流約束。
  前端的 Vercel 預覽網域不在預設白名單內，預覽站上 `/oracle` 的鏈下欄位會顯示讀取失敗。
- **第三方資料條款**：這個端點**只即時轉發**參考價供比對——不保存歷史、不提供下載或批次匯出、每一格都標示來源與報價時間；
  回應本身也帶同樣的聲明（`disclaimer`）。各上游（Yahoo、CoinGecko、Nasdaq、Coinbase、gold-api.com）的使用條款與商業授權**未查證**，
  正式使用（含商業化或對外提供）前必須逐一取得授權或改用有授權的資料源。
- 2026-10-06 實測：Nasdaq 對帶 `/1.0; +https://…` 的 User-Agent 不回應（掛到逾時），所以端點用較短的 UA。signal-api 部署在 Vercel `sin1`，
  雲端 IP 對 Nasdaq 是否可用**未驗證**；不可用時看板對應格顯示「取價失敗」，美股與 ETF 就只剩 keeper 的單一來源。
- 端點尚未部署到線上 signal-api 之前，看板顯示「鏈下參考價讀取失敗（HTTP …），以下只顯示鏈上資料」。
- 各上游的商業授權**未查證**（[`COMPLIANCE_BOUNDARY.md`](COMPLIANCE_BOUNDARY.md) §2）。這不是簽名價、也不是去中心化預言機；它做到的是「任何人都能對帳」。
- 未做（RWA_ALIGNMENT 方案 ② 的其餘部分）：每日帶雜湊的 JSON 快照、Pyth Hermes／Chainlink 主網代幣化股價作第二來源、是否通過 keeper 熔斷規則的欄位。
  `GET /reference-prices` 也還沒寫進 `docs/api/openapi.yaml` 與 SDK。

## 3. `/solvency`：儲備與償付能力

| 區塊 | 來源 | 備註 |
|---|---|---|
| 交易所 USDC 餘額 | `MockUSDC.balanceOf(exchange)`，`decimals()` 讀鏈上 | MockUSDC 是 18 位小數 |
| 未平倉保證金、未實現損益 | 從 `nextPositionId − 1` 往回逐筆 `getPosition`，未平倉的再讀 `getUnrealizedPnL`（與 `useMarketActivity` 同一種讀法） | 最多掃 400 筆，超過標「不完整」；讀不到的筆數照實列出。2026-10-06 `nextPositionId = 0` |
| 交易者可提領餘額（freeMargin） | 不列入 | 要逐一地址查詢 |
| 保險金庫資產 | `InsuranceVault.totalAssets()` | |
| ADL 是否開啟 | `adlEnabled()` | 函式不存在時顯示「此部署沒有這個函式」 |
| 金庫儲備、負債、準備率 | `AssetVaultV2.reserveStatus()`、`minReserveRatioBps()` | 無負債時合約回 `uint256 max` → 顯示「沒有負債」；有未計價資產或 `stale` → 準備率「無法判斷」 |
| 準備率歷史 | `ReserveObserved` 事件（keeper 每輪呼叫 `observeReserve`） | 見下 |
| 損失吸收瀑布 | [`RISK_WATERFALL.md`](RISK_WATERFALL.md) §2.3 | 保證金 → 保險金庫 → ADL → 壞帳事件；前兩層附鏈上金額，ADL 附鏈上開關，第四層只揭露 |

- **準備率曲線**：最近約 24 小時（43,200 塊），每段 450 塊、併發 2、每段重試 2 次。
  2026-10-06 實測公開節點 `sepolia.base.org` 的 `eth_getLogs` 上限已降為 **500 塊**（回 `-32614 eth_getLogs is limited to a 500 range`）；
  `chainLogs.ts` 的 `CHUNK_SIZE = 800`（2026-09-29 實測 1,001 塊）在公開節點上會被拒，其他用到它的頁面需要另外確認。
  全部段失敗顯示「讀取失敗」，部分失敗顯示「n／N 段讀取失敗」，期間沒有事件顯示「沒有事件（不代表準備率為 0）」；有未計價資產的觀測點不畫入。
  keeper 排程常延遲：2026-10-06 的 24 小時視窗內只有 4 個觀測點。
- **照實標示**：頁首固定警示「本平台不持有標的資產……這裡的儲備是測試幣 MockUSDC，不是標的資產的儲備證明」；金庫區塊固定「金庫非足額抵押」與
  「現在的比率很高是因為負債很小而儲備是大量測試幣，不能拿來宣稱超額擔保」；瀑布下方「現行部署不保證恆償付」。

## 4. 測試

| 檔案 | 涵蓋 |
|---|---|
| `frontend/src/lib/pepefi/contractProbe.test.ts` | selector 探測、proxy 實作槽、函式不存在不呼叫、revert／逾時為 failed |
| `frontend/src/lib/pepefi/rwaCards.test.ts` | 舊部署無 `assetMode` → 休市規則 `noStop`；sGOLD 未標記；KYC 判斷；讀取失敗與函式不存在的降級 |
| `frontend/src/lib/pepefi/rwaProfile.keeper.test.ts` | 主來源／第二來源與 `agent/keeper/feeds.ts` 一致 |
| `frontend/src/lib/pepefi/oracleWitness.test.ts` | 鏈上報價、價格年齡、鏈下報表解析與 `fetchReferencePrices` 的失敗路徑、偏離 |
| `frontend/src/lib/pepefi/solvency.test.ts` | 彙總、讀取失敗不是 0、降級、`uint256 max`、500 塊上限、歷史部分失敗 |
| `frontend/src/lib/pepefi/readChain.test.ts` | 鏈與節點選擇 |
| `frontend/src/components/pepefi/rwa/rwaComponents.test.ts` | 每個新元件以 `react-dom/server` 渲染：休市揭露文字、讀取失敗、非足額抵押與非儲備證明文字、瀑布順序、曲線四種狀態、導覽列 |
| `agent/signal-api/src/referencePrices.test.ts` | 來源與 keeper 一致、萃取、單一上游失敗隔離、快取與 single-flight、路由免費且節流、失敗不回原文 |
