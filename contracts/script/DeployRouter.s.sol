// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockSwapRouter.sol";

contract DeployRouter is Script {
    function run() external {
        vm.startBroadcast();
        // The current Sepolia MockUSDC deployed address
        address usdc = 0x655D51EDE4439d66894663AD4725770381db3EBa;
        MockSwapRouter router = new MockSwapRouter(usdc);
        vm.stopBroadcast();
        console.log("MockSwapRouter deployed to:", address(router));
    }
}
