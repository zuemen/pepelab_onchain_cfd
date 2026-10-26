# shellcheck shell=bash
# 本機 Anvil 上 `forge script --broadcast` 的看門狗。scripts/demo-autosync.sh 與 agent/copy-sync/anvil-e2e.sh 共用（source）。
#
# 為什麼：DeployLocalDemo 的廣播曾經實測卡死 22 分鐘。forge 沒加 --slow 時一次預派多筆交易，Anvil 的 txpool 留著一段
# nonce 斷層（pending 0、queued 54），之後的交易永遠不會被打包，forge 卻一直等收據。兩支腳本都改加 --slow（一筆上鏈
# 再送下一筆，比照 scripts/heroes-replay.sh），這裡再加兩道上限，不靠 CI job 的 45 分鐘逾時：
#   - 停滯：廣播已經開始（部署者 nonce > 0，或 txpool 裡有交易），而且連續 FORGE_DEPLOY_STALL 秒（預設 90）
#     區塊號碼與部署者 nonce 都沒動 → 判定卡死。Anvil 自動出塊，--slow 下每一筆幾乎立刻上鏈，正常情況不會停這麼久；
#     編譯期間還沒廣播（nonce 0、txpool 空），不會誤判。
#   - 總時長：超過 FORGE_DEPLOY_TIMEOUT 秒（預設 1200，含第一次 via_ir 編譯）→ 判定逾時。
# 任一成立就印出 txpool_status／txpool_inspect、區塊號碼、nonce 與 forge 日誌尾端，結束 forge，回傳 124。
#
# 用法：forge_broadcast_guarded <工作目錄> <日誌檔> <rpc> <部署者地址> -- <指令…>
#   指令在工作目錄裡執行，stdout／stderr 都寫進日誌檔；回傳值是指令自己的結束碼（或 124）。
#   只用在本機 Anvil：txpool_* 是 Anvil／geth 的除錯 RPC。

forge_broadcast_guarded() {
  local dir="$1" log="$2" rpc="$3" deployer="$4"
  shift 4
  [ "${1:-}" = "--" ] && shift
  local timeout="${FORGE_DEPLOY_TIMEOUT:-1200}" stall="${FORGE_DEPLOY_STALL:-90}" poll="${FORGE_DEPLOY_POLL:-3}"

  (cd "$dir" && exec "$@") >"$log" 2>&1 &
  local pid=$!
  local start=$SECONDS last_mark="" last_change=$SECONDS reason=""
  local block nonce pool pending queued
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$poll"
    kill -0 "$pid" 2>/dev/null || break
    block=$(cast block-number --rpc-url "$rpc" 2>/dev/null || echo "?")
    nonce=$(cast nonce "$deployer" --rpc-url "$rpc" 2>/dev/null || echo "?")
    pool=$(cast rpc txpool_status --rpc-url "$rpc" 2>/dev/null || echo "{}")
    pending=$(printf '%s' "$pool" | sed -nE 's/.*"pending":"?(0x[0-9a-fA-F]+|[0-9]+)"?.*/\1/p')
    queued=$(printf '%s' "$pool" | sed -nE 's/.*"queued":"?(0x[0-9a-fA-F]+|[0-9]+)"?.*/\1/p')
    pending=$((${pending:-0})); queued=$((${queued:-0}))
    if [ "$block/$nonce" != "$last_mark" ]; then last_mark="$block/$nonce"; last_change=$SECONDS; fi
    if [ $((SECONDS - start)) -gt "$timeout" ]; then
      reason="超過 ${timeout} 秒還沒結束（FORGE_DEPLOY_TIMEOUT）"
      break
    fi
    if { [ "$nonce" != "?" ] && [ "$nonce" -gt 0 ]; } || [ $((pending + queued)) -gt 0 ]; then
      if [ $((SECONDS - last_change)) -gt "$stall" ]; then
        reason="廣播停滯：${stall} 秒內區塊與 nonce 都沒動（pending ${pending}、queued ${queued}，FORGE_DEPLOY_STALL）"
        break
      fi
    fi
  done

  if [ -n "$reason" ]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    {
      echo "::error::forge script 中止：$reason"
      echo "  區塊 $(cast block-number --rpc-url "$rpc" 2>/dev/null || echo '?')、部署者 ${deployer} 的 nonce $(cast nonce "$deployer" --rpc-url "$rpc" 2>/dev/null || echo '?')"
      echo "  txpool_status：$(cast rpc txpool_status --rpc-url "$rpc" 2>/dev/null || echo '讀不到')"
      echo "  txpool_inspect（前 4000 字）："
      cast rpc txpool_inspect --rpc-url "$rpc" 2>/dev/null | head -c 4000 || echo "  讀不到"
      echo
      echo "  forge 日誌尾端（${log}）："
      tail -20 "$log" 2>/dev/null || true
    } >&2
    return 124
  fi
  wait "$pid"
}
