# #129 — 主鏈硬化版金庫 ＋ 碳定價連鎖重部署

> **對象：** 持有 Base Sepolia 部署者金鑰的組員。
> **這是 [#93](https://github.com/zuemen/pepelab_onchain_cfd/issues/93) 第二次同規模的連鎖重部署** —— [#102](./DEPLOY_102_CUTOVER.md) 剛做完一次。這一份沿用同一套引導式分階段流程,不是新流程。動手前把整份讀一次,再讀一次 `DEPLOY_102_CUTOVER.md`。
>
> AI 在沒有金鑰的前提下能做的都做完了:六份部署腳本 + 這份 runbook + `frontend/src/contracts/addresses.ts` 的欄位 + keeper 設定說明。這份文件是需要真人的那一段:對著鏈跑腳本、清空舊 exchange、重接線、畫面驗收。

---

## 為什麼有這一輪

**一、主鏈根本沒有硬化版金庫。** `V2_STACK`(`frontend/src/contracts/addresses.ts`)只有 Sepolia。Base Sepolia 是 canonical 那條、#102 剛把四個合約重部署過去的那條 —— 而它的買賣路徑到今天還是 V1 `AssetVault`:無費率、無儲備率、無暫停、無逐資產上限、無破線停鑄。#93 寫給投資人的那幾條(看得到儲備率、儲備率不可信時顯示「無法確認」、儲備率被定期寫成鏈上事件、破線自動暫停鑄造、贖回永遠不受限)**全部是 V2 才有的**,在主鏈上一條都讀不到。

**二、#128 的合約改動要求連鎖重部署。** `ESGRegistryV2` 的見證紀錄多了 `tier` + `basis` 兩個欄位(ADR-006),而它是普通合約、沒有 proxy。`PerpetualExchange` 持有登記所位址 `immutable`,`CopyTracker` / `StrategyRegistry` / `AgentSessionManager` 持有 exchange 位址 `immutable` —— 一條和 #102 完全相同的連鎖。舊 exchange 讀的是 `medianCarbonIntensity`,而 #128 之後絕對基準的資產(sBTC/sETH/sGOLD/sBOND/sICLN)見證時強度寫 0,`tierOf(0) == Low` —— 舊 exchange 會把 sBTC 定價成低碳。**只有重部署才能讓 `medianCarbonTier` 的 bytecode 上鏈。**

**三、分兩次做等於把同樣的風險付兩遍。** 兩次都要重新見證 11 檔、重新餵價、重新確認位址表、重新確認 keeper。一次做完。

---

## 前置:#128 必須先合併並通過測試

| Issue | 交付 | 狀態 |
|---|---|---|
| [#128](https://github.com/zuemen/pepelab_onchain_cfd/issues/128) | `ESGRegistryV2` tier/basis + `medianCarbonTier`;`PerpetualExchange` 改讀 tier;`AssetVaultV2_4`(碳定價鑄造費);`EsgRewardDistributor` 改讀 tier;ADR-005/006 | **PR #141 —— 這一輪動手前先合併** |

若 #141 沒合併,`AssetVaultV2_4.sol` / 新版 `ESGRegistryV2.sol` 不存在,phase A / C 編不出來。

---

## 0. 開始前

### 0.1 WSL / 工具 / secrets

比照 `DEPLOY_102_CUTOVER.md` 的「WSL 環境須知」與 §0 —— 同一台機器、同一套工具(foundry 在 WSL、`jq`、Node/yarn/npm、`gh`)。

```bash
export PRIVATE_KEY=0x…                              # 合約現任 owner
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export BASESCAN_API_KEY=…                           # 選用,開 --verify
```

**合約現任 owner:`0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`**(2026-08-07 輪替後那把,單一 EOA,不在 git —— 找當初執行輪替的組員或團隊密碼管理器)。驗證:

```bash
cast wallet address --private-key "$PRIVATE_KEY"     # == 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585
cast call 0xfAEf549C687C37064cEaB5728989a839B08955cf "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

部署者金鑰是下列每一個合約現在的 `owner()` / admin:`PerpetualExchange`(0xfAEf…)、`FeeRouter`、`InsuranceVault`、`TraderStake`、`AgentSessionManager`。GuardedOracle / 硬化版金庫 / `ESGRegistryV2` / `SustainabilityBadge` 是這一輪**新部署**,建構時 admin 給部署者,結尾再視 `ADMIN_ADDRESS` 交接。

`forge script` 廣播一律加 `--slow`(Base 對 7702-delegated 帳號拒絕預派 gapped nonce)。錢包多抓一點 Base Sepolia ETH —— 這輪約 25–35 筆交易。

### 0.2 角色分離(M10)

`ADMIN_ADDRESS` / `KEEPER_ADDRESS` / `GUARDIAN_ADDRESS` **必須是三把不同的 key**,否則 GuardedOracle 的偏離上限、freeze、pause 等於零。任一沒設就退回部署者,腳本會印一整塊警告 —— 那配置只給 anvil。`RISK_ADDRESS` 不設則預設 `ADMIN_ADDRESS`。

### 0.3 凍結時窗

phase C 有一個不可逆點(`InsuranceVault.setExchange` / `FeeRouter.setExchange`)。挑一個沒人 demo、**前面還有完整兩天緩衝**的時間,不要在口試前一天下午。

### 0.4 現行 Base Sepolia 狀態(2026-09-09 讀取)

```
保留(不動):
  MockUSDC          0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
  MockOracle        0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3   (exchange 的 oracle,immutable)
  TraderStake       0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe
  InsuranceVault    0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812
  FeeRouter         0x00f6cf0113399a7A451c7f85fe094a28092d3e0c
  KYCRegistry       0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d
  AssetVault (V1)   0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5   (仍在跑,#129 部署 V2 在旁邊,不遷移)

重部署(新位址):
  ESGRegistryV2     0x285C16bf8160bD1343a9409445a4Ad4A8C5E2879   ← 舊 schema,無 medianCarbonTier
  PerpetualExchange 0xfAEf549C687C37064cEaB5728989a839B08955cf   ← 讀 medianCarbonIntensity
  StrategyRegistry  0xB92A47fb7E0AE7b87E159cCf56e98cB40f9c0539
  CopyTracker       0x8c35FA2967b3cC716940656a510b2aCa4e1b5b7D
  EsgRewardDistributor 0xceD347341eF54046352E05f5fec70DD6F5D23150
  AgentSessionManager  (讀 agent/.env 的 SESSION_MANAGER_ADDRESS,或鏈上查)

全新(Base Sepolia 上不存在):
  GuardedOracle · AssetVaultV2_4 proxy · 11 顆 SyntheticAssetV2 · SustainabilityBadge
```

**現行 exchange 上有 4 個未平倉部位**(dry-run 2026-09-09,全部 owner `0x858b36C7…`,合計約 99 USDC 保證金)。phase C 之前必須清到 0 —— 見 §清空舊 exchange。

開一個 scratch 檔擺著。過程中會產出約 8 個新位址。

---

## 1. 影響範圍

### 一落地就壞的點(phase C 第 5 步)

`InsuranceVault.setExchange` / `FeeRouter.setExchange` 重新指向新 exchange 之後,**舊** exchange 變成「虧損部位平不掉、清算不了」的場所(bailout + vault-fee 路徑 revert `NotAuthorized`)。這就是為什麼清空舊 exchange 排在最前面,而這兩個 setter 排在 phase C 最後兩個呼叫。

### session id 重置

新 `AgentSessionManager` 從 session id 0 開始。前端 `/sessions` 簽發過的每張 VC 失效。`agent/.env` 的 `DEMO_SESSION_ID` 改回 `0`。

### 已發布策略消失

新 `StrategyRegistry` 是空的,舊的已發布 `Allocation` 無法遷移 —— 見 §demo 資料。

### 存活的東西

價格(MockOracle 不動)、KYC 狀態、trader 質押、V1 金庫儲備、代幣化資產層(V1)。V1 那套整個留著當對照。

---

## 2. Phase A — 硬化版金庫

`script/DeployHardenedVault129.s.sol`。部署 GuardedOracle + `AssetVaultV2_4` proxy(直接部到 2.4.0,不走逐版升級)+ 11 顆 `SyntheticAssetV2`。**不動任何既有合約。**

價格從現行 MockOracle 複製過去,GuardedOracle 起始就同步。任一資產在 MockOracle 上讀不到價 → 腳本 revert(除非 `SKIP_UNPRICED_ASSETS=true`)。

```bash
cd contracts

# dry-run(不加 --broadcast):讀 11 檔價、印角色分離狀態、印估算 gas
MOCKUSDC_ADDR=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035 \
MOCKORACLE_ADDR=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
ADMIN_ADDRESS=0x…  KEEPER_ADDRESS=0x…  GUARDIAN_ADDRESS=0x… \
forge script script/DeployHardenedVault129.s.sol:DeployHardenedVault129 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv

# 正式:加 --broadcast --slow --private-key
… --broadcast --slow --private-key "$PRIVATE_KEY" \
  ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"}
```

從 console 抄:

```
export GUARDED_ORACLE_129=0x…
export VAULT_PROXY_129=0x…
# 11 顆 token 位址(sBTC … sESGU)
```

**phase A 自我驗證**(腳本結尾已印,再手動確認):

```bash
cast call $VAULT_PROXY_129 "version()(string)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # 2.4.0
cast call $VAULT_PROXY_129 "oracle()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == GUARDED_ORACLE_129
cast call $VAULT_PROXY_129 "esgRegistry()(address)"       --rpc-url $BASE_SEPOLIA_RPC_URL   # 0x0(phase E 才接)
cast call $VAULT_PROXY_129 "mintFeeBpsForAsset(bytes32)(uint256)" $(cast keccak sMSFT) --rpc-url $BASE_SEPOLIA_RPC_URL  # 100(fail-closed,還沒接登記所)
cast call $GUARDED_ORACLE_129 "getPrice(bytes32)(uint256,uint256)" $(cast keccak sBTC) --rpc-url $BASE_SEPOLIA_RPC_URL  # 非零
```

> `esgRegistry` 未接時 `mintFeeBpsForAsset` 對每一檔都回 100(最保守級)—— 這是刻意的 fail-closed,phase E 接上登記所後才變成逐資產。**在 phase E 之前不要開放鑄造 / 設 cap。**

---

## 3. Phase B — 見證登記所 ＋ 見證 11 檔

`script/Deploy102CarbonRegistry.s.sol`(#128 已更新成帶 tier/basis)。部署 `ESGRegistryV2` + `SustainabilityBadge`,授 `ATTESTOR_ROLE`,對 11 檔各寫一筆見證(帶 `tier` + `basis`)。

見證資料在腳本的 `_assets()` 表裡,對齊 `docs/data/carbon-intensity.md` 與 `frontend/src/lib/pepefi/assetMeta.ts`:

- **營收基準**(sAAPL/sTSLA/sNVDA/sMSFT/sGOOGL/sESGU):照舊寫強度,`tier` 必須等於 `tierOf(強度)` —— 新登記所提交時檢查,不一致直接 revert。
- **絕對 / 質性基準**(sBTC/sETH/sGOLD/sBOND/sICLN):`basis` 標 `Absolute` 或 `Qualitative`,強度寫 0,**不再反推假數字**,`tier` 直接指定。

每一筆見證照舊帶 `sourceHash = keccak256(來源網址 + 擷取日期)`(腳本 `_assets()` 的 `abi.encodePacked(symbol, "|2026-09-02|docs/data/carbon-intensity.md")`)—— 使用者自己去查證那個數字的地方(#129 story 10)。`attest` 對 `sourceHash == 0` 直接 revert;`Verify129`(phase F)會逐檔讀回確認非零。

```bash
forge script script/Deploy102CarbonRegistry.s.sol:Deploy102CarbonRegistry \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv \
  ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"}
```

從 console 抄:

```
export ESG_REGISTRY_V2=0x…
export SUSTAINABILITY_BADGE=0x…
```

### 多見證者(選用,demo 用)

「三家機構給不同分數」要是真的鏈上狀態:設 `ATTESTOR_2` / `ATTESTOR_3` 為兩把額外 EOA,**各自用自己的 key 再跑一次這支腳本**(第一次跑時部署者已授它們 `ATTESTOR_ROLE`)。

> **誠實揭露(#93):** 那些 attestor 金鑰全是團隊持有。從不同地址見證讓歧見在鏈上是真的,但那是安排,不是機構獨立性 —— 畫面與文件都要這樣寫。

**phase B 自我驗證**(腳本結尾已印 sBTC=High / sNVDA=Low):

```bash
for s in sMSFT sNVDA sGOLD sBTC sESGU sBOND; do
  cast call $ESG_REGISTRY_V2 "medianCarbonTier(bytes32)(uint8,uint256,uint256,bool)" $(cast keccak "$s") --rpc-url $BASE_SEPOLIA_RPC_URL
done
# 預期 tier(第一個回傳值):sMSFT=3(High) · sNVDA=1(Low) · sGOLD=3 · sBTC=3 · sESGU=2(Mid) · sBOND=1
# 每一筆第四個回傳值(isRated)都要 true
```

---

## 4. 清空舊 exchange(在 phase C 之前)

dry-run 顯示現行 exchange 有 4 個未平倉部位。

1. **公告**凍結給每個有測試錢包的人。
2. 重跑 `DRY_RUN=true … Redeploy129Exchange`,讀未平倉數與 owner。
3. 讓每個 owner **平倉**(或清算),直到 dry-run 回報 **0**。
4. 讓每個 owner 從舊 exchange **提出可用保證金**:
   ```bash
   cast send 0xfAEf549C687C37064cEaB5728989a839B08955cf "withdrawMargin(uint256)" <amount> \
     --private-key <owner_key> --rpc-url "$BASE_SEPOLIA_RPC_URL"
   ```
5. 到這裡才跑 phase C 的 `--broadcast`。

若**必須**帶著未平倉往下走:phase C 的腳本會把這記成一個刻意的選擇並繼續 —— 那些部位失去保險金庫後盾。盡量別。

---

## 5. Phase C — 碳定價連鎖重部署

`script/Redeploy129Exchange.s.sol`。部署新 `PerpetualExchange`(讀 `medianCarbonTier`)+ 新 `StrategyRegistry` + 新 `CopyTracker` + 新 `AgentSessionManager`,重接 `TraderStake` / `FeeRouter` / `InsuranceVault`,撤舊 `AgentSessionManager`。

**腳本開頭有一道 schema + seed 閘:** 若 `ESG_REGISTRY_V2` 是舊登記所(無 `medianCarbonTier`)或未 seed,在**任何交易送出之前** revert 並說明。

```bash
# dry-run first, ALWAYS:
ESG_REGISTRY_V2=$ESG_REGISTRY_V2 DRY_RUN=true \
forge script script/Redeploy129Exchange.s.sol:Redeploy129Exchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
# 只在 dry-run 回報 0 未平倉時往下:
ESG_REGISTRY_V2=$ESG_REGISTRY_V2 \
forge script script/Redeploy129Exchange.s.sol:Redeploy129Exchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv \
  ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"}
```

從 console 抄:

```
export EXCHANGE_NEW=0x…
export STRATEGY_REGISTRY_NEW=0x…
export COPYTRACKER_NEW=0x…
export SESSION_MANAGER_NEW=0x…
# demo sessionId = 0
```

腳本結尾已把每一條接線讀回來 `require`,並印新 exchange 的逐資產費率/槓桿(sMSFT 1x/100、sNVDA 5x/10)。

> broadcast JSON 在 `contracts/broadcast/Redeploy129Exchange.s.sol/84532/run-latest.json` —— 中途 revert 時用 `jq` 撈已落地的位址。**不要重跑整個腳本**(會得到第二個 exchange),用 `cast send` 手動補剩下的 `onlyOwner` setter。

---

## 6. Phase D — 獎勵發放

`script/Deploy102RewardDistributor.s.sol`(env-var 驅動,#128 之後它讀 `medianCarbonTier`)。它的 `exchange` 是 immutable,所以只能在 phase C 之後部署。

```bash
EXCHANGE_NEW=$EXCHANGE_NEW ESG_REGISTRY_V2=$ESG_REGISTRY_V2 SUSTAINABILITY_BADGE=$SUSTAINABILITY_BADGE \
forge script script/Deploy102RewardDistributor.s.sol:Deploy102RewardDistributor \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv
```

```
export REWARD_DISTRIBUTOR_NEW=0x…
```

腳本已 `require` badge 的 `MINTER_ROLE` 授給了 distributor。

---

## 7. Phase E — 接金庫到登記所

`script/Wire129.s.sol`。`vault.setEsgRegistry(ESG_REGISTRY_V2)` + 讀回驗證鑄造費率變成逐資產。冪等。

```bash
VAULT_PROXY_129=$VAULT_PROXY_129 ESG_REGISTRY_V2=$ESG_REGISTRY_V2 \
forge script script/Wire129.s.sol:Wire129 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv
```

腳本 `require`:`mintFeeBpsForAsset(sMSFT) == High 費率`、`sNVDA == Low 費率`、`sMSFT > sNVDA`。

### 開放鑄造

登記所接上後才做:

```bash
# 每檔設 cap(單位:token,18 位小數)。金額跟風險組員確認。
cast send $VAULT_PROXY_129 "setAssetCap(bytes32,uint256)" $(cast keccak sNVDA) <cap> --private-key <RISK_KEY> --rpc-url $BASE_SEPOLIA_RPC_URL
# … 11 檔
# 注資(RISK/ADMIN 依合約),先 approve USDC
cast send $VAULT_PROXY_129 "fundVault(uint256)" <usdc_amount> --private-key "$PRIVATE_KEY" --rpc-url $BASE_SEPOLIA_RPC_URL
```

---

## 8. Phase F — 逐項驗證

`script/Verify129.s.sol` —— 唯讀,把整張相依圖跑一遍,第一個不符就 revert 並印欄位名。

```bash
GUARDED_ORACLE_129=$GUARDED_ORACLE_129 VAULT_PROXY_129=$VAULT_PROXY_129 \
ESG_REGISTRY_V2=$ESG_REGISTRY_V2 SUSTAINABILITY_BADGE=$SUSTAINABILITY_BADGE \
EXCHANGE_NEW=$EXCHANGE_NEW COPYTRACKER_NEW=$COPYTRACKER_NEW \
STRATEGY_REGISTRY_NEW=$STRATEGY_REGISTRY_NEW SESSION_MANAGER_NEW=$SESSION_MANAGER_NEW \
REWARD_DISTRIBUTOR_NEW=$REWARD_DISTRIBUTOR_NEW \
forge script script/Verify129.s.sol:Verify129 --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
```

它檢查:金庫 version/oracle/esgRegistry/逐資產費率;GuardedOracle 11 檔有價;登記所 11 檔 isRated + sMSFT=High/sNVDA=Low;exchange 的 esgRegistry/copyTracker/agent 授權/碳參數;CopyTracker 上游;FeeRouter/InsuranceVault/TraderStake 指向新 exchange/copyTracker;EsgRewardDistributor 的 exchange/registry/badge + badge MINTER_ROLE。

---

## 9. 重接線清單(合約以外)

| # | 目標 | 動作 |
|---|---|---|
| 1 | `frontend/src/contracts/addresses.ts` | **`V2_STACK[84532]`**:填 `GuardedOracle` / `AssetVaultV2`(= `VAULT_PROXY_129`)/ `ESGRegistryV2` / `SustainabilityBadge` / 11 顆 `tokens`。**`BASE_SEPOLIA` `ChainAddresses`**:換 `PerpetualExchange` / `StrategyRegistry` / `CopyTracker` / `ESGRegistry`(→ V2)/ `EsgRewardDistributor`。**一次 commit 全部改完,在 phase F `Verify129` 通過之後** —— 只有 `V2_STACK` 有 `hasV2Stack` 的 0x0 退回閘,`ChainAddresses` 的 exchange 欄位沒有,分批改會留下「金庫已切、exchange 還舊」的裂腦時窗。 |
| 2 | `frontend/src/contracts/abi/*.json` | 從 `contracts/out/` 重新複製 `PerpetualExchange.json`、`CopyTracker.json`、`StrategyRegistry.json`、`AgentSessionManager.json`、`AssetVaultV2.json`(V2.4 有新函式 `mintFeeBpsForAsset` / `setEsgRegistry` / 事件)、`ESGRegistryV2.json`(`medianCarbonTier` / 新 `attest` 簽章 / `Attested` 事件)、`GuardedOracle.json`、`SustainabilityBadge.json`、`EsgRewardDistributor.json`。 |
| 3 | `agent/.env` | `SESSION_MANAGER_ADDRESS` → `SESSION_MANAGER_NEW`;`DEMO_SESSION_ID` → `0`;`PERP_ADDRESS`(資訊)→ `EXCHANGE_NEW`;`KEEPER_GUARDED_ORACLE` → `GUARDED_ORACLE_129`;`KEEPER_VAULT_ADDRESS` → `VAULT_PROXY_129`(讓 keeper 每輪呼叫 `observeReserve()`,把儲備率釘進 `ReserveObserved` 事件,#99)。keeper 的合約位址主要從 `addresses.ts` 讀(項目 1)。 |
| 4 | `agent/mcp-server` | 讀 `addresses.ts`。重啟。驗 `open_position` / `close_position` / `get_session` 解析到新 exchange + 新 session manager。 |
| 5 | 撤舊 `AgentSessionManager` `0x5Ebcc64C…` | phase C 已在舊 exchange 上 `setAgentAuthorized(…, false)`,且新 exchange 天生不授權它。`Verify129` 兩邊都確認。 |
| 6 | `MockSwapRouter` 注資 | 沿用現況;若餘額低 `cast send $MockSwapRouter "fundRouter()" --value <ETH>`。 |

---

## 10. 前端 ＋ agent 重新建置

WSL 裡:

```bash
cd frontend
yarn install
yarn tsc --noEmit          # 必須乾淨
yarn vitest run            # 必須全綠
# 部署這版 build

cd ../agent
npm install
npm run typecheck
npm run test
npm run bundle:vercel      # 若動過 agent/signal-api/src/*.ts
# 重啟 signal-api / keeper / mcp-server
```

keeper 第一次對新 exchange + 新 GuardedOracle 跑,會為 11 檔寫新價。盯 log 看 `sBOND` 有沒有 `DeviationTooLarge`(seed 價 ≈ $48,BGRN 真實水位)。

---

## 11. 畫面驗收(這就是「部署完成」的定義)

**不是**「交易送出去沒 revert」,而是下面六條在主鏈上、從畫面上都成立。連一個 Base Sepolia 真錢包逐條走:

1. **資產頁讀得到儲備率**,而且在預言機失效時顯示「無法確認」而不是一個數字。(把某資產的 GuardedOracle 價 warp 過期,或用 GUARDIAN freeze,看 `ratioIsStale`。)
2. **11 檔各自顯示得出被見證的分級與筆數。**(`medianCarbonTier` 的 tier + count。)
3. **低碳與高碳的買入費率確實不同**,且差距與逐級參數一致。sNVDA 買入 0.10%、sMSFT 買入 1.00%(`mintFeeBpsForAsset`)。
4. **嘗試調整單一資產的買入費率會失敗。** 用 owner 帳號:V2.4 沒有 `mintFeeBps` setter、`setRiskParams` 沒有 mint-fee 參數。最接近的呼叫不存在 / revert。先排練打哪個呼叫。
5. **嘗試為特定使用者豁免碳費率會失敗。** exchange 沒有任何 per-user 費率豁免路徑(`CarbonPricing.t.sol` 釘住的缺席)。排練。
6. **完整的 Expert Mode 11 頁仍可用。** `TradeTerminalPage` · `WhaleTrackerPage` · `TraderDashboard` · `TraderStakePage` · `RewardsPage` · `VaultPage` · `AgentMonitorPage` · `X402DocsPage` · `AdminKYCPage` · `AdminOraclePage` · `AdminTreasuryPage`。盯:空白面板(ABI 過期)、錯誤網路、admin 頁讀不到 owner-only 狀態、agent monitor 無 session(預期 —— 建一個新 demo session)。

### demo 資料 — 重新發布至少 3 份 Allocation

新 `StrategyRegistry` 是空的。比照 `DEPLOY_102_CUTOVER.md` §8:每份 ≥ 3 資產、每個權重 ≤ 5000 bps、加總 = 10000、每 leg 槓桿 ∈ {1,2,5} 且在該資產碳分級上限內(高碳封 1x;demo 全 1x)。用 `SeedMarket.s.sol` 或逐份 `cast send $STRATEGY_REGISTRY_NEW "publishStrategy(...)"`。發布者先 `registerTrader(...)`。

---

## 12. 中途失敗怎麼辦

| 卡在 | 復原 |
|---|---|
| phase C 的 schema 閘 revert | 不是失敗 —— `ESG_REGISTRY_V2` 指錯(舊登記所)或 phase B 沒 seed。修 env / 補跑 phase B。什麼都沒送出。 |
| phase A/C broadcast 跑到一半 revert | `forge script` 非跨交易原子。讀 `run-latest.json` 看哪些落地。用 `cast send` 手動補 `onlyOwner` setter。**不要重跑整個腳本。** |
| phase C 第 5 步落地了但後面壞了 | 舊場所已降級。往前推,用 `cast send` 修剩下的接線,別倒回去。 |
| 前端 build 紅 | 通常是 ABI 沒複製。`contracts/out/<Name>.sol/<Name>.json` → `frontend/src/contracts/abi/`。 |
| keeper 拒 `sBOND` 價 | seed 價離 BGRN 真實太遠。`cast send $GUARDED_ORACLE_129 "updatePrice(bytes32,uint256)" $(cast keccak sBOND) <price_8dec>`(需 KEEPER key)分段逼近;MockOracle 同理。 |
| 金庫 `mintFeeBpsForAsset` 每檔都回 100 | phase E 沒跑,或 `ESG_REGISTRY_V2` 沒 seed。跑 `Wire129`。 |

phase C 第 5 步之後**沒有乾淨的 rollback**。這就是為什麼有清空步驟與 dry-run 閘。

---

## 13. 簽核清單

- [ ] #141(#128)已合併;`forge test` 全綠
- [ ] phase A:GuardedOracle + `AssetVaultV2_4` proxy(version 2.4.0)+ 11 token;角色分離確認
- [ ] phase B:`ESGRegistryV2` 已部署 + seed;11 檔 `medianCarbonTier` isRated;sMSFT=High / sNVDA=Low;(選用)多見證者各跑一次
- [ ] `SustainabilityBadge` 已部署
- [ ] 舊 exchange 清到 0 未平倉;可用保證金已提出
- [ ] phase C:新 exchange 鏈已 broadcast;schema 閘通過;5 個新位址已抄;結尾 `require` 全過
- [ ] phase D:`EsgRewardDistributor` 已部署(exchange 之後);badge MINTER_ROLE 已授
- [ ] phase E:`Wire129` 已跑;金庫 `esgRegistry` 已接;逐資產鑄造費率驗證;cap + `fundVault` 已設
- [ ] phase F:`Verify129` 全綠
- [ ] `addresses.ts` `V2_STACK[84532]` + `BASE_SEPOLIA` 已更新;ABI 已複製
- [ ] 前端 `yarn tsc` + `yarn vitest` 全綠;站台已重部署
- [ ] agent `npm run typecheck` + `npm run test` 全綠;keeper / signal-api / mcp-server 已重啟;`agent/.env` 已更新
- [ ] keeper 為 11 檔寫了新價(MockOracle + GuardedOracle),無 `DeviationTooLarge`
- [ ] keeper 至少跑過一輪 `observeReserve()`(`KEEPER_VAULT_ADDRESS` 已設),新金庫的 `ReserveObserved` 事件已上鏈(#93 story 4「儲備率被定期寫成鏈上事件」)
- [ ] 舊 `0x5Ebcc64C…` 在舊 exchange 上 `authorizedAgents == false`
- [ ] ≥ 3 份 demo Allocation 已發布
- [ ] §11 六條畫面驗收逐條走過(含費率豁免 revert 的排練)
- [ ] #129 已更新新位址 + 發布帳號
- [ ] 部署完成後:前端舊版金庫程式碼分支可刪(純刪除,無畫面變化 —— 見前端 spec;不需獨立驗收)

---

## 14. 與 Sepolia 的關係(#129 user story 17）

Sepolia 上既有那一套**維持不動**,不遷移、不清理 —— 它是對照展示。主鏈補齊後兩條鏈第一次功能對齊,**但仍不是彼此的鏡像**(各自的合約位址、各自的歷史)。前端既有的「使用者站在哪一條鏈」提示維持不動。

Sepolia 上 V1 舊代幣的餘額不遷移(測試網對照,不是產品路徑 —— 前端 spec 已明確接受)。
