---
status: proposed
date: 2026-10-02
plan-item: P3-03
---

# keeper 與結算 signer 改用雲端 KMS（AWS KMS secp256k1）＋GitHub OIDC，不再有原始私鑰；結算資金另放 Safe

> 2026-10-02。本文只是設計，**沒有任何程式、設定或部署變動**。外部資料的查詢日期都是 2026-10-02；標 **未查證** 的項目沒有找到可靠來源。
> pull oracle 之後 keeper 只轉送簽名價格，見 [ADR-013](ADR-013-pull-oracle.md)；升級權限與 Timelock 見 [ADR-015](ADR-015-v3-upgradeability.md)；
> 租戶隔離見 [ADR-008](ADR-008-tenant-isolation.md)。標 **【待擁有者決定】** 的項目本 ADR 不替擁有者做決定。

## 1. 背景

### 1.1 範圍：哪些金鑰在線上簽交易

| 金鑰 | 用在 | 鏈上權限 | 在哪裡執行 | 證據 |
|---|---|---|---|---|
| `KEEPER_PRIVATE_KEY` | 寫價、funding crank（`cast send settleFunding`）、marketOperator 切換 | GuardedOracle `KEEPER_ROLE`（`contracts/src/v2/GuardedOracle.sol:41`、`:280`）；MockOracle 的 owner（`contracts/src/MockOracle.sol:64`）；exchange 的 marketOperator | GitHub Actions，environment `keeper`，cron 每 15 分鐘＋Cloudflare Worker 每 20 分鐘 dispatch | `agent/keeper/run.ts:77`、`:117`、`:193-195`；`.github/workflows/base-sepolia-keeper.yml:29`、`:53-59`、`:271-273`；`.github/workflows/price-keeper.yml:12`、`:21` |
| 同一把 `KEEPER_PRIVATE_KEY` | 管理 workflow 的 `admin-call`（函式白名單含 `transferOwnership`、`updatePrice`、`mint`），前面有 `admin-approval` 人工核准 | 同上（MockOracle owner） | GitHub Actions | `.github/workflows/admin-base-sepolia.yml:34-43`、`:71-80`、`:282` |
| `FEE_SETTLEMENT_PRIVATE_KEY` | x402 分潤：MockUSDC `mint`（僅測試網）、`approve`、`FeeRouter.routeExternalRevenue` | 無角色；但它**持有待分潤的 USDC**：x402 的收款地址 `payTo` 被程式強制必須是 EOA（＝這把金鑰的地址，`agent/signal-api/src/app.ts:576-580`，`requireEoa: true`），`routeExternalRevenue` 再從它的餘額拉款 | GitHub Actions，environment `settlement`，cron 每 10 分鐘；程式拒絕在 Actions 以外執行 | `agent/signal-api/src/settlement.ts:24`、`:46`、`:258-289`；`agent/signal-api/src/settlement-worker.ts:835-842`；`.github/workflows/x402-settlement-worker.yml:24`、`:45-49` |
| `TENANT_KEEPER_PRIVATE_KEY` | 每個租戶的 keeper | 該租戶 oracle 的 `KEEPER_ROLE` | GitHub Actions，environment `keeper-<id>` | `ops/tenant-keeper/keeper.template.yml:11-13`、`:44-45`、`:106-117` |

不在本 ADR 範圍、但同一套做法之後適用的：signal-api 的 `VERIFIER_PRIVATE_KEY`（`agent/signal-api/src/app.ts:116-123`）、Telegram 交易 agent 經 `AGENT_PRIVATE_KEY` 建的 `GuardedWallet`（`agent/shared/src/provider.ts:69-71`）。admin、guardian 屬於治理金鑰，目標是 Safe＋Timelock（`docs/KEY_MANAGEMENT.md:26-33`、`docs/GOVERNANCE_HANDOVER.md`），不是本 ADR 的對象。

### 1.2 現在的保護與缺口

- `KEY_MANAGEMENT.md` 的前提是「keeper 必須在線，所以假設它終將外洩，以偏離上限約束」（`docs/KEY_MANAGEMENT.md:31`）。這個約束只在 GuardedOracle 上成立：**平台現行的 exchange 讀的是 MockOracle，keeper 是它的 owner，沒有偏離上限，可以寫任意價格**（`docs/KNOWN_LIMITATIONS.md:116-119` #3；`docs/ROLE_SEPARATION.md:26-31`）。租戶的 exchange 讀 GuardedOracle（`docs/ADR-008-tenant-isolation.md:36`），才受偏離上限約束。
- 私鑰以 GitHub environment secret 存放；`check-workflow-guards.mjs` 限定哪些 job 能引用哪個 environment（`scripts/check-workflow-guards.mjs:100-104`），持鑰 workflow 整檔 sha256 釘選（`:147-152`）；租戶 workflow 由範本產生並逐位元比對（`:22-31`）。
- **現況限制（截至 2026-10-01）**：keeper 與結算的金鑰仍以 repo 層級 secret 保存，`keeper`、`settlement` 兩個 environment 尚未設定 secret 與保護規則；`ops/keeper-trigger/README.md`「部署前必做」第 1–4 步尚未完成（見該文件）。把金鑰移入受保護的 environment、清理舊分支的存取路徑，是上線的前置條件（§6）。
- 私鑰一旦被讀出（log、舊分支、惡意依賴套件），就**永久**外洩：唯一的處置是換地址、重新授權，而在 Timelock 移交之後，撤銷角色要等 48 小時（`docs/GOVERNANCE_HANDOVER.md:1`）。
- 現在沒有任何簽章層的稽核紀錄：誰在什麼時候用 keeper 金鑰簽了什麼，只能從鏈上反推。

### 1.3 程式的整合點

- **`LocalNonceSigner`**（`agent/keeper/nonceSigner.ts:72`）繼承 ethers v6 的 `AbstractSigner`，只包一個實作 `InnerSigner` 介面的物件（`:60-70`：`provider`、`getAddress`、`getNonce`、`populateTransaction`、`sendTransaction`、`signMessage`、`signTypedData`、`signTransaction`）。nonce 存在本機、以佇列序列化（`:95-100`、`:119-152`）。**任何符合 `InnerSigner` 的 signer 都能塞進去**；現在塞的是 `new ethers.Wallet(PRIVATE_KEY, provider)`（`run.ts:193-195`）。
- **結算 worker** 刻意「先簽、先記 hash、再廣播」（`settlement.ts:274-289`）：`signer.populateTransaction` → `signer.signTransaction` → 記錄 → `provider.broadcastTransaction`。它需要一個**只簽不送**的 signer；廣播結果不明時不重送，以免重複分潤。
- **租戶範本**的 `keycheck` 以 `cast wallet address --private-key` 從私鑰推地址，比對租戶登記的 `roles.keeper`（`keeper.template.yml:106-117`）。
- **Cloudflare Worker**（`ops/keeper-trigger/`）只持有 GitHub 憑證、**不持有任何鏈上金鑰**（`ops/keeper-trigger/README.md:21`）；監控 Worker（ADR-009）唯讀。兩者在本設計中都**不會**拿到簽章能力。

## 2. 外部事實（查證）

**鏈上實測 B**：2026-10-02 以 `eth_getCode` 對 `https://sepolia.base.org` 唯讀查詢（Base Sepolia 區塊約 47,581,778），Roles 2.1.0／2.1.1 mastercopy 與 ModuleProxyFactory 的 runtime 長度分別為 24,401、24,409、2,046 bytes（非空）；另以 `cast code <位址> --rpc-url <RPC> | cast keccak` 比對，這三顆與 Allowance Module `0xAA46…091C` 在 Base Sepolia 與 Base 主網的 runtime bytecode 雜湊都相同。

| 項目 | 事實 | 來源 |
|---|---|---|
| AWS KMS secp256k1 | 支援 `ECC_SECG_P256K1`，簽章演算法 `ECDSA_SHA_256`；`Sign` 可用 `MessageType=DIGEST` 直接簽雜湊，回傳 DER 編碼 | <https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html>、<https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html> |
| low-s 與 v | Ethereum 要求 s ≤ n/2（EIP-2）；KMS 不處理，signer 要自己正規化 s、以公鑰還原 v | <https://eips.ethereum.org/EIPS/eip-2> |
| AWS KMS 價格 | 每把金鑰 $1／月（按小時攤）；非對稱 Sign 依官方範例 $0.15／10,000 次；引用非對稱金鑰的 `Sign`、`Verify`、`GetPublicKey` **不適用**每月 20,000 次免費額度 | <https://aws.amazon.com/kms/pricing/> |
| AWS KMS 稽核 | CloudTrail 預設記錄 KMS 操作（含密碼學操作） | <https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html> |
| AWS KMS 輪替 | 非對稱金鑰**不支援**自動或 on-demand 輪替，只能建新金鑰（對 EOA 而言＝新地址） | <https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html> |
| AWS KMS HSM 認證 | FIPS 140-3 Overall Level 3（證書 #4884），但它是 **Interim validation**（2024-11-18 初次驗證、sunset 2029-11-17）；secp256k1 列在 **Allowed**（不是 Approved）演算法，並註明「secp256k1 may only be used in block-chain related applications」。也就是說，**secp256k1 簽章不屬於 FIPS 核准演算法**，模組本身的認證不等於這把金鑰的簽章受 FIPS 核准 | <https://aws.amazon.com/compliance/fips/>、<https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4884>、<https://csrc.nist.gov/CSRC/media/projects/cryptographic-module-validation-program/documents/security-policies/140sp4884.pdf> |
| ethers v6 的 KMS signer | `@rumblefishdev/eth-signer-kms` 4.3.1（2026-05-21 發版，dependencies 含 ethers ^6）；`aws-kms-ethers-signer` 最後發版 2022-07；`ethers-aws-kms-signer` 最後版 1.3.2（2021-07-14） | <https://www.npmjs.com/package/@rumblefishdev/eth-signer-kms>；`npm view` |
| GCP Cloud KMS | `EC_SIGN_SECP256K1_SHA256` 只能用 HSM 與 HSM single-tenant 保護等級；HSM EC 金鑰版本約 $2.5／月（前 2,000 把）；`AsymmetricSign` 屬 Data Access 稽核日誌，**要另外開啟**；ethers v6 的 signer 套件：**未查證**（`ethers-gcp-kms-signer` 只支援 ethers 5、2022 年後停更；viem 有 `@valora/viem-account-hsm-gcp`）；HSM 欄每 10,000 次 $0.15 是否即 EC 簽章價：**未查證** | <https://docs.cloud.google.com/kms/docs/algorithms>、<https://cloud.google.com/kms/pricing>、<https://docs.cloud.google.com/kms/docs/audit-logging> |
| GitHub OIDC | AWS：`aws-actions/configure-aws-credentials` 的 `role-to-assume`，job 需 `id-token: write`；GCP：Workload Identity Federation，必須設 attribute condition | <https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws>、<https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-google-cloud-platform> |
| GitHub Environments 的方案限制 | required reviewers（「up to six users or teams」）與 wait timer 在 Free／Pro／Team 只適用公開 repo，私有 repo 要 Enterprise；私有 repo 的 deployment branches 要 Pro／Team | <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments> |
| Cloudflare | `aws4fetch` 以 fetch＋SubtleCrypto 做 SigV4，支援 Workers（1.0.20，2024-08）；Cloudflare Secrets Store 只儲存秘密、不做簽章（open beta）；Workers 的 WebCrypto 是否支援 secp256k1：**未查證** | <https://github.com/mhart/aws4fetch>、<https://developers.cloudflare.com/secrets-store/> |
| Fireblocks | 支援 Base（`BASECHAIN_ETH`）；TAP 可依發起者、來源、目的地、金額、合約互動設規則；`@fireblocks/fireblocks-web3-provider` 1.5.0（ethers ^6.13）；Essentials $999／月（「up to 6 months」），Custom 起價 $36,000／年 | <https://developers.fireblocks.com/docs/supported-networks>、<https://developers.fireblocks.com/docs/set-transaction-authorization-policy>、<https://www.fireblocks.com/pricing/> |
| Turnkey | 簽章在 AWS Nitro enclave 內；Pay-as-you-go 每月 25 次免費、之後 $0.10／簽；Pro $99／月＋$0.05／簽；Enterprise 低至 $0.0015／簽；`@turnkey/ethers` 1.3.44 | <https://docs.turnkey.com/security/secure-enclaves>、<https://www.turnkey.com/pricing> |
| Coinbase CDP Server Wallets | 金鑰在 TEE 內，支援 Base；每次寫入操作 $0.005、每月前 5,000 次免費，送一筆交易算 2 次操作 | <https://docs.cdp.coinbase.com/server-wallets/v2/introduction/welcome>、<https://docs.cdp.coinbase.com/server-wallets/v2/introduction/pricing> |
| Safe | v1.4.1（含 L2 版）在 Base 主網與 Base Sepolia 都是 canonical 部署 | <https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe_l2.json> |
| Safe 模組 | Zodiac Roles v2 可限制成員能呼叫的地址、函式與參數值；Zodiac 的網路清單有 Base 8453、**沒有 Base Sepolia 84532**；但 Roles v2 自己的 repo 有列 Base Sepolia（`zodiac-modifier-roles/packages/sdk/src/main/chains.ts` 的 `[84532]`），Roles 2.1.0／2.1.1 mastercopy（`0x9646…D337`、`0xf296…83d5`）與 ModuleProxyFactory（`0x0000…a236`）在 Base Sepolia 都有程式碼，runtime bytecode 的 keccak 與 Base 主網相同（鏈上實測 B）；Allowance Module v0.1.1（`0xAA46…091C`）的官方清單只有 Base 主網，但同一位址在 Base Sepolia 也有相同 bytecode（鏈上實測 B）；Rhinestone Smart Sessions（ERC-7579）自稱 beta | <https://docs.roles.gnosisguild.org/>、<https://github.com/gnosisguild/zodiac/blob/master/src/networks.ts>、<https://github.com/gnosisguild/zodiac-modifier-roles>、<https://github.com/safe-global/safe-modules-deployments/blob/main/src/assets/allowance-module/v0.1.1/allowance-module.json>、<https://github.com/erc7579/smartsessions> |
| Roles 成員的 gas | 成員以自己的 EOA 呼叫 `execTransactionWithRole`、自己付 gas（除非走 4337 bundler 或 relayer）——**這是依模組設計的推論，官方文件沒有原文** | — |

## 3. 方案比較

| | A. 現況（GitHub secret 存私鑰） | **B. 雲端 KMS（AWS）＋GitHub OIDC（建議）** | C. MPC／TEE 託管服務（Fireblocks、Turnkey、CDP） | D. Safe 模組＋受限 session |
|---|---|---|---|---|
| 私鑰能不能被讀出 | 能：任何拿到 secret 的 job、log、依賴套件 | 不能：金鑰不離開 HSM（模組為 FIPS 140-3 L3 interim 認證；secp256k1 是 Allowed 而非 Approved 演算法，§2） | 不能（MPC 分片或 TEE） | **不解決**：成員 EOA 的私鑰仍要放在某處；它限制的是「這把鑰匙能叫 Safe 做什麼」 |
| 外洩後的止血 | 換地址＋重新授權（Timelock 後要 48 小時） | **立即** `DisableKey`／撤 IAM 角色，金鑰當場不能再簽；鏈上換角色可以之後再做 | 立即停用（依服務） | Safe 撤銷該成員（需 Safe 門檻簽署，不經 Timelock 時是分鐘級） |
| 誰能簽 | 拿到 secret 的任何人 | 只有通過 IAM 條件的身分（`sub` 綁 repo＋environment，加上 environment 的分支限制；要綁到 workflow 檔需自訂 `sub` 範本，§4.2） | 依服務的 API 金鑰與政策引擎 | Safe 的成員 |
| 稽核紀錄 | 無 | CloudTrail 記錄每次 `Sign`（時間、身分、金鑰） | 服務內建 | 鏈上事件 |
| 與 `LocalNonceSigner` 整合 | 現況 | 直接：KMS signer 是 `AbstractSigner`，符合 `InnerSigner` | 視服務：web3 provider 型的服務通常自己管 nonce 與廣播，與本機 nonce 管理重疊 | 不影響 |
| 與結算的「先簽、記錄、再廣播」 | 現況 | 直接（`signTransaction` 只簽不送） | **衝突風險**：託管服務多半自己廣播；只簽不送需要 raw signing 或對應 API（**未查證**各服務的政策限制） | 結算改由 Safe 發出，見下方 |
| 成本（每月，以每把金鑰 10 萬次簽章為例的假設） | 0 | 金鑰 $1＋簽章 $1.5 ≈ **$2.5／把** | Turnkey PAYG ≈ $10,000；Turnkey Pro ≈ $5,099；CDP：只簽不送 1 次、送交易 2 次、政策評估另 1 次 → 約 $475–$1,475；Fireblocks $999 起（Essentials 只到 6 個月）或 $36,000／年起 | Safe 免費；每筆多一次模組呼叫的 gas（**未量測**） |
| 依賴 | GitHub | AWS 帳號（成為關鍵基礎設施） | 第三方廠商；停服風險（ADR-009 記錄過 OpenZeppelin Defender 停服的前例） | 合約模組；Roles v2 在 Base Sepolia 有 mastercopy，可以在測試網演練 |
| 持牌租戶的接受度 | 低 | 中高：雲端 HSM 是常見的機構做法 | 高：機構託管的標準選項 | 中 |

「10 萬次／月」是為了比較而設的假設，不是量測值：平台 keeper 每輪對 MockOracle 與 GuardedOracle 兩顆都寫（`agent/keeper/round.ts:242-243`），最多約 22 筆寫價＋funding，名目每 15 分鐘一輪，上限約 23 筆 × 96 輪 × 30 天 ≈ 6.6 萬筆；pull oracle 與常駐轉送（ADR-013）之後頻率會提高。按次計費的方案在這個假設下是 KMS 的約 190–4,000 倍（約 2.3–3.6 個數量級；CDP 計次見 <https://docs.cdp.coinbase.com/server-wallets/v2/introduction/pricing>），這是 C 不適合當預設的主因。

**為什麼不選 D 當 keeper 的主方案**：D 不保護 EOA 私鑰本身，只限制它能叫 Safe 做什麼；而 keeper 的鏈上權限要靠合約本身收窄。在**租戶部署**上，`KEEPER_ROLE` 只能寫價且受 GuardedOracle 的偏離上限約束，D 能再收窄的不多。**平台部署在 #130 改接 GuardedOracle、或 ADR-013 落地之前，keeper 權限並不窄**——它是 MockOracle 的 owner、可寫任意價格（KNOWN_LIMITATIONS #3）；但 D 也解決不了這件事（keeper 寫的是 oracle，不是經 Safe 動錢），正確的處置是 #130 與 ADR-013，不是 D。D 真正有價值的地方是**結算**：結算 signer 手上有錢，見 §4.3 的限制與額外需求。

## 4. 決定（建議）

**採 B（AWS KMS）。結算資金在主網改由 Safe 持有，但這需要 §4.3 的額外限制才有意義，不是單靠 Roles 模組。C 保留為「租戶自帶託管」的外掛點。**

選 AWS 而不是 GCP：secp256k1 以 $1／月的金鑰提供（GCP 要 HSM 等級）、CloudTrail 預設記錄簽章（GCP 要另開 Data Access 日誌）、有仍在維護的 ethers v6 signer（GCP 未查證）。【待擁有者決定】雲端帳號屬於誰。

### 4.1 Signer 工廠

在 `agent/shared` 新增一個工廠，依環境變數選 signer：

- `SIGNER_KIND=local`：現況（`ethers.Wallet`），只供本機與測試。
- `SIGNER_KIND=aws-kms`：`KMS_KEY_ID`＋區域；憑證來自環境（OIDC 換來的臨時憑證），**程式不讀任何長期 AWS 金鑰**。
- 主網的設定檢查：`SIGNER_KIND=local` 時拒絕啟動（比照結算 worker 拒絕在 Actions 以外執行的做法）。

整合點：

| 位置 | 改動 |
|---|---|
| `agent/keeper/run.ts:193-195` | `new LocalNonceSigner(makeSigner(provider))`；`LocalNonceSigner` **不改**——KMS signer 符合 `InnerSigner`。KMS 每次簽章是一次網路往返，會拉長序列化佇列，要量測 |
| `agent/signal-api/src/settlement.ts:46` | `wallet` 改成工廠產生的 signer；「先簽、記錄、再廣播」的流程不改 |
| `ops/tenant-keeper/keeper.template.yml:106-117` | `keycheck` 改為以 KMS `GetPublicKey` 推地址（或由 signer 工廠輸出地址），仍比對 `roles.keeper`；範本雜湊與 `check-workflow-guards.mjs` 一起更新 |
| `.github/workflows/*keeper*.yml`、`x402-settlement-worker.yml` | job 加 `permissions: id-token: write`、`aws-actions/configure-aws-credentials`；移除 `*_PRIVATE_KEY` 的引用 |
| `scripts/check-workflow-guards.mjs` | 新規則：只有允許清單上的 job 可以有 `id-token: write`；任何 workflow 引用 `*_PRIVATE_KEY` secret 都紅燈（主網後） |

### 4.2 IAM 的邊界

- 每個 signer 一把 KMS 金鑰、一個 IAM role；key policy 只允許該 role `kms:Sign` 與 `kms:GetPublicKey`，**不允許** `kms:ScheduleKeyDeletion`、`kms:PutKeyPolicy`（這些留給管理者身分）。
- role 的信任條件只能對 GitHub OIDC token 的 `aud`、`sub` 等條件鍵下條件；**AWS IAM 不能直接對 `job_workflow_ref` 下條件**。採兩層：
  1. **environment 的分支限制（主要機制）**：`keeper`、`settlement`、`keeper-<id>` 三類 environment 設 deployment branch policy＝只允許 master；role 的信任條件要求 `sub`＝`repo:<owner>/<repo>:environment:<env>`。其他分支上的 job 進不了這個 environment，就拿不到這個 `sub`。repo 目前是公開的（2026-10-02 查詢），這項保護在 Free 方案可用；若改為私有，需要 Pro／Team（§2）。
  2. **綁到 workflow 檔（選用的第二層）**：以 repo 的 OIDC `sub` 自訂範本（`POST /repos/{owner}/{repo}/actions/oidc/customization/sub` 的 `include_claim_keys`）把 `context` 與 `job_workflow_ref` 併進 `sub`，再對 `sub` 下條件。`job_workflow_ref` 只對**可重用 workflow** 有值，所以簽章步驟要搬進一支 master 上的可重用 workflow。改了 `sub` 範本，repo 內所有既有的 OIDC 信任條件都要一起改。【待擁有者決定】是否採用第二層。
- 這兩層一起關掉 `ops/keeper-trigger/README.md` 描述的舊分支存取問題：舊分支上的 workflow 拿不到 role。
- Cloudflare 的兩個 Worker **不取得任何 AWS 憑證**。keeper-trigger 仍只負責 dispatch；把簽章搬進 Worker（`aws4fetch`）意味著把長期 AWS 憑證放進 Worker secret，否決。
- 租戶：每個租戶自己的 KMS 金鑰與 role；理想上在**租戶自己的 AWS 帳號**，平台的 workflow 以跨帳號 role 取用【待擁有者決定】。租戶設定檔（`deploy/tenants/<id>.json`）加 `signer: { kind, keyId, roleArn }`，`check-tenant-deploy.mjs` 檢查不同租戶不共用金鑰。持牌租戶要自帶 Fireblocks 等託管時，以同一個工廠加一個 `kind`（C 的外掛點），不改 keeper 主程式。

### 4.3 結算資金放進 Safe：設計需求（主網）

**先講清楚 Roles 模組能限制什麼、不能限制什麼。**

- `routeExternalRevenue(trader, fee)` 會把 70% 記給**呼叫者自填的 `trader`**（`contracts/src/FeeRouter.sol:127-131`、`:161-165`），而 `withdrawTraderEarnings()` 由 `trader` 自己提領（`:136-142`）。所以「只准呼叫 `routeExternalRevenue`、限制單筆金額」並**不能**阻止款項被分給任意地址：只限制函式與金額時，被濫用的 signer 仍可決定 70% 的受益人。
- Roles v2 能做的是限制「呼叫哪個合約、哪個函式、每個參數的值或範圍」；它本身不知道哪些地址是合法的交易員。

**因此結算 Safe 的設計需求是（全部成立才採用）：**

1. **受益人必須受限**，二擇一：
   - Roles 對 `trader` 參數設白名單（Roles v2 的參數條件，例如等值比對的組合），白名單的變更經 Safe 門檻簽署；適合交易員數量少、變動慢的情況。
   - 或改經一顆**包裝合約**：它只接受已登記的交易員（例如 `StrategyRegistry` 的登記、或 signal-api 的 registry），再呼叫 `routeExternalRevenue`；Roles 只允許呼叫這顆包裝合約。登記本身的權限就成為新的信任點，要一併設計。
2. **金額限制**：單筆上限＋每日累計上限（Roles 的 allowance 類條件或包裝合約內實作）。
3. **`approve` 只對 FeeRouter（或包裝合約）**、金額不超過當日上限，不用 `MaxUint256`（現在結算 worker 對 FeeRouter 用 `MaxUint256`，`agent/signal-api/src/settlement.ts:262-266`）。
4. **收款路徑要先改**：`payTo` 現在被強制必須是 EOA（`app.ts:576-580`），x402 的款項會先落在 signer 的 EOA，不會進 Safe。改成 Safe 收款要改 signal-api 的 payTo 守門（`requireEoa`）與 ADR-010 的結算流程，不只是改設定。在那之前，至少要把 EOA 上的餘額限制在一個批次的量，並由 Safe 定期掃走（又是一次需要限制目的地的轉帳）。
5. 若擁有者不採 1，就必須**明文接受**「結算 signer 被濫用時，最多可把 Safe 內款項的 70% 分給任意地址」這個風險，並以每日上限限制單日損失。

其餘：結算 worker 的「先簽、記錄、再廣播」保留，簽的是送給 Roles 模組（或包裝合約）的那筆交易。Roles v2 在 Base Sepolia 有 mastercopy（§2），**這一節可以先在測試網演練**，主網上線前完成。

### 4.4 金鑰輪替

非對稱 KMS 金鑰不能原地輪替；**輪替＝新金鑰＝新地址＝重新授權**。能不能事先授權給備援地址，取決於鏈上權限是「角色」還是「單一地址」：

| 鏈上權限 | 型別 | 能否事先授權備援 | 證據 |
|---|---|---|---|
| GuardedOracle `KEEPER_ROLE` | AccessControl 角色，可多人 | ✓ | `contracts/src/v2/GuardedOracle.sol:41` |
| Roles 模組成員（§4.3） | 可多個成員 | ✓ | Roles v2 文件 |
| exchange 的 `marketOperator` | **單一地址**，只能由 owner 以 `setMarketOperator` 改 | ✗，換人要經 owner（Timelock 移交後 48 小時） | `contracts/src/PerpetualExchange.sol:379`、`:831-833` |
| MockOracle 的 owner | **單一 `Ownable`** | ✗，`transferOwnership` 只能由現任 owner（就是 keeper 本身）發起 | `contracts/src/MockOracle.sol:6`、`:36`、`:64` |

| 情境 | 做法 |
|---|---|
| **備援金鑰** | 每個 signer 預先建好第二把 KMS 金鑰並**事先**授予可多人持有的角色（`KEEPER_ROLE`、Roles 成員），平時停用（`DisableKey`），只放少量 gas |
| 緊急（懷疑被濫用） | (1) 立即 `DisableKey` 現役金鑰並撤 IAM role 的信任——分鐘級止血；(2) 啟用備援金鑰、改 workflow 的 `KMS_KEY_ID`：`KEEPER_ROLE` 與 Roles 成員的工作立即恢復；(3) **`marketOperator` 與 MockOracle owner 無法立即恢復**：marketOperator 要經 owner／Timelock 改指（48 小時），這段期間 RWA 的開休市 ReduceOnly 自動切換中斷，改由 guardian 手動收緊（guardian 可以收緊到 ReduceOnly，`PerpetualExchange.sol:327`，但不能放寬）；MockOracle 的 owner 只能由停用中的舊金鑰轉移（暫時重新啟用、只簽這一筆、再停用），或隨 #130 退役；(4) 經 Timelock 撤銷舊地址的 `KEEPER_ROLE`；(5) 舊地址剩餘的 ETH 只能用舊金鑰簽出，若金額小就放棄，否則照 (3) 的方式暫時重新啟用 |
| 定期 | 依擁有者定的週期（【待擁有者決定】），用同一流程輪到備援、再建新的備援；單一地址的權限每次都經 Timelock |
| 租戶 | 同上，由租戶的 admin／Timelock 授權；平台不能替租戶授權（ADR-008） |

止血期間的中斷要寫進 `INCIDENT_RESPONSE.md`。V3 把 marketOperator 改成可多人持有的角色（ADR-015 §4.3）之後，這個缺口才會消失。

### 4.5 稽核日誌

- CloudTrail 記錄每次 `Sign`；以 EventBridge 規則把「非預期身分呼叫 `Sign`」「`DisableKey`／`PutKeyPolicy`／`ScheduleKeyDeletion`」轉成 webhook，送到 ADR-009 的告警通道（SEV-1）。
- `Sign` 收到的是雜湊，CloudTrail 不會記錄交易內容（**未查證** CloudTrail 對 `Sign` 記錄哪些參數），所以應用層要在送出前記錄 tx hash 與 nonce（結算 worker 已經這樣做；keeper 補上），兩邊以時間與 tx hash 對帳。
- 保存期限與存放處（另一個帳號的 S3、物件鎖定）【待擁有者決定】。CloudTrail 的保存與事件費用：**未查證**（實作前查官方定價）。

### 4.6 成本（估計）

| 項目 | 數量（假設） | 單價（§2） | 每月 |
|---|---|---|---|
| KMS 金鑰 | 平台 keeper、結算各 1＋備援 1 ＝ 4；每個租戶 keeper 2 | $1 | $4＋$2／租戶 |
| 簽章 | 每把現役金鑰 10 萬次 | $0.15／萬次 | $1.5／把 |
| CloudTrail、EventBridge | — | **未查證** | — |
| Safe＋Roles（主網結算） | — | 0（合約） | 每筆多的 gas：**未量測** |

### 4.7 `docs/RUNBOOK_KEY_ROTATION.md` 要怎麼改

這份 runbook 現在只處理 deployer／owner 金鑰外洩後的輪替（標題與 §0–§10），而且明寫 `KEEPER_PRIVATE_KEY` 「目前無需更換」（`docs/RUNBOOK_KEY_ROTATION.md:311`）。實作本 ADR 時：

1. **標題與範圍**：改成「金鑰輪替」，開頭加一張表：哪一類金鑰走哪一節（deployer／owner：現有 §1–§10；線上 signer：新 §11；治理 Safe：指向 `GOVERNANCE_HANDOVER.md`）。
2. **新增 §11「線上 signer（KMS）」**：§4.4 的緊急與定期流程，逐步的 AWS CLI 與 `cast` 唯讀驗證指令（不含任何金鑰字面值）；Timelock 提案的順序；備援金鑰的狀態檢查。可事先授權的角色（`KEEPER_ROLE`、Roles 成員）與單一地址權限（marketOperator、MockOracle owner）分成兩個小節，後者寫明換手期間的手動處置。
3. **§7.2 GitHub Secrets 表**：`KEEPER_PRIVATE_KEY`、`FEE_SETTLEMENT_PRIVATE_KEY`、`TENANT_KEEPER_PRIVATE_KEY` 改為「遷移後必須不存在於 repo 與任何 environment」，以 `gh secret list`（repo 與每個 environment）確認；新增「IAM role 的信任條件」檢查列。
4. **§9 完成檢查表**：加上「鏈上 `KEEPER_ROLE`／marketOperator 的持有者＝KMS 金鑰推出的地址（現役＋備援），沒有其他地址」「CloudTrail 告警有送達」。
5. **附錄的一鍵驗證腳本**：加上讀 KMS 公鑰推地址、與鏈上角色比對的唯讀檢查。
6. **租戶**：`TENANT_OPERATIONS.md` 的 keeper 金鑰段落改指 §11。

## 5. 實作計畫

工作量是單人估計（含測試，不含等待時間），**未經驗證**。

| 階段 | 內容 | 工作量 | 前置 |
|---|---|---|---|
| **0. 帳號與身分** | 擁有者建立 AWS 帳號（或指定公司帳號）、GitHub OIDC 身分提供者、每個 signer 的 IAM role 與 KMS 金鑰；同時完成 `ops/keeper-trigger/README.md`「部署前必做」的 environment 清理 | 1 人日＋擁有者操作 | 擁有者 |
| **1. Signer 工廠** | `aws-kms` signer（DER 解碼、low-s、v 還原、`signTypedData`）；以本機 secp256k1 模擬 KMS 的單元測試；`LocalNonceSigner` 以 KMS signer 為 inner 的測試（nonce、並行、stale） | 3–5 人日 | — |
| **2. workflow 與檢查器** | OIDC、移除私鑰引用、`check-workflow-guards.mjs` 新規則、租戶範本的 `keycheck`；過渡期保留 `SIGNER_KIND=local` 旗標 | 2–3 人日 | 階段 1 |
| **3. 測試網切換** | 新地址加 gas、授予角色（Timelock 移交前即時、之後 48 小時）、切換、撤銷舊地址、刪除 repo 與 environment 的私鑰 secret | 1–2 人日＋Timelock 延遲 | 階段 2 |
| **4. 稽核與 runbook** | CloudTrail→EventBridge→webhook；§4.7 的 runbook 改寫；緊急輪替演練一次 | 2–3 人日 | 階段 3 |
| **5. 結算 Safe** | §4.3 的全部需求：受益人限制（Roles 白名單或包裝合約）、單筆與每日上限、有上限的 `approve`；signal-api 的 payTo 守門（`requireEoa`）與 ADR-010 結算流程改為 Safe 收款；結算 worker 改送 Roles 交易。先在 Base Sepolia 演練（Roles v2 有 mastercopy），再上主網 | 6–10 人日（含包裝合約時另加稽核） | 階段 3 |

## 6. 上主網前必須成立的條件

1. `ops/keeper-trigger/README.md`「部署前必做」第 1–4 步已完成並記錄日期；repo 與任何 environment 都沒有 keeper、結算、租戶 keeper 的原始私鑰；以 `gh secret list`（repo 與每個 environment）確認並記錄。
2. repo 內（含 git 歷史以外的現行檔案）沒有任何私鑰字面值，包括已作廢的舊金鑰預設值。
3. IAM role 的信任條件要求 `sub`＝`repo:<owner>/<repo>:environment:<env>`，且該 environment 的 deployment branch policy 只允許 master（§4.2 第 1 層）；若採第 2 層，`sub` 範本已含 `job_workflow_ref` 並對它下條件。驗收：從非 master 分支 dispatch 一次，確認 job 進不了 environment（第 1 層）或 STS 拒絕 `AssumeRoleWithWebIdentity`（第 2 層），兩者都要記錄是哪一層擋下的。
4. 每個 signer 可多人持有的角色都有已授權、已停用的備援金鑰；單一地址權限（marketOperator、MockOracle owner）的換手流程與中斷期間的手動處置寫進事故手冊；緊急輪替在測試網演練過一次（含 Timelock 的時間）。
5. CloudTrail 的關鍵事件告警送達 ADR-009 的通道。
6. 結算資金符合 §4.3 的設計需求：受益人受限（白名單或包裝合約）、單筆與每日上限、`approve` 不用無上限額度、payTo 收款路徑已改（含 signal-api 的 `requireEoa` 與 ADR-010 流程）；或擁有者已書面接受 §4.3 第 5 點的風險。
7. 轉送／keeper 服務不在 GitHub cron 上（ADR-013），其執行環境以同一套 KMS＋短期憑證取得簽章能力。
8. 每個主網租戶的 signer 金鑰歸屬（租戶帳號或平台帳號）已寫進租戶契約。

## 7. 待擁有者決定

1. 雲端供應商與帳號歸屬（建議 AWS；個人帳號或公司帳號）。
2. 租戶的金鑰放在租戶自己的雲端帳號，還是平台的帳號。
3. 是否允許持牌租戶改用自己的 MPC 託管（Fireblocks 等），以及平台是否為此維護外掛。
4. 定期輪替的週期。
5. 稽核日誌的保存期限與存放位置。
6. 主網的 keeper／轉送服務在哪裡執行（GitHub Actions 已不適合，見 ADR-013）。
7. GitHub 方案：repo 目前是公開的（2026-10-02），environment 的 required reviewers 與 branch policy 在 Free 方案可用；若改為私有，required reviewers 需要 Enterprise、branch policy 需要 Pro／Team，`admin-approval` 的人工核准與 §4.2 第 1 層都依賴它們。
8. 結算 Safe 的簽署人與門檻。
9. 結算受益人的限制方式：Roles 白名單、包裝合約（以哪一份登記為準），或書面接受「最多 70% 可被分給任意地址」的風險（§4.3）。
10. 是否採用 §4.2 的第 2 層（自訂 OIDC `sub` 範本、簽章步驟搬進可重用 workflow）。

## 8. Consequences

- 原始私鑰從 CI 消失；「讀到 secret」不再等於「永久擁有金鑰」，外洩的止血從「等 Timelock」變成「停用金鑰」。
- AWS 帳號成為關鍵基礎設施：帳號被鎖或停用＝keeper 停擺。要有帳號層級的 MFA、break-glass 程序，並寫進事故手冊。
- 每次簽章多一次網路往返；keeper 一輪的時間會變長（未量測）。
- 輪替每次都要動鏈上角色（新地址），所以備援金鑰與 Timelock 排程成為例行作業。
- 租戶上線多一步：建立 KMS 金鑰與 IAM role，`TENANT_DEPLOYMENT.md` 要加上。

## 9. 參考

- 本 repo：`agent/keeper/nonceSigner.ts`、`agent/signal-api/src/settlement.ts`、`ops/keeper-trigger/README.md`、`ops/tenant-keeper/keeper.template.yml`、`scripts/check-workflow-guards.mjs`、[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md)、[`ROLE_SEPARATION.md`](ROLE_SEPARATION.md)、[`RUNBOOK_KEY_ROTATION.md`](RUNBOOK_KEY_ROTATION.md)
- 外部來源見 §2。
