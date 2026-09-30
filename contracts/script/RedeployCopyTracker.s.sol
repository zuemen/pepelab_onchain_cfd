// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/FeeRouter.sol";
import "../src/TraderStake.sol";

/// @dev COMPATIBILITY: this CopyTracker MUST be paired with a
///      PerpetualExchange built from the same source revision (P1 or later).
///      Its unfollow scoring calls `exchange.closeReasonOf(id)`, which an
///      older exchange does not have — every unfollow would revert.
///      (`adlHaircutOf` is read inside a try and degrades to 0 on an old
///      exchange, but `closeReasonOf` is not optional.) Point EXCHANGE_ADDR
///      at a redeployed exchange, not the legacy one.
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
