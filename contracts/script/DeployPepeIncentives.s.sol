// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeIncentives.sol";

/// @notice Deploy PepeIncentives and print the address.
///
///   Required env vars:
///     PRIVATE_KEY          deployer private key, 0x-prefixed (vm.envUint reads a bare hex string as decimal
///                          and fails). Read in-script, so a keystore (--account) cannot be used yet: set it
///                          only in the current shell with `read -rs PRIVATE_KEY && export PRIVATE_KEY`,
///                          then `unset PRIVATE_KEY` (docs/OWNER_ACTIONS.md step 5).
///     PEPE_TOKEN           deployed PepeToken address
///     PERPETUAL_EXCHANGE   deployed PerpetualExchange address
///     COPY_TRACKER         deployed CopyTracker address
///     ESG_REGISTRY         deployed ESGRegistry address
///
///   Usage:
///     forge script script/DeployPepeIncentives.s.sol \
///       --rpc-url https://sepolia.base.org \
///       --broadcast --slow -v
///     (Base Sepolia. No --private-key on the command line: the script reads PRIVATE_KEY itself.)
///
///   After deployment:
///     1. Update frontend/src/contracts/addresses.ts -> PepeIncentives
///     2. Transfer at least 100_000 PEPE into the contract as reward pool
///        (trade mining, tier, copy and ESG-hold rewards; the daily check-in
///        credits non-transferable achievement points and needs no pool):
///          cast send $PEPE_TOKEN "transfer(address,uint256)" $PEPE_INCENTIVES 100000000000000000000000 \
///            --rpc-url https://sepolia.base.org --account <keystore name>
contract DeployPepeIncentives is Script {
    function run() external {
        uint256 deployerPk  = vm.envUint("PRIVATE_KEY");
        address pepeToken   = vm.envAddress("PEPE_TOKEN");
        address exchange    = vm.envAddress("PERPETUAL_EXCHANGE");
        address copyTracker = vm.envAddress("COPY_TRACKER");
        address esgRegistry = vm.envAddress("ESG_REGISTRY");

        vm.startBroadcast(deployerPk);

        PepeIncentives incentives = new PepeIncentives(pepeToken, exchange, copyTracker, esgRegistry);

        vm.stopBroadcast();

        console.log("PepeIncentives deployed:", address(incentives));
        console.log("Update addresses.ts -> PepeIncentives:", address(incentives));
        console.log("Next: transfer 100_000 PEPE into the reward pool (not needed for the daily check-in,");
        console.log("which credits non-transferable achievement points and moves no PEPE).");
    }
}
