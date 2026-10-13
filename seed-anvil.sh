#!/usr/bin/env bash
# 已過時（2026-10）：這支腳本配的是只有 4 個資產的 Deploy.s.sol，而且會把
# frontend/src/contracts/addresses.ts 的本機鏈區塊寫回只有 7 個欄位的舊格式（型別檢查會失敗）。
# 本機部署請改用 contracts/script/DeployLocalDemo.s.sol + agent/heroes/writeAddresses.ts，
# 或直接跑 scripts/heroes-replay.sh。見 heroes/README.md。
echo "deploy-anvil.sh／seed-anvil.sh 已過時，請改用 scripts/heroes-replay.sh（見 heroes/README.md）" >&2
exit 1
# seed-anvil.sh — populate Anvil with demo traders after deploy-anvil.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
RPC_URL="http://localhost:8545"
# Anvil account #0 default private key (never use in production)
PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
CHAIN_ID=31337

BROADCAST="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

if [[ ! -f "$BROADCAST" ]]; then
  echo "ERROR: No broadcast found at $BROADCAST" >&2
  echo "       Run 'bash deploy-anvil.sh' first." >&2
  exit 1
fi

USDC=$(jq -r '.transactions[] | select(.contractName=="MockUSDC") | .contractAddress' "$BROADCAST")
REG=$(jq -r '.transactions[] | select(.contractName=="StrategyRegistry") | .contractAddress' "$BROADCAST")
CT=$(jq -r '.transactions[] | select(.contractName=="CopyTracker") | .contractAddress' "$BROADCAST")
TS=$(jq -r '.transactions[] | select(.contractName=="TraderStake") | .contractAddress' "$BROADCAST")

echo "Using USDC=$USDC, Registry=$REG, CopyTracker=$CT, TraderStake=$TS"
echo ""

cd "$CONTRACTS_DIR"
USDC_ADDR="$USDC" REGISTRY_ADDR="$REG" TRACKER_ADDR="$CT" STAKE_ADDR="$TS" \
  forge script script/Seed.s.sol \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  -v

echo ""
echo "Seed complete. Open http://localhost:5173/marketplace to see Demo Alpha + Demo Beta + Demo Gamma."
