# RWA＋SSI PoC 錄影劇本（Base Sepolia，租戶 `rwa-poc`）

> 狀態：**2026-10-07 完整彩排一次跑通（S7）**，交易 hash 是那次實跑的結果（見 §8）。錄影劇本 `scripts/poc/video/scenes/rwa-poc-full.mjs`
> 照本文 10 景自動操作前端並把 CLI 步驟放進「終端機分頁」。錢包見 [WALLETS.md](WALLETS.md)，合約見 [DEPLOYMENT.md](DEPLOYMENT.md)，
> keeper 與休市切換見 [RUNBOOK.md](RUNBOOK.md)，前端設定見 [FRONTEND.md](FRONTEND.md)。

## 誠實聲明（片頭或片尾字幕要講到）

- 全部在 **Base Sepolia 測試網**。保證金是平台既有的測試代幣 **MockUSDC**（與現役測試部署共用，不是真錢）；x402 付款用的是 Circle 測試 USDC。
- 價格由我們自己在本機跑的 keeper 推上鏈（來源是公開行情），**不是**受監管的報價服務；oracle 沒有獨立參考來源（`referenceSource: none`）。
- 發證者、碳分級見證者都是 PoC 團隊自己的錢包，**不是**持牌的 KYC 機構或第三方驗證機構；「合格投資人」只是示範身分，沒有做任何真實的身分審查。
- 部位是合成 CFD 曝險，**沒有**任何實體股票或黃金在背後。
- signal-api、前端、狀態清單主機都跑在本機（localhost），不是線上服務。

## 0. 位址與共用變數

| 名稱 | 位址 |
|---|---|
| 發證者 issuer（keystore `pepelab-rwa-issuer`） | `0xf67bA3C2F6E710415F548C09b73808ba19b9cD83` |
| 投資人 investor（keystore `pepelab-rwa-investor`） | `0xebAFE53877ad3B691664d8cb0b34874CE1240194` |
| 代理人 agent（keystore `pepelab-rwa-agent`） | `0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7` |
| keeper／marketOperator（keystore `pepelab-rwa-keeper`） | `0x5358cf4E0a1409F6B433Dd25Adf8c92bF0821ED8` |
| x402 收款 payto | `0xC7F9Bd7591601E68A1874Bfe69C0d5b75bc5eFBE` |
| PerpetualExchange | `0xbb7f8059ed5450889c745f5c1f458cb1290fa96b` |
| VCKycRegistry | `0x3869405c4641C72E5F01EaD9ced69139B4D830bD` |
| AgentSessionManager | `0xa60a1dC20E1CBb0cBc869464E35AEBa6ff3acbdd` |
| SessionCredentialAnchor | `0x80269C6FfEbce234d6b24979735D987C8e0e5fBD` |

CLI 步驟共用的殼層變數（repo 根目錄執行；只有位址與 keystore **名稱**，沒有任何秘密）：

```bash
export R=https://sepolia.base.org
export EX=0xbb7f8059ed5450889c745f5c1f458cb1290fa96b
export REG=0x3869405c4641C72E5F01EaD9ced69139B4D830bD
export MGR=0xa60a1dC20E1CBb0cBc869464E35AEBa6ff3acbdd
export ANCHOR=0x80269C6FfEbce234d6b24979735D987C8e0e5fBD
export ISSUER=0xf67bA3C2F6E710415F548C09b73808ba19b9cD83
export INV=0xebAFE53877ad3B691664d8cb0b34874CE1240194
export AGENT=0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7
export GOLD=0x12b611f69af3b5e84f9d2d8a8818b4ad7f2cf0b45274bc7c3b9616f67c7baa1a   # keccak256("sGOLD")
export AAPL=0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220   # keccak256("sAAPL")
export FEE=$(cast call $EX "executionFee()(uint256)" -r $R | cut -d' ' -f1)       # 目前 1e14 wei
acct() { echo "--account pepelab-rwa-$1 --password-file $HOME/.foundry/pepelab-rwa-$1.password"; }
```

規則：每一筆 `cast send` 之前先用同樣參數 `cast call --from <送出者>` 模擬；**預期會被拒**的交易，模擬看到 revert 原因後，
再以固定 `--gas-limit` 送出（跳過預估），讓「被拒」在 BaseScan 留下 status 0 的證據（與 S4 sETH 示範相同做法）。

## 1. 時段限制與標的選擇

keeper（`scripts/poc/rwa-poc-keeper.sh`）預設以 marketOperator 身分依行事曆切換資產模式（`agent/keeper/operator.ts`）：

| 資產 | keeper 何時切 ReduceOnly | 錄影時可開新倉的時段（UTC） | 台灣時間 |
|---|---|---|---|
| sAAPL 等美股／ETF | 正規盤以外，**且收盤前 3 小時就先收緊**（`DEFAULT_CLOSE_LEAD_SEC`，PoC 腳本不開放調整） | 夏令（到 2026-10-31）13:30–17:00；冬令（2026-11-01 起）14:30–18:00 | 夏令 21:30–01:00；冬令 22:30–02:00 |
| sGOLD（RWA、期貨行事曆） | 只在週末：週五 17:00 ET 起（提前 3 小時＝週五 14:00 ET 就收緊）到週日 18:00 ET | 週一到週五幾乎全天 | 週一早上約 06:00 起到週六凌晨約 02:00（夏令） |
| sETH、sBTC | 不切 | 全天 | 全天 |

注意：使用者給的「美股交易時段 UTC 13:30–20:00」是正規盤；keeper 提前 3 小時收緊，所以 **sAAPL 實際可開倉只到 UTC 17:00（夏令）**。
放寬（切回 Active）還要求報價年齡 ≤ 1 小時，開盤後第一輪 keeper 才會切回。

**建議：主線用 sGOLD，休市示範用 sAAPL。**

- sGOLD 已在部署時以 `additionalRwa` 標成 RWA（`rwaAsset(sGOLD) = true`，2026-10-07 讀回），一樣要合格投資人資格，台灣白天平日可錄。
  限制：sGOLD 碳分級是 3 級，**交易所槓桿上限 1 倍**（`maxLeverageForAsset(sGOLD) = 1`，讀回），所有 sGOLD 開倉都用 1 倍。
  前端已知限制：終端機資產列的鎖頭圖示只看靜態表，sGOLD **不顯示鎖頭**，但下單面板仍會擋（FRONTEND.md）。
- 台灣白天 sAAPL 本來就被 keeper 切成 ReduceOnly（2026-10-07 讀回 `assetMode(sAAPL) = 1`），第 8 景直接拿它示範「休市拒絕新開倉」，
  不必手動切，畫面上也能指出是 keeper 依行事曆切的那筆交易。
- 若一定要用 sAAPL 走主線：只能在上表 sAAPL 的時段錄（台灣深夜），或用 `--no-market-operator` 跑 keeper 再手動
  `rwa-poc-market-mode.sh sAAPL 0`，並在畫面上說明「示範用，手動開市」（RUNBOOK.md）。
- 不要在 sGOLD 上手動切 ReduceOnly 又讓 keeper 開著自動切換：平日行事曆是開市，keeper 下一輪（≤ 60 秒）就會把它放寬回 Active。

## 2. 撤銷狀態清單怎麼提供給前端與代理人

兩種憑證、兩份清單，**來源設定不同**：

| | 合格投資人 VC（`VCKycRegistry`） | 委託憑證 v3（`AgentSessionManager`／KYA） |
|---|---|---|
| 清單網址從哪來 | **寫在 VC 裡**：`credentialStatus.statusListCredential = <--status-base-url>/<發證者地址小寫>.json`（簽發時決定） | 前端用 `VITE_VC_STATUS_URL`；代理人寫入路徑與 signal-api 用 `VC_STATUS_URL` 或 `VC_STATUS_DIR` |
| `VITE_VC_STATUS_URL` 有沒有影響 | **沒有**。`/credentials` 只照 VC 裡的網址抓，只接受 https 或 `http://localhost`／`127.0.0.1` | 有：`/sessions` 撤銷前要讀「目前已發佈的清單」 |
| 誰寫清單 | `npm run issuer -- revoke`（發證者 keystore 簽，寫到 `--dir`） | `/sessions` 用投資人錢包簽 → 下載 → 營運方 `npx tsx examples/vc-status.ts install` |
| 開倉閘門看哪一份 | **都不看**。交易所只看鏈上 `VCKycRegistry`（`revoke(credentialHash)` 是權威） | 鏈上 `revokeSession`、錨定是即時的；狀態清單是鏈下 KYA／寫入路徑的檢查 |

CLI 預設的 `--status-base-url` 是 `https://status.example.invalid/investor`，前端會判成「狀態清單網址不可用」（晶片顯示「撤銷狀態不明」，
不擋送出但畫面難看）。**做法：本機起一個開 CORS 的靜態伺服器，兩份清單放在同一個公開目錄底下。**

```bash
# 只放清單的公開目錄（agent/.state 已被 .gitignore 排除；不要直接公開整個 agent/.state，那裡還有發證紀錄與 policy 狀態）
mkdir -p agent/.state/public-status
(cd agent && npm run issuer -- init --dir .state/public-status/investor)           # 投資人 VC 清單目錄標記
(cd agent && npm run vc-status:init -- --dir .state/public-status/vc)             # 委託憑證清單目錄標記（ADR-016）

# 終端機 A：清單主機（只綁 127.0.0.1、開 CORS、不快取）
node scripts/poc/rwa-poc-status-server.mjs --mount investor=agent/.state/public-status/investor --mount vc=<S6 的 agent/.state/rwa-poc/vc-status>
#   不需外部套件；只綁 127.0.0.1、CORS *、Cache-Control: no-store、不列目錄、不轉址
#   投資人 VC 清單： http://localhost:8787/investor/<發證者地址小寫>.json （還沒撤銷前是 404 ＝「沒有發佈清單（沒有撤銷）」）
#   委託憑證清單：   http://localhost:8787/vc/<投資人地址小寫>.json
```

- 簽發投資人 VC 時帶 `--status-base-url http://localhost:8787/investor`，撤銷時 `--dir .state/public-status/investor`。
- 前端：`scripts/poc/rwa-poc-frontend.sh --status-url http://localhost:8787/vc`（寫成 `VITE_VC_STATUS_URL`）。
- 代理人／signal-api：`VC_STATUS_DIR=$PWD/agent/.state/public-status/vc`（或 `VC_STATUS_URL=http://localhost:8787/vc`），與前端讀同一份。
- 這是 PoC 的本機做法；正式環境的清單主機要是 https、由發證者營運。VC 裡的網址是本機位址，片中照實說。

## 3. 錄影前檢查清單

每次正式錄之前逐項打勾（數字是 2026-10-07 00:54 UTC 讀回的值，錄影當天重讀）：

- [ ] **時段**：sGOLD 主線在平日（見 §1）；確認 `cast call $EX "assetMode(bytes32)(uint8)" $GOLD -r $R` = 0、`$AAPL` = 1（台灣白天）。
- [ ] **keeper 在跑**：終端機 B `bash scripts/poc/rwa-poc-keeper.sh`（乾跑一輪 `failed=0` 後才進迴圈；每 60 秒一輪、heartbeat 240 秒）。
- [ ] **價格新鮮**：11 檔都在 5 分鐘內寫過（keeper log 的 `wrote=`），遠小於交易所 `maxPriceAge` 6 小時；`/oracle` 頁看更新時間。
- [ ] **清算寬限期已過**（部署後 30 分鐘；已過）。
- [ ] **各錢包 ETH**：`for a in $INV $AGENT $ISSUER 0x5358cf4E0a1409F6B433Dd25Adf8c92bF0821ED8; do echo $a $(cast balance $a -r $R --ether); done`
  - 投資人 ≥ 0.01（目前 0.0299）；代理人 ≥ 0.01（目前 0.03）；發證者 ≥ 0.002（目前 0.01，撤銷用）；keeper ≥ 0.02（目前 0.0999）。
- [ ] **投資人保證金**：`cast call $EX "freeMargin(address)(uint256)" $INV -r $R` ≥ 100e18（目前 199.92e18）。
- [ ] **代理人測試 USDC**（x402 用）：`cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" $AGENT -r $R`（2026-10-08 補拍後 19.98；`main` 憑證上限已用滿，重拍實付要先 `setup` 新憑證）。
- [ ] **乾淨起點**：`isVerified(INV)` = false、`nonces(INV)` 記下來（目前 0）、`nextSessionId()` 記下來（目前 2：#0、#1 已存在，見 §6）。
- [ ] **清單主機**（§2）在 8787 跑、`curl -i http://localhost:8787/investor/index.json` 有 `Access-Control-Allow-Origin`。
- [ ] **signal-api**：`http://localhost:4021`，`X402_KYA_MODE=on`（S6 負責；`curl -s localhost:4021/ | head`）。
- [ ] **前端**：`scripts/poc/rwa-poc-frontend.sh --status-url http://localhost:8787/vc` → `cd frontend && yarn dev --mode rwa-poc`；
  `/credentials` 顯示合格投資人憑證面板（不是舊的 submitKYC 表單）。
- [ ] **錄影工具**：`scripts/poc/video`（目前在 `feat/rwa-poc-video` 分支）`npm install`、`npx playwright install chromium`；
  正式錄要加 `--allow-tx`，否則交易一律被攔。先不加 `--allow-tx` 排練一次。
- [ ] **殼層乾淨**：`agent/` 的程式會自動讀 `agent/.env`（`@pepelab/shared/autoload-env`）。錄影用的終端機確認沒有 `AGENT_PRIVATE_KEY`、
  `ISSUER_PRIVATE_KEY`、`SUBMITTER_PRIVATE_KEY`；舊電腦的 `.env` 不要放進來。部署與錄影一律使用專用 keystore，不使用 repo 內任何 `.env` 金鑰。
- [ ] 畫面：瀏覽器縮放 100%、1920×1080、通知關閉、終端機字體放大、殼層提示字元不顯示家目錄路徑以外的資訊。

## 4. 分鏡

欄位說明：**操作者**＝哪一把錢包、經 UI 還是 CLI；**交易**＝實跑後回填；**備援**＝現場出錯時改播什麼。
BaseScan 連結格式：`https://sepolia.basescan.org/tx/<hash>`。

### 第 1 景　發證者簽發「合格投資人」VC（離線簽名，不上鏈）

- **操作者**：發證者，CLI（`agent/issuer/cli.ts`，加密 keystore `pepelab-rwa-issuer`）。
- **指令**：

  ```bash
  cd agent
  NONCE=$(cast call $REG "nonces(address)(uint256)" $INV -r $R | cut -d' ' -f1)   # 等於鏈上 nonces(投資人)
  mkdir -p .state/poc
  ISSUER_KEYSTORE=pepelab-rwa-issuer ISSUER_KEYSTORE_PASSWORD_FILE=$HOME/.foundry/pepelab-rwa-issuer.password \
    npm run issuer -- issue --subject $INV --registry $REG --chain-id 84532 --type QUALIFIED_INVESTOR \
      --nonce $NONCE --status-base-url http://localhost:8787/investor --out .state/poc/investor-qi-vc.json
  npm run issuer -- verify --vc .state/poc/investor-qi-vc.json --registry $REG --chain-id 84532 \
    --dir .state/public-status/investor --rpc $R
  ```
- **預期畫面**：`✓ 已簽發 QUALIFIED_INVESTOR VC → .state/poc/investor-qi-vc.json`，印出 `id`、`credentialHash`、到期日（預設 365 天）。
  `verify` 輸出 `signature.valid: true`、`issuer` = `0xf67b…cD83`、`status.ok: true`（還沒有清單）、
  `onchain.issuerTrusted: true`、`submitted: false`、`valid: false`。可以 `jq '.credentialSubject, .proof.attestation' .state/poc/investor-qi-vc.json` 給特寫：沒有姓名、證號。
- **旁白**：「發證者在鏈下完成審查後，用自己的金鑰簽一張合格投資人憑證。憑證裡只有錢包的去中心化識別碼和資格類型，沒有任何個人資料；這裡的發證者是我們自己的測試錢包，示範的是流程，不是真實審查。」
- **交易**：無（離線簽名）。彩排的 `credentialHash`：`0x9131f63e835be1a3ac0fc845ac8271c09c0e96fb9bfe057e109e2816ef8a10ba`。
- **備援**：排練時產出的同一張 VC 與 CLI 輸出截圖（nonce 未用掉前仍可送）；或預錄的終端機片段。

### 第 2 景　未持證開 sGOLD 被拒

> 必須在第 3 景（送出 VC）之前錄。

- **操作者**：投資人，UI `/terminal`（錄影工具注入的投資人錢包）；鏈上證據用 CLI（投資人 keystore）。
- **UI 操作**：`/terminal` → 選 sGOLD → 多單、保證金 20、槓桿 1 → 下單面板。
- **預期畫面**：下單面板出現「🔒 sGOLD 需 KYC…」與連結「用合格投資人憑證取得資格 →」，下單按鈕停用（前端預檢，交易不會送出）。
  終端機資產列 sGOLD 沒有鎖頭（已知限制）。
- **鏈上證據**（同一畫面切到終端機）：

  ```bash
  cast call --from $INV $EX "openPosition(bytes32,bool,uint256,uint256)" $GOLD true $(cast to-wei 20) 1 --value $FEE -r $R
  #   預期：execution reverted … NotKycVerified(0xebAF…0194)
  cast send $EX "openPosition(bytes32,bool,uint256,uint256)" $GOLD true $(cast to-wei 20) 1 --value $FEE \
    --gas-limit 600000 $(acct investor) -r $R
  #   預期：status 0 (failed)
  ```
- **旁白**：「sGOLD 是 RWA 市場，交易所開倉前會向 KYC 登錄確認這個錢包是否具備合格投資人資格。現在還沒有，所以前端擋下，直接送上鏈也會被合約拒絕。」
- **交易**：`NotKycVerified` 失敗交易（status 0）[`0x2b2e12b5…`](https://sepolia.basescan.org/tx/0x2b2e12b5f7c2eb6f8eacf5a03608fb7c3e8ed4cadff8af1bd9df0468fd087fb7)。
- **備援**：S4 的 sETH 失敗交易是同一種「固定 gas 留證據」做法，可以先播 `cast call` 的 revert 輸出；或預錄片段。

### 第 3 景　投資人在 `/credentials` 上傳 VC、本地驗證、送上鏈

- **操作者**：投資人，UI `/credentials`（側邊欄沒有入口，直接輸入網址）。
- **UI 操作**：「上傳 VC 檔案」選 `agent/.state/poc/investor-qi-vc.json`（錄影工具用 `setInputFiles`）→「本地驗證」→「送出資格證明上鏈」。
- **預期畫面**：
  - 上方警示：「你的錢包目前沒有有效的 RWA 市場資格（要求：合格投資人…）」。
  - 驗證後晶片：「簽章有效」「合格投資人」「未撤銷」「發證者受信任」；狀態文字「發證者沒有發佈狀態清單（沒有撤銷）」；持有人、發證者、有效期。
  - 送出後：「交易：0x…」，上鏈後警示變綠：「你的錢包已具 RWA 市場資格（要求：合格投資人）；憑證到期：…」。
- **讀回**：`cast call $REG "isVerified(address)(bool)" $INV -r $R` → `true`。
- **旁白**：「投資人把憑證帶到平台，瀏覽器先在本地驗證簽章、效期與撤銷狀態，再送到鏈上的登錄合約。合約自己再驗一次發證者簽章，鏈上只記地址、類型、到期日和憑證雜湊。」
- **交易**：`submitAttestation` [`0x95080cd3…`](https://sepolia.basescan.org/tx/0x95080cd3f85604bebc8fc17793da899d2975c9aa9b431b575ec31a22f258a4b7)。
- **備援**：UI 送出失敗時改用 CLI（投資人 keystore 送同一份簽章）：

  ```bash
  cd agent
  DATA=$(npx tsx -e 'import fs from "node:fs";import {verifyInvestorCredential,buildSubmitTx} from "./issuer/investorVc.ts";const v=verifyInvestorCredential(JSON.parse(fs.readFileSync(process.argv.at(-1),"utf8")),{});if(!v.valid)throw new Error(v.reason);console.log(buildSubmitTx(v.domain.verifyingContract,v).data)' .state/poc/investor-qi-vc.json)
  cast call --from $INV $REG $DATA -r $R && cast send $REG $DATA $(acct investor) -r $R
  ```

### 第 4 景　持證後開 sGOLD 成功

- **操作者**：投資人，UI `/terminal`。
- **UI 操作**：重新整理 → sGOLD 多單、保證金 20、槓桿 1 → 下單 → 錢包確認（注入錢包自動簽）。
- **預期畫面**：KYC 提示消失、按鈕可按；送出後持倉表出現 sGOLD 多單（記下部位編號）；`/portfolio` 可用保證金減少約 20。
- **旁白**：「同一個錢包、同一筆單，資格登記上鏈之後就能開倉。交易所合約沒有改，只是換上一顆用可驗證憑證准入的 KYC 登錄。」
- **交易**：開倉 [`0xac0f19bb…`](https://sepolia.basescan.org/tx/0xac0f19bb55d9dbbf28daff39b80d1026f24c2d8ce6eb51bd59f692b0de3f0860)；部位 #8。
- **備援**：`cast send $EX "openPosition(bytes32,bool,uint256,uint256)" $GOLD true $(cast to-wei 20) 1 --value $FEE $(acct investor) -r $R`（先 `cast call --from $INV` 模擬）。

### 第 5 景　投資人為代理人建 session、簽發委託 VC v3、錨定

- **操作者**：投資人，UI `/sessions`。
- **UI 操作**：
  1. 先記下 `cast call $MGR "nextSessionId()(uint256)" -r $R`（新 session 的編號）。
  2. 「建立 Session」：Agent 地址 `0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7`（**不要**按「產生 agent 金鑰」）、單筆上限 30、總預算 60、
     最大槓桿 1（sGOLD 上限就是 1 倍）、有效期限 24 小時、允許標的只勾 sGOLD →「建立 Session」。
  3. 自動開啟「委託授權憑證 v3」：x402 每期間上限 0.02、期間 1 小時、總額上限 0.03（S6 的金額待定）、允許端點保留預設 →「以錢包簽發 v3」（EIP-712 簽名，不是交易）。
  4. 「錨定到鏈上」→ 狀態變「已錨定」。
  5. 下載憑證 JSON（給第 6、7 景的代理人用），存成 `agent/.state/poc/delegation-v3.json`。
- **預期畫面**：「Session 已建立 ✓」；我的 Session 表多一列（花費 0 / 60、單筆 30、槓桿 1、到期）；v3 視窗顯示代理人 DID、簽發者 DID、
  與鏈上逐欄一致的額度、credentialHash、「已錨定」。
- **讀回**：`cast call $ANCHOR "currentCredential(uint256)(bytes32)" <sessionId> -r $R` 等於畫面上的 credentialHash。
- **旁白**：「投資人不把主錢包交給 AI。他在鏈上開一個有上限的 session，再把同樣的上限和付費額度簽成一張委託憑證，並把憑證雜湊錨定在鏈上。之後任何服務都能查到：是誰、授權了哪個代理人、授權到哪裡。」
- **交易**：`createSessionWithAssets` [`0xe53319fe…`](https://sepolia.basescan.org/tx/0xe53319fe9df64190cf9697d4542470c154d1e8a6ebf87a4e1f6566def1adae6a)；`anchor` [`0xa7e9c1c6…`](https://sepolia.basescan.org/tx/0xa7e9c1c6ee3ca8e2a8985f192996e21a8fdd83fe810bb68271d68fed5c2567ae)；session #6；委託憑證 credentialHash `0xd3ce4c6bdf187d8bcf36a12b23fd5b240487326424212446ba077cc95cbb5864`。
- **備援**：建 session 可用 CLI（投資人 keystore；到期時間要與 v3 憑證一致，所以之後仍要在 `/sessions` 對這個 session 簽發 v3）：

  ```bash
  EXP=$(( $(date +%s) + 86400 ))
  cast send $MGR "createSessionWithAssets(address,uint256,uint256,uint256,uint256,bytes32[])" \
    $AGENT $(cast to-wei 30) $(cast to-wei 60) 1 $EXP "[$GOLD]" $(acct investor) -r $R
  ```
  簽發 v3 只能用投資人錢包簽 EIP-712（錄影工具的注入錢包、或 SDK `createDelegationCredential`）；錨定可用
  `cast send $ANCHOR "anchor(uint256,bytes32)" $SID <credentialHash> $(acct investor) -r $R`。

### 第 6 景　代理人出示 VP、付 x402 取得訊號

- **操作者**：代理人，CLI（付款客戶端＋`kyaFetch`），細節見 [`X402_KYA.md`](X402_KYA.md)。
- **流程**：
  1. signal-api（終端機 C）：`bash scripts/poc/rwa-poc-x402.sh server`（port 4021；`X402_KYA_MODE=on`、錨定 required、
     真 facilitator `x402.org`、`PAY_TO`＝收款錢包 `0xC7F9…eFBE`；session manager 與錨定合約位址從部署紀錄讀，不手打）。
  2. 不帶 VP 付費：`rwa-poc-x402.sh call main novp` → 403 `kya_presentation_required`（付款不送出）。
  3. 帶 VP 實付：`rwa-poc-x402.sh pay` → 每次 0.01 測試 USDC，回應標頭 `X-Agent-KYA-Spend: total=…`，印出結算 tx；
     呼叫到累計超過憑證上限 0.02 為止 → 403 `kya_spend_limit_exceeded`（不送結算、不扣款）。
- **預期畫面**：終端機的狀態碼、原因代碼、`X-PAYMENT-RESPONSE` 的結算 tx 與 BaseScan 連結、代理人 USDC 餘額 20 → 19.98。
- **旁白**：「代理人買訊號時，除了付款，還要出示由自己簽名的憑證呈現。賣方在收錢之前確認：付款人就是被授權的代理人、授權還有效、鏈上 session 和錨定都對得上、而且沒有超過投資人給的付費上限。」
- **交易**（2026-10-08 補拍，Base Sepolia 真 USDC）：
  [`0x2b9fa83c…`](https://sepolia.basescan.org/tx/0x2b9fa83cccf278fa6fa7d70314eca68461a84304b3ad19798da91fe4d9283911)、
  [`0xba9d7d2e…`](https://sepolia.basescan.org/tx/0xba9d7d2ea945d0ef24ba2cd0fe13da6fad796888bf8e416c4eedf158a43e7d27)（皆 status 1）。
  中間有一次 facilitator 回 402、沒有扣款，KYA 花費帳也退回，片中字幕照實說明；超額被拒是同一個 server 行程的續段。
  入金前的彩排（2026-10-07）：不帶 VP → 403；`lowcap` 帶 VP → 403 `kya_spend_limit_exceeded`；`main` 帶 VP → KYA 通過、facilitator 回 402 餘額不足。
- **備援**：`bash scripts/poc/agent-delegation-demo.sh`（本機 anvil、模擬 facilitator，13 項已在 2026-10-06 實測）的錄影，明確標示是本機模擬。

### 第 7 景　代理人在 session 上限內下單、超額被拒

- **操作者**：代理人，CLI（`cast`＋代理人 keystore；說明見 §6 第 4 點）。
- **指令**（`SID` 換成第 5 景的 sessionId）：

  ```bash
  SID=<第 5 景的 sessionId>
  # 額度內：保證金 20（單筆上限 30、總預算 60）
  cast call --from $AGENT $MGR "openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)" \
    $SID $GOLD true $(cast to-wei 20) 1 0x0000000000000000000000000000000000000000 --value $FEE -r $R
  cast send $MGR "openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)" \
    $SID $GOLD true $(cast to-wei 20) 1 0x0000000000000000000000000000000000000000 --value $FEE $(acct agent) -r $R
  # 超額：保證金 50 > 單筆上限 30
  cast call --from $AGENT $MGR "openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)" \
    $SID $GOLD true $(cast to-wei 50) 1 0x0000000000000000000000000000000000000000 --value $FEE -r $R
  #   預期：MarginExceedsPerTradeCap()
  cast send $MGR "openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)" \
    $SID $GOLD true $(cast to-wei 50) 1 0x0000000000000000000000000000000000000000 --value $FEE --gas-limit 600000 $(acct agent) -r $R
  #   預期：status 0
  ```
  （也可再示範 sAAPL → `AssetNotAllowed`：不在 session 白名單。）
- **預期畫面**：第一筆成功，`/sessions` 花費變 20 / 60；投資人的 `/portfolio` 多一筆 sGOLD 部位（部位擁有者是投資人，不是代理人）。第二筆模擬回 `MarginExceedsPerTradeCap`，送出後 status 0。
- **旁白**：「代理人用自己的 session 金鑰下單，部位記在投資人名下；合約檢查每筆和總額的上限。超過上限的單，不管代理人怎麼送，合約都會拒絕。」
- **交易**：額度內開倉 [`0xfb041d2d…`](https://sepolia.basescan.org/tx/0xfb041d2d701c23aa6d07da11119c10477d3d082ae5ac603d5e4ac49f7b0b4799)（部位 #9）；超額只保留模擬的 revert `MarginExceedsPerTradeCap()`，沒有送出。
- **備援**：預錄的終端機片段；或 `agent-delegation-demo.sh` 第 9 步（本機）。

### 第 8 景　休市：ReduceOnly 拒絕新開倉

- **操作者**：keeper（自動）＋投資人（UI `/terminal`、CLI 證據）。
- **前提**：台灣白天錄，sAAPL 已被 keeper 依行事曆切成 ReduceOnly（`assetMode(sAAPL) = 1`）。
- **UI 操作**：`/rwa` 的 sAAPL 卡片顯示「只能減倉（鏈上模式）」；`/terminal` 選 sAAPL，市場狀態徽章「只能減倉」→ 嘗試開多單 10、1 倍。
- **鏈上證據**：

  ```bash
  cast call --from $INV $EX "openPosition(bytes32,bool,uint256,uint256)" $AAPL true $(cast to-wei 10) 1 --value $FEE -r $R
  #   預期：AssetNotActive(sAAPL, 1)
  cast send $EX "openPosition(bytes32,bool,uint256,uint256)" $AAPL true $(cast to-wei 10) 1 --value $FEE --gas-limit 600000 $(acct investor) -r $R
  ```
  畫面指出 keeper 切換那筆交易（keeper log 的 `setAssetMode`，或 DEPLOYMENT.md 的 S4 紀錄）。
- **預期畫面**：UI 送出時錢包預估失敗並顯示錯誤（或按鈕不可按，以實跑為準）；`cast call` 回 `AssetNotActive`。
- **旁白**：「美股休市時，keeper 依交易所行事曆把股票類資產切成只能減倉。這時不能開新倉，但既有部位隨時可以平倉，投資人不會被鎖在部位裡。」
- **交易**：keeper 切換引用 S4 的 [`0x1f35edef…`](https://sepolia.basescan.org/tx/0x1f35edefa4d0602a0b9a8c32ffb06742ecab97322d4c9eed042be95b3b1fa6c8)（彩排時 sAAPL 已是 ReduceOnly）；開倉失敗（status 0）[`0x2e14a086…`](https://sepolia.basescan.org/tx/0x2e14a086864650e7355f27eda72844b72c0420f26a9d046bec13a98d243e4bca)。前端送出後顯示「這個標的目前休市或暫停…不能開新倉；既有部位可以平倉」。
- **備援**：S4 的 sETH 休市示範（開倉被拒 `0xd71ccda6…`、平倉成功 `0x1b8457e6…`）截圖。
- **若在美股時段錄**：keeper 用 `--no-market-operator` 跑，`bash scripts/poc/rwa-poc-market-mode.sh sAAPL 1` 手動切（keeper 錢包），示範完 `sAAPL 0` 切回，並在旁白說明是手動切。

### 第 9 景　撤銷資格：投資人與代理人都被拒，既有部位可平倉

- **操作者**：發證者（CLI）→ 投資人（UI）→ 代理人（CLI）→ 投資人（UI 平倉）。
- **9a 發證者撤銷**：

  ```bash
  cd agent
  ISSUER_KEYSTORE=pepelab-rwa-issuer ISSUER_KEYSTORE_PASSWORD_FILE=$HOME/.foundry/pepelab-rwa-issuer.password \
    npm run issuer -- revoke --vc .state/poc/investor-qi-vc.json --registry $REG --chain-id 84532 --dir .state/public-status/investor
  #   印出：狀態清單 sequence 1 → .state/public-status/investor/<issuer>.json，以及 {to, data}
  HASH=$(jq -r .proof.attestation.credentialHash .state/poc/investor-qi-vc.json)
  cast call --from $ISSUER $REG "revoke(bytes32)" $HASH -r $R && cast send $REG "revoke(bytes32)" $HASH $(acct issuer) -r $R
  cast call $REG "isVerified(address)(bool)" $INV -r $R     # → false
  ```
  （`revoke` 子指令刻意只印交易資料、不對公開鏈送交易；鏈上撤銷由發證者 keystore 以 `cast send` 送。）
- **9b 投資人被拒**：`/credentials` 重新「本地驗證」→ 晶片「已撤銷」、文字「發證者已撤銷這張憑證（清單 sequence 1）」；上方警示回到「沒有有效的 RWA 市場資格」。
  `/terminal` sGOLD 下單又出現 KYC 提示。鏈上證據同第 2 景（`NotKycVerified`）。
- **9c 代理人也被拒**：代理人的 session 還有效、也在額度內，但交易所檢查的是 session 的使用者（投資人）：

  ```bash
  cast call --from $AGENT $MGR "openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)" \
    $SID $GOLD true $(cast to-wei 10) 1 0x0000000000000000000000000000000000000000 --value $FEE -r $R
  #   預期：NotKycVerified(0xebAF…0194)
  ```
  需要鏈上證據時同樣以 `--gas-limit 600000` 送出。
- **9d 既有部位可平倉**：投資人在 `/portfolio`（或終端機持倉表）平掉第 4 景的 sGOLD 部位 → 成功；代理人平掉第 7 景的部位：

  ```bash
  cast send $MGR "closePositionForSession(uint256,uint256)" $SID <第 7 景部位編號> $(acct agent) -r $R
  ```
- **9e（選用）收回委託**：投資人在 `/sessions` 按「撤銷」（`revokeSession`，一筆交易）→ `isAnchored` 立即變 false，代理人再下單回 `SessionIsRevoked`、
  付費 API 回 403。v3 憑證的狀態清單撤銷要再走「簽清單 → 下載 → `SESSION_MANAGER_ADDRESS=$MGR npx tsx examples/vc-status.ts install --list <檔> --dir .state/public-status/vc` → 確認已發佈」，片中可略。
- **預期畫面**：撤銷交易成功；投資人與代理人的開倉都回 `NotKycVerified`；兩筆平倉成功，`/portfolio` 部位清空、保證金回到可用。
- **旁白**：「發證者撤銷資格後，交易所對這個投資人的新開倉一律拒絕，連他授權的代理人也一樣，因為代理人是代表他下單。撤銷只擋開新倉，既有部位照常可以平倉。」
- **交易**：鏈上 `revoke` [`0xe778adf8…`](https://sepolia.basescan.org/tx/0xe778adf8400abca775494fd7c93a89ebcc0ce47b6ad8bbec1e38af2f1aad6854)（狀態清單 sequence 4：彩排累積的撤銷都在同一份清單）；投資人與代理人開倉只保留模擬的 `NotKycVerified`；代理人平倉 #9 [`0x2f40295e…`](https://sepolia.basescan.org/tx/0x2f40295e09eff3b475e493f98f3b7ff8d47c3874c8ea082f35000bb9cc30bf07)；投資人平倉 #8 [`0x2d0f620c…`](https://sepolia.basescan.org/tx/0x2d0f620c904a8c7590dac301369a9489a8ccdf762fe1a857d9e3a6ff48089f0e)。9e（收回委託）片中略過。
- **備援**：`bash scripts/poc/rwa-ssi-demo.sh`（本機 anvil，步驟 6–8 是同樣的撤銷→被拒→平倉）的錄影，標示為本機。

### 第 10 景　揭露頁：`/rwa`、`/oracle`、`/solvency`

- **操作者**：任何人（UI，唯讀；投資人錢包連著即可）。
- **UI 操作與預期畫面**：
  - `/rwa`：11 檔資產卡；sGOLD 標示鏈上 RWA；碳分級（attestor 寫入）；sAAPL 等美股顯示「只能減倉」（台灣白天）。
  - `/oracle`：鏈上價格與更新時間（keeper 寫入）；鏈下參考價需要 signal-api `/reference-prices`（S6 的 signal-api 要在跑）。
  - `/solvency`：保險金庫（部署時種子 1.00 USDC）、金庫儲備、ADL 開啟。數字很小，照實講是測試網種子資金。
- **旁白**：「最後是揭露：每檔資產的類別、碳分級和見證者、目前的交易模式；鏈上價格和參考價的差距；保險金庫和儲備。這些都直接從鏈上讀，不是我們另外整理的報表。碳分級的見證者是我們自己，保險金也只是測試用的種子資金。」
- **交易**：無。
- **備援**：S5 驗收時的截圖（`scripts/poc/video/out/s5-*.png`，在 `feat/rwa-poc-video` 分支的工作目錄）。

## 5. 與交接文件故事線的對照

`docs/HANDOFF_RWA_POC.md` §2 第 8 步的順序 → 本劇本的景：

| 故事線 | 景 | 調整 |
|---|---|---|
| 發證者簽發合格投資人 VC | 1 | — |
| 投資人提交、鏈上驗證 | 3 | — |
| 開 sAAPL 部位（未持證先示範被拒） | 2、4 | 「被拒」必須在提交之前，所以拆成第 2 景與第 4 景；標的改 sGOLD（§1） |
| 簽發委託 VC v3 並錨定 | 5 | — |
| 代理人出示 VP 付 x402 取得訊號 | 6 | 占位，等 S6 |
| 代理人在 session 上限內下單、超額被拒 | 7 | 用 `cast`＋代理人 keystore（§6） |
| 休市 ReduceOnly 拒絕新開倉 | 8 | 用 keeper 已切好的 sAAPL |
| 撤銷後代理人與投資人都被拒、既有部位可平倉 | 9 | 撤銷的是合格投資人 VC；收回委託是選用的 9e |
| `/rwa`、`/oracle`、`/solvency` | 10 | — |

## 6. 已決定的事（2026-10-07）

1. 代理人下單用 `cast`＋代理人 keystore 直接呼叫 session manager（示範鏈上上限）；鏈下 VC 閘門由 x402 KYA 那段示範，不另開 `AGENT_KEYSTORE`。
2. x402 用 S6 的 `scripts/poc/rwa-poc-x402.sh`（`call`／`balance`），session 是 S6 建的 #0（`main`，上限 0.02）與 #1（`lowcap`，上限 0.005）；字幕照實說明。代理人 USDC 入金前只拍「不帶 VP 被拒＋超額被拒＋KYA 通過但餘額不足」。
3. 代理人下單那景用第 5 景新開的 session。
4. 狀態清單主機改用 `scripts/poc/rwa-poc-status-server.mjs`（不需外部套件）。
5. 終端機文案已修：VC 准入部署下顯示「是 RWA 市場，開倉需要有效的合格投資人資格」，不再叫人去 Exchange 頁。
6. ReduceOnly 的 UI：下單按鈕**沒有**停用；按下後先出現休市確認視窗，確認送出時錢包預估就失敗，前端顯示休市訊息，不會送出交易。
7. 鏈上 status 0 證據只留第 2 景與第 8 景；其他被拒只保留模擬的 revert。

### 重跑

`bash scripts/poc/rwa-poc-rehearsal-reset.sh` 把投資人恢復成「沒有資格、沒有部位」並撤銷彩排建的 session（#0、#1 保留），之後：

```bash
cd scripts/poc/video && node record.mjs --scenes scenes/rwa-poc-full.mjs --base http://localhost:4173 --allow-tx
```

前端用錄影專用的 worktree 起在 4173（`yarn dev --mode rwa-poc --port 4173`；signal-api 的 CORS 白名單含 4173），
`scripts/poc/rwa-poc-frontend.sh --status-url http://localhost:8787/vc` 產生設定。同一個 `out/` 同時只能有一個錄影行程。

## 7. 後製與補拍流程

### 後製（成片）

```bash
cd scripts/poc/video
node postprocess.mjs --main out/<完整版>.json --frames     # → out/PepeLab-RWA-SSI-PoC-final.mp4＋out/keyframe-*.png
```

- 片頭卡 6 秒（定位、Base Sepolia 84532、錄製日期、「測試網研究原型，非真實金融商品」）、片尾卡 10 秒（10 景摘要、各景交易的 BaseScan 短連結、repo 與文件路徑）。
- 錄影時 `record.mjs` 在 JSON 的 `waits` 記下每段「等待區塊確認／節點同步／頁面載入／指令執行／付費 API 回應」。
  後製把這些區段依長度加速（≤ 8 秒 ×4、≤ 20 秒 ×6、更長 ×8；短於 2.5 秒不動），右上角疊「⏩ <原因>（加速 ×N）」；
  其餘畫面（字幕、結果、tx）原速保留，不剪任何片段。
- 字幕在畫面底部置中，不蓋頁首的錢包地址與網路徽章。

### 補拍第 6 景（2026-10-08 已完成）

只重錄 x402 這一段，再插回成片。2026-10-08 實際用的指令：

```bash
bash scripts/poc/rwa-poc-x402.sh balance          # 代理人 USDC ≥ 0.02（atomic 20000）
# signal-api 的 KYA 花費帳是 memory：補拍前全新啟動 server，讓 main 那張憑證從 0 開始計（rwa-poc-x402.sh server）
cd scripts/poc/video
node record.mjs --scenes scenes/rwa-poc-scene6-pay.mjs --base http://localhost:4173 --no-sign        # 不帶 VP 被拒＋pay 實付
node record.mjs --scenes scenes/rwa-poc-scene6-overlimit.mjs --base http://localhost:4173 --no-sign  # 同一個 server 行程：超額被拒
node postprocess.mjs --main out/rwa-poc-full-2026-10-07T03-01-02.json \
  --replace-scene 6=out/rwa-poc-scene6-pay-2026-10-08T12-31-54.json+out/rwa-poc-scene6-overlimit-2026-10-08T12-33-29.json \
  --resume-at 268.3 --frames
```

- `--replace-scene 6=a.json+b.json` 把主影片裡字幕以「第 6 景」開頭的那幾步整段換成補拍，多段依序串接，其餘不動。
  片尾卡的第 6 景摘要改成「實付成功、累計超額被拒」，並列出結算交易。
- `--resume-at`：接回主影片時從哪一秒開始。第 7 景開頭約 2.7 秒，終端機還停在被換掉的舊第 6 景（餘額 0、402），所以從終端機清畫面那一刻（268.3 秒）接回。
  新版 `record.mjs` 會把清畫面時間記在 JSON 的 `termClearsMs`，之後的錄影由後製自動找，不用手動指定。
- 這一段只有 CLI（終端機分頁），不需要前端送交易；`--no-sign` 讓注入錢包拒絕任何簽章。結算交易 hash 由 `rwa-poc-x402.sh` 印成 `tx 0x…`，會自動記進 JSON。
- 後製輸出 `out/PepeLab-RWA-SSI-PoC-final.mp4`（7 分 41 秒，不進版控），交付時另存為 `PepeLab-RWA-SSI-PoC-final-2026-10-08.mp4`。
- **`main` 的上限已在鏈上用滿**：帶 VP 的呼叫（`pay`、`call main vp`、兩支第 6 景劇本）會被本機已付帳 `agent/.state/rwa-poc/x402/main.spent.json` 擋下、不送出。
  要重拍請先 `rwa-poc-x402.sh setup main2 20000 20000`，再以 `POC_X402_LABEL=main2 node record.mjs --scenes scenes/rwa-poc-scene6-pay.mjs …` 錄；現在 `pay` 會自己付到超額被拒，不需要續段。

## 8. 實跑紀錄（2026-10-07 03:01 UTC 完整錄影＋2026-10-08 12:31 UTC 第 6 景補拍，1920×1080）

| 景 | 結果 | 交易 |
|---|---|---|
| 1 發證 | VC 簽發，nonce 0，驗證：簽章有效、發證者受信任、未登記 | — |
| 2 未持證 | 前端停用按鈕並提示；鏈上 `NotKycVerified` | [`0x2b2e12b5…`](https://sepolia.basescan.org/tx/0x2b2e12b5f7c2eb6f8eacf5a03608fb7c3e8ed4cadff8af1bd9df0468fd087fb7)（status 0） |
| 3 提交 | 晶片「簽章有效／合格投資人／未撤銷／發證者受信任」，上鏈後顯示已具資格 | [`0x95080cd3…`](https://sepolia.basescan.org/tx/0x95080cd3f85604bebc8fc17793da899d2975c9aa9b431b575ec31a22f258a4b7) |
| 4 開倉 | sGOLD 多單 20、1 倍，部位 #8 | [`0xac0f19bb…`](https://sepolia.basescan.org/tx/0xac0f19bb55d9dbbf28daff39b80d1026f24c2d8ce6eb51bd59f692b0de3f0860) |
| 5 委託 | session #6（30／60／1 倍／24 小時／sGOLD），v3 簽發、錨定 | [`0xe53319fe…`](https://sepolia.basescan.org/tx/0xe53319fe9df64190cf9697d4542470c154d1e8a6ebf87a4e1f6566def1adae6a)、[`0xa7e9c1c6…`](https://sepolia.basescan.org/tx/0xa7e9c1c6ee3ca8e2a8985f192996e21a8fdd83fe810bb68271d68fed5c2567ae) |
| 6 x402（2026-10-08 補拍） | 不帶 VP 403 `kya_presentation_required`；帶 VP 實付兩筆各 0.01（中間一次 facilitator 402、未扣款）；累計超額 403 `kya_spend_limit_exceeded` | [`0x2b9fa83c…`](https://sepolia.basescan.org/tx/0x2b9fa83cccf278fa6fa7d70314eca68461a84304b3ad19798da91fe4d9283911)、[`0xba9d7d2e…`](https://sepolia.basescan.org/tx/0xba9d7d2ea945d0ef24ba2cd0fe13da6fad796888bf8e416c4eedf158a43e7d27) |
| 7 代理人 | 15 成功（部位 #9）；50 模擬 `MarginExceedsPerTradeCap()` | [`0xfb041d2d…`](https://sepolia.basescan.org/tx/0xfb041d2d701c23aa6d07da11119c10477d3d082ae5ac603d5e4ac49f7b0b4799) |
| 8 休市 | sAAPL `assetMode = 1`；前端顯示休市訊息；鏈上 `AssetNotActive(sAAPL, 1)` | [`0x2e14a086…`](https://sepolia.basescan.org/tx/0x2e14a086864650e7355f27eda72844b72c0420f26a9d046bec13a98d243e4bca)（status 0） |
| 9 撤銷 | 清單 sequence 4＋鏈上 revoke；前端「已撤銷」；投資人與代理人模擬 `NotKycVerified`；兩筆平倉成功 | [`0xe778adf8…`](https://sepolia.basescan.org/tx/0xe778adf8400abca775494fd7c93a89ebcc0ce47b6ad8bbec1e38af2f1aad6854)、[`0x2f40295e…`](https://sepolia.basescan.org/tx/0x2f40295e09eff3b475e493f98f3b7ff8d47c3874c8ea082f35000bb9cc30bf07)、[`0x2d0f620c…`](https://sepolia.basescan.org/tx/0x2d0f620c904a8c7590dac301369a9489a8ccdf762fe1a857d9e3a6ff48089f0e) |
| 10 揭露 | `/rwa`、`/oracle`、`/solvency` 讀鏈正常 | — |

彩排之前另有幾次中斷的試跑（找出前端的節點同步問題），留下的鏈上交易都由 `rwa-poc-rehearsal-reset.sh` 收尾（撤銷資格、平倉、撤銷 session #2–#5）。
