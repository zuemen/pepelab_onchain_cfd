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

**兩個各自獨立、都足以致命的原因**:

1. CI 使用的 keeper key `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` 在 Base
   Sepolia 上餘額為 0 → 每筆 `updatePrice` 在 gas estimation 就失敗
   (`gas required exceeds allowance (0)`)。
2. 就算加了油也不行:Base Sepolia 的 `MockOracle.owner()` 是舊部署者
   `0xE80A81360608C1342e66743F70a00f75d792Eb93`,而 `updatePrice` 是
   `onlyOwner`。2026-07-27 的角色分離只在 Sepolia 轉移了 MockOracle 所有權。

時間點對得上:sBTC 的最後更新時間換算正好是 2026-07-27,也就是換 key 那天。

**為什麼十天沒人發現**:workflow 每個 `cast send` 後面掛 `|| echo`,失敗被吞掉,
job 依然 success。已修正 —— 現在寫入 0 筆會讓 job 失敗,而且
`.github/workflows/oracle-health.yml` 每 3 小時獨立檢查鏈上事實一次。

## 復原程序

以下需要私鑰,由人工執行。

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

`GuardedOracle.maxPriceAge` 目前是 **3600 秒(1 小時)**,而 GitHub 排程的真實
間隔實測是 **68–169 分鐘**(2026-08-05 的 12 次排程,平均約 90 分鐘;2026-08-06
的實測甚至到 120 分鐘)。也就是說這不是偶發過期,而是**設定值小於實際節奏所導致
的結構性過期** —— 即使 keeper 完全正常運作,GuardedOracle 大部分時間仍然是 stale。

2026-08-06 02:25 UTC 實測:`getPrice` 對 sBTC / sMSFT / sAAPL 全部 revert。

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

病根已由 `agent/keeper/core.ts` 的 `stepTowards` 修掉:超出上限時走到上限邊緣,
下一輪再往前一段,兩三輪就收斂。`keeper/core.test.ts` 用上面這兩組真實數字釘住
這個行為,並斷言每一步都能被合約的 `_deviationExceeded` 接受。

**注意方向不對稱**:合約以「兩者中較小值」為分母,所以向上容許 10%、向下只容許
9.09%。`stepTowards` 刻意複製了這個不對稱公式,以確保它送出的每一步都能被**線上
的舊合約**接受。若日後把 `GuardedOracle` 換成對稱版並以 `AssetVaultV2.setOracle`
遷移,必須同步檢查該函式。

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

- Infura project id `7cdfb4923cee46ed9238a5181e4e9a4d` —— 曾硬編碼在
  `frontend/price_keeper.cjs`,雖已刪檔,仍留在 git 歷史中。請到 Infura
  儀表板刪除該 project 或重置金鑰。**刪除檔案不等於撤銷憑證。**
