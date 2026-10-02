# keeper 外部觸發器（Cloudflare Worker）

## 現況（2026-10-02；合併與部署前必讀）

**本文件描述的保護，在「部署前必做」第 1–4 步完成之前都不成立。** 2026-10-01 以 `gh api` 唯讀查詢的結果，四步一項都還沒做：

- repo 層級仍有 `KEEPER_PRIVATE_KEY` 與 `FEE_SETTLEMENT_PRIVATE_KEY`。
- `keeper`、`settlement` 兩個 environment 已經存在，但都是 workflow 引用時自動建立的空 environment：沒有 secret、沒有保護規則、沒有 branch policy。`admin-approval` 不存在。
- 遠端約 95 個分支上的舊版 `admin-base-sepolia.yml` 不綁 environment、直接讀 repo 層級的 `KEEPER_PRIVATE_KEY`，其中 3 個（`fix/demo-polish`、`chore/health-fixes`、`fix/price-feed-liveness`）還把 inputs 直接內插進 shell。

也就是說，現在任何有 Actions: write 的憑證只要 dispatch `ref=<舊分支>`，就能以 MockOracle owner 的身分執行任意指令；本 PR 的 `precheck`、人工核准、靜態檢查都擋不到這條路（它們只存在於 master 上的 workflow 檔）。

建議順序：第 1–3 步 → 合併本 PR → **合併後立刻做第 4 步（刪掉 repo 層級的兩把私鑰）** → 才部署 Worker（第 6、7 步或「改用 GitHub App」）。第 4 步做完之前不要讓 Worker 持有任何 Actions: write 憑證。

## 為什麼要有它

`.github/workflows/base-sepolia-keeper.yml` 名目上每 15 分鐘跑一次，但 GitHub 排程是 best-effort：實測間隔 68–169 分鐘，2026-09-30 甚至 4.5 小時沒有執行。交易所的 `maxPriceAge` 是 6 小時，所以只要一次寫價失敗再遇上排程延遲，資產就會過期、無法交易（當天 sBTC 就是這樣）。

這個 Worker 每 20 分鐘用 Cloudflare 的 cron 檢查一次 `WORKFLOW_FILES` 裡的每一支 keeper（預設 `base-sepolia-keeper.yml` 與 Ethereum Sepolia 的 `price-keeper.yml`；後者在 2026-10-01 同樣因排程節流而過期，見 #208）；某支 keeper 超過 15 分鐘沒有執行、而且目前沒有排隊或執行中的 run，才觸發它一次 `workflow_dispatch`。各支獨立判斷，一支觸發失敗不影響其他支。GitHub 排程仍然保留，兩者並存。keeper 在不需要寫價時不會送交易，多跑一次只花 Actions 分鐘數（公開 repo 免費）。

Worker 本身**不持有任何鏈上金鑰**，對任何 HTTP 請求都回 404（`workers_dev = false`、`preview_urls = false`，不產生公開網址）。它唯一的憑證是一個權限為 **Actions: Read and write** 的 GitHub 憑證：擁有者本人的 fine-grained PAT，或 GitHub App 的私鑰（Worker 用它換一小時的 installation token，見「改用 GitHub App」）。兩種憑證能做的事相同，都比「觸發 keeper」多很多，下面逐項寫明。

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
>   1. **GitHub App**：只給 Actions: Read and write，只安裝在本 repo。觸發者會顯示為 `<app-slug>[bot]`。Worker 已支援，設定步驟見下方「改用 GitHub App」。
>   2. **把 repo 移到 organization**：machine account 以 org 成員身分建 fine-grained PAT。
> - admin workflow 採**白名單**：`precheck`、`approve` 的 gate、`admin-call` 的第一個 step 都要求 `github.actor` 與 `github.triggering_actor` 兩者都等於 `github.repository_owner`（本 repo 是 `zuemen`；比對不分大小寫、去掉前後空白），否則失敗。這項檢查**不需要任何設定**，讀不到擁有者時也是失敗（fail-closed）。改用專用身分後，Worker（或偷到 Worker 憑證的人）dispatch 的 admin run 觸發者是 `<app-slug>[bot]`，在 `precheck`（人工核准**之前**）就失敗，不會進入等待核准的清單（見「改用 GitHub App」第 8 步）。
>   - 先前的做法是黑名單（repo variable `KEEPER_TRIGGER_ACTOR`），沒設定、設在 environment 層級、多一個空白或少寫 `[bot]` 時都會放行（PR #217 審查 M1），已移除。這個 variable 不必再設，設了也不會被讀取。
>   - **白名單擋不到的**：用你本人的 PAT dispatch 的 run，觸發者就是你本人，和你親手 dispatch 的分不出來。這種情況仍只靠人工核准時逐字核對 inputs。
> - 專用身分不是 required reviewer，就算誤給了 Deployments 權限也不能核准。
>
> 在那之前仍用你本人的 PAT：你本人就是 required reviewer，所以**絕對不要給這個 token Deployments 權限**。一旦給了，外洩的 token 就能核准自己觸發的 admin 呼叫。核准時一律照第 5 步的指引，只核准你自己剛剛手動 dispatch 的 run。

### 每個可 dispatch 的 workflow 被觸發時的最壞後果

以 `grep -l workflow_dispatch .github/workflows/*` 列出，共 9 支：

| workflow | 持有的 secret | inputs | 最壞後果（token 外洩時） |
|---|---|---|---|
| `admin-base-sepolia.yml` | `KEEPER_PRIVATE_KEY`（MockOracle owner） | target／function（白名單含 `transferOwnership`、`updatePrice`、`addAsset`、`mint`）／args | **修正前**：攻擊者可指定 inputs，以 owner 身分轉移 MockOracle 所有權或改價格。**修正後**：拆成三個 job。`precheck` 不綁 environment、不碰任何 secret、沒有 token 權限，在核准之前檢查 ref 是 master、是第一次執行、觸發者（`github.actor` 與 `github.triggering_actor`）是 repo 擁有者本人（`github.repository_owner`）；不符就失敗，後面兩個 job 被略過，**不會產生待核准的請求**。`approve`（`needs: precheck`）綁 `environment: admin-approval`（不放 secret），要等 required reviewer 在 GitHub 上核准才開始，再由 gate 重複 precheck 的三項檢查，並確認 environment 真的有 reviewers。`admin-call`（`needs: approve`）才從 `keeper` environment 取私鑰、才進與 keeper 共用的 concurrency group，第一個 step 再做一次同樣的三項檢查；其中拒絕 `run_attempt != 1` 的理由是：只重跑 admin-call 會沿用已核准的 approve，等於重播已核准的呼叫。等核准期間不占 group，所以待核准的 admin run（包括攻擊者 dispatch 的）不會卡住 keeper 排程（審查 H2）。**殘留風險**：舊分支上的舊版 admin workflow 沒有綁 environment。只要 repo 層級還有 `KEEPER_PRIVATE_KEY`，dispatch 到舊分支，或重跑修正前的舊 run，都繞得過審核。所以必須完成下面第 4 步，把 repo 層級的 secret 刪掉 |
| `base-sepolia-keeper.yml` | `KEEPER_PRIVATE_KEY`、RPC | 無 | 多跑幾次：不需要寫價時不送交易，與 admin 共用 concurrency group 而會排隊。指定舊分支時會跑舊版 keeper 程式，最壞是寫價失敗或多花測試網 gas。取消或停用它會讓價格過期 |
| `price-keeper.yml`（Sepolia） | `KEEPER_PRIVATE_KEY`、RPC | 無 | 同上（Sepolia 鏈） |
| `x402-settlement-worker.yml` | `FEE_SETTLEMENT_PRIVATE_KEY`、Upstash token | 無 | 佇列提早結算，本身無害。指定舊分支時會以舊版結算程式使用這把金鑰，其中包括還沒有 P0 收款守門的版本 |
| `oracle-health.yml` | RPC（無私鑰），`issues: write` | 無 | 多開或多留言告警 issue。**被停用時價格過期不會有人知道** |
| `agent-ci.yml`、`contracts-ci.yml`、`frontend-ci.yml`、`consistency.yml` | 無 | 無 | `contents: read`、沒有 secrets，後果只有 Actions 分鐘數（公開 repo 免費） |

**總結最壞情況**：
1. 取消 keeper run 或停用 keeper → 價格超過 `maxPriceAge` 後資產停止交易。平常由 `oracle-health`（每 3 小時）開 issue 告警。但同一個 token 也能停用 `oracle-health`，所以**目前沒有不依賴 GitHub Actions 的告警**。若要補，需要一個不共用這個 token 的監控，例如另一個只讀鏈上 `updatedAt` 的 Cloudflare cron。**2026-10-01**：這個監控已寫在 [`ops/monitoring/`](../monitoring/README.md)（獨立 Worker、不持有 GitHub token，見 [ADR-009](../../docs/ADR-009-monitoring.md)），部署後即補上這個缺口；部署前此句仍成立。
2. 以 owner 身分送 admin 交易 → 由 `admin-approval` 的人工審核擋下；下面第 1–4 步做完之前，這一條**沒有真正關上**。審核時**只核准你自己剛剛手動 dispatch、而且 inputs（target／function／args）逐字核對過的 run；不認得的一律 Reject**。還在用你本人的 PAT 時，攻擊者可以不斷 dispatch 待核准的 run 來洗版（它們不會占用 keeper 的 concurrency group）。改用 GitHub App 之後（觸發者是 `<app-slug>[bot]`，不是擁有者本人），用 Worker 憑證 dispatch 的 admin run 在 `precheck` 就失敗，不會出現在等待核准的清單裡，也不會寄出核准通知。
3. 在舊分支上以私鑰執行舊程式 → 第 4 步刪掉 repo 層級的私鑰 secret 之後，舊版 workflow 拿不到私鑰（`Fail fast when secrets are missing` 會讓它失敗）。

發現外洩時，到 <https://github.com/settings/personal-access-tokens> 撤銷 token（用 GitHub App 時改為更換私鑰或停用安裝，見「App 私鑰外洩時的差別」）。接著確認 `gh workflow list --all` 裡的 workflow 都是 active，並檢查 Actions 頁有沒有預期外的 run，或等待核准的 admin run（有的話一律 Reject）。

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
2. **設定既有的 `keeper` environment**（給 `base-sepolia-keeper.yml`、`price-keeper.yml` 與 admin workflow 的 `admin-call` job）。它已經被 workflow 自動建立（空的），不要另建同名的：repo → Settings → Environments → 點 `keeper`。
   - Environment secrets 新增 `KEEPER_PRIVATE_KEY`（值與現有 repo secret 相同）。
   - Deployment branches and tags 選 Selected branches and tags，加入 `master`。**這一項在 `deployment: false` 下是否生效尚待實測**，見下方「branch policy 待實測」；在證實之前不要把它當成保護。
   - **不要設 required reviewers、wait timer 或任何 custom deployment protection rule**。這些 job 用 `deployment: false`：reviewers 與 wait timer 仍會生效，排程會卡在等核准或被拖慢；custom protection rule 與 `deployment: false` 不相容，會讓 job 失敗（[文件](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments)）。
3. **設定既有的 `settlement` environment**（給 `x402-settlement-worker.yml`；同樣已被自動建立）：Environment secrets 新增 `FEE_SETTLEMENT_PRIVATE_KEY`；Deployment branches 選 `master`（同樣待實測）。不要設 reviewers、wait timer 或 custom protection rule。

   設定完用 `gh` 確認（唯讀）：

   ```bash
   for e in admin-approval keeper settlement; do
     echo "== $e"
     gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e" \
       --jq '{protection_rules: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}], deployment_branch_policy}'
     gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e/deployment-branch-policies" --jq '[.branch_policies[].name]'
     gh api "repos/zuemen/pepelab_onchain_cfd/environments/$e/secrets" --jq '[.secrets[].name]'
   done
   ```

   預期：`admin-approval` 有 `required_reviewers`（`zuemen`）、secrets 是 `[]`；`keeper` 的 secrets 是 `["KEEPER_PRIVATE_KEY"]`、`settlement` 是 `["FEE_SETTLEMENT_PRIVATE_KEY"]`；三者的 `deployment_branch_policy` 都是 `{"protected_branches": false, "custom_branch_policies": true}`、branch policies 是 `["master"]`。

   > **branch policy 待實測**：GitHub 文件〈Using environments without deployments〉只寫了 `deployment: false` 時 required reviewers 與 wait timer 仍然適用、custom protection rule 不相容，**沒有寫 deployment branch policy 是否仍然適用**。在本 repo 實測之前，請假設「其他分支上綁了 `keeper`／`settlement` 的 workflow 仍拿得到 environment secret」。實測方法（需要你本人決定是否執行，會用私鑰跑一次 keeper）：從 master 開一個只改註解的分支，dispatch 該分支上的 `price-keeper.yml`；branch policy 有效時，job 在開始前就以 “is not allowed to deploy to keeper due to environment protection rules” 失敗。真正擋住舊分支的仍是第 4 步。
4. **PR 合併後立刻刪掉 repo 層級的私鑰**（這一步才真正關上舊分支與舊 run 的繞道）：
   1. 先等 `Base Sepolia Keeper`、`Oracle Price Keeper (Sepolia)` 與 `x402 Settlement Worker` 在 master 上各有一次綠燈。**綠燈不能證明用的是 environment 裡的那一份**：environment 沒放 secret 時，`secrets.X` 會退回 repo 層級的同名 secret，照樣是綠的。所以同時用第 3 步後面的 `gh api …/environments/<名稱>/secrets` 確認 `keeper` 有 `KEEPER_PRIVATE_KEY`、`settlement` 有 `FEE_SETTLEMENT_PRIVATE_KEY`（environment 層級優先於 repo 層級，[文件](https://docs.github.com/en/actions/reference/security/secrets)）。真正的證明是第 4 項：刪掉 repo 層級之後仍然是綠的。
   2. 刪除前，在 master 上確認只剩已綁 environment 的 workflow 依賴這兩個 secret：

      ```bash
      grep -ln 'secrets.KEEPER_PRIVATE_KEY\|secrets.FEE_SETTLEMENT_PRIVATE_KEY' .github/workflows/*
      # 應只列出 admin-base-sepolia.yml、base-sepolia-keeper.yml、price-keeper.yml、x402-settlement-worker.yml
      grep -n 'environment:' -A2 <上面列出的每一支>   # 每一支用到私鑰的 job 都要有 environment（admin 是 admin-call 用 keeper）
      ```

      多出來的 workflow（例如之後新增的）要先綁 environment，否則刪掉 repo secret 後它會失敗。
   3. Settings → Secrets and variables → Actions → Repository secrets：刪除 `KEEPER_PRIVATE_KEY` 與 `FEE_SETTLEMENT_PRIVATE_KEY`。
   4. 下一次 keeper、price-keeper、settlement 排程仍應是綠的。若出現「缺少 … PRIVATE_KEY」，代表對應的 environment secret 沒設好，把它補進 environment（不要加回 repo 層級）。
   5. 確認 repo 層級已經沒有私鑰：`gh api repos/zuemen/pepelab_onchain_cfd/actions/secrets --jq '[.secrets[].name]'` 不應再出現這兩個名稱。
   6. （選做）列出仍含舊版 admin workflow 的遠端分支。以下指令只讀，不會刪任何東西；要不要刪分支由你決定。刪分支不能代替這一步：30 天內的舊 run 仍可以重跑，重跑沿用舊的 commit。

      ```bash
      git fetch origin --prune
      git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v '^origin$' | while read -r b; do
        f=$(git show "$b:.github/workflows/admin-base-sepolia.yml" 2>/dev/null) || continue
        if printf '%s\n' "$f" | grep -q 'github.repository_owner'; then continue          # 白名單版（本 PR 之後）
        elif printf '%s\n' "$f" | grep -q 'needs: precheck'; then echo "precheck 黑名單版：$b"
        elif printf '%s\n' "$f" | grep -q 'environment:'; then echo "approve 版（無 precheck）：$b"
        else echo "不綁 environment（直接讀 repo 層級私鑰）：$b"
        fi
      done
      ```

      在 Windows 的 Git Bash 執行前先 `export MSYS_NO_PATHCONV=1`，否則 `<分支>:<路徑>` 會被改寫成 Windows 路徑而全部讀不到。2026-10-02 以本機的遠端 ref 跑的結果：93 個分支是「不綁 environment」版、15 個是「approve 版」（含合併前的 master）、1 個是本 PR 修正前的 precheck 黑名單版。第 4 步完成後，「不綁 environment」版拿不到私鑰（`Fail fast when secrets are missing` 會讓它失敗）；「approve 版」仍要經過 `admin-approval` 的人工核准，但沒有擁有者白名單，核准時照第 5 步逐字核對。
5. **確認 admin gate**：`gh api repos/zuemen/pepelab_onchain_cfd/environments/admin-approval --jq '[.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login]'` 應該回 `["zuemen"]`。之後需要用 admin workflow 時：
   - 你自己 dispatch 後，到該 run 核對頁面上的 inputs（target／function／args）與觸發者，確認是你剛剛送出的那一筆，再按 **Review deployments → Approve and deploy**。
   - **不認得、不是你剛剛 dispatch 的、或 inputs 對不上的一律 Reject**。
   - 失敗要重試時重新 dispatch，不要按 Re-run：`precheck` 與 `admin-call` 都會拒絕重跑（`run_attempt != 1`）。
   - `admin-call` 排隊等 keeper 時，若之後又排進一個 keeper run，它可能被取消（concurrency 預設只保留一個 pending），重新 dispatch 即可。
6. **建立 Worker 用的 token**（用你本人的 fine-grained PAT。要讓 Worker 有自己的身分，改做下方「改用 GitHub App」，這一步與第 7 步的 `GITHUB_TOKEN` 就可以跳過；建議直接用 App，因為用 PAT 時 admin workflow 的擁有者白名單分不出 Worker 與你本人）：<https://github.com/settings/personal-access-tokens/new>
   - Resource owner：`zuemen`；Repository access：Only select repositories → `pepelab_onchain_cfd`。
   - Repository permissions：**只開 Actions: Read and write**（Metadata: Read 會自動帶上）。**不要**開 Deployments、Administration、Contents、Secrets、**Variables**、Environments、Workflows。Variables: write 可以改 repo variable，而 `x402-settlement-worker.yml` 用 `vars.PAY_TO`、`vars.X402_FEE_ROUTER`、`vars.SIGNAL_API_URL` 決定結算的收款與路由，改了等於改它送交易的對象。
   - Expiration：自訂日期，**不超過 90 天**。
7. **部署 Worker**：

   ```bash
   cd ops/keeper-trigger
   npx wrangler login                       # 用你的 Cloudflare 帳號
   npx wrangler secret put GITHUB_TOKEN     # 貼上第 6 步的 token
   npx wrangler deploy
   ```

   `wrangler secret put` **會立刻建立並部署一個新版本**（沿用目前已部署的程式碼，只換 secret）；只想上傳 secret、不想部署時用 `wrangler versions secret put`（[Cloudflare 文件〈Secrets〉](https://developers.cloudflare.com/workers/configuration/secrets/)：「wrangler secret put creates a new version of the Worker and deploys it immediately.」）。所以換 secret 不必再 `deploy`，但第一次部署、或程式碼有改時仍要 `npx wrangler deploy`。

## 改用 GitHub App（讓 Worker 有自己的身分）

用你本人的 PAT 時，Worker 觸發的 run 和你親手觸發的 run 在 GitHub 上是同一個人。改用 GitHub App 後，Worker 觸發的 run 會顯示為 `<app-slug>[bot]`，不是 repo 擁有者，admin workflow 的擁有者白名單就會拒絕 Worker（或偷到 Worker 憑證的人）觸發的 admin run，不需要另外設定。

### Worker 怎麼用 App

設定了 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID` 與 secret `GITHUB_APP_PRIVATE_KEY` 時（`github-app.mjs`）：

1. 用私鑰簽一個 RS256 JWT：`iat` 回推 60 秒、`exp` 為 9 分鐘後、`iss` 為 App ID。GitHub 的規則是「must be signed using the `RS256` algorithm」、`iat` 建議「60 seconds in the past」、`exp`「must be no more than 10 minutes into the future」、`iss` 為「The client ID or application ID of your GitHub App」（[Generating a JSON Web Token (JWT) for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)）。
2. 以 `Authorization: Bearer <JWT>` 呼叫 `POST /app/installations/{installation_id}/access_tokens`，body 帶 `{"repositories": ["pepelab_onchain_cfd"], "permissions": {"actions": "write"}}`，成功回 201（[REST：Create an installation access token for an app](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)、[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)）。文件寫明「The installation access token cannot be granted permissions that the app was not granted」，所以這兩個參數只能縮小、不能放大；就算之後有人把 App 的權限或安裝範圍調大，Worker 拿到的 token 仍然只有本 repo 的 Actions: write。
3. installation token「will expire after 1 hour」。Worker 把它放在 isolate 的記憶體裡，到期前 5 分鐘才重新換；Cloudflare 回收 isolate 時快取跟著消失，下一次 cron 再換一個。token 不寫入任何儲存空間，也不會出現在 log。
4. 之後列 run、dispatch 都用這個 token。`POST …/actions/workflows/{id}/dispatches` 在 App 權限表裡需要 Actions: write，installation token（IAT）可用（[Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-actions)）。

行為規則：

- **三項要一起設定**。只設一部分、ID 格式不對、私鑰格式不對、換 token 被拒（401／403／404／422）都會讓這次 cron 失敗，**不會退回 PAT**：退回去的話 run 的觸發者會變回你本人，而且沒有人會發現。錯誤訊息不含私鑰、JWT 或 token。
- 同時設定了 App 與 `GITHUB_TOKEN` 時用 App，並在 log 留一行 `auth: GitHub App 與 GITHUB_TOKEN 都有設定，使用 GitHub App`。
- 三項都沒設定時，行為和以前一樣（用 `GITHUB_TOKEN`）。
- 私鑰可以直接用 GitHub 下載的 `.pem`。那個檔案是 PKCS#1（`-----BEGIN RSA PRIVATE KEY-----`；文件：「the PEM file you download will be in `PKCS#1 RSAPrivateKey` format」，[Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)），而 WebCrypto 只收 PKCS#8，所以 Worker 會先把它包成 PKCS#8 再匯入，不需要另外用 openssl 轉檔。已經是 PKCS#8（`-----BEGIN PRIVATE KEY-----`）的也接受。加了密碼的金鑰、EC 金鑰、公鑰一律拒絕。

### 設定步驟（需要你本人操作，依序）

Worker 的程式不會替你建立 App。先完成「部署前必做」第 1–5 步。

1. **建立 App**：<https://github.com/settings/apps/new>（Settings → Developer settings → GitHub Apps → New GitHub App；[文件](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)）。
   - **GitHub App name**：例如 `pepelab-keeper`。名稱在整個 GitHub 上必須唯一、不超過 34 個字元。名稱轉成小寫、空白換成 `-` 之後就是 slug（文件舉例 `My APp Näme` 會顯示為 `my-app-name`），之後觸發者會顯示為 `<slug>[bot]`。
   - **Homepage URL**：必填，填 `https://github.com/zuemen/pepelab_onchain_cfd`。
   - **Callback URL** 留空；**Request user authorization (OAuth) during installation** 與 **Enable Device Flow** 都不要勾。
   - **Webhook**：取消勾選 **Active**（Worker 不接收任何事件）。
   - **Permissions → Repository permissions**：**只把 Actions 設為 Read and write**（Metadata: Read-only 會自動帶上）。其餘全部 No access，尤其**不要**開 Deployments、Administration、Contents、Secrets、**Variables**、Environments、Workflows（Variables 的理由見「部署前必做」第 6 步）。Organization 與 Account permissions 全部 No access。
   - **Where can this GitHub App be installed?**：選 **Only on this account**。
   - 按 **Create GitHub App**。
2. **記下 App ID**：建立後停在 App 的設定頁（General），About 區塊有 **App ID**（數字）與 **Client ID**（`Iv…`）。兩個都可以當 `GITHUB_APP_ID`。同一頁的網址 `https://github.com/settings/apps/<slug>` 最後一段就是 slug。
3. **產生私鑰**：同一頁往下到 **Private keys** → **Generate a private key**，瀏覽器會下載一個 `.pem`。GitHub 只保留公鑰，這個檔案遺失就只能重新產生。
4. **只安裝在本 repo**：左側 **Install App** → `zuemen` 旁邊按 **Install** → 選 **Only select repositories** → 選 `pepelab_onchain_cfd` → **Install**（[文件](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)）。不要選 All repositories。
5. **記下 installation ID**：安裝完成後瀏覽器停在 `https://github.com/settings/installations/<數字>`，那個數字就是 installation ID（之後也可以從 Settings → Applications → Installed GitHub Apps → 該 App 的 **Configure** 回到同一頁）。文件記載的取得方式是用 JWT 呼叫 `GET /repos/{owner}/{repo}/installation`；上面的網址是比較省事的做法，兩者的數字相同。
6. **把三項交給 Worker**：

   ```bash
   cd ops/keeper-trigger
   npx wrangler login
   npx wrangler secret put GITHUB_APP_ID                 # 貼上第 2 步的 App ID
   npx wrangler secret put GITHUB_APP_INSTALLATION_ID    # 貼上第 5 步的數字
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < /path/to/下載的私鑰.pem
   npx wrangler deploy
   ```

   - `wrangler secret put` 可以從 stdin 讀（[Cloudflare 文件](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put)：「The `put` command can also receive piped input」），多行的 PEM 用 `<` 導入最不容易貼壞。在 PowerShell 用 `Get-Content -Raw 私鑰.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY`。
   - 每一次 `wrangler secret put` 都會立刻部署新版本（見「部署前必做」第 7 步）。三項放到一半時剛好遇到 cron，那一次會因為「只設了一部分」而失敗（不會退回 PAT），三項都放好後就恢復；介意的話改用 `npx wrangler versions secret put` 放三項，再 `npx wrangler versions deploy` 一次部署。另外 `secret put` 沿用的是**目前已部署的程式碼**：已部署的版本若還不支援 App，要等 `npx wrangler deploy` 之後才會開始用 App。
   - 兩個 ID 不是秘密，也可以改成取消 `wrangler.toml` 裡 `[vars]` 的註解後填入並送 PR。**兩種方式擇一**：同一個名稱不要同時是 var 又是 secret。
   - 設定完成後把私鑰檔從下載資料夾刪掉（需要保留就放進密碼管理器）。私鑰**絕對不要**寫進 `wrangler.toml` 或 commit。
7. **確認 Worker 真的在用 App，並確認觸發者的實際名稱**：
   - Cloudflare → Workers → `pepelab-keeper-trigger` → Logs：下一次 cron 應該有一行 `auth: GitHub App installation token（new，expires in …）`，之後兩三次是 `cached`。出現 `換 installation token 失敗：HTTP 401` 代表 App ID 與私鑰不是同一個 App；`404` 代表 installation ID 不對；`422` 代表 App 沒有安裝在本 repo 或沒有 Actions 權限。
   - 等 Worker 觸發過一次 keeper 之後執行：

     ```bash
     gh api 'repos/zuemen/pepelab_onchain_cfd/actions/runs?event=workflow_dispatch&per_page=10' \
       --jq '.workflow_runs[] | {name, actor: .actor.login, triggering_actor: .triggering_actor.login, created_at}'
     ```

     Worker 觸發的那幾筆，`actor` 與 `triggering_actor` 應該都是 `<slug>[bot]`（例如 `pepelab-keeper[bot]`）。這只是確認 Worker 換了身分；admin workflow 的白名單比對的是擁有者，不需要這個字串。
8. **確認 admin workflow 會擋 Worker 的身分**（不需要任何設定）：
   - 白名單在 admin workflow（`.github/workflows/admin-base-sepolia.yml`）的三個地方各做一次，都要求 `github.actor` 與 `github.triggering_actor` 兩者都等於 `github.repository_owner`（不分大小寫、去掉前後空白），並且 ref 是 `refs/heads/master`、`run_attempt` 是 1：
     1. **`precheck`（核准之前）**：不符就失敗。`approve` 寫了 `needs: precheck`，而「If a job fails or is skipped, all jobs that need it are skipped」（[Workflow syntax：`jobs.<job_id>.needs`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)），所以 `approve` 被略過，**這筆 run 不會進入等待核准的清單**，你不會收到核准通知，也沒有東西可以誤按。
     2. **`approve` 的 gate（核准之後）**：同樣的檢查再做一次，再確認 `admin-approval` 真的有 required reviewers。
     3. **`admin-call` 的第一個 step**：再做一次，之後才有 step 拿得到私鑰。
   - 為什麼需要 `precheck` 這個獨立的 job：`approve` 綁了 `environment: admin-approval`，而「A job that references an environment must follow any protection rules for the environment before running」（[文件](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)），它自己的 step 要等你按下核准才會執行。要在核准畫面之前擋，檢查就必須放在不綁 environment 的 job。`precheck` 不綁 environment、不引用任何 secret、`permissions: {}`、不進 concurrency group。
   - 不再使用 repo variable `KEEPER_TRIGGER_ACTOR`（黑名單，PR #217 審查 M1 指出它在沒設、設錯層級、多空白、少寫 `[bot]` 時都會放行）。之前若設過，可以刪掉；留著也不會被讀取。
   - **它擋不到的**：用你本人的 PAT（或你的帳號）dispatch 的 run，觸發者就是你，白名單分不出來，仍然靠核准時逐字核對 inputs。所以第 9 步要把 PAT 從 Worker 拿掉並撤銷。
   - **擋的那一側目前只在本機驗證過**：三個守門 script 已抽出來在本機 bash 以 66 種環境變數組合實跑（擁有者大小寫、前後空白與 `\r`、bot 名稱、擁有者的前後綴、空值、讀不到擁有者、各種 ref 與 run_attempt），結果全部符合預期。在 GitHub 上實測「非擁有者觸發的 admin run 在 `precheck` 失敗、run 頁面沒有 Review deployments 按鈕」需要用 App 的 token dispatch 一次 admin workflow，這一步沒有做，要不要做由你決定（App 的 token 只在 Worker 裡，不要為此另外匯出）。
   - 放行的那一側可以安全確認：你本人手動 dispatch 一次 admin workflow，`precheck` 應該通過、run 停在等待核准；不要核准，直接 Reject。
9. **移除 PAT**：確認連續幾次 cron 都正常後，`npx wrangler secret delete GITHUB_TOKEN`，再到 <https://github.com/settings/personal-access-tokens> 撤銷那個 PAT。只要 App 三項有設定，Worker 就不會使用 `GITHUB_TOKEN`，留著只是多一個可以外洩的憑證。

### 觸發者名稱的依據與待驗證事項

- 文件對 `github.actor` 的定義是「The username of the user that triggered the initial workflow run」，`github.triggering_actor` 是「The username of the user that initiated the workflow run. If the workflow run is a re-run, this value may differ from `github.actor`」（[Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。**文件沒有明寫由 App 觸發的 `workflow_dispatch` 會是什麼字串。**
- 實測依據（2026-10-01，以公開的 REST API `GET /repos/{owner}/{repo}/actions/runs?event=workflow_dispatch` 查詢，未觸發任何 workflow）：`microsoft/vscode` 有 94 筆 run 的 `actor.login` 與 `triggering_actor.login` 都是 `vs-code-engineering[bot]`（`type: Bot`）；`grafana/grafana` 有 16 筆是 `grafana-releases-oss[bot]`。格式是 `<app-slug>[bot]`。
- 重跑時兩個值會分開：`vercel/next.js` 有一筆 run 的 `actor` 是 `github-actions[bot]`、`triggering_actor` 是按下 Re-run 的人。所以 Worker 觸發的 admin run 被你重跑時，`actor` 仍是 bot，三個守門（兩個值都比對）仍然會拒絕；三個守門另外都拒絕任何 `run_attempt != 1`。
- **待驗證**（兩項都沒有在本 repo 實測過，因為需要實際 dispatch）：
  1. 本 repo 的 App 實際顯示的字串。白名單不依賴這個字串（只要不是擁有者就擋），所以它只影響第 7 步的確認，不影響保護。
  2. `precheck` 失敗時 `approve` 不會送出核准請求。這是依文件對 `needs` 的說明推得的；守門 script 本身已在本機以 66 種環境變數組合測過。第 8 步列出了實際驗證的方法。

### App 私鑰外洩時的差別

- 能做的事與上面「Actions: write 能做什麼」完全相同（App 權限表與 PAT 權限表在 Actions: write 列出的端點一致），而且只限安裝了 App 的 repo。
- **私鑰不會到期**（「Private keys do not expire and instead need to be manually revoked」）。PAT 最多 90 天會自己失效，私鑰不會，所以更要照下面的方式輪替。
- Worker 換 token 時會把範圍縮到本 repo＋Actions: write，但偷到私鑰的人可以要到 App 的全部權限。所以**上限由 App 本身的設定決定**：App 只能有 Actions: Read and write、只能安裝在本 repo。
- App 不是 required reviewer，不能核准等待審核的部署。**不要給 App Deployments 權限**。
- 處理方式：到 App 設定頁的 Private keys **先產生新私鑰、再刪除舊的**（只有一把時 GitHub 不讓你直接刪）；要立刻切斷就到 Settings → Applications → Installed GitHub Apps → 該 App 的 **Configure**，把安裝 **Suspend** 或 **Uninstall**（keeper 會退回只靠 GitHub 排程）。接著照「發現外洩時」檢查 workflow 是否都還是 active、有沒有預期外的 run。

## token 輪替

- **GitHub App 私鑰**：建議每 90 天換一次。App 設定頁 → Private keys → Generate a private key → `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < 新私鑰.pem`（`secret put` 會立刻部署新版本，快取的 token 也跟著清掉）→ 下一次 cron 的 log 出現 `auth: GitHub App installation token（new…）` 且沒有錯誤 → 回 App 設定頁刪除舊私鑰。一個 App 最多可以同時有 25 把私鑰，所以新舊可以並存到確認完成。
- 以下是使用 PAT 時的輪替方式。
- 到期前 7 天：依第 6 步建立新 token（同樣只給 Actions: Read and write、≤ 90 天），執行 `npx wrangler secret put GITHUB_TOKEN` 換上新 token。等下一次 cron 在 Logs 出現 `decide: dispatch=...` 且沒有錯誤，再到 GitHub 撤銷舊 token。
- 懷疑外洩：先撤銷，再依上面「發現外洩時」檢查，最後換新 token。
- 忘了輪替時，token 過期會讓 dispatch 回 401，cron 會被 Cloudflare 記成失敗（`scheduled` 直接 await，失敗會 reject）。GitHub 排程仍在跑，不會完全停擺。

## 驗證

- Cloudflare dashboard → Workers → `pepelab-keeper-trigger` → Logs（`[observability]` 已開啟）：每 20 分鐘每支 workflow 各一行 `[<workflow>] decide: dispatch=...`；dispatch 失敗的 cron 會顯示為錯誤。
- GitHub → Actions → Base Sepolia Keeper 與 Oracle Price Keeper (Sepolia)：兩者都出現 `workflow_dispatch` 觸發的執行，且間隔不超過約 35 分鐘。
- `oracle-health.yml` 的過期告警 issue 應該不再出現。

## 調整

`wrangler.toml` 的 `[vars]`：`WORKFLOW_FILES`（逗號分隔，預設兩支 keeper；舊的單一 `WORKFLOW_FILE` 仍相容，`WORKFLOW_FILES` 優先）、`MIN_GAP_SEC`（預設 900）、`WORKFLOW_REF`（預設 master）、`GITHUB_APP_ID` 與 `GITHUB_APP_INSTALLATION_ID`（改用 GitHub App 時才設，見上方）。cron 間隔改 `[triggers] crons`。

## 測試

```bash
node --test ops/keeper-trigger/keeper-trigger.test.mjs
```
CI（consistency.yml 的 `keeper-trigger` job）會跑這組測試。

部署前想確認 Worker 打包得起來（不需要登入、不會部署）：

```bash
cd ops/keeper-trigger
npx wrangler@4.145.0 deploy --dry-run --outdir "$(mktemp -d)"
```

## workflow 守門的靜態檢查

上面的保護（私鑰只放 environment secret、只有特定 job 綁那個 environment、admin 呼叫先經人工核准）都只是 workflow 檔裡的幾行 YAML。`scripts/check-workflow-guards.mjs` 把它們寫成檢查，consistency.yml 的 `workflow-guards` job 在每個 PR 與 master push 上執行。檢查分兩層。

**第一層：持有私鑰的 workflow 整檔釘選。** 任何 job 引用 `KEEPER_PRIVATE_KEY`／`FEE_SETTLEMENT_PRIVATE_KEY`（或動態、整包存取 secrets），或綁 `keeper`／`settlement`／`admin-approval` 的 workflow，整份檔案的 sha256 必須等於 `PINNED_WORKFLOWS` 的釘選值。雜湊前只做兩件事：去掉 BOM、CRLF 換成 LF。註解與空白都算，改任何一個字都會紅。檢查器會自動找出所有持鑰 workflow：新增一支卻沒加進釘選表會失敗，釘選表裡的檔案不見了也會失敗。

目前釘選的是 `admin-base-sepolia.yml`、`base-sepolia-keeper.yml`、`price-keeper.yml`、`x402-settlement-worker.yml` 四支（雜湊以 `scripts/check-workflow-guards.mjs` 的 `PINNED_WORKFLOWS` 為準，這裡不重抄，免得兩邊不同步）。

為什麼要整檔釘選：PR #217 的兩輪審查都是「補一種危險寫法，又冒出另一種」。第一輪補了 `continue-on-error`，第二輪就找到 `if: always()`。第一輪擋了 `${{ inputs.* }}` 內插，第二輪就找到 `${{ env.X }}` 與 `toJSON(github)`。第一輪釘住了守門 step，第二輪就找到後面 step 的 `uses: docker://` 與寫 `$GITHUB_PATH` 放假的 `cast`。這四支檔能直接動用私鑰，所以改成「任何修改都要人工審過整份 diff，再更新雜湊」，不再靠列舉危險寫法。

**第二層：結構規則。** 更新釘選值時仍然要過這一層，它也讓錯誤訊息能指出是哪一種危險改動：

| 項目 | 規則 |
|---|---|
| (a) environment 允許清單 | 綁 `keeper` 的只能是 `base-sepolia-keeper.yml#keep`、`price-keeper.yml#update-prices`、`admin-base-sepolia.yml#admin-call`；`settlement` 只能是 `x402-settlement-worker.yml#settle`；`admin-approval` 只能是 `admin-base-sepolia.yml#approve`。字串與物件寫法都算，名稱不分大小寫。未登記的 environment、`${{ }}` 動態名稱一律拒絕 |
| (b) admin workflow | 結構採白名單：workflow 層級只能有 `name`／`on`／`permissions`／`jobs`（沒有 `defaults`、`env`、`concurrency`），只能有 `precheck`、`approve`、`admin-call` 三個 job，每個 job 只能有列出的鍵（沒有 `if`、`continue-on-error`、`defaults`、`services`、`container`、`strategy`），`runs-on` 必須是 GitHub 代管的 ubuntu。三個 job 的第一個 step 是守門：只能有 `name`／`env`／`run`（沒有 `shell`、`if`），而且 `env`＋`run` 全文的 sha256 必須等於檢查器裡的 `GUARD_SHA256`（`admin-call` 連同 job 層級的 `env` 一起算；YAML 註解不算）。`precheck` 不可綁 environment、不可引用 secret、`permissions: {}`、只有一個 step；`approve` 必須 `needs: precheck`、以字串寫法綁 `admin-approval`、不引用 secret、只有一個 step；`admin-call` 必須 `needs: approve`，所有 step 都不可有 `continue-on-error` |
| (c) 觸發事件 | 任何 workflow 都不可使用 `pull_request_target`／`workflow_run`。admin workflow 只能用 `workflow_dispatch`。綁 `keeper`／`settlement` 的其他 workflow 只能用 `schedule`、`workflow_dispatch`，而且 `workflow_dispatch` 不可有 `inputs`（否則允許清單內的 keeper job 可以被改成不經核准、可帶參數的 admin） |
| (d) 私鑰 secret | 引用 `secrets.KEEPER_PRIVATE_KEY` 的 job 必須綁 `keeper`，引用 `secrets.FEE_SETTLEMENT_PRIVATE_KEY` 的必須綁 `settlement`。`secrets[...]` 動態存取、`toJSON(secrets)`、`secrets: inherit` 一律拒絕。找 `${{ }}` 的結尾時跳過單引號字串（與 actions/runner 一致），`format('}}', secrets.X)` 藏不住 |
| (e) reusable workflow | 任何 job 都不可用 job 層級的 `uses:`（被呼叫的 workflow 可以自己綁 environment，可能在別的 repo，這支檢查看不到） |
| (f) shell injection | 任何 `run:` 都不可內插 `${{ inputs.… }}`、`${{ github.event.… }}`，一律經 `env` 傳遞 |
| (g) 持鑰 workflow 的 step | `run:` 內不可有任何 `${{ }}`（值一律經 step 的 `env` 傳入，`${{ env.X }}`、`toJSON(github)` 也算內插）；step 的 `uses:` 只能是釘 40 位 commit SHA 的 `actions/checkout`、`actions/setup-node`、`foundry-rs/foundry-toolchain`（不可用 `docker://`、本地 action 或 tag）；admin workflow 守門以外的 step 不可有 `if`（`if: always()`／`failure()` 會在守門失敗後照樣執行） |
| YAML | anchor／alias、merge key（`<<`）、重複的鍵、多文件、解析失敗一律算失敗 |

```bash
npm ci --ignore-scripts --prefix scripts          # 第一次：安裝固定版本的 YAML 解析器
node --test scripts/check-workflow-guards.test.mjs
node scripts/check-workflow-guards.mjs
```

- **改任何一支持鑰 workflow 時**（admin、兩支 keeper、settlement，包括只改註解）：先人工審過整份 diff，再執行 `node scripts/check-workflow-guards.mjs --print-pins`，把印出的值貼進 `PINNED_WORKFLOWS`。workflow 的 diff 與雜湊的 diff 會出現在同一個 PR，審查時一起看。
- **Dependabot**：Dependabot 升級這四支檔裡的 action SHA 時，`workflow-guards` 會紅。這是刻意的：被換掉的 action 在持有私鑰的 job 裡執行，例如 `foundry-toolchain` 可以裝一個假的 `cast`。處理方式是人工確認新 SHA 對應的 release 與 diff，再在同一個 PR 更新 `PINNED_WORKFLOWS`。其他 workflow 的 Dependabot PR 不受影響。
- **新增一個要用私鑰或綁 environment 的 job 時**，要同時改 `scripts/check-workflow-guards.mjs` 的 `ENVIRONMENTS` 與 `PINNED_WORKFLOWS`（刻意的摩擦：這些改動會出現在 PR diff 裡）。
- **改 admin workflow 的守門 step 時**（任何一個字，包括錯誤訊息），另外執行 `--print-guard-hashes` 更新 `GUARD_SHA256`。說明請寫在 YAML 註解裡（不算進守門指紋，但算進整檔雜湊）。
- 測試把 PR #217 兩輪審查的 50 個繞過嘗試（第一輪 40 個、第二輪 N 系列 10 個；`scripts/fixtures/check-workflow-guards/bypass-cases.mjs`）以現行 workflow 為底重做。每一個都必須被擋，而且是以預期的理由；第二層單獨跑也要擋住，只有 N06（寫 `$GITHUB_PATH` 放假的 `cast`，純 shell 內容）是只有第一層擋得到。
- **actionlint**：consistency.yml 的 `actionlint` job 下載固定版本（1.7.12）的 release 檔、驗 sha256 後執行，連同 runner 內建的 shellcheck 檢查 `run:`。這個 pin 不在 Dependabot 範圍內，升級時手動改 `VERSION` 與 `SHA256`。
- **依賴**：只有 `yaml`，版本固定在 `scripts/package.json`（2.9.1，與 `agent/package-lock.json` 相同），`scripts/package-lock.json` 帶 sha512 integrity，CI 用 `npm ci --ignore-scripts` 安裝。不自己寫 YAML 解析器，是因為自製解析一旦和 GitHub 的解析結果不同就會被繞過；anchor／alias、重複的鍵、解析失敗的檔案一律算失敗。
- **它檢查不到的事**（寫實版）：
  - **舊分支**：只檢查目前 checkout 的 workflow 檔（PR 上是合併後的結果，master push 上是 master）。遠端其他分支上的舊版 workflow 照樣可以被 dispatch，不在範圍內；擋它們的是「部署前必做」第 4 步（刪掉 repo 層級私鑰），在那之前這支檢查對「dispatch 到舊分支」完全沒有作用。
  - **它不是必要的檢查（擁有者待辦）**：master 目前沒有 branch protection 或 ruleset，所以 `workflow-guards` 與 `actionlint` 紅了也擋不住合併，也擋不住直接 push 到 master。整檔釘選的效果只是讓改動被看見，不是強制。**建議**你在 repo 設定（Settings → Rules → Rulesets，或 Branches → Branch protection）把 `workflow guards (environment / secrets / triggers)` 與 `actionlint` 設成 master 的 required status check。本 PR 不改 repo 設定。
  - **GitHub 上的設定**：required reviewers、branch policy、secret 放在哪一層、App 的權限與安裝範圍，都不在 workflow 檔裡。`approve` 的 gate 只在執行時檢查 `admin-approval` 有沒有 required reviewers；其餘只能靠「部署前必做」第 3 步的 `gh api` 確認。
  - **語意**：整檔釘選保證「改了就看得見」，不保證「現在釘住的內容是對的」。守門 script 的正確性靠本機實跑（66 種組合）與審查；Validate inputs 的白名單、keeper 的程式碼，這支檢查都不判斷對錯。
  - **runner 的行為**：檢查器用 `yaml` 套件解析，GitHub 用自己的解析器。已知的差異（anchor、merge key、多文件、`}}` 在單引號字串內）都改成直接拒絕，但不能保證沒有其他差異。整檔釘選不受這一點影響，因為它比對的是原始文字。
  - **action 本身的內容**：`uses: <action>@<sha>` 釘住的那個 commit 內容不檢查，只靠 SHA pin。admin-call 的 Install Foundry（`foundry-rs/foundry-toolchain`）在守門之後、拿私鑰的 step 之前執行，它安裝的 `cast` 就是之後送交易用的程式；這個 SHA 對應的內容若有問題，它可以在送交易的 step 拿到私鑰。action 的 `pre:` 階段也會在 job 開頭、守門之前執行。所以升級這些 SHA 時要人工審（見上面的 Dependabot 說明）。
  - **repo 轉移到 organization**：`github.repository_owner` 會變成 org 名稱，沒有使用者等於它，三道守門會永遠失敗（fail-closed）。轉移後要改 admin workflow 的白名單寫法，並更新兩個雜湊。
