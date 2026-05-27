// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeIncentives.sol";

/// @notice Deploy PepeIncentives and print the address.
///
///   Required env vars:
///     PRIVATE_KEY          deployer private key
///     PEPE_TOKEN           deployed PepeToken address
///     PERPETUAL_EXCHANGE   deployed PerpetualExchange address
///     COPY_TRACKER         deployed CopyTracker address
///
///   Usage:
///     forge script script/DeployPepeIncentives.s.sol \
///       --rpc-url $SEPOLIA_RPC_URL \
///       --private-key $PRIVATE_KEY \
///       --broadcast --slow -v
///
///   After deployment:
///     1. Update frontend/src/contracts/addresses.ts -> PepeIncentives
///     2. Transfer at least 100_000 PEPE into the contract as reward pool:
///          cast send $PEPE_TOKEN "transfer(address,uint256)" $PEPE_INCENTIVES 100000000000000000000000 \
///            --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
contract DeployPepeIncentives is Script {
    function run() external {
        uint256 deployerPk  = vm.envUint("PRIVATE_KEY");
        address pepeToken   = vm.envAddress("PEPE_TOKEN");
        address exchange    = vm.envAddress("PERPETUAL_EXCHANGE");
        address copyTracker = vm.envAddress("COPY_TRACKER");

        vm.startBroadcast(deployerPk);

        PepeIncentives incentives = new PepeIncentives(pepeToken, exchange, copyTracker);

        vm.stopBroadcast();

        console.log("PepeIncentives deployed:", address(incentives));
        console.log("Update addresses.ts -> PepeIncentives:", address(incentives));
        console.log("Next: transfer 100_000 PEPE into the reward pool.");
    }
}
