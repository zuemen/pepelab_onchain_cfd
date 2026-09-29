#!/usr/bin/env bash
# create-session.sh — 在 Base Sepolia 的 AgentSessionManager 建一個受限 session，
# 授權 agent EOA 在額度內代下單，並印出 DEMO_SESSION_ID 供 agent/.env 使用。
#
# 用法（在 repo 根目錄）：
#   export RPC_URL=https://sepolia.base.org
#   export USER_PK=0x<建立 session 的使用者私鑰（=持有 freeMargin 的帳戶）>
#   export AGENT_ADDR=0x<被授權的 agent EOA 地址>
#   export SESSION_ASSETS=sBTC,sETH        # 選用；資產白名單（預設 sBTC,sETH）
#   bash create-session.sh
#
# 需要：cast（Foundry）、jq。
#
# 前置：使用者需先在 PerpetualExchange 存過保證金（depositMargin），agent 開倉時才有
#       freeMargin 可用。AgentSessionManager 已在部署時被 setAgentAuthorized(true)。
set -euo pipefail

: "${RPC_URL:?set RPC_URL}"
: "${USER_PK:?set USER_PK}"
: "${AGENT_ADDR:?set AGENT_ADDR}"
command -v cast >/dev/null || { echo "需要 cast（Foundry）" >&2; exit 1; }
command -v jq >/dev/null || { echo "需要 jq" >&2; exit 1; }

# Base Sepolia 現行 AgentSessionManager（可用 SESSION_MGR 覆寫）。
#
# 2026-09-29 更正：這裡原本寫 0x4E7cC1B79B72ab72531a6C790e14304370f70764 —— 那個 manager
# 綁的是**舊** exchange 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072，在上面建的 session
# 下單會打到已退役的交易所。現行 manager 來源：
#   contracts/broadcast/Redeploy129Exchange.s.sol/84532/run-latest.json（AgentSessionManager）
# 鏈上核對：exchange() == 0x827eA0c62a32e995927101259042F8A27D99124D（現行 PerpetualExchange，
# = frontend/src/contracts/addresses.ts BASE_SEPOLIA.PerpetualExchange），且該 exchange 的
# authorizedAgents(本 manager) == true。
SESSION_MGR="${SESSION_MGR:-0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B}"

# Session 參數（可改）：每筆最高保證金 / 總額度 / 槓桿上限 / 到期
MAX_PER_TRADE="${MAX_PER_TRADE:-50000000000000000000}"   # 50e18
TOTAL_BUDGET="${TOTAL_BUDGET:-200000000000000000000}"    # 200e18
MAX_LEV="${MAX_LEV:-5}"                                  # ≤ MAX_LEVERAGE
EXPIRY="${EXPIRY:-$(( $(date +%s) + 7*24*3600 ))}"       # 7 天後

# 資產白名單：symbol → assetId = keccak256(symbol)（與 Deploy.s.sol / addresses.ts ASSET_IDS 一致）。
# 用 createSessionWithAssets：沒有白名單的 session 可以把整個額度押在使用者從沒打算持有的資產上。
SESSION_ASSETS="${SESSION_ASSETS:-sBTC,sETH}"
ASSET_IDS=()
IFS=',' read -r -a _syms <<< "$SESSION_ASSETS"
for s in "${_syms[@]}"; do
  s="$(echo "$s" | tr -d '[:space:]')"
  [ -n "$s" ] || continue
  ASSET_IDS+=("$(cast keccak "$s")")
done
if [ "${#ASSET_IDS[@]}" -eq 0 ]; then
  echo "SESSION_ASSETS 為空——拒絕建立沒有資產白名單的 session。" >&2
  exit 1
fi
ASSETS_ARG="[$(IFS=','; echo "${ASSET_IDS[*]}")]"

echo "Creating session on $SESSION_MGR"
echo "  agent=$AGENT_ADDR  perTrade=$MAX_PER_TRADE  budget=$TOTAL_BUDGET  maxLev=$MAX_LEV  expiry=$EXPIRY"
echo "  assets=$SESSION_ASSETS"

# session id 從**這筆交易 receipt 的 SessionCreated 事件**讀取。
# 舊版是送交易前先讀 nextSessionId() —— 期間若有別人也建了 session，印出來的 id 就是
# 別人的（race）。事件是這筆交易自己的輸出，不會錯。
RECEIPT_JSON="$(cast send "$SESSION_MGR" \
  "createSessionWithAssets(address,uint256,uint256,uint256,uint256,bytes32[])" \
  "$AGENT_ADDR" "$MAX_PER_TRADE" "$TOTAL_BUDGET" "$MAX_LEV" "$EXPIRY" "$ASSETS_ARG" \
  --rpc-url "$RPC_URL" --private-key "$USER_PK" --json)"

# tr -d '\r'：Windows 上的 jq 會輸出 CRLF。
STATUS="$(echo "$RECEIPT_JSON" | jq -r '.status' | tr -d '\r')"
TX="$(echo "$RECEIPT_JSON" | jq -r '.transactionHash' | tr -d '\r')"
if [ "$STATUS" != "0x1" ] && [ "$STATUS" != "1" ]; then
  echo "❌ 交易失敗（status=$STATUS）：$TX" >&2
  exit 1
fi

TOPIC0="$(cast sig-event "SessionCreated(uint256,address,address,uint256,uint256)")"
MGR_LC="$(echo "$SESSION_MGR" | tr '[:upper:]' '[:lower:]')"
SID_HEX="$(echo "$RECEIPT_JSON" | jq -r --arg a "$MGR_LC" --arg t "$TOPIC0" \
  '[.logs[] | select((.address|ascii_downcase)==$a and (.topics[0]|ascii_downcase)==$t)][0].topics[1] // empty' | tr -d '\r')"
if [ -z "$SID_HEX" ]; then
  echo "❌ 交易 $TX 的 receipt 裡找不到 SessionCreated 事件，無法確定 session id。" >&2
  exit 1
fi
SESSION_ID="$(cast to-dec "$SID_HEX")"

echo ""
echo "✅ Session 建立成功（tx $TX）。把這些填進 agent/.env："
echo "   SESSION_MANAGER_ADDRESS=$SESSION_MGR"
echo "   DEMO_SESSION_ID=$SESSION_ID"
