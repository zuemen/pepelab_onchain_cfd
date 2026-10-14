#!/usr/bin/env bash
# 起一條乾淨的本機 Anvil → 部署 → 回放 → 把鏈狀態存成 heroes/out/chain.json → 關閉 Anvil。
#   scripts/heroes-replay.sh [schedule.json]          預設 heroes/out/schedule.json
# PATH 上要有 anvil／forge／cast。開啟 Smart App Control 的 Windows 機器請在 WSL 裡跑，
# 並先 export PATH="$HOME/.foundry/bin:$PATH"。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/heroes/out"
SCHEDULE="${1:-$OUT/schedule.json}"
PORT="${HEROES_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"
# Anvil 預設帳號 0 的私鑰。公開的測試金鑰，只能用在本機鏈。
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

[ -f "$SCHEDULE" ] || { echo "找不到排程 $SCHEDULE（先跑 heroes/build_schedule.py）" >&2; exit 2; }
# 回放在 agent/ 裡執行，相對路徑要先換成絕對路徑
SCHEDULE="$(cd "$(dirname "$SCHEDULE")" && pwd)/$(basename "$SCHEDULE")"
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "$RPC 已經有節點在回應。回放需要一條乾淨的鏈：先關掉它，或設 HEROES_PORT 換埠。" >&2
  exit 2
fi

mkdir -p "$OUT"
rm -f "$OUT/chain.json" "$OUT/events.json"

# 鏈的起始時間設在排程第一天的 12 小時前。不設的話，部署會把區塊時間推到「現在」，
# 之後就無法把時間設回 2024 年（區塊時間只能往前）。
GENESIS="$(node -e "const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(s.days[0].timestamp - 43200)" "$SCHEDULE")"

anvil --port "$PORT" --host 0.0.0.0 --timestamp "$GENESIS" --silent &
ANVIL_PID=$!
# 不論成功失敗都要收掉它。不靠 --dump-state 在結束時寫檔：Windows 上 SIGINT 送不到原生的 anvil.exe，
# `wait` 會一直卡住。鏈狀態改在回放成功後用 anvil_dumpState 主動存。
trap 'kill -9 "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "不是本機鏈，中止" >&2; exit 1; }

# --slow：一筆等上鏈再送下一筆。不加的話 forge 一次送出多筆，每次落在幾個區塊不一定，
# 之後的區塊號碼、base fee 與交易雜湊就不同，兩次回放無法逐筆比對。
(cd "$ROOT/contracts" && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --slow)
(cd "$ROOT/agent" && npx tsx heroes/writeAddresses.ts)
(cd "$ROOT/agent" && HEROES_RPC_URL="$RPC" npx tsx heroes/replay.ts "$SCHEDULE" "$OUT/addresses.json" "$OUT/events.json")

# anvil_dumpState 回傳 gzip 過的鏈狀態（hex），解開後就是 --load-state 讀的 JSON，含歷史區塊與交易收據。
cast rpc anvil_dumpState --rpc-url "$RPC" | node -e "
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => {
    const hex = JSON.parse(s).slice(2);
    require('fs').writeFileSync(process.argv[1], require('zlib').gunzipSync(Buffer.from(hex, 'hex')));
  });" "$OUT/chain.json"
echo "回放完成。鏈狀態：$OUT/chain.json"
