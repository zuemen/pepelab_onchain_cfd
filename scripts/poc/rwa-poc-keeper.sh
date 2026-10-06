#!/usr/bin/env bash
# scripts/poc/rwa-poc-keeper.sh — RWA PoC 租戶的本機 keeper（推價＋休市切換）。docs/tenants/rwa-poc/RUNBOOK.md
#
#   位址只從已審查的登記檔讀（ops/tenant-keeper/load-env.mjs，與租戶 workflow 同一個來源），不寫死。
#   金鑰是加密 keystore（KEEPER_KEYSTORE 模式，keeper/keySource.ts）：私鑰只在 keeper 行程的記憶體裡解開，
#   不經過環境變數、指令列或檔案。
#
#   每一輪：先 DRY_RUN 一次（只在啟動時），必須 failed=0 → 之後每 INTERVAL 秒送一輪；
#   heartbeat 240 秒，讓 11 檔價格都在 5 分鐘內更新。
#
# 用法（repo 根目錄）：
#   bash scripts/poc/rwa-poc-keeper.sh                       # 迴圈，Ctrl-C 結束
#   bash scripts/poc/rwa-poc-keeper.sh --once                # 只跑一輪
#   bash scripts/poc/rwa-poc-keeper.sh --no-market-operator  # 不自動切休市（白天錄影要讓股票保持 Active 時）
# 環境變數：KEEPER_RPC_URL（預設 https://sepolia.base.org）、POC_TENANT（預設 rwa-poc）、
#           POC_KEEPER_ACCOUNT（預設 pepelab-rwa-keeper）、POC_KEEPER_INTERVAL（預設 60 秒）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TENANT="${POC_TENANT:-rwa-poc}"
ACCOUNT="${POC_KEEPER_ACCOUNT:-pepelab-rwa-keeper}"
INTERVAL="${POC_KEEPER_INTERVAL:-60}"
ONCE=0
MARKET_OPERATOR=1
for a in "$@"; do
  case "$a" in
    --once) ONCE=1 ;;
    --no-market-operator) MARKET_OPERATOR=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "✖ 不認得的參數：$a" >&2; exit 2 ;;
  esac
done
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && (( INTERVAL >= 15 )) || { echo "✖ POC_KEEPER_INTERVAL 必須是 ≥ 15 的整數秒" >&2; exit 2; }

for c in cast node npx; do command -v "$c" >/dev/null || { echo "✖ 找不到 $c" >&2; exit 1; }; done
[[ -d "$REPO_ROOT/agent/node_modules" ]] || { echo "✖ 請先在 agent/ 執行 npm ci" >&2; exit 1; }

KEYSTORE="$HOME/.foundry/keystores/$ACCOUNT"
PASSWORD_FILE="$HOME/.foundry/$ACCOUNT.password"
[[ -f "$KEYSTORE" ]] || { echo "✖ 找不到 keystore：$KEYSTORE" >&2; exit 1; }
[[ -f "$PASSWORD_FILE" ]] || { echo "✖ 找不到密碼檔：$PASSWORD_FILE" >&2; exit 1; }

# 1. 位址：只認 dedicated 登記＋status=deployed 的設定。部署前會在這裡停。
if ! ENV_LINES="$(node "$REPO_ROOT/ops/tenant-keeper/load-env.mjs" "$TENANT")"; then
  echo "✖ 讀不到 $TENANT 的 keeper 位址。部署並把登記改成 dedicated、設定改成 status=deployed 之後才能跑 keeper（docs/TENANT_DEPLOYMENT.md §5）。" >&2
  exit 1
fi
while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z_]+$ ]] || { echo "✖ load-env 輸出格式不對：$k" >&2; exit 1; }
  export "$k=$v"
done <<< "$ENV_LINES"

export KEEPER_CHAIN=base-sepolia
export KEEPER_RPC_URL="${KEEPER_RPC_URL:-https://sepolia.base.org}"
export KEEPER_TENANT="$TENANT"
export KEEPER_HEARTBEAT="${KEEPER_HEARTBEAT:-240}"
unset KEEPER_PRIVATE_KEY KEEPER_GUARDED_ORACLE   # 租戶只有一顆 oracle；不設 KEEPER_GUARDED_ORACLE（TENANT_OPERATIONS.md）
(( MARKET_OPERATOR )) || export KEEPER_MARKET_OPERATOR=0

CHAIN_ID="$(cast chain-id --rpc-url "$KEEPER_RPC_URL")"
[[ "$CHAIN_ID" == "84532" ]] || { echo "✖ KEEPER_RPC_URL 指向 chainId $CHAIN_ID，不是 Base Sepolia（84532）" >&2; exit 1; }

# 2. 參考來源：設定的值必須等於 oracle 鏈上的 referenceSource()（與租戶 workflow 相同的檢查）。
ZERO=0x0000000000000000000000000000000000000000
if [[ "$KEEPER_ORACLE_KIND" == "guarded" ]]; then
  WANT="$(echo "${KEEPER_RELAY_SOURCE:-$ZERO}" | tr '[:upper:]' '[:lower:]')"
  GOT="$(cast call "$KEEPER_ORACLE_ADDRESS" "referenceSource()(address)" --rpc-url "$KEEPER_RPC_URL" | tr '[:upper:]' '[:lower:]')"
  [[ "$WANT" == "$GOT" ]] || { echo "✖ oracle 的 referenceSource() 是 $GOT，設定預期 $WANT" >&2; exit 1; }
fi

# 3. keystore 推出的地址必須是設定的 roles.keeper（只印地址）。
ADDR="$(cast wallet address --account "$ACCOUNT" --password-file "$PASSWORD_FILE")"
if [[ "$(echo "$ADDR" | tr '[:upper:]' '[:lower:]')" != "$(echo "$KEEPER_EXPECTED_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
  echo "✖ keystore $ACCOUNT 的地址 $ADDR 不是 $TENANT 的 roles.keeper（$KEEPER_EXPECTED_ADDRESS）。不送任何交易。" >&2
  exit 1
fi
BAL="$(cast balance "$ADDR" --rpc-url "$KEEPER_RPC_URL" --ether)"
echo "keeper $ADDR 餘額 $BAL ETH；oracle $KEEPER_ORACLE_ADDRESS；exchange $EXCHANGE；marketOperator=$([[ $MARKET_OPERATOR == 1 ]] && echo on || echo off)"

cd "$REPO_ROOT/agent"

# 一輪的摘要行 available=… failed=N；failed≠0 或非零結束都算失敗。
run_round() {
  local log status failed
  log="$(mktemp)"
  set +e
  "$@" npx tsx keeper/run.ts 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  failed="$(grep -E '^available=[0-9]+ .*failed=[0-9]+$' "$log" | tail -1 | sed -n 's/.*failed=\([0-9]*\).*/\1/p')"
  rm -f "$log"
  if (( status != 0 )); then echo "✖ keeper/run.ts 以 exit $status 結束" >&2; return 1; fi
  if [[ -z "$failed" ]]; then echo "✖ 找不到 keeper 摘要行" >&2; return 1; fi
  if (( failed != 0 )); then echo "✖ 本輪 failed=$failed" >&2; return 1; fi
  return 0
}

# 4. 啟動前先乾跑一輪（不需要金鑰、不送交易）。
echo "── DRY_RUN 一輪 ──"
run_round env DRY_RUN=1 || { echo "✖ DRY_RUN 沒有全過，不開始送交易" >&2; exit 1; }

export KEEPER_KEYSTORE="$KEYSTORE"
export KEEPER_KEYSTORE_PASSWORD_FILE="$PASSWORD_FILE"
trap 'echo; echo "keeper 結束"; exit 0' INT TERM

while :; do
  echo "── $(date '+%F %T') 送出一輪 ──"
  if ! run_round env; then
    (( ONCE )) && exit 1
    echo "（本輪失敗，${INTERVAL} 秒後重試）" >&2
  fi
  (( ONCE )) && exit 0
  sleep "$INTERVAL"
done
