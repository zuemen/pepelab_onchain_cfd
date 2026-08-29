# 正式站健康檢查

這個系統有兩個會隨時間自己壞掉的地方，兩個都不會報錯，只會在畫面上表現成「東西不見了」。
要展示、驗收或交付之前先跑一遍：

1. **Oracle 價格超過 6 小時**（`PerpetualExchange.maxPriceAge = 21600`）→ 開倉與平倉一律
   revert `StalePrice`，`/exchange` 與 `/terminal` 會擋住下單，錯誤訊息只說「價格過期」。
2. **平倉資料滑出 7 天視窗** → `/marketplace` 的領獎台變空，顯示「還沒有交易者平倉滿 5 筆」。
   這是設計上的正確行為（TraderScore 要求視窗內平倉 ≥ 5 筆），不是 bug。

正式站：<https://pepelab-onchain-cfd.vercel.app>　鏈：Base Sepolia (84532)

---

## 1. Oracle 新鮮度

```bash
cd ~/pepelab_onchain_cfd
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . agent/.env; set +a
NOW=$(date +%s)
for n in sBTC sETH sGOLD sBOND sAAPL sTSLA; do
  H=$(cast keccak "$n")
  cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "getPrice(bytes32)(uint256,uint256)" "$H" \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" > /tmp/p.txt
  U=$(sed -n 2p /tmp/p.txt | sed 's/ .*//')
  echo "$n age_h=$(( (NOW - U) / 3600 ))"
done
```

六個資產的 `age_h` 都要 **< 6**。

超過的話 keeper 停了：到 GitHub Actions 手動觸發 **Base Sepolia Keeper** workflow，
或本機跑 `npm run keeper -w keeper`（需要 `KEEPER_PRIVATE_KEY`）。

## 2. 領獎台資格

領獎台只收「視窗內平倉 ≥ 5 筆」的交易者。先看視窗涵蓋到哪：

```bash
HEAD=$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL")
echo "head=$HEAD  7 天視窗起點=$((HEAD - 302400))"
```

再數三位 demo 交易者在視窗內的平倉筆數（`PositionClosed` 的 topic0 是
`0x7a0db93f...`，owner 在 topics[2]）：

```bash
python - <<'PY'
import json, subprocess, os
rpc = os.environ["BASE_SEPOLIA_RPC_URL"]
EX  = "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072"
T0  = "0x7a0db93fde80eea902af70e15fa590136ec8ea44fbc9de1a71175446513213f5"
names = {
    "0x91ade4824386af80ed003b9363f54731a2ec24ef": "ESG Master",
    "0x95d16653aa0993ed994c81d8be1409dfc06c9ec3": "Tesla Maxi",
    "0x5def0dffa97da7636064172c1c419002d1c1fdd4": "Macro Trader",
}
head = int(subprocess.check_output(["cast", "block-number", "--rpc-url", rpc]).strip())
logs = json.loads(subprocess.check_output([
    "cast", "logs", "--from-block", str(head - 9000), "--to-block", str(head),
    "--address", EX, T0, "--rpc-url", rpc, "--json",
]))
for addr, name in names.items():
    mine = [l for l in logs if l["topics"][2][-40:].lower() == addr[2:]]
    pnls = []
    for l in mine:
        raw = int(l["data"][2:][:64], 16)
        if raw >= 2**255:
            raw -= 2**256
        pnls.append(raw / 1e18)
    wins = sum(1 for p in pnls if p > 0)
    ok = "OK" if len(pnls) >= 5 else "不足"
    print(f"{name:13s} closes={len(pnls)} wins={wins} pnl={sum(pnls):+.2f} USDC  [{ok}]")
PY
```

三位都要 `closes >= 5`。

上面掃的是最近 9,000 塊（約 5 小時），只夠確認「剛剛補種的有沒有進去」。要看
**前端實際使用的完整 7 天視窗**，把 `head - 9000` 改成 `head - 302400`——
`agent/.env` 裡的私有 RPC 單次就吃得下這個範圍（實測 15 筆、一次回完）；
若改用公開端點 `https://sepolia.base.org`，超過上限時要像前端那樣分段查詢
（`frontend/src/lib/pepefi/chainLogs.ts` 的 `CHUNK_SIZE = 9,900`）。

不足的話補種——需要 `contracts/.env.roles` 裡的 `SEED_MNEMONIC` 與 `KEEPER_PK`：

```bash
cd contracts
set -a; . ./.env.roles; . ../agent/.env; set +a
export ORACLE_OWNER_PK="$KEEPER_PK"
export EXCHANGE_ADDR=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
export USDC_ADDR=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
export ORACLE_ADDR=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3
forge script script/SeedWhaleCloses.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv              # 先模擬
forge script script/SeedWhaleCloses.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow -vv
```

約 36 筆交易、90 秒。腳本可重複執行：已平倉的 id 會被算成「沒落地」而不是中斷整批，
不足的筆數會用新開的部位補上。**跑之前先確認第 1 節的 oracle 是新鮮的**，否則開平倉都會 revert。

## 3. 三頁抽查

| 頁面 | 要看到 |
|---|---|
| `/` | 第一張功能卡是「代幣化 RWA 現貨」；幣股金債四個指數有數字；tagline 沒有 MemeFi |
| `/marketplace` | 載入時有「掃描鏈上事件… N/31」（約 12 秒）；領獎台三位；頁尾寫約 7 天而不是 27 小時 |
| `/exchange` | **看不到任何槓桿倍數按鈕**；「Get Test Tokens」卡在；儲備率有數字 |

頁尾那行字是分辨新舊版前端最快的方法：舊版寫死「~50,000 個區塊（約 7 天）」，
新版印的是實際掃描量與換算後的時間。

## 4. 對外說明時容易講錯的三個點

- **兩種 USDC 不要混。** 平台保證金畫面上叫 `USDC`（合約 symbol 也是 `USDC`，
  `name()` 是 `Mock USD Coin`）；x402 付費用的是 **Circle USDC**，是不同地址的真代幣。
  講 x402 時「Circle」不可省略——省略會讓人以為水龍頭領的測試幣可以拿去付真錢的 API。
  規則寫在 `frontend/src/lib/pepefi/tokenLabel.ts`（ADR-0002 規則 1）。
- **K 線的報價來源是 Coinbase BTC-USD 現貨**，Bybit 永續只是 fallback。
  出處會直接標在圖表下方，說錯會被對照出來。
- **為什麼預設沒有槓桿。**《虛擬資產服務法》2026/6/30 三讀通過：母法規範托管型服務，
  **衍生性商品未納入主文**（金管會以附帶決議要求一年內提出辦法與時程），而**股票代幣與
  RWA 在現行架構下保留發展空間**。所以「先做現貨、把槓桿收起來」是主動的合規判斷，
  不是功能沒做完。槓桿本身沒有被刪掉，是 `VITE_SHOW_LEVERAGE` 旗標控制的（預設關），
  合約完全沒動。

## 5. 已知的、刻意不修的事

- 已部署的 MockUSDC 實例鏈上 symbol 仍是 `mUSDC`；原始碼已改成 `USDC`，但要重新部署
  整套才會生效（會清掉現有餘額與部位）。畫面一律顯示 `USDC`，只有進 BaseScan 或把代幣
  加進錢包才看得到差異。
- 線上 `PerpetualExchange`（`0xEf75…c072`）比 `src/` 舊：它的 `getUserPositions` 是
  append-only，平倉後 id 仍留在陣列裡。讀這個回傳值判斷「未平倉數」會得到錯的答案——
  `SeedWhaleCloses.s.sol` 因此改成數「成功平倉幾筆」。
