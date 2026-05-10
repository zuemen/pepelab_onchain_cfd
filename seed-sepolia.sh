#!/usr/bin/env bash
# seed-sepolia.sh — populate Sepolia with demo traders after deploy-sepolia.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
CHAIN_ID=11155111

if [[ -f "$CONTRACTS_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$CONTRACTS_DIR/.env"; set +a
fi

: "${PRIVATE_KEY:?PRIVATE_KEY not set in contracts/.env}"
: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL not set in contracts/.env}"

BROADCAST="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

if [[ ! -f "$BROADCAST" ]]; then
  echo "ERROR: No Sepolia broadcast found at $BROADCAST" >&2
  echo "       Run 'bash deploy-sepolia.sh' first." >&2
  exit 1
fi

USDC=$(jq -r '.transactions[] | select(.contractName=="MockUSDC") | .contractAddress' "$BROADCAST")
REG=$(jq -r '.transactions[] | select(.contractName=="StrategyRegistry") | .contractAddress' "$BROADCAST")
CT=$(jq -r '.transactions[] | select(.contractName=="CopyTracker") | .contractAddress' "$BROADCAST")

echo "Using USDC=$USDC, Registry=$REG, CopyTracker=$CT"
echo ""

cd "$CONTRACTS_DIR"
USDC_ADDR="$USDC" REGISTRY_ADDR="$REG" TRACKER_ADDR="$CT" \
TRADER2_PK="${TRADER2_PK:-0}" \
TRADER3_PK="${TRADER3_PK:-0}" \
  forge script script/Seed.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  -vvv

echo ""
echo "Seed complete. Vercel frontend will show demo traders on /marketplace."
echo "(To add Demo Beta / Gamma on Sepolia: set TRADER2_PK / TRADER3_PK in contracts/.env)"
