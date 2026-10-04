# Runbook：凍結外洩部署者金鑰在舊部署上的權限（P0-09／選項卡 D6）

> 狀態：**腳本與本機分叉演練已完成（2026-10-03），尚未對任何公開鏈執行。** 實際執行由擁有者本人做。
>
> - 腳本：`contracts/script/FreezeLegacyDeployments.s.sol`
> - 唯讀讀回：`ops/freeze-legacy/readback.mjs`（盤點全集：`ops/freeze-legacy/inventory-2026-10-03.json`）
> - 分叉演練的使用者路徑測試：`ops/freeze-legacy/exit-tests-sepolia.sh`、`exit-tests-base.sh`
> - 演練輸出：`ops/freeze-legacy/rehearsal-2026-10-03/`
>
> 本文件與上述檔案都不含私鑰字面值，也不含任何持有人位址或個人餘額。

## 0. 一句話

外洩地址 `0xE80A81360608C1342e66743F70a00f75d792Eb93` 的私鑰在公開的 git 歷史裡。
2026-08-07 的輪替（`KEY_ROTATION_20260807.md`）只處理了 Base Sepolia 的現行合約；
這把金鑰截至 2026-10-03 **仍是 Ethereum Sepolia 54 顆合約的 owner／admin，以及 Base Sepolia 3 顆 oracle adapter 的 owner**。
本 runbook 用那把金鑰本人的簽名，把這些權限全部放棄（Sepolia）或移交（Base adapter），
並逐顆確認沒有讓任何使用者資金卡死、沒有誤傷 keeper 等其他角色。

## 1. 它現在能做什麼（為什麼要做）

依嚴重程度：

| # | 權限 | 能造成的傷害 |
|---|---|---|
| 1 | Base `ChainlinkOracleAdapter`／`PythOracleAdapter`／`AggregatorOracleAdapter` 的 owner | `base-sepolia-keeper.yml` 的 `KEEPER_RELAY_SOURCE` 就是 `AggregatorOracle 0x8215…`，keeper **優先**讀它的價格再中繼進現行交易所讀的 MockOracle。owner 能 `setFeed`／`setPriceId` 把來源指向任意合約 → 經由 keeper 影響**現行 Base 交易所**的結算價。ops/monitoring 的 oracleDeviation 也拿它當參考價。鏈上沒有合約指向這三顆，所以只查 getter 會漏掉這條鏈下依賴。 |
| 2 | Sepolia `AssetVaultV2` 代理 `0x3a37…` 的 DEFAULT_ADMIN | UUPS 升級權：可換掉實作、搬走金庫的 502,000 mUSDC。 |
| 3 | Sepolia 8 顆 `SyntheticAssetV2` 的**唯一** DEFAULT_ADMIN | 可給自己 MINTER_ROLE、增發 sBTC 等，再向 AssetVaultV2 贖回。 |
| 4 | Sepolia `GuardedOracle` 的 DEFAULT_ADMIN／KEEPER／GUARDIAN | 改偏離上限、改價、暫停。 |
| 5 | Sepolia 舊 `MockOracle` ×6 的 owner | 舊 exchange 仍讀它們、仍有非外洩使用者的部位；owner 能任意改價、清算別人。 |
| 6 | 其餘 Sepolia Ownable 合約 | 改費率、改接線、增發 PEPE／MockUSDT 等。 |

分叉上的對照組證明了上表不是理論：凍結前，外洩地址能 `grantRole(KEEPER)`、`grantRole(MINTER)`、`grantRole(RISK)`、
改舊 oracle 價、改現行 Sepolia exchange 的 FeeRouter、增發 PEPE（`rehearsal-sepolia-0-control-prefreeze.txt` 的 C 區），
在真實 Base 上以 `eth_call` 模擬 `setFeed`／`setMaxDeviationBps` 也都會成功（`rehearsal-base-0-control-ethcall.txt`）。

## 2. 盤點

### 2.1 方法（不只靠既有清單）

候選合約 = 三個來源的聯集，對每一顆有 code 的合約逐一讀 `owner()`、`pendingOwner()`、`guardian()`、
`marketOperator()`、`authorizedAgents(leak)`、`verifiers(leak)`、`platformTreasury()`、ERC-1967 admin slot，
以及 AccessControl 的 `hasRole(role, leak)`：

1. **外洩地址的 CREATE 全掃**：Sepolia nonce 0–1230、Base nonce 0–1961，逐一計算 CREATE 位址並查 code（Sepolia 95 顆、Base 37 顆）。
2. **全區段事件**（Tenderly gateway 允許 0→latest 的 `eth_getLogs`）：`OwnershipTransferred(newOwner = leak)`、
   `OwnershipTransferred(previousOwner = leak)`、`RoleGranted(account = leak)`、`RoleRevoked(account = leak)`、`RoleGranted(sender = leak)`。
   這一步也涵蓋「不是外洩地址部署、但後來授權給它」的合約。
3. **repo 內出現過的所有位址**（325 個，含 broadcast）。

合計 Sepolia 169 個、Base 133 個有 code 的位址；其中 51／53 個是被 EIP-7702 委派的一般帳戶（runtime code 只有 23 bytes 的 `0xef0100…`，是公開測試金鑰被委派到共用的 DeleGator 合約），不是合約，也都不持有任何權限。排除後實際合約為 Sepolia 118 顆、Base 80 顆，收在 `inventory-2026-10-03.json`。

角色雜湊：從 `contracts/src/**` 的常數（`ATTESTOR/GUARDIAN/KEEPER/MINTER/PAUSER/RISK_ROLE`）＋ `ops/monitoring/monitors.json`
的 `roleNames` ＋ 常見名稱（UPGRADER/ADMIN/OPERATOR/VERIFIER/BURNER…）計算；另外 RoleGranted 事件裡外洩地址拿過的角色
全部落在上述集合內，沒有未知角色。

**AccessControlEnumerable**：這批合約都**不支援**（`supportsInterface(0x5a05180f)` 為 false），所以角色持有人以
`RoleGranted`／`RoleRevoked` 事件重建（下表）。外洩金鑰曾送出的 28 筆 `RoleGranted` 全部指向預期地址
（自己、V2 admin／keeper／guardian／risk、金庫代理），**沒有授權給計畫外地址的紀錄**；`OwnershipTransferred(previousOwner = leak)`
在 Sepolia 只有 MockOracle `0x17CA → keeper`，在 Base 只有 2026-08-07 輪替與 MockOracle → keeper。

### 2.2 結果：外洩地址持有的權限（2026-10-03）

**Base Sepolia（84532）— 3 顆**

| 合約 | 權限 | 使用中？ | 資金 |
|---|---|---|---|
| ChainlinkOracleAdapter `0x37DC7b70899BFfB17949366a5b6a86203C428E2f` | owner | 是：AggregatorOracle 的來源 | 無 |
| PythOracleAdapter `0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5` | owner | 是：AggregatorOracle 的來源 | 無 |
| AggregatorOracleAdapter `0x8215158642350a3f329aB9597186d21f957A813D` | owner | 是：Base keeper 的 `KEEPER_RELAY_SOURCE`、監控的參考價（目前對全部資產 revert `NoLiveSource`，keeper 退回外部 API） | 無 |

**Ethereum Sepolia（11155111）— 54 顆、58 個權限**

AccessControl 角色持有人（事件重建）：

| 合約 | 外洩地址持有 | 其他持有人（必須保留） |
|---|---|---|
| GuardedOracle `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` | DEFAULT_ADMIN、KEEPER、GUARDIAN | admin `0x2a58…83e3`、keeper `0x540a…ef17`、guardian `0x9913…A4e4` |
| AssetVaultV2（UUPS 代理）`0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17` | DEFAULT_ADMIN、RISK、PAUSER | admin `0x2a58…83e3`、risk `0xECe9…B165`、pauser `0x9913…A4e4` |
| SyntheticAssetV2 sBTC `0xeCF2…32Ac`、sETH `0x5768…478A`、sAAPL `0x84C2…0163`、sTSLA `0x0e8b…695E`、sGOLD `0xc97b…1a10`、sBOND `0xb84C…44eb`、sNVDA `0xB558…CfeE`、sMSFT `0xCB2c…50cf` | DEFAULT_ADMIN（**唯一**） | MINTER = AssetVaultV2 代理 |

（V2 的 sGOOGL／sICLN／sESGU 沒有任何角色事件，外洩地址也不持有。）

Ownable（全部 `owner() == 外洩地址`）：

| 分組 | 合約 |
|---|---|
| 前端 Sepolia（legacy demo）現行 V1 | PerpetualExchange `0x0c6459d3…c32b`、InsuranceVault `0x8bDE83dB…b091`、FeeRouter `0x2297e580…3079`、TraderStake `0x3fe1dbC8…d673`、KYCRegistry `0x7d40A2D3…C5bB`、ESGRegistry `0xdCFdDd38…8c13`、AssetVault（V1）`0xB4D10cBC…325f`、PepeAMM `0x3e6503BA…6A0c`、PepeToken `0xa364F436…e1D9`、PepeClaim `0x852c0fBa…2A4C`、EsgRewardDistributor `0xA1a522B9…EdD0`、PepeIncentives `0x65b9F1B4…E5D7`、PepeStaking `0xf5d0953A…09f9`、MockUSDT `0xA08C0F92…B5F1` |
| 已被取代的舊部署 | PerpetualExchange ×6（`0x00f6cf01…`、`0xb3e978E9…`、`0xc100f942…`、`0x4cC711AE…`、`0xdC5cc6Ab…`（從未接上前端）、`0xF2A6F7B6…`）、FeeRouter ×5、TraderStake ×4、MockOracle ×6、PepeAMM ×3、PepeIncentives ×2、InsuranceVault ×1、MockUSDT ×1 |
| 早期練習代幣（nonce 0、1，非本產品） | CoolToken `0x69fd695B…b035`、HaerinToken `0xC9b0e5C2…8Ae`（與 Base 的 MockUSDC／MockSwapRouter 同位址，是不同鏈上同 nonce 的巧合） |

完整位址見 `inventory-2026-10-03.json`（`label` 欄位）與腳本的 `_planSepolia()`。

### 2.3 凍結**處理不了**的：`platformTreasury`（immutable）

`FeeRouter.platformTreasury` 是 `immutable`，`withdrawPlatformFees()` 只付給它。以下 FeeRouter 的 treasury 是外洩地址：

- **Base 現行 FeeRouter `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c`**（現行 exchange `0x827e…` 的 FeeRouter）：盤點時 `platformEarnings` = 0.06 MockUSDC。
- **Base x402 FeeRouter `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d`**。
- Sepolia FeeRouter ×6（`0x2297…`、`0x0FfA…`、`0x54e5…`、`0xBb7c…`、`0xc2aA…`、`0xCCD0…`）。

意思是：**平台 20% 分潤會持續累積在只有外洩金鑰能領的位置**。這不是 owner 權限，任何凍結操作都拿不掉，
只能重新部署 FeeRouter（並把 exchange／CopyTracker 改接新的那顆）。`RUNBOOK_KEY_ROTATION.md` §6.2 寫「用該 router 的
owner-only setter 改成 $NEW_ADDR」，但 `FeeRouter` 沒有這種 setter——那段需要更正。建議另開一張卡處理。

## 3. 還有沒有東西在用

| 對象 | 結論 | 依據 |
|---|---|---|
| 前端 | Sepolia 仍可切換使用：`CHAIN_MAP` 含 `11155111`（標為「Sepolia（legacy demo）」），錢包在 Sepolia 時讀 `SEPOLIA` 位址與 `V2_STACK[11155111]`；`/legacy` 頁列 Sepolia 舊 exchange。 | `frontend/src/contracts/addresses.ts`、`legacyExchanges.ts` |
| Sepolia keeper | 仍在跑：`price-keeper.yml` 寫 MockOracle `0x17CA…`（owner = keeper `0x540a…`）與 GuardedOracle（KEEPER_ROLE = keeper `0x540a…`）。最近一次成功 2026-10-03 08:08 UTC。**兩者都不是外洩地址持有的權限，凍結不影響它。** | workflow、`gh run list` |
| Base keeper | 讀 AggregatorOracle 當中繼來源（見 §1 #1）。移交 owner 不改變讀取行為。 | `base-sepolia-keeper.yml`、`agent/keeper/run.ts` |
| 監控 | `ops/monitoring` 只監控 Base，讀三顆 adapter（`oracle-deviation`、`aggregator-oracle-config`、`chainlink-/pyth-adapter-config`、`owner-transferred`）。**移交時 `owner-transferred`（SEV-1）會對三顆各響一次，這是預期的。** | `monitors.json` |
| 資金（合約層級，鏈上公開餘額） | 現行 Sepolia exchange 4,914,803 mUSDC、AssetVaultV2 502,000、AssetVault V1 1,000,000、TraderStake 6,600、InsuranceVault 1,006.6、PepeAMM 699.9 + 1.8 ETH；舊 exchange 0x00f6／0xb3e9／0xc100／0x4cC7 分別 3,000／498.5／1,003／920（各自的舊 mUSDC）；PEPE 獎勵池若干。 | `balanceOf` |
| 資金（持有人層級） | 現行 Sepolia exchange、InsuranceVault、TraderStake、舊 exchange `0x4cC7` 上**有非外洩地址的資金**。持有人明細只在本機的內部盤點文件，不放進 repo。 | `docs/commercial/`（不入版控）與鏈上事件 |

## 4. 每顆的處理方式與理由

原則：**能放棄就放棄（renounce = 永久無主 = 凍結）**；只有「之後確實還需要有人管理」的才移交；
「處理會造成更大傷害」的不處理——這次盤點沒有任何一顆落在這一類（逐顆理由見下）。

| 對象 | 處理 | 理由 |
|---|---|---|
| **（最前）0x0c64、0x4cC7 的 FeeRouter** | **`setFeeRouter(address(0))`，排在批次最前面** | 這兩顆是同一份 build（82c68d9），有一個已知的會計缺陷，只能在**放棄 owner 之前**由 owner 停用 FeeRouter 來封堵；一旦 renounce 就永遠修不了，所以必須最先做。缺陷細節不在本公開文件描述，見內部審查。其餘舊 exchange 是另一份 build（907a6b6，無此缺陷），不碰它們的 FeeRouter。腳本 `verify()` 會檢查 `feeRouter()==0`。 |
| Base 三顆 oracle adapter | **移交**給 `ADAPTER_NEW_OWNER`（建議 `0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`，2026-08-07 輪替後的 Base 部署者，已是所有 Base 現行合約的 owner，不增加新的信任對象） | keeper 與監控都依賴它；參考價目前 `NoLiveSource`，之後要有人 `setFeed`／`setPriceId` 修好。放棄會讓這條依賴永遠修不了。腳本要求新 owner 是 EOA、不在拒絕清單、並以 `ADAPTER_NEW_OWNER_CONFIRM` 二次確認。 |
| GuardedOracle、AssetVaultV2 的外洩角色 | **renounceRole**：先非 admin 角色，DEFAULT_ADMIN 最後 | 另一個 admin `0x2a58…` 仍在（腳本放棄前會確認，否則中止；執行前另需 `V2_ADMIN_PROVEN=1`，見 §7.0），所以兩顆都不會變成無 admin；keeper／guardian／risk 由獨立金鑰持有，外洩那份純屬風險。 |
| 8 顆 SyntheticAssetV2 的 DEFAULT_ADMIN | **兩階段（M4）**：① 腳本以外洩金鑰 `grantRole(admin, V2_ADMIN)` 再 `renounceRole(admin, leaked)`；② 確認無後門後，由 **V2_ADMIN 自己** `renounceRole(admin, V2_ADMIN)`（見 §7.4 phase 2） | 外洩地址是唯一 admin。若一步放棄成永久無主，執行期間被插入的後門就再也無法撤銷；兩階段讓 V2_ADMIN 在空窗期保有撤銷能力。最終仍是無 admin（phase 2 後），MINTER 永遠只在金庫代理手上。 |
| 現行 Sepolia V1（14 顆） | **renounceOwnership** | 逐顆確認使用者的退出路徑都不需要 owner（§5）。owner 剩下的能力只有改參數、改接線、增發、提走 owner 自己的部分——在一條已降為 legacy 的鏈上，這些都只對搶到金鑰的人有用。 |
| 舊 Sepolia 部署（28 顆） | **renounceOwnership** | 前端與 keeper 都不再引用；舊 MockOracle 尤其重要（舊 exchange 仍讀它、仍有非外洩使用者的部位）。放棄後價格凍結在最後一次的值，平倉以該價結算（舊版不檢查時效，見 `LEGACY_EXCHANGES.md`）。 |
| CoolToken、HaerinToken | **renounceOwnership** | owner 只能增發；沒有任何東西依賴它們。 |
| `platformTreasury` ×8 | 無法處理 | immutable，見 §2.3。 |

放棄 owner 的已知代價（都已評估、可接受）：

- 現行 Sepolia exchange 的執行費（0.054 ETH）只能由 owner `withdrawExecutionFees()` 領出，放棄後永久留在合約裡；不放棄的話只會被搶到金鑰的人領走。
- PepeClaim／PepeIncentives 的 owner `withdraw` 與 PepeStaking `notifyRewardAmount` 從此無法使用：剩餘 PEPE 獎勵留在合約裡，使用者照常 claim／退出。
- KYCRegistry `0x7d40`（部署版 c477705）的 KYC 是自助送出（`submitKYC`）、不會過期；owner 端只有一個 `batchVerify`，放棄後無法再用，但不影響使用者自助送出，現行 Sepolia exchange 也沒有 KYC 檢查。（此合約的部署版本**沒有** `recapitalize`／`setVerifier`。）
- 8 顆 SyntheticAssetV2 在 phase 2 之後永久無 admin：日後若要把代幣改指**新的**金庫代理，或某次升級把金庫端的升級能力弄壞，代幣將無法改接新金庫。實際影響小（目前僅 sAAPL 有少量供給，且全在外洩地址手上），但要寫明。

## 5. 資金路徑：凍結後是否仍能取回

逐顆確認「使用者把錢拿回來」的函式不需要 owner／admin，並在分叉上**實際送交易**（`rehearsal-sepolia-6-exit-paths-after-freeze.txt`，21/21 PASS）：

| 合約 | 退出路徑 | 是否需要權限 | 分叉實測（凍結後） |
|---|---|---|---|
| 現行 Sepolia PerpetualExchange `0x0c64…` | `withdrawMargin`、`closePosition` | 否（此版本沒有 pause、沒有時效檢查、沒有 KYC） | 非外洩持有人提領 1,000 成功、平倉成功 |
| InsuranceVault `0x8bDE…` | `withdraw(shares)` | 否 | 非外洩持有人全額贖回成功 |
| TraderStake `0x3fe1…` | `requestUnstake` → 1 天 → `executeUnstake` | 否（`slash` 只限 copyTracker，不受影響） | 非外洩持有人全額解除質押成功 |
| 舊 PerpetualExchange `0x4cC7…` | `closePosition`、`withdrawMargin` | 否 | 非外洩持有人先平倉、再全額提領成功 |
| AssetVaultV2 `0x3a37…` | `redeem` | 否（需 GuardedOracle 價格新鮮，keeper 照常寫） | `redeem(sAAPL, 1)` 成功（唯一 sAAPL 持有人是外洩地址本身） |
| PepeAMM `0x3e65…` | — | 部署版本 bytecode **沒有** `removeLiquidity`，也沒有 owner 提款（凍結前後相同）；唯一 LP 是外洩地址 | swap 仍可用 |
| PepeStaking `0xf5d0…` | `withdraw`／`exit` | 否 | 目前沒有任何質押者（餘額只是獎勵預算） |
| AssetVault V1 `0xB4D1…` | `redeem` | 否 | V1 合成資產總供給為 0，沒有可贖回的人；1,000,000 mUSDC 是 owner 注入的準備金，部署版本沒有 owner 提款函式（凍結前後相同） |

**已知限制（與凍結無關，但須對使用者說明）**：Sepolia 的舊部署資金池**不保證可全額取回**。這是舊部署
本身的經濟性性質，凍結不會讓它變好也不會變壞——owner 本來就沒有任何能保護這些資金的操作（沒有 pause、
沒有 owner 提款）。前端公告與客服說明應講明這一點，不要只停用開倉。手法細節不在本公開文件描述。

## 6. 對 keeper 與前端的影響（只寫建議，本次不改）

**`price-keeper.yml`（Sepolia）**：凍結本身**不需要**停掉它——它用的是獨立的 keeper 金鑰，分叉實測凍結後仍能寫
MockOracle 與 GuardedOracle。建議：

1. 凍結後**先繼續跑一段公告期**（例如兩週）。現行 Sepolia exchange 不檢查價格時效，keeper 一停，平倉會以停止當下的價格結算；
   有非外洩使用者仍有部位，讓他們在價格仍然真實的時候平倉比較公平。
2. 公告期後停用排程（移除 `schedule`，保留 `workflow_dispatch`）。停用後 GuardedOracle 一小時內過期，AssetVaultV2 的 mint／redeem 會 `StalePrice`；
   目前唯一受影響的 V2 持有人是外洩地址本身，所以可以接受。
3. 停用前把 keeper 金鑰的 Sepolia ETH 餘額（盤點時約 0.44 ETH）留作之後手動補價用即可，不需要移走。

**前端**：建議把 Sepolia 標成「已凍結：只能平倉、提領、贖回；參數不再調整」，並在 Sepolia 上停用入金與開倉按鈕。
理由：凍結只拿掉管理權，`depositMargin`、`stake`、`deposit` 等仍是 permissionless，使用者仍可能把新的錢放進一條不再有人維護的鏈；
`/legacy` 頁不受影響。

## 7. 擁有者執行步驟

### 7.0 先做什麼

1. **不要轉任何東西給外洩地址。** Base 上它被 EIP-7702 委派到 MetaMask `EIP7702StatelessDeleGator` 1.3.0
   （`0x63c0…E32B`；Sepolia 上沒有 code）。目前帳上仍有約 2.06 ETH（Sepolia）與約 0.00996 ETH（Base），
   沒有被掃空的跡象，但委派一旦被用來簽名就可能動用，所以不要再入金。
   不需要補 gas：模擬估計 Sepolia 需約 0.0045 ETH、Base 需約 0.0000013 ETH，餘額都夠。
2. **（M3）證明 `0x2a58…`（V2_ADMIN）金鑰可用**：用它在 Sepolia 送一筆 0 值自轉帳或簽一則訊息。
   確認 `contracts/.env.roles` 有**離線備份**（本步驟不要去讀或動那個檔案的內容）。做完後執行才設 `V2_ADMIN_PROVEN=1`；
   沒設時腳本在 Sepolia 執行會以 `V2AdminNotProven` 中止。
3. **（M2）證明 `ADAPTER_NEW_OWNER`（建議 `0x27C2…`）金鑰可用**：用它在 Base 送一筆 0 值自轉帳或簽一則訊息。
   腳本會要求它是 EOA、不在拒絕清單、且 `ADAPTER_NEW_OWNER_CONFIRM` 與它逐字相符。若改成放棄，設 `ADAPTER_RENOUNCE=true`（先讀 §4）。
4. 通知會收到監控告警的人：Base 的 `owner-transferred`（SEV-1）會對三顆 adapter 各響一次。
5. 在 `contracts/` 執行 `forge build`。

### 7.1 執行前的唯讀確認（不需要金鑰）

```bash
# 應該 exit 1，列出 Sepolia 54 顆、Base 3 顆；LOGS_RPC 行的「可疑」必須為 0。
# 若合約數多於此、或可疑 > 0，代表盤點後又有新的授權／升級，先停下來查再繼續。
LOGS_RPC=https://sepolia.gateway.tenderly.co      node ops/freeze-legacy/readback.mjs sepolia      https://ethereum-sepolia-rpc.publicnode.com
LOGS_RPC=https://base-sepolia.gateway.tenderly.co node ops/freeze-legacy/readback.mjs base-sepolia https://base-sepolia-rpc.publicnode.com
```

事件掃描若出現「指向計畫外地址」「Upgraded」「AdminChanged」，代表有人已用外洩金鑰留下後門，
**光放棄外洩地址的權限不夠**，先處理那些對象再繼續。readback 遇 RPC 錯誤會 `exit 2`（不會假裝通過），
換一個支援全區段 `eth_getLogs` 的節點重跑。

### 7.2 本機分叉演練（建議，與 2026-10-04 的演練相同）

```bash
anvil --fork-url https://sepolia.gateway.tenderly.co --port 18545 &      # 記下 PID，結束時用 PID 關
cd contracts
export FOUNDRY_BROADCAST="$HOME/freeze-fork-broadcast"   # 指到 repo 外，分叉紀錄不要混進 contracts/broadcast/
cast rpc anvil_impersonateAccount 0xE80A81360608C1342e66743F70a00f75d792Eb93 --rpc-url http://127.0.0.1:18545
FREEZE_CHAIN=sepolia FREEZE_EXECUTE=true V2_ADMIN_PROVEN=1 FREEZE_CONFIRM=FREEZE-11155111 \
  forge script script/FreezeLegacyDeployments.s.sol --rpc-url http://127.0.0.1:18545 \
  --sender 0xE80A81360608C1342e66743F70a00f75d792Eb93 --unlocked --broadcast --slow
cd .. && LOGS_RPC=http://127.0.0.1:18545 node ops/freeze-legacy/readback.mjs sepolia http://127.0.0.1:18545   # 應 exit 0、可疑 0
H_EX=… H_IV=… H_OLD=… bash ops/freeze-legacy/exit-tests-sepolia.sh                # 持有人位址見本機內部盤點
```

Base 同理（port 18546，`FREEZE_CHAIN=base-sepolia`、`ADAPTER_NEW_OWNER=0x27C2…`、`ADAPTER_NEW_OWNER_CONFIRM=0x27C2…`、
`FREEZE_CONFIRM=FREEZE-84532`，測試用 `exit-tests-base.sh`）。**Base 分叉要加 `--no-storage-caching`**：forge 1.7.1 在
Base 分叉上會讀到快取的 balance=0 而報 `lack of funds`，加這個旗標即可（演練時另外 `anvil_setBalance` 給冒充帳戶補餘額）。

### 7.3 對真實鏈：計畫 → 模擬 → 執行

**先做 Base**（切斷 keeper 中繼來源被操控的路徑），再做 Sepolia。

```bash
cd contracts
export ADAPTER_NEW_OWNER=0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585
export ADAPTER_NEW_OWNER_CONFIRM=0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585   # 二次確認，逐字相符

# (a) 計畫：只讀，印出每一筆與目前狀態
FREEZE_CHAIN=base-sepolia forge script script/FreezeLegacyDeployments.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"

# (b) 模擬：不加 --broadcast，不需要私鑰，不會送出任何東西；最後要看到「讀回完成」
FREEZE_CHAIN=base-sepolia FREEZE_EXECUTE=true forge script script/FreezeLegacyDeployments.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --sender 0xE80A81360608C1342e66743F70a00f75d792Eb93

# (c) 執行：私鑰只放在這個 shell 的環境變數，不要寫進檔案、不要出現在指令列
read -rs LEAKED_PRIVATE_KEY && export LEAKED_PRIVATE_KEY
FREEZE_CHAIN=base-sepolia FREEZE_EXECUTE=true FREEZE_CONFIRM=FREEZE-84532 \
  forge script script/FreezeLegacyDeployments.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow

# Sepolia：同樣 (a)(b)(c)，但要 FREEZE_CHAIN=sepolia、FREEZE_CONFIRM=FREEZE-11155111、
# 並加 V2_ADMIN_PROVEN=1（見 §7.0 第 2 步）、--rpc-url "$SEPOLIA_RPC_URL"
unset LEAKED_PRIVATE_KEY
```

- `--slow` 必加：Base 上的外洩地址有 EIP-7702 委派，節點對被委派的帳戶**同一時間只接受 1 筆在途交易**，
  forge 預設批次送出會被拒。`--slow` 逐筆等收據，自然滿足。（Sepolia 外洩地址沒有委派，不需要，但加了無害。）
- 廣播（或 `--resume`）情境下**一律**要求 `FREEZE_CONFIRM=FREEZE-<chainId>`，不論用 `--private-key`／`--account`／`--ledger`
  或環境變數簽署；不符會 `NotConfirmed` 中止。模擬（不加 `--broadcast`）不要求。
- 腳本會檢查私鑰推導出的地址是 `0xE80A…Eb93`，不是就 `KeyMismatch` 中止。
- 腳本是冪等的：已完成的項目顯示 `done` 並跳過，中途失敗可直接重跑。

### 7.4 驗證（按順序，每一條都要通過）

```bash
# 1) 盤點全集讀回 + 事件掃描：**必須帶 LOGS_RPC，且 exit 0、可疑 0**。這是驗收的第一條，不可省略。
cd .. && LOGS_RPC=https://sepolia.gateway.tenderly.co node ops/freeze-legacy/readback.mjs sepolia "$SEPOLIA_RPC_URL"
ADAPTER_NEW_OWNER=$ADAPTER_NEW_OWNER LOGS_RPC=https://base-sepolia.gateway.tenderly.co \
  node ops/freeze-legacy/readback.mjs base-sepolia "$BASE_SEPOLIA_RPC_URL"

# 2) 腳本自己的讀回（含保留清單、impl-slot pin、owner 計畫外即 revert）
cd contracts
FREEZE_CHAIN=sepolia forge script script/FreezeLegacyDeployments.s.sol --sig "verify()" --rpc-url "$SEPOLIA_RPC_URL"
FREEZE_CHAIN=base-sepolia ADAPTER_NEW_OWNER=$ADAPTER_NEW_OWNER \
  forge script script/FreezeLegacyDeployments.s.sol --sig "verify()" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

- **phase 2（8 顆合成代幣）**：上面完成後，8 顆 SyntheticAssetV2 的 admin 此時在 `0x2a58…`（V2_ADMIN）手上。
  確認 readback 的事件掃描「可疑 0」之後，由 **V2_ADMIN 自己的金鑰**對每一顆送 `renounceRole(0x00, 0x2a58…)`，
  讓它們回到無 admin。這一步用 V2_ADMIN 金鑰，不是外洩金鑰。做完再跑一次 readback 確認。
- 另外確認下一次排程的 `price-keeper.yml` 與 `base-sepolia-keeper.yml` 仍是綠的。

### 7.5 失敗時怎麼辦

| 狀況 | 處理 |
|---|---|
| 中途中斷（RPC、nonce、gas） | 直接用同一條指令重跑。已完成的項目會跳過，只送剩下的。 |
| `NotConfirmed(...)` | 廣播但沒給（或給錯）`FREEZE_CONFIRM=FREEZE-<chainId>`。 |
| `V2AdminNotProven()` | Sepolia 執行前沒設 `V2_ADMIN_PROVEN=1`。先做 §7.0 第 2 步證明金鑰可用，再設。 |
| `BadNewOwner(a, why)` | Base 的 `ADAPTER_NEW_OWNER` 是 0、在拒絕清單、或有合約 code（必須是 EOA 或 7702 帳戶）。 |
| `NewOwnerUnconfirmed()` | `ADAPTER_NEW_OWNER_CONFIRM` 與 `ADAPTER_NEW_OWNER` 不相符。 |
| `ImplChanged(...)` | AssetVaultV2 代理的實作 slot 與已知值不符——執行期間（或之前）被換過實作。**停**，查 `Upgraded` 事件。 |
| `FeeRouterNotDisabled(...)` | 0x0c64／0x4cC7 的 `setFeeRouter(0)` 沒生效。重跑；仍失敗代表 owner 已不在外洩地址手上。 |
| `KeepBroken(...)` | 保留清單中的某個角色已不在預期持有人手上（有人先動過）。**停**，查該合約的 `RoleGranted`／`RoleRevoked`，更新腳本的保留清單後再跑。 |
| `OtherAdminMissing(...)` | 要放棄 DEFAULT_ADMIN，但既沒有另一個 admin、計畫中也沒有先授給 V2_ADMIN。**絕對不要繞過**，否則合約會永久無 admin。 |
| `StillHeld(...)` / `UnexpectedOwner(...)`（廣播後） | 有交易沒上鏈、被搶先重新授權、或 owner 落到計畫外地址。重跑一次，再跑帶 `LOGS_RPC` 的 `readback.mjs` 找出對象。 |
| `KeyMismatch` | `LEAKED_PRIVATE_KEY` 不是外洩地址的金鑰。 |
| 計畫中某項顯示 `not-held(skip)` | 該合約的 owner 已是別的地址。腳本不碰它，但 `verify()` 會把計畫外的 owner 當成 `UnexpectedOwner` 失敗；先確認那個地址是否在預期內。 |
| 執行前發現外洩地址已被搶先改了設定（例如改了 adapter 的 feed） | 先執行凍結（停止進一步傷害），再由新 owner 修正設定。 |

## 8. 演練紀錄（2026-10-04，本機 anvil 分叉，未對公開鏈送出任何交易）

| 步驟 | Sepolia（fork ≈ 區塊 11.84M） | Base Sepolia（fork ≈ 區塊 47.66M） |
|---|---|---|
| 守門：M1 | 廣播但不給 `FREEZE_CONFIRM` → `NotConfirmed` 中止 ✓ | — |
| 守門：M3 | 執行但不給 `V2_ADMIN_PROVEN` → `V2AdminNotProven` 中止 ✓ | — |
| 守門：M2 | — | 新 owner = 0／adapter 自己／anvil 帳號／合約 code／未二次確認，五種都被拒 ✓ |
| 計畫 | 68 筆待處理（含 C1 的 2 筆 setFeeRouter(0)、8 代幣各 grant+renounce）、保留清單 15 項、impl pin ✓ | 3 筆待處理、保留清單 1 項、新 owner 0x27C2 |
| 模擬（不廣播） | 68 筆、讀回通過 | 3 筆、讀回通過（`--no-storage-caching`） |
| 分叉廣播（impersonate） | 68 筆全部成功 | 3 筆全部成功，adapter owner → 0x27C2 |
| `verify()` | 通過；impl pin（前後）成立、owner 全部落在計畫內 | 通過 |
| 重跑（冪等） | 0 筆待處理 | 0 筆待處理 |
| 盤點全集讀回（exit 0） | 118 顆合約；外洩地址無任何權限；帶 `LOGS_RPC`：可疑 0 | 80 顆合約；外洩地址無權限（owner 已是 0x27C2） |
| C1 修補 | 凍結後 0x0c64／0x4cC7 `feeRouter()==0`；跟單部位平倉後 freeMargin 維持合理範圍（缺陷觸發前提被移除） | — |
| M4 後門偵測 | 另跑一次：凍結「前」先插入 0xbEEF 後門（grant admin on sBTC 與 AssetVaultV2）→ 腳本 verify 仍過（看不到），但帶 `LOGS_RPC` 的 readback 標出 2 筆可疑、exit 1 ✓ | — |
| 使用者路徑與無誤傷 | 23/23 PASS（§5；keeper 寫 MockOracle 與 GuardedOracle、guardian setPaused 都成功；外洩地址 6 種操作＋ feeRouter 檢查全部符合預期） | 7/7 PASS（新 owner 能 setFeed／setPriceId／setMaxDeviationBps；外洩地址不能；keeper 能寫 Base MockOracle） |

C1 補充：這兩顆 exchange 的會計缺陷觸發前提需要部位處於特定虧損型態；凍結把 `feeRouter` 設為 0，使那段**只在
`feeRouter != 0` 時才執行**的績效費扣減永遠不執行，觸發前提被結構性移除。缺陷的完整重現在內部審查（`scratchpad/w38r/REVIEW.md`），
本公開文件不列手法。
