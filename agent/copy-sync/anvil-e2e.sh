#!/usr/bin/env bash
# 跟單自動同步執行者的本機端對端驗證（ADR-024）：真的合約、真的 Anvil、真的 copy-sync CLI。
#
#   cd agent && bash copy-sync/anvil-e2e.sh
#
# 需要 Foundry（anvil／forge／cast）。只連自己起的本機 Anvil（隨機埠、chainId 31337），只用 Anvil 公開的測試金鑰；
# forge 的 out／cache／broadcast 都放暫存目錄，不動 repo 裡的 contracts/out 與 broadcast 紀錄。
# 第一次編譯 DeployLocalDemo 需要幾分鐘（via_ir）。部署加 --slow，並由 scripts/lib/forge-broadcast-guard.sh 看門：
# 廣播停滯 90 秒或總時長超過 20 分鐘就印出 txpool 狀態後失敗（FORGE_DEPLOY_STALL／FORGE_DEPLOY_TIMEOUT 可調）。
#
# 不讀 agent/.env：copy-sync CLI 平常一啟動就會載入它，這裡設 AGENT_SKIP_DOTENV=1 關掉，並清掉 shell 裡繼承來的
# COPY_SYNC_*——開發者的 .env 或 shell 若有正式的 COPY_SYNC_NOTIFY_WEBHOOK／COPY_SYNC_KEYSTORE，不會被這支腳本用到。
#
# 流程與斷言（v 後面是合約的 versionId，從 0 起算；畫面與執行者日誌從 1 起算，v0 ＝ 第 1 版）：
#   1. DeployLocalDemo（含自動同步版 CopyTracker）；交易者質押、發 v0；跟隨者入金（另存 1000 在交易所當作
#      「其他 freeMargin」）、followTraderAtVersionWithAutoSync（槓桿上限 2、冷卻 1 小時（合約下限 MIN_SYNC_INTERVAL）、
#      小費 0.0001 ETH、油箱 0.01 ETH）。
#   2. 沒有新版 → 不送交易。
#   3. 交易者發 v1（含 5 倍槓桿）→ 冷卻中不送 → Anvil 時間前進 1 小時 → --dry-run 只模擬 → 正式一輪：
#      record 到 v1、油箱扣「執行費×3＋小費」、執行者拿到小費、跟隨者其他的 freeMargin 沒被動用。
#   4. 再跑一輪：冪等，不送交易。
#   5. 交易者發 v2（含需要 KYC 的 sAAPL）、時間再前進 1 小時、跟隨者未 KYC → 被擋（kyc），部位維持 v1。
#   6. 擁有者替跟隨者 KYC → personal 模式（--followers）同步到 v2。
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
for bin in anvil forge cast; do
  command -v "$bin" >/dev/null || { echo "::error::找不到 ${bin}（請先安裝 Foundry）"; exit 1; }
done

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$(cd "$AGENT_DIR/../contracts" && pwd)"
# shellcheck source=../../scripts/lib/forge-broadcast-guard.sh
. "$AGENT_DIR/../scripts/lib/forge-broadcast-guard.sh"

export AGENT_SKIP_DOTENV=1
for v in $(compgen -e | grep '^COPY_SYNC_' || true); do unset "$v"; done
TMP="$(mktemp -d "${TMPDIR:-/tmp}/copy-sync-e2e.XXXXXX")"
PORT="${E2E_ANVIL_PORT:-$((20000 + RANDOM % 20000))}"
RPC="http://127.0.0.1:$PORT"
ANVIL_PID=""
cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "::error::$*"; exit 1; }
pass() { echo "✓ $*"; }

anvil --port "$PORT" --silent >"$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || fail "Anvil 沒有起來"

MN="test test test test test test test test test test test junk"
PK0=$(cast wallet private-key "$MN" 0)
TRADER_PK=$(cast wallet private-key "$MN" 5); TRADER=$(cast wallet address --private-key "$TRADER_PK")
FOL_PK=$(cast wallet private-key "$MN" 6);    FOL=$(cast wallet address --private-key "$FOL_PK")
EXEC_PK=$(cast wallet private-key "$MN" 8);   EXEC=$(cast wallet address --private-key "$EXEC_PK")

echo "部署 DeployLocalDemo（第一次編譯需要幾分鐘）…"
# --slow：一筆上鏈再送下一筆（比照 scripts/heroes-replay.sh）。不加時 forge 一次預派多筆，曾在 txpool 留下 nonce 斷層卡死。
forge_broadcast_guarded "$CONTRACTS_DIR" "$TMP/deploy.log" "$RPC" "$(cast wallet address --private-key "$PK0")" -- \
  env FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" FOUNDRY_BROADCAST="$TMP/broadcast" \
  forge script script/DeployLocalDemo.s.sol:DeployLocalDemo --rpc-url "$RPC" --private-key "$PK0" --broadcast --slow \
  || { tail -20 "$TMP/deploy.log"; fail "DeployLocalDemo 失敗"; }
OUT=$(cat "$TMP/deploy.log")
EX=$(echo "$OUT" | awk '/DeployLocalDemo: exchange/{print $3}')
CT=$(echo "$OUT" | awk '/DeployLocalDemo: copyTracker/{print $3}')
[ -n "$CT" ] || fail "讀不到 copyTracker 位址"
REG=$(cast call "$CT" "registry()(address)" --rpc-url "$RPC")
USDC=$(cast call "$CT" "usdc()(address)" --rpc-url "$RPC")
STAKE=$(cast call "$CT" "traderStake()(address)" --rpc-url "$RPC")
KYC=$(cast call "$EX" "kyc()(address)" --rpc-url "$RPC")
pass "部署完成：tracker=$CT"

s() { cast send "$@" --rpc-url "$RPC" >/dev/null; }
E18=000000000000000000
strategy() { # 三個資產（MIN_ALLOCATION_ASSETS = 3）
  s "$REG" "publishStrategy((bytes32,uint256,bool,uint256)[])" "$1" --private-key "$TRADER_PK"
}
version() { cast call "$CT" "getCopyRecords(address)((address,uint256,uint256,uint256[],uint256,bool,uint256)[])" "$FOL" --rpc-url "$RPC" | sed -E 's/^\[\([^,]+, ([0-9]+),.*/\1/'; }
gas_tank() { cast call "$CT" "syncGasBalance(address)(uint256)" "$FOL" --rpc-url "$RPC" | awk '{print $1}'; }
free_margin() { cast call "$EX" "freeMargin(address)(uint256)" "$FOL" --rpc-url "$RPC" | awk '{print $1}'; }

s "$USDC" "mint(address,uint256)" "$TRADER" "1000$E18" --private-key "$PK0"
s "$USDC" "approve(address,uint256)" "$STAKE" "1000$E18" --private-key "$TRADER_PK"
s "$STAKE" "stake(uint256)" "100$E18" --private-key "$TRADER_PK"
s "$REG" "registerTrader(string)" "E2E Trader" --private-key "$TRADER_PK"
strategy "[($(cast keccak sBTC),4000,true,2),($(cast keccak sETH),3000,true,2),($(cast keccak sGOLD),3000,true,1)]"

s "$USDC" "mint(address,uint256)" "$FOL" "2000$E18" --private-key "$PK0"
s "$USDC" "approve(address,uint256)" "$EX" "1000$E18" --private-key "$FOL_PK"
s "$EX" "depositMargin(uint256)" "1000$E18" --private-key "$FOL_PK"
s "$USDC" "approve(address,uint256)" "$CT" "1000$E18" --private-key "$FOL_PK"
# 最後一個參數：跟隨者簽名同意的每腿執行費上限（maxExecFeePerLeg）＝ 送出前讀到的 executionFee
FEE0=$(cast call "$EX" "executionFee()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
s "$CT" "followTraderAtVersionWithAutoSync(address,uint256,uint256,uint8,uint32,uint96,uint256)" "$TRADER" "500$E18" 0 2 3600 100000000000000 "$FEE0" \
  --value 0.01ether --private-key "$FOL_PK"
[ "$(version)" = "0" ] || fail "跟單後應在 v0"
pass "跟單＋開啟自動同步（一筆交易）"

STATE="$TMP/state.json"
run() { (cd "$AGENT_DIR" && COPY_SYNC_RPC_URL="$RPC" npx tsx copy-sync/src/run.ts --once --tracker "$CT" --state-file "$STATE" "$@"); }

COPY_SYNC_PRIVATE_KEY="$EXEC_PK" run --from-block 0 >"$TMP/r1.log" 2>&1 || { cat "$TMP/r1.log"; fail "第一輪失敗"; }
grep -q "sent=0" "$TMP/r1.log" || { cat "$TMP/r1.log"; fail "沒有新版時不該送交易"; }
pass "沒有新版 → 不送交易"

strategy "[($(cast keccak sETH),4000,false,5),($(cast keccak sBTC),3000,true,1),($(cast keccak sGOLD),3000,true,2)]"
COPY_SYNC_PRIVATE_KEY="$EXEC_PK" run >"$TMP/cd.log" 2>&1 || { cat "$TMP/cd.log"; fail "冷卻那一輪失敗"; }
grep -q "sent=0" "$TMP/cd.log" || { cat "$TMP/cd.log"; fail "冷卻中不該送交易"; }
[ "$(version)" = "0" ] || fail "冷卻中部位應維持 v0"
pass "冷卻中（跟單後 1 小時內）→ 不送交易"
# 本機鏈時間前進 1 小時（MIN_SYNC_INTERVAL）。DeployLocalDemo 的報價有效期是 7 天，不必刷新價格。
warp_hour() { cast rpc evm_increaseTime 3601 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; }
warp_hour
run --dry-run >"$TMP/dry.log" 2>&1 || { cat "$TMP/dry.log"; fail "dry-run 失敗"; }
grep -q "\[dry-run\] 模擬成功：v1 → v2（versionId 0 → 1）" "$TMP/dry.log" || { cat "$TMP/dry.log"; fail "dry-run 應模擬成功"; }
[ "$(version)" = "0" ] || fail "dry-run 不該改變部位"
pass "dry-run：模擬成功、不送交易"

TANK0=$(gas_tank); FREE0=$(free_margin)
COPY_SYNC_PRIVATE_KEY="$EXEC_PK" run >"$TMP/r2.log" 2>&1 || { cat "$TMP/r2.log"; fail "同步那一輪失敗"; }
grep -q "已同步 v1 → v2（versionId 0 → 1）" "$TMP/r2.log" || { cat "$TMP/r2.log"; fail "應同步到 v2（versionId 1）"; }
[ "$(version)" = "1" ] || fail "record 應在 v1"
FEE=$(cast call "$EX" "executionFee()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
TANK1=$(gas_tank)
[ "$(python3 -c "print($TANK0 - $TANK1)")" = "$(python3 -c "print($FEE * 3 + 100000000000000)")" ] \
  || fail "油箱應扣 執行費×3＋小費（$TANK0 → ${TANK1}）"
# 只用這次平倉釋出的保證金：其他 freeMargin 不能減少（手續費緩衝的零頭會留在 freeMargin，所以可能略增）。
[ "$(python3 -c "print(int($(free_margin) >= $FREE0))")" = "1" ] || fail "跟隨者其他的 freeMargin 不該被動用（$FREE0 → $(free_margin)）"
pass "交易者發新版 → 執行者同步到 v2（versionId 1）；油箱扣執行費×腿數＋小費；其他 freeMargin 不動"

COPY_SYNC_PRIVATE_KEY="$EXEC_PK" run >"$TMP/r3.log" 2>&1 || { cat "$TMP/r3.log"; fail "冪等那一輪失敗"; }
grep -q "sent=0" "$TMP/r3.log" || { cat "$TMP/r3.log"; fail "已是最新版時不該再送"; }
pass "冪等：已是最新版就不送"

strategy "[($(cast keccak sBTC),4000,true,1),($(cast keccak sETH),3000,true,1),($(cast keccak sAAPL),3000,true,1)]"
warp_hour
COPY_SYNC_PRIVATE_KEY="$EXEC_PK" run >"$TMP/r4.log" 2>&1 || { cat "$TMP/r4.log"; fail "KYC 那一輪失敗"; }
grep -q "NotKycVerified" "$TMP/r4.log" || { cat "$TMP/r4.log"; fail "應被 KYC 擋下"; }
[ "$(version)" = "1" ] || fail "被擋時部位應維持 v1"
pass "新版含 RWA、跟隨者未 KYC → 整筆被擋、部位維持舊版"

s "$KYC" "batchVerify(address[])" "[$FOL]" --private-key "$PK0"
PSTATE="$TMP/personal.json"
(cd "$AGENT_DIR" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$EXEC_PK" npx tsx copy-sync/src/run.ts --once \
  --tracker "$CT" --state-file "$PSTATE" --from-block 0 --followers "$FOL") >"$TMP/r5.log" 2>&1 || { cat "$TMP/r5.log"; fail "personal 模式失敗"; }
[ "$(version)" = "2" ] || { cat "$TMP/r5.log"; fail "KYC 後 personal 模式應同步到 v2"; }
pass "KYC 後，跟隨者自己的 agent（personal 模式）同步到 v3（versionId 2）"

(cd "$AGENT_DIR" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$FOL_PK" npx tsx copy-sync/src/run.ts --once \
  --tracker "$CT" --state-file "$TMP/self.json" --followers "$FOL") >"$TMP/r6.log" 2>&1 && fail "執行者金鑰等於跟隨者時應拒絕啟動"
grep -q "就是你要服務的跟隨者" "$TMP/r6.log" || { cat "$TMP/r6.log"; fail "拒絕理由不對"; }
pass "把跟隨者的私鑰當執行者金鑰 → 拒絕啟動"

echo "copy-sync anvil e2e: all ok"
