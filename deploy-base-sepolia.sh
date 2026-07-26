#!/usr/bin/env bash
# Deploy the full PepeLab stack to Base Sepolia (chainId 84532).
#
# Secrets come ONLY from the environment — never hard-code or commit a key.
# Required:
#   PRIVATE_KEY            funded Base Sepolia deployer key (0x…)
#   BASE_SEPOLIA_RPC_URL   Base Sepolia RPC endpoint
# Optional:
#   BASESCAN_API_KEY       enables --verify on BaseScan
#   PYTH_CONTRACT          override the Base Sepolia Pyth address (showcase)
#
# Usage:
#   bash deploy-base-sepolia.sh            # DRY-RUN: simulate + print plan/gas
#   bash deploy-base-sepolia.sh --broadcast   # really send (after you confirm)
set -euo pipefail

cd "$(dirname "$0")/contracts"

: "${BASE_SEPOLIA_RPC_URL:?set BASE_SEPOLIA_RPC_URL}"

BROADCAST=""
VERIFY=""
if [[ "${1:-}" == "--broadcast" ]]; then
  : "${PRIVATE_KEY:?set PRIVATE_KEY to broadcast}"
  BROADCAST="--broadcast"
  if [[ -n "${BASESCAN_API_KEY:-}" ]]; then
    VERIFY="--verify"
  fi
  echo "▶ BROADCASTING to Base Sepolia (real transactions)…"
else
  echo "▶ DRY-RUN (simulation only — no transactions sent). Pass --broadcast to send."
fi

# Feed `yes` to stdin so any forge confirmation prompt (e.g. the EIP-170
# size-limit warning) auto-accepts under non-interactive Git Bash — it no
# longer hangs. PIPESTATUS preserves forge's real exit code despite the pipe.
set +o pipefail
yes | forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  ${PRIVATE_KEY:+--private-key "$PRIVATE_KEY"} \
  $BROADCAST $VERIFY \
  -vvv
rc=${PIPESTATUS[1]}
set -o pipefail
[ "$rc" -eq 0 ] || { echo "✖ forge script failed (exit $rc)"; exit "$rc"; }

echo "▶ Done. Copy the printed addresses into frontend/src/contracts/addresses.ts (BASE_SEPOLIA block)."
