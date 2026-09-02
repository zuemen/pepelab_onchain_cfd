// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/v2/AssetVaultV2_3.sol";

interface IUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// @notice Upgrades the deployed AssetVaultV2 proxy to V2.3.
///
///         #99: reserve-ratio observability. V2.2 had reserve(), outstandingValue(),
///         reserveRatioBps() and ratioIsStale() — all public, all independently
///         verifiable — but no event to replay the ratio as history, no reaction
///         when a price move alone put the book under the floor, and nothing
///         consuming ratioIsStale(). V2.3 adds observeReserve() (permissionless,
///         emits ReserveObserved and latches mintingHalted on a breach) and
///         reserveStatus() (the ratio and its trustworthiness in one call). No
///         off-chain attestor: everything V2.3 reports was already public and
///         independently recomputable.
///
///         Storage layout is identical except one new field consumed from the
///         front of __gap (45 -> 44 slots): `mintingHalted` (bool), which starts
///         false on every existing proxy regardless of the pre-upgrade reserve
///         ratio — the first post-upgrade `observeReserve()` call establishes the
///         real state. Verified with `forge inspect storage-layout` on both,
///         field by field.
///
///           VAULT_PROXY=0x… forge script … --broadcast
///
///         Requires DEFAULT_ADMIN_ROLE on the proxy.
contract UpgradeVaultToV2_3 is Script {
    error StatePreservationFailed(string field);

    function run() external {
        address proxy = vm.envAddress("VAULT_PROXY");
        AssetVaultV2_3 v = AssetVaultV2_3(proxy);

        // Snapshot before, so the upgrade can be checked rather than trusted.
        string memory versionBefore = v.version();
        uint256 feesBefore      = v.accruedFees();
        address oracleBefore    = v.oracle();
        address usdcBefore      = v.usdc();
        uint256 mintFeeBefore   = v.mintFeeBps();
        uint256 redeemFeeBefore = v.redeemFeeBps();
        uint256 minRatioBefore  = v.minReserveRatioBps();
        uint256 maxAgeBefore    = v.maxPriceAge();
        uint256 assetsBefore    = v.registeredAssets().length;

        console.log("=== before ===");
        console.log("version      :", versionBefore);
        console.log("accruedFees  :", feesBefore);
        console.log("oracle       :", oracleBefore);
        console.log("assets       :", assetsBefore);

        vm.startBroadcast();

        AssetVaultV2_3 impl = new AssetVaultV2_3();
        console.log("new implementation:", address(impl));

        // No initializer call: V2.3 adds no state that needs seeding —
        // mintingHalted defaults to false, which is correct for every existing
        // proxy until the first observeReserve() establishes the real state.
        IUpgradeable(proxy).upgradeToAndCall(address(impl), "");

        vm.stopBroadcast();

        // Verify on chain. A silent state loss here is the failure mode that
        // matters, so assert rather than print and hope someone reads it.
        if (keccak256(bytes(v.version())) != keccak256(bytes("2.3.0"))) {
            revert StatePreservationFailed("version");
        }
        if (v.accruedFees()  != feesBefore)    revert StatePreservationFailed("accruedFees");
        if (v.oracle()       != oracleBefore)  revert StatePreservationFailed("oracle");
        if (v.usdc()         != usdcBefore)    revert StatePreservationFailed("usdc");
        if (v.mintFeeBps()   != mintFeeBefore) revert StatePreservationFailed("mintFeeBps");
        // Both were missing from V2.2's own upgrade-script assertions and
        // inherited that gap here until code review caught it: redeemFeeBps is
        // ordinary operator revenue config, but minReserveRatioBps is the exact
        // threshold V2.3's whole breach/halt mechanism gates on — a silent
        // storage-layout mistake shifting either one would otherwise print
        // "state preserved" while actually changing what redeemers pay or when
        // minting halts.
        if (v.redeemFeeBps()       != redeemFeeBefore) revert StatePreservationFailed("redeemFeeBps");
        if (v.minReserveRatioBps() != minRatioBefore)  revert StatePreservationFailed("minReserveRatioBps");
        if (v.maxPriceAge()  != maxAgeBefore)  revert StatePreservationFailed("maxPriceAge");
        if (v.registeredAssets().length != assetsBefore) {
            revert StatePreservationFailed("registeredAssets");
        }

        console.log("=== after ===");
        console.log("version        :", v.version());
        console.log("accruedFees    :", v.accruedFees());
        console.log("assets         :", v.registeredAssets().length);
        console.log("ratioIsStale   :", v.ratioIsStale());
        console.log("mintingHalted  :", v.mintingHalted());
        console.log("state preserved - all fields match");
        console.log("");
        console.log("Next: point the keeper at this proxy via KEEPER_VAULT_ADDRESS so");
        console.log("observeReserve() starts building a replayable history (see agent/.env.example).");
    }
}
