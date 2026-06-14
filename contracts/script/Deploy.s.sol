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
import "../src/ChainlinkOracleAdapter.sol";
import "../src/PythOracleAdapter.sol";
import "../src/AggregatorOracleAdapter.sol";

contract Deploy is Script {
    // Asset IDs — same keccak256 used on-chain and in the frontend
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");  // RWA: equity
    bytes32 constant STSLA = keccak256("sTSLA");  // RWA: equity

    function run() external {
        address deployer = msg.sender;
        vm.startBroadcast();

        // 1. MockUSDC
        MockUSDC usdc = new MockUSDC();

        // 2. MockSwapRouter (needs usdc; wire setSwapRouter immediately)
        MockSwapRouter swapRouter = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(swapRouter));

        // 3. MockOracle
        MockOracle oracle = new MockOracle();

        // 4. Register synthetic assets
        //    Prices use 8-decimal format (1e8 = $1.00) — PerpetualExchange scales ×1e10 internally
        oracle.addAsset(SBTC,   50_000e8);   // $50,000
        oracle.addAsset(SETH,    3_000e8);   // $ 3,000
        oracle.addAsset(SAAPL,     200e8);   // $   200
        oracle.addAsset(STSLA,     250e8);   // $   250

        // 5. TraderStake (skin-in-the-game; must deploy before StrategyRegistry)
        TraderStake traderStake = new TraderStake(address(usdc));

        // 6. InsuranceVault (must deploy before FeeRouter since FeeRouter holds it immutably)
        InsuranceVault vault = new InsuranceVault(address(usdc));

        // 7. FeeRouter (platformTreasury = deployer; 10% slash share → vault)
        FeeRouter feeRouter = new FeeRouter(address(usdc), deployer, address(vault));

        // 8. PerpetualExchange
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(oracle));

        // 9. StrategyRegistry (with stake gate)
        StrategyRegistry registry = new StrategyRegistry(address(traderStake));

        // 10. CopyTracker (with stake reference for slashing)
        CopyTracker ct = new CopyTracker(
            address(usdc),
            address(exchange),
            address(registry),
            address(feeRouter),
            address(traderStake)
        );

        // 11. Wire contracts
        vault.setFeeRouter(address(feeRouter));
        vault.setExchange(address(exchange));
        traderStake.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setFeeRouter(address(feeRouter));
        exchange.setInsuranceVault(address(vault));
        feeRouter.setCopyTracker(address(ct));
        feeRouter.setExchange(address(exchange));

        // 12. AgentSessionManager (Phase 2 session-key delegation layer) +
        //     authorize it as an additional agent on the exchange.
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);

        // 13. KYCRegistry + RWA compliance gating (G2). Equity synthetics are
        //     real-world assets: opening them requires KYC. Crypto (sBTC/sETH)
        //     stays permissionless.
        KYCRegistry kyc = new KYCRegistry();
        exchange.setKycRegistry(address(kyc));
        exchange.setRwaAsset(SAAPL, true);
        exchange.setRwaAsset(STSLA, true);

        // 14. Production oracle SHOWCASE (P4-3). Deployed and Pyth-wired, but
        //     intentionally NOT connected to the live exchange (oracle is
        //     immutable; the exchange runs on MockOracle so the synthetic-asset
        //     demo keeps working). To go live on real feeds, set Chainlink feeds
        //     via setFeed with verified Base Sepolia aggregators and redeploy the
        //     exchange pointing at `aggOracle`. The aggregator degrades to a
        //     single live source, so Pyth alone already serves BTC/ETH.
        //     Pyth contract defaults to Base Sepolia; override with env PYTH_CONTRACT.
        address pythContract = vm.envOr("PYTH_CONTRACT", address(0xA2aa501b19aff244D90cc15a4Cf739D2725B5729));
        ChainlinkOracleAdapter clOracle  = new ChainlinkOracleAdapter();
        PythOracleAdapter       pythOracle = new PythOracleAdapter(pythContract);
        // Universal Pyth price ids (chain-independent).
        pythOracle.setPriceId(SBTC, 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43);
        pythOracle.setPriceId(SETH, 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace);
        AggregatorOracleAdapter aggOracle = new AggregatorOracleAdapter(address(clOracle), address(pythOracle));

        vm.stopBroadcast();

        // Print addresses (visible with forge script -v)
        console.log("=== Deployed Contract Addresses ===");
        console.log("MockUSDC         :", address(usdc));
        console.log("MockSwapRouter   :", address(swapRouter));
        console.log("MockOracle       :", address(oracle));
        console.log("TraderStake      :", address(traderStake));
        console.log("InsuranceVault   :", address(vault));
        console.log("FeeRouter        :", address(feeRouter));
        console.log("PerpetualExchange:", address(exchange));
        console.log("StrategyRegistry :", address(registry));
        console.log("CopyTracker      :", address(ct));
        console.log("AgentSessionMgr  :", address(sessionManager));
        console.log("KYCRegistry      :", address(kyc));
        console.log("-- oracle showcase (NOT wired to exchange) --");
        console.log("ChainlinkAdapter :", address(clOracle));
        console.log("PythAdapter      :", address(pythOracle));
        console.log("AggregatorOracle :", address(aggOracle));
        console.log("=== Asset IDs (bytes32) ===");
        console.logBytes32(SBTC);
        console.logBytes32(SETH);
        console.logBytes32(SAAPL);
        console.logBytes32(STSLA);
    }
}
