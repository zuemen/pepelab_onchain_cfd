// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeStaking.sol";

/// @notice Deploy PepeStaking and print the address.
///
///   Required env vars:
///     PRIVATE_KEY   deployer private key
///     PEPE_TOKEN    deployed PepeToken address
///
///   Usage:
///     forge script script/DeployPepeStaking.s.sol \
///       --rpc-url $SEPOLIA_RPC_URL \
///       --private-key $PRIVATE_KEY \
///       --broadcast --slow -v
///
///   After deployment:
///     1. Update frontend/src/contracts/addresses.ts -> PepeStaking
///     2. Approve + call notifyRewardAmount to seed the first reward period:
///          cast send $PEPE_TOKEN "approve(address,uint256)" $STAKING 10000000000000000000000 \
///            --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
///          cast send $STAKING "notifyRewardAmount(uint256)" 10000000000000000000000 \
///            --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
contract DeployPepeStaking is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address pepeToken  = vm.envAddress("PEPE_TOKEN");

        vm.startBroadcast(deployerPk);

        PepeStaking staking = new PepeStaking(pepeToken);

        vm.stopBroadcast();

        console.log("PepeStaking deployed:", address(staking));
        console.log("Update addresses.ts -> PepeStaking:", address(staking));
        console.log("Next: approve + call notifyRewardAmount to seed rewards.");
    }
}
