#!/usr/bin/env bash
# deploy-sepolia.sh
# 部署所有合約到 Sepolia testnet，並更新 frontend/src/contracts/addresses.ts
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
FRONTEND_CONTRACTS="$REPO_ROOT/frontend/src/contracts"
ADDRESSES_TS="$FRONTEND_CONTRACTS/addresses.ts"
CHAIN_ID=11155111

# ── Load .env ─────────────────────────────────────────────────────────────────
if [[ -f "$CONTRACTS_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$CONTRACTS_DIR/.env"; set +a
else
  echo "ERROR: $CONTRACTS_DIR/.env not found. Copy .env.example and fill in values." >&2
  exit 1
fi

: "${PRIVATE_KEY:?PRIVATE_KEY not set in contracts/.env}"
: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL not set in contracts/.env}"

# ── 1. Build ──────────────────────────────────────────────────────────────────
echo "[1/4] Building contracts..."
cd "$CONTRACTS_DIR"
forge build --silent

# ── 2. Deploy ─────────────────────────────────────────────────────────────────
echo "[2/4] Deploying to Sepolia (chainId $CHAIN_ID)..."
VERIFY_FLAGS=""
if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
  VERIFY_FLAGS="--verify --etherscan-api-key $ETHERSCAN_API_KEY"
fi

forge script script/Deploy.s.sol \
  --rpc-url     "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  $VERIFY_FLAGS \
  -vvv

# ── 3. Parse broadcast + update addresses.ts ──────────────────────────────────
echo "[3/4] Updating addresses.ts..."
BROADCAST="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

export BROADCAST_FILE="$BROADCAST"
export ADDRESSES_FILE="$ADDRESSES_TS"

python3 <<'PYEOF'
import json, re, os

bcast = json.load(open(os.environ["BROADCAST_FILE"]))
addrs = {
    tx["contractName"]: tx["contractAddress"]
    for tx in bcast["transactions"]
    if tx.get("transactionType") == "CREATE" and tx.get("contractName")
}

names = ["MockUSDC", "MockOracle", "TraderStake", "FeeRouter", "PerpetualExchange", "StrategyRegistry", "CopyTracker"]

print()
print("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
print("  Sepolia contract addresses:")
for n in names:
    print(f"    {(n + ':'):<22} {addrs.get(n, 'NOT FOUND')}")
print("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

with open(os.environ["ADDRESSES_FILE"]) as f:
    content = f.read()

z = "0x0000000000000000000000000000000000000000"
block = (
    "const SEPOLIA: ChainAddresses = {\n"
    + '  MockUSDC:          "' + addrs.get("MockUSDC",          z) + '",\n'
    + '  MockOracle:        "' + addrs.get("MockOracle",        z) + '",\n'
    + '  TraderStake:       "' + addrs.get("TraderStake",       z) + '",\n'
    + '  FeeRouter:         "' + addrs.get("FeeRouter",         z) + '",\n'
    + '  PerpetualExchange: "' + addrs.get("PerpetualExchange", z) + '",\n'
    + '  StrategyRegistry:  "' + addrs.get("StrategyRegistry",  z) + '",\n'
    + '  CopyTracker:       "' + addrs.get("CopyTracker",       z) + '",\n'
    + "}"
)

new_content = re.sub(
    r"const SEPOLIA: ChainAddresses = \{[^}]*\}",
    block,
    content,
    flags=re.DOTALL,
)

with open(os.environ["ADDRESSES_FILE"], "w") as f:
    f.write(new_content)

print("\n  addresses.ts updated ✓")
PYEOF

# ── 4. Export ABIs ─────────────────────────────────────────────────────────────
echo "[4/4] Exporting ABIs..."
mkdir -p "$FRONTEND_CONTRACTS/abi"
for name in MockUSDC MockOracle TraderStake FeeRouter PerpetualExchange StrategyRegistry CopyTracker; do
  python3 -c "
import json, sys
d = json.load(open('$CONTRACTS_DIR/out/$name.sol/$name.json'))
print(json.dumps(d['abi'], indent=2))
" > "$FRONTEND_CONTRACTS/abi/$name.json"
done

echo ""
echo "Sepolia deployment complete. Run 'npm run dev' in frontend/ to see the updated addresses."
