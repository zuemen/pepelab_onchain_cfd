# #102 —— 四合約連鎖重部署與全系統重接線

> **對象：** 持有 Base Sepolia 部署者金鑰的組員。
> **這是 [#93](https://github.com/zuemen/pepelab_onchain_cfd/issues/93) 全案風險最高的單一項目。** 任何一項漏掉，症狀都是「demo 當天某個功能靜默失效」。動手前先把整份 runbook 讀一次。
>
> AI 在沒有金鑰的前提下能做的都做完了（見下方子 issue）。這份文件是需要真人的那一段：部署合約、撤銷一個鏈上授權、發布 demo 策略、端到端驗證。

---

## WSL 環境須知

- foundry 裝在 WSL，repo 在 Windows 側：WSL 裡的路徑是 `/mnt/c/Users/maxli/projects/pepelab_onchain_cfd`。所有 `cd contracts` 之類都在這個路徑底下。
- **建議把 repo clone 進 WSL 的原生檔案系統**（例如 `~/pepelab_onchain_cfd`）再操作 —— `/mnt/c` 的檔案 I/O 慢，`forge build` / `forge test` 會明顯拖，而且 git line-ending 在跨 `/mnt/c` 時容易出怪事。若堅持用 `/mnt/c`，先 `git config core.autocrlf input`。
- `PRIVATE_KEY` 之類的 `export` 只在**當前 WSL shell** 有效。開新視窗要重設，或寫進 `contracts/.env`（已 gitignore）。
- 瀏覽器（看 BaseScan、開 PR）用 Windows 的；WSL 裡 `explorer.exe .` 可以從當前目錄開 Windows 檔案總管。

---

## 0. 開始前

### 0.1 必須先合併的子 issue

| Issue | 交付什麼 | 狀態 |
|---|---|---|
| #96 | `PerpetualExchange` 碳分級定價（逐資產費率 + 槓桿上限由 `CarbonTiers` 推導） | 已合併 |
| #97 | `CopyTracker` 逐 `Allocation` 費用緩衝 + `StrategyRegistry` 多元化約束 | 已合併 |
| #98 | `SustainabilityBadge` + 碳分級 `EsgRewardDistributor` | 已合併 |
| #106 | `sBOND` 追蹤 BGRN（綠色債券 ETF）而非美國公債 | **PR #117 —— 部署前先合併** |

若 #117 沒合併，`agent/keeper/feeds.ts` / `symbols.ts` / `assetMeta.ts` 的 `sBOND` 還指向 TLT，步驟 3 會註冊錯的標的。

### 0.2 工具

- **Foundry**（在 WSL）—— `foundryup` 後確認 `forge --version` 與 `cast --version`。
- **`jq`** —— seed 腳本要解析 `broadcast/*.json`。（`sudo apt install jq`）
- **Node 20+ / yarn / npm** —— 前端與 agent 重新建置用。
- **`gh` CLI**，已登入，若想從命令列開後續 PR。

### 0.3 Secrets（只放環境變數 —— 絕不 commit）

```bash
export PRIVATE_KEY=0x…                 # 合約現任 owner 的金鑰（見下）
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # 或 Alchemy / Infura 的 Base Sepolia 端點
export BASESCAN_API_KEY=…              # 選用，開啟 --verify（不要照抄 "…"，沒 key 就整行刪掉）
```

**金鑰在哪：** 舊的洩漏金鑰（`0xE80A8136…`）**已於 2026-08-07 輪替掉**（見 `docs/KEY_ROTATION_20260807.md`）—— 那把已被 sweeper bot 接管、現在什麼都不擁有。

- **合約現任 owner：`0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`**
- 它的私鑰**不在 git 裡**（輪替的重點就是換一把沒 commit 的）。當初 `rotate-key.sh` 把它寫進 `contracts/.env.rotation`（mode 600、gitignored），計畫是移進團隊密碼管理器後刪掉該檔。
- **要這把 key：找 2026-08-07 執行輪替的組員，或團隊密碼管理器。**
- ⚠️ `contracts/.env.example` 裡的 `PRIVATE_KEY`（`0xac09…`）是 **Anvil 本機測試假金鑰**（地址 `0xf39Fd6…`），它不擁有任何 Base Sepolia 合約 —— 不要用。

驗證你手上這把對不對：

```bash
cast wallet address --private-key "$PRIVATE_KEY"
# 應該印出 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585
cast call 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
# 鏈上 owner，兩個要一致
```

> 這把新金鑰是單一 EOA、不是 multisig（`KNOWN_LIMITATIONS.md` #13 記的限制）。#102 之後整套 stack 的 owner 仍是這把 EOA —— 可接受，但論文/口試提一句。

部署者金鑰**必須是**下列每個合約現在的 `owner()`：`PerpetualExchange`、`FeeRouter`、`InsuranceVault`、`StrategyRegistry`、`AgentSessionManager`、`EsgRewardDistributor`、`PepeIncentives`、`TraderStake` —— 下面每個 `onlyOwner` 呼叫都以它的身分執行。

> `MockOracle` 的 owner 是**另一把 keeper 金鑰**（輪替時刻意沒動）。§10 那個「用 `cast send $ORACLE setPrice` 拉近 sBOND 價」要用 keeper 金鑰，不是這把部署者金鑰。

forge 廣播記得加 `--slow`（wizard 已內建）：Base 對 7702-delegated 帳號會拒絕 forge 預派的 gapped nonce，`--slow` 讓每筆等 receipt、nonce 嚴格遞增。

部署者錢包要有 **Base Sepolia ETH** 付 gas —— 抓多一點，這輪大約 15–20 筆部署/setter 交易。水龍頭：<https://docs.base.org/chain/network-faucets>。

### 0.4 凍結時窗

切換有一個不可逆點（步驟 4.5 / 步驟 7）。挑一個沒有人在 demo、而且**前面還有完整兩天緩衝**的時間做，不要在口試前一天下午。

---

## 1. 影響範圍 —— 誰動、誰不動、誰會壞

`PerpetualExchange` 沒有 proxy，`usdc` / `oracle` 是 `immutable`，所以碳定價改寫（#96）只能透過**重部署**上鏈。這會連鎖：

### 重部署（新位址）

| 合約 | 為什麼不能留 |
|---|---|
| `PerpetualExchange` | 碳定價在 bytecode 裡；`immutable` 的 oracle/usdc |
| `CopyTracker` | `exchange`、`registry`、`traderStake`、`feeRouter` 全是 `immutable` |
| `AgentSessionManager` | `exchange` 是 `immutable` → **session id 從 0 重新開始**，前端 `/sessions` 簽發過的每張 VC 都失效 |
| `StrategyRegistry` | #97 的約束；而且它一旦重部署，**所有已發布的 Allocation 都沒了**（見 §8） |

> `EsgRewardDistributor` 與 `PepeIncentives` 也把 exchange 位址存成 `immutable`。跟組員確認它們是否也要重部署，還是它們的 exchange 繫結不重要到可以留。若重部署，`EsgRewardDistributor` 的發放物還要從 PEPE 換成 `SustainabilityBadge`（#98）—— 確認你部署的版本已經是這樣。

### 保留（沿用）

`MockUSDC`、`MockUSDT`、`MockOracle`（V1）/ `GuardedOracle`（V2）、`KYCRegistry`、`InsuranceVault`、`FeeRouter`、`TraderStake`、`AssetVault` / `AssetVaultV2_3`、`PepeToken`、`PepeAMM`、`MockSwapRouter`。

`ESGRegistryV2`、`SustainabilityBadge`、V2 版 `EsgRewardDistributor` 在這輪切換裡是**新部署** —— 見 §2.5。

價格、KYC 狀態、trader 質押、金庫儲備、以及代幣化資產層都因為合約不動而存活。

### 步驟 4.5 一落地就壞

把 `InsuranceVault.setExchange` / `FeeRouter.setExchange` 重新指向新 exchange 之後，**舊** exchange 變成一個「虧損部位再也平不掉、清算不了」的場所（bailout + vault-fee 路徑會 revert `NotAuthorized`）。這就是為什麼把舊 exchange 清到**零未平倉**（§4）要排在前面。

### 現行 Base Sepolia 位址（84532）—— 「之前」的快照

來自 `frontend/src/contracts/addresses.ts`（`BASE_SEPOLIA` 區塊）：

```
MockUSDC          0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
MockUSDT          0x5c8A1e970D275Cc269e09A949D68693120416d78
MockOracle        0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3
TraderStake       0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe
InsuranceVault    0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812
FeeRouter         0x00f6cf0113399a7A451c7f85fe094a28092d3e0c
PerpetualExchange 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072   ← 重部署
StrategyRegistry  0x54e8C43f9Eb151Bb8DD6e61d16a969C4D0e73915   ← 重部署（見 §8）
CopyTracker       0x96357144fE56c5E0e33e8046bE2A63F45528b210   ← 重部署
MockSwapRouter    0xC9b0e5C219AA1B3eB00E92Fd9a883B182F0AE8Ae
ESGRegistry       0x73310bfb9f93711e9405EB717e3426246BD58618   ← V1；V2 位址待定（§2.5）
KYCRegistry       0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d
AssetVault        0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5

AgentSessionManager（現行）  0x4E7cC1B79B72ab72531a6C790e14304370f70764   ← 重部署
AgentSessionManager（舊/廢） 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8   ← 絕不能授權在新 exchange 上（§7）
```

開一個 scratch 檔擺著 —— 過程中你會把約 5 個新位址貼進去。

---

## 2. 準備部署腳本（在分支上做，找人 review）

現有的重部署腳本早於碳定價。**照原樣跑不會產出正確的 exchange。**

### 2.1 `contracts/script/RedeployExchange.s.sol`

它目前：
- 建構子第三個參數傳 `address(0)`（`_esgRegistry`）—— 碳定價 exchange 從 `ESGRegistryV2` 讀碳強度中位數，所以這裡必須是**真的 V2 位址**；
- 只註冊 `sBTC / sETH / sAAPL / sTSLA`、只把 `sAAPL / sTSLA` 標 KYC —— #102 需要**全部 11 個資產**都註冊、以及完整的 KYC 集合（`sAAPL sTSLA sNVDA sMSFT sGOOGL sICLN sESGU sBOND`，即 `frontend/src/lib/pepefi/assetMeta.ts` 裡每個 `regulated: true` 的資產）；
- 有一個 `require(FUNDING_INTERVAL() == 300)` 的守衛，綁在舊的資金費 bug 故事上 —— 依你是否從已修好的 exchange 重部署，決定保留或拿掉。

改成：
1. `new PerpetualExchange(USDC, ORACLE, ESG_REGISTRY_V2)`
2. 迴圈註冊全部 11 個 `keccak256(symbol)` asset id（exchange 上沒有逐資產碳設定 —— 它在開倉時從 `CarbonTiers` + 註冊表中位數推導費率/槓桿，所以註冊只是「這個資產存在」）
3. 對 8 個 KYC 資產各呼叫 `setRwaAsset(id, true)`
4. 保留 `MAX_PRICE_AGE = 21_600`、`EXECUTION_FEE = 1e14`、`ADL_ENABLED = true`、`setKycRegistry`、`setFeeRouter`、`setInsuranceVault` 這幾個呼叫
5. 部署 `CopyTracker` + `StrategyRegistry`（新）並接線 `exchange.setCopyTracker`、`traderStake.setCopyTracker`、`feeRouter.setCopyTracker`（腳本已經有 CopyTracker 那三個 —— 加上新 registry 的部署）
6. 部署 `AgentSessionManager(newExchange)` 並 `exchange.setAgentAuthorized(newSessionManager, true)` —— **`authorizedAgents` 裡不放其他任何東西**（舊的 `0x5Ebcc64C…` 就是永遠不加）
7. `InsuranceVault.setExchange` / `FeeRouter.setExchange` 留在**最後兩個**呼叫（對舊場所不可逆）
8. 回傳前用 `require(...)` 把每一條接線讀回來，`console.log` 所有新位址

`RedeployCopyTracker.s.sol` 是 env-var + 讀回驗證風格的好參考。

### 2.2 Dry-run

```bash
cd contracts
DRY_RUN=true forge script script/RedeployExchange.s.sol:RedeployExchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
```

腳本會盤點**舊** exchange 並印出未平倉數。**只要非零就不要往下走**（§4）。

### 2.3 `contracts/script/SeedESG.s.sol`

`sBOND` 的分數還寫著「US Treasuries」。#106（PR #117）會改成綠色債券的樣貌 —— 確認你部署的分支有這個。若你用 `ESGRegistryV2`（多筆見證），`SeedESG` 打的是 V1 的 `setESG` API，需要 V2 版 —— 見 §2.5。

### 2.5 `ESGRegistryV2` / `SustainabilityBadge` / `EsgRewardDistributor` —— 部署腳本還不存在

合約已合併（`contracts/src/ESGRegistryV2.sol`、`SustainabilityBadge.sol`、`EsgRewardDistributor.sol`、`CarbonTiers.sol`），**有測試但沒有部署腳本** —— `contracts/script/` 還是只有 V1 的 `DeployESG.s.sol` / `SeedESG.s.sol`。§2 的腳本工作之一就是寫：

| 新腳本 | 部署 | 建構子 | 順序 |
|---|---|---|---|
| `DeployESGRegistryV2.s.sol` | `ESGRegistryV2` | `(address admin)` | **在 exchange 之前**（exchange 建構子第三參數） |
| `SeedESGV2.s.sol` | —（見證） | — | registry 之後、exchange 之前 |
| `DeploySustainabilityBadge.s.sol` | `SustainabilityBadge` | `(address admin)` | `EsgRewardDistributor` 之前任何時候 |
| `DeployEsgRewardDistributorV2.s.sol` | `EsgRewardDistributor` | `(address _exchange, address _esgRegistry, address _badge)` | **在 exchange 之後** —— 它綁新 exchange |

**`ESGRegistryV2` 的 seeding 不是 `setESG`。** V2 流程：

1. `registry.grantRole(ATTESTOR_ROLE, <attestor EOA>)` —— admin 必須**明確地、對具名地址**授予；建構時不會自動授。demo 的「三家機構意見不同」就是授給 2–3 個 EOA。
2. 每個 attestor 對全部 11 個資產呼叫 `registry.attest(assetId, carbonIntensity, e, s, g, sourceHash)`。`carbonIntensity` 與 source hash 來自 `docs/data/carbon-intensity.md`；`sourceHash = keccak256(來源網址 + 擷取日期)`。
3. 需要的話 `registry.setMaxAttestationAge(<秒>)` —— 跟 `frontend/src/lib/pepefi/carbon.ts` 的 `MAX_ATTESTATION_AGE_DAYS`（365）保持一致。

> **論文誠實聲明（來自 #93）：** demo 中「獨立」的 attestor 金鑰全由團隊持有。從不同地址 `attest` 讓「三家機構給 82 / 61 / 79」在鏈上是真實狀態，但那是安排，不是機構獨立性。主動說明比被問出來好。

在部署 exchange **之前**先 seed —— 對著未 seed 的註冊表開的 exchange 會把每個資產都當成最保守級（`Unrated`：1x、最高費率），這是 fail-closed 但不是 demo 要展示的樣子。

`CarbonRetirement` / `MockCarbonCredit`（#93 第 4 週的可犧牲項）不在這輪範圍。

---

## 3. 部署連鎖

§2 review + merge 完，且 §2.2 dry-run 回報**0 未平倉**之後：

```bash
cd contracts
forge script script/RedeployExchange.s.sol:RedeployExchange \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"} \
  -vvv
```

從 console 輸出抄進 scratch 檔：

```
PerpetualExchange_NEW    = 0x…
CopyTracker_NEW          = 0x…
StrategyRegistry_NEW     = 0x…
AgentSessionManager_NEW  = 0x…
demo sessionId           = 0
```

broadcast JSON 在 `contracts/broadcast/RedeployExchange.s.sol/84532/run-latest.json` —— 之後要撈某個位址就 `jq` 它。

**往下走之前的健檢：**

```bash
cast call $PerpetualExchange_NEW "FUNDING_INTERVAL()(uint256)"      --rpc-url $BASE_SEPOLIA_RPC_URL   # 28800（8h）
cast call $PerpetualExchange_NEW "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $FEE_ROUTER            "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $TRADER_STK            "copyTracker()(address)"            --rpc-url $BASE_SEPOLIA_RPC_URL   # == CopyTracker_NEW
cast call $INS_VAULT             "exchange()(address)"               --rpc-url $BASE_SEPOLIA_RPC_URL   # == PerpetualExchange_NEW
cast call $PerpetualExchange_NEW "authorizedAgents(address)(bool)" $AgentSessionManager_NEW --rpc-url $BASE_SEPOLIA_RPC_URL  # true
# 高碳資產被封在 1x 且吃最高費率；低碳資產 5x / 低費率：
cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"    $(cast keccak "sMSFT") --rpc-url $BASE_SEPOLIA_RPC_URL   # 1
cast call $PerpetualExchange_NEW "tradingFeeBpsForAsset(bytes32)(uint256)"  $(cast keccak "sMSFT") --rpc-url $BASE_SEPOLIA_RPC_URL   # 100
cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"    $(cast keccak "sNVDA") --rpc-url $BASE_SEPOLIA_RPC_URL   # 5
```

---

## 4. 清空舊 exchange（若 dry-run 顯示有未平倉，這一步要在步驟 3 之前做）

1. **公告**凍結給每個有測試錢包的人。
2. **停掉舊 exchange 上的新開倉** —— 前端在 Simple Mode 已經把交易介面藏起來；Expert Mode 要嘛部署一版指向新位址的前端（§6），要嘛接受在時窗內開倉照常。時窗內在舊 exchange 上的新開倉只是變成更多要清的部位。
3. 重跑 `DRY_RUN=true forge script … RedeployExchange`，讀未平倉數與 owner。
4. 讓每個 owner **平倉**（或清算能清算的），直到 dry-run 回報 **0**。
5. 讓每個 owner 從舊 exchange **提出可用保證金**：
   ```bash
   cast send $OLD_EXCHANGE "withdrawMargin(uint256)" <amount> --private-key <owner_key> --rpc-url $BASE_SEPOLIA_RPC_URL
   ```
6. 到這裡才跑步驟 3 的 `--broadcast`。

若你**必須**帶著未平倉部位往下走（你不會有時間追每個人），腳本會把這記成一個刻意的選擇 —— 那些部位失去保險金庫的後盾。盡量別。

---

## 5. 重接線清單

[#102](https://github.com/zuemen/pepelab_onchain_cfd/issues/102) 的每一項。做完就打勾。

| # | 目標 | 動作 |
|---|---|---|
| 1 | `frontend/src/contracts/addresses.ts` —— `BASE_SEPOLIA` 區塊 | 換掉 `PerpetualExchange`、`StrategyRegistry`、`CopyTracker`，以及 `ESGRegistry`→V2。**這個檔案是唯一真相來源** —— keeper 與 MCP server 從它讀合約位址，不是從自己的 env。 |
| 2 | `frontend/src/contracts/abi/*.json` | 從 `contracts/out/` 重新複製 `PerpetualExchange.json`、`CopyTracker.json`、`StrategyRegistry.json`、`AgentSessionManager.json`、以及任何新合約的 ABI。碳定價 exchange 有前端需要的新函式/事件。 |
| 3 | `agent/keeper` 的 `settleFunding` 目標 | 從 `addresses.ts`（項目 1）讀 exchange 位址。確認 `agent/keeper/run.ts` / `core.ts` 有接上；重啟 keeper process / CI。 |
| 4 | `agent/mcp-server` 的合約繫結 | 同上 —— 讀 `addresses.ts`。重啟 MCP server。驗證 `open_position` / `close_position` / `get_session` 解析到新 exchange + 新 session manager。 |
| 5 | `CopyTracker` 的上游 | 在步驟 3 的腳本裡完成（`exchange` 走建構子 + `setCopyTracker`；`feeRouter.setCopyTracker`；`traderStake.setCopyTracker`；新 `StrategyRegistry` 走建構子）。用 §3 的 `cast call` 再驗一次。 |
| 6 | `FeeRouter` 的 authorized callers | `FeeRouter` 把 `receivePerformanceFee` / vault-fee routing 閘在 `exchange` 與 `copyTracker` slot 上 —— 兩個都在步驟 3 重指了。確認沒有另一份 allow-list 需要加新 exchange。 |
| 7 | `InsuranceVault` / `KYCRegistry` 繫結 | `InsuranceVault.setExchange(new)` —— 步驟 3 完成（最後一個呼叫）。`KYCRegistry` —— 是 **exchange** 指向註冊表（步驟 3 的 `setKycRegistry`），註冊表本身不回指，所以註冊表這邊沒東西要改。 |
| 8 | `AgentSessionManager` 在新 exchange 上被授權 | `exchange.setAgentAuthorized(AgentSessionManager_NEW, true)` —— 步驟 3 完成。 |
| 9 | **撤銷舊的 `AgentSessionManager` `0x5Ebcc64C…`** | 見 §7。 |
| 10 | `EsgRewardDistributor` / `PepeIncentives` 的 immutable exchange | 若你重部署它們（§1），抄下位址加進 `addresses.ts`。若不重部署，記一筆說它們的 exchange 繫結是「舊但無害」。`EsgRewardDistributor` 的發放物：確認是 `SustainabilityBadge` 不是 PEPE（#98）。 |
| 11 | `deploy-base-sepolia.sh` / `seed-*.sh` / `contracts/script/Deploy*.s.sol` | 更新任何寫死的舊位址，讓未來的整套重部署是一致的。`DeploySyntheticAssets.s.sol` / `DeployGuardedStack.s.sol` 的 `sBOND` name 字串來自 #106。 |
| 12 | `MockSwapRouter` 預先注資 | `cast send $MockSwapRouter "fundRouter()" --value <ETH> …`（或它提供的注資呼叫），讓 `/exchange` 的 ETH↔USDC 兌換有流動性。金額跟組員確認。 |
| 13 | 註冊 BGRN 資產 | 已被步驟 3 的「全部 11 個資產」涵蓋（id `keccak256("sBOND")` 不變 —— #106 保留 symbol）。keeper 餵 `sBOND`←`BGRN`（來自 #106）。把初始 oracle 價設在 BGRN 真實水位附近（約 $48，來自 `INITIAL_PRICES` / `symbols.ts` seed），讓 keeper 第一次真的抓價時通過偏離守衛（`KEEPER_REJECT_DEVIATION=0.5`）。 |

### `agent/.env`

若有就更新（大多數繫結來自 `addresses.ts`，但少數幾個釘在 env）：

- `SESSION_MANAGER_ADDRESS` → `AgentSessionManager_NEW`
- `DEMO_SESSION_ID` → `0`（新 manager 從頭開始；舊的 `#0` / `#6` 在它上面不存在）
- `PERP_ADDRESS`（資訊用）→ `PerpetualExchange_NEW`
- `KEEPER_VAULT_ADDRESS` → 不變（`AssetVault` 不動）

---

## 6. 前端 + agent 重新建置

WSL 裡執行：

```bash
# frontend
cd frontend
yarn install
yarn build            # tsc + vite —— 必須乾淨
yarn test             # 完整 vitest —— 必須全綠
# 部署這版 build（Vercel 或 demo 站所在處）

# agent
cd ../agent
npm install
npm run typecheck
npm run test          # keeper + signal-api 離線測試
npm run bundle:vercel  # ← 若動過 agent/signal-api/src/*.ts 一定要重跑，否則 bundle-drift CI 會紅
# 重啟：signal-api、keeper（或它的 CI 排程）、mcp-server
```

keeper 第一次對新 exchange 跑，會為全部 11 個資產寫新價。盯它的 log 看 `sBOND` 有沒有 `DeviationTooLarge` —— 若被拒，鏈上 seed 價離 BGRN 真實價太遠；修 seed 讓 keeper 分段逼近。

---

## 7. 撤銷舊的 `AgentSessionManager` `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8`

**為什麼：** 它還在**舊** exchange 的 `authorizedAgents` 裡且從未撤權。它**沒有 per-session 資產白名單**（`createSessionWithAssets` 在它部署時還不存在），所以它上面任何有預算的 session 都能把整個額度押在使用者從沒打算持有的資產上 —— 一條繞過資產閘門的可用路徑。見 `docs/KNOWN_LIMITATIONS.md` §10。

**在新 exchange 上：** 它自動**不**被授權 —— 全新的 `PerpetualExchange` 起始 `authorizedAgents` 是空的，步驟 3 只加 `AgentSessionManager_NEW`。所以新場所天生就是乾淨的。

**在舊 exchange 上**（趁它還讀得到，做縱深防禦）：

```bash
cast send $OLD_EXCHANGE "setAgentAuthorized(address,bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 false \
  --private-key "$PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# 驗證
cast call $OLD_EXCHANGE "authorizedAgents(address)(bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 --rpc-url "$BASE_SEPOLIA_RPC_URL"   # false
```

也確認**現行的** manager `0x4E7cC1B…` 沒有被帶到新 exchange 上（除非你刻意要兩個都在，你不會 —— 它的 `exchange` 是 immutable 指向舊的，反正在新場所也交易不了）。

demo「試圖為特定使用者豁免碳費率 → 看它 revert」那一幕：那是新 exchange 的性質（**沒有**任何 per-user 費率豁免路徑 —— 那是一個被測試釘住的缺席，`CarbonPricing.t.sol`），不是你在這裡設定的東西。

---

## 8. Demo 資料 —— 重新發布範例 Allocation

新 `StrategyRegistry` 是**空的**。既有已發布策略無法遷移。你需要**至少 3 份**，每份都通過 #97 的約束：

- **≥ 3 個資產**
- **每個權重 ≤ 5000 bps（50%）**
- **權重加總剛好 10000 bps**
- 每條 leg 的槓桿 ∈ {1, 2, 5} **且**在該資產的碳分級上限內（高碳資產封在 1x；demo 全部用 1x 避開這個邊界）

**發布帳號：** 跟組員決定用哪些 EOA 發布，記在 [#102](https://github.com/zuemen/pepelab_onchain_cfd/issues/102)。每個發布者依序：

1. `StrategyRegistry_NEW.registerTrader("<顯示名稱>")` —— `publishStrategy` 是 `onlyRegistered`。
2. 若新註冊表建構時帶了非零的 `stakeContract`（它建構子吃 `_stake` = `TraderStake`），發布者必須**質押夠**：`cast call $StrategyRegistry_NEW "isEligible(address)(bool)" <發布者>` 要回 `true` —— 不夠就補 `TraderStake` 存款。（若 `_stake` 是 `address(0)`，這個閘跳過。）
3. `publishStrategy(Allocation[])` —— `Allocation` 是 `(bytes32 asset, uint256 weightBps, bool isLong, uint256 leverage)`。強制：長度 ≥ 3、資產不重複、每個 `weight ≤ 5000`、`Σ weight == 10000`、`leverage ∈ {1,2,5}`。

建議的 3 份（碳分級依 `frontend/src/lib/pepefi/carbon.ts` + `assetMeta.ts`：低 = sNVDA、sAAPL、sETH、sICLN、sBOND；中 = sESGU；高 = sMSFT、sGOOGL、sTSLA、sGOLD、sBTC）：

| 策略 | 組成（全部 long、1x） | 理由 |
|---|---|---|
| **低碳保守** | sICLN 3400 · sBOND 3300 · sNVDA 3300 | 三個低碳資產，加權碳強度最低，沒有一個超過 34% |
| **均衡** | sAAPL 2500 · sESGU 2500 · sGOLD 2500 · sETH 2500 | 橫跨低 / 中 / 高，四等分 |
| **成長** | sNVDA 4000 · sMSFT 3000 · sGOOGL 3000 | 科技權重；sMSFT + sGOOGL 是高碳，所以被 1x 封頂 —— 展示機制在咬 |

發布方式：對每份策略 `cast send $StrategyRegistry_NEW "publishStrategy(...)"`，或擴充 `contracts/script/SeedMarket.s.sol`（它已經在建 `StrategyRegistry.Allocation[]` 的變體）對新註冊表跑：

```bash
cd contracts
USDC_ADDR=$USDC EXCHANGE_ADDR=$PerpetualExchange_NEW REGISTRY_ADDR=$StrategyRegistry_NEW \
FEE_ROUTER_ADDR=$FEE_ROUTER STAKE_ADDR=$TRADER_STK \
  forge script script/SeedMarket.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast -vvv
```

驗證：`/marketplace` 顯示 3 份策略，且每份都能按加權碳強度排序。

---

## 9. 端到端驗證（#102 要求的兩項檢查）

### 9.1 一次完整的採用流程 + 正確的逐資產扣款

1. 在 `/marketplace` 採用 **均衡**（橫跨三個碳分級）。
2. 確認預留的手續費預算是**逐 `Allocation` 項目**計算的（#97）—— 一份混合低碳 + 高碳的配置必須預留到足以讓每條 leg 都開得成；失敗症狀是「4 條開了 2 條，然後因保證金不足 revert」。
3. 直接在**高碳**資產（`sMSFT`）和**低碳**資產（`sNVDA`）各開一個部位：
   - `sMSFT` 交易費 ≈ `CarbonTiers` 高（`tradingFeeBps` 100）且**最大槓桿 1x** —— 試 2x，確認 revert。
   - `sNVDA` 交易費 ≈ 低（`tradingFeeBps` 10），槓桿最高 5x 被接受。
4. 讓一個部位累積一段借貸費；確認每小時費率吻合開倉當下寫進部位的分級（事後見證變動**不得**追溯改變它）。

```bash
# exchange 會套用的費率 + 槓桿上限，逐資產
for s in sNVDA sMSFT sBOND sESGU; do
  lev=$(cast call $PerpetualExchange_NEW "maxLeverageForAsset(bytes32)(uint256)"   $(cast keccak "$s") --rpc-url $BASE_SEPOLIA_RPC_URL)
  fee=$(cast call $PerpetualExchange_NEW "tradingFeeBpsForAsset(bytes32)(uint256)" $(cast keccak "$s") --rpc-url $BASE_SEPOLIA_RPC_URL)
  echo "$s  maxLev=$lev  tradingFeeBps=$fee"
done
# 預期：sNVDA/sBOND 低（5, 10）· sESGU 中（2, 40）· sMSFT 高（1, 100）
```

### 9.2 Expert Mode —— 重部署後 11 頁全部仍可用

Expert Mode 會出現在口試。連一個 Base Sepolia 的真錢包，走過每一頁：

`TradeTerminalPage` · `WhaleTrackerPage` · `TraderDashboard` · `TraderStakePage` · `RewardsPage` · `VaultPage` · `AgentMonitorPage` · `X402DocsPage` · `AdminKYCPage` · `AdminOraclePage` · `AdminTreasuryPage`

盯著看：空白面板（ABI 過期）、不該出現的「錯誤網路」、讀不到 owner-only 狀態的 admin 頁（部署者金鑰對不上）、agent monitor 顯示無 session（預期 —— session id 重置了；建一個新的 demo session）。

### 9.3「不可裁量」的 demo 一幕

用部署者（owner）帳號，試著給某個特定使用者降低碳費率。**沒有這個函式** —— 最接近的呼叫會 revert 或不存在。這就是主張句的現場證明；先排練你要打哪個呼叫。

---

## 10. 中途失敗怎麼辦

| 卡在 | 復原 |
|---|---|
| §2 dry-run 顯示有未平倉 | 不是失敗 —— 去清空（§4），重試。什麼都沒送出。 |
| §3 broadcast 跑到一半 revert | `forge` script **不是跨交易原子的**。讀 `run-latest.json` 看哪些 tx 落地了。若 exchange 部署了但接線沒跑完，可以用 `cast send` 手動補完那些 setter（都是 `onlyOwner`）。**不要**重跑整個腳本 —— 你會得到第二個 exchange。 |
| §4.5 `InsuranceVault.setExchange` 落地了但後面壞了 | 舊場所已經降級。往前推 —— 用 `cast send` 修剩下的接線，別想倒回去。 |
| §5 之後前端 build 紅 | 通常是 ABI 沒複製。`contracts/out/<Name>.sol/<Name>.json` → `frontend/src/contracts/abi/<Name>.json`。 |
| keeper 拒絕 `sBOND` 價 | seed 價離 BGRN 真實（約 $48）太遠。用 `cast send $ORACLE "setPrice(bytes32,uint256)" $(cast keccak "sBOND") <price_8dec>` 把鏈上價拉近，讓 keeper 逼近。 |

過了 §4.5 **沒有乾淨的 rollback**。這就是為什麼有清空步驟與 dry-run 閘門。

---

## 11. 簽核清單

- [ ] #117（#106）已合併
- [ ] §2 腳本工作完成 + review + merge：更新 `RedeployExchange.s.sol`；**新增** `DeployESGRegistryV2` / `SeedESGV2` / `DeploySustainabilityBadge` / `DeployEsgRewardDistributorV2` 腳本
- [ ] `ESGRegistryV2` 已部署；`ATTESTOR_ROLE` 已授予；11 個資產已見證（× 每個 attestor EOA）
- [ ] `SustainabilityBadge` + V2 `EsgRewardDistributor` 已部署（distributor 在 exchange 之後）
- [ ] 舊 exchange 清到 0 未平倉；可用保證金已提出
- [ ] `RedeployExchange` 已 broadcast；5 個新位址已抄下
- [ ] §3 的 `cast call` 健檢全通過
- [ ] `addresses.ts` + ABI 已更新；前端 `yarn build` + `yarn test` 全綠；站台已重部署
- [ ] agent `npm run typecheck` + `npm run test` 全綠；若動過 `signal-api/src` 已 `npm run bundle:vercel`；keeper / signal-api / mcp-server 已重啟
- [ ] keeper 為全部 11 個資產寫了新價，沒有 `DeviationTooLarge`
- [ ] 舊 `0x5Ebcc64C…` 在舊 exchange 上 `authorizedAgents == false`；在新 exchange 上不存在
- [ ] `MockSwapRouter` 已注資
- [ ] 3 份 demo Allocation 已發布；`/marketplace` 能按加權碳強度排序
- [ ] §9.1 逐資產扣款已驗證（高碳 1x 封頂、低碳 5x）
- [ ] §9.2 走過 11 頁 Expert Mode
- [ ] §9.3 排練過費率豁免的 revert
- [ ] `#102` 已更新新位址 + 發布帳號

---

## 附錄 —— 要做成互動式 wizard 嗎

機械的部分（把位址填進 `addresses.ts` + `agent/.env`、`cast call` 驗證掃描、發布 demo 策略）可以包成一個分階段的 bash wizard：開每個瀏覽器連結、抓每個位址、寫進該去的地方、每個不可逆的 `cast send` 前確認。要就說一聲，可以產進 `scripts/`。部署本身（`forge script … --broadcast`）維持你手動跑、手動讀 —— 它需要你對 gas、revert、未平倉數的判斷。
