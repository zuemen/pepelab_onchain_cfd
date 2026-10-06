#!/usr/bin/env bash
# RWA＋SSI PoC：產生前端本機設定 frontend/.env.rwa-poc.local，讓 `yarn dev --mode rwa-poc`
# 連到 rwa-poc 專屬部署（docs/tenants/rwa-poc/）。預設展示站（沒設 VITE_TENANT）不受影響。
#
#   scripts/poc/rwa-poc-frontend.sh [--anchor 0x…] [--signal-api URL] [--status-url URL] [--print]
#   cd frontend && yarn dev --mode rwa-poc
#
# 位址一律不手打：合約位址由 frontend/src/contracts/deployments/rwa-poc.json（由
# check-tenant-deploy.mjs --print-frontend 產生、CI 對帳過的 dedicated 登記）在建置時讀入，
# 這支只寫「登記裡沒有」的東西：
#   VITE_SESSION_ANCHOR_ADDRESS   SessionCredentialAnchor（不在 DeployTenant 紀錄裡）。
#                                 --anchor 優先，否則讀 docs/tenants/rwa-poc/DEPLOYMENT.md
#                                 中「SessionCredentialAnchor」那一行的位址。
#   VITE_SESSION_ANCHOR_CHAIN_ID  84532（覆寫只套用到這條鏈）
#   VITE_SIGNAL_API_URL           本機 signal-api（預設 http://localhost:4021；專屬部署不得退回平台的）
#   VITE_VC_STATUS_URL            選用：撤銷狀態清單的公開目錄
#   VITE_SHOW_PERPETUALS/LEVERAGE 錄影要示範開倉與槓桿上限
# VC 准入登錄不必設 VITE_VC_KYC_REGISTRY：前端探測租戶的 KYCRegistry 是不是 VCKycRegistry。
#
# 產生的檔案被根目錄 .gitignore 的 `.env.*.local` 排除，不會進版控；裡面沒有任何私鑰。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TENANT=rwa-poc
REG="$ROOT/frontend/src/contracts/deployments/$TENANT.json"
DOC="$ROOT/docs/tenants/$TENANT/DEPLOYMENT.md"
OUT="$ROOT/frontend/.env.$TENANT.local"
ANCHOR=""
SIGNAL_API="http://localhost:4021"
STATUS_URL=""
PRINT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --anchor) ANCHOR="${2:-}"; shift 2 ;;
    --signal-api) SIGNAL_API="${2:-}"; shift 2 ;;
    --status-url) STATUS_URL="${2:-}"; shift 2 ;;
    --print) PRINT=1; shift ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "::error::不認得的參數 $1" >&2; exit 2 ;;
  esac
done

is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] && [ "$1" != "0x0000000000000000000000000000000000000000" ]; }

[ -f "$REG" ] || { echo "::error::找不到 ${REG}" >&2; exit 1; }
KIND="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).kind))' "$REG")"
if [ "$KIND" != "dedicated" ]; then
  echo "::error::${REG} 的 kind 是 ${KIND}：rwa-poc 還沒部署（廣播並讀回驗證後，用 check-tenant-deploy.mjs --print-frontend 產生 dedicated 登記）" >&2
  exit 1
fi

if [ -z "$ANCHOR" ] && [ -f "$DOC" ]; then
  ANCHOR="$(grep -E 'SessionCredentialAnchor' "$DOC" | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)"
fi
if [ -n "$ANCHOR" ] && ! is_addr "$ANCHOR"; then
  echo "::error::--anchor 不是位址：$ANCHOR" >&2
  exit 2
fi
[[ "$SIGNAL_API" =~ ^https?:// ]] || { echo "::error::--signal-api 必須是 http(s) URL" >&2; exit 2; }

body="$(cat <<EOF
# 由 scripts/poc/rwa-poc-frontend.sh 產生；不進版控（.env.*.local）。重新產生會覆寫。
VITE_TENANT=$TENANT
VITE_SIGNAL_API_URL=$SIGNAL_API
VITE_SHOW_PERPETUALS=1
VITE_SHOW_LEVERAGE=1
VITE_SESSION_ANCHOR_CHAIN_ID=84532
VITE_SESSION_ANCHOR_ADDRESS=$ANCHOR
VITE_VC_STATUS_URL=$STATUS_URL
EOF
)"

if [ "$PRINT" = 1 ]; then
  printf '%s\n' "$body"
  exit 0
fi
printf '%s\n' "$body" > "$OUT"
( cd "$ROOT" && git check-ignore -q "frontend/.env.$TENANT.local" ) || {
  echo "::error::frontend/.env.$TENANT.local 沒有被 .gitignore 排除——不要 commit 它" >&2
  exit 1
}
echo "寫入 frontend/.env.$TENANT.local（已被 .gitignore 排除）"
[ -n "$ANCHOR" ] || echo "注意：沒有 SessionCredentialAnchor 位址，/sessions 能簽發 v3 憑證但無法錨定（用 --anchor 補上）"
echo "啟動：cd frontend && yarn dev --mode $TENANT"
