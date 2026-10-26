#!/usr/bin/env bash
# 跟單自動同步（ADR-024）本機端對端展示＋驗收：真的合約、真的 Anvil、真的 copy-sync 執行者。
#   scripts/demo-autosync.sh
#
# 一條指令跑完整個故事，每一步都有斷言，任何一步不符就以非零結束（失敗時保留日誌目錄）：
#   1. 起一條乾淨的本機 Anvil（chainId 31337）→ DeployLocalDemo 部署（含自動同步版 CopyTracker）；
#      核對前端 addresses.ts 的 ANVIL 區塊與這次部署相同（不同就照 heroes-replay.sh 的慣例更新）。
#   2. 交易者質押、註冊、發布第 1 版。
#   3. 跟隨者一筆交易完成「跟單＋開啟自動同步＋預存油箱」，再追加存入油箱。
#   4. 交易者發布第 2 版（含 5 倍槓桿）。冷卻中：執行者不送、陌生人呼叫被 SyncCooldown 擋下。
#   5. 時間前進 1 小時 → copy-sync 以 public 模式跑一輪（Anvil 帳號 (8) 當執行者）：部位換成第 2 版、
#      槓桿三者取小、執行者拿到小費、油箱只扣「執行費 × 腿數＋小費」、跟隨者其他的 freeMargin 沒被動用；
#      陌生人再呼叫被 AlreadySynced 擋下，也領不走別人的油箱。
#   6. 交易者發布含 RWA（sAAPL）的第 3 版、跟隨者未 KYC → 執行者模擬失敗、不送交易，webhook 回報原因（kyc），
#      部位一條腿都沒動。KYC 之後、到了重試時間，同一個 public 執行者同步到第 3 版。
#   7. 只讓自己的 agent 同步：跟隨者 setSyncExecutor 指定自己 agent 的熱錢包（Anvil 帳號 (6)）。交易者發第 4 版後，
#      public 執行者不送、陌生人被 NotSyncExecutor 擋下；跟隨者自己的 agent（copy-sync personal 模式）同步成功、拿小費。
#   8. 跟隨者關閉自動同步（之後陌生人被 AutoSyncDisabled 擋下）；交易者再發一版，personal agent 不送交易、只以 webhook
#      通知本人「有新版」（new-version）；沒有任何金鑰的只通知模式（--notify-only）連跑兩次，同一版只通知一次；
#      全額提領油箱：tracker 的 ETH 餘額＝totalSyncGas＝0。
#   9. 金鑰護欄：把跟隨者的私鑰交給執行者程式 → personal、public 模式都拒絕啟動；私鑰誤貼進 --followers → 拒絕且不顯示。
#  10. 由 agent 發起跟單：MCP 工具 prepare_copy_follow_tx 只產生未簽名交易（approve 剛好金額＋
#      followTraderAtVersionWithAutoSync），第二位跟隨者（Anvil 帳號 (4)）用自己的錢包（cast）依序簽名送出；
#      授權足夠後再呼叫一次只剩一筆、並附 eth_call 模擬。驗證紀錄釘在最新版、自動同步設定、同意的執行費、油箱。
#
# 版本號：畫面（Portfolio、動態牆）從 1 起算；合約的 versionId 與執行者日誌從 0 起算——「第 2 版」＝ versionId 1。
#
# 安全：只連這支腳本自己起的本機 Anvil，只用 Anvil 公開的測試金鑰（助記詞 test … junk），不讀任何 .env、
# keystore 或私鑰檔，不對任何公開鏈送交易。copy-sync CLI 平常一啟動就會載入 agent/.env：這裡設 AGENT_SKIP_DOTENV=1
# 關掉，並清掉 shell 裡繼承來的 COPY_SYNC_*（開發者正式的 webhook、keystore 設定不會被用到，負面測試也不會因為
# 「金鑰只能設定一個」這種無關的錯誤而通過）。forge 的 broadcast 紀錄寫到暫存目錄，不動 repo 裡的紀錄；
# 結束時（含失敗、Ctrl-C）一定關掉 Anvil 與本機 webhook。
#
# 部署加 --slow，並由 scripts/lib/forge-broadcast-guard.sh 看門：廣播停滯 90 秒或總時長超過 20 分鐘就印出 txpool
# 狀態後失敗（FORGE_DEPLOY_STALL／FORGE_DEPLOY_TIMEOUT 可調），不靠 CI 的 job 逾時。
#
# 需要：Foundry（anvil／forge／cast）、node，以及 agent/ 已 npm ci。contracts 原始碼改過時，DeployLocalDemo
# 會先重新編譯（via_ir，幾分鐘）。選項（環境變數）：DEMO_AUTOSYNC_PORT（Anvil 埠，預設隨機）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
for bin in anvil forge cast node npx; do
  command -v "$bin" >/dev/null || { echo "::error::找不到 ${bin}（Foundry 與 node 要在 PATH 上）" >&2; exit 2; }
done
[ -d "$ROOT/agent/node_modules" ] || { echo "::error::agent/ 還沒安裝依賴：cd agent && npm ci" >&2; exit 2; }
# shellcheck source=lib/forge-broadcast-guard.sh
. "$ROOT/scripts/lib/forge-broadcast-guard.sh"

export AGENT_SKIP_DOTENV=1
for v in $(compgen -e | grep '^COPY_SYNC_' || true); do unset "$v"; done

PORT="${DEMO_AUTOSYNC_PORT:-$((20000 + RANDOM % 20000))}"
RPC="http://127.0.0.1:$PORT"
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "::error::$RPC 已經有節點在回應；換一個 DEMO_AUTOSYNC_PORT" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/demo-autosync.XXXXXX")"
ANVIL_PID=""
HOOK_PID=""
cleanup() {
  local code=$?
  [ -n "$HOOK_PID" ] && kill "$HOOK_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$code" -eq 0 ]; then rm -rf "$TMP"; else echo "（日誌保留在 ${TMP}）" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step() { printf '\n── %s ──\n' "$*"; }
pass() { printf '  ✓ %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

# 整數運算與比較（wei 超過 2^53，一律用 BigInt）：bn '<運算式>'，運算式裡的十進位整數都當成 BigInt。
bn() { node -p "String($(printf '%s' "$1" | sed -E 's/([0-9]+)/\1n/g'))"; }
# wei → 「1.23」（18 位小數，去掉尾端的 0）
fmt18() { node -p "const v=BigInt(process.argv[1]),s=v<0n?'-':'',a=v<0n?-v:v;s+(a/10n**18n)+((a%10n**18n)?'.'+String(a%10n**18n).padStart(18,'0').replace(/0+\$/,''):'')" "$1"; }
# 從 cast --json 的輸出取值：jget '<JSON>' '<JS 運算式，r 是解析後的值>'
jget() { node -e "const r=JSON.parse(process.argv[1]);const v=($2);console.log(Array.isArray(v)?v.join(' '):String(v))" "$1"; }

c() { cast call "$@" --rpc-url "$RPC"; }
cn() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }   # 數字：去掉 cast 附加的「[1e18]」
s() { cast send "$@" --rpc-url "$RPC" >/dev/null; }

# expect_revert '<錯誤簽章>' <cast call 參數…>：這筆 eth_call 必須以該自訂錯誤 revert；解碼後的參數放在 REVERT_ARGS。
expect_revert() {
  local sig="$1"; shift
  local out data
  if out=$(cast call "$@" --rpc-url "$RPC" 2>&1); then fail "預期 revert ${sig%%(*}，結果成功了"; fi
  data=$(printf '%s' "$out" | sed -nE 's/.*data: "(0x[0-9a-fA-F]*)".*/\1/p' | head -1)
  [ "${data:0:10}" = "$(cast sig "$sig")" ] || fail "預期 revert ${sig%%(*}，實際：$out"
  REVERT_ARGS=$(cast decode-error --sig "$sig" "$data" | awk '{print $1}' | paste -sd, -)
}

# ── 1. 本機鏈與部署 ─────────────────────────────────────────────────────────
step "1. 起本機 Anvil、部署 DeployLocalDemo（含自動同步版 CopyTracker）"
anvil --port "$PORT" --silent >"$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || fail "不是本機鏈（chainId 31337），中止"

MN="test test test test test test test test test test test junk"
key() { cast wallet private-key "$MN" "$1"; }
PK0=$(key 0);          OWNER=$(cast wallet address --private-key "$PK0")
TRADER_PK=$(key 5);    TRADER=$(cast wallet address --private-key "$TRADER_PK")
AGENT_PK=$(key 6);     AGENT=$(cast wallet address --private-key "$AGENT_PK")
STRANGER_PK=$(key 7);  STRANGER=$(cast wallet address --private-key "$STRANGER_PK")
EXEC_PK=$(key 8);      EXEC=$(cast wallet address --private-key "$EXEC_PK")
FOL_PK=$(key 9);       FOL=$(cast wallet address --private-key "$FOL_PK")

# --slow：一筆上鏈再送下一筆（比照 scripts/heroes-replay.sh）。不加時 forge 一次預派多筆，曾在 txpool 留下 nonce 斷層卡死。
forge_broadcast_guarded "$ROOT/contracts" "$TMP/deploy.log" "$RPC" "$OWNER" -- \
  env FOUNDRY_BROADCAST="$TMP/broadcast" forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url "$RPC" --private-key "$PK0" --broadcast --slow \
  || { tail -30 "$TMP/deploy.log"; fail "DeployLocalDemo 失敗"; }
EX=$(awk '/DeployLocalDemo: exchange/{print $3}' "$TMP/deploy.log")
CT=$(awk '/DeployLocalDemo: copyTracker/{print $3}' "$TMP/deploy.log")
[ -n "$EX" ] && [ -n "$CT" ] || fail "讀不到部署位址（$TMP/deploy.log）"
REG=$(c "$CT" "registry()(address)")
USDC=$(c "$CT" "usdc()(address)")
STAKE=$(c "$CT" "traderStake()(address)")
KYC=$(c "$EX" "kyc()(address)")
[ "$(c "$EX" "copyTracker()(address)")" = "$CT" ] || fail "交易所沒有授權這顆 CopyTracker"
MIN_INTERVAL=$(cn "$CT" "MIN_SYNC_INTERVAL()(uint32)")
pass "部署完成：CopyTracker ${CT}（MIN_SYNC_INTERVAL ${MIN_INTERVAL} 秒）、交易所 $EX"

# 前端 31337 位址表：比照 scripts/heroes-replay.sh（agent/heroes/writeAddresses.ts）的慣例，不同才改寫。
ADDR_CHECK=$(cd "$ROOT/agent" && BROADCAST="$TMP/broadcast/DeployLocalDemo.s.sol/31337/run-latest.json" npx tsx --eval '
import { readFileSync, writeFileSync } from "node:fs";
import { addressesFromBroadcast, renderAnvilBlock, replaceAnvilBlock } from "./heroes/addresses.ts";
const file = "../frontend/src/contracts/addresses.ts";
const before = readFileSync(file, "utf8");
const after = replaceAnvilBlock(before, renderAnvilBlock(addressesFromBroadcast(JSON.parse(readFileSync(process.env.BROADCAST!, "utf8")))));
if (after !== before) writeFileSync(file, after);
console.log(after === before ? "unchanged" : "updated");
')
if [ "$ADDR_CHECK" = "unchanged" ]; then
  pass "前端 addresses.ts 的 ANVIL 區塊與這次部署相同（前端連本機鏈時用的就是這些合約）"
else
  pass "前端 addresses.ts 的 ANVIL 區塊已更新為這次部署的位址（與 heroes-replay.sh 相同的慣例；請一併提交）"
fi

E18=000000000000000000
FEE=$(cn "$EX" "executionFee()(uint256)")
TIP=100000000000000          # 0.0001 ETH：跟隨者願意付給第三方執行者的小費
CAP=2                        # 跟隨者自設的槓桿上限
PREFUND=10000000000000000    # 0.01 ETH：跟單時預存進油箱
TOPUP=5000000000000000       # 0.005 ETH：之後追加存入
note "角色（Anvil 公開測試帳號）：交易者 (5) ${TRADER}、跟隨者 (9) ${FOL}、public 執行者 (8) ${EXEC}、跟隨者自己的 agent (6) ${AGENT}、陌生人 (7) ${STRANGER}、擁有者／KYC 審核 (0) $OWNER"
note "交易所 executionFee $(fmt18 "$FEE") ETH／腿"

# 跟隨者第 0 筆跟單（getCopyRecords）：rec_json；欄位 [trader, versionId, initialAmount, positionIds, copiedAt, active, deployedAmount]
rec_json() { cast call "$CT" "getCopyRecords(address)((address,uint256,uint256,uint256[],uint256,bool,uint256)[])" "$FOL" --rpc-url "$RPC" --json; }
rec() { jget "$(rec_json)" "r[0][0][$1]"; }
tank() { cn "$CT" "syncGasBalance(address)(uint256)" "$FOL"; }
invariant() { # tracker 持有的 ETH 必須剛好等於所有油箱的總和
  local bal total
  bal=$(cast balance "$CT" --rpc-url "$RPC"); total=$(cn "$CT" "totalSyncGas()(uint256)")
  [ "$bal" = "$total" ] || fail "不變量破壞：tracker ETH 餘額 $bal ≠ totalSyncGas $total"
}
POS_SIG="getPosition(uint256)((uint256,address,bytes32,bool,uint256,uint256,uint256,uint256,uint256,int256,bool,address,int256,uint16,uint16,uint8))"

# verify_legs "<sym>:<long|short>:<策略槓桿>:<權重>" …：跟單紀錄目前的腿必須逐一等於這一版策略——資產、方向、
# 權重比例，槓桿＝min(策略, 交易所該資產上限, 跟隨者上限 CAP)，copiedFrom＝交易者（績效費照常）。
verify_legs() {
  local ids deployed i=0 spec sym side lev w id p want assetMax
  ids=($(rec 3)); deployed=$(rec 6)
  [ "${#ids[@]}" = "$#" ] || fail "腿數 ${#ids[@]} ≠ 策略 $# 檔"
  for spec in "$@"; do
    IFS=: read -r sym side lev w <<<"$spec"
    id=${ids[$i]}
    p=$(cast call "$EX" "$POS_SIG" "$id" --rpc-url "$RPC" --json)
    assetMax=$(cn "$EX" "maxLeverageForAsset(bytes32)(uint256)" "$(cast keccak "$sym")")
    want=$(bn "[$lev, $assetMax, $CAP].reduce((a, b) => a < b ? a : b)")
    [ "$(jget "$p" 'r[0][2]')" = "$(cast keccak "$sym")" ] || fail "腿 $i 的資產不是 $sym"
    [ "$(jget "$p" 'r[0][3]')" = "$([ "$side" = long ] && echo true || echo false)" ] || fail "腿 ${i}（${sym}）方向不對"
    [ "$(jget "$p" 'r[0][6]')" = "$want" ] || fail "腿 ${i}（${sym}）槓桿 $(jget "$p" 'r[0][6]')×，應為 ${want}×"
    [ "$(jget "$p" 'r[0][10]')" = "true" ] || fail "腿 ${i}（${sym}）沒有開著"
    [ "$(jget "$p" 'r[0][1]').$(jget "$p" 'r[0][11]')" = "$FOL.$TRADER" ] || fail "腿 ${i}（${sym}）的 owner／copiedFrom 不對"
    [ "$(jget "$p" 'r[0][5]')" = "$(bn "$deployed * $w / 10000")" ] || fail "腿 ${i}（${sym}）保證金不等於 deployedAmount × 權重"
    note "#$id $sym $([ "$side" = long ] && echo 多 || echo 空) $((w / 100))%：策略 ${lev}×、交易所上限 ${assetMax}×、跟隨者上限 ${CAP}× → 實際 ${want}×，保證金 $(fmt18 "$(jget "$p" 'r[0][5]')") USDC"
    i=$((i + 1))
  done
}
legs_closed() { # legs_closed <id…>：這些腿都已平倉
  local id
  for id in "$@"; do
    [ "$(jget "$(cast call "$EX" "$POS_SIG" "$id" --rpc-url "$RPC" --json)" 'r[0][10]')" = "false" ] || fail "舊腿 #$id 仍開著"
  done
}
publish() { s "$REG" "publishStrategy((bytes32,uint256,bool,uint256)[])" "$1" --private-key "$TRADER_PK"; }
warp_hour() { cast rpc evm_increaseTime $((MIN_INTERVAL + 1)) --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; }

# ── 本機 webhook：接住執行者的通知（「本人或他的其他 agent」收到的就是這份 JSON）──
node -e '
const fs = require("fs");
const srv = require("http").createServer((q, s) => {
  let b = ""; q.on("data", (d) => (b += d)).on("end", () => { fs.appendFileSync(process.argv[1], b.replace(/\n/g, " ") + "\n"); s.end("ok"); });
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(srv.address().port)));
' "$TMP/webhook.jsonl" "$TMP/webhook.port" &
HOOK_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/webhook.port" ] && break; sleep 0.1; done
[ -s "$TMP/webhook.port" ] || fail "本機 webhook 沒有起來"
HOOK="http://127.0.0.1:$(cat "$TMP/webhook.port")/copy-sync"
touch "$TMP/webhook.jsonl"
# hook_last '<kind>'：最新一則該類通知（JSON）；沒有就空字串
hook_last() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(p=>p.kind===process.argv[2]);console.log(l.length?JSON.stringify(l[l.length-1]):"")' "$TMP/webhook.jsonl" "$1"; }

STATE="$TMP/copy-sync-public.json"
# copy_sync <日誌名> [旗標…]：public 模式（服務所有開了自動同步的人）跑一輪；執行者金鑰是 Anvil 帳號 (8)，
# 明文私鑰只因為這是本機 Anvil 才被允許（公開鏈要用加密 keystore，見 agent/copy-sync/README.md）。
copy_sync() {
  local log="$TMP/$1.log"; shift
  (cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$EXEC_PK" npx tsx copy-sync/src/run.ts \
    --once --mode public --tracker "$CT" --state-file "$STATE" --notify-webhook "$HOOK" "$@") >"$log" 2>&1 \
    || { cat "$log"; fail "copy-sync 這一輪以非零結束（${log}）"; }
  grep -E "head=.* sent=" "$log" | tail -1 | sed -E 's/.*(evaluated=[0-9]+ simulatedOk=[0-9]+ sent=[0-9]+ synced=[0-9]+ blocked=[0-9]+).*/    執行者：\1/'
}
sent_of() { grep -E "head=.* sent=" "$TMP/$1.log" | tail -1 | sed -E 's/.* sent=([0-9]+) .*/\1/'; }
# personal_sync <日誌名> [旗標…]：跟隨者自己的 agent（Anvil 帳號 (6) 當熱錢包）以 personal 模式只服務跟隨者，跑一輪。
personal_sync() {
  local log="$TMP/$1.log"; shift
  (cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$AGENT_PK" npx tsx copy-sync/src/run.ts \
    --once --mode personal --followers "$FOL" --tracker "$CT" --state-file "$TMP/copy-sync-personal.json" \
    --notify-webhook "$HOOK" "$@") >"$log" 2>&1 \
    || { cat "$log"; fail "copy-sync（personal）這一輪以非零結束（${log}）"; }
  grep -E "head=.* sent=" "$log" | tail -1 | sed -E 's/.*(evaluated=[0-9]+ simulatedOk=[0-9]+ sent=[0-9]+ synced=[0-9]+ blocked=[0-9]+).*/    跟隨者的 agent：\1/'
}

# ── 2. 交易者 ───────────────────────────────────────────────────────────────
step "2. 交易者質押、註冊、發布第 1 版"
s "$USDC" "mint(address,uint256)" "$TRADER" "1000$E18" --private-key "$PK0"
s "$USDC" "approve(address,uint256)" "$STAKE" "100$E18" --private-key "$TRADER_PK"
s "$STAKE" "stake(uint256)" "100$E18" --private-key "$TRADER_PK"
s "$REG" "registerTrader(string)" "Demo Trader" --private-key "$TRADER_PK"
V1="[($(cast keccak sBTC),4000,true,1),($(cast keccak sETH),3000,true,2),($(cast keccak sGOLD),3000,true,1)]"
publish "$V1"
[ "$(c "$REG" "isEligibleTrader(address)(bool)" "$TRADER")" = "true" ] || fail "交易者應符合資格"
pass "第 1 版（versionId 0）：sBTC 多 40% 1×、sETH 多 30% 2×、sGOLD 多 30% 1×"

# ── 3. 跟隨者 ───────────────────────────────────────────────────────────────
step "3. 跟隨者一筆交易完成「跟單＋開啟自動同步＋預存油箱」"
s "$USDC" "mint(address,uint256)" "$FOL" "2000$E18" --private-key "$PK0"
# 另外存 1000 USDC 在交易所：這是跟隨者自己的「其他 freeMargin」，同步絕對不能動用它。
s "$USDC" "approve(address,uint256)" "$EX" "1000$E18" --private-key "$FOL_PK"
s "$EX" "depositMargin(uint256)" "1000$E18" --private-key "$FOL_PK"
s "$USDC" "approve(address,uint256)" "$CT" "500$E18" --private-key "$FOL_PK"
[ "$(c "$KYC" "isVerified(address)(bool)" "$FOL")" = "false" ] || fail "展示前提：跟隨者尚未 KYC"
# msg.value＝這次開倉的執行費 × 3 條腿＋預存油箱；最後一個參數是跟隨者簽名同意的每腿執行費上限
#（前端帶入畫面上顯示的 executionFee）。跟隨者的私鑰只在這裡、他自己的錢包裡簽名。
s "$CT" "followTraderAtVersionWithAutoSync(address,uint256,uint256,uint8,uint32,uint96,uint256)" \
  "$TRADER" "500$E18" 0 "$CAP" "$MIN_INTERVAL" "$TIP" "$FEE" \
  --value "$(bn "$FEE * 3 + $PREFUND")" --private-key "$FOL_PK"
[ "$(rec 0).$(rec 1).$(rec 5)" = "$TRADER.0.true" ] || fail "跟單紀錄應指向交易者、versionId 0、active"
verify_legs sBTC:long:1:4000 sETH:long:2:3000 sGOLD:long:1:3000
CFG=$(c "$CT" "syncConfig(address,uint256)(bool,uint8,uint32,uint96)" "$FOL" 0 | awk '{print $1}' | paste -sd, -)
[ "$CFG" = "true,$CAP,$MIN_INTERVAL,$TIP" ] || fail "syncConfig 應為 true,$CAP,$MIN_INTERVAL,${TIP}（實際 ${CFG}）"
[ "$(cn "$CT" "syncExecFeeCap(address,uint256)(uint256)" "$FOL" 0)" = "$FEE" ] || fail "同意的每腿執行費應等於簽名帶入的值"
[ "$(tank)" = "$PREFUND" ] || fail "油箱應剛好是預存的 $PREFUND wei（實際 $(tank)）"
s "$CT" "depositSyncGas()" --value "$TOPUP" --private-key "$FOL_PK"
TANK=$(tank)
[ "$TANK" = "$(bn "$PREFUND + $TOPUP")" ] || fail "追加存入後油箱應為 $(bn "$PREFUND + $TOPUP")"
invariant
COST=$(bn "$FEE * 3 + $TIP")
pass "自動同步已開啟：上限 ${CAP}×、冷卻 $((MIN_INTERVAL / 3600)) 小時、小費 $(fmt18 "$TIP") ETH；油箱 $(fmt18 "$TANK") ETH，約可被代為同步 $(bn "$TANK / $COST") 次"
expect_revert "AlreadySynced(uint256,uint256)" "$CT" "resyncFor(address,uint256)" "$FOL" 0 --from "$STRANGER"
pass "交易者還沒發新版：陌生人呼叫 resyncFor 被 AlreadySynced($REVERT_ARGS) 擋下"

# ── 4. 新版＋冷卻 ───────────────────────────────────────────────────────────
step "4. 交易者發布第 2 版（sETH 5×、sBTC 2×、sGOLD 改空）；冷卻中"
OLD_IDS=($(rec 3))
publish "[($(cast keccak sETH),5000,true,5),($(cast keccak sBTC),3000,true,2),($(cast keccak sGOLD),2000,false,1)]"
PENDING=$(c "$CT" "pendingSync(address,uint256)(bool,uint256,uint256)" "$FOL" 0 | awk '{print $1}' | paste -sd, -)
[ "$PENDING" = "false,1,$COST" ] || fail "冷卻中 pendingSync 應為 false,1,${COST}（實際 ${PENDING}）"
expect_revert "SyncCooldown(uint256)" "$CT" "resyncFor(address,uint256)" "$FOL" 0 --from "$STRANGER"
pass "陌生人呼叫被 SyncCooldown(readyAt=$REVERT_ARGS) 擋下：別人替你同步至少隔你設定的冷卻"
copy_sync round-cooldown --from-block 0
[ "$(sent_of round-cooldown)" = "0" ] && [ "$(rec 1)" = "0" ] || fail "冷卻中執行者不該送交易"
pass "執行者這一輪不送交易（本地讀 syncReadyAt，排到冷卻結束再試）"

# ── 5. 執行者同步 ───────────────────────────────────────────────────────────
step "5. 時間前進 1 小時；copy-sync（public 模式）先 --dry-run、再正式跑一輪"
warp_hour
PENDING=$(c "$CT" "pendingSync(address,uint256)(bool,uint256,uint256)" "$FOL" 0 | awk '{print $1}' | paste -sd, -)
[ "$PENDING" = "true,1,$COST" ] || fail "冷卻結束後 pendingSync 應為 true,1,${COST}（實際 ${PENDING}）"
(cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" npx tsx copy-sync/src/run.ts --once --dry-run --tracker "$CT" --from-block 0) \
  >"$TMP/dry-run.log" 2>&1 || { cat "$TMP/dry-run.log"; fail "dry-run 失敗"; }
grep -q "\[dry-run\] 模擬成功：v1 → v2（versionId 0 → 1）" "$TMP/dry-run.log" && [ "$(rec 1)" = "0" ] \
  || { cat "$TMP/dry-run.log"; fail "dry-run 應只模擬成功、不改變部位"; }
pass "dry-run：不讀任何金鑰、模擬成功、不送交易"

FREE0=$(cn "$EX" "freeMargin(address)(uint256)" "$FOL")
EXEC_BAL0=$(cast balance "$EXEC" --rpc-url "$RPC")
FROM_BLOCK=$(cast block-number --rpc-url "$RPC")
copy_sync round-sync
[ "$(sent_of round-sync)" = "1" ] || { cat "$TMP/round-sync.log"; fail "這一輪應送出一筆 resyncFor"; }
grep -q "已同步 v1 → v2（versionId 0 → 1）" "$TMP/round-sync.log" || { cat "$TMP/round-sync.log"; fail "執行者日誌應出現「已同步 v1 → v2」"; }
[ "$(rec 1)" = "1" ] || fail "跟單紀錄應已在 versionId 1"
legs_closed "${OLD_IDS[@]}"
verify_legs sETH:long:5:5000 sBTC:long:2:3000 sGOLD:short:1:2000
pass "部位已換成第 2 版：舊腿 #${OLD_IDS[*]} 全平、新腿逐一符合策略（sETH 被跟隨者上限夾到 ${CAP}×，sBTC 被交易所上限夾到 1×）"

LOG=$(cast logs --from-block "$FROM_BLOCK" --address "$CT" \
  "Resynced(address indexed,uint256 indexed,address indexed,uint256,uint256,address,uint256,uint256)" --rpc-url "$RPC" --json)
[ "$(jget "$LOG" 'r.length')" = "1" ] || fail "應剛好有一筆 Resynced 事件"
TX=$(jget "$LOG" 'r[0].transactionHash')
EV=($(cast abi-decode --input "x(uint256,uint256,address,uint256,uint256)" "$(jget "$LOG" 'r[0].data')" | awk '{print $1}'))
[ "${EV[0]}.${EV[1]}.${EV[2]}.${EV[4]}" = "0.1.$EXEC.3" ] || fail "Resynced 應為 v0→v1、executor＝執行者、3 條腿（實際 ${EV[*]}）"
RCPT=$(cast receipt "$TX" --rpc-url "$RPC" --json)
GAS_COST=$(bn "$(cast to-dec "$(jget "$RCPT" 'r.gasUsed')") * $(cast to-dec "$(jget "$RCPT" 'r.effectiveGasPrice')")")
EXEC_BAL1=$(cast balance "$EXEC" --rpc-url "$RPC")
[ "$(bn "$EXEC_BAL1 - $EXEC_BAL0 + $GAS_COST")" = "$TIP" ] || fail "執行者應淨收小費 $TIP wei（餘額變化＋gas＝$(bn "$EXEC_BAL1 - $EXEC_BAL0 + $GAS_COST")）"
pass "執行者拿到小費 $(fmt18 "$TIP") ETH（gas 花了 $(fmt18 "$GAS_COST") ETH，自己付）；tx $TX"
[ "$(bn "$TANK - $(tank)")" = "$COST" ] || fail "油箱應剛好扣「執行費×3＋小費」＝${COST}（實際扣 $(bn "$TANK - $(tank)")）"
TANK=$(tank)
invariant
pass "油箱剛好扣「執行費 × 3 條腿＋小費」＝ $(fmt18 "$COST") ETH，剩 $(fmt18 "$TANK") ETH；tracker ETH 餘額＝totalSyncGas"
FREE1=$(cn "$EX" "freeMargin(address)(uint256)" "$FOL")
[ "$(bn "$FREE1 >= $FREE0 && $FREE1 >= 1000$E18")" = "true" ] || fail "跟隨者其他的 freeMargin 不該被動用（$FREE0 → ${FREE1}）"
pass "只重新部署這次平倉釋出的保證金：跟隨者自己存的 1000 USDC freeMargin 沒被動用（$(fmt18 "$FREE0") → $(fmt18 "$FREE1")，零頭是手續費緩衝）"
SYNCST=$(c "$CT" "getSyncState(address,uint256)((uint64,uint32,bool,uint256,int256))" "$FOL" 0 --json)
[ "$(jget "$SYNCST" 'r[0][1]')" = "1" ] || fail "syncCount 應為 1"
HOOK_OK=$(hook_last resynced)
[ -n "$HOOK_OK" ] && [ "$(jget "$HOOK_OK" 'r.toVersion')" = "1" ] || fail "webhook 應收到 resynced 通知"
pass "webhook 收到通知：$(jget "$HOOK_OK" 'r.message')"

expect_revert "AlreadySynced(uint256,uint256)" "$CT" "resyncFor(address,uint256)" "$FOL" 0 --from "$STRANGER"
pass "陌生人再呼叫被 AlreadySynced($REVERT_ARGS) 擋下（同一版不能重放）"
expect_revert "InsufficientSyncGas(uint256,uint256)" "$CT" "withdrawSyncGas(uint256)" 1 --from "$STRANGER"
pass "陌生人提領只扣自己的油箱：InsufficientSyncGas($REVERT_ARGS)，跟隨者的油箱領不走"
copy_sync round-idle
[ "$(sent_of round-idle)" = "0" ] || fail "已是最新版時不該再送"
pass "冪等：再跑一輪，已是最新版就不送"

# ── 6. RWA 原子性 ───────────────────────────────────────────────────────────
step "6. 交易者發布含 RWA（sAAPL）的第 3 版；跟隨者未 KYC"
SYNC_IDS=($(rec 3))
publish "[($(cast keccak sETH),4000,true,1),($(cast keccak sBTC),3000,true,1),($(cast keccak sAAPL),3000,true,1)]"
[ "$(c "$EX" "rwaAsset(bytes32)(bool)" "$(cast keccak sAAPL)")" = "true" ] || fail "展示前提：sAAPL 是需要 KYC 的 RWA"
warp_hour
copy_sync round-kyc
[ "$(sent_of round-kyc)" = "0" ] || fail "模擬失敗時不該送交易"
grep -q "NotKycVerified" "$TMP/round-kyc.log" || { cat "$TMP/round-kyc.log"; fail "執行者日誌應寫出 NotKycVerified"; }
[ "$(rec 1)" = "1" ] && [ "$(rec 3)" = "${SYNC_IDS[*]}" ] && [ "$(tank)" = "$TANK" ] || fail "被擋時部位與油箱都不能動"
HOOK_KYC=$(hook_last blocked)
[ -n "$HOOK_KYC" ] && [ "$(jget "$HOOK_KYC" 'r.category')" = "kyc" ] || fail "webhook 應收到 category＝kyc 的 blocked 通知"
pass "整筆擋下、一條腿都沒動（仍在第 2 版、油箱不變）；webhook 通知本人：$(jget "$HOOK_KYC" 'r.message')（下次重試 $(jget "$HOOK_KYC" 'r.retryAt')）"

s "$KYC" "batchVerify(address[])" "[$FOL]" --private-key "$PK0"
warp_hour
copy_sync round-after-kyc
grep -q "已同步 v2 → v3（versionId 1 → 2）" "$TMP/round-after-kyc.log" || { cat "$TMP/round-after-kyc.log"; fail "KYC 後應同步到 versionId 2"; }
[ "$(rec 1)" = "2" ] || fail "跟單紀錄應已在 versionId 2"
legs_closed "${SYNC_IDS[@]}"
verify_legs sETH:long:1:4000 sBTC:long:1:3000 sAAPL:long:1:3000
[ "$(bn "$TANK - $(tank)")" = "$COST" ] || fail "第二次同步油箱應再扣 $COST"
TANK=$(tank)
SYNCST=$(c "$CT" "getSyncState(address,uint256)((uint64,uint32,bool,uint256,int256))" "$FOL" 0 --json)
[ "$(jget "$SYNCST" 'r[0][1]')" = "2" ] || fail "syncCount 應為 2"
invariant
pass "KYC 後到了重試時間，同一個 public 執行者把部位同步到第 3 版（含 sAAPL）；syncCount 2"

# ── 7. 只讓自己的 agent 同步 ────────────────────────────────────────────────
step "7. 跟隨者指定自己的 agent 為唯一執行者（setSyncExecutor）；交易者發布第 4 版"
s "$CT" "setSyncExecutor(uint256,address)" 0 "$AGENT" --private-key "$FOL_PK"
[ "$(c "$CT" "syncExecutor(address,uint256)(address)" "$FOL" 0)" = "$AGENT" ] || fail "syncExecutor 應為跟隨者的 agent"
pass "指定執行者：${AGENT}（跟隨者的 agent，另一把只放 gas 的熱錢包；跟隨者的私鑰仍只在他自己的錢包）"
SYNC_IDS=($(rec 3))
publish "[($(cast keccak sETH),5000,true,2),($(cast keccak sBTC),2500,true,1),($(cast keccak sGOLD),2500,true,1)]"
warp_hour
expect_revert "NotSyncExecutor(address)" "$CT" "resyncFor(address,uint256)" "$FOL" 0 --from "$STRANGER"
pass "冷卻已過，陌生人呼叫仍被 NotSyncExecutor($REVERT_ARGS) 擋下"
copy_sync round-designated
[ "$(sent_of round-designated)" = "0" ] && [ "$(rec 1)" = "2" ] || fail "public 執行者不該替指定了別人的跟單送交易"
grep -q "指定的執行者是" "$TMP/round-designated.log" || { cat "$TMP/round-designated.log"; fail "public 執行者日誌應寫出停止追蹤的理由"; }
pass "平台的 public 執行者不送交易，停止追蹤這筆（日誌：跟隨者指定的執行者不是本執行者）"
AGENT_BAL0=$(cast balance "$AGENT" --rpc-url "$RPC")
personal_sync round-personal --from-block 0
[ "$(sent_of round-personal)" = "1" ] || { cat "$TMP/round-personal.log"; fail "跟隨者的 agent 應送出一筆 resyncFor"; }
[ "$(rec 1)" = "3" ] || fail "跟單紀錄應已在 versionId 3"
legs_closed "${SYNC_IDS[@]}"
verify_legs sETH:long:2:5000 sBTC:long:1:2500 sGOLD:long:1:2500
[ "$(bn "$TANK - $(tank)")" = "$COST" ] || fail "指定執行者同步一樣只扣「執行費×3＋小費」"
TANK=$(tank)
HOOK_P=$(hook_last resynced)
[ "$(jget "$HOOK_P" 'r.executor')" = "$AGENT" ] && [ "$(jget "$HOOK_P" 'r.toVersion')" = "3" ] || fail "webhook 應收到跟隨者 agent 送出的 resynced"
[ "$(bn "$(cast balance "$AGENT" --rpc-url "$RPC") < $AGENT_BAL0 + $TIP")" = "true" ] || fail "agent 的淨收不該超過小費"
invariant
pass "跟隨者自己的 agent（personal 模式）同步到第 4 版、拿到跟隨者設定的小費；webhook：$(jget "$HOOK_P" 'r.message')"

# ── 8. 跟隨者收回控制 ───────────────────────────────────────────────────────
step "8. 跟隨者關閉自動同步；personal agent 只通知、不送；全額提領油箱"
s "$CT" "setAutoSync(uint256,bool,uint8,uint32,uint96,uint256)" 0 false 0 0 0 0 --private-key "$FOL_PK"
publish "[($(cast keccak sETH),4000,true,2),($(cast keccak sBTC),3000,true,1),($(cast keccak sGOLD),3000,true,1)]"
expect_revert "AutoSyncDisabled()" "$CT" "resyncFor(address,uint256)" "$FOL" 0 --from "$STRANGER"
pass "關閉後交易者再發新版，陌生人呼叫被 AutoSyncDisabled 擋下"
personal_sync round-notify
[ "$(sent_of round-notify)" = "0" ] && [ "$(rec 1)" = "3" ] || fail "自動同步關閉時 personal agent 不該送交易"
HOOK_NV=$(hook_last new-version)
[ -n "$HOOK_NV" ] && [ "$(jget "$HOOK_NV" 'r.autoSync')" = "false" ] && [ "$(jget "$HOOK_NV" 'r.toVersion')" = "4" ] \
  || fail "webhook 應收到 autoSync=false、toVersion=4 的 new-version 通知"
pass "personal agent 不送交易，只通知本人有新版：$(jget "$HOOK_NV" 'r.message')"
# 沒有自己的執行者熱錢包也收得到通知：只通知模式不讀任何金鑰、不送交易，但會寫狀態檔（每一版只通知一次）
notify_only() {
  local log="$TMP/$1.log"
  (cd "$ROOT/agent" && env -u COPY_SYNC_PRIVATE_KEY -u COPY_SYNC_KEYSTORE COPY_SYNC_RPC_URL="$RPC" npx tsx copy-sync/src/run.ts \
    --once --notify-only --followers "$FOL" --tracker "$CT" --state-file "$TMP/copy-sync-notify.json" --from-block 0 \
    --notify-webhook "$HOOK") >"$log" 2>&1 || { cat "$log"; fail "copy-sync --notify-only 這一輪以非零結束（${log}）"; }
}
nv_from_notifier() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(p=>p.kind==="new-version"&&p.executor===null&&p.toVersion===Number(process.argv[2]));console.log(l.length)' "$TMP/webhook.jsonl" "$1"; }
notify_only round-notify-only-1
notify_only round-notify-only-2
grep -q "notify-only：只通知、不送交易、不讀任何金鑰" "$TMP/round-notify-only-1.log" || { cat "$TMP/round-notify-only-1.log"; fail "只通知模式應宣告不讀金鑰"; }
[ "$(sent_of round-notify-only-1)$(sent_of round-notify-only-2)" = "00" ] && [ "$(rec 1)" = "3" ] || fail "只通知模式不該送任何交易"
[ "$(nv_from_notifier 4)" = "1" ] || fail "只通知模式連跑兩次，第 5 版應剛好通知一次（實際 $(nv_from_notifier 4) 次）"
pass "只通知模式（--notify-only，沒有任何金鑰）：連跑兩次只通知一次（狀態檔記住已通知的版本），適合沒有執行者熱錢包的人掛 cron"
FOL_BAL0=$(cast balance "$FOL" --rpc-url "$RPC")
s "$CT" "withdrawSyncGas(uint256)" "$TANK" --private-key "$FOL_PK"
[ "$(tank).$(cn "$CT" "totalSyncGas()(uint256)").$(cast balance "$CT" --rpc-url "$RPC")" = "0.0.0" ] || fail "提領後油箱、totalSyncGas、tracker 餘額都應為 0"
[ "$(bn "$(cast balance "$FOL" --rpc-url "$RPC") > $FOL_BAL0")" = "true" ] || fail "ETH 應回到跟隨者錢包"
pass "油箱 $(fmt18 "$TANK") ETH 全數回到跟隨者錢包；tracker 不留任何 ETH"

# ── 9. 金鑰護欄 ─────────────────────────────────────────────────────────────
step "9. 金鑰護欄：把跟隨者的私鑰交給執行者程式"
if (cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$FOL_PK" npx tsx copy-sync/src/run.ts --once \
  --tracker "$CT" --state-file "$TMP/self.json" --followers "$FOL") >"$TMP/self-key.log" 2>&1; then
  fail "執行者金鑰等於跟隨者時應拒絕啟動"
fi
grep -q "就是你要服務的跟隨者" "$TMP/self-key.log" || { cat "$TMP/self-key.log"; fail "拒絕的理由不對"; }
# public 模式（沒有 --followers）也一樣：這把金鑰在 tracker 上有跟單紀錄，就是跟隨者的主錢包
if (cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" COPY_SYNC_PRIVATE_KEY="$FOL_PK" npx tsx copy-sync/src/run.ts --once \
  --mode public --tracker "$CT" --state-file "$TMP/self-public.json") >"$TMP/self-key-public.log" 2>&1; then
  fail "public 模式載入跟隨者的私鑰時也應拒絕啟動"
fi
grep -q "跟隨者的主錢包" "$TMP/self-key-public.log" || { cat "$TMP/self-key-public.log"; fail "public 模式拒絕的理由不對"; }
# 私鑰誤貼進只填地址的欄位：拒絕，而且錯誤訊息不帶出任何片段
if (cd "$ROOT/agent" && COPY_SYNC_RPC_URL="$RPC" npx tsx copy-sync/src/run.ts --once --dry-run --followers "$FOL_PK" \
  --tracker "$CT") >"$TMP/pasted-key.log" 2>&1; then
  fail "--followers 給私鑰時應拒絕"
fi
grep -q "看起來像私鑰" "$TMP/pasted-key.log" || { cat "$TMP/pasted-key.log"; fail "私鑰誤貼的拒絕理由不對"; }
pass "personal、public 模式都拒絕把跟隨者的私鑰當執行者金鑰；私鑰誤貼進 --followers 被拒且不顯示"

# ── 10. 由 agent 發起跟單（MCP 工具，只產生未簽名交易）─────────────────────
step "10. 由 agent 發起跟單：prepare_copy_follow_tx 產生未簽名交易，第二位跟隨者用自己的錢包簽"
FOL2_PK=$(key 4);      FOL2=$(cast wallet address --private-key "$FOL2_PK")
s "$USDC" "mint(address,uint256)" "$FOL2" "1000$E18" --private-key "$PK0"
# agent 端：只拿得到地址，拿不到任何私鑰。這段程式就是 MCP 伺服器裡 prepare_copy_follow_tx 呼叫的同一個函式。
mcp_follow() {
  (cd "$ROOT/agent" && MCP_RPC="$RPC" MCP_TRACKER="$CT" MCP_EXCHANGE="$EX" MCP_FOLLOWER="$FOL2" MCP_TRADER="$TRADER" npx tsx --eval '
import { ethers } from "ethers";
import { jsonSafe } from "@pepelab/shared";
import { makeCopyReads, prepareCopyFollow } from "./mcp-server/src/copyTools.ts";
const env = process.env as Record<string, string>;
const p = new ethers.JsonRpcProvider(env.MCP_RPC, 31337, { staticNetwork: true, batchMaxCount: 1 });
const reads = makeCopyReads(p, { chainId: 31337, tracker: env.MCP_TRACKER, exchange: env.MCP_EXCHANGE });
prepareCopyFollow(reads, { follower: env.MCP_FOLLOWER, trader: env.MCP_TRADER, amountUsdc: "500", autoSync: true, maxLeverage: 2 })
  .then((plan) => console.log(JSON.stringify(jsonSafe(plan))))
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => p.destroy());
') 2>"$TMP/mcp-follow.err" || { cat "$TMP/mcp-follow.err"; fail "prepare_copy_follow_tx 失敗"; }
}
# 跟隨者的錢包：照工具給的 to／data／value 原樣簽名送出（cast 接受原始 calldata）
wallet_sign() { cast send "$(jget "$1" "r.steps[$2].to")" "$(jget "$1" "r.steps[$2].data")" --value "$(jget "$1" "r.steps[$2].value")" \
  --private-key "$FOL2_PK" --rpc-url "$RPC" >/dev/null; }
PLAN=$(mcp_follow)
[ "$(jget "$PLAN" 'r.steps.length')" = "2" ] && [ "$(jget "$PLAN" 'r.simulation')" = "null" ] || fail "還沒授權時應是 approve＋跟單兩筆、尚未模擬"
[ "$(jget "$PLAN" 'r.steps[0].to')" = "$USDC" ] && [ "$(jget "$PLAN" 'r.steps[1].to')" = "$CT" ] || fail "第 1 筆應給 USDC、第 2 筆給 CopyTracker"
[ "$(jget "$PLAN" 'r.preview.version')" = "v5" ] || fail "預覽應是交易者最新的第 5 版"
note "$(jget "$PLAN" 'r.steps[0].summary')"
wallet_sign "$PLAN" 0
[ "$(cn "$USDC" "allowance(address,address)(uint256)" "$FOL2" "$CT")" = "500$E18" ] || fail "approve 應剛好 500（不是無上限授權）"
PLAN=$(mcp_follow)
[ "$(jget "$PLAN" 'r.steps.length')" = "1" ] && [ "$(jget "$PLAN" 'r.simulation.ok')" = "true" ] || fail "授權足夠後應只剩跟單一筆、eth_call 模擬會成功（$(jget "$PLAN" 'JSON.stringify(r.simulation)')）"
note "$(jget "$PLAN" 'r.steps[0].summary')"
VALUE=$(jget "$PLAN" 'r.steps[0].value')
[ "$VALUE" = "$(bn "$FEE * 3 + ($FEE * 3) * 5")" ] || fail "value 應為開倉執行費 × 3＋預存油箱（夠代為同步 5 次）"
wallet_sign "$PLAN" 0
REC2=$(cast call "$CT" "getCopyRecords(address)((address,uint256,uint256,uint256[],uint256,bool,uint256)[])" "$FOL2" --rpc-url "$RPC" --json)
[ "$(jget "$REC2" 'r[0][0][0]').$(jget "$REC2" 'r[0][0][1]').$(jget "$REC2" 'r[0][0][5]')" = "$TRADER.4.true" ] || fail "第二位跟隨者的紀錄應指向交易者、釘在 versionId 4、active"
CFG2=$(c "$CT" "syncConfig(address,uint256)(bool,uint8,uint32,uint96)" "$FOL2" 0 | awk '{print $1}' | paste -sd, -)
[ "$CFG2" = "true,2,86400,0" ] || fail "自動同步設定應為 true,2,86400,0（實際 ${CFG2}）"
[ "$(cn "$CT" "syncExecFeeCap(address,uint256)(uint256)" "$FOL2" 0)" = "$FEE" ] || fail "同意的每腿執行費應等於工具帶入的現行費率"
[ "$(cn "$CT" "syncGasBalance(address)(uint256)" "$FOL2")" = "$(bn "$VALUE - $FEE * 3")" ] || fail "油箱應剛好是預存金額"
for id in $(jget "$REC2" 'r[0][0][3]'); do
  lev=$(jget "$(cast call "$EX" "$POS_SIG" "$id" --rpc-url "$RPC" --json)" 'r[0][6]')
  [ "$lev" -le 2 ] || fail "腿 #$id 槓桿 ${lev}× 超過跟隨者上限 2×"
done
invariant
pass "agent 只準備交易、跟隨者自己簽：跟單釘在第 5 版、自動同步（上限 2×、冷卻 24 小時）、同意的執行費、油箱 $(fmt18 "$(bn "$VALUE - $FEE * 3")") ETH 都與預覽相同"

# 最後一道：這次展示的所有日誌（含執行者、只通知模式、agent 準備跟單的輸出）都不得出現任何一把私鑰。
if grep -qE "${FOL_PK#0x}|${EXEC_PK#0x}|${AGENT_PK#0x}|${FOL2_PK#0x}" "$TMP"/*.log "$TMP"/*.err 2>/dev/null; then fail "日誌裡出現了私鑰"; fi
pass "所有日誌都沒有印出任何私鑰"

printf '\n自動同步展示：全部斷言通過（本機 Anvil 已關閉）\n'
