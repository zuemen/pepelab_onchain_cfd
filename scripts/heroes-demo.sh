#!/usr/bin/env bash
# 本機展示：載入回放好的鏈狀態、把鏈的時間對到現在、持續寫入即時價格。
#   scripts/heroes-demo.sh
# 按 Ctrl-C 結束。這裡不存狀態：每次啟動都回到回放剛結束的樣子，展示可以重複做。
# PATH 上要有 anvil／cast。開啟 Smart App Control 的 Windows 機器請在 WSL 裡跑，
# 並先 export PATH="$HOME/.foundry/bin:$PATH"。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/heroes/out/chain.json"
ADDRESSES="$ROOT/heroes/out/addresses.json"
PORT="${HEROES_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"

[ -f "$STATE" ] && [ -f "$ADDRESSES" ] || { echo "找不到鏈狀態：先跑 scripts/heroes-replay.sh（見 heroes/README.md）" >&2; exit 2; }
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "$RPC 已經有節點在回應，先關掉它，或設 HEROES_PORT 換埠。" >&2
  exit 2
fi

anvil --port "$PORT" --host 0.0.0.0 --load-state "$STATE" --silent &
ANVIL_PID=$!
TICK_PID=""
cleanup() {
  [ -n "$TICK_PID" ] && kill "$TICK_PID" 2>/dev/null || true
  kill -INT "$ANVIL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "不是本機鏈，中止" >&2; exit 1; }

# 載入的狀態停在回放的最後一天。把下一個區塊的時間設成現在，畫面上的「多久以前」與
# 報價新鮮度才會是對的。
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$RPC" >/dev/null

(cd "$ROOT/agent" && HEROES_RPC_URL="$RPC" npx tsx heroes/priceTick.ts "$ADDRESSES") &
TICK_PID=$!

cat <<EOF

本機鏈已啟動：$RPC（chain ID 31337，區塊 $(cast block-number --rpc-url "$RPC")）
價格每分鐘寫入一次。

下一步：
  1. 另開終端機：cd frontend && yarn dev --mode heroes
  2. 錢包新增網路：RPC $RPC、chain ID 31337、幣別 ETH
  3. 匯入展示帳號：Anvil 預設帳號 (9)。私鑰用這個指令看（公開的測試金鑰，只能用在本機鏈）：
       anvil --port 8599 | grep -A 12 "Private Keys"     # 列出來的第 (9) 把；看完按 Ctrl-C
  4. 錢包若之前連過本機鏈：清除該帳號的活動紀錄（nonce 快取），否則第一筆交易會卡住。
  5. 前端右上角切到 Expert Mode，開 /marketplace

按 Ctrl-C 結束。
EOF

wait "$ANVIL_PID"
