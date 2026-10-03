# Keeper Runbook

## 症狀:交易所對所有資產 revert `StalePrice`

`PerpetualExchange` 的 `_freshPrice` / `_requireFresh` 會在
`block.timestamp > updatedAt + maxPriceAge` 時 revert,而**開倉、平倉、清算三條
路徑都會經過它**。所以喂價一停,不只不能開新倉 —— 已開的倉也關不掉、水下的倉也
清算不了。

用鏈上事實確認,不要看 CI 是不是綠的:

```bash
cd agent && KEEPER_CHAIN=base-sepolia \
  KEEPER_RPC_URL=https://sepolia.base.org \
  KEEPER_ORACLE_ADDRESS=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  KEEPER_EXCHANGE_ADDRESS=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 \
  npx tsx keeper/health.ts
```

## 2026-08-06 的事故:Base Sepolia 停擺 9.5 天

**現象**:11 個資產全部過期(加密 9.5 天、股票 44 天),`maxPriceAge` 為 6 小時,
`liquidatePosition(0)` 模擬回 `StalePrice(sBTC, 1785162620)`(selector
`0xfa53fd94`)。CI 上的 `Base Sepolia Keeper` 連續 10 天回報 success,每次執行
14–33 秒(健康的 Sepolia keeper 是 4–5 分鐘)。

**兩個各自獨立、都足以致命的原因**(事故當下):

1. CI 使用的 keeper key `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` 在 Base
   Sepolia 上餘額為 0 → 每筆 `updatePrice` 在 gas estimation 就失敗
   (`gas required exceeds allowance (0)`)。
2. 就算加了油也不行:Base Sepolia 的 `MockOracle.owner()` 是舊部署者
   `0xE80A81360608C1342e66743F70a00f75d792Eb93`,而 `updatePrice` 是
   `onlyOwner`。2026-07-27 的角色分離只在 Sepolia 轉移了 MockOracle 所有權。

時間點對得上:sBTC 的最後更新時間換算正好是 2026-07-27,也就是換 key 那天。

> ### ✅ 上述兩點都已解決 —— 下面的 Step A/B 是歷史紀錄,不要再跑一次
>
> **2026-08-06 鏈上實測(Base Sepolia)**:
>
> | 項目 | 事故當下 | **現在** |
> |---|---|---|
> | `0x540aECD3…ef17` 餘額 | 0 ETH | **≈0.0499 ETH** |
> | `MockOracle.owner()` | `0xE80A8136…Eb93`(部署者) | **`0x540aECD3…ef17`(keeper)** |
>
> Step A 與 Step B **已經被執行過**。再跑一次 Step B 會 revert(呼叫者已不是
> owner);Step A 則只是多送一次 ETH。保留在下方是為了記錄「當時做了什麼」,
> 以及未來若重新部署 MockOracle 時的參照。**先跑 Step C 確認現況,再決定要不要
> 動 A/B。**
>
> ⚠️ 仍未解決的部分:`PerpetualExchange`、`MockUSDC`、`PepeToken`、
> `InsuranceVault` 的 owner **仍是** `0xE80A8136…Eb93`,而該地址的私鑰在 public
> repo 的 git 歷史中。這是目前最高優先的問題 —— 見
> [`RUNBOOK_KEY_ROTATION.md`](RUNBOOK_KEY_ROTATION.md)。

**為什麼十天沒人發現**:workflow 每個 `cast send` 後面掛 `|| echo`,失敗被吞掉,
job 依然 success。已修正 —— 現在寫入 0 筆會讓 job 失敗,而且
`.github/workflows/oracle-health.yml` 每 3 小時獨立檢查鏈上事實一次。

## 復原程序

以下需要私鑰,由人工執行。**Step A / B 在 2026-08-06 之前已執行完成**(見上方
表格),保留為紀錄與重新部署時的參照;要確認現況請直接跳到 Step C。

**Step A — 給 keeper 加油**(需要部署者 `0xE80A8136…Eb93` 的私鑰)

```bash
cast send 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 \
  --value 0.05ether \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK
```

**Step B — 把 Base Sepolia MockOracle 的所有權轉給 keeper**(同一把私鑰)

```bash
cast send 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  "transferOwnership(address)" 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK
```

**Step C — 驗證(不需要私鑰)**

```bash
cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "owner()(address)" \
  --rpc-url https://sepolia.base.org
cast balance 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 --rpc-url https://sepolia.base.org
```

owner 應為 `0x540aECD3…ef17`,餘額應大於 0。
**2026-08-06 實測即為此結果**(owner = `0x540aECD3…ef17`、餘額 ≈0.0499 ETH),
所以這一步現在是「確認沒有回退」,不是「等待被完成」。

**Step D — 手動觸發 keeper 並確認**

```bash
gh workflow run base-sepolia-keeper.yml
gh run watch
```

然後重跑上面的 health check,應該全部 `ok`。

## 症狀:Sepolia 的 V2 金庫整個不能用

`AssetVaultV2.outstandingValue()` 直接呼叫 `GuardedOracle.getPrice`,而
GuardedOracle 是 fail-closed 的 —— 超過 `maxPriceAge` 就 revert `StalePrice`,
連帶 `reserveRatioBps()` 與 `mint()` 一起壞掉。

(以下是 **Sepolia** 的 GuardedOracle `0x32A1…49A1` 在 2026-08-06 的狀況。**Base** 的
GuardedOracle `0x8E9e…f842` 的 `maxPriceAge` 是 **2592000 秒(30 天)**,2026-09-29 唯讀
核對 —— 兩者不同,不要混用。)

當時 Sepolia `GuardedOracle.maxPriceAge` 是 **3600 秒(1 小時)**,而 GitHub 排程的真實
間隔實測是 **68–169 分鐘**(2026-08-05 的 12 次排程,平均約 90 分鐘;2026-08-06
的實測甚至到 120 分鐘)。也就是說這不是偶發過期,而是**設定值小於實際節奏所導致
的結構性過期** —— 即使 keeper 完全正常運作,GuardedOracle 大部分時間仍然是 stale。

2026-08-06 02:25 UTC 實測:`getPrice` 對 sBTC / sMSFT / sAAPL 全部 revert。

**通則**：GuardedOracle 的 `maxPriceAge` 必須 ≥ keeper 的 `KEEPER_HEARTBEAT` ＋ 排程最大延遲（上面實測約 169 分鐘，取 3 小時）。調高 `KEEPER_HEARTBEAT` 前先核對 oracle 的 `maxPriceAge`；重部署 oracle 時 `RedeployGuardedOracle` 會用 `KEEPER_HEARTBEAT`／`KEEPER_SCHEDULE_SLACK` 檢查這條關係（見 DEPLOY_130_CUTOVER §10）。

**Step E — 把 maxPriceAge 調成符合真實節奏**(需要 admin key
`0x2a588AeA3271B159c9188d95E0d10614711f83e3`)

```bash
# 維持偏離上限 1000 bps 不變，只把 maxPriceAge 從 3600 改成 10800（3 小時），
# 給兩次錯過排程的餘裕。
cast send 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  "setRiskParams(uint256,uint256)" 1000 10800 \
  --rpc-url $SEPOLIA_RPC --private-key $GUARDED_ADMIN_PK
```

驗證(不需要私鑰):

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 "maxPriceAge()(uint256)" --rpc-url $SEPOLIA_RPC
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  "getPrice(bytes32)(uint256,uint256)" $(cast keccak "sAAPL") --rpc-url $SEPOLIA_RPC
```

`maxPriceAge` 應為 10800,`getPrice` 應回值而不是 revert。

**這是放寬,不是修好。** 真正的解法是讓喂價節奏可靠(不依賴 GitHub 排程),
在那之前把門檻設在低於實際節奏的位置,只會讓 V2 長期處於故障狀態而沒有任何
額外的安全收益 —— fail-closed 的價值在於「資料真的舊了就停下來」,不是在於
「因為排程被節流所以停下來」。

## 偏離上限死鎖

`GuardedOracle` 的 `maxDeviationBps` 是每次更新的上限。舊 keeper 每輪都寫**全額
目標價**,所以一旦鏡射落後超過上限,之後每一次嘗試都被 `DeviationTooLarge` 打回,
**永遠追不上**。

2026-08-06 實測的兩個死鎖:

| 資產 | GuardedOracle 存的 | MockOracle 現在 | 差距 | 卡住多久 |
|---|---|---|---|---|
| sBTC | $73,468 | $64,578 | −12.1% | 9.5 天 |
| sMSFT | $389.10 | $487.46 | +25.3% | 4.9 天 |

2026-07-27 的處置是把 `maxDeviationBps` 設成 0、寫完 11 個正確價格、再設回 1000
(見 [ROLE_SEPARATION.md](ROLE_SEPARATION.md))。那修的是症狀。

2026-08-06 曾用 `stepTowards`「超出上限時走到上限邊緣,下一輪再往前一段」解這個
死鎖。**2026-09-29 審查後已移除**:分段逼近會把一個明知不是最佳估計的價格帶著新
的時間戳寫上鏈,任何人都能對著它開倉。現在 keeper 對 GuardedOracle 只寫完整價格
(`core.ts` 的 `planMirror`);鏈上上限不接受時記為 failed、輸出 `::error::`、job
變紅,由人依下一節「價格熔斷」處置。也就是說,死鎖不再被自動「解開」,而是被
**大聲地停住**。

**注意方向不對稱**:合約以「兩者中較小值」為分母,所以向上容許 10%、向下只容許
9.09%。`deviationAccepted` 刻意複製了這個不對稱公式,用來在送出前判斷完整價格
會不會被**線上的舊合約**拒絕。若日後把 `GuardedOracle` 換成對稱版並以
`AssetVaultV2.setOracle` 遷移,必須同步更新該函式。

## 價格熔斷(keeper 拒寫大幅變動)

**語意**:keeper 絕不寫入明知不是最佳估計的價格,只有「寫完整價格」或「不寫」。

**兩顆 oracle 一起寫或一起不寫。** Base 的 GuardedOracle(`0x8E9e…f842`)沒有
`referenceSource`,每次寫入都受 `maxDeviationBps=1000` 限制(向上 10%、向下 9.09%)。
keeper 寫 MockOracle 之前先確認 Guarded 會接受同一個完整價格,所以**有效熔斷門檻 =
min(`KEEPER_BREAKER_DEVIATION`, Guarded 該方向上限)**,實際上是 +10% / −9.09%。

| 情況 | keeper 行為 |
|---|---|
| 變動 ≤ 有效門檻 | 兩顆都寫入同一個完整價格 |
| 變動 > 有效門檻,≥2 個新鮮獨立來源彼此差距 ≤ 2%、方向一致,且 Guarded 接受 | 兩顆都寫入完整的共識價(中位數) |
| 多源確認不通過,**或** Guarded 會拒絕完整價格(即使多源確認通過) | **兩顆都不寫**(熔斷);`::error::`、job 失敗、嘗試停單、開 issue |
| Guarded 讀不到 | 兩顆都不寫(fail-closed);記 failed |
| Guarded 已凍結 | 兩顆都不寫(fail-closed,凍結是 guardian 的決定);列為熔斷 |
| Guarded 沒有此資產 | 只寫 MockOracle,但門檻**仍是** Guarded 上限(不放寬回 20%) |
| Guarded `updatePrice` 的 staticCall 預檢 revert(paused／role／cap／reference) | 兩顆都不寫;列為熔斷 |
| 兩顆價格不一致(例如上一輪 Mock 寫失敗) | 即使價格沒動也走補寫,讓兩顆收斂;超限時訊息寫「兩顆已不一致」 |

**寫入順序**:預檢通過後**先寫 GuardedOracle,成功才寫 MockOracle**。Guarded 有上限、Mock
沒有:Guarded 寫失敗 → Mock 不寫,兩顆仍一致;Mock 寫失敗 → 下一輪的不一致補寫自然補上。

**拒寫不等於停單。** 價格停在舊值,但交易所(`0x827e…124D`)的 `maxPriceAge` 是
**6 小時**(21600,2026-09-29 唯讀核對):在那之前,交易所仍會以已知錯誤的舊價開倉、
平倉、清算。所以拒寫時 keeper(`agent/keeper/protect.ts`):

1. 交易所支援 `setAssetMode` 且 keeper 是 `marketOperator` → 切 ReduceOnly(停止新開倉;
   平倉與清算仍用舊價)。
2. 開 issue「[keeper] Base Sepolia 價格熔斷」(或在已開的那張留言),內文列出第 1 步的
   結果。做不到的部分會寫「交易所將以舊價繼續成交，直到 maxPriceAge（6h）；需人工處置」。

**keeper 不凍結 GuardedOracle。** 2026-09-29 窄複審移除了 keeper 自動 `setAssetFrozen`
的路徑:凍結後下一輪 Mock 的門檻會從 10% 放寬回 20%,保護動作反而開洞。凍結一律由
guardian(人)決定;Guarded 被凍結時 keeper 對 Mock 也拒寫(fail-closed)。

新版 GuardedOracle(2026-10-01 的原始碼,尚未部署)的 guardian 凍結 72 小時後自動失效。失效後
`peek` 的 `frozen` 會回到 false,keeper 下一輪就會恢復對兩顆 oracle 寫價,不需要任何人解除。
凍結的原因如果還沒排除,必須在 72 小時內由 admin 接手(`takeOverAssetFreeze(id)`／`takeOverPause()`,見 KNOWN_LIMITATIONS #27)。

熔斷造成的 ReduceOnly,在被拒寫的那一輪不會解除(放寬階段只處理本輪價格被接受的資產,
見下方「休市」)。之後某一輪價格重新通過所有檢查、市場開盤、報價新鮮時,marketOperator
會自動切回 Active。要人工把關,請 guardian 對該資產再設一次 ReduceOnly(設上 guardian 鎖):
keeper 放寬前會讀 `guardianLocked`,上鎖就略過、只記一行 log,不算失敗;解除由 owner 處理。
**注意:owner 呼叫 `setAssetMode` 時會清掉 guardian 鎖。** owner 自己設的 ReduceOnly 沒有鎖,
開盤後價格通過檢查時會被 keeper 自動放寬;要長期停單,owner 設完後請 guardian 再對該資產設一次
ReduceOnly 上鎖,或由 owner 直接設 Halted(Halted 連平倉都會擋,見 KNOWN_LIMITATIONS #23／#27)。funding crank 會讀
`$RUNNER_TEMP/keeper-refused.txt` 跳過被拒寫的資產(不以已知錯誤的價格結算 funding)。

### 目前做不到停單 —— 建議的授權

2026-09-29 鏈上核對:線上交易所(`0x827e…124D`)**沒有 `setAssetMode`**,所以第 1 步
目前一律記錄為「做不到」,只剩告警。Base GuardedOracle 的 `maxPriceAge` 是 **30 天**
(2592000),金庫在這段時間內也不會自己 fail-closed。

**唯一建議**:完成新交易所 cutover(`contracts/p1-guardian-market-modes`)後,由 owner
`setMarketOperator(0x540aECD37E7A7885824e7b7e996eBddfb842ef17)`。代價:keeper 可在
Active↔ReduceOnly 間切換,碰不到 Halted,也改不了價格。**不建議**授予 keeper
GuardedOracle 的 `GUARDIAN_ROLE`(理由見上)。在 cutover 之前,停單只能靠人工。

**股票只有單一來源(Yahoo)**,所以拆股、財報跳空這類 >20% 的真實變動**一定**會
熔斷,需要人工處置。加密資產有 Pyth relay + CoinGecko + Yahoo(BTC-USD/ETH-USD)
可互相確認,通常會自動通過。

### 處置步驟

1. **看 log / issue**:keeper run 的 `::error::<資產> 偏離 X% 超過熔斷門檻…` 會列出鏈上價、
   來源價與未通過的原因;同一輪會開「[keeper] … 價格熔斷」issue。**先判斷是否需要立刻
   停單**:若 issue 寫「交易所將以舊價繼續成交」,由 owner/guardian 手動處置(例如 owner
   暫停交易所或調低該資產的曝險),不要等 maxPriceAge 自己到期。
2. **獨立核價**:至少兩個人工來源(交易所官網、Nasdaq/NYSE、公司公告)。同時確認
   有沒有公司行動(拆股、合併、下市)與 ticker/幣別是否被 Yahoo 換掉。
3. **依原因處置**:
   - **來源壞了**(換 ticker、幣別、錯資料):不要寫價。修 `agent/keeper/feeds.ts`
     的 `SOURCES`,走一般 PR。修好之前資產維持熔斷,交易所停單是預期結果。
   - **拆股/合併**(單位改變):**不要寫入拆股後價格** —— 既有部位的進場價是舊單位,
     直接寫新價會錯誤清算。先維持熔斷,由 owner 決定:(a) 讓該資產的喂價換算回舊
     單位,或 (b) 公告後結算既有部位,再以新單位重新 seed。決定前不得手動寫價。
   - **真實跳空**(單位不變,例如財報):由 owner 以 `admin-base-sepolia.yml`
     (`updatePrice(bytes32,uint256)`,target = MockOracle)寫入人工核過的價格;
     需第二人覆核 workflow 輸入。寫入後下一輪 keeper 的偏離會回到門檻內,恢復自動。
   - **GuardedOracle 拒絕完整價格**:由 GuardedOracle 的 admin 依 2026-07-27 的做法
     (見 [ROLE_SEPARATION.md](ROLE_SEPARATION.md))暫時調整 `maxDeviationBps`、寫入
     完整價格、再設回原值;三筆交易都要記錄 tx hash。
4. **驗證**:手動觸發 `oracle-health.yml`,確認該資產 `ok`、價格過期 issue 自動關閉;
   「[keeper] 價格熔斷」issue 要連續 4 輪正常、且交易所沒有保護中(ReduceOnly)的資產
   才會自動關 —— ReduceOnly 需人工解除;crank 清單缺失或 funding 延遲超過
   2 × FUNDING_INTERVAL 另有「funding 未結算」issue;
   下一輪 keeper 摘要行 `rejected=0 failed=0`。

## 休市(股票／ETF／黃金):停開倉靠 ReduceOnly,不靠價格過期

**現況(線上交易所 `0x827e…124D`)：休市時仍可對收盤價開新倉。** 休市期間來源報價不動,
但 keeper 每次 heartbeat 仍把收盤價重寫一次;兩顆 oracle 的 `updatedAt` 記的是寫入的區塊
時間,不是來源報價時間,交易所只看 `block.timestamp − updatedAt ≤ maxPriceAge(6h)`。
一般的夜間與週末因此不會過期。2026-10-02 唯讀核對:9/26–27 週末 `sAAPL` 每小時取樣
67 筆中有 65 筆未滿 6 小時,價格全程是週五收盤價。詳見 KNOWN_LIMITATIONS #31。

**為什麼不讓價格自然過期。** `closePosition` 與 `liquidatePosition` 的 `_requireFresh` 和開倉
用同一個 `maxPriceAge`。價格一過期,持倉者出不去、清算也停,所以 keeper 休市時**必須**
照常 heartbeat。

**停開倉的做法:marketOperator 切 ReduceOnly**(`agent/keeper/operator.ts`,預設啟用,
`KEEPER_MARKET_OPERATOR=0` 才關):

| 階段 | 時機 | 只做 | 條件 |
|---|---|---|---|
| 收緊 | 每個資產取價後、寫價前 | Active → ReduceOnly | 股票／ETF:行事曆或 Yahoo 時段說休市,或收盤提前量(預設 3 小時,`KEEPER_CLOSE_LEAD_SEC`)內會收盤;黃金:週五 17:00 到週日 18:00 ET,或提前量內會進入這段,或來源沒給價;任何一類:報價停滯超過 2 小時;沒分類的資產當股票處理 |
| 放寬 | 本輪結束後,只對價格通過所有檢查的資產,每個資產重新取時間 | ReduceOnly → Active | 股票／ETF:有 Yahoo 時段且開盤、行事曆也開盤,且距收盤超過提前量;黃金:不在週末窗口、不在每日休息、提前量內也不會進入週末;報價在 1 小時內;guardian 沒上鎖 |

**收盤提前量 3 小時的理由與代價。** 白天排程實測間隔 68–169 分鐘,9/25 收盤前後兩輪間隔 3.2 小時
(13:23 → 16:35 ET)。沒有提前量時,收盤後到下一輪之間資產仍是 Active。代價:股票只有
09:30–13:00 ET 能開新倉;黃金週五 14:00 ET 後不能開新倉。外部觸發 Worker 部署後可把
`KEEPER_CLOSE_LEAD_SEC` 調到約 2700(45 分鐘)。間隔超過提前量時仍有殘餘窗口(KNOWN_LIMITATIONS #31)。

- 加密資產(sBTC、sETH)兩個階段都不動。
- 黃金每天 17:00–18:00 ET 的一小時休息不切。
- 美股假日:沒有交易所行事曆。前一天收盤時已切 ReduceOnly,假日報價不會更新,放寬條件
  (報價 1 小時內)不成立,所以會維持 ReduceOnly。
- 提早收盤(13:00 ET):靠 Yahoo 時段的收盤時間;Yahoo 沒反映時,約 15:00 ET 由「報價停滯
  2 小時」收緊。
- 交易所沒有 `assetMode`(線上舊合約):探測後略過,並印出
  `::warning::休市中但無法切 ReduceOnly…仍可對收盤價開新倉`。這是已知限制,不算失敗。
- 交易所有 `assetMode` 但 keeper 不是 `marketOperator`:每輪開頭讀一次 `marketOperator()`,
  不是自己就印一條 `::warning::` 並整輪略過,不記 failed。照 DEPLOY_130_CUTOVER 第 6 步設定
  `setMarketOperator`,或設 `KEEPER_MARKET_OPERATOR=0` 關閉。
- `marketOperator()` 讀取失敗(RPC 問題)時重試一次;仍失敗就照樣收緊(送出前的預檢會擋掉沒有
  權限的情況,被拒只記 `::warning::`、不記 failed),只略過放寬。收緊階段讀不到某資產的
  `assetMode` 則記 failed(該資產這一輪可能該停開倉卻沒停)。
- 租戶 workflow 有 `FUNDING_SYMBOLS` 時,只切換這些已註冊的資產。
- 熔斷 issue 的「保護中」只算熔斷或 guardian 造成的(guardian 上鎖、Halted、或不是休市卻
  ReduceOnly)。休市造成的 ReduceOnly 另列「休市中」,不擋 issue 關閉。
- 本輪有交易等確認逾時(狀態未知)時,後面資產的收緊與所有放寬都不送;結尾會印出此刻
  休市、但可能還沒切 ReduceOnly 的資產。

## 已知未解:單一資產可能無聲漏掉一輪

2026-08-06 02:57 UTC 的健康檢查在**看起來健康的 Sepolia** 上抓到:10 個資產
age 2.1 小時,但 sETH 是 3.5 小時 —— 它在 00:53 那一輪漏掉了。CI log:

```
sETH: real=$1908.36  oracle 190993000000 -> 190836000000
sETH: updatePrice 失敗(權限或價格防護),略過
```

來源正常、價格正常(−0.08% 的微小變動)、同一把金鑰在同一輪成功寫了其他 10 個
資產。**根因無法判定,因為舊 workflow 用 `>/dev/null 2>&1` 把 revert 原文丟掉了**,
只留下一句猜測性的「權限或價格防護」。

新的 `agent/keeper/run.ts` 會把 `MockOracle ✗ <原始錯誤訊息>` 印出來,所以下一次
發生時可以直接判定。在拿到真正的錯誤訊息之前不加重試邏輯 —— 對一個還不知道
原因的問題加重試,只是把它藏得更深。

這件事本身也說明了為什麼要有 `oracle-health.yml`:CI 當時是綠的。

## 替代方案(若不想轉移所有權)

把 GitHub secret `KEEPER_PRIVATE_KEY` 改回部署者的私鑰。這樣 Base Sepolia 會立刻
恢復,但代價是回到「一把 key 同時持有資金與所有角色」,也就是 2026-07-27 角色分離
要解決的問題。轉移所有權才是與該次決定一致的做法。

## 為什麼股票在事故期間沒有被寫壞

Base 版 workflow 缺少 Sepolia 版的非數值防護,stooq 的 HTML 404 會被 `awk` 強制
轉成 0,理論上會寫 `updatePrice(key, 0)`。沒有寫壞是因為 `MockOracle` 自己拒收 0
(`InvalidPrice`)—— 那是意外,不是控制。`agent/keeper/core.ts` 的
`parseFeedValue` 才是控制,而且 `keeper/feeds.test.ts` 直接拿真實的 stooq 404
HTML 當測資釘住它。

## 待輪替的憑證

### 1. Infura project id `7cdfb4923cee46ed9238a5181e4e9a4d` —— **尚未作廢**

這一節先前寫「雖已刪檔,仍留在 git 歷史中」,**低估了實際情況**:2026-08-06 稽核
時它不只在歷史裡,連 **HEAD 的被追蹤檔案** `frontend/check_all_pepe_balances.cjs:3`
都還硬編碼著它(master 另有 `frontend/price_keeper.cjs:49`)。

**現況(本次稽核後)**:

- ✅ 已從 HEAD 移除 —— `frontend/check_all_pepe_balances.cjs` 已刪除(它是零引用的
  死碼:全 repo 沒有任何檔案、script 或 workflow 參照它,且指向已凍結的 Sepolia
  位址)。`frontend/price_keeper.cjs` 在本分支早已刪除。
- ❌ **歷史仍可達,token 仍然有效** —— repo 是 PUBLIC,任何人都能從舊 commit 取出。
- **待辦(必須人工執行)**:到 Infura 儀表板**刪除該 project 或重置金鑰**。

> **刪除檔案不等於撤銷憑證。** 這一節先前的措辭正是讓這件事被擱置的原因 ——
> 「已刪檔」讀起來像是已經處理完了。

### 2. Deployer / owner 私鑰 `0xE80A8136…Eb93` —— **P0,最高優先**

私鑰本體在 public repo 的 git 歷史中(commits `1d8536e` / `e912bff` / `cf712ec`),
而該地址目前仍是四個合約的 owner、x402 的 payTo、以及 demo session 的 user。

完整的輪替步驟書:[`RUNBOOK_KEY_ROTATION.md`](RUNBOOK_KEY_ROTATION.md)。
