#!/usr/bin/env bash
# scripts/poc/rwa-poc-verify.sh — RWA PoC 租戶（Base Sepolia，chainId 84532）全部合約的原始碼驗證。
#   結果與連結見 docs/tenants/rwa-poc/DEPLOYMENT.md「原始碼驗證」。
#
#   只送原始碼給區塊瀏覽器：不送任何鏈上交易、不需要任何私鑰。
#
#   合約清單、位址、建立交易、library 位址、部署當時的 commit 全部從已入庫的 broadcast 讀：
#     contracts/broadcast/tenants/rwa-poc/DeployTenant.s.sol/84532/run-latest.json
#     contracts/broadcast/tenants/rwa-poc/DeploySessionCredentialAnchor.s.sol/84532/run-latest.json
#   部署之後 contracts/ 改過的話，在暫時的 git worktree 取出部署當時的 commit 編譯，送出的原始碼就是鏈上那份
#   （GuardedOracle、AgentSessionManager 在部署後改過）。編譯設定（solc 0.8.36、via-ir、optimizer 200、
#   evm osaka）由該 commit 的 contracts/foundry.toml 決定。
#
#   Blockscout 與 Sourcify 送的是「從編譯產物的 metadata 重建的 standard JSON」（設定、remappings 與部署時
#   一字不差），所以 metadata hash 也對得上 → 完整比對（Blockscout full／Sourcify exact_match）。
#   forge verify-contract 會精簡 remappings，只拿得到部分比對，所以這兩個驗證器不經 forge。
#
#   驗證器：
#     Blockscout（https://base-sepolia.blockscout.com）、Sourcify —— 不需要 API key，預設都跑。
#     Etherscan V2（BaseScan）—— 只有環境裡有 ETHERSCAN_API_KEY 才跑（forge verify-contract）；
#     金鑰只從環境讀，不寫進任何檔案、不出現在指令列。
#   冪等：每個合約先查驗證器的 API，已完整比對就跳過；未驗證或只有部分比對才送出，再查 API，以 API 的結果為準。
#
# 用法（repo 根目錄）：
#   bash scripts/poc/rwa-poc-verify.sh                 # Blockscout＋Sourcify（＋有金鑰時 BaseScan）
#   bash scripts/poc/rwa-poc-verify.sh --check         # 只查狀態，不送原始碼
#   bash scripts/poc/rwa-poc-verify.sh --only blockscout,sourcify
#   ETHERSCAN_API_KEY=… bash scripts/poc/rwa-poc-verify.sh --only etherscan
# 結束碼：所選驗證器全部已驗證（含部分比對，總表標 ok*）→ 0；有任何一個未驗證 → 1。需要 forge、jq、curl、git、node。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAIN_ID=84532
BROADCAST_DIR="$REPO_ROOT/contracts/broadcast/tenants/rwa-poc"
RUNS=(
  "$BROADCAST_DIR/DeployTenant.s.sol/$CHAIN_ID/run-latest.json"
  "$BROADCAST_DIR/DeploySessionCredentialAnchor.s.sol/$CHAIN_ID/run-latest.json"
)
BLOCKSCOUT="https://base-sepolia.blockscout.com"
SOURCIFY="https://sourcify.dev/server"
ETHERSCAN_V2="https://api.etherscan.io/v2/api"
UA="pepelab-rwa-poc-verify (https://github.com/zuemen/pepelab_onchain_cfd)"

CHECK_ONLY=0
ONLY=""
while (($#)); do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "✖ 不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done

VERIFIERS=()
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a VERIFIERS <<<"$ONLY"
  for v in "${VERIFIERS[@]}"; do
    [[ "$v" =~ ^(blockscout|sourcify|etherscan)$ ]] || { echo "✖ --only 只接受 blockscout、sourcify、etherscan" >&2; exit 2; }
  done
else
  VERIFIERS=(sourcify blockscout)   # Sourcify 先：Blockscout 會自動匯入 Sourcify 的完整比對，多半不必再送
  [[ -n "${ETHERSCAN_API_KEY:-}" ]] && VERIFIERS+=(etherscan)
fi
for v in "${VERIFIERS[@]}"; do
  if [[ "$v" == etherscan && -z "${ETHERSCAN_API_KEY:-}" ]]; then
    echo "✖ 要跑 etherscan（BaseScan）得先 export ETHERSCAN_API_KEY" >&2; exit 2
  fi
done

export PATH="$HOME/.foundry/bin:$PATH"
for c in forge jq curl git node; do command -v "$c" >/dev/null || { echo "✖ 找不到 ${c}" >&2; exit 1; }; done
for r in "${RUNS[@]}"; do [[ -f "$r" ]] || { echo "✖ 找不到 broadcast：$r" >&2; exit 1; }; done
# contracts/foundry.toml 的 [etherscan] 引用了 BASESCAN_API_KEY；沒設時 forge 解析設定會失敗。
# 給空字串只為了讓設定能載入——BaseScan 一律明確傳 Etherscan V2 的網址，金鑰用 ETHERSCAN_API_KEY。
export BASESCAN_API_KEY="${BASESCAN_API_KEY:-}"
export ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rwa-poc-verify.XXXXXX")"
WORKTREES=()
cleanup() {
  for wt in "${WORKTREES[@]+"${WORKTREES[@]}"}"; do git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# macOS 內建 bash 3.2 沒有關聯陣列：對照表都是 $WORK 下的 TSV（key<TAB>value）。
lookup() { awk -F'\t' -v k="$2" '$1 == k { v = $2 } END { print v }' "$1"; }
ROOTS="$WORK/roots.tsv" RESULTS="$WORK/results.tsv" BUILT="$WORK/built.txt"
: >"$ROOTS"; : >"$RESULTS"; : >"$BUILT"

# ── 從 broadcast 組出合約清單 ──────────────────────────────────────────────────
# 每列：name, address, commit, libraries（逗號分隔，沒有時是 "-"）, 建立交易 hash, initcode（含建構子參數）
# （欄位不能留空：TAB 屬於 IFS 空白字元，read 會把連續的 TAB 併成一個。）
LIST="$WORK/contracts.tsv"
: >"$LIST"
for r in "${RUNS[@]}"; do
  jq -r '
    (.commit) as $c | ((.libraries // []) | if length == 0 then "-" else join(",") end) as $libs |
    .transactions[] | select(.transactionType == "CREATE" or .transactionType == "CREATE2")
    # CREATE2（library 經 CREATE2 deployer 部署）的 input 前 32 bytes 是 salt，後面才是 initcode。
    | (if .transactionType == "CREATE2" then "0x" + (.transaction.input | .[66:]) else .transaction.input end) as $init
    | [.contractName, (.contractAddress | ascii_downcase), $c, $libs, .hash, $init] | @tsv' "$r" >>"$LIST"
done
COUNT="$(wc -l <"$LIST" | tr -d ' ')"
(( COUNT > 0 )) || { echo "✖ broadcast 裡沒有任何 CREATE" >&2; exit 1; }

# ── 原始碼：每個部署 commit 一份 contracts/ 根目錄（要送原始碼時才準備）────────────
COMPILE_INPUTS=(contracts/src contracts/script contracts/foundry.toml contracts/lib)
root_for() { # $1 = 部署 commit → 設定 ROOT（要編譯的 contracts/ 目錄）
  local sha="$1" full wt
  ROOT="$(lookup "$ROOTS" "$sha")"
  [[ -n "$ROOT" ]] && return 0
  full="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${sha}^{commit}")" || { echo "✖ 部署的 commit ${sha} 解析不到（需要完整歷史）" >&2; return 1; }
  if git -C "$REPO_ROOT" diff --quiet "$full" HEAD -- "${COMPILE_INPUTS[@]}"; then
    ROOT="$REPO_ROOT/contracts"
    echo "  • ${sha}：部署之後 contracts/ 沒改過，用目前的原始碼"
  else
    # lib 是 submodule：worktree 不會帶出內容，從目前的 checkout 複製；前提是 submodule 指標沒變。
    git -C "$REPO_ROOT" diff --quiet "$full" HEAD -- contracts/lib || { echo "✖ ${sha} 之後 contracts/lib 的 submodule 指標變了，無法重用目前的 lib" >&2; return 1; }
    wt="$WORK/src-${sha}"
    git -C "$REPO_ROOT" worktree add --detach "$wt" "$full" >/dev/null 2>&1 || { echo "✖ git worktree add ${sha} 失敗" >&2; return 1; }
    WORKTREES+=("$wt")
    rm -rf "$wt/contracts/lib"
    cp -R "$REPO_ROOT/contracts/lib" "$wt/contracts/lib"
    ROOT="$wt/contracts"
    echo "  • ${sha}：部署之後 contracts/ 改過，用部署當時的原始碼（暫時 worktree）"
  fi
  printf '%s\t%s\n' "$sha" "$ROOT" >>"$ROOTS"
  echo "  • 編譯（forge build --skip test，第一次要幾分鐘）"
  if ! (cd "$ROOT" && forge build --skip test >"$WORK/build.log" 2>&1); then
    tail -n 30 "$WORK/build.log" >&2; echo "✖ forge build 失敗：$ROOT" >&2; return 1
  fi
}

[[ -f "$REPO_ROOT/contracts/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol" ]] \
  || { echo "✖ contracts/lib 的 submodule 沒取出：git submodule update --init --recursive contracts/lib" >&2; exit 1; }

artifact_of() { # $1 root $2 合約名稱 → 編譯產物 json（以 compilationTarget 認，ERC1967Proxy 在 OZ 的 lib 裡）
  local f
  while IFS= read -r f; do
    if jq -e --arg n "$2" '.metadata.settings.compilationTarget | to_entries | any(.value == $n)' "$f" >/dev/null 2>&1; then
      echo "$f"; return 0
    fi
  done < <(find "$1/out" -path "*.sol/$2.json" 2>/dev/null)
  return 1
}

# 從編譯產物的 metadata 重建 standard JSON input（sources 從原始碼檔讀，settings 照 metadata）。
cat >"$WORK/stdjson.mjs" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [root, art] = process.argv.slice(2);
const a = JSON.parse(readFileSync(art, "utf8"));
const meta = typeof a.rawMetadata === "string" ? JSON.parse(a.rawMetadata) : a.metadata;
const { compilationTarget, ...settings } = meta.settings;
const sources = {};
for (const p of Object.keys(meta.sources)) sources[p] = { content: readFileSync(join(root, p), "utf8") };
// metadata 的 libraries 是 {"path:Name": addr}，standard JSON 是 {path: {Name: addr}}
const libs = {};
for (const [k, v] of Object.entries(settings.libraries || {})) {
  const i = k.lastIndexOf(":");
  (libs[k.slice(0, i)] ||= {})[k.slice(i + 1)] = v;
}
settings.libraries = libs;
settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } };
const [[file, name]] = Object.entries(compilationTarget);
const spdx = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(sources[file].content)?.[1] ?? "";
const license = { MIT: "mit", "GPL-3.0": "gnu_gpl_v3", "AGPL-3.0": "gnu_agpl_v3", "Apache-2.0": "apache_2_0", UNLICENSED: "none", Unlicense: "unlicense" }[spdx] ?? "none";
process.stdout.write(JSON.stringify({
  input: { language: meta.language, sources, settings },
  compilerVersion: meta.compiler.version,
  file, name, license,
}));
NODE

# ── 各驗證器的狀態（以 API 為準）────────────────────────────────────────────────
curl_json() { curl -sS --retry 3 --retry-delay 2 --max-time 60 -A "$UA" "$@"; }

# Blockscout 的公開 API 有速率限制（尤其是送驗證的 POST）：429 時照 x-ratelimit-reset（毫秒）等，再重試。
blockscout() { # curl 參數… → stdout 是回應本文
  local n code reset
  for n in $(seq 1 20); do
    code="$(curl -sS --max-time 120 -A "$UA" -D "$WORK/bs.hdr" -o "$WORK/bs.body" -w '%{http_code}' "$@" || echo 000)"
    if [[ "$code" != 429 && "$code" != 000 ]]; then cat "$WORK/bs.body"; return 0; fi
    reset="$(tr -d '\r' <"$WORK/bs.hdr" | awk -F': ' 'tolower($1) == "x-ratelimit-reset" { print $2 }')"
    reset=$(( ${reset:-5000} / 1000 + 2 )); (( reset > 900 )) && reset=900
    echo "      （Blockscout 速率限制，${reset} 秒後重試 $n/20）" >&2
    sleep "$reset"
  done
  cat "$WORK/bs.body"
}

status_blockscout() { # → full / partial / no
  local j
  sleep 1
  j="$(blockscout "$BLOCKSCOUT/api/v2/smart-contracts/$1" || true)"
  if [[ "$(jq -r '.is_verified // false' <<<"$j" 2>/dev/null)" == true ]]; then
    if [[ "$(jq -r '.is_fully_verified // false' <<<"$j")" == true ]]; then echo full; else echo partial; fi
  else echo no; fi
}
status_sourcify() { # → exact_match / match / no
  # Sourcify 的 CDN 依完整網址快取一小時（不理 Cache-Control: no-cache），剛驗證完查到的會是舊結果。
  # 用隨機排列的 fields 參數（都是合法欄位，回應一定含 match）換出沒被快取過的網址；小寫與 checksum 各查一次取較好的。
  local a m best=no ck fields
  ck="$(cast to-check-sum-address "$1" 2>/dev/null || echo "$1")"
  for a in "$1" "$ck"; do
    fields="$(printf '%s\n' creationMatch runtimeMatch matchId verifiedAt deployment proxyResolution \
      | awk -v s="$RANDOM$RANDOM" 'BEGIN { srand(s) } { print rand() "\t" $0 }' | sort | cut -f2 | head -n $(( RANDOM % 4 + 3 )) | paste -sd, -)"
    m="$(curl_json "$SOURCIFY/v2/contract/$CHAIN_ID/$a?fields=$fields" | jq -r '.match // empty' 2>/dev/null || true)"
    case "$m" in exact_match) best=exact_match ;; match) [[ "$best" == no ]] && best=match ;; esac
  done
  echo "$best"
}
status_etherscan() { # → verified / no
  local j
  j="$(curl_json -G "$ETHERSCAN_V2" --data-urlencode "chainid=$CHAIN_ID" --data-urlencode module=contract \
        --data-urlencode action=getsourcecode --data-urlencode "address=$1" \
        --data-urlencode "apikey=$ETHERSCAN_API_KEY" || true)"
  if [[ -n "$(jq -r '.result[0].SourceCode // empty' <<<"$j" 2>/dev/null)" ]]; then echo verified; else echo no; fi
}
is_ok() { # 已驗證（任何比對等級）
  case "$1:$2" in
    blockscout:full|blockscout:partial|sourcify:exact_match|sourcify:match|etherscan:verified) return 0 ;;
    *) return 1 ;;
  esac
}
is_best() { # 用本 repo 的原始碼完整比對（連 metadata hash 都一致）：Blockscout full、Sourcify exact_match
  case "$1:$2" in
    blockscout:full|sourcify:exact_match|etherscan:verified) return 0 ;;
    *) return 1 ;;
  esac
}

# ── 送出 ───────────────────────────────────────────────────────────────────────
submit_blockscout() { # $1 address；$WORK/cur.json 是 stdjson.mjs 的輸出
  jq '.input' "$WORK/cur.json" >"$WORK/input.json"
  blockscout -X POST "$BLOCKSCOUT/api/v2/smart-contracts/$1/verification/via/standard-input" \
    -F "compiler_version=v$(jq -r .compilerVersion "$WORK/cur.json")" \
    -F "contract_name=$(jq -r .name "$WORK/cur.json")" \
    -F "license_type=$(jq -r .license "$WORK/cur.json")" \
    -F "autodetect_constructor_args=true" \
    -F "files[0]=@$WORK/input.json;type=application/json" || true
}
submit_sourcify() { # $1 address $2 建立交易 hash
  jq --arg tx "$2" '{stdJsonInput: .input, compilerVersion, contractIdentifier: "\(.file):\(.name)", creationTransactionHash: $tx}' \
    "$WORK/cur.json" >"$WORK/body.json"
  local r id
  r="$(curl_json -X POST -H 'content-type: application/json' --data @"$WORK/body.json" "$SOURCIFY/v2/verify/$CHAIN_ID/$1" || true)"
  id="$(jq -r '.verificationId // empty' <<<"$r" 2>/dev/null || true)"
  if [[ -z "$id" ]]; then echo "$r"; return 0; fi
  for _ in $(seq 1 60); do
    r="$(curl_json "$SOURCIFY/v2/verify/$id" || true)"
    [[ "$(jq -r '.isJobCompleted // false' <<<"$r" 2>/dev/null)" == true ]] && break
    sleep 5
  done
  jq -c '{match: .contract.match, error: .error.customCode}' <<<"$r" 2>/dev/null || echo "$r"
}
submit_etherscan() { # $1 address $2 root $3 initcode 尾段（建構子參數） $4 libraries
  local cmd=(forge verify-contract --root "$2" --chain "$CHAIN_ID" --watch
    --verifier etherscan --verifier-url "${ETHERSCAN_V2}?chainid=$CHAIN_ID")
  [[ -n "$3" ]] && cmd+=(--constructor-args "0x$3")
  if [[ "$4" != "-" ]]; then
    local l; IFS=',' read -r -a _libs <<<"$4"
    for l in "${_libs[@]}"; do cmd+=(--libraries "$l"); done
  fi
  cmd+=("$1" "$(jq -r '"\(.file):\(.name)"' "$WORK/cur.json")")
  # 金鑰只經由環境變數 ETHERSCAN_API_KEY 交給 forge。
  "${cmd[@]}" 2>&1 | tail -n 3 || true
}


# ── 主迴圈 ─────────────────────────────────────────────────────────────────────
# 已完整比對 → 跳過；未驗證或只有部分比對 → 送出（部分比對時試著升級成完整比對），再以 API 查回的結果為準。
FAIL=0
i=0
while IFS=$'\t' read -r name addr sha libs txhash init; do
  i=$((i + 1))
  echo "[$i/$COUNT] $name $addr"
  prepared=0 args=""
  for v in "${VERIFIERS[@]}"; do
    s="$("status_$v" "$addr")"
    if [[ "$v" == blockscout ]] && ! is_best "$v" "$s" && (( ! CHECK_ONLY )) \
       && is_best sourcify "$(lookup "$RESULTS" "$addr|sourcify")"; then
      # Blockscout 會從 Sourcify（eth-bytecode-db）匯入完整比對；它送驗證的 POST 限制很緊（約 15 分鐘 1 次），先等匯入。
      for _ in $(seq 1 12); do sleep 10; s="$("status_$v" "$addr")"; is_best "$v" "$s" && break; done
      is_best "$v" "$s" && echo "    ${v}：已從 Sourcify 匯入完整比對"
    fi
    if is_best "$v" "$s"; then
      echo "    ${v}：${s}（已驗證，跳過）"
      printf '%s\t%s\n' "$addr|$v" "$s" >>"$RESULTS"
      continue
    fi
    if (( CHECK_ONLY )); then
      echo "    ${v}：${s}（$(is_ok "$v" "$s" && echo 部分比對 || echo 未驗證)）"
      printf '%s\t%s\n' "$addr|$v" "$s" >>"$RESULTS"
      is_ok "$v" "$s" || FAIL=1
      continue
    fi
    if (( ! prepared )); then
      root_for "$sha"
      art="$(artifact_of "$ROOT" "$name")" || { echo "✖ 找不到 $name 的編譯產物" >&2; exit 1; }
      node "$WORK/stdjson.mjs" "$ROOT" "$art" >"$WORK/cur.json"
      code="$(jq -r '.bytecode.object' "$art")"; code="${code#0x}"; in="${init#0x}"
      (( ${#in} >= ${#code} )) || { echo "✖ $name 的建立交易 initcode 比編譯出的 creation bytecode 短：原始碼不是部署的那份" >&2; exit 1; }
      args="${in:${#code}}"
      prepared=1
    fi
    echo "    ${v}：${s} → 送出 $(jq -r '"\(.file):\(.name)"' "$WORK/cur.json")"
    case "$v" in
      blockscout) out="$(submit_blockscout "$addr")" ;;
      sourcify)   out="$(submit_sourcify "$addr" "$txhash")" ;;
      etherscan)  out="$(submit_etherscan "$addr" "$ROOT" "$args" "$libs")" ;;
    esac
    printf '%s\n' "$out" | sed 's/^/      /' | tail -n 3
    s2="$s"
    for _ in $(seq 1 12); do
      s2="$("status_$v" "$addr")"
      is_best "$v" "$s2" && break
      sleep 5
    done
    echo "    ${v}：API 查回 ${s2}"
    printf '%s\t%s\n' "$addr|$v" "$s2" >>"$RESULTS"
    is_ok "$v" "$s2" || FAIL=1
  done
done <"$LIST"

# ── 總表 ───────────────────────────────────────────────────────────────────────
echo
printf '%-24s %-44s' "contract" "address"
for v in "${VERIFIERS[@]}"; do printf ' %-20s' "$v"; done
echo
PARTIAL=0
while IFS=$'\t' read -r name addr _; do
  printf '%-24s %-44s' "$name" "$addr"
  for v in "${VERIFIERS[@]}"; do
    s="$(lookup "$RESULTS" "$addr|$v")"; s="${s:-?}"
    if is_best "$v" "$s"; then printf ' %-20s' "ok ($s)"
    elif is_ok "$v" "$s"; then printf ' %-20s' "ok* ($s)"; PARTIAL=$((PARTIAL + 1))
    else printf ' %-20s' "NO ($s)"; fi
  done
  echo
done <"$LIST"
echo
echo "ok = 完整比對；ok* = 已驗證，但驗證器紀錄的是部分比對；NO = 未驗證"
echo "Blockscout：$BLOCKSCOUT/address/<位址>?tab=contract    Sourcify：https://repo.sourcify.dev/$CHAIN_ID/<位址>"
if (( FAIL )); then echo "✖ 有合約尚未驗證"; exit 1; fi
echo "✔ 全部 $COUNT 個合約在 ${VERIFIERS[*]} 都已驗證（部分比對 $PARTIAL 項）"
