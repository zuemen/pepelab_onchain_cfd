// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

contract AssetVaultV2RiskTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        bytes32 minterRole = aapl.MINTER_ROLE();

        vm.startPrank(admin);
        aapl.grantRole(minterRole, address(vault));
        vault.registerAsset(AID, address(aapl));
        vault.setAssetCap(AID, 1_000e18);            // 1000 sAAPL cap
        vault.setRiskParams(0, 0, 11_000, 1 hours);  // fees off for clean math
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(admin, 1_000_000e18);
        vm.startPrank(admin);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
        vm.stopPrank();
    }

    function _mintAs(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.mint(AID, amount);
        vm.stopPrank();
    }

    function test_reserveExcludesAccruedFees() public {
        vm.prank(admin);
        vault.setRiskParams(100, 0, 11_000, 1 hours);   // 1% mint fee
        _mintAs(alice, 10_000e18);                       // 100 USDC fee

        assertEq(vault.accruedFees(), 100e18);
        // reserve = 100,000 seeded + 10,000 in - 100 fees
        assertEq(vault.reserve(), 109_900e18);
    }

    function test_outstandingValueTracksPrice() public {
        _mintAs(alice, 2_000e18);                        // 10 sAAPL at $200
        assertEq(vault.exposureOf(AID), 10e18);
        assertEq(vault.outstandingValue(), 2_000e18);

        oracle.updatePrice(AID, 400e8);
        assertEq(vault.outstandingValue(), 4_000e18);    // liability doubled
    }

    /// @dev VULNERABILITY #1 BOUND: exposure to a single market is capped.
    function test_mintRevertsWhenAssetCapExceeded() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.mint(AID, 100_000e18);                     // 500 sAAPL, under cap
        assertEq(vault.exposureOf(AID), 500e18);

        vm.expectRevert(abi.encodeWithSelector(
            AssetVaultV2.CapExceeded.selector, AID, 1_001e18, 1_000e18
        ));
        vault.mint(AID, 100_200e18);                     // would reach 1001
        vm.stopPrank();
    }

    function test_capOfZeroClosesAssetToNewMints() public {
        vm.prank(admin);
        vault.setAssetCap(AID, 0);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.CapExceeded.selector, AID, 5e18, 0));
        vault.mint(AID, 1_000e18);
        vm.stopPrank();
    }

    /// @dev Winding an asset down must not trap existing holders.
    function test_capOfZeroStillAllowsRedeem() public {
        _mintAs(alice, 2_000e18);
        vm.prank(admin);
        vault.setAssetCap(AID, 0);

        vm.prank(alice);
        uint256 out = vault.redeem(AID, 10e18);
        assertEq(out, 2_000e18);
    }

    /// @dev VULNERABILITY #2 FIX: mints stop while the reserve can still pay
    ///      everyone, so no redeemer strands a later one.
    function test_mintRevertsWhenReserveRatioTooLow() public {
        _mintAs(alice, 90_000e18);          // 450 sAAPL, liability 90,000
        oracle.updatePrice(AID, 420e8);      // liability -> 189,000; reserve 190,000

        assertLt(vault.reserveRatioBps(), 11_000);

        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert();                   // ReserveRatioTooLow
        vault.mint(AID, 1_000e18);
        vm.stopPrank();
    }

    /// @dev Redeem must stay open even when the ratio is unhealthy — blocking
    ///      exits would be the bank run, not the fix for it.
    function test_redeemStillWorksWhenRatioUnhealthy() public {
        _mintAs(alice, 90_000e18);
        oracle.updatePrice(AID, 420e8);
        assertLt(vault.reserveRatioBps(), 11_000);

        vm.prank(alice);
        uint256 out = vault.redeem(AID, 100e18);
        assertEq(out, 100e18 * 420e8 / 1e8);
    }

    function test_reserveRatioIsMaxWhenNothingOutstanding() public view {
        assertEq(vault.reserveRatioBps(), type(uint256).max);
    }

    function test_pauseBlocksMintAndRedeem() public {
        _mintAs(alice, 2_000e18);
        vm.prank(admin);
        vault.pause();

        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert();
        vault.mint(AID, 1_000e18);
        vm.expectRevert();
        vault.redeem(AID, 1e18);
        vm.stopPrank();
    }

    function test_onlyRiskRoleCanSetCap() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setAssetCap(AID, 1e18);
    }

    /// @dev M-7 changed the second assertion. The liability must stay READABLE
    ///      during an oracle outage (the original point of this test), but it
    ///      must not silently drop to ZERO — `mint()`'s only solvency gate is the
    ///      reserve ratio, and a vanished liability makes that ratio look perfect
    ///      exactly when it is least knowable. An unpriceable asset is now marked
    ///      to the last price the vault itself transacted on, and flagged.
    function test_outstandingValueMarksStaleAssetToLastPriceInsteadOfDropping() public {
        _mintAs(alice, 2_000e18);
        uint256 fresh = vault.outstandingValue();
        assertGt(fresh, 0);

        vm.warp(block.timestamp + 2 hours);          // price now stale
        assertEq(vault.outstandingValue(), fresh);   // readable, and still counted
        assertTrue(vault.ratioIsStale());            // but flagged as an estimate
    }

    function test_redeemRevertsVaultDryWhenReserveInsufficient() public {
        // Fresh vault with no operator collateral at all.
        AssetVaultV2 impl = new AssetVaultV2();
        AssetVaultV2 dry = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        SyntheticAssetV2 t = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        bytes32 minterRole = t.MINTER_ROLE();
        vm.startPrank(admin);
        t.grantRole(minterRole, address(dry));
        dry.registerAsset(AID, address(t));
        dry.setAssetCap(AID, 1_000e18);
        dry.setRiskParams(0, 0, 0, 1 hours);   // no ratio floor, so mint is allowed
        vm.stopPrank();

        vm.startPrank(alice);
        usdc.approve(address(dry), 2_000e18);
        dry.mint(AID, 2_000e18);               // vault holds exactly alice's 2000
        vm.stopPrank();

        oracle.updatePrice(AID, 400e8);        // owed 4000, only 2000 on hand

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.VaultDry.selector, 4_000e18, 2_000e18));
        dry.redeem(AID, 10e18);
    }

    /// @dev Operator revenue must never be counted as payout collateral.
    function test_withdrawFeesCannotTouchReserve() public {
        vm.prank(admin);
        vault.setRiskParams(100, 0, 0, 1 hours);
        _mintAs(alice, 10_000e18);             // 100 fee

        vm.prank(admin);
        vm.expectRevert(AssetVaultV2.InvalidParam.selector);
        vault.withdrawFees(admin, 101e18);     // more than accrued

        vm.prank(admin);
        vault.withdrawFees(admin, 100e18);     // exactly accrued is fine
        assertEq(vault.accruedFees(), 0);
    }
}
