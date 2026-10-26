#!/usr/bin/env bash
# forge-broadcast-guard.sh 的自我測試：在自己起的本機 Anvil 上重現「nonce 斷層卡住」與「超過總時長」，確認看門狗會在
# 上限內中止並回傳 124；正常結束時回傳指令自己的結束碼；還沒廣播（編譯中）時不誤判停滯。
#   bash scripts/lib/forge-broadcast-guard.test.sh
# 需要 Foundry（anvil／cast）。只連自己起的本機 Anvil（隨機埠、chainId 31337），只用 Anvil 公開的測試金鑰。
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
for bin in anvil cast; do
  command -v "$bin" >/dev/null || { echo "::error::找不到 ${bin}（請先安裝 Foundry）" >&2; exit 2; }
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forge-broadcast-guard.sh
. "$HERE/forge-broadcast-guard.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/forge-guard-test.XXXXXX")"
PORT=$((20000 + RANDOM % 20000))
RPC="http://127.0.0.1:$PORT"
anvil --port "$PORT" --silent >"$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in $(seq 1 100); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "::error::不是本機鏈，中止" >&2; exit 1; }

PK0=$(cast wallet private-key "test test test test test test test test test test test junk" 0)
ADDR=$(cast wallet address --private-key "$PK0")
DEAD=0x000000000000000000000000000000000000dEaD
fail() { echo "::error::$*" >&2; exit 1; }
pass() { echo "✓ $*"; }

rc=0
FORGE_DEPLOY_POLL=1 forge_broadcast_guarded "$TMP" "$TMP/ok.log" "$RPC" "$ADDR" -- \
  bash -c "cast send $DEAD --value 1 --private-key $PK0 --rpc-url $RPC >/dev/null; exit 3" || rc=$?
[ "$rc" = 3 ] || fail "正常結束應回傳指令自己的結束碼 3（實際 ${rc}）"
pass "正常結束：回傳指令自己的結束碼"

# 送一筆 nonce 跳號的交易（留在 queued、永遠不會被打包），然後像 forge 一樣一直等
START=$SECONDS; rc=0
FORGE_DEPLOY_POLL=1 FORGE_DEPLOY_STALL=5 forge_broadcast_guarded "$TMP" "$TMP/stall.log" "$RPC" "$ADDR" -- \
  bash -c "cast send $DEAD --value 1 --nonce 9 --async --private-key $PK0 --rpc-url $RPC >/dev/null; exec sleep 300" \
  2>"$TMP/stall.err" || rc=$?
[ "$rc" = 124 ] || fail "nonce 斷層卡住時應回傳 124（實際 ${rc}）"
[ $((SECONDS - START)) -lt 60 ] || fail "停滯偵測太慢（$((SECONDS - START)) 秒）"
grep -q "廣播停滯" "$TMP/stall.err" && grep -q '"queued":"0x1"' "$TMP/stall.err" || { cat "$TMP/stall.err"; fail "應印出停滯原因與 txpool_status"; }
pass "nonce 斷層卡住（pending 0、queued 1）：$((SECONDS - START)) 秒內中止，並印出 txpool 狀態"

cast rpc anvil_dropAllTransactions --rpc-url "$RPC" >/dev/null
rc=0
FORGE_DEPLOY_POLL=1 FORGE_DEPLOY_STALL=2 forge_broadcast_guarded "$TMP" "$TMP/compile.log" "$RPC" \
  0x0000000000000000000000000000000000000002 -- sleep 6 2>"$TMP/compile.err" || rc=$?
[ "$rc" = 0 ] || { cat "$TMP/compile.err"; fail "還沒廣播（nonce 0、txpool 空）時不該判定停滯（實際 ${rc}）"; }
pass "還沒廣播（例如編譯中）：不誤判停滯"

START=$SECONDS; rc=0
FORGE_DEPLOY_POLL=1 FORGE_DEPLOY_TIMEOUT=4 forge_broadcast_guarded "$TMP" "$TMP/timeout.log" "$RPC" \
  0x0000000000000000000000000000000000000002 -- sleep 300 2>"$TMP/timeout.err" || rc=$?
[ "$rc" = 124 ] && [ $((SECONDS - START)) -lt 30 ] || fail "超過總時長應在上限附近中止並回傳 124（實際 ${rc}，$((SECONDS - START)) 秒）"
grep -q "FORGE_DEPLOY_TIMEOUT" "$TMP/timeout.err" || fail "應印出逾時原因"
pass "超過總時長：中止並回傳 124"

echo "forge-broadcast-guard: all ok"
