#!/usr/bin/env bash
# scripts/poc/rwa-poc-keeper.sh — RWA PoC 租戶的本機 keeper（推價＋休市切換）。docs/tenants/rwa-poc/RUNBOOK.md
#
#   位址只從已審查的登記檔讀（ops/tenant-keeper/load-env.mjs，與租戶 workflow 同一個來源），不寫死。
#   金鑰是加密 keystore（KEEPER_KEYSTORE 模式，keeper/keySource.ts）：私鑰只在 keeper 行程的記憶體裡解開，
#   不經過環境變數、指令列或檔案。
#   keeper/run.ts 以 `env -i` 加上白名單變數啟動：殼層裡殘留的 RELAY_SOURCE、KEEPER_EXCHANGE_ADDRESS、
#   DRY_RUN、門檻參數等都進不去，送交易的對象與價格來源只由登記檔決定。
#
#   啟動時先 DRY_RUN 一輪，必須 failed=0 → 之後每 INTERVAL 秒送一輪；heartbeat 240 秒，讓 11 檔都在 5 分鐘內更新。
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
RPC="${KEEPER_RPC_URL:-https://sepolia.base.org}"
ONCE=0
MARKET_OPERATOR=1
for a in "$@"; do
  case "$a" in
    --once) ONCE=1 ;;
    --no-market-operator) MARKET_OPERATOR=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "✖ 不認得的參數：$a" >&2; exit 2 ;;
  esac
done
[[ "$TENANT" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "✖ POC_TENANT 不是租戶 id" >&2; exit 2; }
[[ "$ACCOUNT" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "✖ POC_KEEPER_ACCOUNT 格式不對" >&2; exit 2; }
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && (( INTERVAL >= 15 )) || { echo "✖ POC_KEEPER_INTERVAL 必須是 ≥ 15 的整數秒" >&2; exit 2; }
[[ "$RPC" =~ ^https?:// ]] || { echo "✖ KEEPER_RPC_URL 必須是 http(s) 網址" >&2; exit 2; }

for c in cast node npx; do command -v "$c" >/dev/null || { echo "✖ 找不到 $c（Foundry 在 ~/.foundry/bin）" >&2; exit 1; }; done
[[ -d "$REPO_ROOT/agent/node_modules" ]] || { echo "✖ 請先在 agent/ 執行 npm ci" >&2; exit 1; }

KEYSTORE="$HOME/.foundry/keystores/$ACCOUNT"
PASSWORD_FILE="$HOME/.foundry/$ACCOUNT.password"
[[ -f "$KEYSTORE" ]] || { echo "✖ 找不到 keystore：$KEYSTORE" >&2; exit 1; }
[[ -f "$PASSWORD_FILE" ]] || { echo "✖ 找不到密碼檔：$PASSWORD_FILE" >&2; exit 1; }

# 1. 位址：只認 dedicated 登記＋status=deployed 的設定。部署前會在這裡停。
#    只收白名單裡的鍵，存在本腳本的變數裡；不 export 到殼層。
if ! ENV_LINES="$(node "$REPO_ROOT/ops/tenant-keeper/load-env.mjs" "$TENANT")"; then
  echo "✖ 讀不到 $TENANT 的 keeper 位址。部署並把登記改成 dedicated、設定改成 status=deployed 之後才能跑 keeper（docs/TENANT_DEPLOYMENT.md §5）。" >&2
  exit 1
fi
L_ORACLE="" L_EXCHANGE="" L_EXPECTED="" L_VAULT="" L_KIND="" L_RELAY="" L_BREAKER="" L_SYMBOLS=""
while IFS='=' read -r k v; do
  case "$k" in
    KEEPER_ORACLE_ADDRESS) L_ORACLE="$v" ;;
    EXCHANGE) L_EXCHANGE="$v" ;;
    KEEPER_EXPECTED_ADDRESS) L_EXPECTED="$v" ;;
    KEEPER_VAULT_ADDRESS) L_VAULT="$v" ;;
    KEEPER_ORACLE_KIND) L_KIND="$v" ;;
    KEEPER_RELAY_SOURCE) L_RELAY="$v" ;;
    KEEPER_BREAKER_DEVIATION) L_BREAKER="$v" ;;
    FUNDING_SYMBOLS) L_SYMBOLS="$v" ;;
    *) echo "✖ load-env 輸出了不認得的鍵：$k" >&2; exit 1 ;;
  esac
done <<< "$ENV_LINES"
[[ -n "$L_ORACLE" && -n "$L_EXCHANGE" && -n "$L_EXPECTED" && -n "$L_KIND" && -n "$L_SYMBOLS" ]] \
  || { echo "✖ load-env 少了必要的鍵" >&2; exit 1; }

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[[ "$CHAIN_ID" == "84532" ]] || { echo "✖ KEEPER_RPC_URL 指向 chainId $CHAIN_ID，不是 Base Sepolia（84532）" >&2; exit 1; }

# 2. 參考來源：設定的值必須等於 oracle 鏈上的 referenceSource()（與租戶 workflow 相同的檢查）。
ZERO=0x0000000000000000000000000000000000000000
if [[ "$L_KIND" == "guarded" ]]; then
  WANT="$(echo "${L_RELAY:-$ZERO}" | tr '[:upper:]' '[:lower:]')"
  GOT="$(cast call "$L_ORACLE" "referenceSource()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')"
  [[ "$WANT" == "$GOT" ]] || { echo "✖ oracle 的 referenceSource() 是 $GOT，設定預期 $WANT" >&2; exit 1; }
fi

# 3. keystore 推出的地址必須是設定的 roles.keeper（只印地址）。
ADDR="$(cast wallet address --account "$ACCOUNT" --password-file "$PASSWORD_FILE")"
if [[ "$(echo "$ADDR" | tr '[:upper:]' '[:lower:]')" != "$(echo "$L_EXPECTED" | tr '[:upper:]' '[:lower:]')" ]]; then
  echo "✖ keystore $ACCOUNT 的地址 $ADDR 不是 $TENANT 的 roles.keeper（$L_EXPECTED）。不送任何交易。" >&2
  exit 1
fi
BAL="$(cast balance "$ADDR" --rpc-url "$RPC" --ether)"
echo "keeper $ADDR 餘額 $BAL ETH；oracle $L_ORACLE；exchange $L_EXCHANGE；marketOperator=$( (( MARKET_OPERATOR )) && echo on || echo off)"

cd "$REPO_ROOT/agent"

# keeper/run.ts 的完整環境：env -i 清空，只放白名單。第一個參數 dry|live。
keeper_env() {
  local mode="$1"
  local -a e=(
    "PATH=$PATH" "HOME=$HOME"
    "KEEPER_CHAIN=base-sepolia" "KEEPER_RPC_URL=$RPC" "KEEPER_TENANT=$TENANT"
    "KEEPER_HEARTBEAT=240"
    "KEEPER_ORACLE_ADDRESS=$L_ORACLE" "EXCHANGE=$L_EXCHANGE" "FUNDING_SYMBOLS=$L_SYMBOLS"
    "KEEPER_MARKET_OPERATOR=$MARKET_OPERATOR"
  )
  [[ -n "${TMPDIR:-}" ]] && e+=("TMPDIR=$TMPDIR")
  [[ -n "$L_VAULT" ]] && e+=("KEEPER_VAULT_ADDRESS=$L_VAULT")
  [[ -n "$L_RELAY" ]] && e+=("KEEPER_RELAY_SOURCE=$L_RELAY")
  [[ -n "$L_BREAKER" ]] && e+=("KEEPER_BREAKER_DEVIATION=$L_BREAKER")
  if [[ "$mode" == dry ]]; then
    e+=("DRY_RUN=1")
  else
    e+=("KEEPER_KEYSTORE=$KEYSTORE" "KEEPER_KEYSTORE_PASSWORD_FILE=$PASSWORD_FILE")
  fi
  printf '%s\0' "${e[@]}"
}

# 一輪：摘要行 available=… failed=N；非零結束、找不到摘要或 failed≠0 都算失敗。
run_round() {
  local mode="$1" log status=0 failed
  local -a envv=()
  while IFS= read -r -d '' x; do envv+=("$x"); done < <(keeper_env "$mode")
  log="$(mktemp)"
  env -i "${envv[@]}" npx tsx keeper/run.ts >"$log" 2>&1 || status=$?
  cat "$log"
  failed="$(grep -E '^available=[0-9]+ .*failed=[0-9]+$' "$log" | tail -1 | sed -n 's/.*failed=\([0-9]*\).*/\1/p')"
  rm -f "$log"
  if (( status != 0 )); then echo "✖ keeper/run.ts 以 exit $status 結束" >&2; return 1; fi
  if [[ -z "$failed" ]]; then echo "✖ 找不到 keeper 摘要行" >&2; return 1; fi
  if (( failed != 0 )); then echo "✖ 本輪 failed=$failed" >&2; return 1; fi
  return 0
}

# 4. 啟動前先乾跑一輪（不需要金鑰、不送交易）。
echo "── DRY_RUN 一輪 ──"
run_round dry || { echo "✖ DRY_RUN 沒有全過，不開始送交易" >&2; exit 1; }

trap 'echo; echo "keeper 結束"; exit 0' INT TERM

while :; do
  echo "── $(date '+%F %T') 送出一輪 ──"
  if ! run_round live; then
    (( ONCE )) && exit 1
    echo "（本輪失敗，${INTERVAL} 秒後重試）" >&2
  fi
  (( ONCE )) && exit 0
  sleep "$INTERVAL"
done
