---
status: proposed
---

# 鏈上監控用一個獨立、唯讀的 Cloudflare Worker，以 webhook 告警，不擴大任何 GitHub token 的權限

> 2026-10-01，P2-12。規則清單：[`ops/monitoring/rules.md`](../ops/monitoring/rules.md)；部署：[`ops/monitoring/README.md`](../ops/monitoring/README.md)；
> 收到告警後怎麼做：[`INCIDENT_RESPONSE.md`「10. 監控與告警」](INCIDENT_RESPONSE.md#10-監控與告警)。
> 標 **【待使用者決定】** 的項目本 ADR 不替使用者做決定。

## 背景

現有的告警只有兩條，而且都跑在 GitHub Actions 上：

| 現有機制 | 看什麼 | 限制 |
|---|---|---|
| `.github/workflows/oracle-health.yml` | MockOracle 的 `updatedAt`、funding 結算延遲；過期時開 issue | 名目每 3 小時，GitHub 排程實測 68 分鐘～4.5 小時才跑一次；`issues: write` |
| keeper 熔斷（`agent/keeper/alert*.ts`） | keeper 拒寫大幅變動的價格時開 issue | 只在 keeper 有跑的時候才會發生 |

`ops/keeper-trigger/` 的 Cloudflare Worker 每 20 分鐘補觸發 keeper，持有一個 **Actions: Read and write** 的 GitHub token。它的 README 已經寫明：同一個 token 能停用 keeper **也能停用 `oracle-health.yml`**，所以「目前沒有不依賴 GitHub Actions 的告警」。

此外，下列事件**完全沒有人在看**：owner／AccessControl 角色變更、金庫升級、agent 授權、FeeRouter 與保險金接線變更、大額提領、保險金與金庫儲備率、價格偏離、keeper 錢包 gas、signal-api 健康、x402 收款地址。

限制條件：

- 合約位址的唯一真相是 `frontend/src/contracts/**`（`consistency.yml` 已經在擋 workflow 寫死舊位址，#178）。監控設定不能再成為第二份手抄的位址表。
- master 上的 guardian 暫停、逐資產模式、OI／獲利上限、Timelock 治理**尚未部署**；現行 exchange 的 ABI 沒有這些事件。對現行位址監控它們等於設一個永遠不會響的告警。
- 目前是測試網、單一維護者、沒有常駐主機；白標上線後每個租戶一套合約（[ADR-008](ADR-008-tenant-isolation.md)）。

## 需求

1. 不依賴 GitHub Actions 排程，也不與 keeper-trigger 共用憑證——監控要能在 keeper 那條路整個失效時還響。
2. 唯讀：不持有任何鏈上私鑰、不送交易。
3. SEV-1 類事件（owner、角色、升級、接線）在約 10 分鐘內通知到人。
4. 規則可由 CI 驗證：位址等於前端設定、事件存在於 ABI、處置段落存在。
5. 能擴充到「每個白標租戶一套合約」。
6. 測試網階段成本接近零。

## 方案比較

| | (a) OpenZeppelin Monitor（開源、自架） | (b1) 擴充現有 keeper-trigger Worker，開 GitHub issue | **(b2) 另開一個唯讀 Worker，webhook 告警（建議）** | (c) 第三方 SaaS |
|---|---|---|---|---|
| 是什麼 | OZ 開源的 Rust 監控服務；以 JSON 設定 network／monitor／trigger，比對事件、函式與交易，送 Slack／Discord／Telegram／email／webhook／自訂腳本；以 cron 運算式排程輪詢區塊 | 在 `ops/keeper-trigger` 裡加鏈上輪詢，告警時用同一個 token 開 issue | 新的 `ops/monitoring` Worker：cron 每 5 分鐘 `eth_getLogs`＋`eth_call`＋兩個 HTTP 檢查，告警送 Telegram／Discord／通用 webhook | Tenderly Alerts、Hypernative、Forta 等；OpenZeppelin Defender 已於 2026-07-01 停止服務，**不是選項** |
| 成本 | 軟體免費；需要一台常駐主機或容器（雲端最小規格每月數美元起，**未查證**），本專案目前沒有 | 免費方案內 | Workers 免費方案（cron、KV 每日 1,000 次寫入；本設計每 5 分鐘寫 1 次＝288 次／日）；若免費方案的 CPU 上限不夠需 Workers Paid（以 Cloudflare 官方定價為準，**部署後觀察**） | 免費層有規則數／通知數限制，企業方案需洽詢（**未查證**） |
| 可靠度 | 取決於自架主機；主機掛了就無聲，需要另外的心跳 | Cloudflare cron 在本專案實測可靠（keeper-trigger）；但與 keeper 共用失效點 | Cloudflare cron；失敗會記在 Workers Logs；可選心跳（dead-man's switch）；送不出去的告警留在 KV outbox 重送 | 高（託管）；廠商停服風險（Defender 就是前例） |
| 權限面 | 告警通道憑證＋RPC；不需要 GitHub token | **擴權**：fine-grained token 要加 **Issues: write**。外洩時攻擊者能停用 keeper 與 oracle-health（Actions）**並**關閉或改寫告警 issue（Issues）——同一把 token 同時能製造事故與掩蓋告警 | 只有告警通道憑證（Worker secret）；**沒有 GitHub token、沒有私鑰**。外洩最壞是有人往我們的頻道送假告警，或讀到告警內容（本來就只含公開的鏈上資料） | 只需提供公開位址與告警目的地；資料存放在廠商 |
| 事件涵蓋 | 強項：事件／函式／交易比對、過濾運算式 | 需自寫 | 自寫：事件（`eth_getLogs`，含金額門檻與累計視窗） | 強；部分廠商有 mempool 級攻擊偵測，是輪詢做不到的 |
| 狀態與 HTTP 涵蓋 | 弱：餘額、儲備率要靠自訂腳本；HTTP 健康檢查不在它的模型裡 | 需自寫 | 自寫：儲備率、保險金、價格新鮮度與偏離、gas、`/healthz`、x402 `payTo` | 視廠商；鏈下 HTTP 通常要另外的服務 |
| 延遲 | 依 cron，可到每區塊 | ≤ 20 分鐘 | ≤ 約 5～10 分鐘（cron 5 分鐘＋3 塊確認） | 秒級 |
| 白標多租戶 | 一個程序可監控多網路、多組合約；每租戶一組 monitor JSON。授權為 AGPL-3.0：若把修改過的監控當網路服務提供給租戶，可能須公開修改（**需法務確認**） | 與 keeper 綁死，不適合 | 每租戶一個 Worker（設定由 `deploy/tenants/*.json` 產生，各自的通道與 KV，故障與憑證隔離）；或單一 Worker 輪流處理（受每次執行的 subrequest 上限限制） | 依專案／合約數計價，成本隨租戶線性成長；持牌機構可能要求廠商盡職調查 |
| 維運負擔 | 主機、升級、日誌 | 低，但耦合 | 約 900 行程式＋測試要自己維護 | 最低 |

### 為什麼不開 GitHub issue

`oracle-health.yml` 開 issue 是合理的：它用的是 workflow 自己的短期 `GITHUB_TOKEN`，只在那一次 job 裡有效。Worker 要開 issue 就得持有一個**長期**的 PAT 並加上 Issues: write。把它加在 keeper-trigger 那把 token 上（b1），等於讓同一把 token 既能停掉 keeper、又能關掉告警；另發一把只有 Issues: write 的 token 給新 Worker，雖然不再耦合，仍是多一把能改寫事故時間線的長期憑證。webhook 到 Telegram／Discord／email 不需要任何 GitHub 權限，而事故時間線仍可由值班者在確認後手動開 issue（或沿用 oracle-health 的 issue）。

## 決定

**採用 (b2)：新增 `ops/monitoring/` 獨立 Worker，唯讀、不持有 GitHub token 與鏈上私鑰，以 webhook 送告警。** `oracle-health.yml` 與 keeper 熔斷 issue **保留**，成為第二條、跑在 GitHub 上的獨立路徑；兩條路徑互不共用憑證，任一條被停掉，另一條仍會響。

具體做法：

- 規則唯一真相是 [`ops/monitoring/monitors.json`](../ops/monitoring/monitors.json)：53 條（運作中 42：事件 30、狀態 10、HTTP 2；不載入 11：部署版不發此事件 10、待部署 1）。位址、topic0、selector、資產 ID、角色名稱由 `node scripts/check-monitoring.mjs --write` 從前端設定與 ABI 產生，人看的 [`rules.md`](../ops/monitoring/rules.md) 也由它渲染。
- `consistency.yml` 新增 `monitoring` job：位址 ≠ `addresses.ts`、事件不在 ABI、topic0 對不上、處置段落不存在、`rules.md` 過期、`wrangler.toml` 任何位置有秘密鍵名或含金鑰的 URL、`.dev.vars`／`.wrangler/` 沒列進 `.gitignore`，任一項都會紅。另外強制：
  - **事件在部署版 bytecode 裡**：前端 ABI 來自 master 原始碼，可能比鏈上那一版新。[`deployed.json`](../ops/monitoring/deployed.json) 是以唯讀 RPC 釘在單一區塊抓下的 runtime bytecode（含 EIP-1967 實作）與 getter 快照；每條 active 事件規則的 topic0 必須出現在對應合約的部署版 bytecode 裡，否則就是「看起來在監控、其實永遠不會響」。部署版不發的事件（InsuranceVault／FeeRouter 的接線、KYC verifier 等）改由**接線狀態規則**輪詢 getter，原事件規則標「部署版不發此事件」。CI 不連網，只讀這份 fixture；合約重新部署或升級後以 `--refresh-deployed` 重抓。
  - **事件涵蓋**：前端 ABI 裡的 admin 類事件（owner、角色、接線、參數）要嘛有規則、要嘛列在附理由的忽略清單。
  - **必要規則與最低嚴重度**：權限、暫停、接線、儲備等必要規則不可被刪、降級或改成 pending。
  - **參數型別與範圍**：例如 `MAX_BLOCK_RANGE` ≤ 1,000（公開 RPC 的 `eth_getLogs` 上限，超過回 413，檢查點會永久卡死）。
- 尚未部署的合約功能（guardian 暫停、資產模式、Timelock…）列為 `pending-deploy`：不帶位址、Worker 不載入，但事件必須真的宣告在 master 的 Solidity 原始碼裡。cutover 後更新 `addresses.ts` 與前端 ABI，改成 `active`，ABI 檢查自動接手。
- 每條規則對應 [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) 的處置段落；嚴重度沿用該文件的 SEV-1～4。
- 涵蓋鏈：只有正式鏈 Base Sepolia（84532）。Ethereum Sepolia 是 legacy 展示鏈，仍只由 `oracle-health.yml` 看價格新鮮度。

### 不做的事

- 不開 GitHub issue、不擴大任何 token 權限（理由見上）。
- 不自動處置（不自動暫停、不自動撤權）：Worker 沒有、也不應該有任何鏈上權限。自動 ReduceOnly 仍由 keeper 依 [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md) 處理。
- 不做 mempool 級的攻擊偵測：輪詢只能在交易上鏈後通知。這是 (c) 的強項，見「重新評估」。

## 待使用者決定

1. **告警通道**：Telegram、Discord、email（經 webhook 轉寄服務）要啟用哪些；誰接收、是否需要第二位接收者（[INCIDENT_RESPONSE §2](INCIDENT_RESPONSE.md#2-角色) 的「沒有值班輪替」缺口）。建立 bot／webhook 需要使用者本人的帳號。
2. **金額與餘額門檻**：`LARGE_WITHDRAWAL_USDC`、`LARGE_WITHDRAWAL_WINDOW_USDC`、`INSURANCE_WITHDRAW_USDC`、`LARGE_REDEEM_USDC`、`INSURANCE_MIN_USDC`、`GAS_MIN_ETH`、`GAS_CRIT_ETH` 目前是佔位值（見 rules.md「參數」）。絕對門檻之外另有相對門檻（`LARGE_WITHDRAWAL_BPS`：單筆佔提領前餘額的比例；`EXCHANGE_BALANCE_DROP_BPS`：交易所結算幣餘額跌幅），讓規則在測試網的小額 TVL 下也會響。
3. **`EXPECTED_PAY_TO` 與 `EXTRA_GAS_WALLETS`**：signal-api 的收款地址與 x402 結算錢包等需要 gas 的地址（公開地址，但只有使用者知道正確值）。在 x402 treasury 換新之前，`x402-payto:unsafe`（SEV-3）會在部署當下就觸發並每 6 小時提醒——要接受、還是以 `MUTE_KEYS = "x402-payto:unsafe"` 只靜音這一則（不要調 `MIN_SEVERITY`：那會關掉所有 SEV-3；`monitor-self` 兩者都擋不掉）。
4. **心跳服務**：是否用外部 dead-man's switch（需要另一個第三方帳號）偵測「Worker 自己停了」。不用的話，Worker 停擺只會出現在 Cloudflare 的 cron 失敗紀錄裡。
5. **RPC**：公開 RPC（`https://sepolia.base.org`，免帳號但有速率限制）或付費 RPC（`RPC_URL` secret）。
6. **白標**：租戶的監控由平台代管、租戶自管，或兩者都收到告警；告警回應時限是否寫進客戶契約（INCIDENT_RESPONSE §7 的目標值）。
7. **主網或第一個付費租戶之前**：是否加購 (c) 的即時攻擊偵測，或改用 (a) 以支撐更多租戶與規則。

## 重新評估的時機

- 上主網或第一個付費白標租戶上線前（真實資金 → 需要秒級與 mempool 級偵測，評估 (c)）。
- 租戶數使單一 Cloudflare 帳號的 Worker 數量、subrequest 或 KV 寫入額度不敷使用（評估 (a)）。
- Cloudflare 免費方案的 CPU 上限在實際執行中不夠（升級 Workers Paid 或拆分 Worker）。

## Consequences

- 多一個需要維護的元件（Worker 與檢查器約 2,900 行程式，另有測試）；但它與前端設定由 CI 綁在一起，位址或 ABI 改了而監控沒跟上會直接紅燈。
- **價格偏離目前沒有被監控**：參考來源 AggregatorOracle 對所有資產 revert（2026-10-01 唯讀實測），`oracle-deviation` 會持續發 SEV-3「沒有可用的參考價」，直到參考來源恢復。
- 告警延遲是分鐘級，不是秒級；SEV-1 的「確認後 1 小時內通知客戶」（INCIDENT_RESPONSE §7）在這個延遲下仍可達成。
- 新合約 cutover 的檢查表多一步：把對應的 `pending-deploy` 規則改成 `active`、`--write`、重新部署 Worker。
- 公開 RPC 限流或故障時，監控會發「監控本身有規則讀取失敗」（SEV-3），且不會把讀不到誤判成恢復。
- 每個白標租戶多一個 Worker 與一組通道憑證；租戶部署檢查表（[`TENANT_DEPLOYMENT.md`](TENANT_DEPLOYMENT.md)）之後需要加上這一步。

## 參考

- OpenZeppelin Monitor：<https://github.com/OpenZeppelin/openzeppelin-monitor>、<https://docs.openzeppelin.com/monitor>
- OpenZeppelin Defender 停止服務公告：<https://www.openzeppelin.com/news/doubling-down-on-open-source-and-phasing-out-defender>、<https://www.openzeppelin.com/news/defender-sunset-faq>
- keeper-trigger 的 token 威脅模型：[`ops/keeper-trigger/README.md`](../ops/keeper-trigger/README.md)
