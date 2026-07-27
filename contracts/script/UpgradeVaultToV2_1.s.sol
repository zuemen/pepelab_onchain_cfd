// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/v2/AssetVaultV2_1.sol";

interface IUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// @notice Upgrades the deployed AssetVaultV2 proxy to V2.1.
///
///         V2.0's outstandingValue() calls the oracle directly and skips stale
///         assets with a `continue`, which assumed an oracle that RETURNS stale
///         data. GuardedOracle fails closed and REVERTS, so the loop died and
///         took reserveRatioBps() and mint() with it — one stale asset blocked
///         minting every other asset. V2.1 wraps the call in try/catch and
///         reports how many assets it could not price.
///
///         Storage layout is identical (verified with `forge inspect
///         storage-layout` on both, field by field), so no state migration is
///         needed and nothing is at risk of being shifted.
///
///           VAULT_PROXY=0x… forge script … --broadcast
///
///         Requires DEFAULT_ADMIN_ROLE on the proxy.
contract UpgradeVaultToV2_1 is Script {
    error StatePreservationFailed(string field);

    function run() external {
        address proxy = vm.envAddress("VAULT_PROXY");
        AssetVaultV2_1 v = AssetVaultV2_1(proxy);

        // Snapshot before, so the upgrade can be checked rather than trusted.
        string memory versionBefore = v.version();
        uint256 feesBefore    = v.accruedFees();
        address oracleBefore  = v.oracle();
        address usdcBefore    = v.usdc();
        uint256 mintFeeBefore = v.mintFeeBps();
        uint256 maxAgeBefore  = v.maxPriceAge();
        uint256 assetsBefore  = v.registeredAssets().length;

        console.log("=== before ===");
        console.log("version      :", versionBefore);
        console.log("accruedFees  :", feesBefore);
        console.log("oracle       :", oracleBefore);
        console.log("assets       :", assetsBefore);

        vm.startBroadcast();

        AssetVaultV2_1 impl = new AssetVaultV2_1();
        console.log("new implementation:", address(impl));

        // No initializer call: V2.1 adds no state, so re-initializing would be
        // both unnecessary and dangerous.
        IUpgradeable(proxy).upgradeToAndCall(address(impl), "");

        vm.stopBroadcast();

        // Verify on chain. A silent state loss here is the failure mode that
        // matters, so assert rather than print and hope someone reads it.
        if (keccak256(bytes(v.version())) != keccak256(bytes("2.1.0"))) {
            revert StatePreservationFailed("version");
        }
        if (v.accruedFees()  != feesBefore)    revert StatePreservationFailed("accruedFees");
        if (v.oracle()       != oracleBefore)  revert StatePreservationFailed("oracle");
        if (v.usdc()         != usdcBefore)    revert StatePreservationFailed("usdc");
        if (v.mintFeeBps()   != mintFeeBefore) revert StatePreservationFailed("mintFeeBps");
        if (v.maxPriceAge()  != maxAgeBefore)  revert StatePreservationFailed("maxPriceAge");
        if (v.registeredAssets().length != assetsBefore) {
            revert StatePreservationFailed("registeredAssets");
        }

        console.log("=== after ===");
        console.log("version      :", v.version());
        console.log("accruedFees  :", v.accruedFees());
        console.log("assets       :", v.registeredAssets().length);
        console.log("ratioIsStale :", v.ratioIsStale());
        console.log("state preserved - all fields match");
    }
}
