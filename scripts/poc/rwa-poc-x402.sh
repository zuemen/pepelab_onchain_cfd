#!/usr/bin/env bash
# scripts/poc/rwa-poc-x402.sh — RWA PoC（Base Sepolia）的 x402 Know-Your-Agent 實測。docs/tenants/rwa-poc/X402_KYA.md
#
# 真鏈、真 facilitator（x402.org，Base Sepolia）、真測試 USDC。位址不寫死：session manager 讀
# deploy/tenants/rwa-poc.deployed.json，錨定合約讀 docs/tenants/rwa-poc/DEPLOYMENT.md，收款地址與代理人地址由
# keystore 解出（~/.foundry/keystores/pepelab-rwa-<名稱>，密碼檔 ~/.foundry/pepelab-rwa-<名稱>.password）。
# 私鑰只在 node／cast 的行程記憶體裡解開，不經過環境變數、指令列或檔案。
#
# 用法（repo 根目錄）：
#   bash scripts/poc/rwa-poc-x402.sh server            # 前景啟動本機 signal-api（port 4021，KYA on），Ctrl-C 結束
#   bash scripts/poc/rwa-poc-x402.sh setup <label> <maxPerPeriod> <maxTotal>
#                                                     # 開 session＋簽發 v3 憑證＋錨定（上限為 atomic USDC，6 位小數）
#   bash scripts/poc/rwa-poc-x402.sh call <label> <vp|novp> [次數]
#   bash scripts/poc/rwa-poc-x402.sh balance           # 代理人的 Base Sepolia USDC
#   bash scripts/poc/rwa-poc-x402.sh pay [label]       # 一鍵案例 (c)：確認 USDC ≥ 0.02 與 server 在線 → 帶 VP 付費 3 次
#                                                     #   （預設 label=main：0.02 上限 → 前 2 次結算成功、第 3 次超額被拒）
# 環境變數：RWA_POC_RPC_URL（預設 https://sepolia.base.org）、SIGNAL_API_PORT（預設 4021）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${SIGNAL_API_PORT:-4021}"
RPC="${RWA_POC_RPC_URL:-https://sepolia.base.org}"
API="http://localhost:${PORT}"
STATE="$ROOT/agent/.state/rwa-poc"
export PATH="$PATH:$HOME/.foundry/bin"

[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "✖ SIGNAL_API_PORT 必須是數字" >&2; exit 2; }
[[ "$RPC" =~ ^https?:// ]] || { echo "✖ RWA_POC_RPC_URL 必須是 http(s) 網址" >&2; exit 2; }
for c in cast node npx; do command -v "$c" >/dev/null || { echo "✖ 找不到 ${c}" >&2; exit 1; }; done
[[ -d "$ROOT/agent/node_modules" ]] || { echo "✖ 請先在 agent/ 執行 npm ci" >&2; exit 1; }

wallet_addr() {
  cast wallet address --account "pepelab-rwa-$1" --password-file "$HOME/.foundry/pepelab-rwa-$1.password"
}
# 乾淨環境：殼層裡殘留的 PRIVATE_KEY、PAY_TO、X402_* 等都進不去。
clean() { env -i PATH="$PATH" HOME="$HOME" "$@"; }
driver() {
  (cd "$ROOT/agent" && clean RWA_POC_RPC_URL="$RPC" RWA_POC_SIGNAL_API="$API" npx tsx examples/rwa-poc-x402.ts "$@")
}

cmd="${1:-}"; shift || true
case "$cmd" in
  server)
    MANAGER="$(node -e 'const j=require(process.argv[1]);if(j.chainId!==84532)process.exit(1);console.log(j.contracts.AgentSessionManager)' "$ROOT/deploy/tenants/rwa-poc.deployed.json")"
    ANCHOR="$(grep -E '^\| SessionCredentialAnchor \|' "$ROOT/docs/tenants/rwa-poc/DEPLOYMENT.md" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
    [[ "$MANAGER" =~ ^0x[0-9a-fA-F]{40}$ && "$ANCHOR" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✖ 讀不到 session manager／錨定合約位址" >&2; exit 1; }
    BOUND="$(cast call "$ANCHOR" 'sessionManager()(address)' -r "$RPC")"
    [[ "$(echo "$BOUND" | tr A-F a-f)" == "$(echo "$MANAGER" | tr A-F a-f)" ]] || { echo "✖ 錨定合約綁的 manager（${BOUND}）與部署紀錄不同" >&2; exit 1; }
    PAY_TO="$(wallet_addr payto)"
    # ADR-016 狀態清單目錄：本機持久目錄（agent/.state 已被 gitignore），只在第一次建立標記。
    mkdir -p "$STATE"
    if [[ ! -f "$STATE/vc-status/index.json" ]]; then
      (cd "$ROOT/agent" && clean npx tsx examples/vc-status.ts init --dir "$STATE/vc-status")
    fi
    echo "▶ signal-api：port ${PORT}、PAY_TO=${PAY_TO:0:6}…${PAY_TO: -4}、KYA on（錨定 required）、facilitator https://x402.org/facilitator（Base Sepolia）"
    cd "$ROOT/agent"
    exec env -i PATH="$PATH" HOME="$HOME" \
      SIGNAL_API_PORT="$PORT" AGENT_CHAIN_ID=84532 X402_NETWORK=base-sepolia \
      BASE_SEPOLIA_RPC_URL="$RPC" KYA_RPC_URL="$RPC" \
      PAY_TO="$PAY_TO" \
      X402_KYA_MODE=on X402_KYA_ANCHOR=required X402_KYA_SPEND_STORE=memory \
      SESSION_MANAGER_ADDRESS="$MANAGER" SESSION_ANCHOR_ADDRESS="$ANCHOR" \
      VC_STATUS_DIR="$STATE/vc-status" VC_STATUS_STATE_PATH="$STATE/vc-status-state.json" \
      CORS_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:4173" \
      npx tsx signal-api/src/index.ts
    ;;
  setup) [[ $# -eq 3 ]] || { echo "用法：setup <label> <maxPerPeriod> <maxTotal>" >&2; exit 2; }; driver setup "$@" ;;
  call) driver call "$@" ;;
  balance) driver balance ;;
  pay)
    LABEL="${1:-main}"
    [[ -f "$STATE/x402/$LABEL.json" ]] || { echo "✖ 沒有 $LABEL 的憑證，先跑：bash $0 setup $LABEL 20000 20000" >&2; exit 1; }
    curl -sf "$API/healthz" >/dev/null 2>&1 || { echo "✖ signal-api 沒在 $API 上，先在另一個終端機跑：bash $0 server" >&2; exit 1; }
    USDC="$(driver balance | sed -n 's/^RESULT balance atomic=\([0-9]*\)$/\1/p')"
    [[ "$USDC" =~ ^[0-9]+$ ]] || { echo "✖ 讀不到代理人 USDC 餘額" >&2; exit 1; }
    (( USDC >= 20000 )) || { echo "✖ 代理人 USDC 只有 ${USDC} atomic（需要 ≥ 20000 = 0.02）：到 https://faucet.circle.com 領 Base Sepolia USDC" >&2; exit 1; }
    echo "▶ 代理人 USDC ${USDC} atomic；帶 VP 付費呼叫 3 次（憑證上限 0.02 → 預期 200、200、403 kya_spend_limit_exceeded）"
    driver call "$LABEL" vp 3
    ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
