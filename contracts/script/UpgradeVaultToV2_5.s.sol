// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/v2/AssetVaultV2_4.sol";
import "../src/v2/AssetVaultV2_5.sol";

interface IUpgradeable25 {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// @notice Upgrades the AssetVault proxy from V2.4 to V2.5 (bounded M-7
///         last-good price fallback). Storage: two appended fields
///         (`_lastGood`, `_unpricedExempt`) taken from the front of __gap (43 -> 41) — check it
///         BEFORE broadcasting with `script/check-vault-storage-layout.sh`.
///
///         No initializer: `_lastGood` starts empty, so the vault behaves
///         exactly like V2.4 until a mint / redeem / `observeReserve` records
///         a live quote. The keeper's next `observeReserve` seeds every
///         outstanding asset.
///
///           # simulate (no key, nothing sent):
///           forge script script/UpgradeVaultToV2_5.s.sol:UpgradeVaultToV2_5 \
///             --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
///           # broadcast (user only; needs DEFAULT_ADMIN_ROLE on the proxy — after the
///           # timelock handover this must go through a timelock proposal instead):
///           forge script … --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vv
///
///         Same broadcast, second call: `setRiskParams` (RISK_ROLE) lowers
///         `maxPriceAge` to VAULT_MAX_PRICE_AGE (default 21600 = 6h). The live
///         proxy ran at 30 days; V2.5 caps live quotes at 6h anyway
///         (`effectiveMaxPriceAge`), this makes the stored parameter say so.
///         Redeem fee and min reserve ratio are re-written unchanged.
///
///         Precondition: every outstanding asset has a quote younger than 6h
///         (dispatch the keeper first) — otherwise the upgrade would turn
///         them unpriced and block mints; the script refuses.
///
///         Env: VAULT_PROXY (default Base Sepolia 0x916D…f10a),
///              VAULT_MAX_PRICE_AGE (default 21600, must be 1..21600).
contract UpgradeVaultToV2_5 is Script {
    address internal constant BASE_SEPOLIA_VAULT = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;

    error StatePreservationFailed(string field);

    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    function run() external {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        address proxy = vm.envOr("VAULT_PROXY", BASE_SEPOLIA_VAULT);
        AssetVaultV2_4 v = AssetVaultV2_4(proxy);

        require(keccak256(bytes(v.version())) == keccak256(bytes("2.4.0")), "proxy is not on V2.4");
        require(v.hasRole(v.DEFAULT_ADMIN_ROLE(), deployer), "broadcaster lacks DEFAULT_ADMIN_ROLE on the proxy");
        require(v.hasRole(v.RISK_ROLE(), deployer), "broadcaster lacks RISK_ROLE (needed to lower maxPriceAge in the same run)");
        uint256 newMaxAge = vm.envOr("VAULT_MAX_PRICE_AGE", uint256(21_600));
        require(newMaxAge > 0 && newMaxAge <= 21_600, "VAULT_MAX_PRICE_AGE must be 1..21600");

        // Snapshot, so the upgrade is checked rather than trusted.
        uint256 feesBefore      = v.accruedFees();
        address oracleBefore    = v.oracle();
        address usdcBefore      = v.usdc();
        address esgBefore       = v.esgRegistry();
        uint256 redeemFeeBefore = v.redeemFeeBps();
        uint256 minRatioBefore  = v.minReserveRatioBps();
        uint256 maxAgeBefore    = v.maxPriceAge();
        bool    haltedBefore    = v.mintingHalted();
        bool    pausedBefore    = v.paused();
        bytes32[] memory ids    = v.registeredAssets();
        uint256[] memory outBefore = new uint256[](ids.length);
        uint256[] memory capBefore = new uint256[](ids.length);
        address[] memory tokBefore = new address[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            outBefore[i] = v.exposureOf(ids[i]);
            capBefore[i] = v.assetCap(ids[i]);
            tokBefore[i] = v.assetToken(ids[i]);
        }
        (uint256 liabBefore, uint256 unpricedBefore) = v.outstandingValueDetailed();

        console.log("=== before (V2.4) ===");
        console.log("proxy         :", proxy);
        console.log("accruedFees   :", feesBefore);
        console.log("assets        :", ids.length);
        console.log("liability     :", liabBefore);
        console.log("unpriced      :", unpricedBefore);
        console.log("mintingHalted :", haltedBefore);

        vm.startBroadcast(deployer);
        AssetVaultV2_5 impl = new AssetVaultV2_5();
        IUpgradeable25(proxy).upgradeToAndCall(address(impl), "");
        AssetVaultV2_5(proxy).setRiskParams(redeemFeeBefore, minRatioBefore, newMaxAge);
        vm.stopBroadcast();
        console.log("new implementation:", address(impl));

        AssetVaultV2_5 n = AssetVaultV2_5(proxy);
        if (keccak256(bytes(n.version())) != keccak256(bytes("2.5.0"))) revert StatePreservationFailed("version");
        if (n.accruedFees()        != feesBefore)      revert StatePreservationFailed("accruedFees");
        if (n.oracle()             != oracleBefore)    revert StatePreservationFailed("oracle");
        if (n.usdc()               != usdcBefore)      revert StatePreservationFailed("usdc");
        if (n.esgRegistry()        != esgBefore)       revert StatePreservationFailed("esgRegistry");
        if (n.redeemFeeBps()       != redeemFeeBefore) revert StatePreservationFailed("redeemFeeBps");
        if (n.minReserveRatioBps() != minRatioBefore)  revert StatePreservationFailed("minReserveRatioBps");
        if (n.maxPriceAge()        != newMaxAge)       revert StatePreservationFailed("maxPriceAge (lowered)");
        maxAgeBefore;
        if (n.mintingHalted()      != haltedBefore)    revert StatePreservationFailed("mintingHalted");
        if (n.paused()             != pausedBefore)    revert StatePreservationFailed("paused");
        if (!n.hasRole(n.DEFAULT_ADMIN_ROLE(), deployer)) revert StatePreservationFailed("admin role");
        bytes32[] memory idsAfter = n.registeredAssets();
        if (idsAfter.length != ids.length) revert StatePreservationFailed("registeredAssets");
        for (uint256 i = 0; i < ids.length; i++) {
            if (idsAfter[i] != ids[i])               revert StatePreservationFailed("assetId order");
            if (n.exposureOf(ids[i]) != outBefore[i]) revert StatePreservationFailed("outstanding");
            if (n.assetCap(ids[i])   != capBefore[i]) revert StatePreservationFailed("assetCap");
            if (n.assetToken(ids[i]) != tokBefore[i]) revert StatePreservationFailed("assetToken");
            (uint256 lg, uint256 at, ) = n.lastGoodPrice(ids[i]);
            if (lg != 0 || at != 0) revert StatePreservationFailed("lastGood must start empty");
        }
        (uint256 liabAfter, uint256 unpricedAfter, uint256 fallbackAfter) = n.valuationDetail();
        if (unpricedAfter > unpricedBefore) {
            revert StatePreservationFailed("an outstanding asset's price is older than 6h - dispatch the keeper, then re-run");
        }
        if (liabAfter != liabBefore || fallbackAfter != 0) revert StatePreservationFailed("valuation changed on upgrade");

        console.log("=== after (V2.5) ===");
        console.log("version       :", n.version());
        console.log("maxPriceAge   :", n.maxPriceAge(), "(effective", n.effectiveMaxPriceAge());
        console.log("liability     :", liabAfter, "(unchanged)");
        console.log("state preserved - every field and every asset matches");
        console.log("NEXT: keeper's next observeReserve() seeds the last-good marks.");
    }
}
