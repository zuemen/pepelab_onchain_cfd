#!/usr/bin/env bash
# besu/scripts/e2e.sh
# 一鍵端到端：在 `docker compose up -d` 之後執行。
#   等節點出塊 → 部署（deploy.sh，沿用 Deploy.s.sol）→ e2e.mjs（推價 → 開倉 → 下跌 → keeper 清算 → 讀回）
# 成功 exit 0；任何一步失敗 exit 非 0。完整輸出同時寫到 besu/logs/e2e-<時間>.log。
#
# 用法：bash scripts/e2e.sh                 （或 npm run e2e）
#       E2E_SKIP_DEPLOY=1 bash scripts/e2e.sh  沿用既有 deployments/<chainId>.json，不重新部署
set -euo pipefail

BESU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${BESU_RPC_URL:-http://127.0.0.1:8545}"
mkdir -p "$BESU_DIR/logs"
LOG="$BESU_DIR/logs/e2e-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$LOG") 2>&1

[[ -d "$BESU_DIR/node_modules/viem" ]] || { echo "✖ 請先在 besu/ 執行 npm ci" >&2; exit 1; }

# ── 等節點出塊（QBFT 4 個驗證者互連後才會開始出塊）────────────────────────────
rpc() { curl -s -m 5 -X POST -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC_URL" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).result??""))}catch{}})'; }

echo "▶ 等待 $RPC_URL 出塊…"
first=""
for i in $(seq 1 90); do
  bn="$(rpc eth_blockNumber || true)"
  if [[ -n "$bn" ]]; then
    if [[ -z "$first" ]]; then first="$bn"
    elif [[ "$((bn))" -gt "$((first))" ]]; then
      echo "  節點已出塊：block $((first)) → $((bn))，peers=$(( $(rpc net_peerCount) ))"
      break
    fi
  fi
  sleep 2
  if [[ "$i" -eq 90 ]]; then
    echo "✖ 3 分鐘內沒有新區塊。請看 docker compose logs node1（常見原因見 README「常見錯誤」）。" >&2
    exit 1
  fi
done

# ── 部署 ─────────────────────────────────────────────────────────────────────
if [[ "${E2E_SKIP_DEPLOY:-0}" != "1" ]]; then
  bash "$BESU_DIR/scripts/deploy.sh"
fi

# ── 端到端情境 ───────────────────────────────────────────────────────────────
node "$BESU_DIR/scripts/e2e.mjs"
echo "（完整紀錄：$LOG）"
