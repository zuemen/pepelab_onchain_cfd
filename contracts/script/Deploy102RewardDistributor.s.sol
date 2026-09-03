// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/EsgRewardDistributor.sol";
import "../src/SustainabilityBadge.sol";

/// @notice #102 step 3 — the carbon-tier EsgRewardDistributor (#98), which
///         mints a non-transferable SustainabilityBadge instead of paying PEPE.
///         Its `exchange` is immutable, so it can only be deployed AFTER the
///         new exchange (step 2).
///
///         Env:
///           EXCHANGE_NEW          new PerpetualExchange (step 2 output)
///           ESG_REGISTRY_V2       ESGRegistryV2 (step 1 output)
///           SUSTAINABILITY_BADGE  SustainabilityBadge (step 1 output)
///
///         Run:
///           forge script script/Deploy102RewardDistributor.s.sol:Deploy102RewardDistributor \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast -vvv
contract Deploy102RewardDistributor is Script {
    function run() external {
        address exchange = vm.envAddress("EXCHANGE_NEW");
        address registry = vm.envAddress("ESG_REGISTRY_V2");
        address badgeAddr = vm.envAddress("SUSTAINABILITY_BADGE");

        vm.startBroadcast();

        EsgRewardDistributor distributor = new EsgRewardDistributor(exchange, registry, badgeAddr);

        // The distributor mints badges — it needs MINTER_ROLE. The deployer
        // holds DEFAULT_ADMIN_ROLE on the badge from step 1, so it can grant.
        SustainabilityBadge badge = SustainabilityBadge(badgeAddr);
        badge.grantRole(badge.MINTER_ROLE(), address(distributor));

        vm.stopBroadcast();

        require(
            badge.hasRole(badge.MINTER_ROLE(), address(distributor)),
            "distributor did not get MINTER_ROLE"
        );

        console.log("=== #102 reward distributor ===");
        console.log("EsgRewardDistributor :", address(distributor));
        console.log("  -> exchange :", exchange);
        console.log("  -> registry :", registry);
        console.log("  -> badge    :", badgeAddr, "(MINTER_ROLE granted)");
        console.log("");
        console.log("Add EsgRewardDistributor to frontend/src/contracts/addresses.ts.");
    }
}
