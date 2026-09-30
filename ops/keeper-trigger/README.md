# keeper 外部觸發器（Cloudflare Worker）

## 為什麼要有它

`.github/workflows/base-sepolia-keeper.yml` 名目上每 15 分鐘跑一次，但 GitHub 排程是 best-effort：實測間隔 68–169 分鐘，2026-09-30 甚至 4.5 小時沒有執行。交易所的 `maxPriceAge` 是 6 小時，所以只要一次寫價失敗再遇上排程延遲，資產就會過期、無法交易（當天 sBTC 就是這樣）。

這個 Worker 每 20 分鐘用 Cloudflare 的 cron 檢查一次；keeper 超過 15 分鐘沒有執行、而且目前沒有排隊或執行中的 run，才觸發一次 `workflow_dispatch`。GitHub 排程仍然保留，兩者並存。keeper 在不需要寫價時不會送交易，多跑一次只花 Actions 分鐘數（公開 repo 免費）。

Worker 本身**不持有任何鏈上金鑰**，對任何 HTTP 請求都回 404（`workers_dev = false`、`preview_urls = false`，不產生公開網址）。它唯一的憑證是一個 GitHub fine-grained token，權限為 **Actions: Read and write**。這個 token 能做的事比「觸發 keeper」多很多，下面逐項寫明。

## 威脅模型：token 外洩時的最壞情況

### Actions: write 能做什麼

依 GitHub 文件〈Permissions required for fine-grained personal access tokens〉的 [Actions 權限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-actions)，Actions: write 涵蓋以下操作：

| 能力 | 端點 | 對本 repo 的後果 |
|---|---|---|
| 觸發任何 `workflow_dispatch` workflow，**可指定任何分支或 tag** | `POST …/actions/workflows/{id}/dispatches` | 見下一節。指定舊分支時，跑的是**那個分支上的 workflow 檔**（[文件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)：`--ref` 可在非預設分支執行）。本 repo 目前有約 90 個遠端分支 |
| 取消、強制取消執行中的 run | `…/runs/{id}/cancel`、`force-cancel` | 一直取消 keeper → 價格過期、sBTC 等資產停止交易 |
| **停用／啟用 workflow** | `PUT …/workflows/{id}/disable`、`enable` | 停用 keeper **和** `oracle-health.yml` → 價格過期，而且不會開告警 issue |
| 重跑舊的 run | `…/runs/{id}/rerun` | 重跑沿用原本的 commit 與 ref（[文件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)），所以舊版 workflow 會以舊邏輯再執行一次 |
| 刪除 run、log、artifact、cache | `DELETE …/runs/{id}`、`…/logs`、`…/caches` | 抹掉 keeper 的執行紀錄；刪 cache 只會讓下次安裝變慢 |
| 核准 fork PR 的 workflow run | `POST …/runs/{id}/approve` | 本 repo 沒有 `pull_request_target`；fork PR 的 run 拿不到 secrets、token 只讀，後果只有 CI 分鐘數 |
| 修改 OIDC subject 範本 | `PUT …/actions/oidc/customization/sub` | 目前沒有任何 workflow 使用 `id-token`，沒有影響 |

**Actions: write 不能做的事**：讀寫程式碼（Contents）、讀或改 secrets（Secrets／Environments）、改 repo 或 environment 設定（Administration），也**不能核准等待審核的部署**。核准端點 `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` 需要 **Deployments: write**（[權限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-deployments)），而且呼叫者必須是 required reviewer（[端點文件](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run)：“Required reviewers with read access to the repository contents and deployments can use this endpoint.”）。

> **觸發者身分（審查 M4）**：用你本人的 PAT 時，Worker（或外洩的 token）dispatch 的 admin run，在 Actions 頁上的觸發者也是你，和你親手 dispatch 的無法區分。理想做法是讓 Worker 用一個**專用身分**，但要注意 GitHub 的限制：
>
> - **machine account 加 fine-grained PAT 在本 repo 行不通**。本 repo 屬於個人帳號，而 fine-grained PAT「Each token is limited to access resources owned by a single user or organization」，而且目前不支援「repositories where the user is an outside or repository collaborator」（[文件](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations)）。
> - **不要改用 machine account 加 classic PAT**。classic 的 `repo` scope 會連帶給 Contents 寫入，外洩時能直接改 keeper 程式碼，比 Actions: write 危險得多。
> - 可行的專用身分有兩種：
>   1. **GitHub App**：只給 Actions: Read and write，只安裝在本 repo。觸發者會顯示為 `<app-slug>[bot]`。**Worker 目前不支援用 App 私鑰換 installation token，需要另開 PR 實作。**
>   2. **把 repo 移到 organization**：machine account 以 org 成員身分建 fine-grained PAT。
> - 改用專用身分後，把它的名稱（例如 `pepelab-keeper[bot]`）設成 repo variable `KEEPER_TRIGGER_ACTOR`（Settings → Secrets and variables → Actions → Variables）。admin workflow 會拒絕 `github.actor` 或 `github.triggering_actor` 等於它的 run。**沒設定這個 variable 時不擋**，現在用你本人的 PAT 時也不要設，否則你自己的 admin run 也會被拒絕。
> - 專用身分不是 required reviewer，就算誤給了 Deployments 權限也不能核准。
>
> 在那之前仍用你本人的 PAT：你本人就是 required reviewer，所以**絕對不要給這個 token Deployments 權限**。一旦給了，外洩的 token 就能核准自己觸發的 admin 呼叫。核准時一律照第 5 步的指引，只核准你自己剛剛手動 dispatch 的 run。

### 每個可 dispatch 的 workflow 被觸發時的最壞後果

以 `grep -l workflow_dispatch .github/workflows/*` 列出，共 9 支：

| workflow | 持有的 secret | inputs | 最壞後果（token 外洩時） |
|---|---|---|---|
| `admin-base-sepolia.yml` | `KEEPER_PRIVATE_KEY`（MockOracle owner） | target／function（白名單含 `transferOwnership`、`updatePrice`、`addAsset`、`mint`）／args | **修正前**：攻擊者可指定 inputs，以 owner 身分轉移 MockOracle 所有權或改價格。**修正後**：拆成兩個 job。`approve` 綁 `environment: admin-approval`（不放 secret），要等 required reviewer 在 GitHub 上核准才開始，再由 gate 確認 environment 真的有 reviewers、ref 是 master、觸發者不是 `KEEPER_TRIGGER_ACTOR`。`admin-call`（`needs: approve`）才從 `keeper` environment 取私鑰、才進與 keeper 共用的 concurrency group，而且拒絕 `run_attempt != 1`：只重跑 admin-call 會沿用已核准的 approve，等於重播已核准的呼叫。等核准期間不占 group，所以待核准的 admin run（包括攻擊者 dispatch 的）不會卡住 keeper 排程（審查 H2）。**殘留風險**：舊分支上的舊版 admin workflow 沒有綁 environment。只要 repo 層級還有 `KEEPER_PRIVATE_KEY`，dispatch 到舊分支，或重跑修正前的舊 run，都繞得過審核。所以必須完成下面第 4 步，把 repo 層級的 secret 刪掉 |
| `base-sepolia-keeper.yml` | `KEEPER_PRIVATE_KEY`、RPC | 無 | 多跑幾次：不需要寫價時不送交易，與 admin 共用 concurrency group 而會排隊。指定舊分支時會跑舊版 keeper 程式，最壞是寫價失敗或多花測試網 gas。取消或停用它會讓價格過期 |
| `price-keeper.yml`（Sepolia） | `KEEPER_PRIVATE_KEY`、RPC | 無 | 同上（Sepolia 鏈） |
| `x402-settlement-worker.yml` | `FEE_SETTLEMENT_PRIVATE_KEY`、Upstash token | 無 | 佇列提早結算，本身無害。指定舊分支時會以舊版結算程式使用這把金鑰，其中包括還沒有 P0 收款守門的版本 |
| `oracle-health.yml` | RPC（無私鑰），`issues: write` | 無 | 多開或多留言告警 issue。**被停用時價格過期不會有人知道** |
| `agent-ci.yml`、`contracts-ci.yml`、`frontend-ci.yml`、`consistency.yml` | 無 | 無 | `contents: read`、沒有 secrets，後果只有 Actions 分鐘數（公開 repo 免費） |

**總結最壞情況**：
1. 取消 keeper run 或停用 keeper → 價格超過 `maxPriceAge` 後資產停止交易。平常由 `oracle-health`（每 3 小時）開 issue 告警。但同一個 token 也能停用 `oracle-health`，所以**目前沒有不依賴 GitHub Actions 的告警**。若要補，需要一個不共用這個 token 的監控，例如另一個只讀鏈上 `updatedAt` 的 Cloudflare cron。
2. 以 owner 身分送 admin 交易 → 由 `admin-approval` 的人工審核擋下；下面第 1–4 步做完之前，這一條**沒有真正關上**。審核時**只核准你自己剛剛手動 dispatch、而且 inputs（target／function／args）逐字核對過的 run；不認得的一律 Reject**。攻擊者可以不斷 dispatch 待核准的 run 來洗版，但它們不會占用 keeper 的 concurrency group。
3. 在舊分支上以私鑰執行舊程式 → 第 4 步刪掉 repo 層級的私鑰 secret 之後，舊版 workflow 拿不到私鑰（`Fail fast when secrets are missing` 會讓它失敗）。

發現外洩時，到 <https://github.com/settings/personal-access-tokens> 撤銷 token。接著確認 `gh workflow list --all` 裡的 workflow 都是 active，並檢查 Actions 頁有沒有預期外的 run，或等待核准的 admin run（有的話一律 Reject）。

## 部署前必做（需要你本人操作，依序）

Worker 的 token **沒有** Deployments 與 Administration 權限，下列設定只能由你在 GitHub 網頁上完成。本 repo 是 public，Free 方案也能用 required reviewers 與 environment secrets（[文件](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)）。

> 為什麼一定要先建 environment：[文件](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)寫明 “Running a workflow that references an environment that does not exist will create an environment with the referenced name … the newly created environment will not have any protection rules or secrets configured.” 也就是說，不先建好，GitHub 會自動建一個**沒有任何保護**的 `admin-approval`。本 PR 的 gate step 會在這種情況下讓 admin workflow 直接失敗（fail-closed）。它的作用是讓設定缺漏變成失敗、而不是無聲放行，但它不能代替設定。

1. **建立 `admin-approval`**：repo → Settings → Environments → New environment → 名稱 `admin-approval`。
   - **Required reviewers**：勾選，加入你自己（`zuemen`）。
   - **Prevent self-review**：**不要勾**。你是唯一的 reviewer，也是平常手動 dispatch 的人，勾了就無法核准自己的 run。
   - **Allow administrators to bypass configured protection rules**：**取消勾選**。
   - **Deployment branches and tags**：選 Selected branches and tags，加入 `master`。
   - **不要放任何 secret**（審查 L5）：這個 environment 只負責人工核准。admin 的私鑰由 `admin-call` job 從 `keeper` environment 取；核准前沒有任何 job 拿得到私鑰。
   - Save protection rules。
2. **建立 `keeper`**（給 `base-sepolia-keeper.yml`、`price-keeper.yml` 與 admin workflow 的 `admin-call` job）：
   - Deployment branches 選 `master`；Environment secrets 新增 `KEEPER_PRIVATE_KEY`（值與現有 repo secret 相同）。
   - **不要設 required reviewers、wait timer 或任何 custom deployment protection rule**。這些 job 用 `deployment: false`：reviewers 與 wait timer 仍會生效，排程會卡在等核准或被拖慢；custom protection rule 與 `deployment: false` 不相容，會讓 job 失敗（[文件](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments)）。
3. **建立 `settlement`**（給 `x402-settlement-worker.yml`）：Deployment branches 選 `master`；Environment secrets 新增 `FEE_SETTLEMENT_PRIVATE_KEY`。同樣不要設 reviewers、wait timer 或 custom protection rule。
4. **PR 合併後刪掉 repo 層級的私鑰**（這一步才真正關上舊分支與舊 run 的繞道）：
   1. 先等 `Base Sepolia Keeper` 與 `x402 Settlement Worker` 在 master 上各有一次綠燈。這時 environment secret 已經生效，因為 environment 層級優先於 repo 層級（[文件](https://docs.github.com/en/actions/reference/security/secrets)）。
   2. 刪除前，在 master 上確認只剩已綁 environment 的 workflow 依賴這兩個 secret：

      ```bash
      grep -ln 'secrets.KEEPER_PRIVATE_KEY\|secrets.FEE_SETTLEMENT_PRIVATE_KEY' .github/workflows/*
      # 應只列出 admin-base-sepolia.yml、base-sepolia-keeper.yml、price-keeper.yml、x402-settlement-worker.yml
      grep -n 'environment:' -A2 <上面列出的每一支>   # 每一支用到私鑰的 job 都要有 environment（admin 是 admin-call 用 keeper）
      ```

      多出來的 workflow（例如之後新增的）要先綁 environment，否則刪掉 repo secret 後它會失敗。
   3. Settings → Secrets and variables → Actions → Repository secrets：刪除 `KEEPER_PRIVATE_KEY` 與 `FEE_SETTLEMENT_PRIVATE_KEY`。
   4. 下一次 keeper、price-keeper、settlement 排程仍應是綠的。若出現「缺少 … PRIVATE_KEY」，代表對應的 environment secret 沒設好，把它補進 environment（不要加回 repo 層級）。
5. **確認 admin gate**：`gh api repos/zuemen/pepelab_onchain_cfd/environments/admin-approval --jq '[.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login]'` 應該回 `["zuemen"]`。之後需要用 admin workflow 時：
   - 你自己 dispatch 後，到該 run 核對頁面上的 inputs（target／function／args）與觸發者，確認是你剛剛送出的那一筆，再按 **Review deployments → Approve and deploy**。
   - **不認得、不是你剛剛 dispatch 的、或 inputs 對不上的一律 Reject**。
   - 失敗要重試時重新 dispatch，不要按 Re-run：`admin-call` 會拒絕重跑。
   - `admin-call` 排隊等 keeper 時，若之後又排進一個 keeper run，它可能被取消（concurrency 預設只保留一個 pending），重新 dispatch 即可。
6. **建立 Worker 用的 token**（目前只能用你本人的 fine-grained PAT，理由見上方「觸發者身分」；`KEEPER_TRIGGER_ACTOR` 先不要設）：<https://github.com/settings/personal-access-tokens/new>
   - Resource owner：`zuemen`；Repository access：Only select repositories → `pepelab_onchain_cfd`。
   - Repository permissions：**只開 Actions: Read and write**（Metadata: Read 會自動帶上）。**不要**開 Deployments、Administration、Contents、Secrets、Environments、Workflows。
   - Expiration：自訂日期，**不超過 90 天**。
7. **部署 Worker**：

   ```bash
   cd ops/keeper-trigger
   npx wrangler login                       # 用你的 Cloudflare 帳號
   npx wrangler secret put GITHUB_TOKEN     # 貼上第 6 步的 token
   npx wrangler deploy
   ```

## token 輪替

- 到期前 7 天：依第 6 步建立新 token（同樣只給 Actions: Read and write、≤ 90 天），執行 `npx wrangler secret put GITHUB_TOKEN` 換上新 token。等下一次 cron 在 Logs 出現 `decide: dispatch=...` 且沒有錯誤，再到 GitHub 撤銷舊 token。
- 懷疑外洩：先撤銷，再依上面「發現外洩時」檢查，最後換新 token。
- 忘了輪替時，token 過期會讓 dispatch 回 401，cron 會被 Cloudflare 記成失敗（`scheduled` 直接 await，失敗會 reject）。GitHub 排程仍在跑，不會完全停擺。

## 驗證

- Cloudflare dashboard → Workers → `pepelab-keeper-trigger` → Logs（`[observability]` 已開啟）：每 20 分鐘應看到一行 `decide: dispatch=...`；dispatch 失敗的 cron 會顯示為錯誤。
- GitHub → Actions → Base Sepolia Keeper：出現 `workflow_dispatch` 觸發的執行，且間隔不超過約 35 分鐘。
- `oracle-health.yml` 的過期告警 issue 應該不再出現。

## 調整

`wrangler.toml` 的 `[vars]`：`MIN_GAP_SEC`（預設 900）、`WORKFLOW_REF`（預設 master）。cron 間隔改 `[triggers] crons`。

## 測試

```bash
node --test ops/keeper-trigger/keeper-trigger.test.mjs
```
CI（consistency.yml 的 `keeper-trigger` job）會跑這組測試。
