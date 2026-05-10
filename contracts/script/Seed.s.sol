// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/StrategyRegistry.sol";
import "../src/CopyTracker.sol";
import "../src/TraderStake.sol";

contract Seed is Script {
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");

    function run() external {
        address usdcAddr     = vm.envAddress("USDC_ADDR");
        address registryAddr = vm.envAddress("REGISTRY_ADDR");
        address trackerAddr  = vm.envAddress("TRACKER_ADDR");
        address stakeAddr    = vm.envAddress("STAKE_ADDR");

        // TRADER2_PK / TRADER3_PK: separate funded wallets on Sepolia; on Anvil, well-known account keys
        uint256 trader2Pk = vm.envOr("TRADER2_PK", uint256(0));
        uint256 trader3Pk = vm.envOr("TRADER3_PK", uint256(0));
        bool isAnvil = block.chainid == 31337;

        MockUSDC         usdc     = MockUSDC(usdcAddr);
        StrategyRegistry registry = StrategyRegistry(registryAddr);
        CopyTracker      ct       = CopyTracker(trackerAddr);
        TraderStake      ts       = TraderStake(stakeAddr);

        // ── Trader 1: deployer (Demo Alpha) ───────────────────────────────────
        vm.startBroadcast();
        address deployer = msg.sender;

        usdc.mint(deployer, 5_000e18);
        usdc.approve(address(ts), 500e18);
        try ts.stake(500e18) {} catch {}
        try registry.registerTrader("Demo Alpha") {} catch {}

        StrategyRegistry.Allocation[] memory allocs1 = new StrategyRegistry.Allocation[](3);
        allocs1[0] = StrategyRegistry.Allocation({asset: SBTC,  weight: 5000, isLong: true,  leverage: 2});
        allocs1[1] = StrategyRegistry.Allocation({asset: SETH,  weight: 3000, isLong: false, leverage: 1});
        allocs1[2] = StrategyRegistry.Allocation({asset: SAAPL, weight: 2000, isLong: true,  leverage: 1});
        try registry.publishStrategy(allocs1) {} catch {}

        vm.stopBroadcast();
        console.log("Seeded Trader 1 (Demo Alpha):", deployer);

        // ── Trader 2: second wallet ────────────────────────────────────────────
        uint256 pk2 = trader2Pk;
        if (pk2 == 0 && isAnvil) {
            pk2 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        }

        if (pk2 != 0) {
            address t2 = vm.addr(pk2);

            vm.startBroadcast();
            usdc.mint(t2, 5_000e18);
            vm.stopBroadcast();

            vm.startBroadcast(pk2);
            usdc.approve(address(ts), 500e18);
            try ts.stake(500e18) {} catch {}
            try registry.registerTrader("Demo Beta") {} catch {}

            StrategyRegistry.Allocation[] memory allocs2 = new StrategyRegistry.Allocation[](2);
            allocs2[0] = StrategyRegistry.Allocation({asset: SETH,  weight: 6000, isLong: true, leverage: 5});
            allocs2[1] = StrategyRegistry.Allocation({asset: STSLA, weight: 4000, isLong: true, leverage: 2});
            try registry.publishStrategy(allocs2) {} catch {}

            vm.stopBroadcast();
            console.log("Seeded Trader 2 (Demo Beta):", t2);
        } else {
            console.log("Skipping Trader 2 (set TRADER2_PK to enable on Sepolia)");
        }

        // ── Trader 3: third wallet (optional) ─────────────────────────────────
        uint256 pk3 = trader3Pk;
        if (pk3 == 0 && isAnvil) {
            pk3 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
        }

        if (pk3 != 0) {
            address t3 = vm.addr(pk3);

            vm.startBroadcast();
            usdc.mint(t3, 5_000e18);
            vm.stopBroadcast();

            vm.startBroadcast(pk3);
            usdc.approve(address(ts), 500e18);
            try ts.stake(500e18) {} catch {}
            try registry.registerTrader("Demo Gamma") {} catch {}

            StrategyRegistry.Allocation[] memory allocs3 = new StrategyRegistry.Allocation[](2);
            allocs3[0] = StrategyRegistry.Allocation({asset: SAAPL, weight: 7000, isLong: true,  leverage: 1});
            allocs3[1] = StrategyRegistry.Allocation({asset: SBTC,  weight: 3000, isLong: false, leverage: 2});
            try registry.publishStrategy(allocs3) {} catch {}

            vm.stopBroadcast();
            console.log("Seeded Trader 3 (Demo Gamma):", t3);
        } else {
            console.log("Skipping Trader 3 (set TRADER3_PK to enable on Sepolia)");
        }

        // ── Self-follow: deployer follows Demo Alpha to show follower count ────
        // Wrapped in try/catch — may fail if oracle has no prices or already followed
        vm.startBroadcast();
        usdc.approve(address(ct), 500e18);
        try ct.followTrader(deployer, 500e18) {
            console.log("Demo Alpha self-follow seeded (follower count = 1)");
        } catch {
            console.log("Skipped self-follow (oracle prices not set or already followed)");
        }
        vm.stopBroadcast();

        console.log("Seed complete.");
    }
}
