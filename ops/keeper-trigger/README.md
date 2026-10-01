# keeper 外部觸發器（Cloudflare Worker）

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
> - 改用專用身分後，把它的名稱（例如 `pepelab-keeper[bot]`）設成 repo variable `KEEPER_TRIGGER_ACTOR`（Settings → Secrets and variables → Actions → Variables）。admin workflow 會拒絕 `github.actor` 或 `github.triggering_actor` 等於它的 run（這個檢查在人工核准**之後**才執行，見「改用 GitHub App」第 8 步的說明）。**沒設定這個 variable 時不擋**，現在用你本人的 PAT 時也不要設，否則你自己的 admin run 也會被拒絕。
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
6. **建立 Worker 用的 token**（用你本人的 fine-grained PAT；`KEEPER_TRIGGER_ACTOR` 先不要設。要讓 Worker 有自己的身分，改做下方「改用 GitHub App」，這一步與第 7 步的 `GITHUB_TOKEN` 就可以跳過）：<https://github.com/settings/personal-access-tokens/new>
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

## 改用 GitHub App（讓 Worker 有自己的身分）

用你本人的 PAT 時，Worker 觸發的 run 和你親手觸發的 run 在 GitHub 上是同一個人。改用 GitHub App 後，Worker 觸發的 run 會顯示為 `<app-slug>[bot]`，這時才能設定 `KEEPER_TRIGGER_ACTOR`，讓 admin workflow 拒絕 Worker（或偷到 Worker 憑證的人）觸發的 admin run。

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
   - **Permissions → Repository permissions**：**只把 Actions 設為 Read and write**（Metadata: Read-only 會自動帶上）。其餘全部 No access，尤其**不要**開 Deployments、Administration、Contents、Secrets、Environments、Workflows。Organization 與 Account permissions 全部 No access。
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
   - 兩個 ID 不是秘密，也可以改成取消 `wrangler.toml` 裡 `[vars]` 的註解後填入並送 PR。**兩種方式擇一**：同一個名稱不要同時是 var 又是 secret。
   - 設定完成後把私鑰檔從下載資料夾刪掉（需要保留就放進密碼管理器）。私鑰**絕對不要**寫進 `wrangler.toml` 或 commit。
7. **確認 Worker 真的在用 App，並確認觸發者的實際名稱**：
   - Cloudflare → Workers → `pepelab-keeper-trigger` → Logs：下一次 cron 應該有一行 `auth: GitHub App installation token（new，expires in …）`，之後兩三次是 `cached`。出現 `換 installation token 失敗：HTTP 401` 代表 App ID 與私鑰不是同一個 App；`404` 代表 installation ID 不對；`422` 代表 App 沒有安裝在本 repo 或沒有 Actions 權限。
   - 等 Worker 觸發過一次 keeper 之後執行：

     ```bash
     gh api 'repos/zuemen/pepelab_onchain_cfd/actions/runs?event=workflow_dispatch&per_page=10' \
       --jq '.workflow_runs[] | {name, actor: .actor.login, triggering_actor: .triggering_actor.login, created_at}'
     ```

     Worker 觸發的那幾筆，`actor` 與 `triggering_actor` 應該都是 `<slug>[bot]`（例如 `pepelab-keeper[bot]`）。**把實際看到的字串記下來**，下一步要用。
8. **設定 `KEEPER_TRIGGER_ACTOR`**：repo → Settings → Secrets and variables → Actions → **Variables** → New repository variable，名稱 `KEEPER_TRIGGER_ACTOR`，值填第 7 步實際看到的字串（含 `[bot]`）。
   - **一定要在第 7 步確認之後才設**。還在用你本人的 PAT 時設了它沒有作用（名稱對不上）；填成你自己的帳號則會讓你自己的 admin run 全部被拒。
   - 它在 admin workflow 裡的作用（`.github/workflows/admin-base-sepolia.yml`）：`approve` job 的 gate step 會拒絕 `github.actor` 或 `github.triggering_actor` 等於這個值的 run，`admin-call` 的第一個 step 會再檢查一次 `github.triggering_actor`。比對不分大小寫。
   - **這個檢查發生在人工核准之後，不是之前**。`approve` 綁了 `environment: admin-approval`，而「A job that references an environment must follow any protection rules for the environment before running」（[文件](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)），所以 gate step 要等你按下核准才會執行。也就是說：Worker 的憑證外洩、被人拿去 dispatch admin workflow 時，那筆 run **仍然會出現在等待核准的清單裡**。改用 App 之後的差別有兩個：
     1. 核准畫面上那筆 run 的觸發者是 `<slug>[bot]`，不是你。**觸發者不是你本人的 admin run 一律 Reject**，這是第一道。
     2. 就算誤按了核准，gate 也會讓 run 在 `approve` 就失敗，`admin-call` 不會開始，私鑰不會被取用。這是第二道。
   - 如果要讓這種 run 連核准畫面都到不了，需要在 `approve` 之前加一個不綁 environment、不碰任何 secret 的檢查 job（`approve` 再 `needs` 它）。目前的 workflow 沒有這個 job。
   - 想先確認 gate 會擋：把 `KEEPER_TRIGGER_ACTOR` 暫時設成 `zuemen`，手動 dispatch 一次 admin workflow 並核准，`approve` 應該以「這次 run 由 keeper 觸發器帳號 zuemen 觸發」失敗（`admin-call` 不會執行，不會送交易），確認後把值改回 bot 的名稱。
9. **移除 PAT**：確認連續幾次 cron 都正常後，`npx wrangler secret delete GITHUB_TOKEN`，再到 <https://github.com/settings/personal-access-tokens> 撤銷那個 PAT。只要 App 三項有設定，Worker 就不會使用 `GITHUB_TOKEN`，留著只是多一個可以外洩的憑證。

### 觸發者名稱的依據與待驗證事項

- 文件對 `github.actor` 的定義是「The username of the user that triggered the initial workflow run」，`github.triggering_actor` 是「The username of the user that initiated the workflow run. If the workflow run is a re-run, this value may differ from `github.actor`」（[Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。**文件沒有明寫由 App 觸發的 `workflow_dispatch` 會是什麼字串。**
- 實測依據（2026-10-01，以公開的 REST API `GET /repos/{owner}/{repo}/actions/runs?event=workflow_dispatch` 查詢，未觸發任何 workflow）：`microsoft/vscode` 有 94 筆 run 的 `actor.login` 與 `triggering_actor.login` 都是 `vs-code-engineering[bot]`（`type: Bot`）；`grafana/grafana` 有 16 筆是 `grafana-releases-oss[bot]`。格式是 `<app-slug>[bot]`。
- 重跑時兩個值會分開：`vercel/next.js` 有一筆 run 的 `actor` 是 `github-actions[bot]`、`triggering_actor` 是按下 Re-run 的人。所以 Worker 觸發的 admin run 被人重跑時，`actor` 仍是 bot，`approve` 的 gate（兩個值都比對）仍然會拒絕；`admin-call` 另外拒絕任何 `run_attempt != 1`。
- **待驗證**：本 repo 的 App 實際顯示的字串。API 的 `actor.login` 與 workflow 內的 `github.actor` 理論上是同一個值，但沒有在本 repo 實測過，所以第 7 步要求先用 `gh api` 看過再設 variable，第 8 步最後一項可以用來確認 gate 本身會擋。

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

## workflow 守門的靜態檢查

上面的保護（私鑰只放 environment secret、只有特定 job 綁那個 environment、admin 呼叫先經人工核准）都只是 workflow 檔裡的幾行 YAML。`scripts/check-workflow-guards.mjs` 把它們寫成檢查，consistency.yml 的 `workflow-guards` job 在每個 PR 與 master push 上執行：

| 項目 | 規則 |
|---|---|
| (a) environment 允許清單 | 綁 `keeper` 的只能是 `base-sepolia-keeper.yml#keep`、`price-keeper.yml#update-prices`、`admin-base-sepolia.yml#admin-call`；`settlement` 只能是 `x402-settlement-worker.yml#settle`；`admin-approval` 只能是 `admin-base-sepolia.yml#approve`。字串與物件寫法都算，名稱不分大小寫。未登記的 environment、`${{ }}` 動態名稱一律拒絕 |
| (b) admin workflow | `admin-call` 必須 `needs: approve`、沒有 job 層級的 `if`／`continue-on-error`，第一個 step 必須是 `github.ref == refs/heads/master` 與 `github.run_attempt == 1` 的守門。`approve` 必須綁 `admin-approval`、不引用任何 secret、不能被 `if`／`continue-on-error` 繞過 |
| (c) 觸發事件 | 任何 workflow 都不可使用 `pull_request_target`／`workflow_run` |
| (d) 私鑰 secret | 引用 `secrets.KEEPER_PRIVATE_KEY` 的 job 必須綁 `keeper`，引用 `secrets.FEE_SETTLEMENT_PRIVATE_KEY` 的必須綁 `settlement`。`secrets[...]` 動態存取、`toJSON(secrets)`、`secrets: inherit` 一律拒絕 |

```bash
npm ci --ignore-scripts --prefix scripts          # 第一次：安裝固定版本的 YAML 解析器
node --test scripts/check-workflow-guards.test.mjs
node scripts/check-workflow-guards.mjs
```

- **新增一個要用私鑰或綁 environment 的 job 時**，要同時改 `scripts/check-workflow-guards.mjs` 的 `ENVIRONMENTS`（刻意的摩擦：這個改動會出現在 PR diff 裡）。
- **依賴**：只有 `yaml`，版本固定在 `scripts/package.json`（2.9.1，與 `agent/package-lock.json` 相同），`scripts/package-lock.json` 帶 sha512 integrity，CI 用 `npm ci --ignore-scripts` 安裝。不自己寫 YAML 解析器，是因為自製解析一旦和 GitHub 的解析結果不同就會被繞過；anchor／alias、重複的鍵、解析失敗的檔案一律算失敗。
- **它檢查不到的事**：這是對 master 上 workflow 檔的靜態檢查。舊分支上的舊版 workflow、GitHub 網頁上的 environment 設定（required reviewers、branch policy、secret 放在哪一層）、守門 script 在執行時的實際行為都不在範圍內；那些仍然靠「部署前必做」的設定與 `approve` 的 fail-closed gate。
