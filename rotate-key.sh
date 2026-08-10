#!/usr/bin/env bash
# 金鑰輪替：把所有合約的 ownership 與資產，從洩漏的 deployer 移到一把新金鑰。
#
# 為什麼需要這支腳本
# ------------------
# 舊 deployer 私鑰在 2026-05~06 的三個 commit（1d8536e / e912bff / cf712ec）
# 進過這個 public repo 的 git 歷史。刪檔沒有用，歷史仍可從所有遠端分支取得。
# 該金鑰對應 0xE80A81360608C1342e66743F70a00f75d792Eb93，目前仍是 9 個合約的
# owner，也是 x402 的收款地址。詳見 docs/RUNBOOK_KEY_ROTATION.md。
#
# 設計原則
# --------
# 簽章用「舊金鑰」（它已經公開，用它沒有增加任何暴露），目的地只需要「新地址」。
# 所以新私鑰由這支腳本在你本機產生、寫進 600 權限的檔案，**永遠不會被印在畫面上、
# 不會進 git、也不會離開這台機器**。
#
# 用法
# ----
#   bash rotate-key.sh              # 只演練，不送任何交易
#   bash rotate-key.sh --execute    # 真的送出
#
set -euo pipefail

cd "$(dirname "$0")"

KEYFILE="contracts/.env.rotation"
LEAKED_ADDR="0xE80A81360608C1342e66743F70a00f75d792Eb93"
RPC="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
EXECUTE=false
[ "${1:-}" = "--execute" ] && EXECUTE=true

command -v cast >/dev/null || { echo "找不到 cast，請先裝 Foundry"; exit 1; }

# ── 舊金鑰 ───────────────────────────────────────────────────────────────────
# 明文寫在這裡不是疏忽：它已經在公開的 git 歷史裡，藏起來只會讓這支腳本更難用，
# 不會讓任何人更安全。輪替完成後這把金鑰就一文不值了。
OLD_PK="${OLD_PK:-0x2b94ce61c754caa8138bd62a86b8665afdbbe70c87bed997d91c5bcd90a0ec0d}"

derived=$(cast wallet address --private-key "$OLD_PK")
if [ "${derived,,}" != "${LEAKED_ADDR,,}" ]; then
  echo "舊金鑰推導出的地址不是預期的 $LEAKED_ADDR（得到 $derived）"; exit 1
fi

# ── 新金鑰：本機產生，只印地址 ───────────────────────────────────────────────
if [ -f "$KEYFILE" ]; then
  # shellcheck disable=SC1090
  source "$KEYFILE"
  echo "沿用既有的新金鑰（$KEYFILE）"
else
  echo "產生新金鑰…"
  out=$(cast wallet new)
  NEW_ADDR=$(echo "$out" | grep -i "^Address"     | awk '{print $NF}')
  NEW_PK=$(  echo "$out" | grep -i "^Private key" | awk '{print $NF}')
  umask 077
  { echo "NEW_ADDR=$NEW_ADDR"; echo "NEW_PK=$NEW_PK"; } > "$KEYFILE"
  echo "新私鑰已寫入 $KEYFILE（權限 600，已被 .gitignore 忽略）"
  echo ">>> 請立刻把它複製進你的密碼管理器，然後再繼續。 <<<"
fi

echo
echo "════════════════════════════════════════════════════════"
echo " 舊 owner（洩漏，作廢中）: $LEAKED_ADDR"
echo " 新 owner（你的新金鑰）  : $NEW_ADDR"
echo " RPC                     : $RPC"
echo " 模式                    : $($EXECUTE && echo '真的送出交易' || echo '演練（不送交易）')"
echo "════════════════════════════════════════════════════════"
echo

# --slow 不是效能取捨，是正確性要求。2026-08-07 發現洩漏的 deployer 本身已被
# EIP-7702 委派接管（code 0xef0100…，掃款機器人幹的，因為私鑰是公開的）。
# Base 對被委派的帳號要求 nonce 嚴格連續，forge 預設會批次預配 nonce，於是整批
# 交易被 RPC 以 `gapped-nonce tx from delegated accounts` 拒絕。--slow 逐筆等
# 收據，nonce 自然連續。
#
# ── 目標合約 ─────────────────────────────────────────────────────────────────
# 這份清單是 2026-08-06 對 Base Sepolia 逐一 cast call owner() 得到的，
# 不是從部署腳本推的。
export EXCHANGE=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
export MOCKUSDC=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
export PEPETOKEN=0xccd05cbdc2f7961a4c27d3633694022722786a0f
export INSVAULT=0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812
export FEEROUTER=0x00f6cf0113399a7A451c7f85fe094a28092d3e0c
export KYCREGISTRY=0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d
export TRADERSTAKE=0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe
export PEPEAMM=0x93be44a81a2796d378f65ebcc8d5f8b40166ad63
export X402_FEEROUTER=0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d
export X402_INSVAULT=0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f
# Deployed 2026-08-07 to close the six-contract gap on Base. RotateOwnership.sol
# already had slots for all of these; the list here did not, so a rotation run
# before this line was added would have reported success while leaving six
# contracts on the leaked key. Verified by cast call owner() on each.
export MOCKUSDT=0x5c8A1e970D275Cc269e09A949D68693120416d78
export ESGREGISTRY=0x73310bfb9f93711e9405EB717e3426246BD58618
export PEPECLAIM=0x459d238aC61eC4A0E08608FBcd363227B860CF34
export ESGDISTRIBUTOR=0x0c85923193AB6137A117E5911aAA7DF7Cb8787D7
export PEPESTAKING=0xC78D68cA1B217ba241c23Ebad3118c6ec0dc0D34
export ASSETVAULT=0xC30DFe1C9EBb47197b785995aA9Cd0F5B89557A5
# MockOracle's owner is already the separated keeper key, not the leaked one, so
# it is deliberately absent: rotating it would break the price feed.
export PEPEINCENTIVES=0xEBfA1dc7dDea032ac6242cB619d982e543A23c12
export COPYTRACKER=0x96357144fE56c5E0e33e8046bE2A63F45528b210

export NEW_OWNER="$NEW_ADDR"

echo "── 步驟 1／3：移轉 ownership ───────────────────────────"
# forge 必須在 contracts/ 內執行，否則解不到 remappings。
( cd contracts
  # 兩種模式都要帶舊金鑰，否則 forge 會用預設 signer，腳本就會把每個合約
  # 判成「owner 不是我，跳過」，然後回報「會執行 0 筆」——一個說謊的演練
  # 比沒有演練更危險。真正的差別只在 --broadcast。
  if $EXECUTE; then
    DRY_RUN=false forge script script/RotateOwnership.s.sol:RotateOwnership \
      --rpc-url "$RPC" --private-key "$OLD_PK" --broadcast --slow -vv
  else
    DRY_RUN=true  forge script script/RotateOwnership.s.sol:RotateOwnership \
      --rpc-url "$RPC" --private-key "$OLD_PK" -vv
  fi
)

echo
echo "── 步驟 2／3：搬走餘額 ─────────────────────────────────"
USDC_OFFICIAL=0x036CbD53842c5426634e7929541eC2318f3dCF7e

sweep_erc20() {
  local token=$1 label=$2
  local bal; bal=$(cast call "$token" "balanceOf(address)(uint256)" "$LEAKED_ADDR" --rpc-url "$RPC" | awk '{print $1}')
  if [ "$bal" = "0" ]; then echo "  $label: 0，略過"; return; fi
  echo "  $label: $bal"
  if $EXECUTE; then
    cast send "$token" "transfer(address,uint256)" "$NEW_ADDR" "$bal" \
      --rpc-url "$RPC" --private-key "$OLD_PK" >/dev/null && echo "    → 已移轉"
  fi
}
sweep_erc20 "$MOCKUSDC"      "MockUSDC(平台模擬幣)"
sweep_erc20 "$USDC_OFFICIAL" "官方 USDC(x402 用)"
sweep_erc20 "$PEPETOKEN"     "PEPE"

# ETH 最後才搬，因為前面每一步都要 gas。保留 0.01 ETH 當緩衝。
ethbal=$(cast balance "$LEAKED_ADDR" --rpc-url "$RPC")
echo "  ETH: $ethbal wei"
if $EXECUTE; then
  keep=10000000000000000                       # 0.01 ETH
  send=$(python3 -c "print(max(0,$ethbal-$keep))")
  if [ "$send" != "0" ]; then
    cast send "$NEW_ADDR" --value "$send" --rpc-url "$RPC" --private-key "$OLD_PK" >/dev/null \
      && echo "    → 已移轉（保留 0.01 ETH 供後續收尾）"
  fi
fi

echo
echo "── 步驟 3／3：驗證 ─────────────────────────────────────"
for pair in "PerpetualExchange:$EXCHANGE" "MockUSDC:$MOCKUSDC" "PepeToken:$PEPETOKEN" \
            "InsuranceVault:$INSVAULT" "FeeRouter:$FEEROUTER" "KYCRegistry:$KYCREGISTRY" \
            "TraderStake:$TRADERSTAKE" "PepeAMM:$PEPEAMM" \
            "X402-FeeRouter:$X402_FEEROUTER" "X402-InsuranceVault:$X402_INSVAULT"; do
  n=${pair%%:*}; a=${pair##*:}
  o=$(cast call "$a" "owner()(address)" --rpc-url "$RPC" 2>/dev/null | head -1)
  if [ "${o,,}" = "${NEW_ADDR,,}" ]; then printf "  ✅ %-22s %s\n" "$n" "$o"
  else                                    printf "  ❌ %-22s %s\n" "$n" "$o"; fi
done

echo
if $EXECUTE; then
  cat <<'DONE'
輪替完成。接下來還要做的（腳本無法代勞）：
  1. 把新私鑰存進密碼管理器，然後刪掉 contracts/.env.rotation
  2. gh secret set KEEPER_PRIVATE_KEY      （若 keeper 也要換）
  3. Vercel 後台把 signal-api 的 PAY_TO 改成新地址
  4. 到 Infura 後台刪除 project 7cdfb492…（洩漏的 RPC token）
DONE
else
  echo "以上為演練。確認無誤後執行：  bash rotate-key.sh --execute"
fi
