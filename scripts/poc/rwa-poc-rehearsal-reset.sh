#!/usr/bin/env bash
# RWA PoC 彩排重置：把投資人恢復成「沒有資格、沒有部位」，讓 scenes/rwa-poc-full.mjs 可以從頭再跑一次。
#
#   bash scripts/poc/rwa-poc-rehearsal-reset.sh [--dry]
#
# 做的事（每筆都經 rwa-poc-tx.sh：先模擬再以 keystore 送出）：
#   1. 投資人目前若具資格（isVerified），發證者在鏈上 revoke 那張憑證的 credentialHash。
#   2. 投資人名下所有還開著的部位（模擬 closePosition 會通過的），由投資人平倉。
#   3. 投資人建立、尚未撤銷的 session 中，id ≥ KEEP_SESSIONS（預設 2：#0、#1 是 S6 x402 用的）由投資人撤銷。
# --dry 只列出要做的事。
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
R="${RWA_POC_RPC_URL:-https://sepolia.base.org}"
# 位址不寫死（repo 裡出現的完整位址都會被算成平台位址）：合約讀部署紀錄，投資人由 keystore 推出。
DEP="$ROOT/deploy/tenants/rwa-poc.deployed.json"
c() { node -e 'const j=require(process.argv[1]);if(j.chainId!==84532)process.exit(1);console.log(j.contracts[process.argv[2]])' "$DEP" "$1"; }
EX=$(c PerpetualExchange); REG=$(c KYCRegistry); MGR=$(c AgentSessionManager)
INV=$(cast wallet address --account pepelab-rwa-investor --password-file "$HOME/.foundry/pepelab-rwa-investor.password")
KEEP="${KEEP_SESSIONS:-2}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
TX="$ROOT/scripts/poc/rwa-poc-tx.sh"
do_tx() { if [ $DRY = 1 ]; then echo "（乾跑）$*"; else bash "$TX" "$@"; fi; }

QI=$(cast keccak QUALIFIED_INVESTOR)
if [ "$(cast call $REG "isVerified(address)(bool)" $INV -r "$R")" = "true" ]; then
  HASH=$(cast call $REG "credentialOf(address,bytes32)((address,uint64,uint64,bytes32,uint64),bool)" $INV "$QI" -r "$R" | grep -oE '0x[0-9a-f]{64}' | head -1)
  do_tx issuer ok "撤銷投資人目前的合格投資人憑證" $REG "revoke(bytes32)" "$HASH"
else
  echo "✓ 投資人目前沒有資格"
fi

NEXT=$(cast call $EX "nextPositionId()(uint256)" -r "$R" | cut -d' ' -f1)
for ((i = 0; i < NEXT; i++)); do
  if cast call $EX "closePosition(uint256)" $i --from $INV -r "$R" >/dev/null 2>&1; then
    do_tx investor ok "平倉 #$i" $EX "closePosition(uint256)" $i
  fi
done

NS=$(cast call $MGR "nextSessionId()(uint256)" -r "$R" | cut -d' ' -f1)
for ((i = KEEP; i < NS; i++)); do
  S=$(cast call $MGR "sessions(uint256)(address,address,uint256,uint256,uint256,uint256,uint256,bool)" $i -r "$R")
  user=$(echo "$S" | sed -n 1p); revoked=$(echo "$S" | sed -n 8p)
  if [ "$(echo "$user" | tr A-F a-f)" = "$(echo $INV | tr A-F a-f)" ] && [ "$revoked" = "false" ]; then
    do_tx investor ok "撤銷 session #$i" $MGR "revokeSession(uint256)" $i
  fi
done
echo "✓ 重置完成：isVerified=$(cast call $REG "isVerified(address)(bool)" $INV -r "$R")"
