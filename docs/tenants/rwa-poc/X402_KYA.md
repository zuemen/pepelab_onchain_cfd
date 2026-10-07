# RWA PoC：x402 Know-Your-Agent 實測（S6）

本機 signal-api 開啟 x402 KYA，接 rwa-poc 租戶在 Base Sepolia（84532）的新部署。代理人用**真的** Base Sepolia 測試 USDC、透過**真的**公開 facilitator（`https://x402.org/facilitator`）付款。設計見 [`docs/SSI_AGENT_DELEGATION.md`](../../SSI_AGENT_DELEGATION.md) §4。

這裡沒有任何模擬的元件。`agent-delegation-demo.sh` 用的是本機假 facilitator 和假 Upstash，這份不是。唯一的取捨是：KYA 花費帳用 `X402_KYA_SPEND_STORE=memory`。它只在單一 process 內有效，**signal-api 重啟後歸零**。

## 1. 參與者與合約

| 角色 | 位址 | 說明 |
|---|---|---|
| 投資人（session.user，憑證簽發者） | `0xebAFE53877ad3B691664d8cb0b34874CE1240194` | keystore `pepelab-rwa-investor` |
| 代理人（session key，VP holder，x402 付款人） | `0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7` | keystore `pepelab-rwa-agent` |
| 收款（`PAY_TO`） | `0xC7F9Bd7591601E68A1874Bfe69C0d5b75bc5eFBE` | keystore `pepelab-rwa-payto`，全新 EOA，通過 signal-api 的 payTo 安全檢查 |
| AgentSessionManager | `0xa60a1dC20E1CBb0cBc869464E35AEBa6ff3acbdd` | 讀自 `deploy/tenants/rwa-poc.deployed.json` |
| SessionCredentialAnchor | `0x80269C6FfEbce234d6b24979735D987C8e0e5fBD` | 讀自 [DEPLOYMENT.md](DEPLOYMENT.md)，`sessionManager()` 等於上一列（啟動時檢查） |
| 結算幣別（x402） | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle 的 Base Sepolia USDC（6 位小數，EIP-3009） |
| 付費端點 | `GET /signals/<trader>` | 0.01 USDC（atomic 10000）。trader 取平台 StrategyRegistry 第一個非外洩地址 |

腳本裡沒有寫死任何位址。合約位址從部署紀錄讀，錢包位址由 keystore 解出（`cast wallet address`／`ethers.Wallet.fromEncryptedJson`，只在記憶體裡解開）。

## 2. 指令

```bash
# 終端機 1：本機 signal-api（port 4021，KYA on，錨定 required），Ctrl-C 結束
bash scripts/poc/rwa-poc-x402.sh server

# 終端機 2
bash scripts/poc/rwa-poc-x402.sh balance                    # 代理人 USDC
bash scripts/poc/rwa-poc-x402.sh setup <label> <每期上限> <總額上限>   # 開 session＋簽發 v3＋錨定（atomic USDC）
bash scripts/poc/rwa-poc-x402.sh call <label> novp|vp [次數]
bash scripts/poc/rwa-poc-x402.sh pay                        # 一鍵案例 (c)：USDC ≥ 0.02 時帶 VP 付 3 次
bash scripts/poc/rwa-poc-x402.sh status-list [label…]       # 投資人簽發並安裝狀態清單（帶 label＝撤銷那張憑證；不送鏈上交易）
```

`server` 以 `env -i` 加上白名單變數啟動，殼層裡殘留的 `PRIVATE_KEY`、`X402_*` 等都進不去。白名單擋不住一件事：signal-api（`index.ts`、`settlement.ts`）和 `@pepelab/shared/autoload-env` 會用 dotenv 讀 `agent/.env`。所以腳本做了兩道防護：

1. 偵測到 `agent/.env` 就拒絕啟動。請在沒有 `agent/.env` 的 checkout 執行，例如專用 worktree。
2. 第二道：在 `env -i` 裡把敏感變數明確設好。dotenv 的 `override:false` 不會蓋過已存在的變數，包括空字串。
   - 設成空字串：`FEE_SETTLEMENT_PRIVATE_KEY`、`VERIFIER_PRIVATE_KEY`、`AGENT_PRIVATE_KEY`、`PRIVATE_KEY`、`X402_PAYTO_ALLOWLIST`、`X402_FEE_ROUTER`、`X402_SETTLEMENT_TOKEN`、`UPSTASH_*`、`VC_STATUS_URL`、`DEMO_TRADER_ADDRESS`、`ORACLE_BENEFICIARY_ADDRESS`、`SIGNAL_API_PUBLIC_URL`、`SIGNAL_API_URL_ALLOWLIST`。
   - 設成明確值：`X402_FACILITATOR_URL`、`X402_PROTOCOL`。這兩個在程式裡用 `??` 取預設，空字串會被當成真的值，所以不能留空。

啟動前還會檢查 RPC 的 `cast chain-id` 是否為 84532。`setup`、`call`、`balance` 也會先檢查 `eth_chainId` 是否為 `0x14a34`。

主要變數如下：

| 變數 | 值 |
|---|---|
| `SIGNAL_API_PORT` | 4021（前端 `scripts/poc/rwa-poc-frontend.sh` 的預設 `VITE_SIGNAL_API_URL`） |
| `PAY_TO` | payto 錢包（由 keystore 解出） |
| `X402_KYA_MODE` / `X402_KYA_ANCHOR` | `on` / `required` |
| `SESSION_MANAGER_ADDRESS` / `SESSION_ANCHOR_ADDRESS` | 上表兩個合約 |
| `KYA_RPC_URL`、`BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org`（可用 `RWA_POC_RPC_URL` 覆寫） |
| `X402_KYA_SPEND_STORE` | `memory`（本機沒有 Upstash） |
| `VC_STATUS_DIR` | `agent/.state/rwa-poc/vc-status`（ADR-016 狀態清單目錄，第一次啟動時 `init`，已被 gitignore） |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:4173` |
| `X402_FACILITATOR_URL` / `X402_PROTOCOL` | `https://x402.org/facilitator` / `v1` |

CORS 的情況：付費端點與 `/kya/spend` 回 `Access-Control-Allow-Origin: *`。`/reference-prices` 只對白名單回 `Access-Control-Allow-Origin: http://localhost:5173`（已實測）。

**監聽位址**：`index.ts` 沒有 hostname 設定，signal-api 會綁在所有網卡（`*:4021`）。同一個區網裡的機器也連得到。錄影時請在可信任的網路上，或用本機防火牆擋掉 4021 的對外連線。這裡沒有改 signal-api 核心程式碼。

### 撤銷狀態清單

目錄初始化時是空的。驗證端遇到沒有清單的簽發者會回 `STATUS_NO_LIST` 並放行。所以在發佈清單之前，憑證**不能**用狀態清單撤銷，只能靠鏈上 `revokeSession` 或 `unanchor`。

2026-10-07 已經用 `status-list` 發佈了投資人的第一份清單：sequence 1，撤銷 0 張。這是離線簽章，沒有鏈上交易。

之後要撤銷某張憑證（S7 示範撤銷）：

```bash
bash scripts/poc/rwa-poc-x402.sh status-list main
```

- 投資人會簽一份累積清單（sequence +1），由 `vc-status install` 驗簽並檢查 sequence 遞增、沒有少掉既有撤銷項，通過才安裝。
- signal-api 的狀態快取最長 60 秒，所以撤銷最慢 60 秒內生效，之後回 `403 kya_credential_revoked`。
- 要立即生效，用鏈上 `revokeSession` 或 `unanchor`。

## 3. 鏈上準備（2026-10-07，全部 status 1；每筆先 `staticCall` 模擬、通過才送）

兩張憑證都是投資人以 EIP-712 簽發的 v3 `AgentDelegationCredential`。endpoints 是 `GET /signals/*` 與 `GET /oracle/*`，期間 3600 秒。兩個 session 的條款相同：單筆 50、總預算 150、5 倍、7 天，資產只限 sAAPL、sGOLD、sBTC、sETH。

| label | session | x402 上限（每期／總額） | credentialHash | 開 session | 錨定 |
|---|---|---|---|---|---|
| `main` | #0 | 0.02／0.02 USDC | `0x80746a72a533b6fa0543a4b70de41fc12d36fa703eac0f23af1c7f544f5e2074` | [0xfd8d7cc0…](https://sepolia.basescan.org/tx/0xfd8d7cc0ca65ea6ffb72b8d4225f666e909d6cf33b73a6c70b54888fa40ddc89) | [0x74cfd108…](https://sepolia.basescan.org/tx/0x74cfd108b009734914290ef31e07beb193f1e141a927f7dd837472b55fae12ab) |
| `lowcap` | #1 | 0.005／0.005 USDC（低於單價 0.01） | `0x117888601f986d2bc51bf3334605888cc153a0e81c239af2e8ed77d083d4b2bc` | [0x4b5c8e7c…](https://sepolia.basescan.org/tx/0x4b5c8e7c3281a4d2919bc11a9f5e6ed25a093fadc2e2ff234a4144df53e2be27) | [0x59eaff03…](https://sepolia.basescan.org/tx/0x59eaff0320cdfa36c9a09b47d7a6fdf0353754622ba59c5466e97f7df9773e96) |

憑證 JSON 存在 `agent/.state/rwa-poc/x402/<label>.json`。這個目錄被 gitignore 排除；檔案裡沒有私鑰。一個 session 同時只能錨定一張憑證，所以兩種上限各開一個 session。

## 4. 三個案例

未付款的請求會得到 `402`：`maxAmountRequired=10000`，`payTo` 是收款錢包，並帶 header `X-Agent-KYA: required; header=X-Agent-Presentation; credential=AgentDelegationCredential; …`。

### (a) 不帶 VP：被拒 ✅

`call main novp`：代理人簽 EIP-3009 付款授權，但不附 `X-Agent-Presentation`。

```
HTTP 403  error=kya_presentation_required
本服務要求代理人出示委託憑證：付款時請一併帶 X-Agent-Presentation（v3 AgentDelegationCredential 的 Verifiable Presentation）。
```

KYA 在付款送進 facilitator 之前就回應了，沒有扣款。

### (b) 超過憑證花費上限：被拒 ✅

`call lowcap vp`：帶 VP，憑證上限 0.005 USDC，低於單價 0.01。

```
HTTP 403  error=kya_spend_limit_exceeded
超過委託憑證的 x402 總額上限：已花 0，本筆 0.01，上限 0.005 USDC。
```

這筆在身分一致、憑證簽章、狀態檢查、鏈上 session 逐欄比對、錨定全部通過之後，被花費檢查擋下，沒有送進 facilitator。

首次實測時投資人還沒有狀態清單，狀態檢查是以 `STATUS_NO_LIST` 放行的。發佈 sequence 1 的空清單後重測，結果相同：(a)、(b) 一樣，(c) 一樣停在餘額不足。

「累計超過」的版本是案例 (c) 的第 3 次呼叫：`main` 上限 0.02，前兩次各 0.01 結算之後，第 3 次預期回 `403 kya_spend_limit_exceeded`。

### (c) 帶 VP、真 USDC 付款：⏳ 等代理人入金

2026-10-07 實測時代理人的 USDC 餘額是 0。`call main vp` 的結果如下：

```
HTTP 402  error=invalid_exact_evm_insufficient_balance
```

這次呼叫的過程：

1. 取得 402 付款需求。
2. 代理人簽 EIP-3009 授權，並以 `kyaFetch` 簽 VP（綁定 `GET /signals/<trader>`、付款 nonce 與 payer）。
3. **KYA 全部通過**。
4. 交給公開 facilitator 驗證，因餘額不足被拒，沒有交易上鏈。

KYA 依設計退回了預留額度。`GET /kya/spend/<main 的 credentialHash>?period=3600` 回 `totalAtomic=0`。

**USDC 到帳後的一鍵指令**（代理人需要 ≥ 0.02 USDC，到 <https://faucet.circle.com> 選 Base Sepolia）：

```bash
bash scripts/poc/rwa-poc-x402.sh server      # 若還沒在跑（重啟會讓 memory 花費帳歸零，正好重新從 0 計）
bash scripts/poc/rwa-poc-x402.sh pay
```

預期結果：

| 次數 | 回應 | 結算 |
|---|---|---|
| 第 1 次 | `200` | `X-PAYMENT-RESPONSE.transaction` 是結算 tx hash（腳本印 BaseScan 連結），`X-Agent-KYA-Spend: total=10000;…` |
| 第 2 次 | `200` | `total=20000` |
| 第 3 次 | `403 kya_spend_limit_exceeded` | 不結算 |

| 結算 tx | BaseScan |
|---|---|
| 第 1 次 | （待填） |
| 第 2 次 | （待填） |

## 5. 錄影注意事項

- signal-api 重啟後，memory 花費帳會歸零。`main` 憑證可以重錄，前兩次會再次真的扣款。
- 同樣在 memory 裡的還有 KYA 的 VP 防重放集合 `(payer, payment nonce)`，重啟後也會清空。重送舊付款仍會被鏈上 EIP-3009 的 nonce 擋下，USDC 合約不接受同一個 nonce 兩次。
- 公開 RPC 會限流，也可能讀到舊狀態。剛錨定完就呼叫，可能得到 `kya_not_anchored`，等幾秒再試即可。`setup` 已經等到 `isAnchored=true` 才結束。
- presentation 的時間容忍是 ±120 秒，本機時鐘要準。
