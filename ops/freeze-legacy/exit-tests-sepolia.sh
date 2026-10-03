#!/usr/bin/env bash
# 只能對 anvil 分叉執行（用 anvil_impersonateAccount 冒充持有人）。凍結後（分叉上）實際呼叫使用者的提領／贖回／平倉路徑，並確認保留角色仍可運作、外洩金鑰已無法動手。
set -uo pipefail
case "${FORK_RPC:-http://127.0.0.1:18545}" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "只允許本機 anvil 分叉" >&2; exit 2;; esac
R=${FORK_RPC:-http://127.0.0.1:18545}
LEAK=0xE80A81360608C1342e66743F70a00f75d792Eb93
MUSDC=0x167Bacef1925184f0df34A3196F834C0622Cfd36
EX=0x0c6459d38617E60017bDc4ed69ec26137DA5c32b; IV=0x8bDE83dBC2CA450B539346e224E7819348C7b091; TS=0x3fe1dbC82eA267085CAB5eb67C6b7d3E68A7d673
OLDEX=0x4cC711AEa7c6D7E19e99676b51b7A69ee08c31Eb; OLDUSDC=0x82c94AAE3F50F2eE31241B986366BC929b774f7a
VAULT2=0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17; SAAPL2=0x84C27703db71062061364E5B8E015139b2ac0163
GO=0x32A19D04ef2ca5A7DA02Df39419729fA745749A1; MO=0x17CA20A37Cf04F2f589B2573EC95f1411D29d958
OLDMO=0x3f1E53C64bc644D07b8FA76baC8aEE33b96194d8; STK=0xf5d0953A443259ebdFC62fE49189998988e309f9; PEPE=0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9; AMM=0x3e6503BA0F4ad9E4743b695141CeB48709106A0c
# 持有人位址不放在公開 repo：從本機盤點（docs/commercial/，不入版控）或鏈上事件自行取得後以環境變數傳入。
# H_EX：現行 Sepolia exchange 有 freeMargin 的非外洩地址；H_IV：同時持有 InsuranceVault 份額與 TraderStake 質押的地址；
# H_OLD：舊 exchange 0x4cC7 上有保證金與未平倉部位的非外洩地址。
H_EX=${H_EX:?設定 H_EX}; H_IV=${H_IV:?設定 H_IV}; H_OLD=${H_OLD:?設定 H_OLD}
KEEPER=0x540aECD37E7A7885824e7b7e996eBddfb842ef17; GUARD=0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4
AAPL=$(cast keccak sAAPL); BTC=$(cast keccak sBTC)
pass=0; fail=0
calc(){ python -c "print($1)"; }
imp(){ cast rpc anvil_impersonateAccount "$1" --rpc-url $R >/dev/null; cast rpc anvil_setBalance "$1" 0x8AC7230489E80000 --rpc-url $R >/dev/null; }
send(){ local from=$1; shift; cast send --unlocked --from "$from" "$@" --rpc-url $R --json 2>&1 | grep -o '"status":"0x[01]"' | head -1; }
ok(){ if [ "$1" = '"status":"0x1"' ]; then echo "  PASS  $2"; pass=$((pass+1)); else echo "  FAIL  $2 ($1)"; fail=$((fail+1)); fi; }
mustfail(){ if [ "$1" = '"status":"0x1"' ]; then echo "  FAIL  $2（應該 revert 卻成功）"; fail=$((fail+1)); else echo "  PASS  $2（revert，符合預期）"; pass=$((pass+1)); fi; }
bal(){ cast call "$1" "balanceOf(address)(uint256)" "$2" --rpc-url $R | awk '{print $1}'; }

echo "== B. 沒有誤傷保留角色"
imp $KEEPER
p=$(cast call $MO "getPrice(bytes32)(uint256,uint256)" $BTC --rpc-url $R | head -1 | awk '{print $1}')
ok "$(send $KEEPER $MO 'updatePrice(bytes32,uint256)' $BTC $p)" "keeper 仍可寫 MockOracle 0x17CA（price-keeper.yml 路徑）"
for A in $BTC $AAPL; do p=$(cast call $GO "peek(bytes32)(uint256,uint256)" $A --rpc-url $R | head -1 | awk '{print $1}')
ok "$(send $KEEPER $GO 'updatePrice(bytes32,uint256)' $A $p)" "keeper 仍可寫 GuardedOracle（KEEPER_ROLE 未受影響）asset ${A:0:10}"; done
imp $GUARD
ok "$(send $GUARD $GO 'setPaused(bool)' true)" "guardian 仍可 setPaused(true) GuardedOracle"
ok "$(send $GUARD $GO 'setPaused(bool)' false)" "guardian 仍可 setPaused(false) GuardedOracle"

echo "== A0. 不需快轉時間的路徑（V2 贖回、質押、AMM）"
imp $H_EX
imp $LEAK; a=$(bal $SAAPL2 $LEAK); b0=$(bal $MUSDC $LEAK)
ok "$(send $LEAK $VAULT2 'redeem(bytes32,uint256)' $AAPL 1000000000000000000)" "AssetVaultV2 redeem(sAAPL, 1)（唯一的 sAAPL 持有人是外洩地址；redeem 不需要任何角色）"
echo "        mUSDC 增加 $(calc "($(bal $MUSDC $LEAK)-$b0)/1e18")"
s=$(cast call $STK "balanceOf(address)(uint256)" $LEAK --rpc-url $R | awk '{print $1}')
[ "$s" = "0" ] && echo "  INFO  PepeStaking 目前沒有任何質押者（餘額只是獎勵預算），無提領可測"
[ "$s" != "0" ] && ok "$(send $LEAK $STK 'withdraw(uint256)' $s)" "PepeStaking withdraw(全部 $s)（唯一質押者是外洩地址；凍結後 owner 不存在仍可退出）"
echo "  INFO  PepeAMM 0x3e65 部署版本的 bytecode 沒有 removeLiquidity／owner 提款（凍結前後相同）；改測 swap 路徑"
ok "$(send $H_EX $MUSDC 'approve(address,uint256)' $AMM 10000000000000000000)" "PepeAMM 使用者 approve"
ok "$(send $H_EX $AMM 'swapUSDCForETH(uint256,uint256)' 10000000000000000000 0)" "PepeAMM(現行) swapUSDCForETH(10) 仍可用"

echo "== A. 使用者資金路徑（凍結後）"
imp $H_EX; b0=$(bal $MUSDC $H_EX); fm=$(cast call $EX "freeMargin(address)(uint256)" $H_EX --rpc-url $R | awk '{print $1}')
ok "$(send $H_EX $EX 'withdrawMargin(uint256)' 1000000000000000000000)" "PerpetualExchange(現行 Sepolia) 持有人 #1 withdrawMargin(1,000) — freeMargin 前 $fm"
b1=$(bal $MUSDC $H_EX); echo "        錢包 mUSDC 增加 $(calc "($b1-$b0)/1e18")"
POS=$(cast call $EX "getUserPositions(address)(uint256[])" $H_EX --rpc-url $R | tr -d '[] ' | tr ',' '\n' | head -50)
OPEN=""; for id in $POS; do o=$(cast call $EX "positions(uint256)(uint256,address,bytes32,bool,uint256,uint256,uint256,uint256,uint256,int256,bool)" $id --rpc-url $R 2>/dev/null | sed -n 11p); [ "$o" = "true" ] && { OPEN=$id; break; }; done
if [ -n "$OPEN" ]; then ok "$(send $H_EX $EX 'closePosition(uint256)' $OPEN)" "PerpetualExchange(現行 Sepolia) 持有人 #1 closePosition(#$OPEN)"; else echo "  INFO  持有人 #1 在現行 Sepolia exchange 沒有未平倉部位"; fi

imp $H_IV; sh=$(bal $IV $H_IV); b0=$(bal $MUSDC $H_IV)
ok "$(send $H_IV $IV 'withdraw(uint256)' $sh)" "InsuranceVault(現行 Sepolia) 持有人 withdraw(全部 $sh shares)"
echo "        錢包 mUSDC 增加 $(calc "($(bal $MUSDC $H_IV)-$b0)/1e18")"
st=$(cast call $TS "stakedAmount(address)(uint256)" $H_IV --rpc-url $R | awk '{print $1}'); b0=$(bal $MUSDC $H_IV)
ok "$(send $H_IV $TS 'requestUnstake(uint256)' $st)" "TraderStake(現行 Sepolia) 持有人 requestUnstake($st)"
cast rpc evm_increaseTime 86401 --rpc-url $R >/dev/null; cast rpc evm_mine --rpc-url $R >/dev/null
ok "$(send $H_IV $TS 'executeUnstake()')" "TraderStake executeUnstake()（快轉 1 天冷卻）"
echo "        錢包 mUSDC 增加 $(calc "($(bal $MUSDC $H_IV)-$b0)/1e18")"

imp $H_OLD; fm=$(cast call $OLDEX "freeMargin(address)(uint256)" $H_OLD --rpc-url $R | awk '{print $1}'); b0=$(bal $OLDUSDC $H_OLD)
POS=$(cast call $OLDEX "getUserPositions(address)(uint256[])" $H_OLD --rpc-url $R | tr -d '[] ' | tr ',' '\n')
for id in $POS; do o=$(cast call $OLDEX "positions(uint256)(uint256,address,bytes32,bool,uint256,uint256,uint256,uint256,uint256,int256,bool)" $id --rpc-url $R 2>/dev/null | sed -n 11p); [ "$o" = "true" ] && ok "$(send $H_OLD $OLDEX 'closePosition(uint256)' $id)" "舊 PerpetualExchange 0x4cC7 非外洩持有人 closePosition(#$id)（舊 oracle 已無 owner，以凍結價結算）"; done
fm=$(cast call $OLDEX "freeMargin(address)(uint256)" $H_OLD --rpc-url $R | awk '{print $1}'); cb=$(bal $OLDUSDC $OLDEX); amt=$fm; [ "$(calc "int($fm > $cb)")" = 1 ] && amt=$cb
ok "$(send $H_OLD $OLDEX 'withdrawMargin(uint256)' $amt)" "舊 PerpetualExchange 0x4cC7 非外洩持有人 withdrawMargin(全額 $amt)"
echo "        錢包舊 mUSDC 增加 $(calc "($(bal $OLDUSDC $H_OLD)-$b0)/1e18")"

echo "== C. 外洩金鑰已無法動手"
mustfail "$(send $LEAK $GO 'grantRole(bytes32,address)' 0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab $LEAK)" "外洩地址 grantRole(KEEPER) on GuardedOracle"
mustfail "$(send $LEAK $SAAPL2 'grantRole(bytes32,address)' 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6 $LEAK)" "外洩地址 grantRole(MINTER) on sAAPL(V2)"
mustfail "$(send $LEAK $VAULT2 'grantRole(bytes32,address)' 0xbb4cf8e50e81e9742807782b2bc5c27c5a943f214ee0b993943eff5a774e555b $LEAK)" "外洩地址 grantRole(RISK) on AssetVaultV2（DEFAULT_ADMIN 檢查，等同升級權限的同一個 admin）"
mustfail "$(send $LEAK $OLDMO 'updatePrice(bytes32,uint256)' $BTC 1)" "外洩地址 updatePrice on 舊 MockOracle 0x3f1E"
mustfail "$(send $LEAK $EX 'setFeeRouter(address)' $LEAK)" "外洩地址 setFeeRouter on 現行 Sepolia exchange"
mustfail "$(send $LEAK $PEPE 'mint(address,uint256)' $LEAK 1)" "外洩地址 mint PEPE"
echo "== 結果：PASS $pass / FAIL $fail"
