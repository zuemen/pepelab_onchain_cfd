// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/FeeRouter.sol";
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

        // 2. MockOracle
        MockOracle oracle = new MockOracle();

        // 3. Register synthetic assets
        //    Prices use 8-decimal format (1e8 = $1.00) — PerpetualExchange scales ×1e10 internally
        oracle.addAsset(SBTC,   50_000e8);   // $50,000
        oracle.addAsset(SETH,    3_000e8);   // $ 3,000
        oracle.addAsset(SAAPL,     200e8);   // $   200
        oracle.addAsset(STSLA,     250e8);   // $   250

        // 4. TraderStake (skin-in-the-game; must deploy before StrategyRegistry)
        TraderStake traderStake = new TraderStake(address(usdc));

        // 5. FeeRouter (platformTreasury = deployer; slashPool = deployer for now)
        FeeRouter feeRouter = new FeeRouter(address(usdc), deployer, deployer);

        // 6. PerpetualExchange
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(oracle));

        // 7. StrategyRegistry (with stake gate)
        StrategyRegistry registry = new StrategyRegistry(address(traderStake));

        // 8. CopyTracker (with stake reference for slashing)
        CopyTracker ct = new CopyTracker(
            address(usdc),
            address(exchange),
            address(registry),
            address(feeRouter),
            address(traderStake)
        );

        // 9. Wire contracts
        traderStake.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setFeeRouter(address(feeRouter));
        feeRouter.setCopyTracker(address(ct));
        feeRouter.setExchange(address(exchange));

        vm.stopBroadcast();

        // Print addresses (visible with forge script -v)
        console.log("=== Deployed Contract Addresses ===");
        console.log("MockUSDC         :", address(usdc));
        console.log("MockOracle       :", address(oracle));
        console.log("TraderStake      :", address(traderStake));
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
