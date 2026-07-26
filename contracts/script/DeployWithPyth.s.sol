// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
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

/// @notice Track 2A — "RWA real pricing" deployment. Identical wiring to
///         Deploy.s.sol, except `PerpetualExchange` points at a REAL aggregator
///         oracle (Pyth + Chainlink, median/degrade-to-live) instead of
///         MockOracle. Because `PerpetualExchange.oracle` is immutable, switching
///         to real feeds means deploying a fresh exchange — this script does that
///         while leaving the existing MockOracle deployment untouched for tests.
///
///         NOT auto-broadcast in CI — review, then run manually:
///           forge script script/DeployWithPyth.s.sol:DeployWithPyth \
///             --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --account <deployer>
///
///         Pyth is a PULL oracle: a keeper must push fresh prices
///         (updatePriceFeeds) or reads go stale and trades revert by design.
///         Set RWA Pyth price ids via env (PYTH_ID_*) — unset assets simply
///         aren't served (aggregator degrades to the live source).
contract DeployWithPyth is Script {
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");  // RWA: equity
    bytes32 constant STSLA = keccak256("sTSLA");  // RWA: equity
    bytes32 constant SGOLD = keccak256("sGOLD");  // RWA: commodity

    // Well-known, chain-independent Pyth price ids.
    bytes32 constant PYTH_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PYTH_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    function run() external {
        address deployer = msg.sender;

        // Pyth contract on Base Sepolia (override with env PYTH_CONTRACT).
        address pythContract = vm.envOr("PYTH_CONTRACT", address(0xA2aa501b19aff244D90cc15a4Cf739D2725B5729));
        // RWA Pyth price ids — fill from Pyth's feed-id list (hermes). Default 0
        // → asset unserved until set (safe; aggregator degrades).
        bytes32 pythAapl = vm.envOr("PYTH_ID_AAPL", bytes32(0));
        bytes32 pythTsla = vm.envOr("PYTH_ID_TSLA", bytes32(0));
        bytes32 pythGold = vm.envOr("PYTH_ID_GOLD", bytes32(0));

        vm.startBroadcast();

        // 1. Real aggregator oracle (Pyth + Chainlink). Chainlink testnet often
        //    lacks equity feeds → aggregator degrades to the live (Pyth) source.
        ChainlinkOracleAdapter  clOracle   = new ChainlinkOracleAdapter();
        PythOracleAdapter       pythOracle = new PythOracleAdapter(pythContract);
        pythOracle.setPriceId(SBTC, PYTH_BTC);
        pythOracle.setPriceId(SETH, PYTH_ETH);
        if (pythAapl != bytes32(0)) pythOracle.setPriceId(SAAPL, pythAapl);
        if (pythTsla != bytes32(0)) pythOracle.setPriceId(STSLA, pythTsla);
        if (pythGold != bytes32(0)) pythOracle.setPriceId(SGOLD, pythGold);
        AggregatorOracleAdapter aggOracle = new AggregatorOracleAdapter(address(clOracle), address(pythOracle));

        // 2. Margin/collateral currency + swap router (unchanged).
        MockUSDC usdc = new MockUSDC();
        MockSwapRouter swapRouter = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(swapRouter));

        // 3. Core stack — exchange points at the REAL aggregator oracle.
        TraderStake traderStake = new TraderStake(address(usdc));
        InsuranceVault vault = new InsuranceVault(address(usdc));
        FeeRouter feeRouter = new FeeRouter(address(usdc), deployer, address(vault));
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(aggOracle));
        StrategyRegistry registry = new StrategyRegistry(address(traderStake));
        CopyTracker ct = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(feeRouter), address(traderStake)
        );

        // 4. Wire (same as Deploy.s.sol).
        vault.setFeeRouter(address(feeRouter));
        vault.setExchange(address(exchange));
        traderStake.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setFeeRouter(address(feeRouter));
        exchange.setInsuranceVault(address(vault));
        feeRouter.setCopyTracker(address(ct));
        feeRouter.setExchange(address(exchange));

        // 5. Agent session layer.
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);

        // 6. KYC + RWA compliance gating — RWA (equity/commodity) require KYC.
        KYCRegistry kyc = new KYCRegistry();
        exchange.setKycRegistry(address(kyc));
        exchange.setRwaAsset(SAAPL, true);
        exchange.setRwaAsset(STSLA, true);
        exchange.setRwaAsset(SGOLD, true);

        vm.stopBroadcast();

        console.log("=== DeployWithPyth (REAL oracle) ===");
        console.log("AggregatorOracle :", address(aggOracle));
        console.log("PythAdapter      :", address(pythOracle));
        console.log("ChainlinkAdapter :", address(clOracle));
        console.log("MockUSDC         :", address(usdc));
        console.log("MockSwapRouter   :", address(swapRouter));
        console.log("TraderStake      :", address(traderStake));
        console.log("InsuranceVault   :", address(vault));
        console.log("FeeRouter        :", address(feeRouter));
        console.log("PerpetualExchange:", address(exchange));
        console.log("StrategyRegistry :", address(registry));
        console.log("CopyTracker      :", address(ct));
        console.log("AgentSessionMgr  :", address(sessionManager));
        console.log("KYCRegistry      :", address(kyc));
        console.log("-- Pyth ids set: BTC/ETH always; RWA only if PYTH_ID_* env provided --");
    }
}
