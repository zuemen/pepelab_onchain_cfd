#!/usr/bin/env bash
# scripts/poc/rwa-poc-market-mode.sh — 手動把 RWA PoC 某檔資產切成 Active（0）或 ReduceOnly（1）。
#
#   PerpetualExchange.setAssetMode(bytes32,uint8)。marketOperator（＝keeper）只能在 Active 與 ReduceOnly
#   之間切（Halted 只有 owner／guardian），所以這支只接受 0／1。先 `cast call --from` 模擬，過了才送。
#   exchange 與註冊資產只從 ops/tenant-keeper/load-env.mjs 讀（與 keeper 同一個來源），不寫死、不吃殼層變數。
#   docs/tenants/rwa-poc/RUNBOOK.md
#
# 用法（repo 根目錄）：
#   bash scripts/poc/rwa-poc-market-mode.sh sAAPL 1     # 休市：只能平倉、不能開新倉
#   bash scripts/poc/rwa-poc-market-mode.sh sAAPL 0     # 回到 Active
# 環境變數：KEEPER_RPC_URL（預設 https://sepolia.base.org）、POC_TENANT（預設 rwa-poc）、
#           POC_MODE_ACCOUNT（預設 pepelab-rwa-keeper；guardian 鎖住時要用 admin 的 keystore 才能放寬）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TENANT="${POC_TENANT:-rwa-poc}"
ACCOUNT="${POC_MODE_ACCOUNT:-pepelab-rwa-keeper}"
RPC="${KEEPER_RPC_URL:-https://sepolia.base.org}"
SYM="${1:-}"
MODE="${2:-}"
[[ "$SYM" =~ ^s[A-Z]{2,6}$ ]] || { echo "用法：$0 <資產代號，例如 sAAPL> <0=Active|1=ReduceOnly>" >&2; exit 2; }
[[ "$MODE" == "0" || "$MODE" == "1" ]] || { echo "✖ 模式只能是 0（Active）或 1（ReduceOnly）" >&2; exit 2; }
[[ "$TENANT" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "✖ POC_TENANT 不是租戶 id" >&2; exit 2; }
[[ "$ACCOUNT" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "✖ POC_MODE_ACCOUNT 格式不對" >&2; exit 2; }
[[ "$RPC" =~ ^https?:// ]] || { echo "✖ KEEPER_RPC_URL 必須是 http(s) 網址" >&2; exit 2; }
for c in cast node; do command -v "$c" >/dev/null || { echo "✖ 找不到 ${c}（Foundry 在 ~/.foundry/bin）" >&2; exit 1; }; done
# 外部指令在乾淨環境裡跑：只帶 PATH 與 HOME（cast 從 ~/.foundry 讀 keystore）。
clean() { env -i PATH="$PATH" HOME="$HOME" "$@"; }
PASSWORD_FILE="$HOME/.foundry/$ACCOUNT.password"
[[ -f "$PASSWORD_FILE" ]] || { echo "✖ 找不到密碼檔：$PASSWORD_FILE" >&2; exit 1; }

if ! ENV_LINES="$(clean node "$REPO_ROOT/ops/tenant-keeper/load-env.mjs" "$TENANT")"; then
  echo "✖ 讀不到 $TENANT 的位址（還沒部署？登記要是 dedicated、設定要是 status=deployed）" >&2
  exit 1
fi
EX="" SYMBOLS=""
while IFS='=' read -r k v; do
  case "$k" in
    EXCHANGE) EX="$v" ;;
    FUNDING_SYMBOLS) SYMBOLS="$v" ;;
  esac
done <<< "$ENV_LINES"
[[ "$EX" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✖ load-env 沒有給 EXCHANGE" >&2; exit 1; }
[[ " $SYMBOLS " == *" $SYM "* ]] || { echo "✖ $SYM 不是 $TENANT 註冊的資產（${SYMBOLS}）" >&2; exit 1; }

CHAIN_ID="$(clean cast chain-id --rpc-url "$RPC")"
[[ "$CHAIN_ID" == "84532" ]] || { echo "✖ RPC 指向 chainId ${CHAIN_ID}，不是 Base Sepolia（84532）" >&2; exit 1; }

FROM="$(clean cast wallet address --account "$ACCOUNT" --password-file "$PASSWORD_FILE")"
AID="$(clean cast keccak "$SYM")"
NAMES=(Active ReduceOnly Halted)
CUR="$(clean cast call "$EX" "assetMode(bytes32)(uint8)" "$AID" --rpc-url "$RPC")"
echo "exchange $EX  $SYM 目前 ${NAMES[$CUR]:-$CUR} → 要切成 ${NAMES[$MODE]}（簽署者 ${FROM}）"
if [[ "$CUR" == "$MODE" ]]; then echo "已經是 ${NAMES[$MODE]}，不送交易"; exit 0; fi

echo "── 模擬（cast call --from）──"
clean cast call "$EX" "setAssetMode(bytes32,uint8)" "$AID" "$MODE" --from "$FROM" --rpc-url "$RPC" >/dev/null \
  || { echo "✖ 模擬失敗，不送交易（簽署者是不是 marketOperator？guardian 是否鎖住了這檔？）" >&2; exit 1; }
echo "模擬通過"

echo "── 送出 ──"
OUT="$(clean cast send "$EX" "setAssetMode(bytes32,uint8)" "$AID" "$MODE" \
  --account "$ACCOUNT" --password-file "$PASSWORD_FILE" --rpc-url "$RPC" --json)"
HASH="$(clean node -e 'const r=JSON.parse(process.argv[1]); console.log(r.transactionHash + " status=" + r.status)' "$OUT")"
echo "tx $HASH"
echo "https://sepolia.basescan.org/tx/${HASH%% *}"
NEW="$(clean cast call "$EX" "assetMode(bytes32)(uint8)" "$AID" --rpc-url "$RPC")"
echo "$SYM 現在是 ${NAMES[$NEW]:-$NEW}"
[[ "$NEW" == "$MODE" ]] || { echo "✖ 讀回的模式與預期不同" >&2; exit 1; }
