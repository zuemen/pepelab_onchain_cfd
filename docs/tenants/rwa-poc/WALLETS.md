# RWA PoC 錢包一覽（只列公開地址）

這份表列出 Base Sepolia（84532）上「RWA ＋ SSI 正式 PoC」用的錢包。

`docs/tenants/` 這個目錄不算進平台位址全集（`scripts/lib/platform-addresses.mjs`）。所以租戶的完整位址只寫在這裡，其他文件一律寫縮寫。

## 金鑰怎麼放、怎麼用

- 每一把都是使用者電腦上的 Foundry **加密 keystore**：
  - keystore：`~/.foundry/keystores/pepelab-rwa-<名稱>`
  - 密碼檔：`~/.foundry/pepelab-rwa-<名稱>.password`（只有本人可讀）
- 私鑰不寫進任何檔案、指令列或 GitHub。
- 使用時一律帶 `--account pepelab-rwa-<名稱> --password-file ~/.foundry/pepelab-rwa-<名稱>.password`。

## 建立與入金

- 部署者以外的 9 把：2026-10-06 由新電腦以 `cast wallet new` 建立，**尚未入金**。
- 部署者：Base Sepolia 有 0.8 ETH，從 Sepolia 跨鏈而來（L1 tx [`0x8f5d…a0e7`](https://sepolia.etherscan.io/tx/0x8f5d12fa09f24e605b9a96269ef4ca9acc441abe169dccca5cf3404e685ca0e7)）。

## 錢包表

| 名稱 | 位址 | 角色 |
|---|---|---|
| `deployer` | `0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE` | 部署整套合約；`DeployTenant` 結束時不留任何權限 |
| `admin` | `0xC0f050fDeD9330169d3b6fD91D731799b26a7f00` | 租戶 `roles.admin`：所有合約的 owner／DEFAULT_ADMIN，兼 `roles.treasury`。這是測試網 EOA，部署時要設 `ALLOW_EOA_ADMIN=true` |
| `risk` | `0x745637A4bEc417E3C5f32A9D2F9158E9D61878b7` | `roles.risk`（金庫 RISK_ROLE） |
| `guardian` | `0xbB7f5F528994AEFA79bb8Cb2F660D08c28A3Cf4F` | `roles.guardian`：oracle／exchange 的限時暫停，以及金庫 PAUSER |
| `keeper` | `0x5358cf4E0a1409F6B433Dd25Adf8c92bF0821ED8` | `roles.keeper`（推價），兼 `roles.marketOperator`（休市時切 ReduceOnly） |
| `issuer` | `0xf67bA3C2F6E710415F548C09b73808ba19b9cD83` | 合格投資人 VC 的發證者（`VCKycRegistry.setIssuer`） |
| `attestor` | `0x217d7A850770da61AD596D98b5334BC22E7D7f0B` | ESG 碳分級見證者（`ESGRegistryV2` 的 `ATTESTOR_ROLE`）。與 admin 同一控制人，也就是說見證者是 PoC 團隊自己 |
| `investor` | `0xebAFE53877ad3B691664d8cb0b34874CE1240194` | 示範投資人：持有合格投資人 VC、開 RWA 部位、簽委託 VC 給代理人 |
| `agent` | `0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7` | AI 代理人：出示 VP、用測試 USDC 付 x402、在 session 上限內下單 |
| `payto` | `0xC7F9Bd7591601E68A1874Bfe69C0d5b75bc5eFBE` | 本機 signal-api 的 x402 收款地址（`PAY_TO`） |

## 角色分離

依 `docs/TENANT_DEPLOYMENT.md` §2：

- admin、keeper、guardian、risk 兩兩不同；
- guardian 和 admin 都不兼 marketOperator；
- treasury 不是 keeper，也不是 guardian；
- 部署者不持有任何角色。

## 不屬於 PoC 的舊平台錢包

以下三把不屬於這個 PoC，完整位址見 `docs/HANDOFF_RWA_POC.md` 第 3 節：

- 現役舊合約 owner `0x27C2…A585`
- 現役 keeper `0x540a…ef17`
- 已外洩的舊部署者 `0xE80A…Eb93`

這裡刻意只寫縮寫：租戶目錄不算平台位址，寫進來會讓人誤以為它們是 PoC 的錢包。

**外洩的 `0xE80A…` 絕不可用來部署或操作 PoC 合約。**
