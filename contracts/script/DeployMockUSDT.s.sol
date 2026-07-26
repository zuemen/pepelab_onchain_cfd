// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/MockUSDT.sol";

/// @notice Deploys the second mock stablecoin. Existing contracts are NOT
///         touched — MockUSDT is additive (hold / faucet / swap). Trading
///         margin still settles in MockUSDC, which PerpetualExchange hardcodes.
contract DeployMockUSDT is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDT usdt = new MockUSDT();
        vm.stopBroadcast();
        console.log("MockUSDT deployed:", address(usdt));
    }
}
