// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/AssetVaultV2_1.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../src/MockUSDC.sol";

/// @notice V2.1 fixes a defect that only appears when the vault is pointed at an
///         oracle that FAILS CLOSED.
///
///         V2.0's outstandingValue() called getPrice directly and skipped stale
///         assets with a `continue`. That works against MockOracle, which
///         returns stale data. GuardedOracle reverts instead — so the loop died,
///         taking reserveRatioBps() and mint() with it. One stale asset blocked
///         minting every OTHER asset.
///
///         These tests run the same scenario against both implementations, so
///         the fix is measured rather than asserted.
contract AssetVaultV2_1UpgradeTest is Test {
    MockUSDC      usdc;
    GuardedOracle oracle;

    address admin = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AAPL = keccak256("sAAPL");
    bytes32 constant BTC  = keccak256("sBTC");

    AssetVaultV2     vault;      // proxy, initially running V2.0
    SyntheticAssetV2 aapl;
    SyntheticAssetV2 btc;

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new GuardedOracle(admin);
        oracle.grantRole(oracle.KEEPER_ROLE(), admin);
        oracle.addAsset(AAPL, 200e8);
        oracle.addAsset(BTC, 100_000e8);

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AAPL, admin);
        btc  = new SyntheticAssetV2("Synthetic Bitcoin", "sBTC", BTC, admin);
        bytes32 minter = aapl.MINTER_ROLE();
        aapl.grantRole(minter, address(vault));
        btc.grantRole(minter, address(vault));
        vault.registerAsset(AAPL, address(aapl));
        vault.registerAsset(BTC, address(btc));
        vault.setAssetCap(AAPL, 1_000e18);
        vault.setAssetCap(BTC, 1_000e18);
        vault.setRiskParams(30, 30, 11_000, 1 hours);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(admin, 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(500_000e18);

        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _upgrade() internal returns (AssetVaultV2_1) {
        AssetVaultV2_1 next = new AssetVaultV2_1();
        vault.upgradeToAndCall(address(next), "");
        return AssetVaultV2_1(address(vault));
    }

    /// @dev Establishes the baseline: V2.0 dies once any price goes stale.
    function test_baseline_v2BreaksWhenAPriceGoesStale() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);

        vm.warp(block.timestamp + 2 hours);   // every price now stale

        vm.expectRevert();                    // GuardedOracle.StalePrice
        vault.reserveRatioBps();

        vm.prank(alice);
        vm.expectRevert();
        vault.mint(BTC, 1_000e18);
    }

    /// @dev The fix. Same state, same staleness, V2.1 survives.
    function test_v2_1SurvivesStalePrices() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);

        AssetVaultV2_1 v = _upgrade();
        vm.warp(block.timestamp + 2 hours);

        uint256 ratio = v.reserveRatioBps();   // no longer reverts
        assertGt(ratio, 0);
        assertTrue(v.ratioIsStale());          // and it says so
    }

    /// @dev The failure that actually hurt: one stale asset blocking a mint of a
    ///      DIFFERENT, freshly-priced asset.
    function test_staleAssetNoLongerBlocksMintingAnother() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);

        AssetVaultV2_1 v = _upgrade();

        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(BTC, 100_000e8);    // refresh ONLY btc

        vm.prank(alice);
        v.mint(BTC, 1_000e18);                 // works despite sAAPL being stale
        assertGt(btc.balanceOf(alice), 0);
    }

    /// @dev Minting an asset whose OWN price is stale must still revert — the
    ///      fix must not become a way to trade on a dead quote.
    function test_mintingAStaleAssetStillReverts() public {
        AssetVaultV2_1 v = _upgrade();
        vm.warp(block.timestamp + 2 hours);

        vm.prank(alice);
        vm.expectRevert();
        v.mint(AAPL, 1_000e18);
    }

    /// @dev A skipped asset understates the liability, so the ratio is
    ///      optimistic. ratioIsStale() is how a caller learns not to trust it.
    function test_unpricedAssetsAreReportedNotHidden() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);

        AssetVaultV2_1 v = _upgrade();
        assertFalse(v.ratioIsStale());

        uint256 fresh = v.outstandingValue();

        vm.warp(block.timestamp + 2 hours);
        (uint256 total, uint256 unpriced) = v.outstandingValueDetailed();
        // M-7: previously `total` collapsed to 0 here — the unpriceable asset was
        // dropped from the liability, which is what made the mint gate optimistic.
        // It is now marked to the last price the vault transacted on, so the
        // liability survives the outage instead of disappearing.
        assertEq(total, fresh);    // still counted, at its last known price
        assertEq(unpriced, 1);     // and flagged, so callers know it is an estimate
        assertTrue(v.ratioIsStale());
    }

    // ── upgrade safety ───────────────────────────────────────────────────────

    /// @dev The whole point of a proxy: state must survive the swap.
    function test_upgradePreservesEveryStateField() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);

        uint256 feesBefore     = vault.accruedFees();
        uint256 exposureBefore = vault.exposureOf(AAPL);
        uint256 capBefore      = vault.assetCap(AAPL);
        uint256 reserveBefore  = vault.reserve();
        address oracleBefore   = vault.oracle();
        address tokenBefore    = vault.assetToken(AAPL);
        uint256 mintFeeBefore  = vault.mintFeeBps();

        AssetVaultV2_1 v = _upgrade();

        assertEq(v.version(), "2.1.0");
        assertEq(v.accruedFees(),     feesBefore);
        assertEq(v.exposureOf(AAPL),  exposureBefore);
        assertEq(v.assetCap(AAPL),    capBefore);
        assertEq(v.reserve(),         reserveBefore);
        assertEq(v.oracle(),          oracleBefore);
        assertEq(v.assetToken(AAPL),  tokenBefore);
        assertEq(v.mintFeeBps(),      mintFeeBefore);
        assertEq(v.registeredAssets().length, 2);
    }

    /// @dev Holder balances live in the token, not the vault, but a botched
    ///      upgrade could still orphan them by losing the registration.
    function test_holdersCanStillRedeemAfterUpgrade() public {
        vm.prank(alice);
        vault.mint(AAPL, 2_000e18);
        uint256 held = aapl.balanceOf(alice);

        AssetVaultV2_1 v = _upgrade();

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        v.redeem(AAPL, held);
        assertGt(usdc.balanceOf(alice), before);
        assertEq(aapl.balanceOf(alice), 0);
    }

    function test_onlyAdminCanUpgrade() public {
        AssetVaultV2_1 next = new AssetVaultV2_1();
        vm.prank(alice);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
    }

    /// @dev Behaviour with a healthy oracle must be unchanged — the fix is for
    ///      the degraded path only.
    function test_normalOperationUnchangedAfterUpgrade() public {
        (uint256 outBefore, uint256 feeBefore) = vault.previewMint(AAPL, 2_000e18);

        AssetVaultV2_1 v = _upgrade();

        (uint256 outAfter, uint256 feeAfter) = v.previewMint(AAPL, 2_000e18);
        assertEq(outAfter, outBefore);
        assertEq(feeAfter, feeBefore);

        vm.prank(alice);
        v.mint(AAPL, 2_000e18);
        assertEq(aapl.balanceOf(alice), outAfter);
        assertFalse(v.ratioIsStale());
    }
}
