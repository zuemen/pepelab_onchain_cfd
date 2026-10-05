#!/usr/bin/env bash
# besu/scripts/deploy.sh
# 把 PepeLab 全部合約部署到本地 Besu（QBFT）網路。
#
# 沿用既有的 contracts/script/Deploy.s.sol（與 deploy-anvil.sh、deploy-base-sepolia.sh 同一支），
# 這裡只是 Besu 的包裝：
#   1. 確認連到的是本地鏈（拒絕任何公開鏈 chainId）
#   2. forge build
#   3. 用本機產生的 deployer 開發金鑰 forge script --broadcast
#      （廣播紀錄導到 besu/.forge-broadcast/，不寫進 contracts/broadcast/ 的正式部署紀錄）
#   4. 從 run-latest.json 取出位址，寫 besu/deployments/<chainId>.json
#   5. 角色分離：MockOracle 的 owner 用既有的 transferOwnership 轉給本機 oracle 帳戶
#      （推價腳本用它簽名；deployer 之後不再能寫價）
#
# 用法：bash scripts/deploy.sh            （在 besu/ 底下，或用 npm run deploy）
# 環境變數：BESU_RPC_URL（預設 http://127.0.0.1:8545）
set -euo pipefail

BESU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BESU_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
RPC_URL="${BESU_RPC_URL:-http://127.0.0.1:8545}"
ACCOUNTS="$BESU_DIR/network/accounts.json"

command -v forge >/dev/null || { echo "✖ 找不到 forge（請安裝 Foundry）" >&2; exit 1; }
command -v cast  >/dev/null || { echo "✖ 找不到 cast（請安裝 Foundry）" >&2; exit 1; }
command -v node  >/dev/null || { echo "✖ 找不到 node" >&2; exit 1; }
[[ -f "$ACCOUNTS" ]] || { echo "✖ 找不到 $ACCOUNTS，請先 npm run gen" >&2; exit 1; }

# 用 node 讀 JSON（不依賴 jq）。
acct() { node -e "const a=require(process.argv[1]); process.stdout.write(a[process.argv[2]][process.argv[3]])" "$ACCOUNTS" "$1" "$2"; }

# ── 0. 只允許本地鏈 ───────────────────────────────────────────────────────────
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)" || {
  echo "✖ 連不到 $RPC_URL。請先在 besu/ 執行 docker compose up -d，並等節點開始出塊。" >&2; exit 1; }
case "$CHAIN_ID" in
  1|11155111|17000|560048|8453|84532|10|42161|137|80002)
    echo "✖ chainId $CHAIN_ID 是公開鏈；這支腳本只部署到本地 Besu。" >&2; exit 1 ;;
esac
EXPECTED_CHAIN_ID="$(node -e "process.stdout.write(String(require(process.argv[1]).chainId))" "$ACCOUNTS")"
if [[ "$CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]]; then
  echo "✖ 節點 chainId=$CHAIN_ID，但 network/accounts.json 是給 chainId=$EXPECTED_CHAIN_ID 的。" >&2
  echo "  是不是連到別的節點（例如 anvil 也佔了 8545）？" >&2
  exit 1
fi

DEPLOYER_PK="$(acct deployer privateKey)"
DEPLOYER="$(acct deployer address)"
ORACLE_SIGNER="$(acct oracle address)"
CLIENT_VERSION="$(cast rpc web3_clientVersion --rpc-url "$RPC_URL" | tr -d '"')"
echo "▶ 部署到 $RPC_URL（chainId $CHAIN_ID，$CLIENT_VERSION）"
echo "  deployer = $DEPLOYER"

# ── 1. 編譯 ──────────────────────────────────────────────────────────────────
echo "[1/4] forge build（第一次全量編譯 via-IR 很久，請耐心等）"
cd "$CONTRACTS_DIR"
forge build

# ── 2. 部署（沿用 Deploy.s.sol）─────────────────────────────────────────────
echo "[2/4] forge script script/Deploy.s.sol --broadcast"
# FOUNDRY_BROADCAST：forge 的 `broadcast` 設定（相對 contracts/），把本地鏈的紀錄留在 besu/ 底下。
# --slow：每筆交易等收據再送下一筆；QBFT 有 2 秒出塊，比一次灌進交易池更穩定、錯誤也比較好讀。
export FOUNDRY_BROADCAST="../besu/.forge-broadcast"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PK" \
  --broadcast \
  --slow \
  -v

RUN_JSON="$BESU_DIR/.forge-broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$RUN_JSON" ]] || { echo "✖ 找不到廣播紀錄 $RUN_JSON" >&2; exit 1; }

# ── 3. 寫 deployments/<chainId>.json ─────────────────────────────────────────
echo "[3/4] 寫入 besu/deployments/$CHAIN_ID.json"
mkdir -p "$BESU_DIR/deployments"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
node - "$RUN_JSON" "$BESU_DIR/deployments/$CHAIN_ID.json" "$CHAIN_ID" "$CLIENT_VERSION" "$COMMIT" "$ACCOUNTS" <<'NODE'
const fs = require('fs');
const [runJson, outPath, chainId, clientVersion, commit, accountsPath] = process.argv.slice(2);
const run = JSON.parse(fs.readFileSync(runJson, 'utf8'));
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
const contracts = {};
for (const tx of run.transactions) {
  if (tx.transactionType !== 'CREATE') continue;
  if (contracts[tx.contractName]) throw new Error(`同名合約部署了兩次：${tx.contractName}`);
  contracts[tx.contractName] = tx.contractAddress;
}
const required = ['MockUSDC', 'MockOracle', 'InsuranceVault', 'FeeRouter', 'PerpetualExchange',
  'StrategyRegistry', 'CopyTracker', 'TraderStake', 'AgentSessionManager', 'KYCRegistry'];
for (const n of required) if (!contracts[n]) throw new Error(`廣播紀錄裡沒有 ${n}`);
const blocks = run.receipts.map((r) => Number(BigInt(r.blockNumber)));
const out = {
  network: 'besu-qbft-local',
  chainId: Number(chainId),
  client: clientVersion,
  commit,
  deployedAt: new Date(run.timestamp * 1000).toISOString(),
  fromBlock: Math.min(...blocks),
  toBlock: Math.max(...blocks),
  transactions: run.transactions.length,
  // 只放位址，不放私鑰（私鑰只在 network/accounts.json）。
  roles: Object.fromEntries(
    ['deployer', 'oracle', 'keeper', 'trader', 'lp'].map((r) => [r, accounts[r].address]),
  ),
  contracts,
  assets: ['sBTC', 'sETH', 'sAAPL', 'sTSLA'],
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
for (const [k, v] of Object.entries(contracts)) console.log(`  ${k.padEnd(24)} ${v}`);
NODE

# ── 4. 角色分離：MockOracle owner → oracle 帳戶 ─────────────────────────────
echo "[4/4] MockOracle.transferOwnership → oracle 帳戶 $ORACLE_SIGNER"
ORACLE_ADDR="$(node -e "process.stdout.write(require(process.argv[1]).contracts.MockOracle)" "$BESU_DIR/deployments/$CHAIN_ID.json")"
cast send "$ORACLE_ADDR" "transferOwnership(address)" "$ORACLE_SIGNER" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" >/dev/null
OWNER_NOW="$(cast call "$ORACLE_ADDR" "owner()(address)" --rpc-url "$RPC_URL")"
# 用 tr 轉小寫（macOS 內建 bash 3.2 不支援 ${var,,}）。
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
if [[ "$(lc "$OWNER_NOW")" != "$(lc "$ORACLE_SIGNER")" ]]; then
  echo "✖ MockOracle owner 是 $OWNER_NOW，不是 oracle 帳戶 $ORACLE_SIGNER" >&2; exit 1
fi

# 合約大小：PerpetualExchange 必須在 EIP-170 上限內（genesis contractSizeLimit=24576）。
EXCHANGE_ADDR="$(node -e "process.stdout.write(require(process.argv[1]).contracts.PerpetualExchange)" "$BESU_DIR/deployments/$CHAIN_ID.json")"
CODE_HEX="$(cast code "$EXCHANGE_ADDR" --rpc-url "$RPC_URL")"
echo "✔ 部署完成。PerpetualExchange 鏈上 runtime = $(( (${#CODE_HEX} - 2) / 2 )) bytes（上限 24576）"
echo "  位址檔：besu/deployments/$CHAIN_ID.json"
