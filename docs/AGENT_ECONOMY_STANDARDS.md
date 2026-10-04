# PepeLab 與代理經濟標準（ERC-8004 / 8126 / 8183）

把本專案定位進新興的「代理經濟」三層標準堆疊：**身分（identity）→ 驗證（verification）
→ 商務（commerce）**。以下說明每層對應到 PepeLab 的哪個既有元件，以及缺口/後續。

> 註：本文件用以**對標定位**，非聲稱已正式合規。2026-10-02 查證的規格狀態：
> **ERC-8126 為 Final**（2026-06-02 由 Last Call 轉 Final，[ethereum/ERCs@8bc3c2a](https://github.com/ethereum/ERCs/commit/8bc3c2a1263a3c44268e846df08699400d541841)）；
> **ERC-8004 為 Draft**（2025-10 進 Review，2026-01-13 退回 Draft，[ethereum/ERCs#1470](https://github.com/ethereum/ERCs/pull/1470)）；
> ERC-8183 本次未重新查證。ERC-8126 Final 的 `requires` 含仍是 Draft 的 8004。

---

## 三層對應總表

| 層 | 標準 | 主題 | PepeLab 對應 | 狀態 |
|----|------|------|--------------|------|
| 商務 | **ERC-8183** | agent 付費購買服務 | **x402 付費訊號 API**（端點即商品，官方 USDC、70/20/10 上鏈分潤） | ✅ 上線 |
| 驗證 | **ERC-8126**（Final） | agent 的可驗證性（ETV/MCV/SCV/WAV/WV + 統一風險分數） | **驗證層模組**：五項檢查 → 0–100 風險分數 → verifier 簽名 attestation；`GET /agent/:did/verification` | 🟡 子集；對 Final 版**不合規**的 MUST 見 §2.1 |
| 身分 | **ERC-8004**（Draft） | agent 身分註冊 | `did:pkh` agent DID + 授權 VC（鏈下，含撤銷：ADR-016）；Base Sepolia 有官方 registry，**尚未註冊** | 🟡 鏈下已做；註冊工具已備、未送 |

---

## 1. 商務層 — ERC-8183（= x402 付費層）

- **端點即商品**：`/signals/:trader`（$0.01）、`/oracle/:asset`（$0.005），任何帶 Base
  Sepolia 官方 USDC 的 agent 直接付費購買。
- **結算**：x402 `transferWithAuthorization`（EIP-3009）→ 收入經 `FeeRouter.routeExternalRevenue`
  走 **70/20/10**（trader / platform / vault）真分潤上鏈。
- **可發現性**：`GET /` 回服務目錄（network / asset / payTo / pricing）。
- 對應 ERC-8183「agent-native commerce」：機器可讀定價 + 即時鏈上結算 + 可程式化購買。

## 2. 驗證層 — ERC-8126（agent 可驗證性）

ERC-8126 把 agent 的可信度拆成五類驗證，並彙整成單一 **0–100 風險分數**（越低越安全）。
本專案在 `agent/shared/src/verification.ts` 實作其**忠於規格的子集**，產出 ERC-8126 形狀、
由 verifier EIP-712 簽章的 attestation；端點 `GET /agent/:did/verification` 對外提供查詢。

### 五類驗證（對齊 EIP-8126 命名）

| 代碼 | 名稱 | EIP-8126 用途 | PepeLab 實作 | 分數含義 |
|------|------|----------------|--------------|----------|
| **ETV** | Ethereum Token Verification | 驗證關聯合約之合法/存在 | 結算 USDC + `PerpetualExchange` 之 `eth_getCode` 非空 | 全在鏈上＝0；缺一比例計分 |
| **MCV** | Media Content Verification | 驗證媒體內容 | **N/A**（交易 agent 無 `imageUrl`） | 不適用、排除於平均 |
| **SCV** | Solidity Code Verification | 驗證合約原始碼 | 核心合約（Perp/FeeRouter/SessionMgr）原始碼已於瀏覽器驗證（Etherscan V2 multichain API）+ bytecode 非空 | 已驗證源碼＝0；僅 bytecode（無 API key）＝30；有碼未驗源＝60；無碼＝100 |
| **WAV** | Web Application Verification | agent web 端點可達且安全 | x402 API 為 HTTPS、根路徑 200、付費端點回 402 | 三項等權，全過＝0 |
| **WV** | Wallet Verification | 錢包持有與鏈上風險 | session 錢包為非零 EOA + 鏈上交易史 + （可選）簽 challenge 出示持有證明 | 各子項計分 |

### 統一風險分數（EIP-8126 區間）

`overallRiskScore` ＝適用檢查分數的**平均**。區間：**0–20 低 / 21–40 中低 / 41–60 偏高 /
61–80 高 / 81–100 嚴重**（與規格一致）。

### 防竄改

每項檢查算出 `proofId = keccak256(規範化結果)`，五項彙整為 `summaryProofId`；verifier 用
EIP-712 簽 `{ subject, overallRiskScore, summaryProofId, issuedAt }`。`verifyAgentVerification`
會**重算所有 proofId + 重算分數 + 還原簽章者**，三道一致才算 valid——竄改任一檢查或分數即被擋。

### 簡化處（相對完整 EIP-8126，列為後續工作）

1. **無 ZK**：`proofId`／`summaryProofId` 為 keccak 摘要，**非**規格中的零知識 PDV proof。
2. **單一 verifier**：本程序自身為唯一 verifier（`VERIFIER_PRIVATE_KEY` 或一次性隨機錢包），
   未接 verifier 網路 / 鏈上 Validation Registry。
3. **身分以 did:pkh 取代 ERC-721 `agentId`**：沿用本專案 ERC-8004 風格 DID，未用鏈上 Identity Registry 的 token id。
4. **SCV 源碼驗證需 `ETHERSCAN_API_KEY`/`BASESCAN_API_KEY`**；未設時退為 bytecode-only 並如實標註。

### 2.1 對照 ERC-8126 Final：逐條差距表（2026-10-02）

規格原文：<https://eips.ethereum.org/EIPS/eip-8126>（原始檔 <https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8126.md>，
`status: Final`，`requires: 155, 191, 712, 721, 3009, 8004`）。下表「條文」引自 Specification 一節；實作位置是
`agent/shared/src/verification.ts`（以下稱 verification.ts）與 signal-api `GET /agent/:did/verification`。

| # | 條文（規範強度） | 現況 | 判定 |
|---|---|---|---|
| 1 | 驗證請求 MUST 以 ERC-8004 `agentId`（Identity Registry 的 `uint256` tokenId）指定 agent | 以 `did:pkh` 指定；本專案 agent 未在 8004 註冊 | ❌ 不合規（需先完成 §3 的註冊） |
| 2 | MUST 呼叫 canonical Identity Registry 的 `tokenURI(agentId)`，從 registration JSON 取出所有 metadata | 檢查對象（合約、URL、錢包）由本程序設定決定，不讀 registration file | ❌ 不合規 |
| 3 | 沒有 `agentId` 而直接送個別參數 NOT permitted | `/agent/:did/verification` 正是以位址直接驗證 | ❌ 不合規 |
| 4 | 合規 provider MUST 實作**全部**五種驗證 | ETV、SCV、WAV、WV 有；MCV 只回「不適用」（agent 沒有 `imageUrl`） | 🟡 MCV 未實作；目前沒有圖片所以不觸發 |
| 5 | ETV：`contractAddress` 存在時 MUST `eth_getCode` 非 `0x` | 對結算 USDC 與 `PerpetualExchange` 做 `eth_getCode` | ✅（對象來自設定而非 registration file，見 #2） |
| 6 | ETV：MUST 比對已知漏洞樣式 | 沒做 | ❌ |
| 7 | ETV／MCV／SCV／WAV／WV：MUST 產出 0–100 分數 | 每項 0–100 | ✅ |
| 8 | ETV／SCV：SHOULD 依 OWASP SCSVS | 沒有 | ⚠️ SHOULD 未做 |
| 9 | MCV：MUST 驗證來源與內嵌 metadata、竄改跡象、浮水印／簽章；SHOULD 鑑識、C2PA | 沒做（N/A） | ❌（觸發條件不成立時不影響；有圖片就必須做） |
| 10 | SCV：`solidityCode` 存在時 MUST `eth_getCode` 非 `0x`；MUST 檢查常見漏洞（reentrancy、flash loan） | 只做 bytecode 非空＋瀏覽器源碼已驗證；不做漏洞檢查 | 🟡 前半 ✅、漏洞檢查 ❌ |
| 11 | WAV：MUST 確認 HTTPS 端點有回應 | 檢查 HTTPS、`GET /` 200、付費端點回 402 | ✅ |
| 12 | WAV：MUST 檢查常見安全弱點；SHOULD 依 OWASP WSTG | 沒做 | ❌ |
| 13 | WAV：MUST 驗證 SSL 憑證有效 | 只靠 Node 的 TLS 驗證（連線失敗即不通過），沒有獨立檢查到期、鏈、主機名 | 🟡 隱含、未明示 |
| 14 | WV：MUST 確認錢包有交易紀錄 | `getTransactionCount > 0` | ✅ |
| 15 | WV：MUST 比對威脅情資資料庫 | 沒做（KYA／KYT 未實作，見 `KNOWN_LIMITATIONS.md` §17） | ❌ |
| 16 | 整體分數 MUST 為適用項目分數的平均；五個等級與區間 | `computeRiskScore` 取平均、MCV 不適用不計；等級與區間一致 | ✅ |
| 17 | 錯誤 MUST 使用標準錯誤碼 `0x01 InvalidAddress` … `0x0D MediaVerificationFailed`；SHOULD 以同名 Solidity error revert | 回 HTTP 錯誤與自訂訊息，未對應標準碼 | ❌ |
| 18 | MAY 收費；收費時 MUST 事先揭露、SHOULD 用 USDC 與 EIP-3009 | 端點免費 | ✅（不適用） |
| 19 | MAY 把結果與 Proof ID 寫進 ERC-8004 Validation Registry | 沒寫 | — MAY |
| 20 | 鏈上元件為選用；若部署 SHOULD 至少有 `AgentVerified`、`AttestationPosted` 事件與 `getLatestRiskScore(uint256)` | 沒有鏈上元件 | — 選用 |
| 21 | PDV：Proof ID 是 ZKP 的識別碼；SHOULD 用成熟 ZKP 系統 | `proofId` 是 keccak 摘要，不是 ZKP（上面「簡化處」1） | ⚠️ 名稱沿用、性質不同 |
| 22 | 撤銷／到期／重新驗證 | 規格**沒有**任何 MUST／SHOULD（只在 Security Considerations 提到可重新驗證） | 本實作多做：attestation 帶 `expiresAt`、驗證時必查 |

規格本身的不一致（觀察，不是我們的差距）：8126 要求從「ERC-8004 registration schema」取出
`walletAddress`、`contractAddress`、`solidityCode`、`chain_id`、`url`、`imageUrl`，但 8004 的 registration file
只定義 `type, name, description, image, services[], x402Support, active, registrations[], supportedTrust`，
`agentWallet` 是鏈上 metadata（`getAgentWallet`）。要合規，registration file 得自行擴充欄位，或讓 WV 改讀鏈上 `agentWallet`。

**結論**：本專案是「8126 形狀的驗證層」，不是合規的 8126 provider。最大的結構性差距是 #1–#3（必須以 8004 `agentId`
為入口），其次是各項的「漏洞／威脅情資」檢查（#6、#10、#12、#15）與標準錯誤碼（#17）。補 #1–#3 的前提是 §3 的註冊。

### 與 x402 / 下單的連接

- **查詢**：`GET /agent/:did/verification` 回完整 attestation（免費、可被對手方/marketplace 探索；列於 `GET /` 目錄）。
- **MCP 讀工具**：`get_agent_verification`。
- **下單 gate（旗標，預設關）**：`RISK_GATE_ENABLED=true` 時，`open_position` 在「授權 VC」之外，
  另要求 agent 自身 `overallRiskScore ≤ RISK_SCORE_MAX`（預設 40）才放行；預設關閉以維持向後相容。
- **WV 強化（Track 3）**：agent 身分 = `did:pkh`；授權 = 使用者簽發的 **W3C VC**，verifier
  在下單前 `verifyAuthorizationVC` + 鏈上 `getSession` 交叉比對。竄改 VC / 換 agent → 驗證失敗、
  拒絕下單。詳見 `docs/AGENT_IDENTITY_VC_SSI.md`。
- **Demo**：`agent/examples/agent-verification.ts`（五項結果 + 風險分數 + 正反竄改）。

## 3. 身分層 — ERC-8004（agent 身分註冊）

- **現況（鏈下）**：每個 agent 有 `did:pkh:eip155:84532:<address>` DID；使用者用 VC 授權該 DID，
  並可用簽章的狀態清單撤銷個別 VC（[ADR-016](ADR-016-vc-credential-status.md)）。
- **對應 ERC-8004**：8004 的 Identity Registry 是 ERC-721：`register(agentURI)` 鑄出 `agentId`，
  `agentURI` 指向 registration file。本專案的 DID + VC 是其**鏈下對應**；註冊後 agent 同時有 `agentId`
  （8126 的入口，見 §2.1 #1–#3）與 did:pkh（授權 VC 的 holder），兩者以 registration file 的 `DID` 服務互相指向。

### 3.1 Base Sepolia 上的 registry（2026-10-02 查證）

| Registry | 位址 | 列在哪裡 | 鏈上確認 |
|---|---|---|---|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | [erc-8004-contracts README「Base Sepolia」](https://github.com/erc-8004/erc-8004-contracts/blob/master/README.md) | 有程式碼（ERC-1967 proxy）；`name()`＝`AgentIdentity`、`getVersion()`＝`2.0.0` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 同上 | 有程式碼；`getIdentityRegistry()` 指回上面的 Identity |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | README **未列**；列在 [scripts/addresses.ts](https://github.com/erc-8004/erc-8004-contracts/blob/master/scripts/addresses.ts) 的 `TESTNET_ADDRESSES` 與 `VANITY_DEPLOYMENT_GUIDE.md` | 有程式碼；`getIdentityRegistry()` 指回 Identity |

- 來源是 GitHub 組織 `erc-8004` 的 `erc-8004-contracts`（規格的參考實作 repo）。三個位址是 CREATE2 vanity 位址，
  **所有測試網同一組**；主網（含 Base 主網）是另一組（例如 Identity `0x8004A169…a432`），那組在 Base Sepolia 上沒有程式碼。
- 鏈上確認方式：`https://sepolia.base.org` 的 `eth_chainId`（84532）、`eth_getCode`、ERC-1967 slot、`eth_call`，
  以及 Blockscout API（`base-sepolia.blockscout.com`，三個位址都標為已驗證）。sepolia.basescan.org 被 Cloudflare 擋，**未能從那裡確認**。
- EIP 正文與 8004.org 都沒有列部署位址；沒有找到官方公告。README 提醒 Validation Registry 仍在與 TEE 社群討論、會再變動。
- Base Sepolia 上的 `agentRegistry` 字串依規格格式為 `eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e`。

### 3.2 註冊步驟（**未執行、未送出**）

工具：`agent/examples/erc8004-register.ts`。只產生資料，不持有金鑰、不連鏈、不送交易。

1. 產生 registration file（`type` = `https://eips.ethereum.org/EIPS/eip-8004#registration-v1`；`services` 帶 agent 的
   did:pkh、x402 API base URL，若對外提供 MCP 再加 MCP 端點）：
   `npx tsx examples/erc8004-register.ts registration-file --agent <agent 位址> --name "<名稱>" --api <x402 API URL>`
2. 把 JSON 放到 https 或 ipfs，取得 `agentURI`。
3. 產生未簽交易：`npx tsx examples/erc8004-register.ts calldata --uri <agentURI>` → `{ to: Identity Registry, data: register(string), value: 0, chainId: 84532 }`。
4. **由 agent 的擁有者（營運方或租戶）用自己的錢包送出**，從 `Registered(agentId, agentURI, owner)` 事件取得 `agentId`。
   擁有者就是 ERC-721 的 owner；不要用 agent 的 session key 註冊（它不該持有身分 NFT 的所有權）。
5. 用 `--agent-id` 重產 registration file（`registrations: [{ agentId, agentRegistry }]`），以 `setAgentURI` 更新（同樣由擁有者送）。
6. （可選）把 session key 綁成 `agentWallet`：`wallet-typed-data --agent-id <id> --wallet <session key> --owner <擁有者> --deadline <現在+≤300 秒>`
   產生 EIP-712 資料，由**新錢包**簽，再由擁有者呼叫 `setAgentWallet`。domain（`ERC8004IdentityRegistry`／`1`）與
   typehash 取自參考實作 `IdentityRegistryUpgradeable.sol`，規格正文沒有給 typed-data 結構，送出前要對照部署的版本。

注意：8004 仍是 Draft，介面可能再變；白標租戶各自擁有自己的 agent 身分（ADR-008），註冊由租戶決定。

---

## 缺口與後續（roadmap）

1. **ERC-8004 註冊**：工具已備（§3.2），送不送由擁有者決定；註冊後才能補 8126 的 `agentId` 入口（§2.1 #1–#3）。
2. **授權撤銷上鏈**：鏈下狀態清單已實作（ADR-016）；鏈上撤銷登記（或 8004 Validation Registry）為後續，見 ADR-016 §6。
   最強的撤銷仍是 `AgentSessionManager.revokeSession`。
3. **ERC-8126 強化**：§2.1 的 ❌ 項（漏洞樣式、威脅情資、WAV 弱點與憑證、標準錯誤碼、MCV）；ZK PDV proof、
   verifier 網路 / 鏈上 Validation Registry（取代本輪單一 verifier + keccak 摘要）。
4. **ERC-8183 擴充**：更多付費端點與動態定價、跨 agent 結算。

_最後更新：2026-10-02（P2-11：ERC-8126 Final 逐條差距、ERC-8004 Base Sepolia 查證與註冊步驟、VC 撤銷 ADR-016）。_
