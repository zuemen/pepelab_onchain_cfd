# 發布狀態（RELEASE_STATUS）

> **已合併不等於使用者受保護。** 合併只代表 repo 裡的原始碼改了；鏈上合約不會因為 PR 合併而改變，
> 使用者碰到的永遠是鏈上那一版。一個修正要等到「已部署」而且「鏈上＝原始碼」，才真的保護到使用者；
> 要等到「展示驗收」有證據，才能對外說它可以展示。

本文件由 `node scripts/check-deployment-status.mjs` 以唯讀 RPC 產生（2026-10-04；比對用的編譯產物是 solc 0.8.36），**不要手改**；
機器可讀版是 [`release-status.json`](release-status.json)。CI 以 `--offline` 檢查本文件仍是那份 JSON 的渲染結果、
位址仍等於 `frontend/src/contracts/**`、標成「鏈上＝原始碼」的元件原始碼沒有在產生之後被改過。部署後重跑見
[`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) 第 7 步。

## 摘要

| 鏈 | 區塊 | 鏈上＝原始碼 | 原始碼較新（待部署） | 無法比對 | 未部署 | 仍指向外洩地址的元件 | 已驗收／部分驗收 |
|---|---|---|---|---|---|---|---|
| Base Sepolia（84532） | 47661267 | 12 | 17 | 0 | 0 | 5 | 1 |
| Sepolia（11155111） | 11840223 | 3 | 20 | 0 | 0 | 17 | 0 |

外洩地址名單取自 `agent/shared/src/payoutSafety.ts` 的 `COMPROMISED_ADDRESSES`（1 個）；本文件只寫縮寫。

## Base Sepolia（84532）— 正式測試網（交易、agent session、x402 都在這條鏈）

RPC：https://sepolia.base.org；區塊 47661267。

| 元件 | 已合併（PR／commit） | 已部署 | 鏈上驗證 | 展示驗收 |
|---|---|---|---|---|
| PerpetualExchange<br>交易引擎 | #198／`264f1d4`（2026-09-30） | `0x827eA0c62a32e995927101259042F8A27D99124D` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 18861 B，原始碼 23911 B）（區塊 47661267，2026-10-04） | 未驗收（docs/DEPLOY_130_CUTOVER.md §11 的畫面驗收（開倉、平倉、跟單、agent session 下單）未勾；docs/VERIFICATION_REPORT.md B2 待錢包） |
| MockOracle<br>現行價格來源（exchange 讀的 oracle；owner 即 keeper） | #7／`a795e9f`（2026-08-07） | `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 1088 B，原始碼 1311 B）（區塊 47661267，2026-10-04） | 未驗收 |
| GuardedOracle<br>強化 oracle（多 keeper、偏離上限） | #219／`7edbf32`（2026-10-02） | `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3742 B，原始碼 8072 B）（區塊 47661267，2026-10-04） | 未驗收 |
| InsuranceVault<br>保險金庫 | #238／`2c87f4a`（2026-10-04） | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 4205 B，原始碼 4641 B）（區塊 47661267，2026-10-04） | 未驗收 |
| FeeRouter<br>平台 FeeRouter（MockUSDC；treasury 為 immutable） | #7／`a795e9f`（2026-08-07） | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2879 B，原始碼 2984 B）（區塊 47661267，2026-10-04） | 未驗收 |
| X402FeeRouter<br>x402 FeeRouter（官方 USDC；treasury 為 immutable） | #182／`fa99346`（2026-09-30） | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2879 B，原始碼 2984 B）（區塊 47661267，2026-10-04） | 部分驗收（2026-07-15）：`docs/VERIFICATION_REPORT.md`、`docs/COST_MODEL.md`。2026-06-15 部署驗證與 2026-06-15～07-15 四筆 routeExternalRevenue 實際結算 tx；x402 v2 從未實付（docs/ADR-010-x402-v2-migration.md） |
| AgentSessionManager<br>agent session（自主交易授權） | #198／`264f1d4`（2026-09-30） | `0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收（只有部署腳本建立的 session #0，沒有 agent 實際下單的 tx 紀錄（docs/VERIFICATION_REPORT.md D 項待貼）） |
| TraderStake<br>交易員質押 | #198／`264f1d4`（2026-09-30） | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3049 B，原始碼 2970 B）（區塊 47661267，2026-10-04） | 未驗收 |
| CopyTracker<br>跟單 | #198／`264f1d4`（2026-09-30） | `0xC9e91f7D36e910C58042164032c625427b23CCB2` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 6056 B，原始碼 9764 B）（區塊 47661267，2026-10-04） | 未驗收 |
| StrategyRegistry<br>策略登錄 | #111／`492594c`（2026-09-02） | `0xA103de184A5C76d7b70fB4e908F252199e004b95` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| KYCRegistry<br>KYC 登錄 | #7／`a795e9f`（2026-08-07） | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2842 B，原始碼 4454 B）（區塊 47661267，2026-10-04） | 未驗收 |
| ESGRegistryV2<br>碳分級見證登錄（V2） | #141／`182379d`（2026-09-09） | `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| ESGRegistry<br>ESG 登錄（V1） | #7／`a795e9f`（2026-08-07） | `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` | 與 ESGRegistryV2 是同一個位址，比對結果見該列 | 未驗收 |
| SustainabilityBadge<br>永續成就徽章 | #112／`9d94e54`（2026-09-02） | `0x0a4aE14a413a03c20ccF43E8134BfbD7bCB89820` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| AssetVaultV2<br>強化代幣化金庫（UUPS proxy，比對的是實作） | #198／`264f1d4`（2026-09-30） | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a`（實作 `0xa2d967221da278b26e0432f4a6bd231d7e0a3733`） | **原始碼較新（待部署）**：鏈上是舊版 AssetVaultV2_4，原始碼現行版是 AssetVaultV2_5（區塊 47661267，2026-10-04） | 未驗收（公開鏈上沒有 mint／redeem 走查紀錄；只有 fork 測試） |
| SyntheticAssetV2<br>強化金庫的合成資產代幣 | （無 PR 編號）／`8378133`（2026-07-26） | 11 顆（sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT、sGOOGL、sICLN、sESGU） | **鏈上＝原始碼**（鏈上＝原始碼 11）：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| AssetVault<br>代幣化金庫 V1（legacy 路徑） | （無 PR 編號）／`70931ed`（2026-07-26） | `0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| SyntheticAsset<br>V1 合成資產代幣 | （無 PR 編號）／`70931ed`（2026-07-26） | 11 顆（sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT、sGOOGL、sICLN、sESGU） | **鏈上＝原始碼**（鏈上＝原始碼 11）：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| PepeAMM<br>PEPE AMM | #7／`a795e9f`（2026-08-07） | `0x93be44a81a2796d378f65ebcc8d5f8b40166ad63` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3320 B，原始碼 4994 B）（區塊 47661267，2026-10-04） | 未驗收 |
| PepeIncentives<br>PEPE 獎勵 | #219／`7edbf32`（2026-10-02） | `0xEBfA1dc7dDea032ac6242cB619d982e543A23c12` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 7031 B，原始碼 6820 B）（區塊 47661267，2026-10-04） | 未驗收 |
| PepeToken<br>PEPE 代幣 | #7／`a795e9f`（2026-08-07） | `0xccd05cbdc2f7961a4c27d3633694022722786a0f` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2434 B，原始碼 2456 B）（區塊 47661267，2026-10-04） | 未驗收 |
| PepeStaking<br>PEPE 質押 | #7／`a795e9f`（2026-08-07） | `0xC78D68cA1B217ba241c23Ebad3118c6ec0dc0D34` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| PepeClaim<br>PEPE 領取 | #7／`a795e9f`（2026-08-07） | `0x459d238aC61eC4A0E08608FBcd363227B860CF34` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| EsgRewardDistributor<br>ESG 獎勵分配 | #141／`182379d`（2026-09-09） | `0x44a8E5195E168e5AdcCa4343Bd8B399B49D5609F` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| AggregatorOracle<br>Chainlink＋Pyth 聚合 oracle（展示用，keeper 的參考來源） | #7／`a795e9f`（2026-08-07） | `0x8215158642350a3f329aB9597186d21f957A813D` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 1700 B，原始碼 2643 B）（區塊 47661267，2026-10-04） | 未驗收 |
| ChainlinkAdapter<br>Chainlink 轉接 | #7／`a795e9f`（2026-08-07） | `0x37DC7b70899BFfB17949366a5b6a86203C428E2f` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 1419 B，原始碼 1906 B）（區塊 47661267，2026-10-04） | 未驗收 |
| PythAdapter<br>Pyth 轉接 | #7／`a795e9f`（2026-08-07） | `0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 1500 B，原始碼 2281 B）（區塊 47661267，2026-10-04） | 未驗收 |
| MockUSDC<br>測試結算幣 MockUSDC | #91／`8e37a0a`（2026-08-29） | `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2814 B，原始碼 2901 B）（區塊 47661267，2026-10-04） | 未驗收 |
| MockUSDT<br>測試幣 MockUSDT | #7／`a795e9f`（2026-08-07） | `0x5c8A1e970D275Cc269e09A949D68693120416d78` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |
| MockSwapRouter<br>測試兌換路由 | #91／`8e37a0a`（2026-08-29） | `0xC9b0e5C219AA1B3eB00E92Fd9a883B182F0AE8Ae` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 47661267，2026-10-04） | 未驗收 |

### Base Sepolia：仍指向已知外洩地址的項目

| 元件 | getter／角色 | 外洩地址（縮寫） |
|---|---|---|
| FeeRouter | `platformTreasury()` | `0xe80a…eb93` |
| X402FeeRouter | `platformTreasury()` | `0xe80a…eb93` |
| AggregatorOracle | `owner()` | `0xe80a…eb93` |
| ChainlinkAdapter | `owner()` | `0xe80a…eb93` |
| PythAdapter | `owner()` | `0xe80a…eb93` |

### Base Sepolia：讀不到的 getter

部署版沒有這個函式，或呼叫 revert。不代表安全，只代表這支腳本無法判斷。

- PerpetualExchange：`guardian()` — 呼叫失敗（部署版沒有這個函式？）
- PerpetualExchange：`marketOperator()` — 呼叫失敗（部署版沒有這個函式？）
- CopyTracker：`owner()` — 呼叫失敗（部署版沒有這個函式？）
- KYCRegistry：`verifiers(0xe80a…eb93)` — 呼叫失敗

### Base Sepolia：與監控快照（`ops/monitoring/deployed.json`）的差異

- AgentSessionManager：快照沒有涵蓋這個位址（監控沒有規則在看它）
- StrategyRegistry：快照沒有涵蓋這個位址（監控沒有規則在看它）
- SyntheticAsset：快照沒有涵蓋這個位址（監控沒有規則在看它）
- MockSwapRouter：快照沒有涵蓋這個位址（監控沒有規則在看它）

## Sepolia（11155111）— legacy 展示鏈（不是產品路徑；合約未做金鑰輪替）

RPC：https://ethereum-sepolia-rpc.publicnode.com；區塊 11840223。

| 元件 | 已合併（PR／commit） | 已部署 | 鏈上驗證 | 展示驗收 |
|---|---|---|---|---|
| PerpetualExchange<br>交易引擎 | #198／`264f1d4`（2026-09-30） | `0x0c6459d38617E60017bDc4ed69ec26137DA5c32b` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 18015 B，原始碼 23911 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| MockOracle<br>現行價格來源（exchange 讀的 oracle；owner 即 keeper） | #7／`a795e9f`（2026-08-07） | `0x17CA20A37Cf04F2f589B2573EC95f1411D29d958` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3194 B，原始碼 1311 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| GuardedOracle<br>強化 oracle（多 keeper、偏離上限） | #219／`7edbf32`（2026-10-02） | `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3620 B，原始碼 8072 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| InsuranceVault<br>保險金庫 | #238／`2c87f4a`（2026-10-04） | `0x8bDE83dBC2CA450B539346e224E7819348C7b091` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 8378 B，原始碼 4641 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| FeeRouter<br>平台 FeeRouter（MockUSDC；treasury 為 immutable） | #7／`a795e9f`（2026-08-07） | `0x2297e580166aF35dd0065379286f782933653079` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 5423 B，原始碼 2984 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| TraderStake<br>交易員質押 | #198／`264f1d4`（2026-09-30） | `0x3fe1dbC82eA267085CAB5eb67C6b7d3E68A7d673` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 6743 B，原始碼 2970 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| CopyTracker<br>跟單 | #198／`264f1d4`（2026-09-30） | `0xA261E76c7C465f910082b372580a57Dea4DD210d` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 11713 B，原始碼 9764 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| StrategyRegistry<br>策略登錄 | #111／`492594c`（2026-09-02） | `0x999962a2F031623cF4996841004BAE8fd0589FeB` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 7659 B，原始碼 3693 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| KYCRegistry<br>KYC 登錄 | #7／`a795e9f`（2026-08-07） | `0x7d40A2D3e39cDD1Dc613071D3C463AA161f7C5bB` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 4119 B，原始碼 4454 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| ESGRegistry<br>ESG 登錄（V1） | #7／`a795e9f`（2026-08-07） | `0xdCFdDd38e1d80C1A5eeB44c05187Ec7979B98c13` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 5327 B，原始碼 2159 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| AssetVaultV2<br>強化代幣化金庫（UUPS proxy，比對的是實作） | #198／`264f1d4`（2026-09-30） | `0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17`（實作 `0xa8a5b0e9c062e0bb1ab3a15788ae823251c41ac1`） | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 8968 B，原始碼 11838 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| SyntheticAssetV2<br>強化金庫的合成資產代幣 | （無 PR 編號）／`8378133`（2026-07-26） | 8 顆（sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT） | **鏈上＝原始碼**（鏈上＝原始碼 8）：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| AssetVault<br>代幣化金庫 V1（legacy 路徑） | （無 PR 編號）／`70931ed`（2026-07-26） | `0xB4D10cBC6143E410dd7b48797334C4397b99325f` | **鏈上＝原始碼**：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| SyntheticAsset<br>V1 合成資產代幣 | （無 PR 編號）／`70931ed`（2026-07-26） | 11 顆（sBTC、sETH、sAAPL、sTSLA、sGOLD、sBOND、sNVDA、sMSFT、sGOOGL、sICLN、sESGU） | **鏈上＝原始碼**（鏈上＝原始碼 11）：程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| PepeAMM<br>PEPE AMM | #7／`a795e9f`（2026-08-07） | `0x3e6503BA0F4ad9E4743b695141CeB48709106A0c` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 6898 B，原始碼 4994 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| PepeIncentives<br>PEPE 獎勵 | #219／`7edbf32`（2026-10-02） | `0x65b9F1B4d18822d4faBa763621E3e4eA065aE5D7` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 11242 B，原始碼 6820 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| PepeToken<br>PEPE 代幣 | #7／`a795e9f`（2026-08-07） | `0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 4321 B，原始碼 2456 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| PepeStaking<br>PEPE 質押 | #7／`a795e9f`（2026-08-07） | `0xf5d0953A443259ebdFC62fE49189998988e309f9` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 7204 B，原始碼 3353 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| PepeClaim<br>PEPE 領取 | #7／`a795e9f`（2026-08-07） | `0x852c0fBa54552aafbA4798709d90056159682A4C` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3645 B，原始碼 1531 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| EsgRewardDistributor<br>ESG 獎勵分配 | #141／`182379d`（2026-09-09） | `0xA1a522B9d31e5B48E41DcCd050DE10dA2e3BEdD0` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 5692 B，原始碼 3498 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| MockUSDC<br>測試結算幣 MockUSDC | #91／`8e37a0a`（2026-08-29） | `0x167Bacef1925184f0df34A3196F834C0622Cfd36` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 4988 B，原始碼 2901 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| MockUSDT<br>測試幣 MockUSDT | #7／`a795e9f`（2026-08-07） | `0xA08C0F92804173Bf796FDa3FA66654F96aDDB5F1` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 2814 B，原始碼 2901 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |
| MockSwapRouter<br>測試兌換路由 | #91／`8e37a0a`（2026-08-29） | `0x115CED81eD9Ef6a1c5faa428cEaf076E284b4871` | **原始碼較新（待部署）**：與原始碼現行版不一致：長度不同（鏈上 3080 B，原始碼 1450 B）（區塊 11840223，2026-10-04） | 未驗收（legacy 展示鏈，不做展示驗收） |

### Sepolia：仍指向已知外洩地址的項目

| 元件 | getter／角色 | 外洩地址（縮寫） |
|---|---|---|
| PerpetualExchange | `owner()` | `0xe80a…eb93` |
| GuardedOracle | `DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| GuardedOracle | `KEEPER_ROLE` | `0xe80a…eb93` |
| GuardedOracle | `GUARDIAN_ROLE` | `0xe80a…eb93` |
| InsuranceVault | `owner()` | `0xe80a…eb93` |
| FeeRouter | `owner()` | `0xe80a…eb93` |
| FeeRouter | `platformTreasury()` | `0xe80a…eb93` |
| TraderStake | `owner()` | `0xe80a…eb93` |
| KYCRegistry | `owner()` | `0xe80a…eb93` |
| ESGRegistry | `owner()` | `0xe80a…eb93` |
| AssetVaultV2 | `DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| AssetVaultV2 | `RISK_ROLE` | `0xe80a…eb93` |
| AssetVaultV2 | `PAUSER_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sBTC.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sETH.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sAAPL.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sTSLA.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sGOLD.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sBOND.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sNVDA.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| SyntheticAssetV2 | `sMSFT.DEFAULT_ADMIN_ROLE` | `0xe80a…eb93` |
| AssetVault | `owner()` | `0xe80a…eb93` |
| PepeAMM | `owner()` | `0xe80a…eb93` |
| PepeIncentives | `owner()` | `0xe80a…eb93` |
| PepeToken | `owner()` | `0xe80a…eb93` |
| PepeStaking | `owner()` | `0xe80a…eb93` |
| PepeClaim | `owner()` | `0xe80a…eb93` |
| EsgRewardDistributor | `owner()` | `0xe80a…eb93` |
| MockUSDT | `owner()` | `0xe80a…eb93` |

### Sepolia：讀不到的 getter

部署版沒有這個函式，或呼叫 revert。不代表安全，只代表這支腳本無法判斷。

- PerpetualExchange：`guardian()` — 呼叫失敗（部署版沒有這個函式？）
- PerpetualExchange：`marketOperator()` — 呼叫失敗（部署版沒有這個函式？）
- PerpetualExchange：`authorizedAgents(0xe80a…eb93)` — 呼叫失敗
- CopyTracker：`owner()` — 呼叫失敗（部署版沒有這個函式？）
- KYCRegistry：`verifiers(0xe80a…eb93)` — 呼叫失敗
- MockUSDC：`owner()` — 呼叫失敗（部署版沒有這個函式？）

## 鏈下元件

鏈下元件沒有 bytecode 可比對；「已部署」欄只寫有證據的狀態。

| 元件 | 已合併（PR／commit） | 已部署 | 鏈上驗證 | 展示驗收 |
|---|---|---|---|---|
| signal-api<br>x402 付費 API（Vercel） | #243／`e85cecb`（2026-10-04） | 已部署：Vercel 分支網域（agent/sdk/src/signalApi.ts 的 SIGNAL_API_TESTNET_URL）；健康與付費端點狀態由 scripts/post-deploy-smoke.mjs 檢查 | 不適用（鏈下） | 部分驗收（2026-07-15）：`docs/VERIFICATION_REPORT.md`、`docs/COST_MODEL.md`。x402 v1 付費呼叫有實際 tx；v2 從未實付；現行 payTo 被判為不安全，付費端點 fail-closed 回 503 |
| keeper<br>寫價 keeper（GitHub Actions 排程） | #242／`fea908d`（2026-10-04） | 已上線：master 上的 base-sepolia-keeper.yml 排程；最近寫價時間由 scripts/post-deploy-smoke.mjs 讀鏈上 oracle | 不適用（鏈下） | 未驗收 |
| keeper-trigger<br>keeper 觸發 Worker（Cloudflare） | #216／`281102f`（2026-10-02） | 未部署（ops/keeper-trigger/README.md「現況」，2026-10-02） | 不適用（鏈下） | 未驗收（Worker 未部署；GitHub App 路徑未在 GitHub 上實測） |
| monitoring<br>鏈上監控 Worker（Cloudflare） | #216／`281102f`（2026-10-02） | 未部署（ops/monitoring/README.md；2026-10-01 只做過唯讀試跑） | 不適用（鏈下） | 未驗收（Worker 未部署；2026-10-01 的唯讀試跑不是展示流程） |

## 判讀方式

- **鏈上＝原始碼**：鏈上 runtime code 與 master 以 `contracts/foundry.toml` 設定編譯的產物等長，遮蔽 immutable 與 library 位址後，
  CBOR metadata 之前的每個 byte 都相同（方法與 `contracts/script/VerifyTenant.s.sol` 的 `_verifyRuntimeCode` 相同）。只有 metadata 不同時另外註記——
  那是原始碼文字的雜湊，改註解也會變，不會被執行。
- **原始碼較新（待部署）**：與 master 的產物不一致。可能是鏈上跑的是舊版原始碼，也可能是舊的編譯設定；兩者的處置相同——
  要讓使用者拿到 master 的行為，就要重新部署。元件列了舊版候選（例如 AssetVaultV2 的各版實作）時，會指出鏈上是哪一版。
- **無法比對**：沒有編譯產物、鏈上沒有程式碼、proxy 沒有實作，或 RPC 失敗。不是「一致」。
- **已合併**：元件原始碼（含它在 repo 內 import 的 Solidity 檔）最後一次進 master 的 PR 與 commit（`git log --first-parent`）。
- **展示驗收**：只引用 repo 內存在的證據檔（`ops/release-status/components.json` 的 `acceptance`）；沒有證據就是「未驗收」。
- 外洩地址檢查：`owner()`、`platformTreasury()` 等 getter 的回傳值，以及 AccessControl 角色、`authorizedAgents`、`verifiers`
  對名單中每個位址的查詢。讀不到的 getter 另外列出，不算通過。
