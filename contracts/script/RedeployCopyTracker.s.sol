// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/FeeRouter.sol";
import "../src/TraderStake.sol";

contract RedeployCopyTracker is Script {
    function run() external {
        address usdc      = vm.envAddress("USDC_ADDR");
        address exchange  = vm.envAddress("EXCHANGE_ADDR");
        address registry  = vm.envAddress("REGISTRY_ADDR");
        address feeRouter = vm.envAddress("FEE_ROUTER_ADDR");
        address stake     = vm.envAddress("STAKE_ADDR");

        vm.startBroadcast();

        // 1. Deploy new CopyTracker
        CopyTracker newCt = new CopyTracker(usdc, exchange, registry, feeRouter, stake);

        // 2. Re-wire all dependent contracts to point to new CopyTracker
        PerpetualExchange(exchange).setCopyTracker(address(newCt));
        FeeRouter(feeRouter).setCopyTracker(address(newCt));
        TraderStake(stake).setCopyTracker(address(newCt));

        vm.stopBroadcast();

        console.log("=== New CopyTracker Deployed & Wired ===");
        console.log("New CopyTracker:", address(newCt));
        console.log("Update frontend/src/contracts/addresses.ts manually!");
    }
}
