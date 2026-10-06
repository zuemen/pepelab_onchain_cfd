# RWA 對齊評估：PepeLab 是否真的符合 RWA 議題、缺口與補強

> 日期：2026-10-06。用途：Capstone 專題發表會（2026）的題目「PepeLab On-Chain CFD：RWA 永續合約與碳強度定價」
> 在 1P（10/7）、20P（10/21）、發表（12/7）中如何**準確**使用「RWA」一詞，以及在現有限制下補得起來的缺口。
>
> - **只做研究與文件**：本文沒有改任何程式、沒有部署、沒有送交易、沒有讀任何私鑰或 `.env`。
> - **鏈上事實**：以公開 RPC `https://sepolia.base.org` 唯讀 `cast call` 查詢，Base Sepolia（84532）區塊 **47744545**（2026-10-06）。
>   其餘鏈上數字引用 [`RELEASE_STATUS.md`](RELEASE_STATUS.md)（區塊 47661267）與 [`PARAMS_INVENTORY.md`](PARAMS_INVENTORY.md)（區塊 47714342）。
> - **外部事實**：查證日 2026-10-06（另有引用 [`ADR-013`](ADR-013-pull-oracle.md) 的 2026-10-02 查證）。每條都附 URL 並標「一手／二手」；
>   查不到一手來源的寫成「未查證」，不當成事實。第 7 節列出所有未查證項目。
> - **本文不是法律意見。** 監理定位一律「需法遵確認」。
> - 行號都是 `檔案:行號`，相對 repo 根目錄，以 `master`（`origin/master`，2026-10-06）為準。**原始碼不等於鏈上**：凡兩者不同都分開寫。

---

## 0. 一頁結論

1. **PepeLab 不是「RWA 代幣化」，是「參照 RWA 的合成衍生品」。** 它不發行、不託管、不給持有人任何對標的的請求權（[`ADR-002`](ADR-002-rwa-demand-layer.md)、README §8）。
   用發行端的判準（託管、儲備證明、法律請求權、贖回為實體資產）去量，它在結構上就「缺少」，而且這是定位選擇，不是漏做。
   用**衍生品層**的判準（參考價的品質、市場時段與公司行動、准入、對手方償付能力透明、揭露、監理定位）去量，它**部分符合**。
2. 11 檔標的中，**9 檔參照真實世界資產**（5 檔美股、3 檔 ETF、1 檔黃金期貨），2 檔是加密資產（sBTC、sETH），不是 RWA。
   鏈上被標成 `rwaAsset` 的是其中 8 檔；**sGOLD 沒有被標**（第 3.2 節）。
3. 衍生品層最弱的三項，也是評審最容易問到的三項：
   - **參考價**：交易所讀的是 keeper 寫入的 `MockOracle`（owner 就是 keeper，寫價沒有偏離上限）；股票與 ETF **只有 Yahoo 一個來源**；Base Sepolia 上沒有 Chainlink 股票或黃金 feed。
   - **市場時段**：現役交易所沒有逐資產模式，**週末與假日可以對著上週五收盤價開倉**（[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) #31）。修正在原始碼，未部署。
   - **准入**：鏈上 KYC 閘門有接上，但現役 `KYCRegistry` 是舊版——送件與核准沒有分離，所以它**不構成身分審查**；原始碼版已分離，未部署。
4. 1P 有三句話**目前不準確**，建議在 10/7 交件前修正（第 5.1 節）：「多來源確認」、「分級由見證者上鏈並取中位數」、「RWA 標的須通過鏈上 KYC 才能開倉」。
5. 在「現役合約 owner 金鑰不可用、`PerpetualExchange` EIP-170 餘裕 0 B」的限制下，前 5 個補強（第 4 節）：
   **① RWA 資產卡與法遵揭露頁**、**② 參考價多源見證看板**、**③ 儲備與償付能力頁**、**④ 以新金鑰部署的「RWA 示範租戶」**、**⑤ 合格投資人 VC 閘門**。
   ①②③ 純鏈下、不需要任何金鑰；④⑤ 需要一把**新的**部署金鑰與 Base Sepolia 測試幣，但不需要現役 owner 金鑰。

---

## 1. 為什麼要分兩套判準

| | RWA 代幣化（發行端） | RWA 衍生品（PepeLab 的定位） |
|---|---|---|
| 持有人拿到什麼 | 對標的或發行人的權利（所有權、債權、受益權），或至少是發行人的給付承諾 | 一份以參考價現金結算的契約部位；**不**取得標的的任何權利 |
| 鏈上與鏈下的連結 | 代幣數量要對得上託管的標的（儲備證明、稽核師 attestation） | 不持有標的；連結只發生在**價格**上（oracle） |
| 主要風險 | 法律確定性、託管、儲備不足、贖回 | 參考價被操縱或過時、休市跳空、對手方（保險金庫／流動性池）無力償付、槓桿 |
| 業界例子 | PAXG（每枚對應金條）、BUIDL（代幣化基金份額）、xStocks、Ondo Global Markets | Ostium（RWA 永續合約）、傳統的 CFD 與期貨 |

依據：
- IOSCO 把代幣化定義為「在 token 帳本或可程式化平台上創建、發行或表示資產」，並指出股票型 token 可能只是「發行人給付金錢收益的承諾」，沒有股東權；主要風險是法律確定性、DLT 營運、託管、交割終局性｜<https://www.iosco.org/library/pubdocs/pdf/IOSCOPD809.pdf>（FR/17/25，2025-11-11）｜一手（經摘要取得，引用原句前請開原文核對）。
- BIS 把代幣化定義為「將傳統帳本上對真實或金融資產的債權記錄到可程式化平台」｜<https://www.bis.org/publ/arpdf/ar2025e3.htm>｜一手。該章沒有討論 oracle 與鏈上鏈下橋接，**不要**引用 BIS 來支持 oracle 論點。
- FSB 列出代幣化的五項脆弱性：流動性／期限錯配、槓桿、資產價格與品質、互連性、營運脆弱｜<https://www.fsb.org/2024/10/the-financial-stability-implications-of-tokenisation/>（2024-10-22）｜一手。
- rwa.xyz 區分 **Distributed**（可移出發行平台、在錢包間轉移）與 **Represented**（不可移出，鏈只當記錄層）｜<https://app.rwa.xyz/blog/a-new-framework-for-tokenized-assets-distributed-and-represented>（2025-11-21）｜一手。PepeLab 兩者都不是：它沒有被代幣化的標的。
- SEC 委員 Hester Peirce 的個人聲明：「Tokenized securities are still securities」；第三方代幣化有對手方風險；**不給持有人底層證券法律與實質所有權的 token，可能是 security-based swap**｜<https://www.sec.gov/newsroom/speeches-statements/peirce-statement-tokenized-securities-070925>（2025-07-09）｜一手（個人聲明，不是 SEC 官方立場）。
  → 這句話對 PepeLab 是**有利的定性**：PepeLab 本來就自居為衍生品，而不是「代幣化股票」。
- Ostium 的 RWA 價格用自建的 pull-based oracle（節點由 Stork 運作），休市時不接受市價單｜<https://ostium-labs.gitbook.io/ostium-docs/supporting-infrastructure/price-oracle>｜一手。它是「RWA 永續合約」這個類別的業界對照。Ostium 是否完全沒有底層資產：**未查證**。

**結論**：本題目用「RWA」是可以成立的，但必須說成「**參照 RWA 的衍生品層**」，並用衍生品層的判準證明自己做得夠好；不能暗示持有人擁有真實資產。

---

## 2. 判準清單（9 項）

| # | 判準 | 發行端要求 | 衍生品層要求（PepeLab 適用） | 權威依據 |
|---|---|---|---|---|
| C1 | **參考標的與參考價** | 標的可識別（ISIN／代號）；NAV 或市價來源 | 標的可識別；參考價來自有授權、可驗證（簽名或多源）的來源；新鮮度以**行情時間**而非寫入時間判斷 | Chainlink Data Feeds 要求依資產類別市場時段使用 feed｜<https://docs.chain.link/data-feeds/selecting-data-feeds>｜一手；Pyth market hours｜<https://docs.pyth.network/price-feeds/core/market-hours>｜一手 |
| C2 | **資產連結／償付能力證明** | 代幣數量對應託管標的；PoR 或稽核師 attestation | 不要求持有標的；要求**對手方償付能力透明**（保證金、保險金、準備金可即時查核，破線有自動反應） | Chainlink PoR：鑄造須對應儲備、協議熔斷、1:1 抵押｜<https://chain.link/proof-of-reserve>｜一手；PAXG 月度 attestation｜<https://www.paxos.com/pax-gold>｜一手；xStocks 每週上鏈 PoR｜<https://support.kraken.com/articles/xstocks-faq>｜一手 |
| C3 | **合規准入** | KYC、合格投資人、制裁篩檢；身分登記 | 參照證券的市場要有准入閘門；身分審查由持牌機構做，鏈上只執行結果；准入可到期、可撤銷 | ERC-3643 Identity Registry 以白名單連結錢包、onchain identity 與國碼｜<https://eips.ethereum.org/EIPS/eip-3643>（Final）｜一手；Ondo 只賣給符合資格的非美國人｜<https://ondo.finance/ondo-stocks>｜一手 |
| C4 | **轉讓限制** | 每次轉讓檢查收款方資格；凍結、強制轉移 | 衍生品部位本身不應可自由轉讓；若另有可轉讓的合成代幣，應受同一套准入 | ERC-3643 `canTransfer`、凍結、`forcedTransfer`｜同上｜一手；ERC-1400 為 Draft（2018），未收錄為正式 EIP｜<https://github.com/SecurityTokenStandard/EIP-Spec/blob/master/eip/eip-1400.md>｜一手（非 eips.ethereum.org） |
| C5 | **市場時段與公司行動** | 股利、分割、停牌、下市要反映到代幣（multiplier、再投資） | 休市不可對過時價格開新倉；拆股不得誤清算；股利對多空部位的調整政策要明訂；期貨換月 | Chainlink Data Streams `marketStatus`，官方建議以它判斷開盤、不要看時間戳｜<https://docs.chain.link/data-streams/market-hours>｜一手；xStocks 拆股與股利再投資｜<https://support.kraken.com/articles/corporate-actions-xstocks-kraken-app>｜一手；Chainlink 24/5 美股：公司行動待處理時可能停報｜<https://docs.chain.link/data-streams/rwa-streams/24-5-us-equities-user-guide>｜一手 |
| C6 | **法律結構與對手方** | 發行人、SPV、託管人、持有人權利 | 誰是對手方、契約條款、違約與壞帳時的損失分配順序 | IOSCO 法律確定性（同 §1）；xStocks 發行人 Backed Assets (JE) Limited、Alpaca 託管｜Kraken FAQ｜一手 |
| C7 | **結算資產** | 贖回為法幣或實體資產 | 現金結算用的結算幣品質（受監管穩定幣、代幣化存款） | FSB 營運與流動性脆弱（同 §1） |
| C8 | **資訊揭露** | 公開說明書、持有人權利、風險 | 「不代表所有權」、參考價來源、休市規則、對手方、槓桿與損失分配、方法論 | IOSCO（同 §1）；ESMA 2026-09 Risk Monitor 有「Tokenisation of equities」專節｜<https://www.esma.europa.eu/sites/default/files/2026-09/ESMA50-1949966494-4282_TRV_Risk_Monitor_2_2026.pdf>｜一手連結、內文引句**未讀到原文，不引用** |
| C9 | **監理定位** | 證券型代幣（STO）或沙盒 | 槓桿衍生品屬受監理業務；原型的定位（PoC／沙盒／B2B 給持牌機構） | 台灣 STO 規範（3,000 萬元界線、專業投資人）｜<https://www.tpex.org.tw/web/STO/index.php?l=zh-tw>｜一手；《期貨交易法》第 3 條「槓桿保證金契約」、第 80 條槓桿交易商許可｜<https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0400100>｜一手（細節見 [`DESIGN_BESU.md`](DESIGN_BESU.md) §5）；金管會「現實世界資產（RWA）代幣化小組」2025-09-25 完成期末報告，驗證標的為國內債券、外國債券與基金｜<https://www.fsc.gov.tw/ch/home.jsp?id=96&parentpath=0%2C2&mcustomize=news_view.jsp&dataserno=202511040002&aplistdn=ou%3Dnews%2Cou%3Dmultisite%2Cou%3Dchinese%2Cou%3Dap_root%2Co%3Dfsc%2Cc%3Dtw&dtable=News>｜一手 |
| 附 | **（題目特有）碳／ESG 資料品質** | — | 資料來源可追溯、方法論公開、見證者獨立、與 PCAF 等標準對照 | [`CARBON_METHODOLOGY.md`](CARBON_METHODOLOGY.md) §5（PCAF 對照） |

> 名稱提醒：台灣的資產代幣化試辦，金管會新聞稿用的名稱是「現實世界資產（RWA）代幣化小組」，**不是** Project Gaia；新聞稿全文沒有 Gaia 一詞。
> STO 的「第一類／第二類」分法在官方頁面上**未查到**，不要使用。

---

## 3. 逐項評分

評分：**已具備**／**部分**／**缺少**。「鏈上」一欄是 2026-10-06 區塊 47744545 的唯讀讀值。

### 3.1 總表

| # | 判準 | 評分 | 證據（檔案:行號／鏈上） | 一句話 |
|---|---|---|---|---|
| C1 | 參考標的與參考價 | **部分** | 標的識別：`frontend/src/lib/pepefi/assetMeta.ts:128`、`:166`、`:185`（交易所＋代號）。來源：`agent/keeper/feeds.ts:14-28`（股票／ETF／黃金全走 Yahoo，加密走 CoinGecko）、`:30-38`（第二來源只有 sBTC、sETH）。交易所讀 `MockOracle`：`contracts/src/MockOracle.sol:64`（`onlyOwner` 寫價）；`PARAMS_INVENTORY.md:154`。鏈上：Chainlink 轉接器 0x37DC… 對 5 檔資產的 `feeds()` 全為 0；Pyth 轉接器 0x551C… 只設了 sBTC、sETH 的 price id | 標的清楚，但價格是受信任的單一 keeper 寫入；股票單一來源；沒有簽名價；資料源未取得商業授權 |
| C2 | 償付能力透明 | **部分** | `contracts/src/v2/AssetVaultV2_4.sol:431`（`reserve`）、`:441`（`outstandingValue`）、`:491`（`reserveRatioBps`）、`:486`（`ratioIsStale`）、`:543`（`observeReserve` 事件）。鏈上（AssetVaultV2 proxy 0x916D…）：`reserve` ≈ 201,291.5、`outstandingValue` ≈ 1,375.26、`reserveRatioBps` = 1,463,658（約 14,637%）、`ratioIsStale` = false、`minReserveRatioBps` = 11,000 | 負債與準備都在鏈上、可重播；但準備是測試幣 MockUSDC，金庫**非足額抵押**、是所有多頭的對手方；這不是、也不能是標的的 PoR |
| C3 | 合規准入 | **部分** | 閘門：`contracts/src/PerpetualExchange.sol:267-271`、`:1769-1770`（只在開倉檢查）。鏈上：`kyc()` = 0x5D95…360d；`rwaAsset` 為 true 的有 sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL、sBOND、sICLN、sESGU，sGOLD／sBTC／sETH 為 false。登錄：`contracts/src/KYCRegistry.sol` 原始碼已分離送件與核准，但 `RELEASE_STATUS.md:37` 顯示鏈上是舊版（2842 B ≠ 4454 B）；前端註解 `frontend/src/lib/pepefi/kycSubmitGate.ts:4-6`。個資：`frontend/src/components/pepefi/KYCModal.tsx:223-225`（送 `keccak256(salt‖姓名)`） | 閘門有接上、個資不上鏈是對的；但現役登錄沒有審核步驟，**不構成身分審查**；沒有到期日、沒有合格投資人分級；金庫 mint 不檢查 KYC |
| C4 | 轉讓限制 | **部分** | 永續部位是交易所內部紀錄（`PerpetualExchange.sol:219`、`:224`），沒有轉讓函式；金庫代幣 `contracts/src/v2/SyntheticAssetV2.sol:5-6` 註明「transferable」，是一般 ERC-20 | 永續部位天然不可轉讓（符合）；金庫的合成代幣可自由轉給任何地址（不符合） |
| C5 | 市場時段與公司行動 | **缺少（鏈上）／部分（鏈下）** | 現役交易所沒有 `assetMode()`（`RELEASE_STATUS.md` 的「讀不到的 getter」；`KNOWN_LIMITATIONS.md:1236` #31：週末以週五收盤價接受開倉）。原始碼有 Active／ReduceOnly／Halted：`PerpetualExchange.sol:369`、`:376-383`；keeper 休市切換：`agent/keeper/marketMode.ts`、`agent/keeper/market.ts:16-28`。拆股：`docs/RUNBOOK_KEEPER.md:238-256`（熔斷＋人工）。下市：`KNOWN_LIMITATIONS.md` #21（沒有最終結算函式） | 休市與公司行動的**設計**都有，**現役鏈上都沒有生效**；股利沒有任何調整機制；sGOLD 追蹤近月期貨（`assetMeta.ts:166`），換月跳價沒有處理 |
| C6 | 法律結構與對手方 | **缺少（定位使然）** | README §8；[`COMPLIANCE_BOUNDARY.md`](COMPLIANCE_BOUNDARY.md) §1-§3（草案）；損失順序 [`RISK_WATERFALL.md`](RISK_WATERFALL.md) | 沒有法律實體、沒有契約條款；對手方與損失分配順序**有寫清楚**（保證金 → 保險金庫 → ADL → 壞帳事件），這是衍生品層能補的部分 |
| C7 | 結算資產 | **部分** | 保證金是 MockUSDC 0x69fd…（README §2：部署版 `mint` 不受限，僅限測試網）；正式設計見 [`DESIGN_BESU.md`](DESIGN_BESU.md) §4（代幣化存款） | 現金結算的結構正確；結算幣是測試幣 |
| C8 | 資訊揭露 | **已具備** | 合成資產揭露 `frontend/src/components/pepefi/SyntheticDisclosure.tsx`（不可關閉、可收合）；資產身世卡 `frontend/src/components/pepefi/AssetProvenance.tsx:1-10`（追蹤標的、「本代幣不代表所有權」、價格來源與新鮮度、碳強度與出處、KYC 理由）；README §5、§8；`KNOWN_LIMITATIONS.md` | 揭露是本專案最強的一項；缺的是休市規則、公司行動政策與監理定位的**畫面**版本 |
| C9 | 監理定位 | **部分** | README 開頭與 §8；`KNOWN_LIMITATIONS.md:1547-1562`（6 檔參照證券，對公眾提供槓桿曝險幾乎在所有法域都需要許可）；`DESIGN_BESU.md:474-490` | 文件清楚寫出「B2B 給持牌機構、原型、需法遵確認」；簡報還沒有把台灣的定位（槓桿保證金契約／沙盒）講出來 |
| 附 | 碳資料品質 | **部分** | [`CARBON_METHODOLOGY.md`](CARBON_METHODOLOGY.md) §4：抽查資產每檔只有 1 筆見證，見證者與合約 owner 為同一 EOA；`sourceHash` 無法在鏈上驗證（`contracts/src/ESGRegistryV2.sol:104`）；PCAF 對照約 2（個股，經二手彙整）到「低於 5」（定性分級） | 方法論與限制寫得誠實；「取中位數」在現況沒有發揮作用 |

### 3.2 必須誠實說明的五件事

**(1) 合成資產與 RWA 的差異。** sAAPL 不是 Apple 股票，也不是 Apple 股票的代幣化憑證；它是一個以 Apple 股價為參考、以 USDC 現金結算的合成曝險。
持有人沒有股東權、沒有股利、沒有對任何人的贖回請求權（只能以參考價向金庫 redeem 成 USDC）。
在 IOSCO 與 Peirce 的框架下，這比較接近衍生品（swap／CFD），而不是代幣化證券。這正是 [`ADR-002`](ADR-002-rwa-demand-layer.md) 選擇的定位。

**(2) 價格來源目前是 keeper 推送的 `MockOracle`。** 交易所的 `oracle` 是 immutable，指向 `MockOracle` 0xeD90…0Aa3（`PARAMS_INVENTORY.md:154`），
owner 即 keeper 金鑰，寫價沒有偏離上限。keeper 有 20% 熔斷，但股票與 ETF 只有 Yahoo 單一來源，所以**多源確認只對加密資產有效**（`agent/keeper/core.ts:95-97`、`feeds.ts:30-38`）。
鏈上另有 `AggregatorOracle`（Chainlink＋Pyth）與兩個轉接器，但只有 sBTC、sETH 設了 Pyth id，Chainlink 一個 feed 都沒設，而且交易所不讀它。
GuardedOracle（有偏離與時間窗限制）目前只給 AssetVaultV2 用。
Base Sepolia 上的 Chainlink Data Feeds 只有 9 個加密 feed，**沒有股票與 XAU/USD**（[`ADR-013`](ADR-013-pull-oracle.md) §2.2，目錄 JSON <https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia-base-1.json>，2026-10-02 與 2026-10-06 兩次讀取一致；這是 Chainlink 公開目錄，與官網頁面的對應關係未查證）。
Chainlink 在 Base **主網**的「Coinbase AAPL」等 feed 報的是**代幣化商品的價格**，不是現股（ADR-013 §2.2）。
Pyth 有 `Equity.US.<代號>/USD` 與 `Metal.XAU/USD`（ADR-013 §2.5，以 Hermes 中繼資料查詢），但 2026-08-26 升級後 Hermes 需要 API key（ADR-013 §2.1），測試網是否涵蓋未查證；3 檔 ETF（BGRN、ICLN、ESGU）查無 Pyth feed。

**(3) AssetVaultV2 非足額抵押。** 金庫是所有多頭的對手方，用 110% 準備率門檻（破線停鑄、贖回不受限）、逐資產上限與暫停來限制曝險，不是 1:1 準備（`KNOWN_LIMITATIONS.md:200-206`、[`ADR-004`](ADR-004-reserve-transparency.md)）。
今天的比率約 14,637%，是因為負債很小（約 1,375）而準備是大量測試幣；這個數字**不能**拿來宣稱「超額擔保」，只能拿來展示「比率與破線反應在鏈上可查」。

**(4) KYC 前端只送雜湊。** 前端送的是 `keccak256(salt‖正規化姓名)` 與 `keccak256(salt‖國籍代碼)`，salt 只留在使用者端（`KYCModal.tsx:223-225`）。這做到了「個資不上鏈」，但**不等於做了 KYC**：
沒有人看過證件、沒有制裁篩檢；加上現役登錄沒有審核步驟，現役閘門只是「這個地址有送過一筆資料」。真正的身分審查在設計上屬於持牌客戶（`COMPLIANCE_BOUNDARY.md` §3）。

**(5) 碳分級的資料來源。** 個股用公司永續報告的範疇一＋二（經二手彙整網站轉引）除以 SEC 申報的營收；加密與黃金用網路或產業的年化絕對排放；sICLN、sBOND 是定性判斷；sESGU 只有約 24% 持股覆蓋（`CARBON_METHODOLOGY.md` §4-§5）。
所有見證都由營運方自己上鏈，沒有第三方確信。分級影響費率與槓桿，**不是**綠色認證或 SFDR 之類的法規分類。

另外一個小的不一致：**sGOLD 在鏈上沒有標成 `rwaAsset`**（前端 `assetMeta.ts:163` 也是 `regulated: false`），部署與驗證腳本的清單同樣排除黃金（`contracts/script/VerifyTenant.s.sol:488-492`）。
黃金在 rwa.xyz 屬於 Commodities 類 RWA；不加 KYC 可以有理由（商品不是證券），但簡報說「RWA 標的須通過 KYC」時要說成「**參照證券的**標的」。

---

## 4. 缺口與補強方案

### 4.1 限制

- `PerpetualExchange` 的 EIP-170 餘裕是 **0 B**（`PARAMS_INVENTORY.md:242`）：不加任何功能。修改既有合約不新增方法；新功能放**新合約**或**鏈下**。
- 現役合約的 owner 金鑰目前找不到：**不能**改現役合約的任何設定（`setKycRegistry`、`setRwaAsset`、ESGRegistryV2 的 `ATTESTOR_ROLE`、MockOracle 寫價以外的 owner 操作都做不到）。新合約可以用新金鑰部署，但要 Base Sepolia 測試幣當 gas。
- 時程：10/21 前要能寫進 20P；12/7 要能 Demo。
- 廣播交易一律由持有新金鑰的使用者本人執行（[`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md) 的既有規則）。

### 4.2 排序（影響 × 可行性）

影響：補到幾項判準、是否回應評審最可能的質疑。可行性：工時、是否需要金鑰、技術風險。分數 1–3，乘積越高越先做。

| 序 | 方案 | 補的判準 | 影響 | 可行性 | 乘積 | 需要現役 owner 金鑰 | 需要新金鑰＋測試幣 | 預估工時 |
|---|---|---|---|---|---|---|---|---|
| ① | RWA 資產卡與法遵揭露頁 | C1、C5、C6、C8、C9 | 3 | 3 | 9 | 否 | 否 | 8–12 h |
| ② | 參考價多源見證看板（鏈下） | C1、C5 | 3 | 3 | 9 | 否 | 否 | 12–16 h |
| ③ | 儲備與償付能力頁 | C2、C6 | 2 | 3 | 6 | 否 | 否 | 6–8 h |
| ④ | RWA 示範租戶（新金鑰部署 master 版整套） | C1、C3、C5、附 | 3 | 2 | 6 | 否 | **是** | 24–32 h |
| ⑤ | 合格投資人 VC 閘門（新合約實作 `IKyc`） | C3 | 2 | 2 | 4 | 否 | **是** | 14–20 h |
| ⑥ | 碳資料來源可驗證（`sourceHash` 對照與重算） | 附 | 2 | 3 | 6 | 否 | 否 | 4–6 h |
| ⑦ | ERC-3643 風格的轉讓限制代幣 | C4 | 1 | 1 | 1 | 否 | 是 | 20 h 以上 |

⑥ 的乘積與 ③④ 相同，但它只補題目特有的碳資料、不回應 RWA 判準本身，所以排在 RWA 前五之外；工時很小，建議與 ① 一起做。
⑦ 不建議：永續部位本來就不可轉讓；金庫代幣的問題用揭露（①）或在示範租戶不部署金庫（④ 的 `deployVault: false`）處理即可。ERC-3643 參考實作與本專案技術棧衝突的理由見 `ADR-002`。

### 4.3 各方案

#### ① RWA 資產卡與法遵揭露頁

- **做什麼**：在既有的資產身世卡（`AssetProvenance.tsx`、`assetMeta.ts`）補欄位，並新增一頁「法遵與風險揭露」：
  - 每檔：參考市場與代號、**正規交易時段**（美股 9:30–16:00 ET；黃金依 COMEX）、**目前是否休市**（沿用 keeper 已在抓的 Yahoo `currentTradingPeriod`，`agent/keeper/market.ts`）、**休市時本平台的實際行為**（現役：仍以最後收盤價接受開倉；誠實寫出）；
  - 價格來源層級（「單一來源，keeper 寫入」／「兩個來源互相確認」）、最後一次寫入時間與**來源報價時間**分開顯示；
  - 公司行動政策：拆股（熔斷、人工決定換算或結算，依 `RUNBOOK_KEEPER.md:253-256`）、**股利：不調整，多單不收股利、空單不付股利**（現況，需揭露）、黃金期貨換月（未處理，需揭露）、下市（沒有最終結算函式，`KNOWN_LIMITATIONS.md` #21）；
  - 鏈上即時讀值：`rwaAsset(id)`、`kyc()`，直接顯示「這檔需要 KYC：是／否（鏈上讀取）」，讓 sGOLD 的差異變成可見的事實；
  - 監理定位一段：「參照證券的槓桿衍生品屬受監理業務；本原型僅供研究，商業化以 B2B 方式提供持牌機構」，引用 `DESIGN_BESU.md` §5 的法條出處，並標「需法遵確認」。
- **為什麼符合 RWA 判準**：C5 與 C8 是 RWA 衍生品與一般加密衍生品最大的差別（Chainlink 與 Pyth 的文件都要求依市場時段使用價格）；C9 回應「你們能不能合法做」。
- **元件**：前端（React）與文案；不碰合約。
- **金鑰**：不需要。
- **Demo**：打開 sAAPL 資產卡，週末時顯示「休市中：鏈上價格為週五收盤，本平台現役合約仍接受開倉（已知限制 #31）」；點 sGOLD 顯示「鏈上未標為需 KYC」。
- **風險**：文案寫得太像法律意見——所有監理文字都標「需法遵確認」；休市狀態依賴 Yahoo，拿不到時要顯示「無法判斷」而不是「開盤」。

#### ② 參考價多源見證看板（鏈下）

- **做什麼**：一個唯讀的比對頁或排程報告，每檔同時列出：
  1. 交易所實際讀的 `MockOracle` 價格與 `updatedAt`（鏈上唯讀）；
  2. keeper 的主來源（Yahoo／CoinGecko）與**來源報價時間**；
  3. 第二來源：加密用 Chainlink（Base Sepolia 有 BTC、ETH feed）與 Pyth；美股與黃金的候選依序是 Pyth Hermes（需 API key，條款與測試網涵蓋未查證）、Chainlink Base **主網** XAU/USD 與「Coinbase <代號>」代幣化商品價（只當寬鬆合理性檢查，heartbeat 1 天）；ETF 標明「無獨立第二來源」；
  4. 偏離（bps）、是否休市、是否通過 keeper 的熔斷規則。
  每天把結果存成一份帶雜湊的 JSON 快照（放在 repo 或 Actions artifact），讓「價格是否被亂寫」可以事後稽核。
- **為什麼符合 RWA 判準**：C1 要求參考價可驗證。現役價格無法在不改合約的前提下變成簽名價，但可以做到「**任何人都能對帳**」，並把來源層級揭露清楚。這也是 `ADR-013` 長期方案（Pyth pull＋Chainlink 交叉比對）的鏈下前置。
- **元件**：鏈下腳本（可重用 `agent/keeper/feeds.ts` 的萃取函式）＋前端頁面；GitHub Actions 唯讀排程。
- **金鑰**：不需要（只讀）。若使用 Pyth Hermes 需要 Pyth 的 API key（不是區塊鏈金鑰），取得條件**未查證**。
- **Demo**：表格即時顯示 sAAPL 鏈上價、Yahoo 價、第二來源價與偏離；週末時顯示「來源報價時間停在週五 16:00 ET，鏈上寫入時間仍是新的」——這一欄正是已知限制 #31 的證據，也是評審會欣賞的誠實。
- **風險**：Yahoo 與 CoinGecko 的商業授權未查證（`COMPLIANCE_BOUNDARY.md` §2）；Chainlink 主網代幣化股價與現股定義不同，不能說成「Chainlink 驗證了股價」。

#### ③ 儲備與償付能力頁

- **做什麼**：把已在鏈上的數字整理成一頁，並附上「這不是什麼」：
  - 金庫：`reserve`、`outstandingValue`、`reserveRatioBps`、`ratioIsStale`、`minReserveRatioBps`，以及 `ReserveObserved`／`ReserveBreached`／`ReserveRestored` 事件的歷史曲線（`AssetVaultV2_4.sol:169-183`）；
  - 交易所：保險金庫餘額、未平倉量、ADL 狀態、`BadDebt` 事件；
  - 明示：「準備是測試幣」「金庫是對手方、非足額抵押」「本平台不持有標的，因此**沒有**、也不需要標的的 Proof of Reserve；這一頁證明的是對手方償付能力」。
  `TokenizedAssetsPage.tsx` 已經讀 `reserveRatioBps`，這一案是補歷史與損失順序，不是從零開始。
- **為什麼符合 RWA 判準**：C2 在衍生品層的對應是「對手方償付能力透明」。用 PoR 的語言回答評審，但不冒充 PoR。
- **元件**：前端＋鏈上事件唯讀查詢。
- **金鑰**：不需要。
- **Demo**：一張比率曲線＋一張損失吸收瀑布圖；指著 `ratioIsStale` 說明「有資產無法計價時，畫面顯示『無法確認』而不是樂觀數字」。
- **風險**：比率數字很漂亮但沒有意義（測試幣）——畫面上必須和數字並列說明。keeper 是否持續呼叫 `observeReserve` 要先確認（`PARAMS_INVENTORY.md:189`），否則歷史會有斷點。

#### ④ RWA 示範租戶（以新金鑰部署 master 版整套）

- **做什麼**：用既有的白標租戶流程（`deploy/tenants/<id>.json` → `contracts/script/DeployTenant.s.sol` → `VerifyTenant.s.sol` → 前端 `VITE_TENANT`），以**新的部署金鑰**在 Base Sepolia 部署一套 master 版合約，作為「RWA 示範市場」。這一套會**一次**帶上現役部署沒有的東西：
  - 逐資產模式 Active／ReduceOnly／Halted，keeper 以 marketOperator 身分在休市時切 ReduceOnly（`agent/keeper/marketMode.ts`）——**已知限制 #31 在這個租戶上不成立**；
  - 送件與核准分離的 `KYCRegistry`（原始碼版），由自己的 verifier 核准；
  - GuardedOracle 當交易所的 oracle（偏離上限、時間窗限制、凍結），而不是 `MockOracle`；
  - 自己當 admin 的空白 `ESGRegistryV2`（全部從 Unrated 開始），可以指派**不同的** attestor 地址；
  - `assets.registered` 只放參照真實資產的標的（例如 sAAPL、sMSFT、sGOLD、sBOND），並可決定 `deployVault: false`，避免可自由轉讓的金庫代幣。
- **為什麼符合 RWA 判準**：同時補 C1（受限的 oracle）、C3（真的有核准步驟）、C5（休市停開新倉、平倉與清算照常）。不違反 0 B 限制：部署的是**現有** master 原始碼，沒有新增任何方法。
- **元件**：既有腳本與設定檔（新增一份租戶 JSON）、新租戶的 keeper workflow（`TENANT_OPERATIONS.md`）、前端租戶設定。
- **金鑰**：**不需要**現役 owner 金鑰；需要使用者本人保管的**新**部署金鑰、keeper 金鑰與 Base Sepolia 測試幣。新金鑰不得放進 repo，依 `TENANT_DEPLOYMENT.md` 只放 secret。
- **工時**：24–32 h（設定與 dry-run 4 h、部署與驗證 6 h、keeper workflow 6 h、前端租戶與驗收 8 h、文件 4 h），另需 `forge` 編譯與模擬——**要排在同機沒有其他示範在跑的時段**。
- **Demo**：同一個前端切到示範租戶；週末對 sAAPL 開倉被拒（`AssetNotActive`），但既有部位可以平倉；未核准的錢包開 sAAPL 被拒（`NotKycVerified`），核准後通過、撤銷後不能再開但能平倉。
- **風險**：(a) 示範租戶與現役平台是兩套位址，簡報要講清楚「現役是舊版、示範租戶是 master 版」；(b) `PerpetualExchange` 剛好卡在 EIP-170 門檻，編譯器版本或設定一變就可能超過，部署前必須跑 `contract-size` 檢查；(c) 新 keeper 會增加維運負擔（GitHub Actions cron 延遲）；(d) 新 ESGRegistryV2 的 attestor 雖然是不同地址，仍由同一團隊控制，**不能**說成獨立見證。

#### ⑤ 合格投資人 VC 閘門（新合約實作 `IKyc`）

- **做什麼**：照 [`DESIGN_BESU.md`](DESIGN_BESU.md) §3 的方案 A2，新寫一個 `CredentialKycRegistry`：只存 `地址 → (validUntil, credentialHash)`，`isVerified` 回傳「未過期且未撤銷」；鏈下准入服務驗證機構簽發的「合格投資人」VC（不含姓名、證號、財力證明），通過後寫入。撤銷沿用 [`ADR-016`](ADR-016-vc-credential-status.md) 的狀態清單格式。
- **為什麼符合 RWA 判準**：C3 的核心是「准入可到期、可撤銷、身分資料留在發證機構」。這與 ERC-3643 的 Identity Registry 精神相同（錢包對應到經驗證的身分聲明），但只做衍生品層需要的部分。
- **元件**：一個新合約（全新檔案，不改既有合約）、鏈下准入服務（可重用 agent 的 EIP-712／`did:pkh` 驗證程式）、前端「出示 VC」流程。
- **金鑰**：新合約由新金鑰部署；要讓交易所使用它，只能接到 ④ 的示範租戶（現役交易所的 `setKycRegistry` 需要 owner 金鑰）。若 ④ 不做，⑤ 只能單獨展示「VC → 登錄 → `isVerified`」，不能展示交易所擋單。
- **工時**：14–20 h（合約與測試 6 h、准入服務 6 h、前端 4 h、文件 2 h）。
- **Demo**：錢包出示過期的 VC → 登錄拒絕；出示有效 VC → `isVerified` 為 true → 在示範租戶開 sAAPL 成功；機構撤銷 → 不能再開新倉、既有部位可平倉。
- **風險**：新合約沒有稽核；VC 發證者其實是團隊自己，簡報要說「模擬持牌機構的 KYC 單位」；與 ④ 有相依關係，時程上 ⑤ 要排在 ④ 之後。

#### ⑥ 碳資料來源可驗證（附帶建議）

- 公開一份「資產 → 來源網址、取得日期、`sourceHash`」對照表，加一支唯讀腳本重算雜湊並與鏈上 `ESGRegistryV2` 的紀錄比對；每筆標出 PCAF 資料品質的約略等級（`CARBON_METHODOLOGY.md` §7 第 4、6 項）。
- 不需要金鑰、4–6 h；Demo 是「點一下就能從鏈上雜湊追到原始報告」。
- 不能解決的：見證者不獨立（只能在 ④ 的新登錄上指派不同地址，仍屬同一團隊）。

### 4.4 建議時程

| 時間 | 項目 |
|---|---|
| 10/6–10/7 | 1P 文字修正（第 5.1 節）——**10/7 交件前必做** |
| 10/8–10/14 | ①、③、⑥（純鏈下，不需金鑰） |
| 10/14–10/20 | ②；決定是否做 ④（需要使用者準備新金鑰與測試幣、找一個不影響其他示範的時段編譯） |
| 10/21 | 20P：①②③⑥ 以「已完成」寫入；④⑤ 依實際進度寫成「已完成」或「設計＋時程」，**不得預寫成已上線** |
| 10/21–11/30 | ④ → ⑤ |
| 12/1–12/7 | Demo 彩排；週末與平日各錄一次休市行為的畫面備援 |

---

## 5. 敘事建議

### 5.1 1P 必須修正的說法（10/7 前）

目前 1P 的內容檔（交件資料夾內的 `content_1p.py`，本文不修改它）有三句話與鏈上事實不符，另兩句建議收斂：

| 現行說法 | 問題 | 建議改成 |
|---|---|---|
| 「異常價格經多來源確認並熔斷」 | 股票與 ETF 只有 Yahoo 一個來源，多源確認只對加密資產有效 | 「異常價格超過門檻即熔斷拒寫（加密資產需兩個來源確認，股票改由人工覆核）」 |
| 「分級由見證者上鏈並取中位數」 | 目前每檔只有 1 筆見證，見證者就是營運方 | 「分級以見證紀錄上鏈、合約取中位數（目前為自有見證，尚無第三方）」 |
| 「RWA 標的須通過鏈上 KYC 才能開倉（前端只送雜湊）」 | 現役登錄沒有審核步驟；sGOLD 沒有被標記 | 「參照證券的標的設有鏈上 KYC 開倉閘門（測試網示範，不做真實身分審查；前端只送雜湊）」 |
| 「11 檔合成標的：涵蓋美股、綠債／潔淨能源／ESG ETF、黃金與加密資產」 | 正確，但沒說哪些是 RWA | 可加「其中 9 檔參照真實世界資產」 |
| 英文「KYC-gated RWA markets」 | 同第三列 | 「KYC-gated (demo) markets referencing securities」 |

篇幅不夠時，前三列優先。

### 5.2 20P 與簡報的用語

- **用**：「參照 RWA 的鏈上衍生品層」「RWA-referenced perpetuals」「合成曝險（synthetic exposure）」「不發行、不託管、不給標的權利」「對手方償付能力在鏈上可查」。
- **不要用**：「把真實資產上鏈」「代幣化股票」「持有 RWA」「Proof of Reserve」（除非緊接著說明「我們證明的是對手方償付能力，不是標的儲備」）、「去中心化預言機」、「合規」（改用「合規閘門機制」）、「通過 KYC」（改用「通過示範 KYC 閘門」）。
- **一定要講的一張投影片**：「發行端 vs 衍生品層」對照（第 1 節的表），以及 9 項判準的自評表（第 3.1 節）——誠實的自評比宣稱全部做到更能拿到「完整性」與「可行性」的分數。
- **把弱點轉成路線圖**：每一個「部分」都對應到第 4 節的一個方案或一份既有 ADR（ADR-013 預言機、ADR-015 V3、DESIGN_BESU 許可鏈與 VC 准入），讓評審看到「知道缺什麼、知道怎麼補、知道補不了的為什麼補不了」。

### 5.3 評審可能的質疑與回答

| 質疑 | 回答要點 |
|---|---|
| 你們沒有任何真實資產，憑什麼叫 RWA？ | 我們定位為衍生品層，不做發行（ADR-002）。期貨與 CFD 也不持有現貨；業界也有 RWA 永續合約（例如 Ostium）。依 SEC 委員 Peirce 的聲明，不給所有權的 token 可能是 security-based swap——所以我們從一開始就以衍生品自居，並把對公眾的服務交給持牌機構。 |
| 價格是你們自己寫上鏈的，怎麼信？ | 是，現役是受信任的 keeper 中繼，這寫在 README §5。我們有 20% 熔斷與加密資產的兩源確認；股票只有單一來源，所以大跳空一律人工覆核。Base Sepolia 上沒有 Chainlink 股票 feed；長期方案是 Pyth 簽名價為主、Chainlink 為交叉比對（ADR-013）。看板（②）讓任何人都能對帳。 |
| 週末美股休市，你們還能開倉？ | 現役合約可以，這是已知限制 #31。修正（休市切 ReduceOnly、保留平倉與清算）已在原始碼，現役合約因 owner 金鑰問題無法升級；示範租戶（④）展示修正後的行為。 |
| KYC 是真的嗎？ | 不是。鏈上只是一個閘門機制，個資不上鏈。身分審查是持牌客戶的責任（COMPLIANCE_BOUNDARY）。我們展示的是「審查結果如何被鏈上強制、如何到期與撤銷」（⑤）。 |
| 金庫非足額抵押，擠兌怎麼辦？ | 金庫是合成曝險的對手方，以 110% 準備率門檻、破線停鑄與逐資產上限控制；贖回永遠不受準備率限制（ADR-004）。所有數字在鏈上可查。測試網上的比率很高是因為負債小、準備是測試幣，不代表正式環境的資本適足。 |
| 股票拆股或發股利怎麼處理？ | 拆股：熔斷、不寫入新單位價格，人工決定換算或結算（RUNBOOK_KEEPER）。股利：目前不調整，已揭露；代幣化股票的做法是再投資或 multiplier（xStocks、Ondo），衍生品的做法是對多空部位做股利調整，列為後續工作。 |
| 碳分級誰說了算？ | 方法論公開、門檻是合約常數、營運方不能調；但現在只有自有見證、沒有第三方確信，資料品質約 PCAF 2 到 5（CARBON_METHODOLOGY §5）。改進路線是獨立見證者與第三方確信。 |
| 在台灣能做嗎？ | 參照證券的槓桿差價契約屬受監理業務（《期貨交易法》槓桿保證金契約、槓桿交易商需許可，條文見 DESIGN_BESU §5，需法遵確認）。本作品是研究原型，商業路徑是 B2B 給持牌機構，或走金融科技創新實驗。金管會的 RWA 代幣化小組做的是債券與基金的**發行端**，和我們的衍生品層互補。 |
| 為什麼不用 ERC-3643？ | ERC-3643 解決的是可轉讓證券代幣的發行與轉讓合規。永續部位本來就不可轉讓；我們只取它的准入精神（⑤），不取發行與轉讓的部分。技術棧衝突的理由見 ADR-002。 |

---

## 6. 不建議做的事

- 不要為了「看起來像 RWA」在現役交易所加任何功能：0 B 餘裕，也沒有 owner 金鑰。
- 不要做一個「演出來的」託管或 PoR（例如自己簽一份儲備聲明）。ADR-002 與 ADR-004 已經說明它會讓真正誠實的部分一起被懷疑。
- 不要把 Chainlink 主網的「Coinbase AAPL」說成 Apple 股價，也不要把 Pyth 說成「已經接上」——現役交易所不讀任何簽名價。
- 不要在 20P 預寫 ④⑤ 為已上線；寫「設計＋時程」或在完成後再更新。

---

## 7. 未查證事項（不得寫成事實）

1. Base Sepolia 上沒有 Chainlink 股票與 XAU/USD feed：依據是 Chainlink 公開目錄 JSON，與 docs.chain.link 網頁的對應關係未查證。
2. Pyth Hermes API key 是否涵蓋測試網、免費額度與條款；Pyth 在 Base Sepolia 的位址以 ADR-013 引用的 Pyth 升級頁為準，舊位址 `0xA2aa…5729` 是否仍接受新 payload 未查證。
3. Ostium 是否完全沒有底層資產（「合成」的定性）。
4. xStocks 的 PoR 是否由 Chainlink 提供。
5. BlackRock BUIDL（合格買方、白名單、Securitize）與 Centrifuge（SPV 結構）只查到二手來源，本文沒有把它們當成判準依據。
6. PAXG 由哪一個機關監理：官方頁寫「受 OCC 監管的 trust company」，常見的「NYDFS」說法未在官方頁核對。
7. ESMA 2026-09 Risk Monitor「Tokenisation of equities」專節的內文引句（只讀到二手轉述）。
8. 台灣 STO 的「第一類／第二類」分法；證券商能否辦理 CFD；「差價契約是槓桿保證金契約的型態之一」（`DESIGN_BESU.md:484` 已標需確認）。
9. Yahoo 與 CoinGecko 資料的商業使用授權。

## 8. 來源

外部（查證日 2026-10-06，另註明者除外）：

| 來源 | URL | 性質 |
|---|---|---|
| BIS Annual Economic Report 2025 第三章 | <https://www.bis.org/publ/arpdf/ar2025e3.htm> | 一手 |
| IOSCO FR/17/25 Tokenization of Financial Assets | <https://www.iosco.org/library/pubdocs/pdf/IOSCOPD809.pdf> | 一手（摘要取得） |
| FSB 2024 Financial Stability Implications of Tokenisation | <https://www.fsb.org/2024/10/the-financial-stability-implications-of-tokenisation/> | 一手 |
| rwa.xyz Distributed vs Represented | <https://app.rwa.xyz/blog/a-new-framework-for-tokenized-assets-distributed-and-represented> | 一手 |
| rwa.xyz 資產類別 | <https://www.rwa.xyz/> | 一手 |
| ERC-3643 | <https://eips.ethereum.org/EIPS/eip-3643> | 一手 |
| ERC-1400（Draft） | <https://github.com/SecurityTokenStandard/EIP-Spec/blob/master/eip/eip-1400.md> | 一手（非 EIP 官網） |
| Chainlink Proof of Reserve | <https://chain.link/proof-of-reserve> | 一手 |
| Chainlink Data Feeds 選用與市場時段 | <https://docs.chain.link/data-feeds/selecting-data-feeds> | 一手 |
| Chainlink Data Streams market hours | <https://docs.chain.link/data-streams/market-hours> | 一手 |
| Chainlink 24/5 美股 streams | <https://docs.chain.link/data-streams/rwa-streams/24-5-us-equities-user-guide> | 一手 |
| Chainlink Base Sepolia feed 目錄 | <https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia-base-1.json> | 一手（目錄 JSON） |
| Pyth market hours | <https://docs.pyth.network/price-feeds/core/market-hours> | 一手 |
| Pyth Core 升級與位址（2026-10-02 查證，見 ADR-013） | <https://docs.pyth.network/price-feeds/core/upgrade/contracts> | 一手 |
| Ondo Global Markets / Ondo Stocks | <https://ondo.finance/ondo-stocks> | 一手 |
| xStocks FAQ、公司行動 | <https://support.kraken.com/articles/xstocks-faq>、<https://support.kraken.com/articles/corporate-actions-xstocks-kraken-app> | 一手 |
| Ostium price oracle | <https://ostium-labs.gitbook.io/ostium-docs/supporting-infrastructure/price-oracle> | 一手 |
| Paxos PAXG | <https://www.paxos.com/pax-gold> | 一手 |
| SEC 委員 Peirce 聲明 | <https://www.sec.gov/newsroom/speeches-statements/peirce-statement-tokenized-securities-070925> | 一手（個人聲明） |
| ESMA TRV Risk Monitor 2/2026 | <https://www.esma.europa.eu/sites/default/files/2026-09/ESMA50-1949966494-4282_TRV_Risk_Monitor_2_2026.pdf> | 一手連結，內文未讀 |
| 櫃買中心 STO | <https://www.tpex.org.tw/web/STO/index.php?l=zh-tw> | 一手 |
| 金管會 2022-01 STO 放寬 | <https://www.fsc.gov.tw/ch/home.jsp?id=96&parentpath=0%2C2&mcustomize=news_view.jsp&dataserno=202201200002&aplistdn=ou%3Dnews%2Cou%3Dmultisite%2Cou%3Dchinese%2Cou%3Dap_root%2Co%3Dfsc%2Cc%3Dtw&dtable=News> | 一手 |
| 金管會 RWA 代幣化小組期末報告 | <https://www.fsc.gov.tw/ch/home.jsp?id=96&parentpath=0%2C2&mcustomize=news_view.jsp&dataserno=202511040002&aplistdn=ou%3Dnews%2Cou%3Dmultisite%2Cou%3Dchinese%2Cou%3Dap_root%2Co%3Dfsc%2Cc%3Dtw&dtable=News> | 一手 |
| 《期貨交易法》 | <https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0400100> | 一手 |

Repo 內：[`ADR-002`](ADR-002-rwa-demand-layer.md)、[`ADR-004`](ADR-004-reserve-transparency.md)、[`ADR-006`](ADR-006-carbon-tier-is-a-witnessed-fact.md)、[`ADR-013`](ADR-013-pull-oracle.md)、[`ADR-016`](ADR-016-vc-credential-status.md)、
[`COMPLIANCE_BOUNDARY.md`](COMPLIANCE_BOUNDARY.md)、[`CARBON_METHODOLOGY.md`](CARBON_METHODOLOGY.md)、[`DESIGN_BESU.md`](DESIGN_BESU.md)、[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)、
[`PARAMS_INVENTORY.md`](PARAMS_INVENTORY.md)、[`RELEASE_STATUS.md`](RELEASE_STATUS.md)、[`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md)、[`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md)。
