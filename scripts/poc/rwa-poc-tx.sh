#!/usr/bin/env bash
# RWA PoC：先模擬再送出一筆交易，輸出給錄影的「終端機畫面」看（docs/tenants/rwa-poc/POC_SCRIPT.md）。
#
#   bash scripts/poc/rwa-poc-tx.sh <錢包名稱> <ok|fail|fail-send> <說明> <to> <函式簽名> [參數…]
#     ok         模擬必須通過 → 以 keystore 送出，必須 status 1
#     fail       模擬必須 revert → 只印 revert 原因，不送出
#     fail-send  模擬必須 revert → 以固定 gas（跳過預估）送出，留下 status 0 的鏈上證據
#   環境變數：VALUE（msg.value，wei）、GAS_LIMIT（fail-send 用，預設 600000）、RWA_POC_RPC_URL
#
# 金鑰：~/.foundry/keystores/pepelab-rwa-<名稱>＋~/.foundry/pepelab-rwa-<名稱>.password，只經 cast 的
# --account／--password-file 使用，私鑰不經過環境變數、指令列或檔案。
# 輸出裡的 `tx 0x…` 會被錄影工具轉成 BaseScan 連結。
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
R="${RWA_POC_RPC_URL:-https://sepolia.base.org}"
[ $# -ge 5 ] || { sed -n '4,9p' "$0"; exit 2; }
name=$1; mode=$2; label=$3; to=$4; sig=$5; shift 5
case "$mode" in ok|fail|fail-send) ;; *) echo "✖ 模式只能是 ok／fail／fail-send" >&2; exit 2 ;; esac
[[ "$name" =~ ^[a-z0-9-]+$ ]] || { echo "✖ 錢包名稱不合法" >&2; exit 2; }
ACCT=(--account "pepelab-rwa-$name" --password-file "$HOME/.foundry/pepelab-rwa-$name.password")
from=$(cast wallet address "${ACCT[@]}")
[ "$(cast chain-id -r "$R")" = "84532" ] || { echo "✖ RPC 不是 Base Sepolia" >&2; exit 1; }
VAL=(); [ -n "${VALUE:-}" ] && VAL=(--value "$VALUE")

# 已知的自訂錯誤（只用來把 revert data 翻成人看得懂的名字）
ERRORS=(
  "NotKycVerified(address)" "AssetNotActive(bytes32,uint8)" "MarginExceedsPerTradeCap()" "BudgetExceeded()"
  "LeverageExceedsSessionCap()" "AssetNotAllowed(uint256,bytes32)" "SessionIsRevoked()" "SessionExpired()"
  "NotSessionAgent()" "CredentialIsRevoked(bytes32)" "StalePrice(bytes32,uint256)" "MarginTooLow()"
  "InsufficientMargin()" "LeverageTooHigh()"
)
decode() {
  local data=$1 sel=${1:0:10} e
  for e in "${ERRORS[@]}"; do
    if [ "$(cast sig "$e")" = "$sel" ]; then
      local args; args=$(cast decode-error --sig "$e" "$data" 2>/dev/null | paste -sd, - || true)
      echo "${e%%(*}(${args})"; return
    fi
  done
  echo "$data"
}

echo "▶ ${label}"
echo "  模擬：cast call --from ${from:0:6}…${from: -4} ${to:0:6}…${to: -4} \"${sig}\""
set +e
sim=$(cast call "$to" "$sig" "$@" --from "$from" ${VAL[@]+"${VAL[@]}"} -r "$R" 2>&1)
simrc=$?
set -e
if [ $simrc -eq 0 ]; then
  echo "  ✓ 模擬通過"
  [ "$mode" = ok ] || { echo "  ✖ 預期會被拒，但模擬通過了——停止，不送出"; exit 1; }
else
  data=$(echo "$sim" | grep -oE '0x[0-9a-fA-F]{8,}' | tail -1 || true)
  echo "  ✖ 模擬 revert：$( [ -n "$data" ] && decode "$data" || echo "$sim" | tail -1)"
  [ "$mode" != ok ] || { echo "  ✖ 預期會成功，但模擬 revert——停止，不送出"; exit 1; }
  if [ "$mode" = fail ]; then echo "  （只保留模擬結果，沒有送出交易）"; exit 0; fi
fi

GAS=()
if [ "$mode" = fail-send ]; then
  GAS=(--gas-limit "${GAS_LIMIT:-600000}")
  echo "  送出：固定 gas ${GAS_LIMIT:-600000}（跳過預估），讓「被拒」留下鏈上紀錄"
else
  echo "  送出：cast send（keystore pepelab-rwa-${name}）"
fi
set +e
out=$(cast send "$to" "$sig" "$@" ${VAL[@]+"${VAL[@]}"} ${GAS[@]+"${GAS[@]}"} "${ACCT[@]}" -r "$R" --json 2>&1)
rc=$?
set -e
h=$(echo "$out" | grep -oE '"transactionHash":"0x[0-9a-fA-F]{64}"' | grep -oE '0x[0-9a-fA-F]{64}' | head -1 || true)
st=$(echo "$out" | grep -oE '"status":"0x[01]"' | grep -oE '0x[01]' | head -1 || true)
if [ -z "$h" ]; then echo "  ✖ 送出失敗：$(echo "$out" | tail -1 | cut -c1-200)"; exit 1; fi
if [ "$st" = "0x1" ]; then
  echo "  tx ${h}  status 1（成功）"
  [ "$mode" = ok ] || { echo "  ✖ 預期失敗卻成功"; exit 1; }
else
  echo "  tx ${h}  status 0（被合約拒絕，符合預期）"
  [ "$mode" = fail-send ] || exit 1
fi
[ $rc -eq 0 ] || [ "$mode" = fail-send ] || exit 1
