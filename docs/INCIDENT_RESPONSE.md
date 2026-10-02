# 事故應變程序

> **草案**（2026-09-30）。適用於 PepeFi 在 Base Sepolia 測試網的現行部署，並描述白標客戶上線後的預期做法。
> 所有時限都是**可調整的目標值**，實際值須寫入與客戶的契約（**需客戶確認**）；對主管機關的法定通報時限
> 由客戶負責（**需律師確認**）。本文不含任何未修補漏洞的細節。

## 1. 嚴重度分級

| 等級 | 定義（任一成立） | 例子 |
|---|---|---|
| **SEV-1 嚴重** | 資金正在或即將被不當移轉；特權金鑰疑似外洩；價格被寫成明顯錯誤的值且交易仍在進行 | owner 金鑰外洩；錯誤價格導致大量清算 |
| **SEV-2 高** | 資金暫無立即損失，但核心功能失效或保護失效 | 價格熔斷後交易所仍以舊價成交；保險金庫耗盡；結算 worker 停機 |
| **SEV-3 中** | 單一元件降級，有替代路徑 | 單一資產價格過期；付費 API 回 503；前端部分頁面錯誤 |
| **SEV-4 低** | 不影響資金與交易的問題 | 文件錯誤、告警誤報 |

無法判斷時，先以較高等級處理，再降級。

## 2. 角色

| 角色 | 職責 | 現況 |
|---|---|---|
| 事故指揮（IC） | 判定等級、指派工作、決定是否暫停、核准對外溝通 | 由專案維護者擔任 |
| 技術負責人 | 調查、止血、修補、驗證 | 專案維護者 |
| 金鑰持有人 | 執行需要 owner／guardian／pauser／risk 權限的交易 | **owner 為單一 EOA**，只有一位持有人；沒有 multisig，也沒有 timelock |
| 對外溝通 | 通知客戶機構、更新狀態、發布事後檢討 | 專案維護者 |
| 客戶聯絡窗口 | 客戶端接收通報並負責對其主管機關與終端客戶通報 | 規劃中，每個客戶指定 |

**已知缺口**：目前 IC、技術負責人、金鑰持有人常是同一人，沒有值班輪替，也沒有第二人覆核。
白標上線前必須補上（**需客戶確認**需要的人力配置）。

## 3. 暫停與凍結：現行部署能做什麼

**現行 exchange（`0x827eA0c62a32e995927101259042F8A27D99124D`）沒有全域暫停、也沒有逐資產停單功能。**
可用的手段有限，而且大多是鈍器：

| 對象 | 手段 | 權限 | 效果與代價 |
|---|---|---|---|
| Agent 交易 | `PerpetualExchange.setAgentAuthorized(sessionManager, false)` | exchange owner | 所有 agent session 無法開倉，也無法由 agent 平倉；終端客戶仍可自行平倉 |
| 單一 session | `AgentSessionManager.revokeSession` | 該 session 的使用者 | 立即撤銷 |
| 新曝險 | 調低逐資產槓桿上限、調整費率等 owner 參數 | exchange owner | 只能降低新部位的槓桿或提高成本，不能阻止開倉 |
| 價格 | 停止 keeper workflow | GitHub repo 管理者 | 價格停在舊值；在 `maxPriceAge`（6 小時）內交易所**仍以舊價成交**，之後開倉、平倉、清算都會 revert（這三者需要新鮮價格；入金與提領 `freeMargin` 不需要，仍可進行）。**會同時凍結平倉**，只在持續損失大於凍結代價時考慮 |
| 價格 | 人工寫入核對過的價格（`admin-base-sepolia.yml`） | oracle 寫入金鑰 | 需第二人覆核輸入；見 [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md) |
| 代幣化金庫 | `AssetVaultV2.pause()` | `PAUSER_ROLE` | mint 與 redeem 都停止（贖回也會被凍結） |
| 代幣化金庫 | 調低逐資產上限；準備率跌破門檻時 mint 自動鎖住 | `RISK_ROLE` | 只限制新的 mint |
| 金庫價格 | `GuardedOracle.setAssetFrozen` | `GUARDIAN_ROLE` | 該資產讀價 revert，金庫無法對它 mint／redeem；**不影響** exchange（exchange 讀的是 MockOracle） |
| 金庫價格 | `GuardedOracle.setPaused` | `GUARDIAN_ROLE` | 停止價格更新；讀取不受影響，直到價格超過 GuardedOracle 的 `maxPriceAge`（Base 現行 30 天）才 revert |
| x402 收款 | 收款地址守門自動 fail-closed | 自動 | 收款地址不安全時付費端點回 503，不要求付款 |
| x402 分潤 | 停用 `x402-settlement-worker.yml`；worker 在結果不明時會自行全域停機 | GitHub repo 管理者 | 分潤暫停，佇列保留 |
| 前端 | Vercel 回滾（第 6 節）；以功能旗標關閉入口 | Vercel 專案管理者 | 只影響畫面；不能阻止任何人直接呼叫合約 |

上表兩列 GuardedOracle 是鏈上現行版本（`0x8E9e…`）的行為：guardian 的凍結與暫停沒有期限。
新版原始碼（2026-10-01，尚未部署，要重部署 oracle 才生效）改為 guardian 的凍結或暫停 72 小時後自動失效、
同一範圍接著 24 小時冷卻（暫停若提前解除，冷卻從解除時起算）；要維持更久必須由 admin 接手：`takeOverAssetFreeze(id)`／`takeOverPause()`，只接手正在生效的 guardian 停機，guardian 已解除時會 revert，不會變成新的無期限停機。誤報的暫停請立刻解除：它不會削弱之後的資產凍結。
兩個要先知道的行為：暫停跑了很久之後（一天內）才開的凍結會依暫停的時間縮短，最短可能只剩幾秒，交易仍會成功且會用掉該資產的凍結視窗（之後 24 小時不能再凍結），凍結前先讀 `guardianFreezeTerms(id)`；暫停生效期間開過任何資產凍結，暫停就要到原本終點後 24 小時（最多開始後 96 小時）才能再用，之後先解除凍結再解除暫停也避不開。
timelock 解除 oracle 停機時，若懷疑 guardian 金鑰外洩，要在同一批提案撤換 `GUARDIAN_ROLE`（見 GOVERNANCE_HANDOVER）。
到期是 fail-open，且到期只移除凍結、不更新價格。規則與代價見 [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) #27。

2026-09-30 唯讀查詢：Base 金庫的 `PAUSER_ROLE` 與 GuardedOracle 的 `GUARDIAN_ROLE` 不在 owner EOA 上。
但 owner EOA 在 vault 與 GuardedOracle 都持有 `DEFAULT_ADMIN_ROLE`，在 vault 另有 `RISK_ROLE`，
因此可以自行授予自己（或他人）`PAUSER_ROLE`／`GUARDIAN_ROLE`。這代表緊急時單一金鑰就能取得暫停權限，
也代表單一金鑰外洩的影響範圍涵蓋上述所有角色。目前角色持有者以部署與角色分離紀錄為準（見 [`ROLE_SEPARATION.md`](ROLE_SEPARATION.md)、
[`DEPLOY_129_CUTOVER.md`](DEPLOY_129_CUTOVER.md)），本文**未逐一驗證**。

## 4. 原始碼版（PR #191，未部署）多了什麼

完成 cutover 後才會生效：

| 手段 | 權限 | 效果 |
|---|---|---|
| 全域 `pause()` | guardian 或 owner | 停止開倉、平倉、清算與提領；允許入金；funding 與借貸費暫停計息。guardian 的暫停 72 小時後自動失效，之後 24 小時冷卻；只有 owner 能解除 |
| 逐資產 ReduceOnly | guardian（只能收緊）、marketOperator（Active↔ReduceOnly）、owner | 禁止新開倉，平倉與清算照常 |
| 逐資產 Halted | guardian、owner | 凍結該資產的開平倉、清算與 funding |
| 暫停後寬限期 | 自動 | 解除後 30 分鐘內禁止清算與開倉，讓交易者補保證金 |
| OI 與獲利上限 | owner（部署腳本設定） | 限制資金池的最大曝險 |

keeper 熔斷時會自動嘗試把資產切成 ReduceOnly，但**只有在新 exchange 上線、且 keeper 被設為 marketOperator 後
才做得到**；現行部署下這一步一律記錄為「做不到」，只剩告警（見 [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md)
「價格熔斷」）。

## 5. keeper 熔斷處置

依 [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md) 的「價格熔斷」一節執行。重點：

1. keeper 拒寫時會讓 job 失敗並開 issue「[keeper] Base Sepolia 價格熔斷」。
2. **先判斷是否需要立刻停止交易**：現行部署在 6 小時內仍以舊價成交；可用手段見第 3 節。
3. 至少兩個人工來源獨立核價，確認是否有拆股等公司行動。
4. 依原因處置：來源壞了就修來源、不寫價；拆股不得直接寫新價；真實跳空由 owner 以人工核過的價格寫入，
   並由第二人覆核。
5. 驗證：手動觸發 `oracle-health.yml`，確認告警 issue 依規則自動關閉。

其他 keeper 症狀（全面 `StalePrice`、偏離上限死鎖）見同一份手冊。

## 6. Vercel 回滾（前端與 signal-api）

前端與 signal-api 都部署在 Vercel。回滾只影響程式碼版本，**不會**改變鏈上狀態，也不會撤回已送出的交易。

**儀表板**：

1. Vercel → 對應專案 → **Deployments**。
2. 找到最後一個已知正常的 Production 部署（確認 commit 與時間）。
3. 在該部署的選單選 **Instant Rollback**（或 **Promote to Production**）。
4. 確認正式網域已指向該部署；以瀏覽器與 `curl` 驗證（signal-api 可打 `GET /healthz` 與 `GET /`）。

**CLI**（需要專案權限）：

```bash
vercel rollback <deployment-url-or-id>   # 回到指定的部署
vercel promote <deployment-url-or-id>    # 修好後把新部署升為 Production
```

注意事項：
- 回滾後，新的 push 可能不會自動升為 Production，直到手動 promote；可用的回滾範圍依 Vercel 方案而定。
  以 Vercel 官方文件為準（**未驗證**本專案所用方案的限制）。
- 環境變數的變更（例如收款地址、功能旗標）需要重新部署才會生效；回滾到舊部署會一併使用舊部署建置時的設定，
  務必確認不會把已撤換的設定帶回來。
- 前端的 CSP 與安全標頭在 `frontend/vercel.json`，會隨部署一起回滾。
- **只有 master 與 `preview/**` 分支會自動部署**（`vercel.json` 的 `git.deploymentEnabled`，
  2026-09-30 部署額度用罄後設定）。需要 PR 預覽時，把分支命名為 `preview/<名稱>`。
- master 的 push 另有 Ignored Build Step（`scripts/vercel-ignore-build.sh`）：自上次成功部署以來本專案
  沒有變更就跳過建置。因此**只改環境變數後要讓它生效，必須手動 Redeploy，並取消勾選
  「Use project's Ignore Build Step」**；等下一次 push 不一定會重建。被跳過的部署仍計入每日部署額度。
- 部署被額度擋下（`build-rate-limit`）時，額度恢復後下一次 master push 會自動補部署積欠的變更；
  急需上線可在額度恢復後手動 Redeploy 最新的 master。

## 7. 對外溝通與客戶通報（目標值，可調整）

| 事件 | 通知客戶機構 | 後續更新 | 事後檢討 |
|---|---|---|---|
| SEV-1 | 確認後 **1 小時**內 | 每 **4 小時**，直到止血 | **5 個工作天**內提交 |
| SEV-2 | 確認後 **4 小時**內 | 每個工作天 | **10 個工作天**內 |
| SEV-3 | **1 個工作天**內 | 解決時 | 視需要 |
| SEV-4 | 納入例行報告 | — | — |

- 通知內容：發生時間、影響範圍（哪些合約、資產、客戶）、已採取的措施、是否需要客戶採取行動、下次更新時間。
- **不公開未修補漏洞的細節**；公開說明以影響與處置為主。
- 對主管機關與終端客戶的通報由客戶負責（**需律師確認**法定時限）。
- 通報管道規劃中：每個客戶指定窗口與備援窗口（**需客戶確認**）。

## 8. 外部協助：SEAL 911

SEAL 911 是 Security Alliance（SEAL）提供的公開緊急聯絡管道，協助正在發生的鏈上安全事件。依其公開資訊：

- Telegram：`@seal_911_bot`（<https://t.me/seal_911_bot>）
- 說明與流程：<https://github.com/security-alliance/seal-911>

使用前請以 SEAL 官方公開頁再次確認聯絡方式。聯絡時提供：鏈與合約位址、事件時間、已觀察到的交易、
我方可聯繫的人。**不要**在公開頻道貼出未修補漏洞的細節或任何私鑰。

## 9. 事後檢討範本

```markdown
# 事後檢討：<標題>（SEV-<等級>）

- 日期與時間範圍（UTC 與台灣時間）：
- 撰寫人／審閱人：
- 狀態：草稿 / 已審閱 / 已公開

## 摘要
一段話說明發生了什麼、影響多大、是否已解決。

## 影響
- 受影響的合約、資產、服務：
- 受影響的客戶機構與終端客戶數：
- 資金影響（金額與幣別；測試網請註明無真實價值）：

## 時間軸
| 時間 | 事件 | 來源（tx hash、log、issue） |
|---|---|---|

## 根因
技術原因與流程原因分開寫。

## 偵測
怎麼發現的？告警有沒有響？應該多早發現？

## 處置
採取了哪些措施，各自的效果與副作用。

## 做得好的地方 / 需要改進的地方

## 行動項目
| 項目 | 負責人 | 期限 | 追蹤（issue／PR） |
|---|---|---|---|

## 對外說明
已通知的客戶與時間；是否需要公開說明。
```

## 10. 監控與告警

告警有兩條互相獨立的路徑，不共用任何憑證；任一條被停掉，另一條仍會響。決策與方案比較見
[`ADR-009-monitoring.md`](ADR-009-monitoring.md)。

| 路徑 | 看什麼 | 怎麼通知 | 頻率 |
|---|---|---|---|
| 鏈上監控 Worker（[`ops/monitoring/`](../ops/monitoring/README.md)） | 權限與 owner 變更、暫停與資產模式、大額提領、價格過期、保險金與金庫儲備率、FeeRouter 與 x402 收款設定、keeper gas、signal-api 健康 | Telegram／Discord／webhook（依部署設定） | 每 5 分鐘 |
| GitHub Actions（`oracle-health.yml`、keeper 熔斷） | 價格過期、funding 未結算、keeper 拒寫 | 固定標題的 GitHub issue | 每 3 小時（排程常延遲） |

**規則清單**：[`ops/monitoring/rules.md`](../ops/monitoring/rules.md)。每條規則列出事件或狀態、合約與位址來源、門檻、
嚴重度，以及對應本文件的處置段落；告警訊息本身也附「處置」連結。

收到告警時：

1. **先判斷等級**：訊息上的 SEV 是規則的預設判斷，依第 1 節以實際影響調整（無法判斷時取較高者）。
   「事件」型告警（owner、角色、升級、接線變更）要先確認**是不是我們自己做的**：對照當天的變更紀錄與
   Timelock 排程；認不得的一律以 SEV-1 處理。
2. **依規則清單的「處置」欄**到對應段落執行；需要暫停或撤權時見第 3、4 節。
3. **「恢復」通知不等於事故結束**：狀態型告警（價格、儲備率、gas、健康檢查）在條件解除時會自動發「恢復」，
   但事後檢討（第 9 節）仍依原等級進行。
4. **「監控本身有規則讀取失敗」**（SEV-3，連續數輪失敗才發）代表 RPC 或 signal-api 讀不到，**不代表**被監控的狀態正常；
   讀取失敗期間不會發「恢復」。持續時改用區塊瀏覽器人工確認，並檢查 Worker 的 Cloudflare Logs。
5. **「監控狀態重置：往回看 N 個區塊，從區塊 M 重新開始」**（SEV-3）：剛部署時是正常的；之後再收到代表 Worker 的 KV 狀態遺失或被清除，
   從上一次正常掃描到區塊 M 之間的 owner、角色、接線、提領事件要到區塊瀏覽器人工補查（Worker 只自動回看有上限的一段）。
6. **「監控設定問題」**（`monitor-self:config`，SEV-2）：有人在 Worker 設了不可靜音的 `MUTE_KEYS`、`MIN_SEVERITY = SEV-1`，
   把參數調到範圍外，或某個通道／心跳／RPC 的設定格式不對（該項已停用）。Worker 已以夾住後的值照常運作；查 Cloudflare 的變數是誰、何時改的，認不得的變更以 SEV-1 處理（可能有人想讓告警閉嘴）。
7. **「（累計，過去發生）」**：監控停機或落後期間的提領（只在落後追趕時才會發），發生當時的一小時內累計達門檻。訊息裡的發生時間是區塊時間；依大額提領處置，並一併檢查那段期間的其他事件。
8. **「告警 outbox 溢位」**（`monitor-self:outbox`，SEV-2）與「N 則 SEV-1／監控自身通知合併」：告警通道長時間送不出去或通知量異常，
   有低嚴重度通知被丟棄、或關鍵通知被合併成摘要。檢查通道，並到區塊瀏覽器補查訊息列出的時間範圍。
   「（本輪 N 筆，合併為摘要）」是同一條規則一輪內的大量事件；摘要只列前幾筆，其餘要到區塊瀏覽器查。
   「（值再次變更）」：接線、實作或收款地址的告警開著時，值又被換成另一個——以新的變更重新判斷，不要當成舊告警的重複。
9. **新版 GuardedOracle 的停機告警**（#219 原始碼，oracle 重新部署並把規則改 active 後才會響）：「guardian 停機開始／解除」（SEV-2）帶自動失效時間 `expiresAt`；
   到期失效時不發事件，`guarded-oracle-paused` 每輪讀 `paused()` 會看到暫停解除（資產凍結的到期沒有狀態規則，以 `expiresAt` 為準）。原因還沒排除時，依第 3 節與 GOVERNANCE_HANDOVER 在到期前由 timelock 接手；
   懷疑 guardian 金鑰外洩時，解除停機的提案要同一批撤換 `GUARDIAN_ROLE`。「停機被 admin 接手（不再到期）」是 SEV-1：對照 timelock 排程，認不得的接手等同 admin 權限被濫用。
10. **「UUPS 實作被升級」**（`proxy-implementation`）：鏈上的實作與 CI 依據的 `deployed.json` 不同。未經排程就是 SEV-1；預期中的升級也要重抓 `deployed.json` 並重新部署 Worker，否則 CI 的「事件在部署版裡」檢查是對舊版做的。
11. **誤報**：調門檻要改 `ops/monitoring/monitors.json`（或 Worker 的 `[vars]`）並走 PR，不要在事故當下關掉整條規則。
   已知、已接受的單一告警用 `MUTE_KEYS` 只靜音那一個 key（只接受 `mutableKeys` 白名單）；不要用 `MIN_SEVERITY` 一次壓掉整個等級。
   SEV-1 與 `monitor-self`（監控自身故障）在任何設定下都會送出。

已知限制：監控是分鐘級輪詢，只能在交易上鏈後通知，不能攔截；Worker 沒有任何鏈上權限，不會自動暫停或撤權。
**價格偏離目前沒有被監控**：規則 `oracle-deviation` 已寫好，但參考來源（AggregatorOracle）對所有資產 revert（2026-10-01 實測），
規則會持續發 SEV-3「沒有可用的參考價」而不是靜靜空轉；參考來源恢復後自動開始比對。在那之前，價格正確性只靠 keeper 的熔斷與 `oracle-health.yml`。
尚未部署的合約功能（全域暫停、資產模式、Timelock）的規則已寫好但標為「待部署」，cutover 後才會生效。
