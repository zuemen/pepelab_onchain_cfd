# PepeLab × Hyperledger Besu（QBFT）本地網路 — Phase 2

把 PepeLab 鏈上 CFD 協議完整部署到一條 **4 驗證者 QBFT 許可制私有鏈**，並附上機構行情源推價、
許可制 keeper、一鍵端到端檢查與「既有測試對 Besu fork 跑」的腳本。所有東西都只在本機跑，
不連任何公開鏈。

```
besu/
├── docker-compose.yml        4 個 QBFT 驗證者（hyperledger/besu:26.9.0），node1 開 RPC（只綁 127.0.0.1）
├── .env.example              可調參數範本（複製成 .env）
├── package.json              腳本依賴（viem 2.57.2，與 agent/ 同版）；npm 管理
├── scripts/
│   ├── gen-network.mjs       產生 genesis、節點金鑰、帳戶、白名單 → network/（gitignored）
│   ├── deploy.sh             沿用 contracts/script/Deploy.s.sol 部署 → deployments/<chainId>.json
│   ├── oracle-pusher.mjs     推價（GBM 隨機價／CSV 重播／一次性指定）
│   ├── keeper.mjs            許可制 keeper：資金費率結算 + 清算掃描
│   ├── e2e.sh / e2e.mjs      一鍵端到端：部署 → 推價 → 開倉 → 下跌 → 清算 → 讀回
│   ├── fork-test.sh          forge test --fork-url 對 Besu 跑完整既有測試
│   ├── lib.mjs               共用工具
│   └── lib.test.mjs          離線單元測試（npm test）
├── deployments/example.json  部署輸出格式範例（實際輸出 gitignored）
├── network/                  ← 本機產生，含私鑰，gitignored
├── .forge-broadcast/         ← forge 廣播紀錄，gitignored
└── logs/                     ← 執行紀錄，gitignored
```

---

## 1. 查證紀錄（2026-10-05 查詢）

| 項目 | 結論 | 來源 |
|---|---|---|
| Besu 目前穩定版 | **26.9.0**（2026-09-25 發布，非 prerelease；含安全修補，官方建議儘快升級） | GitHub Releases：<https://github.com/besu-eth/besu/releases/tag/26.9.0>（repo 已由 `hyperledger/besu` 移到 `besu-eth/besu`） |
| Docker 映像 | `hyperledger/besu:26.9.0`，digest `sha256:fc1813d67d630d7660eea6ee555c01e73bfecda3e54d24f9484c1c4a52c6fcb0` | Docker Hub tags API：<https://hub.docker.com/r/hyperledger/besu/tags> |
| 文件站 | `besu.hyperledger.org` 已 308 轉址到 `docs.besu-eth.org` | 實測 HTTP 回應 |
| QBFT genesis | `config.qbft` 內 `blockperiodseconds`（最短出塊秒數，預設 1）、`epochlength`（重置投票的區塊數，預設 30000）、`requesttimeoutseconds`（每輪逾時換輪，預設 1）；另有 `emptyblockperiodseconds`、`pertxgaslimit` 等選用欄位。`mixHash` 為 BFT 固定值；QBFT 至少 4 個驗證者才有拜占庭容錯 | <https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft> |
| extraData（RLP） | 格式 `RLP([32 bytes Vanity, List<Validators>, No Vote, Round=Int(0), 0 Seals])`。可用 `besu operator generate-blockchain-config`（一次產生 genesis＋節點金鑰）或 `besu rlp encode --type=QBFT_EXTRA_DATA`。本專案用前者 | 同上；教學 <https://docs.besu-eth.org/private-networks/tutorials/qbft> |
| 免費 gas | 每個節點 `--min-gas-price=0`（任一節點 >0 會默默丟掉 gas 價 0 的交易）；London 之後必須在 genesis 設 `"zeroBaseFee": true`（否則 baseFee 不為 0）；`contractSizeLimit` 可在 genesis 設定 | <https://docs.besu-eth.org/private-networks/how-to/configure/free-gas> |
| 硬分叉 milestone | genesis 支援 `berlinBlock`、`londonBlock`、`shanghaiTime`、`cancunTime`、`pragueTime`、`osakaTime`、`bpo1Time`…；私有網路建議指定最新 milestone 以取得最新 opcode | <https://docs.besu-eth.org/public-networks/reference/genesis-items> |
| 帳戶白名單 | `--permissions-accounts-config-file-enabled` + `permissions_config.toml` 的 `accounts-allowlist=[...]`；提交、P2P 接收、打包三處都檢查；仍為現行支援功能 | <https://docs.besu-eth.org/private-networks/how-to/use-local-permissioning> |

**EVM 版本對應**：`contracts/foundry.toml` 釘選 `solc_version = "0.8.36"`、未指定 `evm_version`，
`forge config` 顯示實際生效的是 **`osaka`**（solc 0.8.36 的預設）。Besu 26.9.0 支援 `osakaTime`，
所以 genesis 直接把 Berlin → London → Shanghai → Cancun → Prague → Osaka 全部設在創世啟用，
**不需要**為 Besu 另開 foundry profile，`foundry.toml` 完全沒動。

**合約大小**：genesis 刻意設 `contractSizeLimit: 24576`（與 EIP-170／主網／Base 相同），而不是
免費 gas 文件示範的最大值——這樣本地鏈會跟正式鏈一樣擋下超限合約，PerpetualExchange
（runtime 23,911 B）的大小門檻在 Besu 上仍有意義。

---

## 2. 從零到跑起來

### 前置需求

| 工具 | 版本（本專案實測） |
|---|---|
| Docker Desktop／Docker Engine + Compose v2 | Docker 28.0.4、Compose v2.34 |
| Node.js | ≥ 20（實測 v25.8.0） |
| Foundry（forge／cast） | 1.7.x |
| Bash | Windows 用 Git Bash；macOS／Linux 用內建 shell |

記憶體：4 個 Besu 節點預設各 `-Xmx320m`、容器硬上限 `768m`（實測閒置約 180 MB／節點）。via-IR 全量編譯
（`forge build`）另需數 GB。**Docker Desktop 的 VM 記憶體不足時整個 Docker 引擎會卡死**（見「常見錯誤」）。

### 步驟（Windows Git Bash 與 macOS／Linux 相同）

```bash
cd besu
npm ci                      # 安裝 viem（只裝在 besu/node_modules）
cp .env.example .env        # 可選：調整出塊間隔、埠號、記憶體
npm run gen                 # 產生 network/（genesis、4 把節點金鑰、5 個角色帳戶、白名單）
docker compose up -d        # 啟動 4 個驗證者
npm run e2e                 # 等出塊 → 部署 → 推價 → 開倉 → 下跌 → keeper 清算 → 讀回，成功 exit 0
```

個別工具：

```bash
npm run deploy                                  # 只部署（會重新部署一整套新合約）
npm run oracle                                  # 常駐推價：GBM，sBTC+sETH，每 5 秒
npm run oracle -- --interval 2 --assets sBTC --sigma 0.8 --seed 7
npm run oracle -- --replay my-prices.csv        # CSV：每行 symbol,price（例：sBTC,41500.25）
npm run oracle -- --set sBTC=41500              # 一次性指定價格
npm run keeper                                  # 常駐 keeper，每個新區塊一輪
npm run keeper -- --once --json                 # 只跑一輪，輸出 JSON
npm run fork-test                               # forge test --fork-url（很久，見第 5 節）
npm test                                        # 離線單元測試（不需節點）
```

Windows 注意事項：

- 一律在 **Git Bash** 執行 `bash scripts/*.sh`；`npm run` 也會用 Git Bash 以外的 shell 呼叫 `bash`，
  只要 `bash` 在 PATH 上即可。
- 在 Git Bash 手動執行 `docker run -v /x:/y …` 時，MSYS 會把 `/work/...` 這類參數改寫成
  `C:/Program Files/Git/work/...`。本專案的 `gen-network.mjs` 由 Node 直接呼叫 docker，不受影響；
  自己手動下指令請加 `MSYS_NO_PATHCONV=1`。

### 停止與清除

```bash
docker compose stop                 # 停止，保留鏈資料（下次 up 從原高度繼續）
docker compose down                 # 移除容器與網路，保留 volume（鏈資料仍在）
                                    # compose 專案名固定為 pepelab-besu，只影響本專案的容器／網路／volume
docker compose down -v              # 連 volume 一起刪：鏈資料歸零（要重產 genesis 時必做）
npm run gen -- --force              # 換一組全新的金鑰與 genesis（之後一定要 down -v）
```

---

## 3. 網路參數

| 參數 | 預設 | 在哪裡設定 | 改了要做什麼 |
|---|---|---|---|
| 映像檔 | `hyperledger/besu:26.9.0` | `BESU_IMAGE` | `docker compose up -d` |
| chainId | `1337` | `BESU_CHAIN_ID`（寫進 genesis） | `gen --force` + `down -v` |
| 出塊間隔 `blockperiodseconds` | `2` | `BESU_BLOCK_PERIOD`（寫進 genesis；Besu 沒有對應的 CLI 參數） | `gen --force` + `down -v` |
| 換輪逾時 `requesttimeoutseconds` | `2 × 出塊間隔` | `BESU_REQUEST_TIMEOUT`（必須大於出塊間隔） | 同上 |
| `epochlength` | `30000` | `BESU_EPOCH_LENGTH`（官方不建議在運行中的網路更改） | 同上 |
| 區塊 gasLimit | `1,000,000,000` | `BESU_GAS_LIMIT` | 同上 |
| 單筆交易 gas 上限 | 16,777,216（EIP-7825，Osaka 起生效；QBFT `pertxgaslimit` 未設定即沿用） | genesis `qbft.pertxgaslimit` | 同上 |
| 合約大小上限 | `24576`（EIP-170） | genesis `contractSizeLimit` | 同上 |
| baseFee | `0`（`zeroBaseFee: true`） | genesis | 同上 |
| 最低 gas 價 | `0`（每個節點 `--min-gas-price=0`） | compose | `up -d` |
| 帳戶白名單 | 5 個角色帳戶 | `network/node*/permissions_config.toml` | 改檔後重啟節點 |
| RPC | `127.0.0.1:8545`，API：ETH,NET,WEB3,QBFT,TXPOOL,PERM | `BESU_RPC_PORT` | `up -d` |
| 狀態儲存格式 | FOREST（完整歷史狀態，`--profile=ENTERPRISE` 的設定；實測節點日誌 `format=FOREST`） | compose | `down -v` 後重建 |
| 節點 IP | `10.233.66.11`–`.14`（static-nodes，discovery 關閉） | `BESU_SUBNET_PREFIX` | `gen --force` + `down -v` |
| JVM 記憶體 | `-Xms64m -Xmx320m`＋metaspace／code cache／direct memory 上限、SerialGC | `BESU_JAVA_OPTS` | `up -d` |
| 容器記憶體上限 | `768m`（超過只 OOM kill 該節點，restart 拉起） | `BESU_MEM_LIMIT` | `up -d` |

### 角色帳戶（`network/accounts.json`，本機產生、gitignored）

| 角色 | 權限 | 用途 |
|---|---|---|
| deployer | 所有合約的 owner（`MockOracle` 除外） | `deploy.sh`；e2e 裡 mint MockUSDC |
| oracle | `MockOracle` 的 owner（部署後用既有的 `transferOwnership` 轉入） | `oracle-pusher.mjs` 唯一能寫價的帳戶 |
| keeper | 無合約特權；在節點帳戶白名單內 | `keeper.mjs`：`settleFunding`、`liquidatePosition` |
| trader／lp | 一般使用者 | e2e 的交易者與保險庫 LP |

私鑰用 viem 的 `generatePrivateKey()`（CSPRNG）在本機產生；驗證者節點金鑰由 Besu 官方工具產生。
genesis 的 `alloc` 只放位址與餘額，不放 `privateKey`（官方教學範例會放，這裡刻意不放）。
`network/`、`deployments/*.json`、`.forge-broadcast/` 都在 `besu/.gitignore` 裡。

---

## 4. 推價與 keeper 的設計

### 推價（`oracle-pusher.mjs`）

- 寫價走 `MockOracle.updatePrice(bytes32,uint256)`（既有、`onlyOwner`）。啟動時先讀 `owner()`，
  簽名帳戶不是 owner 就拒絕啟動。
- 行情來源：
  - **GBM**：`S' = S·exp((μ−σ²/2)Δt + σ√Δt·Z)`，Δt = 推價間隔；PRNG 為 mulberry32，**種子固定 → 每次重跑同一串價格**。
  - **CSV 重播**：`symbol,price` 一行一筆，依序每 tick 推一行。
  - **一次性**：`--set sBTC=41500`。
- 同一個 tick 的多筆 `updatePrice` 用連號 nonce 一起送、一起等收據，通常落在同一區塊。

### keeper（`keeper.mjs`）

**資金費率的實際外部入口不是 `_pokeFunding`。** `_pokeFunding(bytes32)` 是 `PerpetualExchange`
的 `internal` 函式；外部能呼叫、且會走到它的是：

| 外部函式 | 何時呼叫 `_pokeFunding` |
|---|---|
| `settleFunding(bytes32 asset)` | 公開的 crank，**任何人可呼叫**，但 `block.timestamp < lastFundingUpdateAt + FUNDING_INTERVAL` 時 revert `FundingIntervalNotElapsed` |
| `openPosition`／`closePosition`／`liquidatePosition`… | 開倉、平倉、清算前一律先結算資金費率 |
| `setAssetMode`（進入 Halted 時） | 停市前結算到停市當下 |

`FUNDING_INTERVAL` 是合約常數 **8 小時**，所以「每個區塊觸發資金費率累積」做不到、也不需要：
keeper 每個區塊都**檢查**是否到期（讀 `lastFundingUpdateAt` 與 `FUNDING_INTERVAL`），到期才送
`settleFunding`；沒到期就記下距下次可結算的秒數，不送注定 revert 的交易。資金費率本身在
每次開倉／平倉／清算時都會被結算，不依賴 keeper。

**清算檢查**：合約沒有 `isLiquidatable` 之類的 view。keeper 用既有 view 組出與
`liquidatePosition` 完全相同的門檻：

```
getPositionValue(id)  ≤  margin × leverage × maintenanceMarginBpsForAsset(asset) / 10000
```

（`getPositionValue` 的算式與 `liquidatePosition` 的 `closeAmount` 相同：保證金 + 損益 − 手續費 − 資金費。）
符合者再用 `eth_call` 模擬 `liquidatePosition(id)`——健康部位會 revert `PositionIsHealthy`——
模擬通過才送交易。部位用 `nextPositionId` 游標增量掃描、維護未平倉集合。

**「許可制」落在網路層**：合約的 `settleFunding`／`liquidatePosition` 本來就是任何人可呼叫
（合約設計，沒有為此新增方法）。Besu 每個節點開帳戶白名單，只有 5 個角色帳戶能送交易；
keeper 啟動時呼叫 `perm_getAccountsAllowlist` 確認自己在名單內，不在就拒絕啟動。

---

## 5. 「既有合約測試在 Besu 上通過」——兩種驗證的差別

| | `npm run fork-test`（`forge test --fork-url`） | `npm run e2e`（端到端） |
|---|---|---|
| 誰執行 EVM | **forge 內建的 revm**（在你的電腦記憶體裡） | **Besu 節點**（4 個驗證者共識後上鏈） |
| Besu 扮演 | 唯讀的狀態來源：forge 透過 JSON-RPC 讀 chainId、區塊環境、code、storage、balance | 真正的執行與共識層 |
| 交易上鏈 | 否 | 是（有 tx hash、block、receipt） |
| 驗證的是 | 既有測試在 Besu 的鏈環境（chainId 1337、真實時間戳、gasLimit、baseFee 0）上仍成立 | 合約在 Besu 的 EVM（Osaka 規則、EIP-170、QBFT 出塊、免費 gas、帳戶白名單）上真的能部署與運作 |
| 涵蓋範圍 | 完整既有測試套件 | 部署全套 + 推價 + 開倉 + 清算主流程 |

換句話說：fork 測試全綠**不代表** Besu 的 EVM 執行結果與 forge 一致；那一半由端到端腳本負責。
`test/fork/*` 底下的測試自己判斷 `block.chainid != 84532` 就 `vm.skip`（它們是給 Base Sepolia 的），
所以在 Besu fork 上會顯示為 skipped。

fork-test.sh 把 fork 區塊釘在啟動當下（`--fork-block-number`），整個套件讀同一個狀態；node1 開了
FOREST 儲存（完整歷史狀態），套件跑再久也讀得到該區塊的狀態。

**省記憶體做法（本專案實測採用）**：fork 測試只需要 node1 提供唯讀狀態，可以先
`docker compose stop node2 node3 node4`。剩 1／4 個驗證者時 QBFT 會停止出塊（不到 2/3），
但 node1 仍正常回應 JSON-RPC，而 fork 區塊本來就是釘住的，對測試沒有影響。測完再 `docker compose start`。

---

## 6. 實測結果

### 端到端（`npm run e2e`，2026-10-05 本機實測，Windows 11 + Docker Desktop 28.0.4 + Besu 26.9.0）

部署：`Deploy.s.sol` 在 Besu 上 `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`，共 15 個合約（含 linked library
`ExchangeOpsLib`），PerpetualExchange 鏈上 runtime **23,911 bytes**（`contractSizeLimit` 24,576 內）。
接著 `MockOracle.transferOwnership` 給 oracle 帳戶。

| 步驟 | 結果 |
|---|---|
| 1 推價 | oracle 帳戶 GBM（seed 42）推 3 tick：sBTC 49,992.77 → 49,990.71 → 49,976.80；deployer 寫價被拒 ✔ |
| 2 保險庫 | LP 存入 20,000 USDC，`totalAssets` = 20,000.0000 |
| 3 開倉 | 部位 #0：sBTC 多單，保證金 1,000 × 5 倍，入場價 49,976.8037 |
| 4 keeper 第一輪 | 帳戶在白名單（5 個）✔；資金費率 `not-due`（距下次 28,794 秒）；部位價值 995.0000 > 維持保證金 250.0000，不清算 ✔ |
| 5 下跌 | sBTC 49,976.80 → 41,480.74（−17%），部位價值降為 144.9999 |
| 6 keeper 第二輪 | `liquidatePosition(0)` 成功，gas 248,933 ✔ |
| 7 讀回 | `isOpen=false`、`closeReasonOf=Liquidated` ✔；已實現損益 −850.0000 |
| | 保險庫 `totalAssets` 與 USDC 餘額 20,000.0000 → **20,028.9999（+28.9999，清算罰金 20%）** ✔ |
| | keeper 獎勵 +7.2499 USDC（5%）✔；trader 退回 +108.7499 ✔；sBTC 未平倉索引清空 ✔ |

數字對得上合約：剩餘價值 144.9999 × 5% = 7.2499（獎勵）、× 20% = 28.9999（進保險庫）、其餘 108.7499 退給交易者。
腳本 exit 0。


### fork 測試（`npm run fork-test`，同日實測，fork block 467，只留 node1）

```
Ran 105 test suites in 677.84s: 1232 tests passed, 1 failed, 4 skipped (1237 total tests)
```

- **4 skipped**：`test/fork/*` 的 `setUp`，條件是 `block.chainid != 84532`（這些測試只給 Base Sepolia fork 用），符合預期。
- **1 failed**：`test/Funding.t.sol:FundingTest.testSettleFunding_beforeInterval_revert`。
  這支測試預期「從沒碰過的資產」呼叫 `settleFunding` 會 revert `FundingIntervalNotElapsed`，
  前提是 forge 預設的 `block.timestamp = 1`（`1 < 0 + 8h`）。fork 到任何真實鏈時 `block.timestamp`
  是真實時間（約 1.79e9 秒），`last = 0` 時條件不成立，`settleFunding` 只會啟動資金費率時鐘、不 revert。
  這是**測試對時間起點的假設**，與 Besu 的 EVM 無關（fork 模式下 EVM 是 forge 執行的）；合約行為本身
  正是 `_pokeFunding` 註解寫的「第一次碰觸只啟動時鐘」。依任務規範沒有改測試或合約，留給後續決定是否把該測試
  改成先 `vm.warp(1)`。
- 不帶 `--fork-url` 時同一支測試照常通過：master 24b515b 的 contracts-ci（`forge test`，非 fork）為 success。


---

## 7. 常見錯誤

| 症狀 | 原因與處理 |
|---|---|
| `npm run gen` 回 `Output directory already exists`、但檔案其實產生了 | 直接用 `docker run hyperledger/besu:26.9.0 operator …` 時，映像檔的 `besu-entry.sh` 以 root 執行會先用 `--print-paths-and-exit` 把同一組參數跑一次，operator 子指令因此執行兩次。`gen-network.mjs` 已用 `--entrypoint /opt/besu/bin/besu` 繞開 |
| `network/ 已存在` | 防止誤蓋金鑰。要重產：`npm run gen -- --force` 後務必 `docker compose down -v`（舊鏈資料的 genesis 不同，節點會拒絕啟動） |
| 節點起來但 `eth_blockNumber` 一直是 0 | QBFT 需要超過 2/3 驗證者在線（4 個至少 3 個）。看 `docker compose logs node2`；常見是 `BESU_SUBNET_PREFIX` 與 static-nodes 的 IP 不一致（改了前綴要 `gen --force`） |
| `Pool overlaps with other one on this address space` | 網段衝突。在 `.env` 改 `BESU_SUBNET_PREFIX`，再 `gen --force` + `down -v` |
| Docker 指令全部回 `500 Internal Server Error … dockerDesktopLinuxEngine`、`127.0.0.1:8545` 逾時 | Docker Desktop 的 VM 卡死。本專案實測在主機實體記憶體只剩不到 1 GB（同時開著 Elasticsearch 等大型容器與 via-IR 編譯）時發生多次，`wsl -d docker-desktop` 也連不進去。處理：`docker desktop restart`（**注意：沒有 restart 政策的其他容器會因此停止，要自己 `docker start`**）；預防：關掉不用的容器、維持本 compose 的記憶體上限、fork 測試時只留 node1 |
| `deploy.sh` 回 `節點 chainId=31337` | 8545 被 anvil 佔走。關掉 anvil，或設 `BESU_RPC_PORT=8546` 並 `BESU_RPC_URL=http://127.0.0.1:8546` |
| 交易回 `Sender account not authorized to send transactions` | 帳戶不在白名單。只能用 `network/accounts.json` 的角色帳戶 |
| 交易一直 pending | 某個節點的最低 gas 價不是 0（compose 每個節點都有 `--min-gas-price=0`，自訂 compose 時別漏掉） |
| `forge test --fork-url` 中途 `world state not available` | 要讀的區塊歷史狀態已被修剪。本 compose 用 FOREST（不修剪）；若自行改成 BONSAI，需加大 `--bonsai-historical-block-limit` |
| e2e 的清算被 `StalePrice` 擋下 | 價格超過 `maxPriceAge`（24h）未更新；先跑一次推價 |
| `keeper` 啟動就說不在白名單 | node1 的 `--rpc-http-api` 要有 `PERM`，而且 keeper 帳戶要在 `network/node*/permissions_config.toml` 內 |

---

## 8. 與 Base Sepolia 部署的差異

| 面向 | Base Sepolia（`deploy-base-sepolia.sh`） | 本地 Besu（本目錄） |
|---|---|---|
| 鏈型態 | 公開 OP Stack L2 測試網，chainId 84532 | 4 驗證者 QBFT 許可制私有鏈，chainId 1337（可調） |
| 終局性 | L2 sequencer 確認，最終性依附 L1 | QBFT 即時終局（區塊一旦產生就不會重組） |
| 出塊 | 由 Base 決定 | `blockperiodseconds` 自訂（預設 2 秒） |
| gas | 需要測試 ETH 付 gas | 免費（`zeroBaseFee` + `min-gas-price=0`）；ETH 仍用於支付合約的 `executionFee` |
| 誰能送交易 | 任何人 | 只有帳戶白名單內的 5 個角色帳戶 |
| 部署腳本 | `Deploy.s.sol`（同一支） | `Deploy.s.sol`（同一支，只加 Besu 包裝） |
| 部署紀錄 | `contracts/broadcast/…/84532/`（入庫，作為正式紀錄） | `besu/.forge-broadcast/`（gitignored，不污染正式紀錄） |
| 位址來源 | `frontend/src/contracts/addresses.ts` | `besu/deployments/<chainId>.json`（gitignored；不寫前端） |
| 金鑰 | 部署者私鑰來自環境變數／GitHub environment secret | `network/accounts.json` 本機產生的開發金鑰 |
| 推價 | GitHub Actions keeper（`agent/keeper/run.ts`），keeper 金鑰本身是 MockOracle owner | `oracle-pusher.mjs`，獨立 oracle 帳戶為 owner；deployer 失去寫價權（e2e 會驗證） |
| 資金費率／清算 | `settleFunding` 由排程 keeper crank | `keeper.mjs` 每個區塊檢查；清算掃描 |
| Pyth 展示 adapter | 指向 Base Sepolia 上真的 Pyth 合約 | 同一個位址在本地鏈沒有程式碼——adapter 照樣部署，但本來就沒接到 exchange，不影響功能 |
| 區塊瀏覽器／驗證 | BaseScan | 無（可自行加 Blockscout） |
| EVM | 依 OP Stack 升級排程 | 創世即啟用到 Osaka，合約大小上限 24,576 B |
