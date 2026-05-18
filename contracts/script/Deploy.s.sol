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

contract Deploy is Script {
    // Asset IDs — same keccak256 used on-chain and in the frontend
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");

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
        console.log("=== Asset IDs (bytes32) ===");
        console.logBytes32(SBTC);
        console.logBytes32(SETH);
        console.logBytes32(SAAPL);
        console.logBytes32(STSLA);
    }
}
