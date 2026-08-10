# Runbook — Deployer / Owner 金鑰輪替

> **狀態：未執行。這是 P0，在它完成之前，本專案其他所有安全修復都沒有意義。**
>
> 建立於 2026-08-06，依據 [`audit/AUDIT_2026-08-06.md`](audit/AUDIT_2026-08-06.md) 的 S1。
> 本文件**只描述步驟**；撰寫者未執行任何鏈上指令。

---

## 0. 為什麼必須輪替

Deployer 的**私鑰本體**曾被 commit 進這個 **PUBLIC** repo，且從所有遠端分支可達：

| 項目 | 值 |
|---|---|
| 洩漏的私鑰（截斷） | `0x2b94ce61…a0ec0d` |
| 對應地址 | **`0xE80A81360608C1342e66743F70a00f75d792Eb93`** |
| 洩漏檔案 | `frontend/.env.example`、`frontend/price_keeper.cjs` |
| 洩漏 commits | **`1d8536e`**(2026-05-28)、**`e912bff`**(2026-06-16)、**`cf712ec`**(2026-06-19) |
| repo 可見性 | `gh repo view` 確認為 **PUBLIC** |

從工作樹刪除檔案**完全沒有解決任何事** —— 那三個 commit 仍可被 `git show` 直接取出。

### 為什麼「改寫 git 歷史」不是解法

`git filter-repo` / BFG 可以做，但：

- 已經被抓取（clone、fork、GitHub 事件 API、各家爬蟲與 secret-scanning 資料集）
  的內容**無法撤回**
- 改寫後舊 commit 在 GitHub 上有時仍能透過 SHA 直接存取一段時間

**輪替（把資產與權限移到新金鑰）才是止血，改寫歷史最多是善後。**
先做輪替，改寫歷史可以之後再考慮。

---

## 1. 受影響資產清單

輪替前先確認範圍。以下為 2026-08-06 的鏈上實測值。

### 1.1 合約 ownership

`0xE80A8136…Eb93` 是下列 **9 個**合約的 owner。清單以 2026-08-06 對 Base Sepolia 逐一
`cast call <addr> "owner()(address)"` 的結果為準，不是從部署腳本推得的。

| 合約 | 位址 | 攻擊者能做什麼 |
|---|---|---|
| `PerpetualExchange` | `0xEf75ECA6514cE96B18382E921aC6190a0cF8c072` | `setTradingFeeBps` 吃掉保證金、`setMaxPriceAge` 關閉 staleness、改 FeeRouter 收款 |
| `MockUSDC` | `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035` | 無限 `mint` 灌爆保證金池 |
| `PepeToken` | `0xccd05cbdc2f7961a4c27d3633694022722786a0f` | 無限 `mint` |
| `InsuranceVault` | `0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812` | 改 exchange 綁定、影響 bailout |
| `FeeRouter` | `0x00f6cf0113399a7A451c7f85fe094a28092d3e0c` | 改 70/20/10 的收款地址 |
| `KYCRegistry` | `0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d` | 任意核發／撤銷 KYC，等於關閉 RWA 合規閘 |
| `TraderStake` | `0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe` | 改罰沒參數 |
| **X402 `FeeRouter`** | `0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d` | **改 x402 真實收入的分潤去向（綁官方 USDC）** |
| **X402 `InsuranceVault`** | `0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f` | 同上，x402 那 10% 的去向 |
| `PepeAMM` | `0x93be44a81a2796d378f65ebcc8d5f8b40166ad63` | 改 oracle 容忍參數；重寫後另有 LP 部位 |

> **MockOracle `0xeD90c4F3…0Aa3` 不在範圍**：owner 已經是 keeper `0x540aECD3…ef17`
> （鏈上實測確認），見 `RUNBOOK_KEEPER.md`。
> `CopyTracker`、`StrategyRegistry`、`AgentSessionManager`、`MockSwapRouter` **沒有 `owner()`**，
> 不需輪替；但 `AgentSessionManager` 的 session 授權對象是 `0xE80A8136…` 本身，
> 見 §1.4。

`contracts/script/RotateOwnership.s.sol` 已涵蓋上述全部目標，先用 `DRY_RUN=true`
跑一次核對真實 owner，再實際執行。

### 1.2 餘額（攻擊者可直接提走）

| 鏈 | 資產 | 數量 |
|---|---|---|
| Base Sepolia | ETH | **1.29** |
| Sepolia | ETH | **3.65** |
| Base Sepolia | 官方 USDC（Circle, 6-dec） | **59.98** |
| Base Sepolia | MockUSDC（18-dec） | **33,217** |

### 1.3 身分／角色

| 角色 | 說明 |
|---|---|
| x402 `payTo` treasury | 攻擊者可冒用 treasury 身分收 x402 款項 |
| `platformTreasury`（X402 FeeRouter `0x29e5…B57d`） | 分潤收款地址 |
| AgentSessionManager session #0 / #6 的 `user` | 即 agent 下單的授權來源 |
| `agent/.env.example` 的 `PAY_TO` 預填值 | 會被複製到每個人的 `.env` |

---

## 2. 前置準備

```bash
# 需要 foundry（cast）
cast --version

export BASE_RPC=https://sepolia.base.org
export SEPOLIA_RPC=<你的 Sepolia RPC>

# 舊金鑰（洩漏的那把）—— 只用來簽輪替交易，之後永久作廢
export OLD_PK=0x<洩漏的私鑰>
export OLD_ADDR=0xE80A81360608C1342e66743F70a00f75d792Eb93
```

> ⚠️ 這些指令會用到洩漏的私鑰。**在你動手的當下，任何人也都能動手** ——
> 把整段流程當成與攻擊者賽跑，一次做完，不要中途離開。
> 建議先做 §4（移轉 ownership），再做 §5（搬錢）：ownership 是無上限的損害，
> 餘額是有上限的。

---

## 3. 產生新的 deployer 金鑰

```bash
cast wallet new
# 輸出：
#   Address:     0x<NEW_ADDR>
#   Private key: 0x<NEW_PK>
```

**保存規則**：

- 私鑰**只**進 GitHub Secrets 與你本機的密碼管理器
- **絕不**寫進任何 `.env.example`、README、文件、註解
- `.env.example` 一律只放 `0x…`／`<your-key>` 這類佔位字串

```bash
export NEW_ADDR=0x<NEW_ADDR>
export NEW_PK=0x<NEW_PK>

# 新地址需要 gas 才能之後執行 owner 操作
cast send "$NEW_ADDR" --value 0.1ether --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
```

驗證：

```bash
cast balance "$NEW_ADDR" --rpc-url "$BASE_RPC"
```

---

## 4. 移轉四個合約的 ownership

四個合約各自獨立呼叫 `transferOwnership(address)`。

```bash
export EXCHANGE=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
export MOCKUSDC=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
export PEPETOKEN=0xccd05cbd0000000000000000000000000000786a0f   # ← 用 addresses.ts 的完整值取代
export INSVAULT=0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812

for C in "$EXCHANGE" "$MOCKUSDC" "$PEPETOKEN" "$INSVAULT"; do
  echo "transferOwnership on $C"
  cast send "$C" "transferOwnership(address)" "$NEW_ADDR" \
    --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
done
```

> `PEPETOKEN` 的完整位址請從 `frontend/src/contracts/addresses.ts` 的
> `BASE_SEPOLIA` 區塊取得（本文件刻意不重抄，避免再製造一個會過期的副本）。

### 4.1 驗證（每一個都要回 `NEW_ADDR`）

```bash
for C in "$EXCHANGE" "$MOCKUSDC" "$PEPETOKEN" "$INSVAULT"; do
  echo -n "$C owner = "
  cast call "$C" "owner()(address)" --rpc-url "$BASE_RPC"
done
```

四行輸出**全部**必須等於 `$NEW_ADDR`。任何一行還是 `0xE80A8136…` 就是沒完成。

> **注意 OpenZeppelin v5 的 `Ownable2Step`**：若某個合約繼承的是 `Ownable2Step`
> 而非 `Ownable`，`transferOwnership` 只是「提名」，新 owner 還必須自己呼叫
> `acceptOwnership()` 才會生效：
> ```bash
> cast send "$C" "acceptOwnership()" --rpc-url "$BASE_RPC" --private-key "$NEW_PK"
> ```
> 先用 `cast call "$C" "pendingOwner()(address)"` 判斷是哪一種：
> 有回值＝兩段式，revert＝單段式。**驗證步驟以 `owner()` 的回傳為準。**

---

## 5. 移轉餘額

### 5.1 ERC-20（先做，因為需要 gas）

```bash
export USDC_OFFICIAL=0x036CbD53842c5426634e7929541eC2318f3dCF7e

# 官方 USDC（6-dec）
BAL=$(cast call "$USDC_OFFICIAL" "balanceOf(address)(uint256)" "$OLD_ADDR" --rpc-url "$BASE_RPC" | awk '{print $1}')
cast send "$USDC_OFFICIAL" "transfer(address,uint256)" "$NEW_ADDR" "$BAL" \
  --rpc-url "$BASE_RPC" --private-key "$OLD_PK"

# MockUSDC（18-dec）
BAL=$(cast call "$MOCKUSDC" "balanceOf(address)(uint256)" "$OLD_ADDR" --rpc-url "$BASE_RPC" | awk '{print $1}')
cast send "$MOCKUSDC" "transfer(address,uint256)" "$NEW_ADDR" "$BAL" \
  --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
```

驗證：

```bash
cast call "$USDC_OFFICIAL" "balanceOf(address)(uint256)" "$OLD_ADDR" --rpc-url "$BASE_RPC"  # 應為 0
cast call "$USDC_OFFICIAL" "balanceOf(address)(uint256)" "$NEW_ADDR" --rpc-url "$BASE_RPC"  # 應為 59.98e6
cast call "$MOCKUSDC"      "balanceOf(address)(uint256)" "$OLD_ADDR" --rpc-url "$BASE_RPC"  # 應為 0
```

### 5.2 交易所內的 freeMargin

`0xE80A8136…` 同時是 demo session 的 user，在 exchange 內可能存有保證金。

```bash
cast call "$EXCHANGE" "freeMargin(address)(uint256)" "$OLD_ADDR" --rpc-url "$BASE_RPC"
# 若 > 0，先平掉未平倉部位，再提領：
cast send "$EXCHANGE" "withdrawMargin(uint256)" <amount> \
  --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
```

### 5.3 原生 ETH（**最後做** —— 送完就沒 gas 了）

```bash
# Base Sepolia
cast send "$NEW_ADDR" --value 1.2ether --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
# Sepolia
cast send "$NEW_ADDR" --value 3.5ether --rpc-url "$SEPOLIA_RPC" --private-key "$OLD_PK"
```

> 刻意留一小段餘額（約 0.05–0.1 ETH）當緩衝，不要試圖精算到 0 而讓最後一筆
> 因為 gas 不足而失敗。

驗證：

```bash
cast balance "$OLD_ADDR" --rpc-url "$BASE_RPC"
cast balance "$NEW_ADDR" --rpc-url "$BASE_RPC"
cast balance "$OLD_ADDR" --rpc-url "$SEPOLIA_RPC"
cast balance "$NEW_ADDR" --rpc-url "$SEPOLIA_RPC"
```

---

## 6. 撤銷舊身分與舊授權

### 6.1 撤銷舊 AgentSessionManager 與舊 session

舊 SessionManager `0x5Ebcc64C712C5a26119789dCbD0753981dc518E8` **從未撤權**，
且沒有 per-session 資產白名單；其 session #6 到期日是 2027。

```bash
# 用新 owner 撤掉舊 manager 的 agent 授權
cast send "$EXCHANGE" "setAgentAuthorized(address,bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 false \
  --rpc-url "$BASE_RPC" --private-key "$NEW_PK"

# 撤銷舊 user 仍持有的 session（用舊金鑰簽，因為 session 的 user 是它）
cast send 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 "revokeSession(uint256)" 6 \
  --rpc-url "$BASE_RPC" --private-key "$OLD_PK"
```

驗證：

```bash
cast call "$EXCHANGE" "authorizedAgents(address)(bool)" \
  0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 --rpc-url "$BASE_RPC"   # 應為 false
```

### 6.2 x402 payTo / platformTreasury

```bash
export X402_ROUTER=0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d
cast call "$X402_ROUTER" "platformTreasury()(address)" --rpc-url "$BASE_RPC"
# 若仍是 0xE80A8136…，用該 router 的 owner-only setter 改成 $NEW_ADDR，然後：
cast call "$X402_ROUTER" "platformTreasury()(address)" --rpc-url "$BASE_RPC"  # 應為 $NEW_ADDR
```

---

## 7. 更新 repo 與 CI 設定

### 7.1 `agent/.env.example`

把 `PAY_TO` 的預填值從 `0xE80A81360608C1342e66743F70a00f75d792Eb93`
改成新的 treasury 地址。

```bash
grep -n "PAY_TO\|0xE80A8136" agent/.env.example
```

> **`0xE80A81360608C1342e66743F70a00f75d792Eb93` 從此永久視為「已公開地址」。**
> 它不該再出現在任何預填值、預設值或文件範例中。全 repo 掃一次：
> ```bash
> grep -rn "0xE80A8136" --include="*.ts" --include="*.tsx" --include="*.md" \
>   --include="*.sol" --include="*.sh" --include="*.example" . | grep -v node_modules
> ```
> `docs/VERIFICATION_REPORT.md §4` 與 `docs/audit/` 裡的**歷史紀錄**可以保留
> （那是事實陳述），但任何**會被複製去使用**的值都必須換掉。

### 7.2 GitHub Secrets

```bash
gh secret list
```

| Secret | 動作 |
|---|---|
| `KEEPER_PRIVATE_KEY` | 確認其值**從未等於**洩漏的金鑰（鏈上顯示 CI 用的是 `0x540aECD3…ef17`，與洩漏值不同 → 目前無需更換） |
| `BASE_SEPOLIA_RPC_URL` | 若使用被洩漏的 Infura project，必須換（見 §8） |
| `KEEPER_RPC_URL` | 同上 |
| 新增（若部署流程需要） | `DEPLOYER_PRIVATE_KEY` = 新金鑰 |

```bash
gh secret set DEPLOYER_PRIVATE_KEY   # 互動輸入，不要放進指令歷史
```

### 7.3 前端 / agent 設定

`frontend/src/contracts/addresses.ts` 是位址的唯一真相來源。ownership 移轉
**不會改變合約位址**，所以這裡通常不需要改；但若你順便重新部署了 exchange
（解決 `FUNDING_INTERVAL = 300` 的問題），則必須同步更新。

---

## 8. 作廢 Infura project

Infura project id `7cdfb4923cee46ed9238a5181e4e9a4d` 也在 public 歷史中
（且直到 2026-08-06 都還在 HEAD 的 `frontend/check_all_pepe_balances.cjs`）。

1. 登入 <https://app.infura.io/>
2. 找到該 project
3. **Delete project**（或至少 Settings → 重置 API key + 開啟 allowlist）
4. 更新所有引用它的 GitHub secret / 本機 `.env`

驗證（應該要失敗）：

```bash
curl -s -X POST "https://sepolia.infura.io/v3/7cdfb4923cee46ed9238a5181e4e9a4d" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# 期待：401 / 403 / project not found。若回傳正常的 blockNumber，代表還沒作廢。
```

---

## 9. 完成檢查表

全部打勾才算輪替完成：

- [ ] 新金鑰已產生，私鑰只存在於密碼管理器 + GitHub Secrets
- [ ] `PerpetualExchange.owner()` == 新地址
- [ ] `MockUSDC.owner()` == 新地址
- [ ] `PepeToken.owner()` == 新地址
- [ ] `InsuranceVault.owner()` == 新地址
- [ ] `FeeRouter.owner()` == 新地址
- [ ] `KYCRegistry.owner()` == 新地址
- [ ] `TraderStake.owner()` == 新地址
- [ ] **X402 `FeeRouter.owner()`（`0x29e5…B57d`）== 新地址**
- [ ] **X402 `InsuranceVault.owner()`（`0xc7Af…7B9f`）== 新地址**
- [ ] `PepeAMM.owner()` == 新地址
- [ ] 官方 USDC 餘額已移轉（舊地址 = 0）
- [ ] MockUSDC 餘額已移轉（舊地址 = 0）
- [ ] Base Sepolia ETH 已移轉
- [ ] Sepolia ETH 已移轉
- [ ] exchange 內 `freeMargin(舊地址)` == 0
- [ ] 舊 SessionManager `authorizedAgents` == false
- [ ] 舊 session #6 已 `revoked`
- [ ] x402 `platformTreasury` / `payTo` 已指向新 treasury
- [ ] `agent/.env.example` 的 `PAY_TO` 已更新
- [ ] 全 repo `grep 0xE80A8136` 只剩歷史紀錄，無可複製使用的預填值
- [ ] Infura project 已刪除，且 curl 驗證回 401/403
- [ ] `gh secret list` 已確認 `KEEPER_PRIVATE_KEY` 從未等於洩漏值

---

## 10. 之後（可選）：改寫 git 歷史

輪替完成、資產歸零之後才考慮這一步。它**不是**止血手段。

```bash
# 先做完整備份
git clone --mirror git@github.com:zuemen/pepelab_onchain_cfd.git backup.git

pip install git-filter-repo
git filter-repo --path frontend/price_keeper.cjs --path frontend/.env.example --invert-paths
git push --force --all
git push --force --tags
```

**副作用（務必先讓所有協作者知道）**：

- 所有 commit SHA 改變 → 每個 clone 都必須重新 clone
- 開啟中的 PR（含 PR #6）會壞掉
- fork 不受影響 —— **洩漏內容仍在 fork 裡**
- 已被外部索引／抓取的內容無法撤回

也請一併聯絡 GitHub Support 要求清除快取的 commit view。

---

## 附錄：一鍵驗證腳本

輪替後隨時可重跑，確認沒有回退。

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${BASE_RPC:?}" "${NEW_ADDR:?}"
OLD=0xE80A81360608C1342e66743F70a00f75d792Eb93

declare -A C=(
  [PerpetualExchange]=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
  [MockUSDC]=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
  [InsuranceVault]=0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812
)

FAIL=0
for name in "${!C[@]}"; do
  owner=$(cast call "${C[$name]}" "owner()(address)" --rpc-url "$BASE_RPC")
  if [ "${owner,,}" = "${NEW_ADDR,,}" ]; then
    echo "✅ $name owner = $owner"
  else
    echo "❌ $name owner = $owner（預期 $NEW_ADDR）"; FAIL=1
  fi
done

bal=$(cast balance "$OLD" --rpc-url "$BASE_RPC")
echo "舊地址 Base Sepolia 餘額：$bal wei"

exit "$FAIL"
```
