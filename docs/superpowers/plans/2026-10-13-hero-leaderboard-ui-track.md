# 交易者排行榜資料化 — 畫面線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供本機鏈的完整部署，並讓 Expert Mode 的交易者排行榜、交易者個人頁與跟單流程讀得到、看得到模擬交易者的績效資料。

**Architecture:** 一支只能在本機鏈執行的 Foundry 部署腳本，加一支把位址寫回前端位址表的工具。前端新增一個純函式模組解析績效資料並轉成排行榜既有的資料形狀；排行榜從過大的頁面檔拆出後接上它；個人頁新增兩個元件。沒有績效資料的鏈（Base Sepolia 展示站）畫面與今天完全相同。

**Tech Stack:** Foundry（Solidity 0.8.36）、Node 20 + tsx + ethers v6、React + Vite + MUI + recharts、vitest。

**Spec:** GitHub issue zuemen/pepelab_onchain_cfd#309（本機草稿：`docs/superpowers/specs/2026-10-13-hero-leaderboard-design.md`）。資料線計畫：`docs/superpowers/plans/2026-10-13-hero-leaderboard-data-track.md`。

## Global Constraints

- 只在本機鏈（chainId 31337）運作。部署腳本與任何寫鏈的工具連到其他 chainId 必須立刻中止。不碰 Base Sepolia 上的任何合約。
- 不修改 `contracts/src` 下任何既有合約。
- `frontend/` 只用 yarn（`yarn install --frozen-lockfile`）；`agent/` 只用 npm。
- repo 外的安裝交給人執行（見 `docs/agents/environment.md`）。開啟 Smart App Control 的 Windows 機器，`forge`／`anvil`／`cast` 只能在 WSL 執行，路徑是 `~/.foundry/bin/`。
- 合約位址一律從 `src/contracts/deployment` 取（不是 `src/contracts/addresses`）；`tenantDeployment.test.ts` 會擋。
- 元件一律 `import { t } from 'src/locales'`；新的顯示文字放進 String Catalog，`zh-TW` 與 `en` 兩份結構相同。
- 用詞照 `frontend/CONTEXT.md` 的 Expert Mode 詞彙：交易者（Trader）、跟單／跟隨（Copy／Follow）、部位（Position）、策略（Strategy）。Simple Mode 的配置市集與 `adopt` catalog 不動。
- 讀不到的資料顯示「—」，不得顯示成 0。
- 凡是出現模擬交易者或其績效的畫面，固定顯示揭露文字；它不能被收合，也不依賴任何鏈上讀取。
- 跟單在前端是預設關閉的 Authorized Feature：只用本機的環境檔打開，不改任何租戶設定的預設值。
- 分支：`feat/309-hero-ui`。每個 Task 結束提交一次。

## File Structure

```
contracts/script/DeployLocalDemo.s.sol        本機鏈的完整部署（只允許 31337）
contracts/test/DeployLocalDemo.t.sol
agent/heroes/addresses.ts                     broadcast 紀錄 → 位址；改寫前端位址表的本機區塊（純函式）
agent/heroes/addresses.test.ts
agent/heroes/writeAddresses.ts                CLI
frontend/src/lib/pepefi/heroData.ts           績效資料的型別、解析、讀取、轉成排行榜資料
frontend/src/lib/pepefi/heroData.test.ts
frontend/src/lib/pepefi/leaderboardMetrics.ts 修改：新排序鍵、TraderCard.hero
frontend/src/components/pepefi/TraderLeaderboard.tsx   從 MarketplacePage.tsx 拆出
frontend/src/pages/pepefi/MarketplacePage.tsx          只剩 Mode 切換
frontend/src/components/pepefi/hero/HeroPerformance.tsx  個人頁：績效卡、淨值曲線、月報酬
frontend/src/components/pepefi/hero/HeroTrades.tsx       個人頁：策略版本、部位列表、鏈上讀回
frontend/src/pages/pepefi/TraderProfilePage.tsx        修改：掛上兩個元件
frontend/src/pages/pepefi/CopyPage.tsx                 修改：快照說明
frontend/src/locales/{zh-TW,en}/{marketplace,traderProfile,copy}.ts   修改
frontend/.env.heroes                          本機展示用的功能旗標
scripts/heroes-demo.sh                        載入鏈狀態 + 價格寫入
```

---

### Task B1: 本機鏈的完整部署腳本

**Files:**
- Create: `contracts/script/DeployLocalDemo.s.sol`
- Test: `contracts/test/DeployLocalDemo.t.sol`

**Interfaces:**
- Produces: `forge script script/DeployLocalDemo.s.sol:DeployLocalDemo --broadcast` 在本機鏈部署並接好：`MockUSDC`、`MockSwapRouter`、`MockOracle`（11 個資產）、`ESGRegistryV2`（11 筆見證、不過期）、`KYCRegistry`、`TraderStake`、`InsuranceVault`（已注資）、`FeeRouter`、`PerpetualExchange`（碳定價開啟）、`StrategyRegistry`、`CopyTracker`、`AgentSessionManager`。所有合約的 owner／admin／見證者都是部署者。broadcast 紀錄寫在 `contracts/broadcast/DeployLocalDemo.s.sol/31337/run-latest.json`，Task B2 讀它。資料線的回放（Task A6）依賴這支腳本。

- [ ] **Step 1: 寫失敗測試**

`contracts/test/DeployLocalDemo.t.sol`：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployLocalDemo.s.sol";

contract DeployLocalDemoTest is Test {
    DeployLocalDemo internal script;
    DeployLocalDemo.Deployed internal d;
    address internal deployer = makeAddr("deployer");
    address internal trader = makeAddr("trader");

    string[11] internal SYMBOLS =
        ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

    function setUp() public {
        script = new DeployLocalDemo();
        d = script.deploy(deployer);
    }

    function _id(string memory symbol) internal pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    function _exchange() internal view returns (PerpetualExchange) {
        return PerpetualExchange(payable(d.exchange));
    }

    function _fund(address who, bool verified) internal {
        vm.deal(who, 1 ether);
        vm.prank(deployer);
        MockUSDC(d.usdc).mint(who, 10_000e18);
        if (verified) {
            address[] memory list = new address[](1);
            list[0] = who;
            vm.prank(deployer);
            KYCRegistry(d.kyc).batchVerify(list);
        }
        vm.startPrank(who);
        MockUSDC(d.usdc).approve(d.exchange, 10_000e18);
        _exchange().depositMargin(10_000e18);
        vm.stopPrank();
    }

    function test_everyAssetHasAPrice() public view {
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            (uint256 price,) = MockOracle(d.oracle).getPrice(_id(SYMBOLS[i]));
            assertGt(price, 0, SYMBOLS[i]);
        }
    }

    function test_carbonTierSetsTheLeverageCeilingAndTheFee() public view {
        PerpetualExchange ex = _exchange();
        // Low
        assertEq(ex.maxLeverageForAsset(_id("sETH")), 5);
        assertEq(ex.tradingFeeBpsForAsset(_id("sETH")), 10);
        // Mid
        assertEq(ex.maxLeverageForAsset(_id("sESGU")), 2);
        assertEq(ex.tradingFeeBpsForAsset(_id("sESGU")), 40);
        // High
        assertEq(ex.maxLeverageForAsset(_id("sBTC")), 1);
        assertEq(ex.tradingFeeBpsForAsset(_id("sBTC")), 100);
    }

    function test_attestationsOutliveATwoYearReplay() public {
        vm.warp(block.timestamp + 800 days);
        assertEq(_exchange().maxLeverageForAsset(_id("sETH")), 5);
    }

    function test_aVerifiedTraderCanOpenOnEveryAsset() public {
        _fund(trader, true);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            _exchange().openPosition{value: fee}(_id(SYMBOLS[i]), true, 20e18, 1);
        }
        vm.stopPrank();
        assertEq(_exchange().getUserPositions(trader).length, 11);
    }

    function test_regulatedMarketsNeedKycAndCryptoDoesNot() public {
        _fund(trader, false);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        _exchange().openPosition{value: fee}(_id("sBTC"), true, 20e18, 1);
        _exchange().openPosition{value: fee}(_id("sGOLD"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sAAPL"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sBOND"), true, 20e18, 1);
        vm.stopPrank();
    }

    function test_theCopyStackIsWiredAndTheInsuranceVaultIsFunded() public view {
        assertEq(TraderStake(d.traderStake).copyTracker(), d.copyTracker);
        assertEq(address(CopyTracker(payable(d.copyTracker)).exchange()), d.exchange);
        assertEq(address(CopyTracker(payable(d.copyTracker)).registry()), d.strategyRegistry);
        assertTrue(_exchange().authorizedAgents(d.copyTracker));
        assertEq(InsuranceVault(payable(d.insuranceVault)).totalAssets(), 500_000e18);
        assertEq(_exchange().maxPriceAge(), 7 days);
    }

    function test_refusesToRunOffTheLocalChain() public {
        vm.chainId(84532);
        DeployLocalDemo other = new DeployLocalDemo();
        vm.expectRevert(abi.encodeWithSelector(DeployLocalDemo.NotLocalChain.selector, uint256(84532)));
        other.deploy(deployer);
    }
}
```

- [ ] **Step 2: 跑測試確認失敗**

Run（在 `contracts/` 內）: `forge test --match-contract DeployLocalDemoTest`
Expected: 編譯失敗，`Source "script/DeployLocalDemo.s.sol" not found`

- [ ] **Step 3: 寫部署腳本**

`contracts/script/DeployLocalDemo.s.sol`：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/MockSwapRouter.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/CopyTracker.sol";
import "../src/TraderStake.sol";
import "../src/AgentSessionManager.sol";
import "../src/KYCRegistry.sol";
import "../src/ESGRegistryV2.sol";
import "./CarbonAttestations.sol";

/// @notice 本機 Anvil（chainId 31337）專用的完整部署：平台整套合約、11 個資產、
///         開啟碳定價。給模擬交易者的回放與本機展示用（issue #309），其他鏈一律拒絕。
///
///           forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
///             --rpc-url http://127.0.0.1:8545 --private-key <anvil account 0> --broadcast
///
/// @dev 與正式部署刻意不同、且只在本機鏈成立的四件事：
///      - 見證不過期（`setMaxAttestationAge(0)`）。回放會把時間快轉兩年，預設 180 天的
///        效期會讓每個資產落回未評等（最嚴一級）。
///      - 見證者與 KYC 審核者都是部署者自己：這是營運方自己的陳述，不是獨立機構的評等或審查。
///      - 交易所的報價時效放到合約上限（7 天），展示時價格寫入程序短暫中斷不至於讓所有操作失敗。
///      - 沒有設未平倉量上限與單筆獲利上限。
contract DeployLocalDemo is Script {
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    uint256 public constant INSURANCE_SEED = 500_000e18;
    uint256 public constant LOCAL_MAX_PRICE_AGE = 7 days;

    error NotLocalChain(uint256 chainId);

    struct Deployed {
        address usdc;
        address swapRouter;
        address oracle;
        address esgRegistry;
        address kyc;
        address traderStake;
        address insuranceVault;
        address feeRouter;
        address exchange;
        address strategyRegistry;
        address copyTracker;
        address sessionManager;
    }

    function run() external returns (Deployed memory) {
        return deploy(msg.sender);
    }

    function deploy(address deployer) public returns (Deployed memory d) {
        if (block.chainid != LOCAL_CHAIN_ID) revert NotLocalChain(block.chainid);
        vm.startBroadcast(deployer);

        MockUSDC usdc = new MockUSDC();
        MockSwapRouter swapRouter = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(swapRouter));

        // 價格與見證。順序與 CarbonAttestations.assets() 相同；初始價格只是佔位，
        // 回放第一天就會寫入真實歷史價格。
        MockOracle oracle = new MockOracle();
        ESGRegistryV2 esg = new ESGRegistryV2(deployer);
        esg.grantRole(esg.ATTESTOR_ROLE(), deployer);
        esg.setMaxAttestationAge(0);
        CarbonAttestations.A[11] memory assets = CarbonAttestations.assets();
        uint256[11] memory prices = [
            uint256(50_000e8), 3_000e8, 200e8, 250e8, 2_650e8, 48e8, 135e8, 420e8, 175e8, 14e8, 120e8
        ];
        for (uint256 i = 0; i < assets.length; i++) {
            oracle.addAsset(keccak256(bytes(assets[i].symbol)), prices[i]);
            CarbonAttestations.attest(esg, assets[i]);
        }

        TraderStake traderStake = new TraderStake(address(usdc));
        // 保險金庫先注資：槓桿部位的穿倉由它吸收，空的金庫會讓回放裡的虧損變成壞帳。
        InsuranceVault vault = new InsuranceVault(address(usdc));
        usdc.mint(deployer, INSURANCE_SEED);
        usdc.approve(address(vault), INSURANCE_SEED);
        vault.deposit(INSURANCE_SEED);
        FeeRouter feeRouter = new FeeRouter(address(usdc), deployer, address(vault));

        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(oracle), address(esg));
        StrategyRegistry registry = new StrategyRegistry(address(traderStake));
        CopyTracker copyTracker = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(feeRouter), address(traderStake)
        );

        vault.setFeeRouter(address(feeRouter));
        vault.setExchange(address(exchange));
        traderStake.setCopyTracker(address(copyTracker));
        feeRouter.setCopyTracker(address(copyTracker));
        feeRouter.setExchange(address(exchange));
        exchange.setCopyTracker(address(copyTracker));
        exchange.setFeeRouter(address(feeRouter));
        exchange.setInsuranceVault(address(vault));
        exchange.setAdlEnabled(true);
        exchange.setMaxPriceAge(LOCAL_MAX_PRICE_AGE);

        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);

        // 合約層的 RWA = 需要 KYC 的受監管市場：股票、債券、ETF。加密貨幣與黃金不在內。
        KYCRegistry kyc = new KYCRegistry();
        exchange.setKycRegistry(address(kyc));
        for (uint256 i = 0; i < assets.length; i++) {
            bytes32 id = keccak256(bytes(assets[i].symbol));
            bool permissionless = id == keccak256("sBTC") || id == keccak256("sETH") || id == keccak256("sGOLD");
            if (!permissionless) exchange.setRwaAsset(id, true);
        }

        vm.stopBroadcast();

        d = Deployed({
            usdc: address(usdc),
            swapRouter: address(swapRouter),
            oracle: address(oracle),
            esgRegistry: address(esg),
            kyc: address(kyc),
            traderStake: address(traderStake),
            insuranceVault: address(vault),
            feeRouter: address(feeRouter),
            exchange: address(exchange),
            strategyRegistry: address(registry),
            copyTracker: address(copyTracker),
            sessionManager: address(sessionManager)
        });
        console.log("DeployLocalDemo: exchange", d.exchange);
        console.log("DeployLocalDemo: copyTracker", d.copyTracker);
        console.log("DeployLocalDemo: esgRegistry", d.esgRegistry);
    }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `forge test --match-contract DeployLocalDemoTest -vv`
Expected: 7 passed

若 `test_aVerifiedTraderCanOpenOnEveryAsset` 以 `InvalidLeverage` 之外的錯誤失敗，讀 revert 訊息：`StalePrice` 代表測試的區塊時間與預言機寫入時間不一致（不該發生，兩者在同一個 `setUp`）；`MarginTooLow` 代表 `MIN_MARGIN` 變了，把 20e18 調到新的下限以上。

- [ ] **Step 5: 跑整套合約測試確認沒有波及**

Run: `forge test`
Expected: 全部通過，數量比改動前多 7。

- [ ] **Step 6: 在真的 Anvil 上廣播一次**

Run（兩個終端機，或把 anvil 放背景）:

```bash
anvil --silent &
ANVIL_PID=$!
cd contracts && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
cast call "$(jq -r '.transactions[] | select(.contractName=="PerpetualExchange" and .transactionType=="CREATE") | .contractAddress' broadcast/DeployLocalDemo.s.sol/31337/run-latest.json)" \
  "maxLeverageForAsset(bytes32)(uint256)" "$(cast keccak sESGU)" --rpc-url http://127.0.0.1:8545
kill -INT $ANVIL_PID
```

Expected: 腳本印出 `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`；最後的 `cast call` 回 `2`。那把私鑰是 Anvil 預設帳號 0 的公開測試金鑰（repo 既有的 `deploy-anvil.sh` 也用它），只能用在本機鏈。

- [ ] **Step 7: Commit**

```bash
git add contracts/script/DeployLocalDemo.s.sol contracts/test/DeployLocalDemo.t.sol
git commit -m "feat(contracts): 本機鏈的完整部署腳本，開啟碳定價（#309）"
```

---

### Task B2: 把本機部署的位址寫回前端

**Files:**
- Create: `agent/heroes/addresses.ts`, `agent/heroes/writeAddresses.ts`
- Test: `agent/heroes/addresses.test.ts`
- Modify: `agent/package.json`（`test:heroes`）、`frontend/src/contracts/addresses.ts`（本機鏈區塊，由工具產生）、`deploy-anvil.sh`、`seed-anvil.sh`、`contracts/script/README.md`（標示已過時）

**Interfaces:**
- Consumes: `contracts/broadcast/DeployLocalDemo.s.sol/31337/run-latest.json`（Task B1）
- Produces: `cd agent && npx tsx heroes/writeAddresses.ts`，它（1）把 `frontend/src/contracts/addresses.ts` 的 `const ANVIL: ChainAddresses = { … }` 區塊換成這次部署的位址，其餘內容一字不動；（2）寫出 `heroes/out/addresses.json`：`{ "chainId": 31337, "MockUSDC": "0x…", "MockOracle": "0x…", "TraderStake": "0x…", "InsuranceVault": "0x…", "FeeRouter": "0x…", "PerpetualExchange": "0x…", "StrategyRegistry": "0x…", "CopyTracker": "0x…", "MockSwapRouter": "0x…", "ESGRegistry": "0x…", "KYCRegistry": "0x…", "AgentSessionManager": "0x…" }`。資料線的回放與價格寫入讀這個檔。

- [ ] **Step 1: 寫失敗測試**

`agent/heroes/addresses.test.ts`：

```ts
// 純函式測試：從 forge 的 broadcast 紀錄取位址、改寫前端位址表的本機鏈區塊。
//   cd agent && npx tsx heroes/addresses.test.ts
import assert from "node:assert";
import { addressesFromBroadcast, renderAnvilBlock, replaceAnvilBlock, FRONTEND_FIELDS, ZERO } from "./addresses.ts";

// 位址只用十進位數字組成：沒有英文字母，checksum 格式就不會改變大小寫，斷言好寫。
const created = (contractName: string, n: number) => ({
  transactionType: "CREATE", contractName, contractAddress: "0x" + String(n).padStart(40, "0"),
});
const BROADCAST = {
  transactions: [
    created("MockUSDC", 1), created("MockSwapRouter", 2), created("MockOracle", 3), created("ESGRegistryV2", 4),
    { transactionType: "CALL", contractName: "ESGRegistryV2", contractAddress: "0x" + "9".repeat(40) },
    created("TraderStake", 5), created("InsuranceVault", 6), created("FeeRouter", 7), created("PerpetualExchange", 8),
    created("StrategyRegistry", 9), created("CopyTracker", 10), created("AgentSessionManager", 11), created("KYCRegistry", 12),
  ],
};

// ── 取位址 ──────────────────────────────────────────────────────────────────
const found = addressesFromBroadcast(BROADCAST);
assert.equal(found.MockUSDC, "0x0000000000000000000000000000000000000001");
// 前端的 ESGRegistry 欄位指向 ESGRegistryV2（與 Base Sepolia 相同）
assert.equal(found.ESGRegistry, "0x0000000000000000000000000000000000000004");
assert.equal(found.AgentSessionManager, "0x0000000000000000000000000000000000000011");
// 這次沒部署的合約是 0x0，前端的「未部署」判斷靠它
assert.equal(found.PepeAMM, ZERO);
assert.equal(found.AssetVault, ZERO);
// 位址一律轉成 checksum 格式
assert.equal(
  addressesFromBroadcast({ transactions: [...BROADCAST.transactions.slice(1), {
    transactionType: "CREATE", contractName: "MockUSDC", contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  }] }).MockUSDC,
  "0x5FbDB2315678afecb367f032d93F642f64180aa3",
);
// 少了一個必要的合約就報錯，不寫出半套位址
assert.throws(
  () => addressesFromBroadcast({ transactions: BROADCAST.transactions.filter((t) => t.contractName !== "CopyTracker") }),
  /no CREATE for CopyTracker/,
);

// ── 產生區塊 ────────────────────────────────────────────────────────────────
const block = renderAnvilBlock(found);
assert.ok(block.startsWith("const ANVIL: ChainAddresses = {\n"));
assert.ok(block.endsWith("\n}"));
for (const field of FRONTEND_FIELDS) assert.ok(block.includes(`  ${field}:`), `缺欄位 ${field}`);
assert.ok(!block.includes("AgentSessionManager"), "ChainAddresses 沒有這個欄位，寫進去會讓型別檢查失敗");

// ── 改寫：只動本機鏈區塊 ────────────────────────────────────────────────────
const SOURCE = [
  "export interface ChainAddresses {\n  MockUSDC: string\n}",
  "// ── Anvil local (chainId 31337) ──",
  'const ANVIL: ChainAddresses = {\n  MockUSDC:          "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",\n}',
  'const SEPOLIA: ChainAddresses = {\n  MockUSDC:           "0x167Bacef1925184f0df34A3196F834C0622Cfd36",\n}',
].join("\n\n");
const rewritten = replaceAnvilBlock(SOURCE, block);
assert.ok(rewritten.includes(block));
assert.ok(rewritten.includes('const SEPOLIA: ChainAddresses = {\n  MockUSDC:           "0x167Bacef1925184f0df34A3196F834C0622Cfd36",\n}'));
assert.ok(rewritten.includes("export interface ChainAddresses {\n  MockUSDC: string\n}"));
assert.ok(!rewritten.includes("0x610178dA211FEF7D417bC0e6FeD39F05609AD788"));
assert.equal(replaceAnvilBlock(rewritten, block), rewritten, "重跑一次不該再改動檔案");
assert.throws(() => replaceAnvilBlock("const SEPOLIA = {}", block), /ANVIL block not found/);

console.log("addresses.test.ts ✓");
```

- [ ] **Step 2: 跑測試確認失敗**

Run（在 `agent/` 內）: `npx tsx heroes/addresses.test.ts`
Expected: FAIL，`Cannot find module './addresses.ts'`

- [ ] **Step 3: 實作**

`agent/heroes/addresses.ts`：

```ts
// 本機部署（contracts/script/DeployLocalDemo.s.sol）的位址：從 forge 的 broadcast 紀錄取出，
// 寫回前端位址表的本機鏈區塊。

import { ethers } from "ethers";

export const ZERO = ethers.ZeroAddress;

/**
 * frontend/src/contracts/addresses.ts 的 ChainAddresses 欄位（順序相同）→ broadcast 裡的合約名稱。
 * null = 本機部署沒有這個合約，寫 0x0。
 */
const FIELD_SOURCES: Record<string, string | null> = {
  MockUSDC: "MockUSDC",
  MockUSDT: null,
  MockOracle: "MockOracle",
  TraderStake: "TraderStake",
  InsuranceVault: "InsuranceVault",
  FeeRouter: "FeeRouter",
  PerpetualExchange: "PerpetualExchange",
  StrategyRegistry: "StrategyRegistry",
  CopyTracker: "CopyTracker",
  MockSwapRouter: "MockSwapRouter",
  ESGRegistry: "ESGRegistryV2",
  KYCRegistry: "KYCRegistry",
  PepeAMM: null,
  PepeToken: null,
  PepeClaim: null,
  EsgRewardDistributor: null,
  PepeIncentives: null,
  PepeStaking: null,
  AssetVault: null,
};

export const FRONTEND_FIELDS = Object.keys(FIELD_SOURCES);

/** 回放需要、但前端的 ChainAddresses 沒有的合約。 */
const EXTRA_SOURCES: Record<string, string> = { AgentSessionManager: "AgentSessionManager" };

export interface BroadcastFile {
  transactions?: { transactionType?: string; contractName?: string | null; contractAddress?: string | null }[];
}

export function addressesFromBroadcast(broadcast: BroadcastFile): Record<string, string> {
  const created = new Map<string, string>();
  for (const tx of broadcast.transactions ?? []) {
    if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
      created.set(tx.contractName, ethers.getAddress(tx.contractAddress));
    }
  }
  const out: Record<string, string> = {};
  for (const [field, source] of [...Object.entries(FIELD_SOURCES), ...Object.entries(EXTRA_SOURCES)]) {
    if (source === null) {
      out[field] = ZERO;
      continue;
    }
    const address = created.get(source);
    if (!address) throw new Error(`broadcast has no CREATE for ${source}`);
    out[field] = address;
  }
  return out;
}

export function renderAnvilBlock(addresses: Record<string, string>): string {
  const lines = FRONTEND_FIELDS.map((field) => `  ${(field + ":").padEnd(24)}"${addresses[field]}",`);
  return ["const ANVIL: ChainAddresses = {", ...lines, "}"].join("\n");
}

const ANVIL_BLOCK = /const ANVIL: ChainAddresses = \{[^}]*\}/;

export function replaceAnvilBlock(source: string, block: string): string {
  if (!ANVIL_BLOCK.test(source)) throw new Error("ANVIL block not found in addresses.ts");
  return source.replace(ANVIL_BLOCK, block);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx tsx heroes/addresses.test.ts`
Expected: `addresses.test.ts ✓`

- [ ] **Step 5: 寫 CLI**

`agent/heroes/writeAddresses.ts`：

```ts
// 讀 DeployLocalDemo 的 broadcast 紀錄，更新前端位址表的本機鏈區塊，並寫出 heroes/out/addresses.json。
//   cd agent && npx tsx heroes/writeAddresses.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addressesFromBroadcast, renderAnvilBlock, replaceAnvilBlock } from "./addresses.ts";

const at = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const BROADCAST = at("contracts/broadcast/DeployLocalDemo.s.sol/31337/run-latest.json");
const FRONTEND = at("frontend/src/contracts/addresses.ts");
const OUT = at("heroes/out/addresses.json");

const addresses = addressesFromBroadcast(JSON.parse(readFileSync(BROADCAST, "utf8")));

const before = readFileSync(FRONTEND, "utf8");
const after = replaceAnvilBlock(before, renderAnvilBlock(addresses));
if (after !== before) writeFileSync(FRONTEND, after);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ chainId: 31337, ...addresses }, null, 1) + "\n");

console.log(`${after === before ? "unchanged" : "updated"}: frontend/src/contracts/addresses.ts (ANVIL block)`);
console.log(`written: heroes/out/addresses.json (exchange ${addresses.PerpetualExchange})`);
```

- [ ] **Step 6: 把測試接進 agent 的測試指令**

`agent/package.json` 的 `scripts`：

- 若資料線已經加了 `"test:heroes": "tsx heroes/plan.test.ts"`，改成：

```json
    "test:heroes": "tsx heroes/plan.test.ts && tsx heroes/addresses.test.ts",
```

- 若還沒有，新增下面這一行，並在 `test` 的最後串上 `&& npm run test:heroes`：

```json
    "test:heroes": "tsx heroes/addresses.test.ts",
```

Run: `npm run test:heroes`
Expected: 以 `addresses.test.ts ✓` 結束。

- [ ] **Step 7: 對真的部署跑一次，更新前端位址表**

Run（repo 根目錄；Anvil 用預設參數啟動，部署者 nonce 從 0 開始，位址每次都相同）:

```bash
anvil --silent &
ANVIL_PID=$!
(cd contracts && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast)
(cd agent && npx tsx heroes/writeAddresses.ts)
kill -INT $ANVIL_PID
git diff --stat frontend/src/contracts/addresses.ts
```

Expected: `updated: frontend/src/contracts/addresses.ts (ANVIL block)`；`git diff` 只顯示 `const ANVIL` 那一段有變動，19 個欄位都在，`TraderStake`／`FeeRouter`／`InsuranceVault`／`ESGRegistry`／`KYCRegistry`／`MockSwapRouter` 不再是 0x0。再跑一次 `writeAddresses.ts` 應印出 `unchanged`。

- [ ] **Step 8: 確認前端沒有被位址變動弄壞**

Run（在 `frontend/` 內）:

```bash
yarn test
```

Expected: 全部通過。若 `src/contracts/tenantDeployment.test.ts` 的快照因本機鏈位址改變而失敗：先看 diff 確認變的只有 31337 的位址，再執行 `yarn vitest run -u src/contracts/tenantDeployment.test.ts` 更新快照。

Run（repo 根目錄）: `node scripts/check-addresses.mjs`
Expected: 通過（它核對的是文件與公開鏈的位址；若它對本機鏈區塊的格式有意見，照它的訊息修 `renderAnvilBlock` 並補一個斷言）。

- [ ] **Step 9: 把舊的本機部署標示為已過時**

在 `deploy-anvil.sh` 與 `seed-anvil.sh` 的 shebang 下一行各加上：

```bash
# 已過時（2026-10）：這支腳本配的是只有 4 個資產的 Deploy.s.sol，而且會把
# frontend/src/contracts/addresses.ts 的本機鏈區塊寫回只有 7 個欄位的舊格式（型別檢查會失敗）。
# 本機部署請改用 contracts/script/DeployLocalDemo.s.sol + agent/heroes/writeAddresses.ts，
# 或直接跑 scripts/heroes-replay.sh。見 heroes/README.md。
echo "deploy-anvil.sh／seed-anvil.sh 已過時，請改用 scripts/heroes-replay.sh（見 heroes/README.md）" >&2
exit 1
```

把 `contracts/script/README.md`「快速部署（本地 Anvil）」那一節的內容換成：

```markdown
## 快速部署（本地 Anvil）

```bash
anvil &
cd contracts && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
cd ../agent && npx tsx heroes/writeAddresses.ts
```

`DeployLocalDemo` 只能在 chainId 31337 執行：平台整套合約、11 個資產、開啟碳定價。
`writeAddresses.ts` 把位址寫回 `frontend/src/contracts/addresses.ts` 的本機鏈區塊，並輸出
`heroes/out/addresses.json`。要連同模擬交易者的歷史一起建出來，用 `scripts/heroes-replay.sh`
（見 `heroes/README.md`）。

根目錄的 `deploy-anvil.sh`／`seed-anvil.sh` 已過時，執行會直接中止。
```
```

- [ ] **Step 10: Commit**

```bash
git add agent/heroes/addresses.ts agent/heroes/addresses.test.ts agent/heroes/writeAddresses.ts agent/package.json \
  frontend/src/contracts/addresses.ts deploy-anvil.sh seed-anvil.sh contracts/script/README.md
git add -u frontend/src/contracts/__snapshots__
git commit -m "feat(heroes): 本機部署的位址寫回前端，舊的本機部署腳本標示過時（#309）"
```

提交後通知資料線：Task B1 與 B2 已完成，他們的 Task A6（回放）可以開始。

---

### Task B3: 績效資料的前端模組與排行榜的新排序鍵

**Files:**
- Create: `frontend/src/lib/pepefi/heroData.ts`
- Test: `frontend/src/lib/pepefi/heroData.test.ts`
- Modify: `frontend/src/lib/pepefi/leaderboardMetrics.ts`, `frontend/src/lib/pepefi/leaderboardMetrics.test.ts`

**Interfaces:**
- Consumes: 資料線 Task A7 產出的 `frontend/public/data/heroes/index.json` 與 `<address 小寫>.json`。格式：

```jsonc
// index.json
{ "schemaVersion": 1, "chainId": 31337, "range": { "from": "2024-10-01", "to": "2026-10-09" },
  "traders": [{ "address": "0x…", "name": "Whale Alpha", "rule": "buy_hold",
    "totalReturnPct": 12.34, "maxDrawdownPct": 8.9, "sharpe": 1.21,
    "winRatePct": 62.5, "closedTrades": 8, "esgScore": 49,
    "window7d":  { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "window30d": { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "sparkline": [10000, 10012.5] }] }
// <address>.json：上面那位交易者的所有欄位，另加
{ "equityCurve": [{ "date": "2024-10-01", "equity": 9950.5 }],
  "monthlyReturns": [{ "month": "2024-10", "returnPct": 1.2 }],
  "exposure": [{ "asset": "sBTC", "weightPct": 50, "isLong": true, "leverage": 1 }],
  "esgCorrelation": 0.41, "avgHoldDays": 23.5,
  "strategies": [{ "date": "2024-10-01", "versionId": 0, "tx": "0x…",
                   "legs": [{ "asset": "sBTC", "weightBps": 5000, "isLong": true, "leverage": 1 }] }],
  "trades": [{ "positionId": 1, "asset": "sBTC", "isLong": true, "leverage": 1, "marginUsd": 4950.0,
               "openTx": "0x…", "openTime": 1727816412, "openPrice": 60830.11,
               "closeTx": "0x…", "closeTime": 1730408412, "closePrice": 70215.0,
               "pnlUsd": 612.3, "grossPnlUsd": 763.1, "liquidated": false }] }
```

金額是美元浮點數、百分比是 0–100、時間是 Unix 秒。`winRatePct`／`esgScore`／`esgCorrelation`／`avgHoldDays` 可能是 `null`；未平倉部位的 `closeTx`／`closeTime`／`closePrice`／`pnlUsd`／`grossPnlUsd` 是 `null`。

- Produces（Task B5、B6 使用）:
  - 型別 `HeroSummary`、`HeroIndex`、`HeroDetail`、`HeroTrade`、`HeroStrategyVersion`
  - `fetchHeroIndex(chainId: number | null, fetchImpl?): Promise<HeroIndex | null>`
  - `fetchHeroDetail(address: string, chainId: number | null, fetchImpl?): Promise<HeroDetail | null>`
  - `heroByAddress(index: HeroIndex): Map<string, HeroSummary>`（鍵為小寫位址）
  - `applyHeroSummary(card: TraderCard, hero: HeroSummary): TraderCard`
  - `fSignedPct(v: number | null | undefined): string`、`fDrawdown(v): string`、`fRatio(v): string`、`fUsd(v): string`
  - `TraderCard.hero?: HeroSummary`；`LeaderboardSortKey` 新增 `'return' | 'drawdown' | 'sharpe'`

- [ ] **Step 1: 寫績效資料模組的失敗測試**

`frontend/src/lib/pepefi/heroData.test.ts`：

```ts
import { describe, it, expect } from 'vitest'

import { buildTraderCard } from './leaderboardMetrics'
import {
  parseHeroIndex,
  parseHeroDetail,
  fetchHeroIndex,
  fetchHeroDetail,
  heroByAddress,
  applyHeroSummary,
  usdToWei,
  fSignedPct,
  fDrawdown,
  fRatio,
  fUsd,
  type HeroSummary,
} from './heroData'

const ADDR = '0x00000000000000000000000000000000000000AA'
const window = { pnlUsd: 0, marginUsd: 0, volumeUsd: 0, wins: 0, trades: 0 }
const summary: HeroSummary = {
  address: ADDR, name: 'Whale Alpha', rule: 'buy_hold',
  totalReturnPct: 12.34, maxDrawdownPct: 8.9, sharpe: 1.21, winRatePct: 62.5, closedTrades: 8, esgScore: 49,
  window7d: window,
  window30d: { pnlUsd: 123.45, marginUsd: 1000, volumeUsd: 2500, wins: 5, trades: 8 },
  sparkline: [10000, 10050.5, 9990],
}
const index = { schemaVersion: 1, chainId: 31337, range: { from: '2024-10-01', to: '2026-10-09' }, traders: [summary] }
const detail = {
  ...summary,
  equityCurve: [{ date: '2024-10-01', equity: 10000 }],
  monthlyReturns: [{ month: '2024-10', returnPct: 1.2 }],
  exposure: [{ asset: 'sBTC', weightPct: 50, isLong: true, leverage: 1 }],
  esgCorrelation: 0.41, avgHoldDays: 23.5, strategies: [], trades: [],
}

const responding = (body: unknown, ok = true) => async () => ({ ok, json: async () => body })
const serving = (files: Record<string, unknown>) => async (url: string) => {
  const name = url.split('/').pop() as string
  return name in files ? { ok: true, json: async () => files[name] } : { ok: false, json: async () => ({}) }
}

describe('parseHeroIndex', () => {
  it('accepts data for the connected chain', () => {
    expect(parseHeroIndex(index, 31337)?.traders[0].name).toBe('Whale Alpha')
  })

  it('refuses data that belongs to another chain', () => {
    expect(parseHeroIndex(index, 84532)).toBeNull()
    expect(parseHeroIndex(index, null)).toBeNull()
  })

  it('refuses a schema version it does not know', () => {
    expect(parseHeroIndex({ ...index, schemaVersion: 2 }, 31337)).toBeNull()
  })

  it('refuses the whole file when one trader is malformed', () => {
    const broken = { ...index, traders: [summary, { ...summary, totalReturnPct: '12' }] }
    expect(parseHeroIndex(broken, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, traders: [{ ...summary, address: 'nope' }] }, 31337)).toBeNull()
    expect(parseHeroIndex('<!doctype html>', 31337)).toBeNull()
  })

  it('keeps null for figures that could not be computed', () => {
    const parsed = parseHeroIndex({ ...index, traders: [{ ...summary, winRatePct: null, esgScore: null }] }, 31337)
    expect(parsed?.traders[0].winRatePct).toBeNull()
  })
})

describe('parseHeroDetail', () => {
  it('accepts a detail file for the address asked for', () => {
    expect(parseHeroDetail(detail, ADDR.toLowerCase())?.equityCurve).toHaveLength(1)
  })

  it('refuses a file about a different trader or without the detail sections', () => {
    expect(parseHeroDetail(detail, '0x00000000000000000000000000000000000000BB')).toBeNull()
    expect(parseHeroDetail(summary, ADDR)).toBeNull()
  })
})

describe('fetching', () => {
  it('returns null instead of throwing when the file is missing or is not JSON', async () => {
    expect(await fetchHeroIndex(31337, responding({}, false))).toBeNull()
    expect(await fetchHeroIndex(31337, async () => ({ ok: true, json: async () => { throw new Error('html') } }))).toBeNull()
    expect(await fetchHeroIndex(31337, async () => { throw new Error('offline') })).toBeNull()
  })

  it('does not fetch at all without a chain', async () => {
    let calls = 0
    const counting = async () => { calls += 1; return { ok: true, json: async () => index } }
    expect(await fetchHeroIndex(null, counting)).toBeNull()
    expect(calls).toBe(0)
  })

  it('reads a detail file only for a trader the index lists', async () => {
    const files = { 'index.json': index, [`${ADDR.toLowerCase()}.json`]: detail }
    expect((await fetchHeroDetail(ADDR, 31337, serving(files)))?.avgHoldDays).toBe(23.5)
    expect(await fetchHeroDetail('0x00000000000000000000000000000000000000BB', 31337, serving(files))).toBeNull()
    expect(await fetchHeroDetail(ADDR, 84532, serving(files))).toBeNull()
  })
})

describe('applyHeroSummary', () => {
  const empty = { volumeMap: {}, marginMap: {}, pnlMap: {}, closedEventsByOwner: {} }
  const card = buildTraderCard(
    { address: ADDR, displayName: 'Whale Alpha', allocs: [], followerCount: 3n, reputation: 90n, stake: 5_000n * 10n ** 18n, totalSlashed: 0n },
    empty,
  )

  it('converts dollars to 18-decimal wei without float drift', () => {
    expect(usdToWei(123.45)).toBe(123_450_000n * 10n ** 12n)
    expect(usdToWei(-0.5)).toBe(-500_000n * 10n ** 12n)
  })

  it('feeds the 30-day window into the existing leaderboard fields', () => {
    const applied = applyHeroSummary(card, summary)
    expect(applied.pnl7d).toBe(usdToWei(123.45))
    expect(applied.totalVolume).toBe(usdToWei(2500))
    expect(applied.marginDeployed).toBe(usdToWei(1000))
    expect([applied.wins, applied.trades]).toEqual([5, 8])
    expect(applied.hero).toBe(summary)
  })

  it('recomputes TraderScore from the window and keeps what was read from chain', () => {
    const applied = applyHeroSummary(card, summary)
    expect(applied.score.returnPct).toBeCloseTo(12.345)
    expect(applied.score.winRate).toBeCloseTo(0.625)
    expect(applied.score.insufficientSample).toBe(false)
    expect(applied.score.stakeScore).toBe(card.score.stakeScore)
    expect([applied.followerCount, applied.reputation, applied.stake]).toEqual([3n, 90n, card.stake])
  })

  it('draws the sparkline as change since the first point', () => {
    expect(applyHeroSummary(card, summary).equityCurve).toEqual([0n, usdToWei(50.5), usdToWei(-10)])
    expect(applyHeroSummary(card, { ...summary, sparkline: [10000] }).equityCurve).toEqual([])
  })

  it('indexes traders by lower-case address', () => {
    expect(heroByAddress(parseHeroIndex(index, 31337)!).get(ADDR.toLowerCase())).toEqual(summary)
  })
})

describe('formatting', () => {
  it('never shows a missing figure as zero', () => {
    expect([fSignedPct(undefined), fSignedPct(null), fDrawdown(undefined), fRatio(null), fUsd(null)])
      .toEqual(['—', '—', '—', '—', '—'])
  })

  it('always signs a return, and shows a drawdown as a loss', () => {
    expect([fSignedPct(12.34), fSignedPct(-4.2), fSignedPct(0)]).toEqual(['+12.3%', '-4.2%', '+0.0%'])
    expect([fDrawdown(8.9), fDrawdown(0)]).toEqual(['-8.9%', '0.0%'])
    expect(fRatio(1.214)).toBe('1.21')
    expect([fUsd(1234.5), fUsd(-20)]).toEqual(['1,234.50', '-20.00'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run（在 `frontend/` 內）: `yarn vitest run src/lib/pepefi/heroData.test.ts`
Expected: FAIL，`Failed to resolve import "./heroData"`

- [ ] **Step 3: 實作模組**

`frontend/src/lib/pepefi/heroData.ts`：

```ts
// 模擬交易者的績效資料（issue #309）——純函式加兩個讀取函式，不含 ethers 或 React。
//
// 資料由 heroes/ 的管線從本機鏈的事件算出來，放在 public/data/heroes/：一份索引（排行榜用）
// 加每位交易者一個詳細檔（個人頁用）。它只補鏈上讀不出來的歷史統計；跟隨者人數、質押、
// 聲譽、目前策略照舊直接讀鏈。
//
// 這份資料只屬於產生它的那條鏈：chainId 不符就當作沒有，畫面走原本的路徑。

import { computeTraderScore, type TraderCard } from './leaderboardMetrics'

export const HERO_SCHEMA_VERSION = 1

export interface HeroWindow {
  pnlUsd: number
  marginUsd: number
  volumeUsd: number
  wins: number
  trades: number
}

export interface HeroSummary {
  address: string
  name: string
  rule: string
  totalReturnPct: number
  maxDrawdownPct: number
  sharpe: number
  /** 沒有任何平倉時為 null。 */
  winRatePct: number | null
  closedTrades: number
  esgScore: number | null
  window7d: HeroWindow
  window30d: HeroWindow
  sparkline: number[]
}

export interface HeroIndex {
  schemaVersion: number
  chainId: number
  range: { from: string; to: string }
  traders: HeroSummary[]
}

export interface HeroLeg {
  asset: string
  weightBps: number
  isLong: boolean
  leverage: number
}

export interface HeroStrategyVersion {
  date: string
  versionId: number
  tx: string
  legs: HeroLeg[]
}

export interface HeroTrade {
  positionId: number
  asset: string
  isLong: boolean
  leverage: number
  marginUsd: number
  openTx: string
  openTime: number
  openPrice: number
  /** 以下五個欄位在部位還沒平倉時為 null。 */
  closeTx: string | null
  closeTime: number | null
  closePrice: number | null
  pnlUsd: number | null
  grossPnlUsd: number | null
  liquidated: boolean
}

export interface HeroDetail extends HeroSummary {
  equityCurve: { date: string; equity: number }[]
  monthlyReturns: { month: string; returnPct: number }[]
  exposure: { asset: string; weightPct: number; isLong: boolean; leverage: number }[]
  esgCorrelation: number | null
  avgHoldDays: number | null
  strategies: HeroStrategyVersion[]
  trades: HeroTrade[]
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x)
const WINDOW_KEYS = ['pnlUsd', 'marginUsd', 'volumeUsd', 'wins', 'trades'] as const
const isWindow = (x: unknown): boolean => isRecord(x) && WINDOW_KEYS.every((k) => isNum(x[k]))

const isSummary = (x: unknown): boolean =>
  isRecord(x) &&
  typeof x.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x.address) &&
  typeof x.name === 'string' && typeof x.rule === 'string' &&
  isNum(x.totalReturnPct) && isNum(x.maxDrawdownPct) && isNum(x.sharpe) &&
  isNumOrNull(x.winRatePct) && isNum(x.closedTrades) && isNumOrNull(x.esgScore) &&
  isWindow(x.window7d) && isWindow(x.window30d) &&
  Array.isArray(x.sparkline) && x.sparkline.every(isNum)

/** 只要有一筆不合格就整份不收：半份資料畫出來的排行榜比沒有資料更糟。 */
export function parseHeroIndex(raw: unknown, chainId: number | null): HeroIndex | null {
  if (!isRecord(raw) || raw.schemaVersion !== HERO_SCHEMA_VERSION) return null
  if (chainId === null || raw.chainId !== chainId) return null
  if (!isRecord(raw.range) || typeof raw.range.from !== 'string' || typeof raw.range.to !== 'string') return null
  if (!Array.isArray(raw.traders) || !raw.traders.every(isSummary)) return null
  return raw as unknown as HeroIndex
}

const DETAIL_LISTS = ['equityCurve', 'monthlyReturns', 'exposure', 'strategies', 'trades'] as const

export function parseHeroDetail(raw: unknown, address: string): HeroDetail | null {
  if (!isSummary(raw)) return null
  const record = raw as Record<string, unknown>
  if ((record.address as string).toLowerCase() !== address.toLowerCase()) return null
  if (!DETAIL_LISTS.every((k) => Array.isArray(record[k]))) return null
  if (!isNumOrNull(record.esgCorrelation) || !isNumOrNull(record.avgHoldDays)) return null
  return raw as HeroDetail
}

// ── 讀取 ─────────────────────────────────────────────────────────────────────

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const fileUrl = (name: string) => `${import.meta.env.BASE_URL}data/heroes/${name}`

/** 讀不到（404、不是 JSON、離線）一律是 null。SPA 的 fallback 會對不存在的檔回 index.html，所以 json() 失敗是常態。 */
async function readJson(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url)
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

export async function fetchHeroIndex(chainId: number | null, fetchImpl: FetchLike = fetch): Promise<HeroIndex | null> {
  if (chainId === null) return null
  return parseHeroIndex(await readJson(fileUrl('index.json'), fetchImpl), chainId)
}

export async function fetchHeroDetail(
  address: string,
  chainId: number | null,
  fetchImpl: FetchLike = fetch,
): Promise<HeroDetail | null> {
  const index = await fetchHeroIndex(chainId, fetchImpl)
  if (!index || !heroByAddress(index).has(address.toLowerCase())) return null
  return parseHeroDetail(await readJson(fileUrl(`${address.toLowerCase()}.json`), fetchImpl), address)
}

export const heroByAddress = (index: HeroIndex): Map<string, HeroSummary> =>
  new Map(index.traders.map((t) => [t.address.toLowerCase(), t]))

// ── 併進排行榜 ────────────────────────────────────────────────────────────────

/** 美元 → 18 位小數的 wei。先乘到百萬分之一再取整，避免 123.45 × 1e18 的浮點誤差。 */
export const usdToWei = (usd: number): bigint => BigInt(Math.round(usd * 1e6)) * 10n ** 12n

/**
 * 用績效資料取代瀏覽器掃事件得到的那幾個欄位。近期視窗取 30 天：策略以週到月為單位調整，
 * 7 天內的平倉常不足以通過「至少 5 筆」的樣本門檻。欄位名稱（pnl7d）是既有的，
 * 這裡不改名；畫面上的標題由呼叫端換成 30 天。
 * 從鏈上讀到的（跟隨者、質押、聲譽、罰沒、策略）原樣保留。
 */
export function applyHeroSummary(card: TraderCard, hero: HeroSummary): TraderCard {
  const recent = hero.window30d
  const pnl = usdToWei(recent.pnlUsd)
  const margin = usdToWei(recent.marginUsd)
  return {
    ...card,
    totalVolume: usdToWei(recent.volumeUsd),
    pnl7d: pnl,
    marginDeployed: margin,
    wins: recent.wins,
    trades: recent.trades,
    equityCurve: hero.sparkline.length < 2 ? [] : hero.sparkline.map((v) => usdToWei(v - hero.sparkline[0])),
    score: computeTraderScore({
      pnl7d: pnl,
      marginDeployed: margin,
      wins: recent.wins,
      trades: recent.trades,
      stake: card.stake,
      reputation: card.reputation,
      totalSlashed: card.totalSlashed,
    }),
    hero,
  }
}

// ── 顯示 ─────────────────────────────────────────────────────────────────────

type Maybe = number | null | undefined
const missing = (v: Maybe): v is null | undefined => v === null || v === undefined

/** 「+12.3%」/「-4.2%」。符號永遠顯示；缺資料給破折號，不是 0。 */
export const fSignedPct = (v: Maybe): string => (missing(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)

/** 回撤存的是正數（8.9 代表從高點跌了 8.9%），顯示成損失。 */
export const fDrawdown = (v: Maybe): string => (missing(v) ? '—' : v === 0 ? '0.0%' : `-${v.toFixed(1)}%`)

export const fRatio = (v: Maybe): string => (missing(v) ? '—' : v.toFixed(2))

export const fUsd = (v: Maybe): string =>
  missing(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
```

- [ ] **Step 4: 讓 `TraderCard` 帶得動績效資料**

`frontend/src/lib/pepefi/leaderboardMetrics.ts`，檔案最上方的註解區塊之後加上（型別匯入，不會造成執行期的循環依賴）：

```ts
import type { HeroSummary } from './heroData'
```

在 `TraderCard` 介面的 `score: TraderScoreBreakdown;` 後面加一個欄位：

```ts
  /** 模擬交易者的績效資料；這條鏈沒有、或這個位址不在其中時為 undefined。見 heroData.ts。 */
  hero?:          HeroSummary;
```

- [ ] **Step 5: 跑測試確認通過**

Run: `yarn vitest run src/lib/pepefi/heroData.test.ts`
Expected: 17 passed

- [ ] **Step 6: 寫新排序鍵的失敗測試**

`frontend/src/lib/pepefi/leaderboardMetrics.test.ts`，在檔案最後加上：

```ts
describe('sorting by the simulated-trader figures', () => {
  const window = { pnlUsd: 0, marginUsd: 0, volumeUsd: 0, wins: 0, trades: 0 }
  const withHero = (address: string, totalReturnPct: number, maxDrawdownPct: number, sharpe: number): TraderCard => ({
    ...buildTraderCard(
      { address, displayName: address, allocs: [], followerCount: 0n, reputation: null, stake: null, totalSlashed: null },
      emptyAggregates,
    ),
    hero: {
      address, name: address, rule: 'buy_hold', totalReturnPct, maxDrawdownPct, sharpe,
      winRatePct: null, closedTrades: 0, esgScore: null, window7d: window, window30d: window, sparkline: [],
    },
  })
  const steady = withHero('0xa', 10, 5, 2.0)
  const wild = withHero('0xb', 40, 35, 0.8)
  const plain = buildTraderCard(
    { address: '0xc', displayName: 'no data', allocs: [], followerCount: 0n, reputation: null, stake: null, totalSlashed: null },
    emptyAggregates,
  )
  const order = (key: 'return' | 'drawdown' | 'sharpe') =>
    [plain, steady, wild].sort(makeTraderComparator(key, () => null)).map((t) => t.address)

  it('puts the highest return first', () => {
    expect(order('return')).toEqual(['0xb', '0xa', '0xc'])
  })

  it('puts the shallowest drawdown first', () => {
    expect(order('drawdown')).toEqual(['0xa', '0xb', '0xc'])
  })

  it('puts the best risk-adjusted return first', () => {
    expect(order('sharpe')).toEqual(['0xa', '0xb', '0xc'])
  })

  it('keeps a trader without the data last rather than treating it as zero', () => {
    const losing = withHero('0xd', -20, 50, -1.5)
    expect([plain, losing].sort(makeTraderComparator('return', () => null)).map((t) => t.address)).toEqual(['0xd', '0xc'])
    expect([plain, losing].sort(makeTraderComparator('sharpe', () => null)).map((t) => t.address)).toEqual(['0xd', '0xc'])
  })
})
```

Run: `yarn vitest run src/lib/pepefi/leaderboardMetrics.test.ts`
Expected: FAIL，型別錯誤 `Argument of type '"return"' is not assignable to parameter of type 'LeaderboardSortKey'`（或執行期順序不符）。

- [ ] **Step 7: 實作新排序鍵**

`frontend/src/lib/pepefi/leaderboardMetrics.ts`：

把 `LeaderboardSortKey` 改成：

```ts
export type LeaderboardSortKey =
  | 'score' | 'pnl' | 'reputation' | 'followers' | 'volume' | 'stake' | 'esg'
  | 'return' | 'drawdown' | 'sharpe';
```

在 `makeTraderComparator` 上方加：

```ts
/**
 * 績效資料才有的數字（累積報酬、最大回撤、Sharpe）。沒有資料的人一律墊底，
 * 不當成 0——0% 報酬是一個結果，沒有資料不是。
 */
const cmpOptionalNumber = (a: number | undefined, b: number | undefined, direction: 'asc' | 'desc'): number => {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return direction === 'desc' ? b - a : a - b;
};
```

在 `makeTraderComparator` 的 `switch` 裡、`case 'score':` 之前加：

```ts
    case 'return':     primary = cmpOptionalNumber(a.hero?.totalReturnPct, b.hero?.totalReturnPct, 'desc'); break;
    case 'drawdown':   primary = cmpOptionalNumber(a.hero?.maxDrawdownPct, b.hero?.maxDrawdownPct, 'asc'); break;
    case 'sharpe':     primary = cmpOptionalNumber(a.hero?.sharpe, b.hero?.sharpe, 'desc'); break;
```

- [ ] **Step 8: 跑測試與型別檢查**

Run:

```bash
yarn vitest run src/lib/pepefi/leaderboardMetrics.test.ts src/lib/pepefi/heroData.test.ts
yarn tsc --noEmit
```

Run: `yarn lint`
Expected: 通過。若 `import/no-cycle` 抱怨 `heroData.ts` 與 `leaderboardMetrics.ts` 互相匯入（其中一邊只是型別），把 `HeroWindow` 與 `HeroSummary` 兩個介面搬到新檔 `src/lib/pepefi/heroTypes.ts`，兩邊都從那裡匯入型別，`heroData.ts` 再把它們重新匯出。

Expected（前兩個指令）: 兩個測試檔全部通過；`tsc` 沒有錯誤。`MarketplacePage.tsx` 的排序下拉用 `Record` 以外的方式列舉排序鍵，新增的三個鍵不會讓它編譯失敗。

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/pepefi/heroData.ts frontend/src/lib/pepefi/heroData.test.ts \
  frontend/src/lib/pepefi/leaderboardMetrics.ts frontend/src/lib/pepefi/leaderboardMetrics.test.ts
git commit -m "feat(frontend): 模擬交易者績效資料的解析、讀取與排行榜排序鍵（#309）"
```

---

### Task B4: 把交易者排行榜從頁面檔拆出來

行為不變的搬移，單獨一個提交，之後的改動才看得出差異。

**Files:**
- Create: `frontend/src/components/pepefi/TraderLeaderboard.tsx`
- Modify: `frontend/src/pages/pepefi/MarketplacePage.tsx`

**Interfaces:**
- Produces: `frontend/src/components/pepefi/TraderLeaderboard.tsx` 預設匯出 `TraderLeaderboard`（無 props）。Task B5 改這個檔。

- [ ] **Step 1: 搬移**

1. 把 `frontend/src/pages/pepefi/MarketplacePage.tsx` 整個檔案複製成 `frontend/src/components/pepefi/TraderLeaderboard.tsx`。
2. 在新檔裡：
   - 刪掉 `export default function MarketplacePage() { … }` 這個函式與它上方那段 `#149 / ADR-007` 的註解。
   - 把 `function TraderLeaderboard() {` 改成 `export default function TraderLeaderboard() {`。
   - 刪掉不再用到的匯入：`useMode`、`FEATURE_COPY_TRADING`、`AllocationMarketplace`。
3. 把 `MarketplacePage.tsx` 整個內容換成：

```tsx
import { useMode } from 'src/contexts/mode-context';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import AllocationMarketplace from 'src/components/pepefi/AllocationMarketplace';
import TraderLeaderboard from 'src/components/pepefi/TraderLeaderboard';

/**
 * #149 / ADR-007：Simple Mode 看到的是配置市集（無槓桿的現貨採用），Expert Mode
 * 才是交易者排行榜（CopyTracker 的槓桿跟單）。兩個是不同的商品，不是同一個畫面
 * 換兩套詞——拆成兩個元件，Simple Mode 也就不會去掃排行榜那幾百段 getLogs。
 */
export default function MarketplacePage() {
  const { mode } = useMode();
  // 跟單排行榜跟著 FEATURE_COPY_TRADING 走（商業版預設關）——關閉時兩個模式都是配置市集。
  return mode === 'expert' && FEATURE_COPY_TRADING ? <TraderLeaderboard /> : <AllocationMarketplace />;
}
```

- [ ] **Step 2: 確認沒有東西壞掉**

Run（在 `frontend/` 內）:

```bash
yarn tsc --noEmit && yarn lint && yarn test
```

Expected: 三個都通過。`lint` 若抱怨新檔有未使用的匯入，刪掉它指出的那幾個。`src/tenant/branding.test.ts` 會讀 `MarketplacePage` 的原始碼：若它因為某段字串搬到了 `TraderLeaderboard.tsx` 而失敗，把它讀的檔案路徑改成新檔，斷言內容不動。

- [ ] **Step 3: 確認真的只是搬移**

Run:

```bash
git diff --no-index --stat <(git show HEAD:frontend/src/pages/pepefi/MarketplacePage.tsx) frontend/src/components/pepefi/TraderLeaderboard.tsx
```

Expected: 只有刪除的行（Mode 切換的函式、三個匯入）與一行 `export default` 的修改，沒有其他新增。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/pepefi/TraderLeaderboard.tsx frontend/src/pages/pepefi/MarketplacePage.tsx
git add -u frontend/src/tenant
git commit -m "refactor(frontend): 交易者排行榜從 MarketplacePage 拆成獨立元件（行為不變）"
```

---

### Task B5: 排行榜接上績效資料

**Files:**
- Modify: `frontend/src/components/pepefi/TraderLeaderboard.tsx`, `frontend/src/locales/zh-TW/marketplace.ts`, `frontend/src/locales/en/marketplace.ts`

**Interfaces:**
- Consumes: `fetchHeroIndex`、`heroByAddress`、`applyHeroSummary`、`fSignedPct`、`fDrawdown`、`fRatio`（Task B3）；`TraderLeaderboard`（Task B4）；`frontend/public/data/heroes/index.json`（資料線 Task A7）
- Produces: `t.marketplace.hero.disclosure`（Task B6 的個人頁也用這一句）

- [ ] **Step 1: 加顯示文字**

`frontend/src/locales/zh-TW/marketplace.ts`，在 `footer: { … },` 之後、檔案結尾的 `};` 之前加：

```ts
  /**
   * 模擬交易者（issue #309）。這條鏈有績效資料時才出現。
   * disclosure 是固定顯示的揭露：不能收合，也不依賴任何鏈上讀取。
   */
  hero: {
    disclosure:
      '模擬交易者：以下交易者由程式依公開的規則操作，績效是真實歷史價格在本機鏈上的回放，不是真人的交易紀錄。每一筆開倉與平倉都是鏈上交易；累積報酬、回撤等統計由這些鏈上事件在鏈下算出。',
    range: '績效統計期間 {from} 至 {to}；交易量、PnL、勝率為最近 30 天',
    volLabel: '30 日量',
    pnlLabel: '30 日 PnL',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    sortReturn: '排序：累積報酬',
    sortDrawdown: '排序：最大回撤',
    sortSharpe: '排序：Sharpe',
  },
```

`frontend/src/locales/en/marketplace.ts`，同樣的位置加：

```ts
  hero: {
    disclosure:
      'Simulated traders: the traders below are operated by a program following published rules. Their performance is a replay of real historical prices on a local chain, not the record of a real person. Every open and close is an on-chain transaction; cumulative return, drawdown and the other statistics are computed off-chain from those on-chain events.',
    range: 'Performance from {from} to {to}; volume, PnL and win rate cover the last 30 days',
    volLabel: '30d volume',
    pnlLabel: '30d PnL',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    sortReturn: 'Sort: total return',
    sortDrawdown: 'Sort: max drawdown',
    sortSharpe: 'Sort: Sharpe',
  },
```

Run（在 `frontend/` 內）: `yarn vitest run src/locales`
Expected: 通過（兩個 Locale 的 catalog 結構相同的檢查在這裡）。

- [ ] **Step 2: 讀取績效資料，有的話取代事件掃描**

`frontend/src/components/pepefi/TraderLeaderboard.tsx`：

在匯入區加：

```tsx
import {
  fetchHeroIndex,
  heroByAddress,
  applyHeroSummary,
  fSignedPct,
  fDrawdown,
  fRatio,
} from 'src/lib/pepefi/heroData';
```

在 `const [progress, setProgress] = useState…` 那一行之後加一個狀態：

```tsx
  // 這條鏈有模擬交易者的績效資料時，它的統計期間；null = 沒有，績效欄位走原本的事件掃描。
  const [heroRange, setHeroRange] = useState<{ from: string; to: string } | null>(null);
```

在 `fetchAll` 裡，`try {` 之後的第一行（`const currentBlock = await wallet.provider.getBlockNumber();` 之前）加：

```tsx
      // 有績效資料就不掃事件：本機鏈上「最近 7 天的區塊數」和時間無關，掃出來的數字沒有意義。
      const heroIndex = await fetchHeroIndex(wallet.chainId);
      if (ac.signal.aborted) return;
      setHeroRange(heroIndex?.range ?? null);
```

在既有的 `setProgress({ done: 0, total: chunks });` 那一行後面加一行，有績效資料時不顯示掃描進度：

```tsx
      if (heroIndex) setProgress({ done: 0, total: 0 });
```

把 `Promise.allSettled([` 的第一個元素 `getLogsChunked( … ),` 整個呼叫包起來：

```tsx
      const [logsRes, addressesRes] = await Promise.allSettled([
        heroIndex
          ? Promise.resolve([])
          : getLogsChunked(
              wallet.provider,
              {
                address: contracts.exchange.target as string,
                topics:  [[topicOf('PositionOpened'), topicOf('PositionClosed')]],
              },
              fromBlock,
              currentBlock,
              tick,
              () => { failedChunks += 1; },
              { retries: UI_RETRIES, concurrency: LEADERBOARD_CONCURRENCY, signal: ac.signal },
            ),
        contracts.registry.getAllTraders() as Promise<string[]>,
      ]);
```

把 `setTraders(cards);` 換成：

```tsx
      const heroes = heroIndex ? heroByAddress(heroIndex) : null;
      setTraders(
        heroes
          ? cards.map((card) => {
              const hero = heroes.get(card.address.toLowerCase());
              return hero ? applyHeroSummary(card, hero) : card;
            })
          : cards,
      );
```

- [ ] **Step 3: 排序選項與欄位標題**

把 `sortOptions` 的宣告換成：

```tsx
  const usingHeroData = heroRange !== null;
  const volLabel = usingHeroData ? t.marketplace.hero.volLabel : t.marketplace.card.volLabel;
  const pnlLabel = usingHeroData ? t.marketplace.hero.pnlLabel : t.marketplace.card.pnlLabel;

  const sortOptions: Array<{ key: SortKey; label: string }> = [
    { key: 'score', label: t.marketplace.sort.score },
    ...(usingHeroData
      ? ([
          { key: 'return', label: t.marketplace.hero.sortReturn },
          { key: 'drawdown', label: t.marketplace.hero.sortDrawdown },
          { key: 'sharpe', label: t.marketplace.hero.sortSharpe },
        ] as Array<{ key: SortKey; label: string }>)
      : []),
    { key: 'pnl', label: t.marketplace.sort.pnl },
    { key: 'reputation', label: t.marketplace.sort.reputation },
    { key: 'followers', label: t.marketplace.sort.followers },
    { key: 'volume', label: t.marketplace.sort.volume },
    { key: 'stake', label: t.marketplace.sort.stake },
    { key: 'esg', label: t.marketplace.sort.esg },
  ];
```

在表頭，把

```tsx
                  {sortableHeader('volume', t.marketplace.card.volLabel)}
                  {sortableHeader('pnl', t.marketplace.card.pnlLabel)}
```

換成

```tsx
                  {usingHeroData && sortableHeader('return', t.marketplace.hero.totalReturn)}
                  {usingHeroData && sortableHeader('drawdown', t.marketplace.hero.maxDrawdown)}
                  {usingHeroData && sortableHeader('sharpe', t.marketplace.hero.sharpe)}
                  {sortableHeader('volume', volLabel)}
                  {sortableHeader('pnl', pnlLabel)}
```

- [ ] **Step 4: 每一列的新欄位**

在表身，交易量那一格

```tsx
                      <TableCell align="right" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                        {trader.totalVolume > 0n ? fVol(trader.totalVolume) : '—'}
                      </TableCell>
```

的**前面**加三格（順序對應表頭）：

```tsx
                      {usingHeroData && (
                        <>
                          <TableCell
                            align="right"
                            sx={{
                              fontFamily: MONO,
                              fontWeight: 'bold',
                              color: !trader.hero ? 'text.secondary'
                                : trader.hero.totalReturnPct >= 0 ? 'success.main' : 'error.main',
                            }}
                          >
                            {fSignedPct(trader.hero?.totalReturnPct)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontFamily: MONO }}>
                            {fDrawdown(trader.hero?.maxDrawdownPct)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontFamily: MONO }}>
                            {fRatio(trader.hero?.sharpe)}
                          </TableCell>
                        </>
                      )}
```

- [ ] **Step 5: 揭露文字與頁尾**

在 `return (` 的 `<Container …>` 裡，Header 那個 `<Box>` 結束之後（搜尋框與排序下拉所在的區塊之後）加：

```tsx
      {usingHeroData && (
        <Alert severity="info" variant="outlined" icon={<Icon icon="solar:test-tube-bold-duotone" width={20} />}>
          {t.marketplace.hero.disclosure}
        </Alert>
      )}
```

在頁尾，把

```tsx
              {interpolate(t.marketplace.footer.volumeWindow, {
                blocks: scan.blocks.toLocaleString(),
                window: fWindow(scan.hours),
              })}
```

換成

```tsx
              {heroRange
                ? interpolate(t.marketplace.hero.range, heroRange)
                : interpolate(t.marketplace.footer.volumeWindow, {
                    blocks: scan.blocks.toLocaleString(),
                    window: fWindow(scan.hours),
                  })}
```

`Podium` 元件標題下方若有「7 日」字樣的統計標籤（它用 `t.marketplace.card.volLabel`／`pnlLabel`），給 `Podium` 加兩個選用的 props `volLabel?: string`、`pnlLabel?: string`，預設用原本的 catalog 字串，從這裡把上面算好的 `volLabel`／`pnlLabel` 傳進去。

- [ ] **Step 6: 型別、lint、測試**

Run（在 `frontend/` 內）: `yarn tsc --noEmit && yarn lint && yarn test`
Expected: 全部通過。

- [ ] **Step 7: 在瀏覽器對著本機鏈驗證**

前置：資料線的 Task A7 已合併（`frontend/public/data/heroes/` 有資料），並且自己跑過一次

```bash
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json   # 或完整排程
anvil --host 0.0.0.0 --load-state heroes/out/chain.json --silent &
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url http://127.0.0.1:8545
```

啟動前端：`cd frontend && VITE_FEATURE_COPY_TRADING=1 yarn dev`，錢包連本機鏈（RPC `http://127.0.0.1:8545`、chain ID 31337），切到 Expert Mode，開 `/marketplace`。

逐項確認：
1. 標題下方出現揭露文字。
2. 表格列出 `index.json` 裡的每一位交易者，累積報酬／最大回撤／Sharpe 三欄有數字，與 `index.json` 相符（挑兩位對照）。
3. 點三個新欄位的標題，順序正確：累積報酬由高到低、最大回撤由淺到深、Sharpe 由高到低。
4. 交易量與 PnL 的欄位標題寫的是「30 日」。
5. 跟隨者人數與 `cast call <CopyTracker> "getFollowerCount(address)(uint256)" <交易者位址>` 相符（從鏈上讀的，不是資料檔）。
6. 頁尾顯示統計期間，不是「最近 ~N 個區塊」。
7. 載入不再出現幾百段的掃描進度條。

把 `frontend/public/data/heroes/index.json` 暫時改名後重新整理：揭露文字與三個新欄位消失，畫面回到原本的事件掃描路徑且不報錯。改回檔名。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/pepefi/TraderLeaderboard.tsx frontend/src/components/pepefi/Podium.tsx \
  frontend/src/locales/zh-TW/marketplace.ts frontend/src/locales/en/marketplace.ts
git commit -m "feat(frontend): 交易者排行榜顯示模擬交易者的累積報酬、回撤與 Sharpe（#309）"
```

---

### Task B6: 交易者個人頁的績效、策略版本與部位列表

**Files:**
- Create: `frontend/src/components/pepefi/hero/HeroPerformance.tsx`, `frontend/src/components/pepefi/hero/HeroTrades.tsx`, `frontend/src/components/pepefi/hero/HeroRiskStats.tsx`
- Modify: `frontend/src/lib/pepefi/heroData.ts`, `frontend/src/lib/pepefi/heroData.test.ts`, `frontend/src/pages/pepefi/TraderProfilePage.tsx`, `frontend/src/locales/zh-TW/traderProfile.ts`, `frontend/src/locales/en/traderProfile.ts`

**Interfaces:**
- Consumes: #320 產出的詳細檔，含九個風險與交易統計欄位（見 Step 4a）；`fetchHeroDetail`、`HeroDetail`、`HeroTrade`、`fSignedPct`、`fDrawdown`、`fRatio`、`fUsd`（Task B3）；`t.marketplace.hero.disclosure`（Task B5）；`StatCard`（既有，props：`title`、`value`、`sub?`、`valueColor?`）；`explorerTx(hash, chainId): string | null`（`src/lib/pepefi/explorer`，本機鏈回 null）

- [ ] **Step 1: 加顯示文字**

`frontend/src/locales/zh-TW/traderProfile.ts`，在 `activity: { … },` 之後、檔案結尾的 `};` 之前加：

```ts
  /** 模擬交易者的歷史績效（issue #309）。該位址有績效資料時才出現。 */
  hero: {
    performanceTitle: '歷史績效',
    range: '{from} 至 {to}',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    winRate: '勝率',
    winRateSub: '{count} 筆平倉',
    esgCorrelation: '與永續型資產的相關性',
    esgCorrelationSub: '日報酬對 sESGU',
    avgHold: '平均持有',
    avgHoldValue: '{days} 天',
    equityTitle: '淨值',
    equityNote: '淨值 = 可用保證金 + 各部位依當日價格計算的價值。未平倉部位尚未實現的借款費與資金費率不計入，平倉時才反映。',
    monthlyTitle: '逐月報酬',
    exposureTitle: '目前策略的持倉分布',
    strategiesTitle: '策略版本',
    strategyVersion: '第 {version} 版',
    tradesTitle: '部位紀錄',
    tradesNote: '損益為淨額：平倉取回的金額減去保證金與開倉手續費。括號內是未扣費用與資金費率的價差損益。',
    colAsset: '資產',
    colSide: '方向',
    colMargin: '保證金',
    colOpen: '開倉',
    colClose: '平倉',
    colPnl: '損益',
    colProof: '交易',
    long: '多',
    short: '空',
    stillOpen: '未平倉',
    liquidated: '已清算',
    openTx: '開倉交易',
    closeTx: '平倉交易',
    publishTx: '發布交易',
    proofLoading: '從鏈上讀取中…',
    proofFailed: '這筆交易讀不到。鏈重新啟動後，歷史交易可能不在節點上。',
    proofBlock: '區塊 {block}',
    proofTime: '時間 {time}',
    proofStatus: '狀態 {status}',
    proofSuccess: '成功',
    proofReverted: '失敗',
    proofLogs: '{count} 筆事件',
    showMore: '顯示全部 {count} 筆',
  },
```

`frontend/src/locales/en/traderProfile.ts`，同樣的位置加：

```ts
  hero: {
    performanceTitle: 'Track record',
    range: '{from} to {to}',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    winRate: 'Win rate',
    winRateSub: '{count} closed',
    esgCorrelation: 'Correlation with sustainable assets',
    esgCorrelationSub: 'Daily returns vs sESGU',
    avgHold: 'Average hold',
    avgHoldValue: '{days} days',
    equityTitle: 'Equity',
    equityNote: 'Equity = free margin + each position valued at the day\'s price. Borrow fees and funding not yet realised on open positions are left out until the position closes.',
    monthlyTitle: 'Monthly returns',
    exposureTitle: 'Current strategy exposure',
    strategiesTitle: 'Strategy versions',
    strategyVersion: 'Version {version}',
    tradesTitle: 'Positions',
    tradesNote: 'PnL is net: the amount returned on close, less margin and the opening fee. The figure in brackets is the price move before fees and funding.',
    colAsset: 'Asset',
    colSide: 'Side',
    colMargin: 'Margin',
    colOpen: 'Open',
    colClose: 'Close',
    colPnl: 'PnL',
    colProof: 'Transactions',
    long: 'Long',
    short: 'Short',
    stillOpen: 'Open',
    liquidated: 'Liquidated',
    openTx: 'Open transaction',
    closeTx: 'Close transaction',
    publishTx: 'Publish transaction',
    proofLoading: 'Reading from chain…',
    proofFailed: 'This transaction could not be read. After the chain restarts, historical transactions may not be on the node.',
    proofBlock: 'Block {block}',
    proofTime: 'Time {time}',
    proofStatus: 'Status {status}',
    proofSuccess: 'success',
    proofReverted: 'reverted',
    proofLogs: '{count} events',
    showMore: 'Show all {count}',
  },
```

Run: `yarn vitest run src/locales`
Expected: 通過。

- [ ] **Step 2: 寫績效元件**

`frontend/src/components/pepefi/hero/HeroPerformance.tsx`：

```tsx
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Bar, Cell, Line, XAxis, YAxis, Tooltip, BarChart, LineChart, CartesianGrid, ResponsiveContainer } from 'recharts';

import { t, interpolate } from 'src/locales';
import StatCard from 'src/components/pepefi/StatCard';
import { MONO } from 'src/components/pepefi/brandKit';
import { fRatio, fDrawdown, fSignedPct, type HeroDetail } from 'src/lib/pepefi/heroData';

// ----------------------------------------------------------------------
// 模擬交易者的歷史績效（issue #309）。資料來自 public/data/heroes/<address>.json，
// 由鏈上事件在鏈下算出；這個元件只畫，不讀鏈。

const STAT = { xs: 6, md: 4 };

export default function HeroPerformance({ hero }: { hero: HeroDetail }) {
  const theme = useTheme();
  const L = t.traderProfile.hero;
  const up = theme.palette.success.main;
  const down = theme.palette.error.main;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="baseline" spacing={1.5} flexWrap="wrap">
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.performanceTitle}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {interpolate(L.range, {
            from: hero.equityCurve[0]?.date ?? '—',
            to: hero.equityCurve[hero.equityCurve.length - 1]?.date ?? '—',
          })}
        </Typography>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={STAT}>
          <StatCard
            title={L.totalReturn}
            value={fSignedPct(hero.totalReturnPct)}
            valueColor={hero.totalReturnPct >= 0 ? 'success.main' : 'error.main'}
          />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.maxDrawdown} value={fDrawdown(hero.maxDrawdownPct)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.sharpe} value={fRatio(hero.sharpe)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.winRate}
            value={hero.winRatePct === null ? '—' : `${hero.winRatePct.toFixed(0)}%`}
            sub={interpolate(L.winRateSub, { count: hero.closedTrades })}
          />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.esgCorrelation} value={fRatio(hero.esgCorrelation)} sub={L.esgCorrelationSub} />
        </Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.avgHold}
            value={hero.avgHoldDays === null ? '—' : interpolate(L.avgHoldValue, { days: hero.avgHoldDays.toFixed(1) })}
          />
        </Grid>
      </Grid>

      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.equityTitle}</Typography>
        <Box sx={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={hero.equityCurve} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={48} />
              <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={64} />
              <Tooltip />
              <Line type="monotone" dataKey="equity" stroke={theme.palette.primary.main} dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Box>
        <Typography variant="caption" color="text.secondary">{L.equityNote}</Typography>
      </Card>

      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.monthlyTitle}</Typography>
        <Box sx={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hero.monthlyReturns} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
              <Tooltip />
              <Bar dataKey="returnPct" isAnimationActive={false}>
                {hero.monthlyReturns.map((m) => (
                  <Cell key={m.month} fill={m.returnPct >= 0 ? up : down} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Box>
      </Card>

      {hero.exposure.length > 0 && (
        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.exposureTitle}</Typography>
          <Stack spacing={1}>
            {hero.exposure.map((leg) => (
              <Box key={leg.asset}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 64 }}>{leg.asset}</Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={leg.isLong ? 'success' : 'error'}
                    label={`${leg.isLong ? L.long : L.short} ${leg.leverage}×`}
                    sx={{ height: 20, fontSize: '0.6875rem' }}
                  />
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>{leg.weightPct.toFixed(0)}%</Typography>
                </Stack>
                <Box sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}>
                  <Box sx={{ width: `${leg.weightPct}%`, height: '100%', bgcolor: leg.isLong ? up : down }} />
                </Box>
              </Box>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
```

- [ ] **Step 3: 寫策略版本與部位列表元件**

`frontend/src/components/pepefi/hero/HeroTrades.tsx`：

```tsx
import type { BrowserProvider } from 'ethers';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import TableRow from '@mui/material/TableRow';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import TableContainer from '@mui/material/TableContainer';

import { t, interpolate } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import { explorerTx } from 'src/lib/pepefi/explorer';
import { fUsd, type HeroDetail, type HeroTrade } from 'src/lib/pepefi/heroData';

// ----------------------------------------------------------------------
// 模擬交易者的策略版本與部位紀錄（issue #309）。每一筆都附交易雜湊；點開會直接向節點
// 讀這筆交易的收據——畫面上的「交易證明」是鏈回的答案，不是資料檔自己說的。

const FIRST_PAGE = 25;
const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const fDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

type Proof =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; block: number; time: number | null; success: boolean; logs: number };

function TxProof({ label, hash, provider, chainId }: {
  label: string;
  hash: string;
  provider: BrowserProvider | null;
  chainId: number | null;
}) {
  const [proof, setProof] = useState<Proof | null>(null);
  const L = t.traderProfile.hero;
  const href = explorerTx(hash, chainId);

  const load = async () => {
    if (!provider) return setProof({ state: 'failed' });
    setProof({ state: 'loading' });
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) return setProof({ state: 'failed' });
      const block = await provider.getBlock(receipt.blockNumber);
      return setProof({
        state: 'ok',
        block: receipt.blockNumber,
        time: block?.timestamp ?? null,
        success: receipt.status === 1,
        logs: receipt.logs.length,
      });
    } catch {
      return setProof({ state: 'failed' });
    }
  };

  return (
    <Box sx={{ lineHeight: 1.4 }}>
      <Typography variant="caption" color="text.secondary">{label} </Typography>
      {href ? (
        <Link href={href} target="_blank" rel="noopener noreferrer" variant="caption" sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      ) : (
        <Link component="button" type="button" variant="caption" onClick={() => void load()} sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      )}
      {proof?.state === 'loading' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{L.proofLoading}</Typography>
      )}
      {proof?.state === 'failed' && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{L.proofFailed}</Typography>
      )}
      {proof?.state === 'ok' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: MONO }}>
          {interpolate(L.proofBlock, { block: proof.block })}
          {' · '}
          {interpolate(L.proofTime, { time: proof.time === null ? '—' : new Date(proof.time * 1000).toISOString().replace('.000Z', 'Z') })}
          {' · '}
          {interpolate(L.proofStatus, { status: proof.success ? L.proofSuccess : L.proofReverted })}
          {' · '}
          {interpolate(L.proofLogs, { count: proof.logs })}
        </Typography>
      )}
    </Box>
  );
}

function PnlCell({ trade }: { trade: HeroTrade }) {
  const L = t.traderProfile.hero;
  if (trade.pnlUsd === null) {
    return <Chip size="small" variant="outlined" label={L.stillOpen} sx={{ height: 20, fontSize: '0.6875rem' }} />;
  }
  return (
    <Stack alignItems="flex-end" spacing={0.25}>
      <Box sx={{ fontFamily: MONO, fontWeight: 'bold', color: trade.pnlUsd >= 0 ? 'success.main' : 'error.main' }}>
        {trade.pnlUsd >= 0 ? '+' : ''}{fUsd(trade.pnlUsd)}
      </Box>
      <Box sx={{ fontFamily: MONO, fontSize: '0.6875rem', color: 'text.secondary' }}>
        ({trade.grossPnlUsd !== null && trade.grossPnlUsd >= 0 ? '+' : ''}{fUsd(trade.grossPnlUsd)})
      </Box>
      {trade.liquidated && (
        <Chip size="small" color="error" variant="outlined" label={L.liquidated} sx={{ height: 18, fontSize: '0.625rem' }} />
      )}
    </Stack>
  );
}

interface Props {
  hero: HeroDetail;
  provider: BrowserProvider | null;
  chainId: number | null;
}

export default function HeroTrades({ hero, provider, chainId }: Props) {
  const [showAll, setShowAll] = useState(false);
  const L = t.traderProfile.hero;
  // 最新的在最上面
  const strategies = [...hero.strategies].reverse();
  const trades = [...hero.trades].reverse();
  const shown = showAll ? trades : trades.slice(0, FIRST_PAGE);

  return (
    <Stack spacing={2}>
      {strategies.length > 0 && (
        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>{L.strategiesTitle}</Typography>
          <Stack spacing={1.5}>
            {strategies.map((version) => (
              <Box key={version.versionId}>
                <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {interpolate(L.strategyVersion, { version: version.versionId + 1 })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>{version.date}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ my: 0.5 }}>
                  {version.legs.map((leg) => (
                    <Chip
                      key={leg.asset}
                      size="small"
                      variant="outlined"
                      color={leg.isLong ? 'success' : 'error'}
                      label={`${leg.isLong ? '↑' : '↓'}${leg.asset} ${(leg.weightBps / 100).toFixed(0)}% ${leg.leverage}×`}
                      sx={{ height: 20, fontSize: '0.6875rem', fontFamily: MONO }}
                    />
                  ))}
                </Stack>
                <TxProof label={L.publishTx} hash={version.tx} provider={provider} chainId={chainId} />
              </Box>
            ))}
          </Stack>
        </Card>
      )}

      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.tradesTitle}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{L.tradesNote}</Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{L.colAsset}</TableCell>
                <TableCell>{L.colSide}</TableCell>
                <TableCell align="right">{L.colMargin}</TableCell>
                <TableCell align="right">{L.colOpen}</TableCell>
                <TableCell align="right">{L.colClose}</TableCell>
                <TableCell align="right">{L.colPnl}</TableCell>
                <TableCell>{L.colProof}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((trade) => (
                <TableRow key={trade.positionId} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{trade.asset}</TableCell>
                  <TableCell sx={{ color: trade.isLong ? 'success.main' : 'error.main', whiteSpace: 'nowrap' }}>
                    {trade.isLong ? L.long : L.short} {trade.leverage}×
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>{fUsd(trade.marginUsd)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                    {fUsd(trade.openPrice)}
                    <Box sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>{fDay(trade.openTime)}</Box>
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                    {fUsd(trade.closePrice)}
                    <Box sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>
                      {trade.closeTime === null ? '—' : fDay(trade.closeTime)}
                    </Box>
                  </TableCell>
                  <TableCell align="right"><PnlCell trade={trade} /></TableCell>
                  <TableCell>
                    <TxProof label={L.openTx} hash={trade.openTx} provider={provider} chainId={chainId} />
                    {trade.closeTx && (
                      <TxProof label={L.closeTx} hash={trade.closeTx} provider={provider} chainId={chainId} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {!showAll && trades.length > FIRST_PAGE && (
          <Button size="small" onClick={() => setShowAll(true)} sx={{ mt: 1, textTransform: 'none' }}>
            {interpolate(L.showMore, { count: trades.length })}
          </Button>
        )}
      </Card>
    </Stack>
  );
}
```

- [ ] **Step 4: 掛到個人頁**

`frontend/src/pages/pepefi/TraderProfilePage.tsx`：

匯入區加：

```tsx
import Alert from '@mui/material/Alert'
import HeroTrades from 'src/components/pepefi/hero/HeroTrades'
import HeroPerformance from 'src/components/pepefi/hero/HeroPerformance'
import { fetchHeroDetail, type HeroDetail } from 'src/lib/pepefi/heroData'
```

（`Alert` 若已經匯入就不要重複。）

在其他 `useState` 旁邊加一個狀態，並在第一個讀鏈的 `useEffect` 之前加一個獨立的 effect：

```tsx
  // 模擬交易者的績效資料（issue #309）。讀的是靜態檔，不該被讀鏈的 loading 拖住；
  // 這個位址不是模擬交易者、或這條鏈沒有資料時維持 null，下面的區塊就不出現。
  const [hero, setHero] = useState<HeroDetail | null>(null)

  useEffect(() => {
    let cancelled = false
    setHero(null)
    if (!traderAddr) return undefined
    void fetchHeroDetail(traderAddr, wallet.chainId).then((detail) => {
      if (!cancelled) setHero(detail)
    })
    return () => { cancelled = true }
  }, [traderAddr, wallet.chainId])
```

在 JSX 裡，`{/* ─── B. Stats grid (4 cards) ──… */}` 那個 `<Grid container …>` 的**前面**加揭露文字：

```tsx
          {hero && (
            <Alert severity="info" variant="outlined">
              {t.marketplace.hero.disclosure}
            </Alert>
          )}
```

在那個 Stats `<Grid container>` 結束之後、`{/* ─── C. Latest Strategy ──… */}` 之前加：

```tsx
          {hero && <HeroPerformance hero={hero} />}
```

在 `{/* ─── F. On-chain activity ──… */}` 的註解之前加：

```tsx
          {hero && <HeroTrades hero={hero} provider={wallet.provider} chainId={wallet.chainId} />}
```

- [ ] **Step 4a: 績效資料加上風險與交易統計（型別、驗證、測試）**

#320 的詳細檔多了九個欄位（參考 eToro 交易者統計頁）：`riskScore`（1–10，可能是 `null`）、`worstDayLossPct`、`worstWeekLossPct`、`maxDrawdown1yPct`、`profitableWeeksPct`（可能是 `null`）、`tradesPerWeek`、`topAssets`（`{ asset, trades, sharePct }[]`）、`followerHistory`（`{ month, followers }[]`）、`activeSince`（日期字串或 `null`）。

`frontend/src/lib/pepefi/heroData.ts`，在 `HeroDetail` 介面的 `avgHoldDays: number | null` 後面加：

```ts
  /** 1–10，最近 365 天日報酬的 95% 單日 VaR 分級；資料不足 30 天時為 null。 */
  riskScore: number | null
  /** 以下三個是正數表示的損失百分比。 */
  worstDayLossPct: number
  worstWeekLossPct: number
  maxDrawdown1yPct: number
  profitableWeeksPct: number | null
  tradesPerWeek: number
  topAssets: { asset: string; trades: number; sharePct: number }[]
  followerHistory: { month: string; followers: number }[]
  activeSince: string | null
```

`parseHeroDetail` 裡，`if (!isNumOrNull(record.esgCorrelation) || !isNumOrNull(record.avgHoldDays)) return null` 的後面加：

```ts
  if (!isNumOrNull(record.riskScore) || !isNumOrNull(record.profitableWeeksPct)) return null
  if (!['worstDayLossPct', 'worstWeekLossPct', 'maxDrawdown1yPct', 'tradesPerWeek'].every((k) => isNum(record[k]))) return null
  if (!Array.isArray(record.topAssets) || !Array.isArray(record.followerHistory)) return null
  if (record.activeSince !== null && typeof record.activeSince !== 'string') return null
```

`frontend/src/lib/pepefi/heroData.test.ts`，把 `const detail = { … }` 裡的 `esgCorrelation: 0.41, avgHoldDays: 23.5, strategies: [], trades: [],` 換成：

```ts
  esgCorrelation: 0.41, avgHoldDays: 23.5,
  riskScore: 6, worstDayLossPct: 4.1, worstWeekLossPct: 9.8, maxDrawdown1yPct: 12.3,
  profitableWeeksPct: 58.3, tradesPerWeek: 1.4,
  topAssets: [{ asset: 'sBTC', trades: 12, sharePct: 40 }],
  followerHistory: [{ month: '2024-10', followers: 2 }],
  activeSince: '2024-10-01',
  strategies: [], trades: [],
```

在 `describe('parseHeroDetail', …)` 裡加一個案例：

```ts
  it('refuses a detail file from before the risk statistics existed', () => {
    const older: Record<string, unknown> = { ...detail }
    delete older.riskScore
    expect(parseHeroDetail(older, ADDR)).toBeNull()
    expect(parseHeroDetail({ ...detail, riskScore: null, profitableWeeksPct: null, activeSince: null }, ADDR)).not.toBeNull()
  })
```

Run（在 `frontend/` 內）: `yarn vitest run src/lib/pepefi/heroData.test.ts`
Expected: 18 passed

- [ ] **Step 4b: 風險與交易統計的顯示文字**

`frontend/src/locales/zh-TW/traderProfile.ts`，在 `hero: { … }` 裡 `showMore` 那一行後面加：

```ts
    riskTitle: '風險與交易統計',
    riskScore: '風險分數',
    riskScoreScale: '1 最低、10 最高',
    riskScoreNote: '依最近一年日報酬的 95% 單日風險值（VaR）分級，參考 eToro 的風險分數；分級門檻是本平台自訂的。',
    worstDay: '最差單日',
    worstWeek: '最差一週',
    drawdown1y: '近一年最大回撤',
    profitableWeeks: '獲利週數',
    tradesPerWeek: '每週交易',
    activeSince: '開始交易',
    topAssets: '最常交易的資產',
    topAssetValue: '{asset} {share}%',
    followersTitle: '跟隨人數',
```

`frontend/src/locales/en/traderProfile.ts`，同樣的位置加：

```ts
    riskTitle: 'Risk and trading statistics',
    riskScore: 'Risk score',
    riskScoreScale: '1 lowest, 10 highest',
    riskScoreNote: 'Graded on the one-day 95% value at risk (VaR) of the past year of daily returns, after eToro\'s risk score; the grade thresholds are this platform\'s own.',
    worstDay: 'Worst day',
    worstWeek: 'Worst week',
    drawdown1y: 'Max drawdown, past year',
    profitableWeeks: 'Profitable weeks',
    tradesPerWeek: 'Trades per week',
    activeSince: 'Trading since',
    topAssets: 'Most traded assets',
    topAssetValue: '{asset} {share}%',
    followersTitle: 'Followers',
```

- [ ] **Step 4c: 風險與交易統計元件**

`frontend/src/components/pepefi/hero/HeroRiskStats.tsx`：

```tsx
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Line, XAxis, YAxis, Tooltip, LineChart, ResponsiveContainer } from 'recharts';

import { t, interpolate } from 'src/locales';
import StatCard from 'src/components/pepefi/StatCard';
import { MONO } from 'src/components/pepefi/brandKit';
import type { HeroDetail } from 'src/lib/pepefi/heroData';

// ----------------------------------------------------------------------
// 參考 eToro 交易者統計頁的「風險」「交易」「其他」三張卡（issue #309）。數字來自
// public/data/heroes/<address>.json，由鏈上事件算出；這個元件只畫。

const STAT = { xs: 6, md: 3 };
const loss = (v: number) => (v === 0 ? '0.0%' : `-${v.toFixed(1)}%`);

function RiskMeter({ score }: { score: number | null }) {
  const theme = useTheme();
  const colorOf = (n: number) =>
    n <= 3 ? theme.palette.success.main : n <= 6 ? theme.palette.warning.main : theme.palette.error.main;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <Box
          key={n}
          sx={{
            width: 18, height: 18, borderRadius: 0.5,
            bgcolor: score !== null && n <= score ? colorOf(score) : 'action.hover',
          }}
        />
      ))}
      <Typography sx={{ ml: 1, fontFamily: MONO, fontWeight: 'bold' }}>{score ?? '—'}</Typography>
    </Stack>
  );
}

export default function HeroRiskStats({ hero }: { hero: HeroDetail }) {
  const theme = useTheme();
  const L = t.traderProfile.hero;

  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>{L.riskTitle}</Typography>

      <Stack spacing={0.5} sx={{ mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Typography variant="subtitle2">{L.riskScore}</Typography>
          <Typography variant="caption" color="text.secondary">{L.riskScoreScale}</Typography>
        </Stack>
        <RiskMeter score={hero.riskScore} />
        <Typography variant="caption" color="text.secondary">{L.riskScoreNote}</Typography>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={STAT}><StatCard title={L.worstDay} value={loss(hero.worstDayLossPct)} /></Grid>
        <Grid size={STAT}><StatCard title={L.worstWeek} value={loss(hero.worstWeekLossPct)} /></Grid>
        <Grid size={STAT}><StatCard title={L.drawdown1y} value={loss(hero.maxDrawdown1yPct)} /></Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.profitableWeeks}
            value={hero.profitableWeeksPct === null ? '—' : `${hero.profitableWeeksPct.toFixed(0)}%`}
          />
        </Grid>
        <Grid size={STAT}><StatCard title={L.tradesPerWeek} value={hero.tradesPerWeek.toFixed(1)} /></Grid>
        <Grid size={STAT}><StatCard title={L.activeSince} value={hero.activeSince ?? '—'} /></Grid>
      </Grid>

      {hero.topAssets.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
          <Typography variant="subtitle2" sx={{ mr: 1 }}>{L.topAssets}</Typography>
          {hero.topAssets.map((a) => (
            <Chip
              key={a.asset}
              size="small"
              variant="outlined"
              label={interpolate(L.topAssetValue, { asset: a.asset, share: a.sharePct.toFixed(0) })}
              sx={{ fontFamily: MONO }}
            />
          ))}
        </Stack>
      )}

      {hero.followerHistory.length > 1 && (
        <>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{L.followersTitle}</Typography>
          <Box sx={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hero.followerHistory} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
                <Tooltip />
                <Line type="stepAfter" dataKey="followers" stroke={theme.palette.info.main} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 4d: 掛到個人頁**

`frontend/src/pages/pepefi/TraderProfilePage.tsx`，匯入區加：

```tsx
import HeroRiskStats from 'src/components/pepefi/hero/HeroRiskStats'
```

把 `{hero && <HeroPerformance hero={hero} />}` 換成：

```tsx
          {hero && <HeroPerformance hero={hero} />}
          {hero && <HeroRiskStats hero={hero} />}
```

- [ ] **Step 5: 型別、lint、測試**

Run（在 `frontend/` 內）: `yarn tsc --noEmit && yarn lint && yarn test`
Expected: 全部通過。`recharts` 的匯入順序若被 lint 的 perfectionist 規則調整，執行 `yarn lint:fix` 讓它自己排。

- [ ] **Step 6: 在瀏覽器對著本機鏈驗證**

環境同 Task B5 Step 7。從排行榜點進一位交易者（`/trader/<位址>`）。逐項確認：

1. 頁首下方出現揭露文字。
2. 六張績效卡的數字與該位址的 `frontend/public/data/heroes/<位址小寫>.json` 相符。
3. 淨值曲線有畫出來，起點接近 10,000；滑鼠移上去有數值。
4. 逐月報酬的長條，正的是綠、負的是紅。
5. 持倉分布與上方「最新策略」那張卡（從鏈上讀的）是同一組資產與權重。
6. 策略版本由新到舊；點發布交易的雜湊，下方出現「區塊 N · 時間 … · 狀態 成功 · M 筆事件」。
7. 部位紀錄的每一列有開倉交易；已平倉的有平倉交易與損益。點開倉交易的雜湊，出現鏈上讀回的區塊與時間，時間的日期與該列的開倉日期相同。
8. 被清算的部位（槓桿交易者 Crypto Degen／Low Carbon Lev 最容易有）標示「已清算」。
9. 跟隨者人數、質押、聲譽照舊顯示（從鏈上讀的）。
10. 開一個不是模擬交易者的位址（例如展示帳號自己）：沒有揭露文字、沒有績效區塊、頁面其餘部分正常。
11. 「風險與交易統計」卡：風險分數的格數與數字相同，與詳細檔的 `riskScore` 相符；槓桿交易者（Crypto Degen、Low Carbon Lev）的分數明顯高於買入持有類。
12. 跟隨人數的走勢線，最後一個點等於上方從鏈上讀到的跟隨者人數；有人取消過跟單的交易者，走勢線要有下降的段落。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/pepefi/hero frontend/src/pages/pepefi/TraderProfilePage.tsx \
  frontend/src/lib/pepefi/heroData.ts frontend/src/lib/pepefi/heroData.test.ts \
  frontend/src/locales/zh-TW/traderProfile.ts frontend/src/locales/en/traderProfile.ts
git commit -m "feat(frontend): 交易者個人頁顯示模擬交易者的淨值、策略版本與可回鏈上核對的部位紀錄（#309）"
```

---

### Task B7: 展示啟動腳本、跟單防護與跟單流程走通

**Files:**
- Create: `frontend/.env.heroes`, `scripts/heroes-demo.sh`
- Create: `frontend/src/lib/pepefi/copyGuards.ts`, `frontend/src/lib/pepefi/copyGuards.test.ts`
- Modify: `frontend/src/pages/pepefi/CopyPage.tsx`, `frontend/src/pages/pepefi/PortfolioPage.tsx`, `frontend/src/locales/{zh-TW,en}/copy.ts`, `frontend/src/locales/{zh-TW,en}/portfolio.ts`, `heroes/README.md`

**Interfaces:**
- Consumes: `heroes/out/chain.json`、`heroes/out/addresses.json`（資料線 Task A6）；`agent/heroes/priceTick.ts`（資料線 Task A8）

**這個 Task 的 Step 5 需要人操作瀏覽器與錢包。**

- [ ] **Step 1: 本機展示用的功能旗標**

`frontend/.env.heroes`：

```
# 本機展示模擬交易者（issue #309）：yarn dev --mode heroes
# 只打開這個展示需要的 Authorized Feature；不含任何金鑰，可以進版控。
# 公開展示站不讀這個檔（它不用 --mode heroes），跟單在那裡照舊是關的。
VITE_FEATURE_COPY_TRADING=1
VITE_SHOW_PERPETUALS=1
VITE_SHOW_LEVERAGE=1
```

Run（repo 根目錄）: `git check-ignore -v frontend/.env.heroes; echo "exit=$?"`
Expected: 沒有輸出，`exit=1`（沒有被忽略）。

- [ ] **Step 2: 展示啟動腳本**

`scripts/heroes-demo.sh`：

```bash
#!/usr/bin/env bash
# 本機展示：載入回放好的鏈狀態、把鏈的時間對到現在、持續寫入即時價格。
#   scripts/heroes-demo.sh
# 按 Ctrl-C 結束。這裡不存狀態：每次啟動都回到回放剛結束的樣子，展示可以重複做。
# PATH 上要有 anvil／cast。開啟 Smart App Control 的 Windows 機器請在 WSL 裡跑，
# 並先 export PATH="$HOME/.foundry/bin:$PATH"。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/heroes/out/chain.json"
ADDRESSES="$ROOT/heroes/out/addresses.json"
PORT="${HEROES_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"

[ -f "$STATE" ] && [ -f "$ADDRESSES" ] || { echo "找不到鏈狀態：先跑 scripts/heroes-replay.sh（見 heroes/README.md）" >&2; exit 2; }
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "$RPC 已經有節點在回應，先關掉它，或設 HEROES_PORT 換埠。" >&2
  exit 2
fi

anvil --port "$PORT" --host 0.0.0.0 --load-state "$STATE" --silent &
ANVIL_PID=$!
TICK_PID=""
cleanup() {
  [ -n "$TICK_PID" ] && kill "$TICK_PID" 2>/dev/null || true
  kill -INT "$ANVIL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "不是本機鏈，中止" >&2; exit 1; }

# 載入的狀態停在回放的最後一天。把下一個區塊的時間設成現在，畫面上的「多久以前」與
# 報價新鮮度才會是對的。
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$RPC" >/dev/null

(cd "$ROOT/agent" && HEROES_RPC_URL="$RPC" npx tsx heroes/priceTick.ts "$ADDRESSES") &
TICK_PID=$!

cat <<EOF

本機鏈已啟動：$RPC（chain ID 31337，區塊 $(cast block-number --rpc-url "$RPC")）
價格每分鐘寫入一次。

下一步：
  1. 另開終端機：cd frontend && yarn dev --mode heroes
  2. 錢包新增網路：RPC $RPC、chain ID 31337、幣別 ETH
  3. 匯入展示帳號：Anvil 預設帳號 (9)。私鑰用這個指令看（公開的測試金鑰，只能用在本機鏈）：
       anvil --port 8599 | grep -A 12 "Private Keys"     # 列出來的第 (9) 把；看完按 Ctrl-C
  4. 錢包若之前連過本機鏈：清除該帳號的活動紀錄（nonce 快取），否則第一筆交易會卡住。
  5. 前端右上角切到 Expert Mode，開 /marketplace

按 Ctrl-C 結束。
EOF

wait "$ANVIL_PID"
```

Run: `chmod +x scripts/heroes-demo.sh && scripts/heroes-demo.sh`
Expected: 印出上面的說明；約一分鐘內出現 `wrote 11 prices (N changed)`。另一個終端機執行 `cast block-number --rpc-url http://127.0.0.1:8545` 有回應。按 Ctrl-C 後兩個程序都結束（`cast block-number` 不再有回應）。

- [ ] **Step 3: 跟單頁加上「複製的是目前這一版」的說明**

`frontend/src/locales/zh-TW/copy.ts`，在 `confirm: {` 區塊裡 `footer:` 那一行的後面加：

```ts
    /** 跟單不是持續跟隨——這句固定顯示在確認區，送出前一定看得到。 */
    snapshotNote:
      '跟單複製的是交易者「目前這一版」策略。之後交易者發布新版本，你的部位不會自動跟著調整；要換成新版本，請取消跟單後重新跟一次。',
```

`frontend/src/locales/en/copy.ts`，同樣的位置加：

```ts
    snapshotNote:
      'Copying takes the trader\'s current strategy version. If the trader publishes a new version later, your positions do not follow automatically; to move to the new version, unfollow and copy again.',
```

`frontend/src/pages/pepefi/CopyPage.tsx`：找到顯示 `t.copy.confirm.title` 的那個標題元素，在它的正下方加：

```tsx
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          {t.copy.confirm.snapshotNote}
        </Alert>
```

（`Alert` 在這個檔案已經匯入；沒有的話加上 `import Alert from '@mui/material/Alert'`。）

同一個檔案：被跟單的對象是模擬交易者時，這一頁也要固定顯示揭露文字。匯入

```tsx
import { fetchHeroIndex, heroByAddress } from 'src/lib/pepefi/heroData'
```

在元件裡（`wallet` 與 `traderAddress` 是這個檔案既有的變數名稱）加：

```tsx
  // 讀的是靜態檔，不依賴任何鏈上讀取；這條鏈沒有績效資料時維持 false。
  const [isSimulated, setIsSimulated] = useState(false)
  useEffect(() => {
    let cancelled = false
    setIsSimulated(false)
    if (!traderAddress) return undefined
    void fetchHeroIndex(wallet.chainId).then((index) => {
      if (!cancelled) setIsSimulated(!!index && heroByAddress(index).has(traderAddress.toLowerCase()))
    })
    return () => { cancelled = true }
  }, [traderAddress, wallet.chainId])
```

在頁面最上方的標題區塊之後加：

```tsx
        {isSimulated && (
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            {t.marketplace.hero.disclosure}
          </Alert>
        )}
```

Run（在 `frontend/` 內）: `yarn tsc --noEmit && yarn lint && yarn test`
Expected: 全部通過。

- [ ] **Step 3a: 跟單防護的失敗測試（參考 eToro CopyTrader）**

eToro 的跟單有最低金額、整筆跟單的停損（Copy Stop-Loss），而且會持續跟著交易者調整。我們的合約不做自動停損、也不做持續跟隨（見 #309），所以在畫面上補三個不用改合約的防護：

1. 跟單金額太小、會有某一檔低於交易所最低保證金時，送出前就擋下並告訴使用者最低要多少。
2. 交易者發布了新版策略時，在投資組合標示「策略已更新」，並提供一鍵更新：取消舊的跟單、把取回的錢提出來、帶著金額回到跟單頁。
3. 使用者可以替每筆跟單設停損比例；虧損到了就醒目標示並提供一鍵取消。這是提醒，不是鏈上的停損單，畫面上要講清楚。

`frontend/src/lib/pepefi/copyGuards.test.ts`：

```ts
import { describe, it, expect } from 'vitest'

import {
  isOutdated,
  belowMinimum,
  readStopLoss,
  writeStopLoss,
  stopLossReached,
  minimumCopyAmount,
} from './copyGuards'

const E18 = 10n ** 18n

describe('minimum copy amount', () => {
  it('scales the preview until the smallest leg reaches the exchange minimum, rounded up to whole USDC', () => {
    // 試算 1,000 時最小一檔 99 → 1000 × 10 / 99 = 101.01… → 102
    expect(minimumCopyAmount(1000n * E18, [497n * E18, 298n * E18, 99n * E18], 10n * E18)).toBe(102n * E18)
  })

  it('has nothing to say without a usable preview', () => {
    expect(minimumCopyAmount(0n, [1n], 10n * E18)).toBeNull()
    expect(minimumCopyAmount(1000n * E18, [], 10n * E18)).toBeNull()
    expect(minimumCopyAmount(1000n * E18, [0n, 5n * E18], 10n * E18)).toBeNull()
  })

  it('flags a preview with any leg under the minimum', () => {
    expect(belowMinimum([50n * E18, 9n * E18], 10n * E18)).toBe(true)
    expect(belowMinimum([50n * E18, 10n * E18], 10n * E18)).toBe(false)
  })
})

describe('outdated copy', () => {
  it('is outdated when the trader has published a later version', () => {
    expect(isOutdated(0n, 3n)).toBe(true)
    expect(isOutdated(2n, 3n)).toBe(false)
    expect(isOutdated(0n, 1n)).toBe(false)
    expect(isOutdated(0n, 0n)).toBe(false)
  })
})

describe('stop-loss reminder', () => {
  it('fires once the loss reaches the threshold', () => {
    expect(stopLossReached(1000n * E18, 600n * E18, 40)).toBe(true)
    expect(stopLossReached(1000n * E18, 601n * E18, 40)).toBe(false)
  })

  it('never fires without a threshold or a basis', () => {
    expect(stopLossReached(1000n * E18, 0n, null)).toBe(false)
    expect(stopLossReached(0n, 0n, 40)).toBe(false)
  })

  it('remembers a threshold per account and copy, and treats anything odd as unset', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) },
    }
    writeStopLoss('0xAbC', 2, 30, storage)
    expect(readStopLoss('0xabc', 2, storage)).toBe(30)
    expect(readStopLoss('0xabc', 3, storage)).toBeNull()
    writeStopLoss('0xabc', 2, null, storage)
    expect(readStopLoss('0xabc', 2, storage)).toBeNull()
    data.set('pepefi.copyStopLoss.0xabc.5', 'nonsense')
    expect(readStopLoss('0xabc', 5, storage)).toBeNull()
    data.set('pepefi.copyStopLoss.0xabc.6', '99')
    expect(readStopLoss('0xabc', 6, storage)).toBeNull()
    expect(readStopLoss('0xabc', 2, null)).toBeNull()
  })
})
```

Run（在 `frontend/` 內）: `yarn vitest run src/lib/pepefi/copyGuards.test.ts`
Expected: FAIL，`Failed to resolve import "./copyGuards"`

- [ ] **Step 3b: 實作跟單防護**

`frontend/src/lib/pepefi/copyGuards.ts`：

```ts
// 跟單的三個畫面防護（issue #309，參考 eToro CopyTrader）：最低金額、策略已更新、停損提醒。
// 純函式，不含 ethers 或 React。合約不做自動停損、也不做持續跟隨，這裡做的都只是
// 「送出前擋下」與「提醒」，畫面上不能把它說成自動執行。

/**
 * 跟單金額照比例拆給每一檔，每一檔都要達到交易所的最低保證金，否則整筆 revert。
 * 拆分（含跟單費與手續費）對金額是線性的，所以用試算出來的最小一檔反推：
 * 最低金額 = 試算金額 × 最低保證金 ÷ 最小一檔，再往上取到整數 USDC。
 */
export function minimumCopyAmount(previewAmount: bigint, portions: bigint[], minMargin: bigint): bigint | null {
  if (previewAmount <= 0n || portions.length === 0) return null
  const smallest = portions.reduce((a, b) => (b < a ? b : a))
  if (smallest <= 0n) return null
  const raw = (previewAmount * minMargin + smallest - 1n) / smallest
  const unit = 10n ** 18n
  return ((raw + unit - 1n) / unit) * unit
}

export const belowMinimum = (portions: bigint[], minMargin: bigint): boolean =>
  portions.some((portion) => portion < minMargin)

/** 跟單紀錄綁定的版本，比交易者最新發布的那一版舊。strategyCount 是 getStrategyCount 的值。 */
export const isOutdated = (recordVersion: bigint, strategyCount: bigint): boolean =>
  strategyCount > 0n && recordVersion < strategyCount - 1n

/** 目前價值 ≤ 投入 ×（100 − 停損比例）／100。沒有設定（null）永遠不觸發。 */
export function stopLossReached(initial: bigint, current: bigint, thresholdPct: number | null): boolean {
  if (thresholdPct === null || initial <= 0n) return false
  return current * 100n <= initial * BigInt(100 - Math.round(thresholdPct))
}

export const STOP_LOSS_CHOICES = [20, 30, 40, 50] as const

type StopLossStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): StopLossStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const storageKey = (account: string, index: number) => `pepefi.copyStopLoss.${account.toLowerCase()}.${index}`

/** 只存在這台瀏覽器——這是個人提醒，不是鏈上狀態。讀不到、格式不對都當作沒有設定。 */
export function readStopLoss(account: string, index: number, storage: StopLossStorage | null = browserStorage()): number | null {
  try {
    const raw = storage?.getItem(storageKey(account, index))
    if (!raw) return null
    const value = Number(raw)
    return Number.isInteger(value) && value >= 1 && value <= 95 ? value : null
  } catch {
    return null
  }
}

export function writeStopLoss(
  account: string,
  index: number,
  thresholdPct: number | null,
  storage: StopLossStorage | null = browserStorage(),
): void {
  try {
    if (thresholdPct === null) storage?.removeItem(storageKey(account, index))
    else storage?.setItem(storageKey(account, index), String(thresholdPct))
  } catch {
    // 寫不進去（私密視窗、被封鎖）就只是記不住，不影響跟單本身
  }
}
```

Run: `yarn vitest run src/lib/pepefi/copyGuards.test.ts`
Expected: 7 passed

- [ ] **Step 3c: 跟單頁擋下太小的金額，並接受預填金額**

`frontend/src/locales/zh-TW/copy.ts`，在 `amount: {` 區塊裡最後一個鍵的後面加：

```ts
    /** 金額太小，有一檔會低於交易所的最低保證金，整筆會失敗。 */
    belowMinimum: '金額太小：照比例拆分後有一檔低於交易所的最低保證金。這位交易者的策略最少需要 {amount} USDC。',
```

`frontend/src/locales/en/copy.ts`，同樣的位置加：

```ts
    belowMinimum: 'Amount too small: once split by weight, one leg falls under the exchange minimum margin. This strategy needs at least {amount} USDC.',
```

`frontend/src/pages/pepefi/CopyPage.tsx`：

1. 匯入：把 `import { useParams, useNavigate, Link as RouterLink } from 'react-router'` 改成 `import { useParams, useNavigate, useSearchParams, Link as RouterLink } from 'react-router'`，並加上

```tsx
import { belowMinimum, minimumCopyAmount } from 'src/lib/pepefi/copyGuards'
```

2. 在元件裡 `useParams` 那一行附近加 `const [searchParams] = useSearchParams()`，並把 `totalMargin` 的 `useState(…)` 初始值改成 `searchParams.get('amount') ?? <原本的初始值>`——從投資組合「更新到最新版」過來時，金額已經帶好。

3. 在其他 `useState` 旁加最低保證金（讀不到時用合約目前的值 10 USDC）：

```tsx
  // PerpetualExchange.MIN_MARGIN：每一檔部位的最低保證金。讀不到就用合約目前的常數。
  const [minMargin, setMinMargin] = useState<bigint>(10n * 10n ** 18n)
  useEffect(() => {
    if (!contracts) return
    void (contracts.exchange.MIN_MARGIN() as Promise<bigint>).then(setMinMargin).catch(() => undefined)
  }, [contracts])
```

4. 在 `const doApprove = async () => {` 的前面加：

```tsx
  const tooSmall = preview !== null && belowMinimum(preview.portions, minMargin)
  const minAmount = preview && tooSmall ? minimumCopyAmount(totalBig, preview.portions, minMargin) : null
```

5. 在確認區（`t.copy.confirm.snapshotNote` 那個 Alert 的下方）加：

```tsx
        {tooSmall && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {interpolate(t.copy.amount.belowMinimum, {
              amount: minAmount === null ? '—' : (minAmount / 10n ** 18n).toString(),
            })}
          </Alert>
        )}
```

6. 「步驟 1 · 批准」按鈕的 `disabled={…}` 最後加上 `|| tooSmall`；「步驟 2 · 跟隨交易者」按鈕的 `disabled={…}` 也加上 `|| tooSmall`。

- [ ] **Step 3d: 投資組合標示「策略已更新」、一鍵更新、停損提醒**

`frontend/src/locales/zh-TW/portfolio.ts`，在 `page: {` 裡的 `copyColumn: {` 區塊內加一個欄位標題：

```ts
      stopLoss: '停損提醒',
```

在 `page: {` 裡（`copyPositions` 那一行附近）加：

```ts
    copyOutdated: '策略已更新',
    copyOutdatedHint: '交易者發布了新版策略。你的跟單仍是舊版，不會自動調整。',
    copyRefresh: '更新到最新版',
    copyRefreshing: '更新中…',
    copyRefreshStep: '取消舊的跟單、把取回的 {amount} USDC 提回錢包，接著到跟單頁用同樣金額跟最新版。',
    stopLossNone: '不提醒',
    stopLossOption: '虧 {pct}%',
    stopLossReached: '已達停損',
    stopLossHint: '停損提醒只存在這個瀏覽器，不會自動平倉；到了請自己按「取消跟單」。',
```

`frontend/src/locales/en/portfolio.ts`，同樣的位置各加：

```ts
      stopLoss: 'Stop-loss reminder',
```

```ts
    copyOutdated: 'Strategy updated',
    copyOutdatedHint: 'The trader has published a new strategy version. Your copy is still on the old one and does not adjust by itself.',
    copyRefresh: 'Move to latest',
    copyRefreshing: 'Updating…',
    copyRefreshStep: 'Unfollow the old copy, withdraw the {amount} USDC it returns to your wallet, then copy the latest version with the same amount.',
    stopLossNone: 'Off',
    stopLossOption: 'At -{pct}%',
    stopLossReached: 'Stop-loss reached',
    stopLossHint: 'The stop-loss reminder lives in this browser only and never closes anything by itself; when it fires, press Unfollow.',
```

`frontend/src/pages/pepefi/PortfolioPage.tsx`：

1. 匯入：

```tsx
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import { isOutdated, readStopLoss, writeStopLoss, stopLossReached, STOP_LOSS_CHOICES } from 'src/lib/pepefi/copyGuards'
```

（`Select`、`MenuItem`、`Chip`、`Tooltip` 已匯入的就不要重複；缺的補上。）

2. `CopyRec` 介面加兩個欄位：

```ts
  versionId:     bigint;
  /** 交易者目前發布過幾版（getStrategyCount）；讀不到時為 null，就不標示「已更新」。 */
  strategyCount: bigint | null;
```

3. 讀取跟單紀錄的那段：在 `nameMap` 的迴圈旁，同樣對每位交易者讀版本數：

```ts
      const countMap: Record<string, bigint | null> = {};
      await Promise.all(
        uniqueTraders.map(async ta => {
          try { countMap[ta] = (await contracts.registry.getStrategyCount(ta)) as bigint; }
          catch { countMap[ta] = null; }
        })
      );
```

並在 `enriched` 回傳的物件裡加 `versionId: rec.versionId, strategyCount: countMap[rec.trader] ?? null,`。

4. 停損設定的狀態（在其他 `useState` 旁）：

```tsx
  const [stopLoss, setStopLoss] = useState<Record<number, number | null>>({});
  useEffect(() => {
    if (!wallet.address) return;
    setStopLoss(Object.fromEntries(copyRecs.map(r => [r.index, readStopLoss(wallet.address!, r.index)])));
  }, [copyRecs, wallet.address]);
  const changeStopLoss = (index: number, value: number | null) => {
    if (!wallet.address) return;
    writeStopLoss(wallet.address, index, value);
    setStopLoss(prev => ({ ...prev, [index]: value }));
  };
```

5. 一鍵更新（放在 `doUnfollow` 後面）。取消跟單後，取回的錢回到交易所的可用保證金，不是錢包；跟單合約是從錢包扣款，所以要先把這筆提回錢包：

```tsx
  const doRefreshCopy = async (rec: CopyRec) => {
    if (!contracts || !wallet.address) return;
    const blocked = unfollowStaleNotice(rec.index);
    if (blocked) { notify(blocked, false); return; }
    const key = `refresh_${rec.index}`;
    setLoad(key, true);
    try {
      const before = (await contracts.exchange.freeMargin(wallet.address)) as bigint;
      await asTx(await contracts.copyTracker.unfollowAndCloseAll(BigInt(rec.index))).wait();
      const after = (await contracts.exchange.freeMargin(wallet.address)) as bigint;
      const returned = after > before ? after - before : 0n;
      if (returned > 0n) {
        const tx = asTx(await contracts.exchange.withdrawMargin(returned));
        await tx.wait();
        notify(interpolate(t.portfolio.page.copyRefreshStep, { amount: f18(returned) }), true, tx.hash);
      }
      navigate(`/copy/${rec.trader}?amount=${returned / 10n ** 18n}`);
    } catch (e) {
      notify(prettyError(e), false);
      await fetchAll();
    } finally { setLoad(key, false); }
  };
```

6. 跟單表格：
   - 欄位標題陣列，在 `actions` 之前加 `{ label: t.portfolio.page.copyColumn.stopLoss, right: false },`。
   - 交易者那一格，名稱下方加：

```tsx
                        {rec.strategyCount !== null && isOutdated(rec.versionId, rec.strategyCount) && (
                          <Tooltip title={t.portfolio.page.copyOutdatedHint}>
                            <Chip size="small" color="warning" variant="outlined" label={t.portfolio.page.copyOutdated} sx={{ mt: 0.5, height: 20, fontSize: '0.6875rem' }} />
                          </Tooltip>
                        )}
```

   - 報酬那一格，數字下方加：

```tsx
                        {stopLossReached(rec.initialAmount, rec.currentValue, stopLoss[rec.index] ?? null) && (
                          <Chip size="small" color="error" label={t.portfolio.page.stopLossReached} sx={{ mt: 0.5, height: 20, fontSize: '0.6875rem' }} />
                        )}
```

   - 在操作那一格的**前面**加一格：

```tsx
                      <TableCell>
                        <Tooltip title={t.portfolio.page.stopLossHint}>
                          <Select
                            size="small"
                            value={stopLoss[rec.index] ?? ''}
                            displayEmpty
                            onChange={e => changeStopLoss(rec.index, e.target.value === '' ? null : Number(e.target.value))}
                            sx={{ minWidth: 104, fontSize: '0.8125rem' }}
                          >
                            <MenuItem value="">{t.portfolio.page.stopLossNone}</MenuItem>
                            {STOP_LOSS_CHOICES.map(pct => (
                              <MenuItem key={pct} value={pct}>{interpolate(t.portfolio.page.stopLossOption, { pct })}</MenuItem>
                            ))}
                          </Select>
                        </Tooltip>
                      </TableCell>
```

   - 操作那一格，「取消跟單」按鈕前面加（只在策略已更新時出現）：

```tsx
                        {rec.strategyCount !== null && isOutdated(rec.versionId, rec.strategyCount) && (
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => void doRefreshCopy(rec)}
                            disabled={busy[`refresh_${rec.index}`] || !!unfStale}
                            sx={{ mr: 1, fontWeight: 'bold' }}
                          >
                            {busy[`refresh_${rec.index}`] ? t.portfolio.page.copyRefreshing : t.portfolio.page.copyRefresh}
                          </Button>
                        )}
```

   - 「取消跟單」按鈕：已達停損時改成 `variant="contained"`，其餘時候 `variant="outlined"`，讓它在需要時最醒目。

- [ ] **Step 3e: 型別、lint、測試**

Run（在 `frontend/` 內）: `yarn tsc --noEmit && yarn lint && yarn test`
Expected: 全部通過。

- [ ] **Step 4: 把展示步驟寫進說明文件**

`heroes/README.md`，在「## 測試」之前加一節（這個檔由資料線 Task A8 建立；若它還沒合併，先建立只含這一節的檔案，合併時保留兩邊）：

````markdown
## 本機展示

前置：跑過一次完整回放（上面的「一次跑完」），`heroes/out/chain.json` 存在。

```bash
scripts/heroes-demo.sh                 # 終端機一：本機鏈 + 即時價格
cd frontend && yarn dev --mode heroes  # 終端機二：前端（Windows 上在 Windows 這一側跑也可以）
```

錢包設定只要做一次：新增網路（RPC `http://127.0.0.1:8545`、chain ID 31337），匯入 Anvil 預設帳號 (9)。
這個帳號在回放時已經拿到 100,000 測試穩定幣並通過 KYC，可以跟單任何一位交易者。
模擬錢包（Mock Wallet）讀不到鏈上資料，不能用於這個展示。

每次重新啟動 `heroes-demo.sh`，鏈都回到回放剛結束的樣子，所以錢包裡這個帳號的 nonce 快取會對不上：
到錢包的進階設定清除該帳號的活動紀錄，再送第一筆交易。

展示路線：`/marketplace`（Expert Mode）→ 依累積報酬排序 → 點一位交易者 → 看淨值曲線、點一筆部位的
交易雜湊（鏈上讀回）→ 按「跟單」→ 批准、跟隨 → `/portfolio` 看到自己的跟單與部位 → 取消跟單。

要說明的兩件事：
- 這些是模擬交易者：由程式依公開規則操作，價格是真實歷史價格，交易是真的鏈上交易，但不是真人。
- 跟單複製的是交易者目前這一版策略，不是持續跟隨。
````

- [ ] **Step 5: 跟單整條流程走通（需要人操作）**

環境：`scripts/heroes-demo.sh` 與 `yarn dev --mode heroes` 都在跑，錢包用展示帳號連本機鏈，Expert Mode。

逐步操作，每一步對照預期結果：

| # | 操作 | 預期 |
|---|---|---|
| 1 | 開 `/marketplace` | 看到模擬交易者與揭露文字；每列最右邊有「跟單 →」 |
| 2 | 點一位只做多、無槓桿的交易者（例如 Whale Alpha）進個人頁 | 有「跟單」按鈕與績效區塊 |
| 3 | 按「跟單」 | 進 `/copy/<位址>`；看到策略內容、金額輸入、「複製的是目前這一版」說明 |
| 4 | 輸入 1000 | 預覽出現：每一檔分到的保證金、跟單費、交易手續費；三者加總不超過 1000 |
| 5 | 按「步驟 1 · 批准」，在錢包確認 | 按鈕變成「已批准」 |
| 6 | 按「步驟 2 · 跟隨交易者」，在錢包確認 | 出現成功通知 |
| 7 | 回該交易者個人頁並重新整理 | 跟隨者人數加 1；跟隨者清單有展示帳號 |
| 8 | 開 `/portfolio` | 有這筆跟單，底下列出對應的部位（數量 = 策略的檔數），每個部位有損益 |
| 9 | 在 `/portfolio` 取消這筆跟單，在錢包確認 | 跟單從清單消失或標示為已結束；可用保證金增加 |
| 10 | 對一位策略含股票的交易者（例如 Apple Holder）重複 3–6 | 展示帳號已通過 KYC，不會被擋 |
| 11 | 對一位使用槓桿的交易者（Low Carbon Lev）重複 3–6 | 成功；部位的槓桿與策略相同 |
| 13 | 對 Whale Alpha 跟單時金額輸入 50 | 出現「金額太小」並寫出最低金額；兩個按鈕都不能按 |
| 14 | 在 `/portfolio` 替一筆跟單選「虧 20%」，重新整理頁面 | 設定還在；若目前虧損已超過 20%，報酬欄出現「已達停損」，「取消跟單」變成實心按鈕 |
| 15 | 讓展示帳號正在跟的交易者發布新版策略（指令在表格下方），重新整理 `/portfolio` | 該筆跟單出現「策略已更新」與「更新到最新版」 |
| 16 | 按「更新到最新版」，在錢包確認兩筆（取消跟單、提領） | 自動進到跟單頁且金額已填好；照第 5、6 步跟單後，`/portfolio` 只剩一筆、沒有「策略已更新」 |
| 12 | 用另一個**沒有** KYC 的 Anvil 帳號（例如帳號 (8)，先用水龍頭或 `cast send` 給它測試穩定幣）對 Apple Holder 走到第 4 步 | 確認區顯示需要 KYC，批准與跟隨按鈕不能按 |

第 15 步讓交易者發布新版（以 Whale Alpha 為例；位址從 `frontend/public/data/heroes/index.json` 查，`StrategyRegistry` 從 `heroes/out/addresses.json` 查）：

```bash
cast rpc anvil_impersonateAccount <交易者位址> --rpc-url http://127.0.0.1:8545
cast send --unlocked --from <交易者位址> <StrategyRegistry> \
  "publishStrategy((bytes32,uint256,bool,uint256)[])" \
  "[($(cast keccak sETH),4000,true,1),($(cast keccak sBOND),3000,true,1),($(cast keccak sICLN),3000,true,1)]" \
  --rpc-url http://127.0.0.1:8545
```

任何一步與預期不符：先用 systematic-debugging 找出原因再修，不要繞過。每個修正單獨一個提交；失敗的邏輯若在純函式裡（`src/lib/pepefi/`），先補一個會失敗的測試。把每個問題與修法記在 PR 描述裡。

全部通過後，把這張表的結果（每一步「通過」或修了什麼）貼進 PR 描述。

- [ ] **Step 6: Commit**

```bash
git add frontend/.env.heroes scripts/heroes-demo.sh frontend/src/pages/pepefi/CopyPage.tsx frontend/src/pages/pepefi/PortfolioPage.tsx \
  frontend/src/lib/pepefi/copyGuards.ts frontend/src/lib/pepefi/copyGuards.test.ts \
  frontend/src/locales/zh-TW/copy.ts frontend/src/locales/en/copy.ts \
  frontend/src/locales/zh-TW/portfolio.ts frontend/src/locales/en/portfolio.ts heroes/README.md
git commit -m "feat(heroes): 本機展示啟動腳本、跟單頁的快照說明與展示步驟（#309）"
```
