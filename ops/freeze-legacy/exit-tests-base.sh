#!/usr/bin/env bash
# Base Sepolia 分叉：三顆 oracle adapter 移交後，新 owner 能管理、外洩金鑰不能、監控讀取行為不變、keeper 不受影響。
set -uo pipefail
case "${FORK_RPC:-http://127.0.0.1:18546}" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "只允許本機 anvil 分叉" >&2; exit 2;; esac
R=${FORK_RPC:-http://127.0.0.1:18546}
LEAK=0xE80A81360608C1342e66743F70a00f75d792Eb93; NEW=${ADAPTER_NEW_OWNER:?}
CL=0x37DC7b70899BFfB17949366a5b6a86203C428E2f; PY=0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5; AG=0x8215158642350a3f329aB9597186d21f957A813D
MO=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3; KEEPER=0x540aECD37E7A7885824e7b7e996eBddfb842ef17
BTC=$(cast keccak sBTC); pass=0; fail=0
imp(){ cast rpc anvil_impersonateAccount "$1" --rpc-url $R >/dev/null; cast rpc anvil_setBalance "$1" 0x8AC7230489E80000 --rpc-url $R >/dev/null; }
send(){ local from=$1; shift; cast send --unlocked --from "$from" "$@" --rpc-url $R --json 2>&1 | grep -o '"status":"0x[01]"' | head -1; }
ok(){ if [ "$1" = '"status":"0x1"' ]; then echo "  PASS  $2"; pass=$((pass+1)); else echo "  FAIL  $2 ($1)"; fail=$((fail+1)); fi; }
mustfail(){ if [ "$1" = '"status":"0x1"' ]; then echo "  FAIL  $2（應該 revert 卻成功）"; fail=$((fail+1)); else echo "  PASS  $2（revert，符合預期）"; pass=$((pass+1)); fi; }
echo "== 監控讀取（oracleDeviation 的參考價）：AggregatorOracle.getPrice(sBTC)"
cast call $AG "getPrice(bytes32)(uint256,uint256)" $BTC --rpc-url $R 2>&1 | sed 's/^/        /' | head -2
echo "== owner 讀回"
for a in $CL $PY $AG; do echo "        $a owner=$(cast call $a 'owner()(address)' --rpc-url $R)"; done
echo "== 新 owner 可管理、外洩金鑰不行"
imp $NEW; imp $LEAK
T=$(cast keccak FREEZE_REHEARSAL_TEST); MD=$(cast call $AG "maxDeviationBps()(uint256)" --rpc-url $R | awk '{print $1}')
echo "  INFO  部署版 adapter 的 owner 函式只有：Chainlink setFeed、Pyth setPriceId、Aggregator setMaxDeviationBps（其餘是後來的原始碼）"
ok "$(send $NEW $CL 'setFeed(bytes32,address)' $T 0x000000000000000000000000000000000000dEaD)" "新 owner setFeed（測試用 assetId）on ChainlinkAdapter"
ok "$(send $NEW $PY 'setPriceId(bytes32,bytes32)' $T $T)" "新 owner setPriceId（測試用 assetId）on PythAdapter"
ok "$(send $NEW $AG 'setMaxDeviationBps(uint256)' $MD)" "新 owner setMaxDeviationBps(原值 $MD) on AggregatorOracle"
mustfail "$(send $LEAK $CL 'setFeed(bytes32,address)' $BTC $LEAK)" "外洩地址 setFeed(sBTC→任意位址) on ChainlinkAdapter"
mustfail "$(send $LEAK $PY 'setPriceId(bytes32,bytes32)' $BTC $T)" "外洩地址 setPriceId(sBTC) on PythAdapter"
mustfail "$(send $LEAK $AG 'setMaxDeviationBps(uint256)' 10000)" "外洩地址 setMaxDeviationBps(10000) on AggregatorOracle"
echo "== keeper 不受影響"
imp $KEEPER
p=$(cast call $MO "getPrice(bytes32)(uint256,uint256)" $BTC --rpc-url $R | head -1 | awk '{print $1}')
ok "$(send $KEEPER $MO 'updatePrice(bytes32,uint256)' $BTC $p)" "keeper 仍可寫 Base MockOracle（price-keeper-base 路徑）"
echo "== 結果：PASS $pass / FAIL $fail"
