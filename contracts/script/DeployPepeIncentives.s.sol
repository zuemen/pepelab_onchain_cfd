// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeIncentives.sol";

/// @notice Deploy PepeIncentives and print the address.
///
///   The deployer is the broadcasting account (`msg.sender`): use a Foundry keystore with
///   `--account <name> --sender <address>`; no private key is read by the script.
///
///   Required env vars:
///     PEPE_TOKEN           deployed PepeToken address
///     PERPETUAL_EXCHANGE   deployed PerpetualExchange address
///     COPY_TRACKER         deployed CopyTracker address
///     ESG_REGISTRY         deployed ESGRegistry address
///
///   Usage:
///     forge script script/DeployPepeIncentives.s.sol \
///       --rpc-url https://sepolia.base.org --account <keystore name> --sender <deployer> \
///       --broadcast --slow -v
///     (Base Sepolia. Simulate first: same line with --fork-url instead of --rpc-url, no --account/--broadcast.)
///
///   After deployment:
///     1. Update frontend/src/contracts/addresses.ts -> PepeIncentives
///     2. Transfer at least 100_000 PEPE into the contract as reward pool
///        (trade mining, tier, copy and ESG-hold rewards; the daily check-in
///        credits non-transferable achievement points and needs no pool):
///          cast send $PEPE_TOKEN "transfer(address,uint256)" $PEPE_INCENTIVES 100000000000000000000000 \
///            --rpc-url https://sepolia.base.org --account <keystore name>
contract DeployPepeIncentives is Script {
    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    function run() external returns (PepeIncentives incentives) {
        address deployer    = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        address pepeToken   = vm.envAddress("PEPE_TOKEN");
        address exchange    = vm.envAddress("PERPETUAL_EXCHANGE");
        address copyTracker = vm.envAddress("COPY_TRACKER");
        address esgRegistry = vm.envAddress("ESG_REGISTRY");

        require(pepeToken.code.length > 0, "PEPE_TOKEN has no code");
        require(exchange.code.length > 0, "PERPETUAL_EXCHANGE has no code");
        require(copyTracker.code.length > 0, "COPY_TRACKER has no code");

        vm.startBroadcast(deployer);

        incentives = new PepeIncentives(pepeToken, exchange, copyTracker, esgRegistry);

        vm.stopBroadcast();

        console.log("PepeIncentives deployed:", address(incentives));
        console.log("Update addresses.ts -> PepeIncentives:", address(incentives));
        console.log("Next: transfer 100_000 PEPE into the reward pool (not needed for the daily check-in,");
        console.log("which credits non-transferable achievement points and moves no PEPE).");
    }
}
