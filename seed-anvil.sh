#!/usr/bin/env bash
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

echo "Using USDC=$USDC, Registry=$REG"
echo ""

cd "$CONTRACTS_DIR"
USDC_ADDR="$USDC" REGISTRY_ADDR="$REG" \
  forge script script/Seed.s.sol \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  -v

echo ""
echo "Seed complete. Open http://localhost:5173/marketplace to see Demo Alpha + Demo Beta."
