#!/usr/bin/env bash
# besu/scripts/deploy-vc-kyc.sh
# 在本地 Besu（QBFT）上加裝 VC 准入的 KYC 登錄（docs/SSI_RWA_ACCESS.md），接在 deploy.sh 之後執行。
#
#   1. 確認連到的是本機產生的 Besu 網路（與 deploy.sh 同一道 check-rpc.mjs 白名單）
#   2. 讀 deployments/<chainId>.json 取得 PerpetualExchange
#   3. forge script DeployVCKycRegistry.s.sol：部署登錄、信任 VC_KYC_ISSUER、
#      deployer 是 exchange owner 時以既有 setter 接上（setKycRegistry、setRwaAsset）
#   4. 寫 deployments/<chainId>.vc-kyc.json（只有位址）
#
# 用法（在 besu/ 底下）：VC_KYC_ISSUER=0x… bash scripts/deploy-vc-kyc.sh
# 環境變數：BESU_RPC_URL（預設 http://127.0.0.1:8545）、VC_KYC_ISSUER（必填：發證機構的地址）、
#           VC_KYC_RWA_ASSETS（預設 sAAPL,sTSLA；Besu 上要「所有市場都要 KYC」就列出全部四個）、
#           VC_KYC_REQUIRED_TYPE（預設 QUALIFIED_INVESTOR）
# 不改 deploy.sh、不改任何既有合約方法；發證者金鑰不在這裡（它屬於機構的 KMS，見 ADR-014）。
set -euo pipefail

BESU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BESU_DIR/.." && pwd)"
RPC_URL="${BESU_RPC_URL:-http://127.0.0.1:8545}"
ACCOUNTS="$BESU_DIR/network/accounts.json"

command -v forge >/dev/null || { echo "✖ 找不到 forge" >&2; exit 1; }
command -v node  >/dev/null || { echo "✖ 找不到 node" >&2; exit 1; }
[[ -f "$ACCOUNTS" ]] || { echo "✖ 找不到 $ACCOUNTS，請先 npm run gen" >&2; exit 1; }
[[ -n "${VC_KYC_ISSUER:-}" ]] || { echo "✖ 請設定 VC_KYC_ISSUER（發證機構地址）" >&2; exit 1; }

GUARD="$(BESU_RPC_URL="$RPC_URL" node "$BESU_DIR/scripts/check-rpc.mjs")" || exit 1
CHAIN_ID="${GUARD%% *}"
DEPLOYMENT="$BESU_DIR/deployments/$CHAIN_ID.json"
[[ -f "$DEPLOYMENT" ]] || { echo "✖ 找不到 $DEPLOYMENT，請先 bash scripts/deploy.sh" >&2; exit 1; }

acct() { node -e "const a=require(process.argv[1]); process.stdout.write(a[process.argv[2]][process.argv[3]])" "$ACCOUNTS" "$1" "$2"; }
DEPLOYER_PK="$(acct deployer privateKey)"
DEPLOYER="$(acct deployer address)"
EXCHANGE="$(node -e "process.stdout.write(require(process.argv[1]).contracts.PerpetualExchange)" "$DEPLOYMENT")"

echo "▶ VC 准入登錄 → $RPC_URL（chainId $CHAIN_ID）"
echo "  deployer $DEPLOYER｜exchange $EXCHANGE｜issuer $VC_KYC_ISSUER"

cd "$REPO_ROOT/contracts"
export FOUNDRY_BROADCAST="../besu/.forge-broadcast"
VC_KYC_CHAIN_ID="$CHAIN_ID" VC_KYC_WIRE_EXCHANGE=true EXCHANGE="$EXCHANGE" \
  forge script script/DeployVCKycRegistry.s.sol:DeployVCKycRegistry \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" --broadcast --slow -v

RUN_JSON="$BESU_DIR/.forge-broadcast/DeployVCKycRegistry.s.sol/$CHAIN_ID/run-latest.json"
OUT="$BESU_DIR/deployments/$CHAIN_ID.vc-kyc.json"
node - "$RUN_JSON" "$OUT" "$CHAIN_ID" "$EXCHANGE" "$VC_KYC_ISSUER" <<'NODE'
const fs = require('fs');
const [runJson, outPath, chainId, exchange, issuer] = process.argv.slice(2);
const run = JSON.parse(fs.readFileSync(runJson, 'utf8'));
const tx = run.transactions.find((t) => t.transactionType === 'CREATE' && t.contractName === 'VCKycRegistry');
if (!tx) throw new Error('廣播紀錄裡沒有 VCKycRegistry');
const out = { chainId: Number(chainId), VCKycRegistry: tx.contractAddress, exchange, issuer, deployedAt: new Date(run.timestamp * 1000).toISOString() };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`  VCKycRegistry ${tx.contractAddress} → ${outPath}`);
NODE
echo "✔ 完成。前端以 VITE_VC_KYC_REGISTRY 指向上面的位址；發證服務見 agent/issuer/cli.ts。"
