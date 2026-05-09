// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/StrategyRegistry.sol";

contract Seed is Script {
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");

    function run() external {
        address usdcAddr     = vm.envAddress("USDC_ADDR");
        address registryAddr = vm.envAddress("REGISTRY_ADDR");
        // TRADER2_PK: Anvil defaults to account #1 well-known key; Sepolia: set in .env or leave 0 to skip
        uint256 trader2Pk = vm.envOr("TRADER2_PK", uint256(0));
        bool isAnvil = block.chainid == 31337;

        MockUSDC usdc = MockUSDC(usdcAddr);
        StrategyRegistry registry = StrategyRegistry(registryAddr);

        // ── Trader 1: deployer ─────────────────────────────────────────────────
        vm.startBroadcast();
        address deployer = msg.sender;

        usdc.mint(deployer, 5_000e18);

        try registry.registerTrader("Demo Alpha") {} catch {}

        StrategyRegistry.Allocation[] memory allocs1 = new StrategyRegistry.Allocation[](3);
        allocs1[0] = StrategyRegistry.Allocation({asset: SBTC,  weight: 5000, isLong: true,  leverage: 2});
        allocs1[1] = StrategyRegistry.Allocation({asset: SETH,  weight: 3000, isLong: false, leverage: 1});
        allocs1[2] = StrategyRegistry.Allocation({asset: SAAPL, weight: 2000, isLong: true,  leverage: 1});
        registry.publishStrategy(allocs1);

        vm.stopBroadcast();
        console.log("Seeded Trader 1 (Demo Alpha):", deployer);

        // ── Trader 2: second wallet (auto on Anvil, needs TRADER2_PK on Sepolia) ─
        uint256 pk2 = trader2Pk;
        if (pk2 == 0 && isAnvil) {
            // Anvil account #1 — publicly known, local only
            pk2 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        }

        if (pk2 != 0) {
            address t2 = vm.addr(pk2);

            vm.startBroadcast();
            usdc.mint(t2, 5_000e18);
            vm.stopBroadcast();

            vm.startBroadcast(pk2);
            try registry.registerTrader("Demo Beta") {} catch {}

            StrategyRegistry.Allocation[] memory allocs2 = new StrategyRegistry.Allocation[](2);
            allocs2[0] = StrategyRegistry.Allocation({asset: SETH,  weight: 6000, isLong: true, leverage: 5});
            allocs2[1] = StrategyRegistry.Allocation({asset: STSLA, weight: 4000, isLong: true, leverage: 2});
            registry.publishStrategy(allocs2);

            vm.stopBroadcast();
            console.log("Seeded Trader 2 (Demo Beta):", t2);
        } else {
            console.log("Skipping Trader 2 (set TRADER2_PK env var to enable on Sepolia)");
        }

        console.log("Seed complete.");
    }
}
