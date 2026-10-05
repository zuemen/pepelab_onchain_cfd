#!/usr/bin/env bash
# besu/scripts/fork-test.sh
# 用 `forge test --fork-url` 對 Besu 節點跑完整的既有測試套件。
#
# 重要：fork 模式下「執行 EVM 的是 forge（revm）」，不是 Besu。forge 只透過 JSON-RPC
# 向 Besu 讀狀態（eth_getCode／eth_getStorageAt／eth_getBalance…）與區塊環境（chainId、
# timestamp、gasLimit、baseFee），交易從頭到尾都在 forge 的記憶體裡執行，不會上鏈。
# 所以它驗證的是「測試在 Besu 的鏈環境與狀態上仍成立」，而不是「Besu 的 EVM 執行結果正確」；
# 後者由 e2e.sh（真的對 Besu 送交易）負責。
#
# 測試套件很大：via-IR 全量編譯可能超過 15 分鐘、吃數 GB 記憶體；不要同時跑多個 forge。
# 省記憶體：fork 只需要 node1 的唯讀狀態，可先 `docker compose stop node2 node3 node4`（QBFT 會停止出塊，不影響釘住的 fork 區塊）。
# 用法：bash scripts/fork-test.sh [其他 forge test 參數，例如 --match-contract Foo]
# 輸出：besu/logs/fork-test-<時間>.log，最後印出通過／失敗／略過數。
set -euo pipefail

BESU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$BESU_DIR/../contracts"
RPC_URL="${BESU_RPC_URL:-http://127.0.0.1:8545}"
mkdir -p "$BESU_DIR/logs"
LOG="$BESU_DIR/logs/fork-test-$(date +%Y%m%d-%H%M%S).log"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")" || { echo "✖ 連不到 $RPC_URL" >&2; exit 1; }
case "$CHAIN_ID" in
  1|11155111|17000|560048|8453|84532|10|42161|137|80002)
    echo "✖ chainId $CHAIN_ID 是公開鏈；這支腳本只對本地 Besu 跑。" >&2; exit 1 ;;
esac
FORK_BLOCK="$(cast block-number --rpc-url "$RPC_URL")"
echo "▶ forge test --fork-url $RPC_URL（chainId $CHAIN_ID，fork block $FORK_BLOCK，$(cast rpc web3_clientVersion --rpc-url "$RPC_URL" | tr -d '"')）"
echo "  紀錄：$LOG"

cd "$CONTRACTS_DIR"
set +e
# 釘住 fork 區塊：整個套件讀同一個狀態；Besu 端是 FOREST 儲存（--profile=ENTERPRISE），舊區塊狀態不會被修剪。
forge test --fork-url "$RPC_URL" --fork-block-number "$FORK_BLOCK" "$@" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e

# forge 每個測試檔最後一行是 "Suite result: ok. N passed; M failed; K skipped"；最後還有總計行。
echo
grep -E "^Ran [0-9]+ test suites" "$LOG" | tail -1 || true
echo "forge exit code: $rc"
exit "$rc"
