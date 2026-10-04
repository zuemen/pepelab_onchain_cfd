# 擁有者操作包（OWNER_ACTIONS）

> 這份文件列出**只有 repo 與部署金鑰的擁有者能做**的事，依建議順序排列。程式碼裡的修正大多已合併，
> 但合併只改了原始碼：鏈上合約、GitHub 設定、Cloudflare Worker、Vercel 環境變數都不會因為 PR 合併而改變。
> 現況見 [`RELEASE_STATUS.md`](RELEASE_STATUS.md)（由腳本產生）。**已合併不等於使用者受保護。**
>
> 這是公開文件：不含任何私鑰或聯絡方式；已知外洩的舊部署者地址一律寫成縮寫 `0xE80A…Eb93`
> （完整清單在 `agent/shared/src/payoutSafety.ts` 的 `COMPROMISED_ADDRESSES`）。需要金鑰的指令只寫
> 「在哪裡、用哪支腳本」，金鑰一律只放在當下 shell 的環境變數或 GitHub／Cloudflare 的 secret，
> 不寫進檔案、不出現在指令列歷史。

## 總覽

| # | 步驟 | 在哪裡做 | 預估時間 | 完成後的唯讀驗證 |
|---|---|---|---|---|
| 1 | 私鑰移入受保護的 environment、刪 repo 層級 secret、設 branch protection | GitHub 設定頁 | 45–60 分 | `gh api …/environments/…`、`gh api …/actions/secrets` |
| 2 | 部署 keeper-trigger 與 monitoring 兩個 Worker | Cloudflare | 1.5–2 小時 | Worker Logs、`gh api …/actions/runs` |
| 3 | 凍結舊部署上外洩地址的權限 | 本機 forge（Base 先、Sepolia 後） | 2–3 小時 | `ops/freeze-legacy/readback.mjs`、`post-deploy-smoke.mjs` |
| 4 | 換 PAY_TO、重部署 x402 FeeRouter 與平台 FeeRouter | 本機 forge＋Vercel＋GitHub variables | 1.5–2 小時 | `cast call … platformTreasury()`、`post-deploy-smoke.mjs` |
| 5 | 完整 cutover：#130、GuardedOracle、InsuranceVault、PepeIncentives、PepeAMM | 本機 forge（先 dispatch keeper） | 動手 6–8 小時，另有 timelock 48 小時等待與 2 天緩衝 | `Verify130`、`post-deploy-smoke.mjs` |
| 6 | 每台 agent 主機 `npm run vc-status:init` | 各 agent 主機 | 每台 5 分 | `agent/.state/vc-status/index.json` 存在 |
| 7 | 重跑發布狀態與 smoke test，確認「原始碼較新」變成「鏈上＝原始碼」 | 本機 | 45–60 分（含 `forge build`） | `check-deployment-status.mjs --offline`、`post-deploy-smoke.mjs` |

**合計：動手約 13–17 小時，分散在至少 3–4 天**（第 5 步的 timelock 48 小時等待與 cutover 後 2 天緩衝不計入動手時間）。
第 1 步必須最先做；第 2 步的 Worker 在第 1 步完成前不可以持有任何 Actions: write 憑證。

每一步完成後都可以跑一次部署後 smoke test（唯讀、不需要金鑰），看 FAIL 是否如預期減少：

```bash
node scripts/post-deploy-smoke.mjs              # 鏈上接線、外洩地址、keeper 新鮮度、signal-api
node scripts/post-deploy-smoke.mjs --skip-http  # 只看鏈上
```

2026-10-04 的基準：FAIL 7 項——平台與 x402 FeeRouter 的 `platformTreasury()`、Base 三顆 oracle adapter 的 `owner()`
仍是外洩地址，signal-api 的 payTo 是外洩地址、付費端點因此 fail-closed 回 503。第 3、4 步完成後這 7 項應全部消失。

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

     前兩項是 `ops/keeper-trigger/README.md` 點名的最低要求；其餘五項同屬 Consistency（沒有路徑過濾、每個 PR 都會跑），一起設。
   - **不要**把有路徑過濾的 check 設成 required：`forge build + test`、`slither static analysis`、`gas snapshot`（Contracts CI）、
     `npm test`、`npm ci --ignore-scripts smoke`（Agent CI）、`yarn build`（Frontend CI）。PR 沒改到那些路徑時，
     GitHub 不會執行它們，required check 會一直停在「等待中」而擋住合併。主合約大小門檻在 `forge build + test` 裡，
     改到 `contracts/**` 或門檻腳本時一定會跑。

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
gh api repos/zuemen/pepelab_onchain_cfd/rulesets --jq '[.[] | {name, enforcement}]'
```

預期：`admin-approval` 有 required reviewers、secrets 為 `[]`；`keeper` 只有 `KEEPER_PRIVATE_KEY`；`settlement` 只有
`FEE_SETTLEMENT_PRIVATE_KEY`；三者的 branch policy 都是 `["master"]`。

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
凍結**處理不了** `FeeRouter.platformTreasury`（immutable）——那是第 4 步。

**依據：** `docs/RUNBOOK_FREEZE_LEGACY.md`。**這份 runbook 還沒有合併進 master**，目前在分支
[`ops/freeze-legacy-deployments`](https://github.com/zuemen/pepelab_onchain_cfd/blob/ops/freeze-legacy-deployments/docs/RUNBOOK_FREEZE_LEGACY.md)；
**PR #241 合併後生效**，請以合併後 master 上的版本為準（分支上的內容仍可能變動）。腳本
`contracts/script/FreezeLegacyDeployments.s.sol` 與讀回工具 `ops/freeze-legacy/readback.mjs` 也隨 PR #241 進來。

**前置條件（runbook §7.0）：** PR #241 已合併；`forge build` 通過；證明要接手權限的新地址（V2 admin、
`ADAPTER_NEW_OWNER`）的金鑰真的可用；記下外洩地址在兩條鏈的 nonce；先通知會收到告警的人
（Base 的 owner 轉移是 SEV-1，三顆 adapter 各響一次）。

**操作：** 依 runbook §7.1（唯讀確認）→ §7.2（本機分叉演練）→ §7.3（每條鏈各做「計畫 → 不廣播模擬 → 執行」，
**先 Base 後 Sepolia**，`--slow` 必加）。指令與確認字串照 runbook，金鑰只放在當下 shell 的環境變數。

**完成後驗證（唯讀，runbook §7.4）：**

```bash
# 盤點全集讀回＋事件掃描：必須 exit 0、「可疑」為 0（LOGS_RPC 與參數照 runbook）
node ops/freeze-legacy/readback.mjs base-sepolia https://sepolia.base.org
node ops/freeze-legacy/readback.mjs sepolia https://ethereum-sepolia-rpc.publicnode.com
# Base 的三顆 adapter 不再出現在外洩地址 FAIL 裡
node scripts/post-deploy-smoke.mjs --skip-http
```

並依 runbook 做 nonce 對帳、確認兩支 keeper 的下一次排程仍是綠的。

**失敗時：** runbook §7.5 有錯誤碼對照（`NotConfirmed`、`NonceMismatch`、`LeakedHasCode`、`KeepBroken`…）。中途中斷**不要直接重跑**：
先跑 readback，再把 nonce 參數更新成目前值。`OtherAdminMissing` 一類的保護**絕對不要繞過**。

---

## 第 4 步：換 PAY_TO、重部署 x402 FeeRouter 與平台 FeeRouter

**為什麼：** 兩顆 FeeRouter 的 `platformTreasury` 都是外洩地址，而且是 **immutable**——沒有任何 setter 能改
（`docs/RUNBOOK_KEY_ROTATION.md` 提到的「owner-only setter」並不存在）。只能重新部署。signal-api 的 `PAY_TO`
也指向同一個地址，付費端點因此 fail-closed 回 503，等於 x402 收費現在完全停擺。

**前置條件：**
- 第 1 步完成。準備一把**新的結算金鑰**（新 EOA，不是 Safe 或合約）：`PAY_TO` 必須等於這把金鑰的地址
  （結算 worker 會核對 PAY_TO、線上 `/` 公布的 payTo 與 signer 三者一致）。
- 決定新的 `TREASURY`（平台分潤收款地址）。**`DeployX402Router.s.sol` 沒帶 `TREASURY` 時預設是部署者**；一定要明確帶入，
  並確認不在外洩名單內。
- 部署錢包有 Base Sepolia ETH，以及至少 1 USDC（Circle 官方 USDC）作為新 x402 金庫的種子。

**操作：**

1. **x402 FeeRouter**（`contracts/`）：
   `forge script script/DeployX402Router.s.sol:DeployX402Router --rpc-url base_sepolia --broadcast`，環境變數帶 `TREASURY=<新地址>`。
   **注意：** 這支腳本會同時部署一顆**新的** InsuranceVault（現行原始碼是 virtual shares 版）並立刻 `setFeeRouter`。
   依 [`INSURANCE_VAULT_SHARES.md`](INSURANCE_VAULT_SHARES.md) §3.3、§5.2，金庫供給為 0 時流入的錢會永久歸 virtual 份額——
   **在任何收入流進來之前**（也就是下面第 3 小步切換 `X402_FEE_ROUTER` 之前），先以平台地址對新金庫 `deposit` 至少 1 USDC，
   並確認 `totalSupply() > 0`。
2. **新結算金鑰**：GitHub → Settings → Environments → `settlement` → 更新 `FEE_SETTLEMENT_PRIVATE_KEY`。
3. **切換設定**（同一個時段內完成）：
   - GitHub → Settings → Secrets and variables → Actions → **Variables**：`PAY_TO`＝新結算 EOA、`X402_FEE_ROUTER`＝新 router。
   - Vercel → signal-api 專案 → Settings → Environment Variables：`PAY_TO`、`X402_FEE_ROUTER` 同上，然後 Redeploy。
   - repo 內（走 PR）：`frontend/src/contracts/x402.ts` 的 `X402_FEE_ROUTER`、`agent/.env.example` 的 `X402_FEE_ROUTER`；
     結算 worker 會比對 repo variable 與 `x402.ts`，兩邊不同時 fail-closed。
   - Cloudflare monitoring：`EXPECTED_PAY_TO`＝新 PAY_TO，重新 `npx wrangler deploy`；移除第 2 步暫設的 `MUTE_KEYS`。
4. **平台 FeeRouter**：沒有單獨的部署腳本；它的 `insuranceVault` 同樣是 immutable，而 CopyTracker 的 `feeRouter` 也是 immutable
   （見 `INSURANCE_VAULT_SHARES.md` §5.1）。也就是說，**換平台 FeeRouter 就要換 CopyTracker，換主保險金庫又要再換一次 FeeRouter**。
   建議：若第 5 步會在近期執行，平台 FeeRouter 併入第 5 步、與新 InsuranceVault／CopyTracker 同一批部署（帶新 treasury）；
   若第 5 步會延後很久，才先以現行金庫單獨重部署，並接受第 5 步要再部署一次。不論哪種，部署後都要對交易所
   `setFeeRouter`、對新 FeeRouter `setExchange`／`setCopyTracker`。
5. 部署後同一個 PR 更新：`frontend/src/contracts/addresses.ts`、`ops/monitoring/deployed.json`
   （`node scripts/check-monitoring.mjs --refresh-deployed` 後 `--write`）、`ops/monitoring/monitors.json` 中 treasury 的預期值。

**完成後驗證（唯讀）：**

```bash
cast call <新 x402 FeeRouter> "platformTreasury()(address)" --rpc-url https://sepolia.base.org   # 新 treasury
cast call <新 x402 金庫> "totalSupply()(uint256)" --rpc-url https://sepolia.base.org            # > 0
curl -s https://agent-git-master-zuemens-projects.vercel.app/ | jq '{payTo, payToSafety}'        # safe: true
node scripts/post-deploy-smoke.mjs   # signal-api 兩項與 FeeRouter treasury 應轉為 PASS；未付款 /oracle/sBTC 應回 402
```

**失敗時：**
- signal-api 仍回 503 `payto_unsafe`：Vercel 的 `PAY_TO` 沒更新或沒 Redeploy；或新地址有 code（不是 EOA）。
- 結算 worker 失敗「PAY_TO ≠ signer」：`settlement` environment 的金鑰與 `PAY_TO` 不是同一把。
- 已經有收入在種子之前流進新金庫：那筆錢無法取回（歸 virtual 份額）；立刻補種子，避免後續再發生。

---

## 第 5 步：完整 cutover（#130、新 GuardedOracle、InsuranceVault、PepeIncentives、PepeAMM）

**為什麼：** 交易引擎、保險金庫份額定價、oracle 速率限制與凍結期限、PepeIncentives、PepeAMM 的修正都只存在於原始碼；
[`RELEASE_STATUS.md`](RELEASE_STATUS.md) 把它們列為「原始碼較新（待部署）」。合約不可升級，只能重新部署並改接線。

**前置條件：**
- 第 1、4 步完成；`forge test` 全綠；部署者金鑰的地址等於 `DEPLOY_130_CUTOVER.md` §2 指定的位址；guardian 是**另一把**金鑰。
- 挑沒有展示的時段，之後留兩天緩衝。
- **先 dispatch keeper**，確認 11 檔價格都是新的：`RedeployGuardedOracle.s.sol` 在任何價格過期時拒絕執行，`Verify130`
  也會對超過 6 小時的價格發出警告。
  ```bash
  gh workflow run base-sepolia-keeper.yml && gh run watch
  node scripts/post-deploy-smoke.mjs --skip-http   # keeper 類應全部 PASS
  ```

**操作（依序；每一項的詳細指令在對應文件，這裡不重抄）：**

1. **#130 cutover**：[`DEPLOY_130_CUTOVER.md`](DEPLOY_130_CUTOVER.md) §3 設風險參數 → §5.1 清空舊 exchange →
   §5.2 `PREFLIGHT_ONLY=true` 預檢與 fork 模擬（不需要金鑰）→ §5.3 broadcast → §5.4 `Verify130` → §7 部署後必做（一個 commit）。
   §5.3 第 9 步（舊 InsuranceVault／FeeRouter 改指向新 exchange）**不可逆**。
   **Oracle 選擇（§4）：** 若選 `ORACLE_KIND=guarded`，exchange 上的 oracle 是 immutable——要讓新 exchange 讀到**新的** GuardedOracle，
   就必須把下一項（新 GuardedOracle）**提前到 #130 之前**做；選預設的 MockOracle 則順序不影響。
2. **新 GuardedOracle**：`DEPLOY_130_CUTOVER.md` §10，`script/RedeployGuardedOracle.s.sol`；先跑 fork 測試
   （`forge test --match-path test/fork/RedeployGuardedOracleFork.t.sol --fork-url https://sepolia.base.org -vv`）。
   `ORACLE_MAX_PRICE_AGE` 必須 ≥ keeper 的 `KEEPER_HEARTBEAT` ＋ 排程延遲；**要在治理 phase 2 之前做**。
3. **InsuranceVault**：[`INSURANCE_VAULT_SHARES.md`](INSURANCE_VAULT_SHARES.md) §5.3 的順序，**一步都不能調換**：
   部署新金庫（`feeRouter`、`exchange` 留 0）→ 存至少 1 USDC 新資金作種子並確認 `totalSupply > 0` → 接線後移交 timelock
   （前三步同一次 broadcast）→ timelock 預排 `setInsuranceVault`／`setFeeRouter`（等 48 小時）→ 遷移窗口（ReduceOnly → 執行排程 →
   立刻搬協議自有部位 → 切回 Active）。舊金庫**不要**把 `exchange` 設成 0。平台 FeeRouter／CopyTracker 若併入這一批，見第 4 步第 4 小步。
4. **PepeIncentives**：`contracts/script/DeployPepeIncentives.s.sol`，部署後更新 `addresses.ts` 並轉入獎勵池；
   新實例從空狀態開始，舊的連續簽到等資料不會帶過來（`KNOWN_LIMITATIONS.md`）。
5. **PepeAMM**：`contracts/script/DeployAMM.s.sol`（簽署者必須是 MockUSDC 的 owner），部署後更新 `addresses.ts`。

**完成後驗證（唯讀）：**

```bash
cd contracts && forge script script/Verify130.s.sol:Verify130 --rpc-url https://sepolia.base.org   # §5.4 的參數照文件
cd .. && node scripts/check-addresses.mjs && node scripts/check-monitoring.mjs
node scripts/post-deploy-smoke.mjs     # 接線（含 agent session 授權）、外洩地址、keeper、signal-api
```

**失敗時：** `DEPLOY_130_CUTOVER.md` §9：一律用 `RESUME_*` 續跑，不要從頭重跑；各步的回滾指令在 §9。
InsuranceVault 遷移中斷時，舊金庫仍在保護交易——不要提領舊金庫，先把各資產維持 ReduceOnly 再處理。

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

**操作：**

```bash
cd contracts && forge build && cd ..
node scripts/check-deployment-status.mjs          # 唯讀 RPC；寫 docs/RELEASE_STATUS.md 與 docs/release-status.json
node scripts/check-deployment-status.mjs --offline
node scripts/post-deploy-smoke.mjs
```

有新的展示驗收證據時，先更新 `ops/release-status/components.json` 的 `acceptance`（只能引用 repo 內存在的檔案），
再跑 `node scripts/check-deployment-status.mjs --refresh-acceptance`（不連網）。產生的兩個檔案走 PR 提交。

**驗證：** `--offline` 通過（CI 的 `release status ↔ addresses.ts` 也會跑）；`RELEASE_STATUS.md` 摘要表中，
第 3–5 步涉及的元件在「鏈上＝原始碼」欄，「仍指向外洩地址的元件」為 0；smoke test 沒有 FAIL。

**失敗時：**
- 仍是「原始碼較新」：鏈上不是 master 的版本。看該列的說明——若寫「鏈上是舊版 X」，就是部署了舊候選；若是 byte 位移不同，
  確認部署時用的是 master 與 `contracts/foundry.toml` 的設定（`via_ir`、`optimizer_runs 200`、solc 0.8.30）。
- 「無法比對」：先確認 `forge build` 產物存在、前端設定的位址正確、RPC 可用。
- CI `--offline` 失敗並說「位址已變更」：改了位址卻沒重跑本腳本，照上面重跑後一起提交。
