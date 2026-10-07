# 擁有者操作包（OWNER_ACTIONS）

> 這份文件列出**只有 repo 與部署金鑰的擁有者能做**的事，依建議順序排列。程式碼裡的修正大多已合併，
> 但合併只改了原始碼：鏈上合約、GitHub 設定、Cloudflare Worker、Vercel 環境變數都不會因為 PR 合併而改變。
> 現況見 [`RELEASE_STATUS.md`](RELEASE_STATUS.md)（由腳本產生）。**已合併不等於使用者受保護。**
>
> 這是公開文件：不含任何私鑰或聯絡方式；已知外洩的舊部署者地址一律寫成縮寫 `0xE80A…Eb93`
> （完整清單在 `agent/shared/src/payoutSafety.ts` 的 `COMPROMISED_ADDRESSES`）。需要金鑰的指令
> 一律用 Foundry keystore（`cast wallet import <名稱> --interactive` 建立一次，之後 `--account <名稱>`）或 `--interactive`，
> 私鑰不出現在指令列、不寫進檔案或 shell history。本文件用到的部署腳本都已改成以 `msg.sender` 部署，
> 可以用 keystore（`DeployPepeIncentives`、`DeployAMM` 於 2026-10-07 改寫，見第 5 步）。GitHub／Cloudflare 上的金鑰只放 secret。
>
> 本文件的「Base Sepolia」一律指 chainId 84532，公開 RPC `https://sepolia.base.org`；「Sepolia」指 Ethereum 測試網
> （chainId 11155111）。部署與驗證指令都直接寫出 Base Sepolia 的 RPC，不用 `$SEPOLIA_RPC_URL` 這類容易混淆的變數名。

## 總覽

| # | 步驟 | 在哪裡做 | 預估時間 | 完成後的唯讀驗證 |
|---|---|---|---|---|
| 1 | 私鑰移入受保護的 environment、刪 repo 層級 secret、設 branch protection | GitHub 設定頁 | 45–60 分 | `gh api …/environments/…`、`gh api …/actions/secrets` |
| 2 | 部署 keeper-trigger 與 monitoring 兩個 Worker | Cloudflare | 1.5–2 小時 | Worker Logs、`gh api …/actions/runs` |
| 3 | 凍結舊部署上外洩地址的權限 | 本機 forge（Base 先、Sepolia 後） | 2–3 小時 | `ops/freeze-legacy/readback.mjs`、`post-deploy-smoke.mjs` |
| 4 | 換 PAY_TO、重部署 x402 FeeRouter（沿用舊 x402 保險金庫，先斷開再存種子） | 本機 forge／cast＋Vercel＋GitHub variables | 1.5–2 小時 | `cast call … platformTreasury()`、`post-deploy-smoke.mjs` |
| 5 | 完整 cutover：#130、GuardedOracle、AssetVaultV2 升級 V2_5、InsuranceVault＋平台 FeeRouter＋CopyTracker（腳本已備；**前提：#130 完成＋timelock 或明確選擇不移交**）、PepeIncentives、PepeAMM | 本機 forge（先 dispatch keeper） | 不含阻塞項 6–8 小時；阻塞項解除後另 2–3 小時，加 timelock 48 小時等待與 2 天緩衝 | `Verify130`、`post-deploy-smoke.mjs` |
| 6 | 每台 agent 主機 `npm run vc-status:init` | 各 agent 主機 | 每台 5 分 | `agent/.state/vc-status/index.json` 存在 |
| 7 | 重跑發布狀態與 smoke test，確認「原始碼較新」變成「鏈上＝原始碼」 | 本機 | 45–60 分（含 `forge build`） | `check-deployment-status.mjs --offline`、`post-deploy-smoke.mjs` |

**合計：動手約 15–20 小時，分散在至少 3–4 天**（第 5 步第 4 項等 #130 與治理 timelock；timelock 48 小時等待與 cutover 後 2 天緩衝不計入動手時間）。
第 1 步必須最先做；第 2 步的 Worker 在第 1 步完成前不可以持有任何 Actions: write 憑證。

每一步完成後都可以跑一次部署後 smoke test（唯讀、不需要金鑰），看 FAIL 是否如預期減少：

```bash
node scripts/post-deploy-smoke.mjs              # 鏈上接線、外洩地址、keeper 新鮮度、signal-api
node scripts/post-deploy-smoke.mjs --skip-http  # 只看鏈上
```

2026-10-04 的基準：FAIL 8 項——平台與 x402 FeeRouter 的 `platformTreasury()`、Base 三顆 oracle adapter 的 `owner()`
仍是外洩地址，signal-api 的 payTo 是外洩地址、付費端點因此 fail-closed 回 503，以及 `AssetVaultV2 version()` 仍是 2.4.0
（V2_5 升級未做）。第 3 步消掉三顆 adapter，第 4 步消掉 x402 與 signal-api 三項，第 5 步第 3 項消掉 version()，
平台 FeeRouter 的 `platformTreasury()` 要等第 5 步第 4 項（阻塞中）。

---

## 第 1 步：GitHub —— 私鑰移入受保護的 environment、刪 repo 層級 secret、branch protection

**為什麼：** 持有私鑰的 workflow 目前仍能讀到 repo 層級的 `KEEPER_PRIVATE_KEY`、`FEE_SETTLEMENT_PRIVATE_KEY`，
而 `keeper`、`settlement` 兩個 environment 是空殼（沒有 secret、沒有保護規則），`admin-approval` 不存在。
master 上的守門（precheck、人工核准、`check-workflow-guards.mjs`）只保護 master 上的 workflow 檔；
私鑰只要還在 repo 層級，就不受這些守門保護。依據：[`ops/keeper-trigger/README.md`](../ops/keeper-trigger/README.md)「現況」與「部署前必做」第 1–4 步。

**前置條件：**
- 你是 repo 的 admin，手邊有 `gh`（已登入）。
- **方案限制：** environment 的保護規則（required reviewers、deployment branch policy）與 branch protection，
  在**公開 repo 免費**；repo 若改成**私有**，這些功能需要 GitHub Pro／Team／Enterprise 等付費方案，免費方案下
  設定頁會不出現或不生效。本 repo 目前是公開的。日後若改私有，先確認方案，否則第 1 步的保護會靜默消失。

**操作（GitHub → repo → Settings）：**

1. **Environments → New environment `admin-approval`**：Required reviewers 勾選並加入 repo 擁有者帳號；
   **不要**勾 Prevent self-review；**取消**「Allow administrators to bypass configured protection rules」；
   Deployment branches and tags 選 Selected，加入 `master`；**不放任何 secret**。
2. **Environments → `keeper`**：Environment secrets 新增 `KEEPER_PRIVATE_KEY`；Deployment branches 設 `master`。
   **不要**設 reviewers、wait timer 或 custom protection rule（keeper 是排程，設了會卡住寫價）。
3. **Environments → `settlement`**：新增 `FEE_SETTLEMENT_PRIVATE_KEY`；Deployment branches 設 `master`。
   （第 4 步會換成新的結算金鑰；這裡先搬現行那把，第 4 步再更新同一個 secret。）
4. 等 `Base Sepolia Keeper`、`Oracle Price Keeper (Sepolia)`、`x402 Settlement Worker` 在 master 各**成功一次**之後，
   **Secrets and variables → Actions → Repository secrets**：刪除 `KEEPER_PRIVATE_KEY` 與 `FEE_SETTLEMENT_PRIVATE_KEY`。
5. **Rules → Rulesets**（或 Branches → Branch protection rules）對 `master`：
   - Require a pull request before merging；Block force pushes；Restrict deletions。
   - Require status checks to pass，**required checks 名稱**（GitHub 顯示的是 job 的 `name:`）：

     | required check | 來源 workflow |
     |---|---|
     | `workflow guards (environment / secrets / triggers)` | Consistency |
     | `actionlint` | Consistency |
     | `workflow ↔ addresses.ts` | Consistency |
     | `tenant deploy configs` | Consistency |
     | `keeper trigger worker` | Consistency |
     | `monitoring rules ↔ addresses.ts / ABI` | Consistency |
     | `release status ↔ addresses.ts` | Consistency |
     | `contract size budget` | Contract size（`.github/workflows/contract-size.yml`） |
     | `VerifyTenant (public RPC fork)` | Tenant on-chain verify（`tenant-verify.yml`） |

     前兩項是 `ops/keeper-trigger/README.md` 點名的最低要求；Consistency 其餘五項沒有路徑過濾、每個 PR 都會跑，一起設。
     `contract size budget` 是主合約成長門檻（PerpetualExchange runtime 不得超過 `scripts/contract-size-budget.json`）：
     刻意做成沒有路徑過濾、在 job 內判斷是否需要 build，所以可以設成 required，門檻紅燈才擋得住合併。
     它只能機械地擋「放寬卻沒追加紀錄」「改舊紀錄」「換掉量的合約」；放寬理由寫得好不好仍靠人審。建議（本 PR 未加）：
     用 CODEOWNERS 指定 `scripts/check-contract-size.mjs`、`scripts/contract-size-budget.json`、
     `.github/workflows/contract-size.yml` 的審查者，並在 ruleset 勾選 Require review from Code Owners。
     `VerifyTenant (public RPC fork)` 也沒有路徑過濾，`tenant-verify.yml` 檔頭與 `TENANT_OPERATIONS.md` §1.6 都要求設成 required；
     它依賴公開 RPC，偶爾因節點逾時失敗時重跑即可，不要因此把它移出 required。
   - **不要**把有路徑過濾的 check 設成 required：`forge build + test`、`slither static analysis`、`gas snapshot`（Contracts CI）、
     `npm test`、`npm ci --ignore-scripts smoke`（Agent CI）、`yarn build`（Frontend CI）。PR 沒改到那些路徑時，
     GitHub 不會執行它們，required check 會一直停在「等待中」而擋住合併。
6. **盤點其他 repo 層級 secret**：Repository secrets 裡有一個名稱是 `BASE` 的 secret（名稱看得到、內容看不到）。
   確認它是不是私鑰；若是，比照上面移入對應的 environment，或在確認沒有 workflow 使用後刪除。

**完成後驗證（唯讀）：**

```bash
for e in admin-approval keeper settlement; do
  gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e" \
    --jq '{protection_rules: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}], deployment_branch_policy}'
  gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e/deployment-branch-policies" --jq '[.branch_policies[].name]'
  gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e/secrets" --jq '[.secrets[].name]'
done
gh api repos/zuemen/pepelab_onchain_cfd/actions/secrets --jq '[.secrets[].name]'   # 不應再有兩個 *_PRIVATE_KEY
grep -ln 'secrets.KEEPER_PRIVATE_KEY\|secrets.FEE_SETTLEMENT_PRIVATE_KEY' .github/workflows/*
# 只應列出 admin-base-sepolia、base-sepolia-keeper、price-keeper、x402-settlement-worker 四支
# 分支保護：rulesets 與傳統 branch protection 兩種設定方式都查，兩者擇一有設定即可
gh api repos/zuemen/pepelab_onchain_cfd/rulesets --jq '[.[] | {name, enforcement}]'
gh api repos/zuemen/pepelab_onchain_cfd/branches/master/protection \
  --jq '{checks: .required_status_checks.contexts, force_push: .allow_force_pushes.enabled}'   # 沒設時回 404
# rulesets 對 master 實際生效的 required checks（只含 rulesets；傳統保護看上一個查詢）
gh api repos/zuemen/pepelab_onchain_cfd/rules/branches/master \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

預期：`admin-approval` 有 required reviewers、secrets 為 `[]`；`keeper` 只有 `KEEPER_PRIVATE_KEY`；`settlement` 只有
`FEE_SETTLEMENT_PRIVATE_KEY`；三者的 branch policy 都是 `["master"]`。用 rulesets 設定時第一個查詢有結果、
第二個 404；用傳統 branch protection 時相反。required checks 必須包含上表 9 項（用 ruleset 時看第三個查詢，
用傳統保護時看第二個查詢的 `checks`）。

**失敗時：**
- 刪掉 repo 層級 secret 之後，排程出現「缺少 … PRIVATE_KEY」：把 secret 補進對應的 environment，**不要加回 repo 層級**。
- admin workflow 核准後失敗：重新 dispatch，**不要按 Re-run**（`run_attempt != 1` 會被守門拒絕）。
- 設了 required check 之後 PR 一直卡在「等待中」：多半是設到有路徑過濾的 check，照上表移除。

---

## 第 2 步：部署 keeper-trigger 與 monitoring 兩個 Cloudflare Worker

**為什麼：** GitHub 的 cron 實測間隔最長約 169 分鐘，價格會週期性逼近交易所 6 小時的 `maxPriceAge`；
keeper-trigger 每 20 分鐘 dispatch keeper workflow 補上。monitoring 每 5 分鐘讀鏈上狀態並告警——兩者都**還沒有部署**，
所以 repo 裡寫的「監控」「自動補寫價」目前都沒有在運作。

**前置條件：** 第 1 步已完成（尤其是刪除 repo 層級私鑰）；有 Cloudflare 帳號；本機有 Node 20+。
monitoring 至少要有一個告警通道（Telegram bot、Discord webhook 或 email webhook）。

### 2a. keeper-trigger（依 [`ops/keeper-trigger/README.md`](../ops/keeper-trigger/README.md)）

- 建議用 **GitHub App**（只給 Actions: Read and write，不勾 Webhook，只安裝在本 repo）；暫時可用 fine-grained PAT
  （只限本 repo、只給 Actions: Read and write、效期 ≤ 90 天）。
- 在 `ops/keeper-trigger/`：`npx wrangler login` → 以 `npx wrangler secret put` 設定 `GITHUB_APP_ID`、
  `GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`（PAT 路徑則是 `GITHUB_TOKEN`）→ `npx wrangler deploy`。
  App 私鑰從檔案導入（README 有 PowerShell 與 bash 的寫法），不要貼在指令列。
- 部署前可先跑 `node --test ops/keeper-trigger/keeper-trigger.test.mjs`。

**驗證（唯讀）：** Cloudflare → Workers → `pepelab-keeper-trigger` → Logs 每 20 分鐘每支 workflow 一行 `decide: dispatch=…`；
App 路徑另有 `auth: GitHub App installation token`。確認觸發者：

```bash
gh api 'repos/zuemen/pepelab_onchain_cfd/actions/runs?event=workflow_dispatch&per_page=10' \
  --jq '.workflow_runs[] | {name, actor: .actor.login, created_at}'
```

兩支 keeper 的 `workflow_dispatch` run 間隔應 ≤ 約 35 分鐘。

**失敗時：** App 認證錯誤碼 401＝App ID 與私鑰不是同一個 App、404＝installation ID 錯、422＝App 未安裝在本 repo 或沒有 Actions 權限。
改用 App 成功後 `npx wrangler secret delete GITHUB_TOKEN` 並撤銷 PAT。

### 2b. monitoring（依 [`ops/monitoring/README.md`](../ops/monitoring/README.md)）

- 先確認設定一致：`node scripts/check-monitoring.mjs`（應回一致）、`node --test ops/monitoring/monitor.test.mjs`。
- 在 `ops/monitoring/`：`npx wrangler kv namespace create MONITOR_STATE`，把回傳的 id 填回 `wrangler.toml`；
  以 `npx wrangler secret put` 設告警通道（`TELEGRAM_BOT_TOKEN`／`TELEGRAM_CHAT_ID`、`DISCORD_WEBHOOK_URL`、
  `ALERT_WEBHOOK_URL`／`ALERT_WEBHOOK_SECRET` 擇一以上）與強烈建議的 `HEARTBEAT_URL`；然後 `npx wrangler deploy`。
- `EXPECTED_PAY_TO`：README 列為必填，但必須是**換過之後**的安全地址。第 4 步完成前沒有安全值可填，先留空；
  部署當下會收到一則 `x402-payto:baseline`（SEV-2）與 `x402-payto:unsafe`（SEV-3，可用 `MUTE_KEYS = "x402-payto:unsafe"` 靜音，
  **不要**用 `MIN_SEVERITY` 壓）。第 4 步完成後回來填新 PAY_TO 並重新 `npx wrangler deploy`。
- 也預期會有 `oracle-deviation:no-reference`（SEV-3）：參考來源目前對所有資產 revert。

**驗證（唯讀）：** Logs 每 5 分鐘一行 `tick: findings=… notes=… sent=… pending=0 errors=0`。送一則測試告警：在 `[vars]`
暫時加 `GAS_MIN_ETH = "1000"` 後 deploy，下一輪應收到 SEV-3；移除後再 deploy，應收到「恢復」。

**失敗時：** 沒收到任何訊息先看 Logs 的 `errors=`；Worker 不會跟著 master 自動更新，改規則後要手動 `npx wrangler deploy`。
只清 payTo 基準時刪 `baselines:v1` 一個鍵，**不要刪 `state:v1`**（README 有指令）。

---

## 第 3 步：凍結舊部署

**為什麼：** 外洩地址 `0xE80A…Eb93` 仍是 Sepolia 54 顆舊合約的 owner／admin，也是 Base 三顆 oracle adapter
（AggregatorOracle、ChainlinkAdapter、PythAdapter）的 owner。凍結是把這些權限轉走或放棄，讓那把金鑰不再能改設定。
凍結**處理不了** `FeeRouter.platformTreasury`（immutable）——x402 那顆在第 4 步、平台那顆在第 5 步重新部署。

**依據：** [`RUNBOOK_FREEZE_LEGACY.md`](RUNBOOK_FREEZE_LEGACY.md)。腳本是 `contracts/script/FreezeLegacyDeployments.s.sol`，
讀回工具是 `ops/freeze-legacy/readback.mjs`，本機分叉演練紀錄在 `ops/freeze-legacy/rehearsal-2026-10-04/`。

**前置條件（runbook §7.0）：** `forge build` 通過；證明要接手權限的新地址（V2 admin、
`ADAPTER_NEW_OWNER`）的金鑰真的可用；記下外洩地址在兩條鏈的 nonce；先通知會收到告警的人
（Base 的 owner 轉移是 SEV-1，三顆 adapter 各響一次）。

**操作：** 依 runbook §7.1（唯讀確認）→ §7.2（本機分叉演練）→ §7.3（每條鏈各做「計畫 → 不廣播模擬 → 執行」，
**先 Base 後 Sepolia**，`--slow` 必加）。指令與確認字串照 runbook。這支腳本在腳本內讀金鑰環境變數（要簽的是外洩地址本身，
無法改用 keystore）：照 runbook 以 `read -rs` 只放進當下 shell，跑完立刻 `unset` 並關掉終端機，不寫進檔案或 history。
RPC 用 runbook 寫的 Base Sepolia（`https://sepolia.base.org` 或 `$BASE_SEPOLIA_RPC_URL`）與 Ethereum Sepolia 兩組，不要混用。

**完成後驗證（唯讀，runbook §7.4）：**

```bash
# 盤點全集讀回＋事件掃描：必須 exit 0、「可疑」為 0
# Base：ADAPTER_NEW_OWNER 是三顆 adapter 的新 owner（公開地址，§7.0 證明過金鑰可用的那個）；不帶會把新 owner 誤報成「計畫外」
ADAPTER_NEW_OWNER=<新 adapter owner 位址> LOGS_RPC=https://base-sepolia.gateway.tenderly.co \
  node ops/freeze-legacy/readback.mjs base-sepolia https://base-sepolia-rpc.publicnode.com
# Sepolia（Ethereum 測試網，chainId 11155111）
LOGS_RPC=https://sepolia.gateway.tenderly.co node ops/freeze-legacy/readback.mjs sepolia https://ethereum-sepolia-rpc.publicnode.com
# Base 的三顆 adapter 不再出現在外洩地址 FAIL 裡
node scripts/post-deploy-smoke.mjs --skip-http
```

並依 runbook 做 nonce 對帳、確認兩支 keeper 的下一次排程仍是綠的。

**失敗時：** runbook §7.5 有錯誤碼對照（`NotConfirmed`、`NonceMismatch`、`LeakedHasCode`、`KeepBroken`…）。中途中斷**不要直接重跑**：
先跑 readback，再把 nonce 參數更新成目前值。`OtherAdminMissing` 一類的保護**絕對不要繞過**。

---

## 第 4 步：換 PAY_TO、重部署 x402 FeeRouter（沿用舊 x402 保險金庫）

**為什麼：** x402 FeeRouter 的 `platformTreasury` 是外洩地址，而且是 **immutable**——沒有任何 setter 能改
（`docs/RUNBOOK_KEY_ROTATION.md` 提到的「owner-only setter」並不存在），只能重新部署。signal-api 的 `PAY_TO`
也指向同一個地址，付費端點因此 fail-closed 回 503，等於 x402 收費現在完全停擺。
**平台 FeeRouter 不在這一步**：它的保險金庫位址是 immutable，而 CopyTracker 綁的 FeeRouter 也是 immutable，
在這裡先換只會在第 5 步換主保險金庫時再部署一次，所以併入第 5 步（見第 5 步第 4 項）。

**x402 保險金庫維持舊的那顆，不換新版**（[`INSURANCE_VAULT_SHARES.md`](INSURANCE_VAULT_SHARES.md) §5.2）：它的 `exchange` 是 0、
不做 bailout、沒有外部 LP；換成 virtual shares 版反而會讓供給為 0 時的流入永久鎖死。2026-10-04 唯讀確認：舊 x402 金庫
`0xc7Af…7B9f` 的 `owner()` 是現行部署者 `0x27C2…A585`（不是外洩地址），`feeRouter()` 是舊 router `0x29e5…B57d`，
`totalSupply()` 為 0、`totalAssets()` 為 4000（0.004 USDC）——所以可以沿用。這顆是舊版程式碼（沒有 virtual shares）：
**種子必須在供給仍為 0、而且沒有任何流入來源的狀態下存入**，所以下面先斷開舊 router 再存。

**不要用 `contracts/script/DeployX402Router.s.sol`**：它一律 `new InsuranceVault(usdc)`，**無法沿用既有金庫**；
而且沒帶 `TREASURY` 時預設是部署者。本步改用 `forge create` 只部署 FeeRouter。
（後續待辦：讓這支腳本支援 `X402_VAULT` 沿用既有金庫、並強制要求 `TREASURY`；本 PR 不改部署腳本。）

**前置條件：**
- 第 1 步完成。準備一把**新的結算金鑰**（新 EOA，不是 Safe 或合約）：`PAY_TO` 必須等於這把金鑰的地址
  （結算 worker 會核對 PAY_TO、線上 `/` 公布的 payTo 與 signer 三者一致）。
- 決定新的 `TREASURY`（平台分潤收款地址），**必須明確指定**，並確認不在 `agent/shared/src/payoutSafety.ts` 的外洩名單內。
- 部署者（也是舊 x402 金庫的 owner `0x27C2…A585`）的 keystore 已建立；錢包有 Base Sepolia ETH，以及至少 1 USDC
  （Circle 官方 USDC `0x036C…CF7e`）作為種子。種子由同一個地址存入（下面用 `$SEEDER` 表示它的公開地址）。

先在 shell 設定公開值（都不是秘密）：

```bash
RPC=https://sepolia.base.org                          # Base Sepolia（chainId 84532）
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e       # Circle 官方 USDC（6 位小數）
VAULT=0xc7AfE2064106A608E0E21BFbF9aff89B0EAd7B9f      # 舊 x402 保險金庫（沿用）
TREASURY=<新的平台分潤地址>                            # 必填，不可留空、不可是外洩地址
SEEDER=<部署者地址，也是金庫 owner>
ACCOUNT=<keystore 名稱>
cast chain-id --rpc-url $RPC                          # 必須是 84532
```

**操作（依序；每一小步都先跑它的唯讀驗證再往下）：**

1. **斷開舊 router，停止所有流入。** 由金庫 owner 把 `feeRouter` 設成 0。之後舊 router 的 `routeExternalRevenue`
   等分潤呼叫會整筆 revert——這是預期的：x402 收費此時本來就因 payTo 不安全而停擺，舊 router 也不該再收錢。
   ```bash
   cast send $VAULT "setFeeRouter(address)" 0x0000000000000000000000000000000000000000 --account $ACCOUNT --rpc-url $RPC
   cast call $VAULT "feeRouter()(address)" --rpc-url $RPC          # 0x0000…0000
   ```
2. **確認供給仍為 0。**
   ```bash
   cast call $VAULT "totalSupply()(uint256)" --rpc-url $RPC        # 必須是 0
   ```
   **若不是 0（種子存入前已有他人份額），就停下來查明**，不要存種子：改走「新版金庫，先存種子再接線」的做法，
   並先回報。
3. **存種子**（1 USDC = 1000000，6 位小數）：
   ```bash
   cast send $USDC "approve(address,uint256)" $VAULT 1000000 --account $ACCOUNT --rpc-url $RPC
   cast send $VAULT "deposit(uint256)" 1000000 --account $ACCOUNT --rpc-url $RPC
   ```
4. **確認全部份額都在種子地址。**
   ```bash
   cast call $VAULT "balanceOf(address)(uint256)" $SEEDER --rpc-url $RPC   # 必須等於下一行
   cast call $VAULT "totalSupply()(uint256)" --rpc-url $RPC                 # > 0
   cast call $VAULT "totalAssets()(uint256)" --rpc-url $RPC                 # 約為 1000000 + 4000
   ```
   兩者不相等就停下來查明，不要接線。
5. **部署新 x402 FeeRouter**（在 `contracts/`；constructor 是 `(usdc, platformTreasury, insuranceVault)`，三者都是 immutable）：
   ```bash
   forge create src/FeeRouter.sol:FeeRouter --rpc-url $RPC --account $ACCOUNT --broadcast \
     --constructor-args $USDC $TREASURY $VAULT
   R=<上一行印出的 Deployed to 位址>
   cast call $R "platformTreasury()(address)" --rpc-url $RPC   # 必須等於 $TREASURY；不是外洩地址、不是 0
   cast call $R "insuranceVault()(address)"   --rpc-url $RPC   # 必須等於 $VAULT
   cast call $R "usdc()(address)"             --rpc-url $RPC   # 必須等於 $USDC
   cast call $R "owner()(address)"            --rpc-url $RPC   # 必須等於 $SEEDER（部署者）
   cast call $R "exchange()(address)"         --rpc-url $RPC   # 0x0000…0000（x402 不接 exchange）
   cast call $R "copyTracker()(address)"      --rpc-url $RPC   # 0x0000…0000
   ```
   任何一項不對就放棄這顆（immutable，不能改），不要接線，重新 `forge create`。
   `exchange`、`copyTracker` 保持 0（監控規則 `feerouter-wiring` 預期 x402 這兩項是 0）。
6. **接線**：
   ```bash
   cast send $VAULT "setFeeRouter(address)" $R --account $ACCOUNT --rpc-url $RPC
   cast call $VAULT "feeRouter()(address)" --rpc-url $RPC          # 必須等於 $R
   ```
7. **換結算金鑰與 PAY_TO（同一個時段內完成）**：結算 worker 會核對 `PAY_TO`、線上 `/` 的 payTo 與 signer 三者相同。
   只換了其中一邊的那段時間，結算 worker 會以「PAY_TO ≠ signer」fail-closed——這是預期中的失敗，不會送錯帳，
   但要盡快把下面幾項一次換完：
   - GitHub → Settings → Environments → `settlement` → 更新 `FEE_SETTLEMENT_PRIVATE_KEY`（新結算金鑰）。
   - GitHub → Settings → Secrets and variables → Actions → **Variables**：`PAY_TO`＝新結算 EOA、`X402_FEE_ROUTER`＝`$R`。
   - Vercel → signal-api 專案 → Settings → Environment Variables：`PAY_TO`、`X402_FEE_ROUTER` 同上，然後 Redeploy。
   - repo 內（走 PR）：`frontend/src/contracts/x402.ts` 的 `X402_FEE_ROUTER`、`agent/.env.example` 的 `X402_FEE_ROUTER`；
     結算 worker 會比對 repo variable 與 `x402.ts`，兩邊不同時 fail-closed。
   - Cloudflare monitoring：`EXPECTED_PAY_TO`＝新 PAY_TO，重新 `npx wrangler deploy`；移除第 2 步暫設的 `MUTE_KEYS`。
8. 同一個 PR 更新 `ops/monitoring/deployed.json`（`node scripts/check-monitoring.mjs --refresh-deployed` 後 `--write`），
   讓 x402 的 treasury 預期值換成新值。

**完成後驗證（唯讀）：**

```bash
cast call $R "platformTreasury()(address)" --rpc-url $RPC      # 新 TREASURY
cast call $VAULT "feeRouter()(address)" --rpc-url $RPC         # $R
curl -s https://agent-git-master-zuemens-projects.vercel.app/ | jq '{payTo, payToSafety}'   # payTo 是新 EOA、safe: true
node scripts/post-deploy-smoke.mjs   # X402FeeRouter.platformTreasury() 與 signal-api 兩項轉為 PASS；未付款 /oracle/sBTC 應回 402
```

此時 smoke test 仍會有 FAIL：平台 `FeeRouter.platformTreasury()`（第 5 步才會消失）與 `AssetVaultV2 version()`（第 5 步第 3 項）。

**失敗時：**
- 第 2 步 `totalSupply` 不是 0、或第 4 步份額不全在種子地址：停下來查明，不要接線。
- `platformTreasury()` 讀回不對：這顆 router 作廢（immutable，不能改），不要接線，重新 `forge create`。
- 已經 `setFeeRouter` 才發現 router 不對：由金庫 owner 立刻 `setFeeRouter(0x0…0)` 斷開，再部署正確的那顆。
- signal-api 仍回 503 `payto_unsafe`：Vercel 的 `PAY_TO` 沒更新或沒 Redeploy；或新地址有 code（不是 EOA）。
- 結算 worker 持續失敗「PAY_TO ≠ signer」：`settlement` environment 的金鑰與 `PAY_TO` 不是同一把。

---

## 第 5 步：完整 cutover（#130、新 GuardedOracle、AssetVaultV2 升級 V2_5、InsuranceVault＋平台 FeeRouter＋CopyTracker、PepeIncentives、PepeAMM）

**為什麼：** 交易引擎、保險金庫份額定價、oracle 速率限制與凍結期限、V2 金庫的安全修正（C12–C16、M1）、PepeIncentives、
PepeAMM 的修正都只存在於原始碼；平台 FeeRouter 的 `platformTreasury` 仍是外洩地址（immutable）。
[`RELEASE_STATUS.md`](RELEASE_STATUS.md) 把它們列為「原始碼較新（待部署）」。除了 V2 金庫（UUPS）之外都不可升級，
只能重新部署並改接線。

**前置條件：**
- 第 1、4 步完成；`forge test` 全綠；guardian 是**另一把**金鑰（`DEPLOY_130_CUTOVER.md` §2）。
- 部署者金鑰已匯入 keystore，地址等於 `DEPLOY_130_CUTOVER.md` §2 指定的 `0x27C2…A585`：
  `cast wallet address --account $ACCOUNT` 印出的就是它。
- 挑沒有展示的時段，之後留兩天緩衝。
- 公開值：`RPC=https://sepolia.base.org`（Base Sepolia，chainId 84532）、`ACCOUNT=<keystore 名稱>`、
  `DEPLOYER=0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`。`cast chain-id --rpc-url $RPC` 必須是 84532。
- **先 dispatch keeper，確認價格是新的**（理由見 `DEPLOY_130_CUTOVER.md` §5.0）。第 2、3 項開始前各再做一次：
  ```bash
  SINCE=$(date -u -d '-60 seconds' +%Y-%m-%dT%H:%M:%SZ)   # 往前 60 秒，容許本機時鐘比 GitHub 快
  gh workflow run base-sepolia-keeper.yml --ref master
  # dispatch 後要幾秒才查得到這個 run：最多輪詢 5 分鐘，取它的 id
  RUN=""; for i in $(seq 1 60); do sleep 5; RUN=$(gh run list --workflow base-sepolia-keeper.yml --event workflow_dispatch \
    --limit 5 --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$SINCE\")][0].databaseId // empty"); [ -n "$RUN" ] && break; done
  [ -n "$RUN" ] || echo "5 分鐘內找不到這次 dispatch 的 run：到 Actions 頁面確認，不要往下做"
  gh run watch "$RUN" --exit-status          # run 失敗時非 0
  node scripts/post-deploy-smoke.mjs --skip-http --fresh-since "$SINCE" --max-age 21600
  # exchange 讀的 oracle 與 V2 金庫讀的 oracle：「最近一次寫價」都必須晚於 dispatch，而且 11 檔都不超過 6 小時
  ```

**私鑰處理：** 第 5 步的每一支腳本都以 `msg.sender` 當部署者，一律用 keystore：
`--account $ACCOUNT --sender $DEPLOYER`（`DeployAMM` 的 `--sender` 要是 MockUSDC 的 owner）。
`DeployPepeIncentives`、`DeployAMM` 原本在腳本內讀 `vm.envUint("PRIVATE_KEY")`，2026-10-07 已改成 `vm.startBroadcast()`
（測試 `contracts/test/DeployPepeScripts.t.sol`），不再需要 `export PRIVATE_KEY`。

**操作（依序）：**

> **Oracle 選擇決定順序。** 若 #130 選 `ORACLE_KIND=guarded`（`DEPLOY_130_CUTOVER.md` §4），exchange 上的 oracle 是 **immutable**：
> **新 GuardedOracle（下面第 2 項）必須在 #130 之前部署**，並在 #130 指向這顆新的；否則新 exchange 會永久讀舊 oracle
> （沒有時間窗上限、凍結沒有期限），要換只能再重部署一次 exchange。選預設的 MockOracle 時才照下面的順序。

1. **#130 cutover**：[`DEPLOY_130_CUTOVER.md`](DEPLOY_130_CUTOVER.md) §3 設風險參數 → §5.0 先寫價 → §5.1 清空舊 exchange →
   §5.2 預檢與 fork 模擬（不需要金鑰）→ §5.3 broadcast → §5.4 `Verify130` → §7 部署後必做（一個 commit）。
   §5.3 第 9 步（舊 InsuranceVault／FeeRouter 改指向新 exchange）**不可逆**。
   - 環境變數：`GUARDIAN`（必填）、`MARKET_OPERATOR`、`OI_CAP_NON_RWA_USDC`、`OI_CAP_RWA_USDC`、`MAX_PROFIT_BPS`、`ORACLE_KIND`；
     要一起換 TraderStake 時 `DEPLOY_NEW_TRADER_STAKE=true`；中斷續跑用 `RESUME_*`（§9）。
   - broadcast：`forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened --rpc-url $RPC --account $ACCOUNT --sender $DEPLOYER --broadcast --slow -vv`
   - 驗證：`forge script script/Verify130.s.sol:Verify130 --rpc-url $RPC -vv`，帶 `EXCHANGE_NEW`、`COPYTRACKER_NEW`、`SESSION_MANAGER_NEW`、
     `STRATEGY_REGISTRY_NEW`、`GUARDIAN`（與 broadcast 印出的值相同）。
2. **新 GuardedOracle**：`DEPLOY_130_CUTOVER.md` §10，`script/RedeployGuardedOracle.s.sol`。
   - 先跑 fork 測試：`forge test --match-path test/fork/RedeployGuardedOracleFork.t.sol --fork-url $RPC -vv`。
   - 環境變數：`KEEPER`、`GUARDIAN`、`KEEPER_HEARTBEAT`（keeper 實際值，秒）、`ORACLE_MAX_PRICE_AGE`（預設 21600，必須 ≥
     `KEEPER_HEARTBEAT` ＋ `KEEPER_SCHEDULE_SLACK`）、`WINDOW_SECONDS`／`WINDOW_DEVIATION_BPS`（預設 1h／2500）；
     `OLD_GUARDED_ORACLE`、`VAULT_PROXY`、`EXCHANGE_NEW` 有預設值時核對一次。
   - broadcast：`forge script script/RedeployGuardedOracle.s.sol:RedeployGuardedOracle --rpc-url $RPC --account $ACCOUNT --sender $DEPLOYER --broadcast --slow -vv`
   - **要在治理 phase 2 之前做**；`ORACLE_KIND=guarded` 時見上方方框，提前到第 1 項之前。
   - **broadcast 之後 keeper 必須改寫新 oracle，而且要在 `ORACLE_MAX_PRICE_AGE`（預設 6 小時）內完成。** 腳本會把 V2 金庫的
     `oracle` 改指向新 oracle，但 keeper 仍照 `KEEPER_GUARDED_ORACLE` 寫舊的那顆：新 oracle 只有搬過去的那一筆價格，
     6 小時後 V2 金庫的報價全部過期。依序：
     1. 改 `.github/workflows/base-sepolia-keeper.yml` 的 `KEEPER_GUARDED_ORACLE` 為新 oracle。這是**持鑰、整檔 sha256 釘選**的
        workflow：人工審過整份 diff 後，用 `node scripts/check-workflow-guards.mjs --print-pins` 印出新值，更新
        `scripts/check-workflow-guards.mjs` 的 `PINNED_WORKFLOWS["base-sepolia-keeper.yml"]`；否則 CI 的
        `workflow guards (environment / secrets / triggers)` 會紅。
     2. 改 `frontend/src/contracts/addresses.ts` 的 `V2_STACK[84532].GuardedOracle`（`node scripts/check-addresses.mjs` 會核對它與
        workflow 的 `KEEPER_GUARDED_ORACLE` 一致），並照 `ops/monitoring/README.md` 重產 `monitors.json`／`deployed.json`。
        各 agent 主機 `agent/.env` 的 `KEEPER_GUARDED_ORACLE` 也一起改。
     3. 上面兩項放在同一個 PR，合併。
     4. dispatch keeper（照前置條件的指令；`--fresh-since` 會同時檢查 V2 金庫讀的 oracle）。
     5. 讀回**新 oracle** 的價格時間：
        `cast call <新 oracle> "peek(bytes32)(uint256,uint256,bool,bool)" $(cast keccak "sBTC") --rpc-url $RPC`，第二個值
        （updatedAt）必須晚於 dispatch；smoke 的「V2 金庫 oracle 最近一次寫價」必須是 PASS。
     6. 舊 oracle 停止寫價：依腳本結尾的提示，由 guardian 對**舊** oracle `setPaused(true)`（鏈上現行的舊版沒有期限）。
        例外：若 #130 用了 `ORACLE_KIND=guarded` 而且 exchange 讀的仍是舊 oracle，**不要暫停**——那時 keeper 必須同時寫兩顆
        （`DEPLOY_130_CUTOVER.md` §10）。
3. **AssetVaultV2 升級到 V2_5**（`DEPLOY_130_CUTOVER.md` §8；**要在治理 phase 2 之前做**，phase 2 之後只能走 timelock）。
   這次升級帶的是安全修正（審查 C12–C16、M1）：即時報價有效期上限 `min(maxPriceAge, 6h)`、任何資產 unpriced 時 mint revert、
   feed 永久失效時的豁免流程。漏做時金庫照常運作、接線也都對，只有版本號與 bytecode 比對看得出來（第 7 步會抓）。
   - 前提：所有有未償額的資產報價都不到 6 小時（先照上面 dispatch keeper），否則腳本拒絕執行。
   - `cd contracts && bash script/check-vault-storage-layout.sh`（只允許尾端追加：`_lastGood` slot 12、`_unpricedExempt` slot 13、
     `__gap` 從 slot 14 起 41 格、結尾仍是 slot 55）。
   - fork 模擬：`forge script script/UpgradeVaultToV2_5.s.sol:UpgradeVaultToV2_5 --fork-url $RPC --sender $DEPLOYER`
   - **2026-10-05 已預先驗證（未廣播）：** storage layout 檢查通過（V2_5 = V2_4 尾端追加 `_lastGood` slot 12、`_unpricedExempt`
     slot 13，`__gap` 43→41，結尾 slot 55 不變）；對 Base Sepolia 實況做 fork 模擬成功——升級前 11 個資產、負債
     1357.19、unpriced 0，升級後 `version()` = 2.5.0、負債不變、腳本自我核對「每個欄位與每個資產都一致」，預估 gas 約 357 萬。
     廣播時仍要先 dispatch keeper（前提是價格都不到 6 小時），並在廣播當下重跑一次 fork 模擬。
   - broadcast：同一行改成 `--rpc-url $RPC --account $ACCOUNT --sender $DEPLOYER --broadcast --slow`。環境變數 `VAULT_PROXY`
     （預設現行金庫）、`VAULT_MAX_PRICE_AGE`（預設 21600）。
   - 驗證：`cast call 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a "version()(string)" --rpc-url $RPC` 必須是 `"2.5.0"`；
     更新前端 ABI（§8 第 4 點）。
4. **InsuranceVault＋平台 FeeRouter＋CopyTracker（同一批）——部署腳本已寫好：`contracts/script/RedeployInsuranceStack.s.sol`
   （測試 `test/RedeployInsuranceStack.t.sol`）。不要用 cast 自己湊。**
   - **仍有兩個前提，腳本會擋，不是建議：**
     1. **第 1 項（#130）必須先完成。** 腳本以 `marketOperator()` 探測 `EXCHANGE`，舊版 exchange 一律拒絕——§5.3 的遷移窗口要用
        `setAssetMode`／`marketOperator`，舊版沒有。2026-10-05 以現行 `0x827e…` 對 Base Sepolia 做 fork 模擬，確認被擋下。
     2. **需要 timelock。** 治理移交尚未進行（`TimelockController` 尚未部署），而本項的安全性來自「存種子後、同一個 broadcast 區塊內
        移交 timelock」，縮短 §5.3 那段「部署者金鑰外洩可改寫金庫設定並取走種子」的窗口。注意這仍是多筆獨立交易：`--slow`
        依序送出、每筆等上一筆確認，只是把窗口縮到幾個區塊，**不是消除**。沒有 timelock 時腳本預設拒絕執行；`KEEP_DEPLOYER_OWNER=true` 可明確選擇保留部署者為 owner，但等於接受那段窗口，**由擁有者決定**。
        給了 `TIMELOCK` 時，它必須**已經是 `EXCHANGE` 的 owner**（`HandoverToTimelock` 第 1 階段已跑完）——只有這樣才能證明它是
        proposer／executor 已核對過的那一個；指錯或沒有角色的 timelock 會讓三個新合約永遠無法再改（PR #254 審查第 4 點）。
   - 審查後追加的防護（PR #254 第一輪對抗式審查）：部署者不得是外洩地址或 7702 委派；新 CopyTracker 也一併移交 timelock
     （`withdrawSlashReserve` 是 owner 專屬）；「是否已存種子」改看部署者自己的份額值，不看 `totalSupply`（任何人都能存 1 wei）；
     續跑的金庫要是有 `DECIMALS_OFFSET()==6` 的新版、不能是 exchange 現役金庫、零供給時不得已有資產；`TREASURY` 不得是任何協議合約；
     `VERIFY_ONLY` 也重跑地址檢查並讀回部署者的種子部位（所以要帶 `BROADCASTER`）。種子份額仍留在部署者 EOA——
     要不要轉給 treasury 是擁有者決定，腳本不做。
   - 第二輪審查追加：**`TRADER_STAKE` 改為必填、沒有預設值。** 新 CopyTracker 的 `registry`／`traderStake` 是 immutable；
     第 1 項若帶了 `DEPLOY_NEW_TRADER_STAKE=true`，舊 TraderStake 就不再是 Registry 認的那一個，用預設值會讓新 CopyTracker
     永久綁錯。腳本會要求 `STRATEGY_REGISTRY.stakeContract() == TRADER_STAKE`，並在 exchange 已有 CopyTracker 時要求它的
     `registry()`／`traderStake()` 與輸入一致（exchange 尚無 CopyTracker 時略過這項比對）。部署者也不得持有 timelock 的
     `DEFAULT_ADMIN_ROLE`（比照 `HandoverToTimelock`）。
   - 用法（環境變數：`EXCHANGE`、`STRATEGY_REGISTRY`、`TRADER_STAKE`、`TREASURY` 必填，`TRADER_STAKE` 填第 1 項之後 Registry
     實際使用的那一個；`TIMELOCK` 或 `KEEP_DEPLOYER_OWNER` 擇一；續跑用
     `RESUME_VAULT`／`RESUME_FEE_ROUTER`／`RESUME_COPY_TRACKER`）：
     ```bash
     cd contracts
     # fork 模擬（不帶金鑰、不送交易）
     forge script script/RedeployInsuranceStack.s.sol:RedeployInsuranceStack --fork-url $RPC --sender $DEPLOYER
     # broadcast
     forge script script/RedeployInsuranceStack.s.sol:RedeployInsuranceStack --rpc-url $RPC --account $ACCOUNT --sender $DEPLOYER --broadcast --slow
     # 對真實鏈讀回核對（任何一項不符即非 0 結束）
     VERIFY_ONLY=true BROADCASTER=$DEPLOYER RESUME_VAULT=<新金庫> RESUME_FEE_ROUTER=<新 router> RESUME_COPY_TRACKER=<新 CT> \
       forge script script/RedeployInsuranceStack.s.sol:RedeployInsuranceStack --rpc-url $RPC
     ```
     腳本結尾印出四個後續呼叫（`setInsuranceVault`、`setFeeRouter`、exchange 與 TraderStake 的 `setCopyTracker`）的
     targets／values／payloads、`predecessor`（0）、`salt`（`keccak256("RedeployInsuranceStack" ‖ 新 CopyTracker)`，可重現）、
     `delay`（`timelock.getMinDelay()`）、operation id，以及 `scheduleBatch` 與 `executeBatch` 的**完整 calldata**。
     **必須用這一個 `scheduleBatch` 一次排程、到期後用對應的 `executeBatch` 一次執行，不要逐筆排程**——分開排就可能只有一邊生效，
     exchange 與 TraderStake 的 `copyTracker` 不一致。TraderStake 也必須已由 timelock 持有，否則整批執行會失敗（腳本會提示）。
     測試 `test_followUpBatch_schedulesAndExecutesThroughTheTimelock` 以腳本印出的參數實跑 schedule → 等待 → execute。
   - 為什麼要同一批：平台 FeeRouter 的 `insuranceVault` 與 `platformTreasury` 都是 immutable，CopyTracker 的 `feeRouter` 也是
     immutable（`INSURANCE_VAULT_SHARES.md` §5.1），三者要一起換。依現有腳本，**平台 FeeRouter 只會部署一次，但 CopyTracker 會部署
     兩次**：第 1 項的 `Redeploy130Hardened.s.sol` 把現行 FeeRouter 寫成常數，建出的 CopyTracker 綁的是舊 FeeRouter，這一項換
     FeeRouter 時必須再部署一次。要做到 CopyTracker 也只部署一次，得先讓 Redeploy130 接受新的 FeeRouter／金庫位址（另一個後續待辦）。
   - 這支部署腳本需要做到（[`INSURANCE_VAULT_SHARES.md`](INSURANCE_VAULT_SHARES.md) §5.3）：
     1. 同一次 broadcast 內：部署新 InsuranceVault（`feeRouter`、`exchange` 留 0）→ 由平台地址存入至少 1 USDC 新資金並 require
        `totalSupply > 0` → 部署新平台 FeeRouter（`TREASURY` **必填**、不可為 0、不可在外洩名單內；constructor
        指向新金庫）→ 部署新 CopyTracker（指向新 FeeRouter）→ 新金庫 `setFeeRouter`／`setExchange`、新 FeeRouter
        `setExchange`／`setCopyTracker` → 新金庫與新 FeeRouter `transferOwnership` 給 timelock。
     2. broadcast 結束後讀回核對：`owner()`、`exchange()`、`feeRouter()`、`platformTreasury()`、`insuranceVault()`、`copyTracker()`、
        `totalSupply()`，任何一項不符就以非 0 結束。
     3. 印出要排進 timelock 的呼叫：`PerpetualExchange.setInsuranceVault`、`setFeeRouter`，以及 `TraderStake.setCopyTracker`、
        交易所對新 CopyTracker 的授權——以單一 `scheduleBatch`／`executeBatch` 的完整 calldata 印出。
     4. 支援 fork 模擬（不帶金鑰）與 `RESUME_*` 續跑；用 `msg.sender` 當部署者，讓 `--account` 可用。
   - 腳本合併後的執行順序同 §5.3：broadcast → timelock `scheduleBatch` 預排（等 48 小時）→ 遷移窗口（ReduceOnly →
     `executeBatch` → 立刻搬協議自有部位 → 切回 Active）。舊金庫**不要**把 `exchange` 設成 0。
   - 第 1 項之後、這一項完成之前，平台手續費仍累積在舊 FeeRouter，而它的提領只認外洩的 treasury。2026-10-04 唯讀讀到的累積額：
     `platformEarnings()` = 0.06 MockUSDC（測試幣）。本項完成前定期讀這個值；明顯增加時優先推動 #130 與 timelock（腳本本身已不是瓶頸）。
5. **PepeIncentives**：`contracts/script/DeployPepeIncentives.s.sol`。它的 `copyTracker` 是 immutable，**要綁第 4 項之後的最終
   CopyTracker**——第 4 項阻塞期間這一項也等；先部署就要在第 4 項之後再部署一次。
   - 環境變數：`PEPE_TOKEN`（`addresses.ts` 的 PepeToken）、`PERPETUAL_EXCHANGE`（第 1 項的新
     exchange）、`COPY_TRACKER`（最終 CopyTracker）、`ESG_REGISTRY`（`addresses.ts` 的 ESGRegistry；現行部署填的是 0 位址，
     沿用就填 0 位址並保持監控規則 `pepe-incentives-wiring` 的預期值）。
   - `forge script script/DeployPepeIncentives.s.sol --rpc-url $RPC --account $ACCOUNT --sender $DEPLOYER --broadcast --slow -v`
   - 部署後更新 `addresses.ts`、轉入獎勵池；新實例從空狀態開始，舊的連續簽到等資料不會帶過來（`KNOWN_LIMITATIONS.md`）。
6. **PepeAMM**：`contracts/script/DeployAMM.s.sol`，簽署者必須是 MockUSDC 的 owner。
   - 環境變數：`MOCK_USDC`、`MOCK_ORACLE`（都取 `addresses.ts` 的 Base Sepolia 值；oracle 若在第 1 項換了，
     填 exchange 實際讀的那顆）、選用 `SEED_ETH`／`SEED_USDC`。
   - `forge script script/DeployAMM.s.sol --rpc-url $RPC --account $ACCOUNT --sender <MockUSDC owner> --broadcast --skip-simulation --slow -v`
   - 部署後更新 `addresses.ts`。

**完成後驗證（唯讀）：**

```bash
cd contracts && forge script script/Verify130.s.sol:Verify130 --rpc-url https://sepolia.base.org -vv   # 參數同第 1 項
cd .. && node scripts/check-addresses.mjs && node scripts/check-monitoring.mjs
node scripts/post-deploy-smoke.mjs     # 接線（含 agent session 授權、AssetVaultV2 version()）、外洩地址、keeper、signal-api
cast call <新平台 FeeRouter> "platformTreasury()(address)" --rpc-url https://sepolia.base.org   # 第 4 項完成後：新 TREASURY
```

**失敗時：** `DEPLOY_130_CUTOVER.md` §9：一律用 `RESUME_*` 續跑，不要從頭重跑；各步的回滾指令在 §9。
V2_5 升級被拒（價格過期）：照前置條件重新 dispatch keeper 後再跑。InsuranceVault 遷移中斷時，舊金庫仍在保護交易——
不要提領舊金庫，先把各資產維持 ReduceOnly 再處理。

---

## 第 6 步：每台 agent 主機執行 `npm run vc-status:init`

**為什麼：** agent 下單前要查 VC 撤銷清單；清單目錄沒有初始化時，所有開倉與平倉都會被拒（`VC_STATUS_UNVERIFIED`）。
第 5 步的 cutover 之後也要為新的 session manager 與 session 0 重新簽發 VC。

**前置條件：** 主機上有 `agent/` 與 Node；清單目錄放在**持久儲存**上。

**操作：** 在每台跑 agent（MCP server、tg-bot、demo agent）的主機的 `agent/` 目錄：

```bash
npm run vc-status:init        # 只跑一次；不連鏈、不送交易。目錄可用 VC_STATUS_DIR 指定
```

**不要**放進容器啟動腳本（每次啟動都重建會讓撤銷紀錄消失）。

**驗證（唯讀）：** 成功時印出 `✓ 清單目錄就緒：<dir>/index.json`；之後 MCP／tg-bot 啟動不再出現 `::error::[vc-status]`。
單張 VC：`npx tsx examples/vc-status.ts check --vc <vc.json>`；到期檢查 `npm run vc-status:expiring`（建議每天排程）。

**失敗時：** 若目錄在暫存空間或容器內，改到持久磁碟後重跑；不要手動建立 `index.json`。

---

## 第 7 步：部署後重跑發布狀態

**為什麼：** 「已部署」要由鏈上比對證明，而不是由人宣布。每次部署或 cutover 之後都要重跑，讓
[`RELEASE_STATUS.md`](RELEASE_STATUS.md) 的對應元件從「原始碼較新（待部署）」變成「鏈上＝原始碼」。

**前置條件：** master 已含第 3–5 步的位址更新（`addresses.ts`、`sessionManager.ts`、`x402.ts`）；本機有 Foundry。
編譯器由 `contracts/foundry.toml` 的 `solc_version` 釘選（目前 0.8.36）；`forge build` 會自動下載。

**操作：**

```bash
cd contracts && forge build && cd ..
node scripts/check-deployment-status.mjs          # 唯讀 RPC；寫 docs/RELEASE_STATUS.md 與 docs/release-status.json
node scripts/check-deployment-status.mjs --offline
node scripts/post-deploy-smoke.mjs
```

連網模式遇到 RPC 失敗（整條鏈或任何一個元件）會以非 0 結束而且**不寫檔**——換一個 RPC（`--rpc 84532=<url>`）重跑，
不要提交一份全是「無法比對」的報告。`contracts/out` 不是用釘選的 solc 編的也會拒絕執行。

有新的展示驗收證據時，先更新 `ops/release-status/components.json` 的 `acceptance`（只能引用 repo 內存在的檔案），
再跑 `node scripts/check-deployment-status.mjs --refresh-acceptance`（不連網）。產生的兩個檔案走 PR 提交。

**驗證：**
- `--offline` 通過（CI 的 `release status ↔ addresses.ts` 也會跑）；smoke test 沒有 FAIL。
- `RELEASE_STATUS.md` 的 Base Sepolia 摘要：「仍指向外洩地址的元件」為 0。
- 下表「第 3–5 步之後應為鏈上＝原始碼」的每一列都必須是「鏈上＝原始碼」。**特別是 AssetVaultV2**：漏做第 5 步第 3 項時，
  它會停在「鏈上是舊版 AssetVaultV2_4」，smoke test 的 `AssetVaultV2 version()` 也會 FAIL。
  ```bash
  node -e 'const r=require("./docs/release-status.json");for(const c of r.chains["84532"].components)console.log(c.id.padEnd(22),c.status,c.matched??"")'
  cast call 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a "version()(string)" --rpc-url https://sepolia.base.org   # "2.5.0"
  ```
- 做完 7 步之後**仍會是「原始碼較新」**的元件只能是下表標成「刻意不部署」或「待辦」的那些；表外的元件仍是「原始碼較新」，
  就是漏做了某一步。

**7 步之後各元件的預期狀態（Base Sepolia）：**

| 元件 | 7 步之後 | 理由 |
|---|---|---|
| PerpetualExchange、StrategyRegistry、AgentSessionManager | 鏈上＝原始碼 | 第 5 步第 1 項（#130）重部署 |
| CopyTracker | 鏈上＝原始碼 | 第 5 步第 1 項部署、第 4 項再部署（綁新 FeeRouter）；第 4 項阻塞期間是 #130 那顆，比對同樣一致 |
| TraderStake | 待辦，或鏈上＝原始碼 | 第 1 項帶 `DEPLOY_NEW_TRADER_STAKE=true` 才會重部署；不帶時 M2（申請 unstake 即喪失資格）不生效，列為待辦 |
| GuardedOracle | 鏈上＝原始碼 | 第 5 步第 2 項 |
| AssetVaultV2 | 鏈上＝原始碼 | 第 5 步第 3 項（V2_5 升級） |
| InsuranceVault、FeeRouter（平台） | **待辦** | 第 5 步第 4 項（`RedeployInsuranceStack.s.sol`），等 #130 與 timelock；完成前平台 FeeRouter 的 treasury 仍是外洩地址 |
| X402FeeRouter | 鏈上＝原始碼 | 第 4 步 |
| PepeIncentives | 待辦（隨第 4 項） | 綁最終 CopyTracker（immutable），等第 5 步第 4 項 |
| PepeAMM | 鏈上＝原始碼 | 第 5 步第 6 項 |
| EsgRewardDistributor、ESGRegistryV2、SustainabilityBadge、PepeStaking、PepeClaim、AssetVault、SyntheticAsset、SyntheticAssetV2、MockUSDT、MockSwapRouter | 鏈上＝原始碼 | 現在就一致（2026-10-04，solc 0.8.36 比對）；EsgRewardDistributor 依 `DEPLOY_130_CUTOVER.md` §7 第 8 項重部署後仍應一致 |
| MockOracle | 刻意不部署（選 MockOracle 時） | exchange 的 `oracle` 是 immutable，換 MockOracle 就要再換一次 exchange；差異是 2026-08-06 稽核修正（#7）。長期以 GuardedOracle 取代（`ORACLE_KIND=guarded`，或 ADR-013 的 pull oracle）。選 guarded 時 exchange 不再讀它 |
| MockUSDC | 刻意不部署 | 測試結算幣：所有保證金、保險金與金庫餘額都以它計價，重部署等於全部歸零重來；差異（#91）是測試用功能 |
| PepeToken | 刻意不部署 | 代幣合約：重部署等於發一顆新幣，持有人餘額與質押全部失效；差異是 2026-08-06 稽核修正（#7） |
| AggregatorOracle、ChainlinkAdapter、PythAdapter | 刻意不部署 | 展示用、沒有接進 exchange（keeper 已停用由外洩金鑰控制的 relay 來源，#242）；第 3 步轉走 owner 後已無外洩風險 |
| KYCRegistry | 待辦 | 2026-08-06 稽核修正（#7）未部署；`Verify130` 斷言 exchange 沿用現行 KYC，換 KYC 需要另一輪接線，未排入本操作包 |

Sepolia（legacy 展示鏈）全部刻意不部署：第 3 步凍結後只保留取回資產的路徑，不再升級。

**失敗時：**
- 仍是「原始碼較新」而且不在上表的例外裡：鏈上不是 master 的版本。看該列的說明——若寫「鏈上是舊版 X」，就是部署了舊候選
  （例如 AssetVaultV2 停在 V2_4 = 漏做第 5 步第 3 項）；若是 byte 位移不同，確認部署時用的是 master 與
  `contracts/foundry.toml` 的設定（`via_ir`、`optimizer_runs 200`、釘選的 `solc_version`）。
- 「無法比對」：先確認 `forge build` 產物存在、前端設定的位址正確、RPC 可用。
- CI `--offline` 失敗並說「位址已變更」：改了位址卻沒重跑本腳本，照上面重跑後一起提交。
