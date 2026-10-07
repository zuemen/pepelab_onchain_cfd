# RWA＋SSI PoC 部署紀錄（Base Sepolia）

租戶 `rwa-poc`，設定檔 `deploy/tenants/rwa-poc.json`（schema v4），部署紀錄 `deploy/tenants/rwa-poc.deployed.json`，
廣播紀錄 `contracts/broadcast/tenants/rwa-poc/`。錢包與入金見 [WALLETS.md](WALLETS.md)。

## 結論

| 項目 | 結果 |
|---|---|
| 部署日期 | 2026-10-07（UTC） |
| 部署者 | `0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE`（加密 keystore `pepelab-rwa-deployer`；部署結束後不持有任何權限） |
| DeployTenant | 164 筆交易全部成功，區塊 47781302–47781465（`deployBlock` 47781289） |
| 廣播前模擬 | Base Sepolia fork 上完整模擬，腳本內讀回驗證 133 項 ok |
| VerifyTenant（真鏈、`TENANT_PRIVILEGE_SCAN_REQUIRED=true`） | 131 項 ok、0 FAIL；權限歷史掃 185 個區塊、47 筆授權事件，每個位址只持有應有的權限 |
| 唯一 NOTE | oracle 無參考來源（`referenceSource: none`），keeper 寫價只受單次上限與時間窗限制 |
| KYC | `kycRegistry: vc`：交易所接的是 admin 擁有的 `VCKycRegistry`，`requiredType` = `QUALIFIED_INVESTOR` |
| RWA 旗標 | 內建 8 檔（sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL、sICLN、sESGU、sBOND）＋追加 sGOLD |

## 合約

| 合約 | 位址 | 建立交易 |
|---|---|---|
| ExchangeOpsLib | `0x2faa5382d118aa9e5e4d50040e02efbfb72ebfaf` | [0xbef037c8…](https://sepolia.basescan.org/tx/0xbef037c8abfc68329c301d784a76a9798681355f409ac22ab15013258e496d59) |
| GuardedOracle | `0x249a6ce5b467a4f44dc6378be313d681b2c4358a` | [0x936b6d89…](https://sepolia.basescan.org/tx/0x936b6d89d5ad34b6bf988ac9feda4fd5ee6db8ebb1d9132212e0fea022550580) |
| ESGRegistryV2 | `0x91ccbbbcef651c2b1e57117a5b0decde23de572b` | [0xaa5cc94e…](https://sepolia.basescan.org/tx/0xaa5cc94e189a8675227f648c10a6b150ee7ece5ecda0ae866f3570fba60534df) |
| VCKycRegistry | `0x3869405c4641c72e5f01ead9ced69139b4d830bd` | [0x2281de25…](https://sepolia.basescan.org/tx/0x2281de25ab4578b056f97af5eb6468e7803da661c63c460ffc3adaaad8e09a85) |
| InsuranceVault | `0x792f0b2072cb3c65d618c50ae31c7802b8909035` | [0x61e29045…](https://sepolia.basescan.org/tx/0x61e2904523c8dd3ebd51e6d6ed39ab83b5e226d836b870f76218fc3b57246c01) |
| InsuranceSeeder | `0xae18a14e91973b5ecd0abd0c3c334538defcd555` | [0x76cd632a…](https://sepolia.basescan.org/tx/0x76cd632a72ad75918d6201870b13a062f94193f62d0c1de0f9013a87f863c557) |
| FeeRouter | `0x622a4c0afd20105c5be28fa5e39d3808ffb065df` | [0x9003e468…](https://sepolia.basescan.org/tx/0x9003e4680b7d17e9971bd479f8d6b21762fbbbc5c8c9f54afdeca411e598ce7b) |
| TraderStake | `0x2a7be6faccb9b00337ff52712430c835cced1034` | [0x06207587…](https://sepolia.basescan.org/tx/0x062075871ea674b4e97bf6ee62cf6e95a63f687a06cf51b3c64ad09310ead4a7) |
| PerpetualExchange | `0xbb7f8059ed5450889c745f5c1f458cb1290fa96b` | [0x34fa022c…](https://sepolia.basescan.org/tx/0x34fa022c2c42243fe5ebebaf2568fc8e522b1bad994a9b0a3ad4e685828a933b) |
| StrategyRegistry | `0x2a1a974ba8ed424cd6acf035a17a88c1816eece9` | [0xb24cb062…](https://sepolia.basescan.org/tx/0xb24cb062dfe2fef4b8d4a0d9b6b145809c1e2fbc5e1044b0dcd8e42c6f0b1610) |
| CopyTracker | `0x48e770d50e7c1ac2f0c098a70b28bd5e641cdd0a` | [0x558ef309…](https://sepolia.basescan.org/tx/0x558ef30901327e0dc52f597a95c496ff76ca7496df67dce2b3f79ae0ba56d893) |
| AgentSessionManager | `0xa60a1dc20e1cbb0cbc869464e35aeba6ff3acbdd` | [0xbed3ea08…](https://sepolia.basescan.org/tx/0xbed3ea08f01ee207025075833edf7e3787d488221fe4f24e819a55c2215971df) |
| AssetVaultV2_5 | `0x6a6a20176e480985ea90f717d5c64898be0ffce9` | [0xeab8c347…](https://sepolia.basescan.org/tx/0xeab8c34748de60020342ff2a17a140392bd7fab1f28ec0a2a1680772fab2f359) |
| ERC1967Proxy | `0x9e77476bb4fe36259e729628cf4a38f54107720b` | [0x808469ae…](https://sepolia.basescan.org/tx/0x808469ae8508c861902ce95bc63a2d80308719613f0f574015025fea35006596) |
| SyntheticAssetV2 | `0x17792ed0e52688cdfa5698ffc3a09531634b61af` | [0x50c88d6e…](https://sepolia.basescan.org/tx/0x50c88d6e14ceb75a9e601244a8d4c371c1dffd7dfef9ffaefb7fe48e174ccd44) |
| SyntheticAssetV2 | `0x79e05b58980eecd7096e6acdf073439ba827a74a` | [0xacff0d49…](https://sepolia.basescan.org/tx/0xacff0d49f7987d4712b4087b23303987621be4ab992062974410794c6d66f25c) |
| SyntheticAssetV2 | `0xda3e3096198c587dd5ce1d3c96057a3cbeb37dc8` | [0x7a867538…](https://sepolia.basescan.org/tx/0x7a867538735e580f8f290828d53aa07efc95bd310d60a01795079aef172d9c59) |
| SyntheticAssetV2 | `0x5d544ee95a2a71cb9d612238b9e1fc83b01a2c7e` | [0xca890dca…](https://sepolia.basescan.org/tx/0xca890dca59a8ef0dcf019e52da430e3dceca6e048402334d97a5f66ef37396f6) |
| SyntheticAssetV2 | `0x0bcee6225bca305881412edc9fdab17434f74e8a` | [0x51240dff…](https://sepolia.basescan.org/tx/0x51240dfff5d19cd6341a2026096edbd5a8de0e12426f28c2b8a8f9b7faa74b2d) |
| SyntheticAssetV2 | `0xbc2755b55462af20ae73acaabc30b6bc5f5db2f5` | [0xba28e74f…](https://sepolia.basescan.org/tx/0xba28e74f052fa46f14bd3a623567d9679424c075e6fca6a09a912fb13d2044b2) |
| SyntheticAssetV2 | `0xe4981caf202c43ea9df9bfc5ff059bdd7b5fde7a` | [0x81465b02…](https://sepolia.basescan.org/tx/0x81465b02b562f15f7f75f63e4d843fd44069085b2e2812aff508b3ce0cfa43de) |
| SyntheticAssetV2 | `0x631551d7695b16155cdbd5d9f8e394b65ca50620` | [0x05fd8bc6…](https://sepolia.basescan.org/tx/0x05fd8bc6ccbb39f91257748ac1ee2e8f714909932bdeebf8f1ed8ca25f147568) |
| SyntheticAssetV2 | `0xd00b097fed3b82a7fd316f42dc42a188b8ef6672` | [0x829f9320…](https://sepolia.basescan.org/tx/0x829f9320b9684d89a1bb48fa759acf39695b4a7019eb1a9f913580df4170d767) |
| SyntheticAssetV2 | `0xd0fb912e3fcc9bd9f1dc78a52007b88953670a34` | [0xf6018018…](https://sepolia.basescan.org/tx/0xf60180181e7a2a179b00a4526e1148da5efc1c92929dc518037a8a507abf5a6e) |
| SyntheticAssetV2 | `0xfde7ff38174c43c1b788f634113beb7c32747cf6` | [0x87249d6a…](https://sepolia.basescan.org/tx/0x87249d6ae9cd627865b79338c0fdb9dbec527b61c6404a234f6a6a83bc8652b3) |
| SessionCredentialAnchor | `0x80269C6FfEbce234d6b24979735D987C8e0e5fBD` | [0xd11baa7a…](https://sepolia.basescan.org/tx/0xd11baa7a68fa18b2eacf626838599e8de1af12a18cd36cdc3a00ec1b49592c94) |

- `ERC1967Proxy` 是 `AssetVaultV2`（UUPS），實作是 `AssetVaultV2_5`（紀錄的 `AssetVaultV2Impl`）。
- `SyntheticAssetV2` 依序為 sAAPL、sTSLA、sNVDA、sMSFT、sGOOGL、sICLN、sESGU、sBOND、sGOLD、sETH、sBTC（位址見部署紀錄 `tokens`）。
- `SessionCredentialAnchor` 由部署者另外部署（無 admin），指向本租戶的 `AgentSessionManager` `0xa60a1dC20E1CBb0cBc869464E35AEBa6ff3acbdd`。

## 部署後設定

| 步驟 | 錢包 | 交易 |
|---|---|---|
| `VCKycRegistry.setIssuer(issuer, QUALIFIED_INVESTOR, true)`，issuer = `0xf67bA3C2F6E710415F548C09b73808ba19b9cD83` | admin | [0x2c0bb587…](https://sepolia.basescan.org/tx/0x2c0bb587bfa5bd23a3fd078993918ae81b1330e90d5742f0c7ced0532df94a54) |
| `ESGRegistryV2.grantRole(ATTESTOR_ROLE, attestor)`，attestor = `0x217d7A850770da61AD596D98b5334BC22E7D7f0B` | admin | [0xa3f5c8d5…](https://sepolia.basescan.org/tx/0xa3f5c8d5a65e49682b6bab9d32461f7c723cb220f496f509d2979c71f2188c81) |
| 部署 `SessionCredentialAnchor` | 部署者 | [0xd11baa7a…](https://sepolia.basescan.org/tx/0xd11baa7a68fa18b2eacf626838599e8de1af12a18cd36cdc3a00ec1b49592c94) |

### 碳分級見證（`AttestTenantCarbon.s.sol`，attestor 錢包）

見證者是 PoC 自己的錢包，不是獨立的第三方機構：分級來自 repo 的 `CarbonAttestations`（與平台相同的清單），
代表的是營運方自己的陳述。

| 資產 | 分級 | 交易 |
|---|---|---|
| sBTC | 3 | [0x69d31fee…](https://sepolia.basescan.org/tx/0x69d31feef513e2bc902f2f3b02a7f1954c09b58e9bf991a37e6d5536fd56f5f1) |
| sETH | 1 | [0xa59a59d6…](https://sepolia.basescan.org/tx/0xa59a59d69fcaed0ded11d058540bc0ff970fbf82863ff3e720021545a8ba0799) |
| sAAPL | 1 | [0xd838a503…](https://sepolia.basescan.org/tx/0xd838a503d6c43db7a356876c445b7015ad26f77e16b8aa24384ea69466c9565c) |
| sTSLA | 3 | [0x3cce2244…](https://sepolia.basescan.org/tx/0x3cce2244df74ad89ca6cbc2c8553eb17bf49d0bcba1ff78a300ed5f435628609) |
| sGOLD | 3 | [0x6ec641dd…](https://sepolia.basescan.org/tx/0x6ec641ddc10332a26dda8c6b3fe8fe2405a9117c9d5104d72e45bf48ce7d9867) |
| sBOND | 1 | [0xf05dd545…](https://sepolia.basescan.org/tx/0xf05dd545591766c0158f6424fa6faf8c9a20f76bc14b5763a5bec6f5291b553d) |
| sNVDA | 1 | [0x4c7c6f63…](https://sepolia.basescan.org/tx/0x4c7c6f63ccef7786e8ef285493b13c4dc0b4bd66f03a8473f9a81d18454f8373) |
| sMSFT | 3 | [0xa8d74d5b…](https://sepolia.basescan.org/tx/0xa8d74d5ba2eb22d205a0df20f0926fbd98d88741e4513cbd0027c4276cedbece) |
| sGOOGL | 3 | [0x1b55fee2…](https://sepolia.basescan.org/tx/0x1b55fee25d56ff4ac5a9fe38b7deaabd5e86bfb589a4b908a6b768bb0b3e9f4b) |
| sICLN | 1 | [0xa9d350a0…](https://sepolia.basescan.org/tx/0xa9d350a02beaab2806224082a8b5465ab3d1694f4fb8179b2c3892b590d088d0) |
| sESGU | 2 | [0x4d08c496…](https://sepolia.basescan.org/tx/0x4d08c4968982bfb07620869fd22603fa958fad109c0a01ba69418c16fb7cb30c) |

## 重現與讀回

```bash
cd contracts
# 讀回整組（唯讀）
TENANT=rwa-poc forge script script/VerifyTenant.s.sol:VerifyTenant --rpc-url https://sepolia.base.org -vv
# 檔案層檢查
node ../scripts/check-tenant-deploy.mjs
node ../scripts/post-deploy-smoke.mjs --tenant rwa-poc --skip-http   # 只做鏈上檢查；本機 signal-api 在跑時改用 --signal-api http://localhost:4021
```

部署用的指令（先 fork 模擬、再以加密 keystore 廣播）見 `docs/TENANT_DEPLOYMENT.md` §3–§5 與
`docs/HANDOFF_RWA_POC.md` 第 4 步。

## 營運驗收（S4）

### 推價（`scripts/poc/rwa-poc-keeper.sh --once`，keeper 錢包，加密 keystore）

先乾跑一輪（不送交易、`failed=0`），再實送。摘要：`available=11 skipped=0 rejected=0 wrote=11 failed=0`。

| 資產 | 寫價交易 |
|---|---|
| sBTC | [0xb0cd80a9…](https://sepolia.basescan.org/tx/0xb0cd80a9503a40bf1d7d42ca420fb6626b866e0350bbfa338841546c0d3897ae) |
| sETH | [0xdf58372b…](https://sepolia.basescan.org/tx/0xdf58372bb028133d6f4b1bce63d53de5a6fa48da7f420a4b7dc418a97204a211) |
| sAAPL | [0x0f5fe0b9…](https://sepolia.basescan.org/tx/0x0f5fe0b97573757330a982d1e80d8c904ce5ac861aadae81e1d392be460c4eb8) |
| sTSLA | [0xd754b3ee…](https://sepolia.basescan.org/tx/0xd754b3ee564d45f71993c7bf6d74ec37fca11ebed7684f69240be3279ad26293) |
| sNVDA | [0x086a022d…](https://sepolia.basescan.org/tx/0x086a022d2f1b471c34d18dd17ce684d4743b560498b20c09a7188d446e62a0ab) |
| sMSFT | [0x3e4c86e0…](https://sepolia.basescan.org/tx/0x3e4c86e059b2a7381a75bf808ad6dd3cd23da91799269e7ef944091964b2d02a) |
| sGOOGL | [0xca7cf3f0…](https://sepolia.basescan.org/tx/0xca7cf3f07e45b61cb3015fbbe5e4b544ab1a905c2025f725ca3e0acec9ba22bf) |
| sGOLD | [0xe0cff4ee…](https://sepolia.basescan.org/tx/0xe0cff4ee64ec1393f15a1d1d0f96fb3f24fc35fedf57f3d5951f028d9bd98554) |
| sBOND | [0x98fcb687…](https://sepolia.basescan.org/tx/0x98fcb687f1d87fce4f92a12b71610a44c921bcdd8a3a28d441d4d5db6d5eca8a) |
| sICLN | [0xfd5501f0…](https://sepolia.basescan.org/tx/0xfd5501f05647d369dbc7e799ac8e21e8806c2df00e8b15473010b35e87b29c74) |
| sESGU | [0xfab6b879…](https://sepolia.basescan.org/tx/0xfab6b879ebe5cffc4d4b7414b68556b7764432919d9cdf7e831063d5d6fca5b5) |

keeper 同一輪也以 marketOperator 身分依交易所行事曆切換休市（美股收盤時段）：

| 資產 | 切換 | 交易 |
|---|---|---|
| sAAPL | 行事曆休市：Active → ReduceOnly | [0x1f35edef…](https://sepolia.basescan.org/tx/0x1f35edefa4d0602a0b9a8c32ffb06742ecab97322d4c9eed042be95b3b1fa6c8) |
| sTSLA | 行事曆休市：Active → ReduceOnly | [0x100cdf5c…](https://sepolia.basescan.org/tx/0x100cdf5c33957cde82e43df08aac80ab21d2bbec6026f2c58cc0efda1048b0f2) |
| sNVDA | 行事曆休市：Active → ReduceOnly | [0x73325e62…](https://sepolia.basescan.org/tx/0x73325e62a997607abbd5854febb2c9d061729a5b5ae8c3a54bd69e7d62c6d890) |
| sMSFT | 行事曆休市：Active → ReduceOnly | [0x516f8080…](https://sepolia.basescan.org/tx/0x516f80809d501ffd5081f600d6209194fe9578909009eaa7848e309cae549a4a) |
| sGOOGL | 行事曆休市：Active → ReduceOnly | [0x752a07c9…](https://sepolia.basescan.org/tx/0x752a07c95bdf9e077270e8d256db24830e17e703e14f8dc4ca7846b9a1e3d8f4) |
| sBOND | 行事曆休市：Active → ReduceOnly | [0xadad544e…](https://sepolia.basescan.org/tx/0xadad544e6418d9862a21e6f2ecc90cb78c12a5ed884987ddaf27c89c4189275f) |
| sICLN | 行事曆休市：Active → ReduceOnly | [0x9f765a28…](https://sepolia.basescan.org/tx/0x9f765a28adf0a545a7c6b39d62d7a938e767d623db729f3de7e4689cbeb1a875) |
| sESGU | 行事曆休市：Active → ReduceOnly | [0xfad4e493…](https://sepolia.basescan.org/tx/0xfad4e4936687671a0c87b69d0e552b41d1988fd9983dd53ab670145fd73f9c21) |

`observeReserve()`：[0x9a21302e…](https://sepolia.basescan.org/tx/0x9a21302eb681d5c4dca583242e880ba98bc07e97e1974d070d8a34be8edb74bb)

### 休市示範（sETH，投資人錢包）

sETH 不是 RWA、不需要合格投資人憑證，keeper 也不自動切它，所以用它示範 ReduceOnly 的行為最乾淨。

| # | 步驟 | 錢包 | 結果 | 交易 |
|---|---|---|---|---|
| 1 | 轉 300 MockUSDC 給投資人 | 部署者 | 成功 | [0xd91e4e5e…](https://sepolia.basescan.org/tx/0xd91e4e5ebdae41db6a5a69cb8a2845931a7561897105511b479e3707e2f54c64) |
| 2 | `approve` 交易所 | 投資人 | 成功 | [0xde5a2cac…](https://sepolia.basescan.org/tx/0xde5a2cac5c1a269aa9f000b4d579b382fb7de2c6b10c7dacab8dc843af5b8692) |
| 3 | `depositMargin(200)` | 投資人 | 成功 | [0xe0c9566e…](https://sepolia.basescan.org/tx/0xe0c9566e06f2ea346d4b3886d32b6485c204f883a2d2ea40dadb7c76415a27f0) |
| 4 | Active 時開 sETH 多單（保證金 20、2x），倉位 #0 | 投資人 | 成功 | [0x8bb0e953…](https://sepolia.basescan.org/tx/0x8bb0e953deab9fe884457509e760d591e92db0ec6576452e4cf5cd9f3cd1fea3) |
| 5 | `setAssetMode(sETH, ReduceOnly)`（`rwa-poc-market-mode.sh sETH 1`） | keeper（marketOperator） | 成功 | [0xd204c5ba…](https://sepolia.basescan.org/tx/0xd204c5bab2bed2876361f21f2adcc3ea5194311dd2e148166ca716437b56cd8a) |
| 6 | ReduceOnly 時再開倉 | 投資人 | **被拒**：`AssetNotActive(sETH, ReduceOnly)`（交易上鏈並 revert，status 0） | [0xd71ccda6…](https://sepolia.basescan.org/tx/0xd71ccda6b670367af722d473acd448491fd852adc2e9455f5cf32008cb93790d) |
| 7 | ReduceOnly 時平倉 #0 | 投資人 | 成功 | [0x1b8457e6…](https://sepolia.basescan.org/tx/0x1b8457e6c0a06eff356ddf7c9be09a5d1845bc6e5ecbbf8f8321435e96e915a0) |
| 8 | `setAssetMode(sETH, Active)` | keeper（marketOperator） | 成功 | [0xa6af46cc…](https://sepolia.basescan.org/tx/0xa6af46cccb239b916ff1ad1020dcd3a5463ab6f4b5d813ad071bddb47bc38828) |

第 6 步刻意以固定 gas 送出（跳過預估），讓「被拒」留下可在 BaseScan 查到的鏈上證據；送出前的 `cast call` 模擬同樣回 `AssetNotActive`。
