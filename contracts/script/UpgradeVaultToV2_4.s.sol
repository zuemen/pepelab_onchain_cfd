// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/v2/AssetVaultV2_4.sol";

interface IUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// @notice Upgrades the deployed AssetVault proxy from V2.3 to V2.4.
///
///         #128 / ADR-005 / ADR-006: the spot-buy (mint) fee stops being a
///         settable scalar and is derived per-asset from the asset's
///         witnessed carbon tier (`ESGRegistryV2.medianCarbonTier` →
///         `CarbonTiers.paramsFor`). The `setRiskParams` mint-fee argument and
///         the `mintFeeBps` public getter are gone; the redeem fee stays a
///         flat, settable scalar.
///
///         Storage layout is identical to V2.3 except one new field consumed
///         from the front of __gap (44 -> 43 slots): `_esgRegistry` (address),
///         which starts `address(0)` on every existing proxy — until it is
///         wired, `mintFeeBpsForAsset` fails closed to the MOST CONSERVATIVE
///         tier's fee, never the old cheap 0.30% default. The retired
///         `mintFeeBps` slot is kept (private `__deprecated_mintFeeBps`) so
///         nothing below it shifts. Verify with `forge inspect storage-layout`
///         on V2.3 and V2.4, field by field.
///
///         TWO STEPS, and this script is only the first:
///           1. this script — swap the implementation (state preserved).
///           2. SEPARATELY: `setEsgRegistry(<the #128 ESGRegistryV2>)` once
///              that registry is deployed and seeded with tier+basis
///              attestations. Until then every asset prices at the ceiling.
///           The full carbon redeployment chain (new ESGRegistryV2, new
///           PerpetualExchange, new CopyTracker / EsgRewardDistributor, and
///           the re-attestation) is the deployment spec's, not this script's.
///
///           VAULT_PROXY=0x… forge script script/UpgradeVaultToV2_4.s.sol:UpgradeVaultToV2_4 \
///             --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast -vvv
///
///         Requires DEFAULT_ADMIN_ROLE on the proxy.
contract UpgradeVaultToV2_4 is Script {
    error StatePreservationFailed(string field);

    function run() external {
        address proxy = vm.envAddress("VAULT_PROXY");
        AssetVaultV2_4 v = AssetVaultV2_4(proxy);

        // Snapshot before, so the upgrade can be checked rather than trusted.
        uint256 feesBefore      = v.accruedFees();
        address oracleBefore    = v.oracle();
        address usdcBefore      = v.usdc();
        uint256 redeemFeeBefore = v.redeemFeeBps();
        uint256 minRatioBefore  = v.minReserveRatioBps();
        uint256 maxAgeBefore    = v.maxPriceAge();
        uint256 assetsBefore    = v.registeredAssets().length;
        bool    haltedBefore    = v.mintingHalted();

        console.log("=== before ===");
        console.log("accruedFees   :", feesBefore);
        console.log("redeemFeeBps  :", redeemFeeBefore);
        console.log("minRatioBps   :", minRatioBefore);
        console.log("assets        :", assetsBefore);
        console.log("mintingHalted :", haltedBefore);

        vm.startBroadcast();

        AssetVaultV2_4 impl = new AssetVaultV2_4();
        console.log("new implementation:", address(impl));

        // No initializer call: V2.4 adds only `_esgRegistry`, which must start
        // address(0) (fail closed) until `setEsgRegistry` is called with the
        // real registry — see this contract's NatSpec, step 2.
        IUpgradeable(proxy).upgradeToAndCall(address(impl), "");

        vm.stopBroadcast();

        // Verify on chain. A silent state loss here is the failure mode that
        // matters, so assert rather than print and hope someone reads it.
        if (keccak256(bytes(v.version())) != keccak256(bytes("2.4.0"))) {
            revert StatePreservationFailed("version");
        }
        if (v.accruedFees()        != feesBefore)      revert StatePreservationFailed("accruedFees");
        if (v.oracle()             != oracleBefore)    revert StatePreservationFailed("oracle");
        if (v.usdc()               != usdcBefore)      revert StatePreservationFailed("usdc");
        if (v.redeemFeeBps()       != redeemFeeBefore) revert StatePreservationFailed("redeemFeeBps");
        if (v.minReserveRatioBps() != minRatioBefore)  revert StatePreservationFailed("minReserveRatioBps");
        if (v.maxPriceAge()        != maxAgeBefore)    revert StatePreservationFailed("maxPriceAge");
        if (v.registeredAssets().length != assetsBefore) revert StatePreservationFailed("registeredAssets");
        if (v.mintingHalted()      != haltedBefore)    revert StatePreservationFailed("mintingHalted");
        // The new slot must be empty — carbon pricing is wired in step 2, not here.
        if (v.esgRegistry()        != address(0))      revert StatePreservationFailed("esgRegistry(should start 0)");

        console.log("=== after ===");
        console.log("version       :", v.version());
        console.log("esgRegistry   :", v.esgRegistry(), "(wire it separately with setEsgRegistry)");
        console.log("state preserved - all fields match");
        console.log("");
        console.log("NEXT: vault.setEsgRegistry(<ESGRegistryV2 from #128>) once it is deployed and");
        console.log("seeded. Until then mintFeeBpsForAsset() returns the most conservative tier's fee.");
    }
}
