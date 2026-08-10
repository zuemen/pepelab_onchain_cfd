// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/AssetVaultV2.sol";
import "../src/v2/AssetVaultV2_1.sol";
import "../src/v2/SyntheticAssetV2.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Regression suite for the 2026-08-06 audit, M-5 / M-6 / M-7 on the
///         AssetVaultV2 family. V2.2 already carried the M-6 fix; V2.0 and V2.1
///         are still deployed artefacts in `src/`, so they get it too.
contract AuditFixesVaultV2Test is Test {
    AssetVaultV2     v20;
    AssetVaultV2_1   v21;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl20;
    SyntheticAssetV2 aapl21;
    SyntheticAssetV2 btc21;

    address admin = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");
    bytes32 constant BID = keccak256("sBTC");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);
        oracle.addAsset(BID, 100_000e8);

        v20 = AssetVaultV2(address(new ERC1967Proxy(
            address(new AssetVaultV2()),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        v21 = AssetVaultV2_1(address(new ERC1967Proxy(
            address(new AssetVaultV2_1()),
            abi.encodeCall(AssetVaultV2_1.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl20 = new SyntheticAssetV2("sAAPL", "sAAPL", AID, admin);
        aapl21 = new SyntheticAssetV2("sAAPL", "sAAPL", AID, admin);
        btc21  = new SyntheticAssetV2("sBTC",  "sBTC",  BID, admin);

        aapl20.grantRole(aapl20.MINTER_ROLE(), address(v20));
        aapl21.grantRole(aapl21.MINTER_ROLE(), address(v21));
        btc21.grantRole(btc21.MINTER_ROLE(),   address(v21));

        v20.registerAsset(AID, address(aapl20));
        v20.setAssetCap(AID, 10_000e18);
        v20.setRiskParams(0, 0, 11_000, 1 hours);

        v21.registerAsset(AID, address(aapl21));
        v21.registerAsset(BID, address(btc21));
        v21.setAssetCap(AID, 10_000e18);
        v21.setAssetCap(BID, 10_000e18);
        v21.setRiskParams(0, 0, 11_000, 1 hours);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(admin, 1_000_000e18);
        usdc.approve(address(v20), type(uint256).max);
        usdc.approve(address(v21), type(uint256).max);
        v20.fundVault(100_000e18);
        v21.fundVault(100_000e18);

        vm.startPrank(alice);
        usdc.approve(address(v20), type(uint256).max);
        usdc.approve(address(v21), type(uint256).max);
        vm.stopPrank();
    }

    // ── M-5: cannot re-point a live asset at a different token ────────────────

    /// @dev PoC: `unregisterAsset` refuses while units are outstanding, but
    ///      `registerAsset` happily overwrote the mapping. Re-pointing then made
    ///      every holder's redeem revert (the vault burns from a token they do
    ///      not hold) while `_outstanding` still recorded the liability.
    function test_M5_cannotRepointAssetWhileOutstanding() public {
        vm.prank(alice); v20.mint(AID, 2_000e18);
        assertGt(v20.exposureOf(AID), 0);

        SyntheticAssetV2 impostor = new SyntheticAssetV2("evil", "evil", AID, admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                AssetVaultV2.AssetStillOutstanding.selector, AID, v20.exposureOf(AID)
            )
        );
        v20.registerAsset(AID, address(impostor));

        // Same token is still fine (idempotent re-wiring).
        v20.registerAsset(AID, address(aapl20));
        assertEq(v20.assetToken(AID), address(aapl20));

        // And once everyone has exited, the swap is allowed again.
        uint256 outstanding = v20.exposureOf(AID);
        vm.prank(alice); v20.redeem(AID, outstanding);
        v20.registerAsset(AID, address(impostor));
        assertEq(v20.assetToken(AID), address(impostor));
    }

    function test_M5_cannotRepointAssetWhileOutstanding_v21() public {
        vm.prank(alice); v21.mint(AID, 2_000e18);
        SyntheticAssetV2 impostor = new SyntheticAssetV2("evil", "evil", AID, admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                AssetVaultV2_1.AssetStillOutstanding.selector, AID, v21.exposureOf(AID)
            )
        );
        v21.registerAsset(AID, address(impostor));
    }

    // ── M-6: redeem must only book fees the reserve can back ──────────────────

    /// @dev The `avail < usdcOut` guard covers the NET payout, so a redeem in the
    ///      window `usdcOut <= reserve < gross` booked operator revenue against
    ///      money that was not there. accruedFees then exceeded the balance,
    ///      reserve() clamped to 0, and every later redeem reverted VaultDry on
    ///      USDC the vault demonstrably held. Fixed in V2.2, backported here.
    function test_M6_redeemOnlyAccruesBackedFees() public {
        _assertRedeemFeeIsBacked_v20();
    }

    function _assertRedeemFeeIsBacked_v20() internal {
        // Dry vault: no operator collateral, 10% redeem fee, no ratio floor.
        AssetVaultV2 dry = AssetVaultV2(address(new ERC1967Proxy(
            address(new AssetVaultV2()),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        SyntheticAssetV2 t = new SyntheticAssetV2("sAAPL", "sAAPL", AID, admin);
        t.grantRole(t.MINTER_ROLE(), address(dry));
        dry.registerAsset(AID, address(t));
        dry.setAssetCap(AID, 10_000e18);
        dry.setRiskParams(0, 1_000, 0, 1 hours);   // 10% redeem fee

        vm.startPrank(alice);
        usdc.approve(address(dry), type(uint256).max);
        dry.mint(AID, 1_000e18);
        uint256 units = t.balanceOf(alice);

        // Redeem everything: gross == 1,000 but the payout is 900 and the whole
        // balance is only 1,000, so the fee is only partly backed.
        dry.redeem(AID, units);
        vm.stopPrank();

        assertLe(
            dry.accruedFees(),
            usdc.balanceOf(address(dry)),
            "accruedFees must never exceed the vault's actual balance"
        );
        // The invariant that used to break: reserve + fees <= balance.
        assertLe(dry.reserve() + dry.accruedFees(), usdc.balanceOf(address(dry)));
    }

    // ── M-7: an unpriceable asset must not vanish from the liability ──────────

    /// @dev `outstandingValue` used to `continue` past an unpriceable asset,
    ///      deleting that liability from `reserveRatioBps()` — the ONLY solvency
    ///      gate `mint()` has. The ratio therefore looked best exactly when it
    ///      was least knowable. The liability is now marked to the last price the
    ///      vault itself transacted on, and flagged via `ratioIsStale()`.
    function test_M7_staleAssetStaysInTheLiability_v20() public {
        vm.prank(alice); v20.mint(AID, 2_000e18);
        uint256 fresh = v20.outstandingValue();
        assertGt(fresh, 0);
        assertFalse(v20.ratioIsStale());

        vm.warp(block.timestamp + 2 hours);        // feed goes stale
        assertEq(v20.outstandingValue(), fresh, "liability must not disappear");
        assertTrue(v20.ratioIsStale());
    }

    /// @dev The concrete consequence: with the liability deleted, the ratio read
    ///      as "infinite" and the mint gate was a no-op. It now reflects reality.
    function test_M7_mintGateIsNoLongerOptimisticWhenAFeedIsDown() public {
        // 200% required coverage against a 100,000 operator reserve.
        v21.setRiskParams(0, 0, 20_000, 1 hours);

        vm.prank(alice); v21.mint(AID, 50_000e18);  // reserve 150k / liability 50k
        uint256 ratioFresh = v21.reserveRatioBps();

        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(BID, 100_000e8);         // refresh ONLY sBTC

        // Pre-fix: sAAPL's liability vanished → reserveRatioBps() == uint.max.
        assertLt(v21.reserveRatioBps(), type(uint256).max, "ratio must stay finite");
        assertEq(v21.reserveRatioBps(), ratioFresh, "and equal to the last known book");
        assertTrue(v21.ratioIsStale(), "caller is told the ratio is an estimate");

        // Reserve 210k against a real liability of 110k = 190% < 200% → refused.
        // With sAAPL deleted from the book it read as 350% and sailed through.
        vm.prank(alice);
        vm.expectRevert();                          // ReserveRatioTooLow
        v21.mint(BID, 60_000e18);
    }

    /// @dev V2.1's headline property must survive: a stale asset still does not
    ///      block minting a DIFFERENT, freshly-priced one when the reserve covers it.
    function test_M7_staleAssetStillDoesNotBlockOtherMints() public {
        vm.prank(alice); v21.mint(AID, 2_000e18);

        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(BID, 100_000e8);

        vm.prank(alice); v21.mint(BID, 1_000e18);
        assertGt(btc21.balanceOf(alice), 0);
    }
}
