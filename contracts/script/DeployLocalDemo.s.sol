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
import "../src/MockCarbonCredit.sol";
import "../src/CarbonRetirement.sol";
import "../src/PlatformFeeSplitter.sol";
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
///
///      平台手續費的收款人是分流合約（#333、ADR-022），與公開鏈的部署順序相同：先部署模擬碳權、
///      退役合約與分流合約，再以分流合約為平台收款人部署 FeeRouter，最後綁定。退役比例 2,500 bps；
///      模擬賣方與 treasury 都是部署者。
contract DeployLocalDemo is Script {
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    uint256 public constant INSURANCE_SEED = 500_000e18;
    uint256 public constant LOCAL_MAX_PRICE_AGE = 7 days;
    /// 平台份額中導向碳權退役的比例：平台 20% 的四分之一（同 DeployCarbonRetirement 的預設）。
    uint256 public constant CARBON_SHARE_BPS = 2500;
    /// 模擬價格：每公噸 10 枚結算幣（MockUSDC 為 18 位）。
    uint256 public constant CARBON_PRICE_PER_TONNE = 10e18;
    /// 模擬賣方的初始庫存。兩年回放的退役量遠小於這個數字。
    uint256 public constant CARBON_INVENTORY = 100_000e18;

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
        address carbonCredit;
        address carbonRetirement;
        address feeSplitter;
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
        // 分流合約坐在 FeeRouter 的平台收款人位置；router 本身一行不改（ADR-022）。
        MockCarbonCredit credit = new MockCarbonCredit(deployer);
        CarbonRetirement retirement =
            new CarbonRetirement(address(usdc), address(credit), deployer, CARBON_PRICE_PER_TONNE);
        PlatformFeeSplitter splitter =
            new PlatformFeeSplitter(address(usdc), deployer, address(retirement), CARBON_SHARE_BPS);
        credit.issue(deployer, CARBON_INVENTORY);
        credit.approve(address(retirement), type(uint256).max);
        FeeRouter feeRouter = new FeeRouter(address(usdc), address(splitter), address(vault));
        splitter.bindFeeRouter(address(feeRouter));

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
            sessionManager: address(sessionManager),
            carbonCredit: address(credit),
            carbonRetirement: address(retirement),
            feeSplitter: address(splitter)
        });
        console.log("DeployLocalDemo: exchange", d.exchange);
        console.log("DeployLocalDemo: copyTracker", d.copyTracker);
        console.log("DeployLocalDemo: esgRegistry", d.esgRegistry);
        console.log("DeployLocalDemo: carbonRetirement", d.carbonRetirement);
    }
}
