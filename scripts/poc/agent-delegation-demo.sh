#!/usr/bin/env bash
# SSI 委託授權 × x402 KYA PoC（可錄影）—— docs/SSI_AGENT_DELEGATION.md §錄製步驟。
#
#   bash scripts/poc/agent-delegation-demo.sh
#
# 只在本機：自己起一條 anvil（預設 port 8645，用完就關）、用既有的 contracts/script/Deploy.s.sol
# 部署整套合約，再用 DeploySessionCredentialAnchor.s.sol 部署錨定合約，最後跑
# agent/examples/agent-delegation-poc.ts（每一步都有中文說明）。
#
# 不連公開鏈、不用公開 facilitator、不動真錢、不讀 .env。部署用 anvil 的解鎖帳號 #0（--unlocked），
# 不需要任何私鑰。x402 結算是本機假 facilitator（會驗 EIP-3009 簽章、但不上鏈），見 PoC 腳本開頭的說明。
#
# 前置：foundry（forge、anvil）、agent/ 已 `npm ci`、node ≥ 20。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${POC_ANVIL_PORT:-8645}"
RPC="http://127.0.0.1:${PORT}"
DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # anvil 解鎖帳號 #0（公開測試帳號）
FORGE="${FORGE:-forge}"; ANVIL="${ANVIL:-anvil}"
command -v "$FORGE" >/dev/null || FORGE="$HOME/.foundry/bin/forge"
command -v "$ANVIL" >/dev/null || ANVIL="$HOME/.foundry/bin/anvil"

LOG="$(mktemp -t pepelab-poc-anvil.XXXXXX)"
"$ANVIL" --port "$PORT" --chain-id 31337 --silent >"$LOG" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; rm -f "$LOG"; echo "（anvil 已關閉）"; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "▶ 部署合約到本機 anvil（$RPC，chainId 31337）…（第一次要編譯，約數分鐘）"
cd "$ROOT/contracts"
# 只編譯這兩支部署腳本與它們依賴的合約：其餘 script／test 跳過（via_ir 全量編譯很慢、很吃記憶體）。
# --offline：本機 PoC 不需要網路；斷網時 forge 會卡在對外查詢。
SKIP=(--skip test)
for f in script/*.s.sol; do
  b="$(basename "$f")"
  case "$b" in Deploy.s.sol|DeploySessionCredentialAnchor.s.sol) ;; *) SKIP+=(--skip "$b") ;; esac
done
"$FORGE" script script/Deploy.s.sol --offline "${SKIP[@]}" --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent >/dev/null
BROADCAST="$ROOT/contracts/broadcast/Deploy.s.sol/31337/run-latest.json"
addr() { node -e "const j=require(process.argv[1]);const t=j.transactions.find(x=>x.transactionType==='CREATE'&&x.contractName===process.argv[2]);if(!t)process.exit(1);console.log(t.contractAddress)" "$BROADCAST" "$1"; }
MANAGER="$(addr AgentSessionManager)"; EXCHANGE="$(addr PerpetualExchange)"; USDC="$(addr MockUSDC)"

SESSION_MANAGER_ADDR="$MANAGER" "$FORGE" script script/DeploySessionCredentialAnchor.s.sol \
  --offline "${SKIP[@]}" --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent >/dev/null
ANCHOR="$(node -e "const j=require(process.argv[1]);console.log(j.transactions.find(x=>x.contractName==='SessionCredentialAnchor').contractAddress)" \
  "$ROOT/contracts/broadcast/DeploySessionCredentialAnchor.s.sol/31337/run-latest.json")"

printf '  %-24s %s\n' AgentSessionManager "$MANAGER" PerpetualExchange "$EXCHANGE" MockUSDC "$USDC" SessionCredentialAnchor "$ANCHOR"

cd "$ROOT/agent"
POC_RPC_URL="$RPC" POC_SESSION_MANAGER="$MANAGER" POC_SESSION_ANCHOR="$ANCHOR" POC_EXCHANGE="$EXCHANGE" POC_USDC="$USDC" \
  npx tsx examples/agent-delegation-poc.ts
