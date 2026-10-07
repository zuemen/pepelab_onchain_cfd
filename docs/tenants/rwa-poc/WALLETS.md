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

- 部署者以外的 9 把：2026-10-06 由新電腦以 `cast wallet new` 建立（加密 keystore），同日由部署者入金（每筆先 `cast estimate` 模擬再送出，全部 status 1）：

  - MockUSDC faucet（部署者 1,000 顆，保險種子用）：[`0xb191…1fde`](https://sepolia.basescan.org/tx/0xb19157eac05c772fd599b34e05d50a86475050b7f628d216fca635b0cea01fde)
  - keeper 0.1 ETH：[`0x5e89…0149`](https://sepolia.basescan.org/tx/0x5e899dd6e5b2cde21c0da6eec97c8a57eddf5fe4e0600e17a699063d70f10149)
  - admin 0.03 ETH：[`0x3e82…4ac1`](https://sepolia.basescan.org/tx/0x3e82ba7c9ba949ca6fb01c94106ec9d4e4bfa4f1924dd012f0e9912cdb6d4ac1)
  - guardian 0.01 ETH：[`0x80f0…3dbd`](https://sepolia.basescan.org/tx/0x80f0f2a7a41c72dd5144899d6090c286859d7604e6ec0d756d263b78823b3dbd)
  - risk 0.005 ETH：[`0x2f40…d80e`](https://sepolia.basescan.org/tx/0x2f4082df9e4693c50a8abb8c3c8a9eb8ee72b983f4f78a67a40d2400e498d80e)
  - attestor 0.01 ETH：[`0x3fe8…80f9`](https://sepolia.basescan.org/tx/0x3fe83b27d176063636cd2f6e5bfa43f6c4ad0b1eddd809190635fb3d420d80f9)
  - issuer 0.01 ETH：[`0x0690…9f81`](https://sepolia.basescan.org/tx/0x0690678e35437fa1f5600137df540daf3d4b5468bf5aa5cfbfc31761f8cd9f81)
  - investor 0.03 ETH：[`0x641d…44af`](https://sepolia.basescan.org/tx/0x641d0120da28788622ee98b4f429deba48c3dfc2e318bc6b931dbf800b8a44af)
  - agent 0.03 ETH：[`0x8e4a…b531`](https://sepolia.basescan.org/tx/0x8e4a8ce821106f7c6f08ae33716f4ea028b42f977be911cecabcdb6ddf91b531)
  - payto 0.01 ETH：[`0xb763…ffa6`](https://sepolia.basescan.org/tx/0xb763b174d11873af463c7b128e0a1ed4f452747b4db6138609378b2e8963ffa6)
- 部署者：Base Sepolia 有 0.8 ETH，從 Sepolia 跨鏈而來（L1 tx [`0x8f5d…a0e7`](https://sepolia.etherscan.io/tx/0x8f5d12fa09f24e605b9a96269ef4ca9acc441abe169dccca5cf3404e685ca0e7)）。

## 錢包表

| 名稱 | 位址 | 角色 |
|---|---|---|
| `deployer` | `0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE` | 部署整套合約；`DeployTenant` 結束時不留任何權限 |
| `admin` | `0xC0f050fDeD9330169d3b6fD91D731799b26a7f00` | 租戶 `roles.admin`：所有合約的 owner／DEFAULT_ADMIN，兼 `roles.treasury`。這是測試網 EOA，部署時要設 `ALLOW_EOA_ADMIN=true` |
| `risk` | `0x745637A4bEc417E3C5f32A9D2F9158E9D61878b7` | `roles.risk`（金庫 RISK_ROLE；本租戶 `deployVault: false`，沒有金庫） |
| `guardian` | `0xbB7f5F528994AEFA79bb8Cb2F660D08c28A3Cf4F` | `roles.guardian`：oracle／exchange 的限時暫停（金庫 PAUSER 只在有金庫時適用；本租戶沒有） |
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
