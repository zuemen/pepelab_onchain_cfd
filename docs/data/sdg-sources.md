# 資產與 SDG：來源查核，以及為什麼不做資產 SDG 標籤

> [#333](https://github.com/zuemen/pepelab_onchain_cfd/issues/333) 的資料交付物。取用日期：2026-10-16。
> **結論（2026-10-16 決定）：平台不替資產標示聯合國永續發展目標（SDG）。** 原本草擬的對應表（資產 → SDG、
> 排行榜依 SDG 篩選、交易者頁與投資組合的 SDG 分布）已從程式移除；永續改放在可以驗證的地方：
> 鏈上的碳權退役（ADR-022）與依鏈上見證的碳分級組成。本檔是做這個取捨的依據。

## 為什麼查、查了什麼

#333 原本要「每個資產標示相關的 SDG 目標與對應理由」。草稿是團隊依資產組成自行判斷，沒有附來源。
我們的立場和 [carbon-intensity.md](carbon-intensity.md) 一樣：畫面上任何一個標籤，被問「出處是什麼」
都要答得出來。所以逐一去找第一手來源——**發行方自己有沒有把這個資產（或它的發行公司）連到某個 SDG**。

SDG 從頭到尾不進入定價（手續費與槓桿只看碳分級，ADR-003），所以這份表沒有定價壓力替它把關；
正因如此，更不能讓團隊意見包裝成聯合國目標。

## 結論

11 個資產裡：

| 結果 | 資產 |
|---|---|
| **發行方自己點名 SDG**（explicit SDG） | sBOND（BGRN Impact Report：7、11、12、13）、sNVDA（9）、sMSFT（9） |
| 業界組織點名 SDG，但方向要我們推論 | sGOLD（World Gold Council 點名 6、13、15，框架是正面貢獻；負方向是從它承認的影響讀出來的，而且 sGOLD 追蹤的是金價，不是礦業） |
| **只有影響數據，SDG 要我們自己歸類**（impact only） | sBTC、sAAPL、sTSLA、sGOOGL、sICLN |
| **完全沒有來源** | sETH、sESGU |

草稿的 23 筆對應中，有 10 筆找不到來源或與來源相反（逐筆見各資產小節）。

所以如果保留 SDG 標籤，畫面上的大多數標籤會是**平台自己對別人資產的永續宣稱**。這正是本平台在其他地方
刻意不做的事：碳權退役只說「退役」、不說「抵銷」，受益人寫平台、不寫使用者（ADR-022，參照歐盟指令
2024/825 對永續宣稱的要求）。只留有來源的 3–4 個資產，交易者頁的分布與排行榜篩選又會大半落在
「未對應」，看起來比沒有更空。兩條路都不好，因此不做。

**留下來的永續功能**（都能在鏈上驗證）：

- 碳權退役：跟單手續費的平台份額依合約寫死的比例撥入，鏈上買入並銷毀模擬碳權（ADR-022）。
- 碳分級組成：交易者策略與使用者持倉落在各碳分級的比例，等級讀自交易所定價用的鏈上見證。

## 如果日後要重新考慮

下面任何一項成立，都值得重新評估資產 SDG 標籤：

1. **Tesla 的 SDG 表。** *2024 Extended Impact Report* 第 188 頁有 "United Nations SDG Alignment"，這次自動擷取被擋
   （403／超過 10 MB）。用瀏覽器打開就能確認。
2. **超過 10 MB 沒打開的報告**：Apple Environmental Progress Report 2025、Microsoft Environmental Sustainability Report
   2025／2026、Google Environmental Report 2025／2026。官網 HTML 與 blog 都沒有提到 SDG，PDF 內有沒有 SDG 索引沒有確認。
3. **UNU 比特幣論文全文**（Wiley 回傳 403）是否點名 SDG。
4. **「自我宣稱 vs. 自己的數據」的規則**：Microsoft（SDG 7、13）與 NVIDIA（SDG 13）自稱正面貢獻，但公布的排放都在上升。
   要重做標籤，得先定一條所有發行方共用的規則。
5. 改用有方法論、可查核的第三方 SDG 資料（例如 ETF 發行商日後公布的 SDG 對應），而不是團隊判斷。

## 交叉發現（不屬於 SDG，另案處理）

iShares fact sheet 上 ICLN 的持股加權碳強度（WACI 299.74）高於 ESGU（75.61），與 carbon-intensity.md 把 ICLN 定性放在
低碳、ESGU 放在中碳的方向相反；BGRN 的指數全名應為 Bloomberg MSCI USD **Green Bond Select** Index。
碳分級會進入定價，已另開工作處理。

---

## 方法

**什麼算第一手來源**

- 發行者自己的文件：公司的永續／環境／影響力報告、官網的 SDG 聲明、SEC 申報（10-K）；ETF 發行者（BlackRock / iShares）的產品頁、fact sheet、impact report；指數提供者（MSCI / Bloomberg）的方法論。
- 擁有該框架的機構：ICMA（綠色債券原則與 SDG 對應表）、World Gold Council（黃金產業）、Ethereum Foundation（ethereum.org）。
- 聯合國機構或同儕審查研究：UNU-INWEH 的比特幣研究、IEA 的資料中心用電報告。
- 新聞、部落格、第三方 SDG 評等（ISS ESG 等）、彙整網站**不算**，只拿來找原始文件。

**三種判定**

| 判定 | 意思 |
|---|---|
| **explicit SDG** | 來源本身寫出了這個 SDG（編號或名稱）。方向（正／負）另外註明是來源自述，還是由來源的影響敘述支持。 |
| **impact only** | 來源記錄了影響（耗電、排放、再生材料比例……），但沒有點名任何 SDG。把它歸到某個 SDG 是團隊的推論，畫面上要照實標示。 |
| **not found** | 找不到第一手來源支持，或來源與草稿相反。 |

另外兩個標記：

- **contested**：發行者自己宣稱對某 SDG 有正面貢獻，但同一發行者公布的數據顯示相反的趨勢（例如排放上升）。這種情況兩個方向都不寫進對應表，列入「待決問題」。
- **未能開啟**：文件存在但這次抓不到（HTTP 403 或檔案超過 10 MB 擷取上限），照實寫出來，不憑摘要猜內容。

PDF 的頁碼是文件本身印的頁碼。引文保留原文語言，每段 25 字以內。

---

## sBTC（Bitcoin）

草稿：7 負、13 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 7 | 負 | impact only | UNU（聯合國大學）新聞稿〈UN study reveals hidden environmental impacts of Bitcoin〉，2023-10-24，[unu.edu](https://unu.edu/press-release/un-study-reveals-hidden-environmental-impacts-bitcoin-carbon-not-only-harmful-product)；所依據的論文：Chamanara, Ghaffarizadeh & Madani (2023), *Earth's Future*, [doi:10.1029/2023EF003871](https://doi.org/10.1029/2023EF003871) | 2020–2021 年全網 "consumed 173.42 Terawatt hours of electricity"；"coal accounting for 45% of Bitcoin's energy supply mix"。沒有點名任何 SDG。 |
| 13 | 負 | impact only | 同上 | "Bitcoin mining emitted over 85.89 Mt of CO2 during the 2020–2021 period"。沒有點名 SDG。 |
| 6 | 負（新增候選） | impact only | 同上 | "The global water footprint of Bitcoin mining in 2020–2021 was 1.65 km3"。 |
| 15 | 負（新增候選） | impact only | 同上 | 土地足跡 "was more than 1,870 square kilometers"。 |

- 新聞稿正文沒有點名任何 SDG（頁面側欄有「Climate action」等主題標籤，那是網站分類，不是研究結論，不採用）。
- 論文全文在 Wiley 回傳 403、UNU Collections 頁面抓回來是空的，**論文本身有沒有提到 SDG 未能確認**；以上數字取自 UNU 自己的新聞稿。
- 碳排的另一個獨立估計（Cambridge CBECI，≈39.8 Mt CO2e/年）已記在 carbon-intensity.md；兩者期間與方法不同，不能直接比。
- 草稿兩筆方向正確、有據，但都只能標 impact only。

## sETH（Ethereum）

草稿：9 正。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 9 | 正 | **not found** | Ethereum Foundation，〈Ethereum energy consumption〉，ethereum.org（頁面未標年份，取用 2026-10-16），[ethereum.org/en/energy-consumption](https://ethereum.org/en/energy-consumption/) | 頁面完全沒有提到 SDG，也沒有把以太坊描述成 SDG 9 意義上的基礎設施。 |
| （7／13） | — | impact only，但不支持正向 | 同上 | "CCRI estimates that The Merge reduced Ethereum's annualized electricity consumption by more than 99.988%"；年用電約 0.0026 TWh。 |

- 草稿理由「改為權益證明後耗電大幅下降」講的是能源，卻掛在 SDG 9；而能源數據只證明「不再是負面」，不等於對 SDG 7 或 13 有正面貢獻。
- ethereum.org 提到 ReFi 社群與 Gitcoin 的氣候募資輪，但那是生態系裡的個別專案，不是持有 ETH 的影響。
- **建議：sETH 不列任何 SDG。**

## sAAPL（Apple）

草稿：12 正、8 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 12 | 正 | impact only | Apple Newsroom，〈Apple accelerates progress with highest-ever recycled material in its products〉，2026-04，[apple.com/newsroom](https://www.apple.com/newsroom/2026/04/apple-accelerates-progress-with-highest-ever-recycled-material-in-its-products/)（隨 Environmental Progress Report 2026 發布） | "a record 30 percent of material across all of its products shipped in 2025" 來自再生材料。沒有提到 SDG。 |
| 12 | 正 | impact only（佐證） | Apple，〈Environment〉，[apple.com/environment](https://www.apple.com/environment/) | 電池使用 "100% recycled cobalt"；拆解機器人 Daisy 可拆 36 款 iPhone。沒有提到 SDG。 |
| 8 | 負 | **not found** | Apple，〈How we hold suppliers accountable〉，2025-04，[PDF](https://s203.q4cdn.com/367071867/files/doc_downloads/2025/04/Apple-How-we-hold-suppliers-accountable.pdf) | 文件描述稽核制度（2024 年 893 次評估、其中 203 次未事先通知；工時上限 60 小時），沒有量化違規情形，也沒有提到 SDG。 |

- Environmental Progress Report 2025 的 PDF 超過 10 MB 擷取上限，**未能開啟全文**檢查有沒有 SDG 索引；apple.com 官網與 2026 newsroom 都沒有提到 SDG。
- 草稿 SDG 8 負的理由（「供應鏈曾有勞動條件疑慮」）的出處都是 NGO 與新聞報導，不是第一手來源。Apple 自己的供應鏈文件只描述管理制度，不能拿來證明負面影響。**建議拿掉。**

## sTSLA（Tesla）

草稿：7 正、11 正、12 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 7 | 正 | impact only | Tesla, Inc. Form 10-K FY2025，2026，[SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1318605/000162828026003952/tsla-20251231.htm) | "In 2025, we deployed 46.7 GWh of energy storage products."（MD&A）。10-K 沒有提到 SDG。 |
| 7／11／12 | — | **未能開啟** | Tesla，*2024 Extended Impact Report*，2025，[PDF](https://www.tesla.com/ns_videos/2024-extended-version-tesla-impact-report.pdf) | 目錄列有 "TCFD, SASB and United Nations SDG Alignment"（第 188 頁），但 tesla.com 回傳 403、tesla.cn 版本超過 10 MB，**表的內容沒看到**。 |
| 11 | 正 | not found（待上面那份） | — | 沒有第一手來源；ICMA 把 Clean Transportation 對到 11.2，但那是債券資金用途的框架，不適用於一家公司的股票。 |
| 12 | 負 | **not found** | 10-K FY2025（同上） | 10-K 只寫到 "prices and availability of raw materials such as lithium, nickel and/or other metals"，講的是價格與供應風險，沒有講開採的環境或人權影響；cobalt 沒有出現。 |

- 注意：FY2025 10-K 的使命敘述已改為 "Our mission is building a world of amazing abundance."，不再是「加速世界轉向永續能源」。理由文字如果引用舊使命要改。
- **Tesla 是唯一一家「發行者自己有 SDG 表、但這次讀不到」的公司**，請有一般瀏覽器的組員打開第 188 頁抄下來（見待決問題）。在那之前只保留 7 正（impact only）。

## sGOLD（黃金，XAU）

草稿：15 負、6 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 6 | 負 | explicit SDG（方向由來源的負面影響敘述支持） | World Gold Council，*Gold Mining's Contribution to the UN Sustainable Development Goals*，2020，[PDF](https://www.gold.org/download/file/15248/Sustainable-development-goals-report.pdf) | p.2 主題表把 SDG 6 列在 "Responsible operations, energy and the environment"；p.48："Gold mining's impact on water is often identified as one of the biggest challenges associated with the industry" |
| 15 | 負 | explicit SDG（同上） | 同上 | p.2 同一主題列有 SDG 15；p.48："Gold mining is resource-intensive. It requires access to significant amounts of land, water and energy."；p.4（Lisa Sachs 序）：採礦 "inevitably impact on the environment, including water sources and biodiversity" |
| 13 | 負（新增候選） | explicit SDG（同上）＋ 數據見 carbon-intensity.md | 同上；排放數據見 [carbon-intensity.md](carbon-intensity.md) 的 sGOLD 段（0.85 tCO2e/oz） | WGC 把 SDG 13 列在同一主題下，p.48 說業者的貢獻在於 "limiting or mitigating their potential negative impact on the environment and the climate" |

- WGC 是產業協會，整份報告的框架是「金礦業者**貢獻**於 SDG」——正面敘述是減緩措施與社區專案。負方向的依據是同一份報告自己承認的負面影響（p.48 "Gold mining's negative impacts can, of course, still be further reduced"）。所以標為 explicit SDG，但方向要註明「由來源承認的影響支持，非來源的結論」。
- 草稿 SDG 6 的理由寫「氰化物與重金屬」。WGC 報告只在框架清單提到 International Cyanide Management Code，以及手工採金（ASGM）"accounts for up to 40% of global mercury emissions"（p.25，ASGM 專題）。建議理由改用 WGC 的原話（用水密集、水是最大挑戰之一），不要寫成氰化物污染。
- 方法上的落差要在畫面上說明：sGOLD 追蹤的是金價，不是礦業公司。把採礦影響歸到持有黃金，前提是「持有需求支撐開採」，這是團隊的推論。
- WGC 的 *Responsible Gold Mining Principles*（2019）第 9、10 條（"Biodiversity, land use and mine closure"、"Water, energy and climate change"）在上述報告 p.8 有對照，原則文件本身這次沒有另外打開。

## sBOND（iShares USD Green Bond ETF，BGRN）

草稿：7 正、13 正。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 7 | 正 | **explicit SDG** | BlackRock / iShares，*iShares USD Green Bond ETF Annual Impact Report – 2026*（資料截至 2026-06-30），[PDF](https://www.ishares.com/us/literature/presentation/bgrn-impact-report.pdf) | p.2–4："UN Sustainable Development Goals (SDGs) that BGRN aligns with include:" Affordable and Clean Energy、Sustainable Cities & Communities、Responsible Consumption & Production、Climate Action |
| 13 | 正 | **explicit SDG** | 同上 | 同上 |
| 11 | 正（新增） | **explicit SDG** | 同上 | 同上 |
| 12 | 正（新增） | **explicit SDG** | 同上 | 同上；註腳："This is a non-exhaustive list of UN SDGs aligned with the fund." |
| 7、9、11、12、13 | 正 | explicit SDG（框架層級佐證） | ICMA，*Green, Social and Sustainability Bonds: A High-Level Mapping to the Sustainable Development Goals*，2023-06，[ICMA 頁面](https://www.icmagroup.org/sustainable-finance/the-principles-guidelines-and-handbooks/mapping-to-the-sustainable-development-goals/)；閱讀的是 IFC 代管的同一份 [PDF](https://www.ifc.org/content/dam/ifc/doc/2023/Green-Social-and-Sustainability-Bonds-A-High-Level-Mapping-to-the-Sustainable-Development-Goals-June-2023.pdf) | p.6：Energy Efficiency (7.3, 7a)、Renewable Energy (7.2, 7a)；p.7：Renewable Energy (9.1)、Green Buildings (11c)、Clean Transportation (11.2)、Pollution Prevention and Control (12.4, 12.5)、Climate Change Mitigation (13.1, 13.3) |
| — | — | 指數適格類別 | Bloomberg / MSCI，*Bloomberg MSCI Green Bond Indices*（primer），2021-09-07，[PDF](https://www.msci.com/downloads/web/msci-com/indexes/fixed-income-indexes/bloomberg-msci-esg-fixed-income-indexes/BBG%20MSCI%20Green%20Bond%20Indices%20Primer.pdf) | p.4：資金用途須落在 "alternative energy, energy efficiency, pollution prevention and control, sustainable water, green building, climate adaption, and other"；混合用途須 "at least 90%" 屬適格類別 |

- **這是全表唯一一個由發行者自己點名 SDG、而且方向與草稿一致的資產。** BGRN 的 impact report 列四個 SDG，草稿只放了兩個；建議補上 11 與 12。
- iShares 產品頁與 2026-06-30 fact sheet 本身都沒有提到 SDG，SDG 只出現在 impact report。
- 鏈條：指數適格類別（MSCI）→ ICMA 把同名類別對到 SDG 目標 → BlackRock 在 impact report 寫出 BGRN 對應的 SDG。三份都是第一手。
- ICMA 自己提醒（p.5）："not all projects associated with a given project category will align to the SDG or target indicated"；以及（p.4）淘汰化石燃料的專案可能對 SDG 8 產生負面影響。這是框架層級的但書，不是 BGRN 的具體負面紀錄，不列入對應。
- 指數名稱更正：基金追蹤的是 **Bloomberg MSCI USD Green Bond Select Index**（產品頁與 impact report 皆如此），不是 carbon-intensity.md 寫的 "Bloomberg MSCI USD Green Bond index"。

## sNVDA（NVIDIA）

草稿：9 正、7 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 9 | 正 | **explicit SDG** | NVIDIA，*FY2025 Sustainability Report*，2025，[PDF](https://images.nvidia.com/aem-dam/Solutions/documents/NVIDIA-Sustainability-Report-Fiscal-Year-2025.pdf)；*FY2024 Corporate Sustainability Report*，2024，[PDF](https://images.nvidia.com/aem-dam/Solutions/documents/FY2024-NVIDIA-Corporate-Sustainability-Report.pdf) | "U.N. Sustainable Development Goals" 表（FY25 p.39、FY24 p.40）："We continue to align our business activities to the UN Sustainable Development Goals." SDG 9 這一列講 Trustworthy AI 與 NAIRR 研究資源 |
| 13 | 正 | **contested** | 同上；排放數據：*NVIDIA Sustainability Report Fiscal Year 2026*，2026，[PDF](https://images.nvidia.com/aem-dam/Solutions/documents/NVIDIA-Sustainability-Report-Fiscal-Year-2026.pdf) | NVIDIA 自列 SDG 13（再生電力、Earth-2 氣象模型）；但 FY26 報告指標表 Scope 3 為 10,700,940 tCO2e，FY24 為 3,638,432——約三倍；location-based Scope 2 由 178,087 升到 308,891 |
| 7 | 負 | impact only（產業層級，非 NVIDIA 專屬） | IEA，*Energy and AI*，2025，[執行摘要](https://www.iea.org/reports/energy-and-ai/executive-summary) | "Data centre electricity consumption is set to more than double to around 945 TWh by 2030."；"AI is the most important driver of this growth"。沒有提到 SDG，也沒有點名 NVIDIA。 |
| 3、4、5 | 正 | explicit SDG（與資產敘事無關，僅記錄） | FY24、FY25 報告同一張表 | 員工福祉（3）、教育計畫（4）、薪酬平等（5） |

- SDG 圖示是圖片，`pdftotext` 讀不到；編號取自 PDF 結構標籤的替代文字（FY24 與 FY25 都是 "TheGlobalGoals_Icons #3 / #4 / #5 / #9 / #13"）。
- FY26 報告也有同一張表（目錄 p.39），但那份 PDF 沒有結構標籤，**圖示編號未能確認**；文字列看得出是福祉、教育、能源效率／電網、溫室氣體四列，不能據此推定編號。
- 草稿 SDG 7 負的依據（資料中心用電成長）有 IEA 的第一手數據，但那是整個資料中心產業，NVIDIA 自己的報告不計客戶端 GPU 用電（Scope 3 的使用階段另以 "per PFLOP" 強度目標表示）。把產業趨勢歸到單一晶片供應商是推論，**建議拿掉**，或在待決問題中由組員決定是否以 impact only 保留。

## sMSFT（Microsoft）

草稿：9 正、7 負。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 9 | 正 | **explicit SDG** | Microsoft，〈Our commitment to sustainable development〉，[microsoft.com/…/un-sdgs](https://www.microsoft.com/en-us/corporate-responsibility/un-sdgs)（頁面未標年份，取用 2026-10-16） | SDG 9 "Industry, Innovations, and Infrastructure" 列在 "Earn trust" 支柱下；Microsoft 支持 "the SDGs as a set of 17 universal goals for all parties to achieve by 2030" |
| 7 | 負 | **contested（來源方向相反）** | 同上；排放數據：Microsoft On the Issues，〈Our 2025 Environmental Sustainability Report〉，2025-05-29，[blogs.microsoft.com](https://blogs.microsoft.com/on-the-issues/2025/05/29/environmental-sustainability-report/) | Microsoft 把 SDG 7 列為**正面**貢獻（"Advance sustainability" 支柱）；但同年報告說 "total emissions (Scope 1, 2, and 3) have increased by 23.4% compared to our 2020 baseline"，能源使用 "a 168% increase" |
| 13 | 正 | contested | 同上 | Microsoft 自列 SDG 13；排放同上 |
| 4、5、6、8、10、11、12、14、15、16、17 | 正 | explicit SDG（僅記錄） | un-sdgs 頁面 | 其餘支柱下的目標 |

- **草稿 SDG 7 負與發行者自己的 SDG 聲明相反。** 發行者宣稱的是 SDG 7 正面（簽約 34 GW 無碳電力），而它自己公布的排放數據是上升的。這種「自我宣稱 vs. 自己的數據」的衝突不該由團隊選邊，兩個方向都不放進對應表。
- 2026 Environmental Sustainability Report（FY25 資料）的 PDF 超過 10 MB，**未能開啟**；新聞報導說 FY25 排放再增約 25%，但沒讀到原文，不採用。microsoft.com 的報告頁只確認 FY25 "match 100% of our annual electricity consumption with renewable energy"。

## sGOOGL（Alphabet）

草稿：9 正、7 正。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 7 | 正 | impact only | Google（Kate Brandt），〈Read Google's 10th annual Environmental Report〉，2025-06-27，[blog.google](https://blog.google/outreach-initiatives/sustainability/environmental-report-2025/) | "In 2024, we made our largest-ever procurement of clean energy"；"We reduced our data center energy emissions by 12%"。沒有提到 SDG。 |
| 7 | 正 | impact only（佐證，較舊） | Google，〈Our biggest renewable energy purchase ever〉，2019-09-19，[blog.google](https://www.blog.google/outreach-initiatives/sustainability/our-biggest-renewable-energy-purchase-ever/) | "we became the largest corporate buyer of renewable energy in the world"（2019 年的自述，現況未驗證） |
| 9 | 正 | **not found** | 2025、2026 Environmental Report 概覽頁，[sustainability.google](https://sustainability.google/reports/google-2026-environmental-report/) | 概覽頁與 blog 都沒有提到 SDG；完整 PDF 超過 10 MB，未能開啟。 |

- 同一篇 2025 blog 也寫了 "a 27% increase in electricity demand to power our data centers"，以及總排放 "increased by 11% year-on-year"。SDG 7（採購潔淨能源）有據，但若要談 SDG 13，數據是往負面走的；草稿沒有放 13，維持不放。
- 草稿理由「最大企業買家之一」只有 2019 年的自述；建議改寫成 2025 報告的「史上最大一次潔淨能源採購」。
- Alphabet 沒有找到自己的 SDG 對應文件。**SDG 9 建議拿掉。**

## sICLN（iShares Global Clean Energy ETF）

草稿：7 正、13 正。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 7 | 正 | impact only | iShares，ICLN fact sheet（截至 2026-06-30），[PDF](https://www.ishares.com/us/literature/fact-sheet/icln-ishares-global-clean-energy-etf-fund-fact-sheet-en-us.pdf)；產品頁 [ishares.com](https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf) | "seeks to track an index of global companies involved in clean energy"；"a way to pursue long-term growth in renewable energy"。指數：S&P Global Clean Energy Transition Index。沒有提到 SDG。 |
| 13 | 正 | **not found**（數據不支持草稿理由） | 同一份 fact sheet 的 Sustainability Characteristics（MSCI ESG Fund Ratings，2026-06） | 沒有 SDG。MSCI Weighted Average Carbon Intensity **299.74** tCO2e/$M sales；MSCI Implied Temperature Rise **> 1.5°–2.0°C** |

- iShares 沒有為 ICLN 發布 impact report（`icln-impact-report.pdf` 回傳 404，搜尋也找不到），產品頁與 fact sheet 都沒有 SDG。
- 草稿 SDG 13 的理由說「減少發電排放」，但 iShares 沒有發布避免排放數據；fact sheet 上的持股加權碳強度 299.74 反而**高於** ESGU 的 75.61（成分股多為電力公司，營收小、發電資產重）。這不代表潔淨能源比大盤髒，而是這個指標對電力業不利——但也正因如此，它不能拿來支持「低碳」的 SDG 13 論點。**建議拿掉 13**；若組員認為 Implied Temperature Rise 1.5–2.0°C 足以支持，可以 impact only 保留，理由文字要改寫成這個數字。

## sESGU（iShares ESG Aware MSCI USA ETF）

草稿：13 正、12 正。

| SDG | 正/負 | 判定 | 來源 | 引文／轉述 |
|---|---|---|---|---|
| 13 | 正 | **not found**（數據與草稿理由不符） | iShares，ESGU fact sheet（截至 2026-06-30），[PDF](https://www.ishares.com/us/literature/fact-sheet/esgu-ishares-esg-aware-msci-usa-etf-fund-fact-sheet-en-us.pdf) | 沒有 SDG。WACI **75.61** tCO2e/$M sales；Implied Temperature Rise **> 2.5°–3.0°C**；fact sheet 沒有和大盤比較的碳強度數字。 |
| 12 | 正 | **not found** | 產品頁 [ishares.com](https://www.ishares.com/us/products/286007/ishares-esg-aware-msci-usa-etf) | 目標是追蹤 "large- and mid-cap U.S. companies with positive environmental, social, and governance characteristics"；排除篩選為 civilian firearms、controversial weapons、tobacco、thermal coal、oil sands。沒有提到 SDG，也沒有提到消費與生產。 |

- 草稿 13 的理由「碳強度低於一般美股大盤」在 iShares 文件裡找不到比較基準；Implied Temperature Rise 超過 2.5°C 也不支持「氣候正面」。
- 草稿 12 的理由「排除爭議性產業」——實際排除清單是武器、菸草、動力煤、油砂，和 SDG 12（永續消費與生產）沒有來源上的連結。
- 指數方法論（MSCI USA Extended ESG Focus Index）這次沒有打開；若方法論本身有碳排降幅目標，13 可以 impact only 回來（見待決問題）。
- **建議：sESGU 不列任何 SDG。**

