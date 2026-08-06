# Keeper Runbook

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

## 待輪替的憑證

- Infura project id `7cdfb4923cee46ed9238a5181e4e9a4d` —— 曾硬編碼在
  `frontend/price_keeper.cjs`,雖已刪檔,仍留在 git 歷史中。請到 Infura
  儀表板刪除該 project 或重置金鑰。**刪除檔案不等於撤銷憑證。**
