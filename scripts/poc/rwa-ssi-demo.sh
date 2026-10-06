#!/usr/bin/env bash
# scripts/poc/rwa-ssi-demo.sh — 一鍵 PoC：可驗證憑證（VC）准入的 RWA 市場（docs/SSI_RWA_ACCESS.md §8）
#
#   起 anvil（本機、獨立 port）→ 沿用 Deploy.s.sol 部署整套 → DeployVCKycRegistry.s.sol 部署 VC 登錄並接到 exchange
#   → 發證者簽發合格投資人 VC → 未持證開 sAAPL 被拒 → 提交 attestation → 開倉成功
#   → 發證者撤銷（狀態清單＋鏈上）→ 再開倉被拒、平倉成功 → 關閉 anvil
#
# 用法（repo 根目錄）：bash scripts/poc/rwa-ssi-demo.sh
# 前置：Foundry（forge／anvil／cast）、Node ≥ 20、agent/ 已 npm ci、contracts/lib 已有 OpenZeppelin。
# 環境變數：POC_PORT（預設 8547，避開常用的 8545）
#
# 只連本機 anvil。用到的私鑰是 anvil 內建、全世界公開的開發帳戶（與 deploy-anvil.sh 相同），
# 在任何公開鏈上都不能、也不該使用。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/scripts/poc/.out"
PORT="${POC_PORT:-8547}"
RPC="http://127.0.0.1:$PORT"

# anvil 預設助記詞（全世界公開的開發助記詞）的前三個帳戶：0 = 部署者／exchange owner，1 = 發證者，2 = 投資人。
# 用 cast 現場推導，不在檔案裡寫私鑰字串。
ANVIL_MNEMONIC="test test test test test test test test test test test junk"
dev_key() { cast wallet private-key --mnemonic "$ANVIL_MNEMONIC" --mnemonic-index "$1"; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
for c in forge anvil cast node; do command -v "$c" >/dev/null || { echo "✖ 找不到 $c" >&2; exit 1; }; done
[[ -d "$REPO_ROOT/agent/node_modules" ]] || { echo "✖ 請先在 agent/ 執行 npm ci" >&2; exit 1; }
ANVIL_PK0="$(dev_key 0)"; ANVIL_PK1="$(dev_key 1)"; ANVIL_PK2="$(dev_key 2)"

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "✖ $RPC 已經有節點在跑；換一個 POC_PORT，或先關掉它（這支腳本不會去關別人的節點）" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

ANVIL_PID=""
cleanup() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
    echo "■ anvil（pid $ANVIL_PID）已關閉"
  fi
}
trap cleanup EXIT INT TERM

say "▶ 0. 起本機 anvil（port $PORT）"
anvil --port "$PORT" --silent > "$OUT/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[[ "$CHAIN_ID" == "31337" ]] || { echo "✖ chainId 不是 31337：$CHAIN_ID" >&2; exit 1; }
echo "  anvil pid $ANVIL_PID，chainId $CHAIN_ID"

cd "$REPO_ROOT/contracts"
# 廣播紀錄放 PoC 自己的目錄，不碰 contracts/broadcast/（正式部署紀錄）。
export FOUNDRY_BROADCAST="../scripts/poc/.out/broadcast"

say "▶ 1. 沿用 Deploy.s.sol 部署整套協議（exchange、oracle、USDC、舊 KYCRegistry…）"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$ANVIL_PK0" --broadcast > "$OUT/deploy.log" 2>&1 \
  || { tail -30 "$OUT/deploy.log"; exit 1; }
RUN1="$OUT/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
addr_of() { node -e "const r=require(process.argv[1]);const t=r.transactions.find(x=>x.transactionType==='CREATE'&&x.contractName===process.argv[2]);if(!t)process.exit(1);process.stdout.write(t.contractAddress)" "$1" "$2"; }
EXCHANGE="$(addr_of "$RUN1" PerpetualExchange)"
USDC="$(addr_of "$RUN1" MockUSDC)"
echo "  PerpetualExchange $EXCHANGE"
echo "  MockUSDC          $USDC"

say "▶ 2. DeployVCKycRegistry.s.sol：部署 VC 登錄、信任發證者、以既有 setter 接到 exchange（sAAPL／sTSLA 為 RWA）"
ISSUER_ADDR="$(cast wallet address --private-key "$ANVIL_PK1")"
VC_KYC_ISSUER="$ISSUER_ADDR" VC_KYC_WIRE_EXCHANGE=true EXCHANGE="$EXCHANGE" VC_KYC_RWA_ASSETS="sAAPL,sTSLA" \
  forge script script/DeployVCKycRegistry.s.sol:DeployVCKycRegistry --rpc-url "$RPC" --private-key "$ANVIL_PK0" --broadcast \
  > "$OUT/deploy-vc-kyc.log" 2>&1 || { tail -30 "$OUT/deploy-vc-kyc.log"; exit 1; }
RUN2="$OUT/broadcast/DeployVCKycRegistry.s.sol/$CHAIN_ID/run-latest.json"
REGISTRY="$(addr_of "$RUN2" VCKycRegistry)"
echo "  VCKycRegistry     $REGISTRY"
node -e "const r=require(process.argv[1]);for(const t of r.transactions)console.log('  tx '+t.hash+'  '+(t.contractName||'')+' '+(t.function||t.transactionType))" "$RUN2"
echo "  exchange.kyc() = $(cast call "$EXCHANGE" 'kyc()(address)' --rpc-url "$RPC")"

say "▶ 3. 發證、提交、開倉、撤銷、平倉（agent/issuer）"
cd "$REPO_ROOT/agent"
ISSUER_PRIVATE_KEY="$ANVIL_PK1" INVESTOR_PRIVATE_KEY="$ANVIL_PK2" \
  npx tsx issuer/poc.ts --rpc "$RPC" --exchange "$EXCHANGE" --registry "$REGISTRY" --usdc "$USDC" --out "$OUT"

say "▶ 4. 結束：關閉 anvil"
