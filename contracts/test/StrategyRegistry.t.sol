// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/StrategyRegistry.sol";

contract StrategyRegistryTest is Test {
    StrategyRegistry reg;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant sBTC = keccak256("sBTC");
    bytes32 constant sETH = keccak256("sETH");
    bytes32 constant sSOL = keccak256("sSOL");
    bytes32 constant sAAPL = keccak256("sAAPL");

    // ── helpers ──────────────────────────────────────────────────────────────

    function _alloc(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)
        internal
        pure
        returns (StrategyRegistry.Allocation memory)
    {
        return StrategyRegistry.Allocation(asset, weight, isLong, leverage);
    }

    /// @dev #97: StrategyRegistry now requires at least 3 allocations and caps
    ///      any one at 50%. This is the "happy path" shape most tests below
    ///      build from — three assets, none over the cap, summing to 10000 —
    ///      used wherever a test needs a VALID strategy to isolate some other
    ///      behaviour (an event, a version, per-trader isolation) rather than
    ///      to test the diversification rules themselves.
    function _threeAssetAllocs() internal pure returns (StrategyRegistry.Allocation[] memory) {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 4_000, true, 1);
        allocs[1] = _alloc(sETH, 3_000, false, 2);
        allocs[2] = _alloc(sSOL, 3_000, true, 5);
        return allocs;
    }

    function setUp() public {
        reg = new StrategyRegistry(address(0));
    }

    // ── registerTrader ───────────────────────────────────────────────────────

    function test_register_storesProfile() public {
        vm.prank(alice);
        reg.registerTrader("Alice");

        (bool isReg, string memory name,) = reg.traders(alice);
        assertTrue(isReg);
        assertEq(name, "Alice");
    }

    function test_register_addsToTraderList() public {
        vm.prank(alice);
        reg.registerTrader("Alice");
        vm.prank(bob);
        reg.registerTrader("Bob");

        address[] memory list = reg.getAllTraders();
        assertEq(list.length, 2);
        assertEq(list[0], alice);
        assertEq(list[1], bob);
    }

    function test_register_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit StrategyRegistry.TraderRegistered(alice, "Alice");
        vm.prank(alice);
        reg.registerTrader("Alice");
    }

    function test_register_duplicate_reverts() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        vm.expectRevert(StrategyRegistry.AlreadyRegistered.selector);
        reg.registerTrader("Alice Again");
        vm.stopPrank();
    }

    // ── publishStrategy – validation ─────────────────────────────────────────

    function test_publish_revertsIfNotRegistered() public {
        vm.prank(alice);
        vm.expectRevert(StrategyRegistry.NotRegistered.selector);
        reg.publishStrategy(_threeAssetAllocs());
    }

    function test_publish_revertsOnEmptyAllocations() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory empty = new StrategyRegistry.Allocation[](0);
        vm.expectRevert(StrategyRegistry.EmptyAllocations.selector);
        reg.publishStrategy(empty);
        vm.stopPrank();
    }

    // ── #97: diversification — at least 3 assets ─────────────────────────────

    function test_publish_revertsOnOneAsset() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(sBTC, 10_000, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.TooFewAssets.selector, 1));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnTwoAssets() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](2);
        allocs[0] = _alloc(sBTC, 5_000, true, 1);
        allocs[1] = _alloc(sETH, 5_000, false, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.TooFewAssets.selector, 2));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    /// @dev The MIN_ALLOCATION_ASSETS constant is the source of truth for
    ///      "how few is too few" — asserted directly so this test breaks
    ///      loudly if that constant ever changes without this test noticing.
    function test_MIN_ALLOCATION_ASSETS_isThree() public view {
        assertEq(reg.MIN_ALLOCATION_ASSETS(), 3);
    }

    function test_publish_exactlyThreeAssets_succeeds() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        reg.publishStrategy(_threeAssetAllocs());
        vm.stopPrank();

        (StrategyRegistry.Allocation[] memory allocs,) = reg.getLatestStrategy(alice);
        assertEq(allocs.length, 3);
    }

    // ── #97: diversification — no single asset over 50% ──────────────────────

    function test_publish_revertsOnWeightExceedsMax() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 5_001, true, 1);
        allocs[1] = _alloc(sETH, 2_999, false, 1);
        allocs[2] = _alloc(sSOL, 2_000, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.WeightExceedsMax.selector, 0, 5_001));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_exactlyFiftyPercent_succeeds() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 5_000, true, 1);
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 2_000, true, 1);
        reg.publishStrategy(allocs);
        vm.stopPrank();

        (StrategyRegistry.Allocation[] memory got,) = reg.getLatestStrategy(alice);
        assertEq(got[0].weight, 5_000, "the cap is inclusive - exactly 50% is allowed");
    }

    function test_MAX_ALLOCATION_WEIGHT_BPS_isFiftyPercent() public view {
        assertEq(reg.MAX_ALLOCATION_WEIGHT_BPS(), 5_000);
    }

    // ── weight sum, zero weight, leverage — unchanged behaviour ──────────────
    //
    // All three now use a 3-allocation array (#97's own minimum) so each
    // isolates the ONE condition it's named for, rather than tripping
    // TooFewAssets before ever reaching it.

    function test_publish_revertsOnWeightSumNot10000_low() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 3_000, true, 1);
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 3_999, true, 1); // sums to 9_999
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidWeightSum.selector, 9_999));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnWeightSumNot10000_high() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 3_000, true, 1);
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 4_001, true, 1); // sums to 10_001
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidWeightSum.selector, 10_001));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnZeroWeight() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC,     0, true,  1);
        allocs[1] = _alloc(sETH, 5_000, true,  1);
        allocs[2] = _alloc(sSOL, 5_000, false, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.ZeroWeight.selector, 0));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnLeverageZero() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 4_000, true, 0); // leverage = 0
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 3_000, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidLeverage.selector, 0, 0));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnLeverageSix() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 4_000, true, 6); // leverage = 6
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 3_000, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidLeverage.selector, 0, 6));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    // ── publishStrategy – happy paths ────────────────────────────────────────

    function test_publish_threeAssets() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        reg.publishStrategy(_threeAssetAllocs());

        (StrategyRegistry.Allocation[] memory allocs, uint256 vid) = reg.getLatestStrategy(alice);
        assertEq(vid, 0);
        assertEq(allocs.length, 3);
        assertEq(allocs[0].asset,    sBTC);
        assertEq(allocs[0].weight,   4_000);
        assertTrue(allocs[0].isLong);
        assertEq(allocs[0].leverage, 1);
        vm.stopPrank();
    }

    function test_publish_mixedLongShort() public {
        // [(sBTC, 4000, true, 2), (sETH, 3000, false, 1), (sSOL, 3000, true, 1)]
        vm.startPrank(alice);
        reg.registerTrader("Alice");

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = _alloc(sBTC, 4_000, true,  2);
        allocs[1] = _alloc(sETH, 3_000, false, 1);
        allocs[2] = _alloc(sSOL, 3_000, true,  1);
        reg.publishStrategy(allocs);

        (StrategyRegistry.Allocation[] memory got,) = reg.getLatestStrategy(alice);
        assertEq(got.length, 3);

        assertEq(got[0].asset,    sBTC);
        assertEq(got[0].weight,   4_000);
        assertTrue(got[0].isLong);
        assertEq(got[0].leverage, 2);

        assertEq(got[1].asset,    sETH);
        assertEq(got[1].weight,   3_000);
        assertFalse(got[1].isLong);
        assertEq(got[1].leverage, 1);

        assertEq(got[2].asset,    sSOL);
        assertEq(got[2].weight,   3_000);
        assertTrue(got[2].isLong);
        assertEq(got[2].leverage, 1);
        vm.stopPrank();
    }

    function test_publish_versionHistory() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");

        // v0: BTC-led
        StrategyRegistry.Allocation[] memory v0Allocs = new StrategyRegistry.Allocation[](3);
        v0Allocs[0] = _alloc(sBTC, 4_000, true, 1);
        v0Allocs[1] = _alloc(sETH, 3_000, false, 1);
        v0Allocs[2] = _alloc(sSOL, 3_000, true, 1);
        reg.publishStrategy(v0Allocs);

        // v1: ETH-led
        StrategyRegistry.Allocation[] memory v1Allocs = new StrategyRegistry.Allocation[](3);
        v1Allocs[0] = _alloc(sETH, 4_000, false, 2);
        v1Allocs[1] = _alloc(sBTC, 3_000, true, 1);
        v1Allocs[2] = _alloc(sSOL, 3_000, false, 1);
        reg.publishStrategy(v1Allocs);

        // v2: SOL-led
        StrategyRegistry.Allocation[] memory v2Allocs = new StrategyRegistry.Allocation[](3);
        v2Allocs[0] = _alloc(sSOL, 5_000, true, 5);
        v2Allocs[1] = _alloc(sBTC, 3_000, false, 1);
        v2Allocs[2] = _alloc(sAAPL, 2_000, true, 1);
        reg.publishStrategy(v2Allocs);

        assertEq(reg.getStrategyCount(alice), 3);

        (StrategyRegistry.Allocation[] memory latest, uint256 vid) = reg.getLatestStrategy(alice);
        assertEq(vid, 2);
        assertEq(latest[0].asset, sSOL);

        // check v0 still intact
        (StrategyRegistry.Allocation[] memory v0,) = reg.getStrategyVersion(alice, 0);
        assertEq(v0[0].asset, sBTC);

        vm.stopPrank();
    }

    function test_publish_emitsStrategyPublishedEvent() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");

        vm.expectEmit(true, false, false, false);
        emit StrategyRegistry.StrategyPublished(alice, 0, block.timestamp);
        reg.publishStrategy(_threeAssetAllocs());
        vm.stopPrank();
    }

    function test_getStrategyCount_zeroForFreshTrader() public {
        vm.prank(alice);
        reg.registerTrader("Alice");
        assertEq(reg.getStrategyCount(alice), 0);
    }

    function test_getAllTraders_empty() public view {
        assertEq(reg.getAllTraders().length, 0);
    }

    function test_multipleTraders_isolatedVersions() public {
        vm.prank(alice);
        reg.registerTrader("Alice");
        vm.prank(alice);
        reg.publishStrategy(_threeAssetAllocs());

        vm.prank(bob);
        reg.registerTrader("Bob");
        StrategyRegistry.Allocation[] memory bobAllocs = new StrategyRegistry.Allocation[](3);
        bobAllocs[0] = _alloc(sETH, 4_000, false, 2);
        bobAllocs[1] = _alloc(sBTC, 3_000, true, 1);
        bobAllocs[2] = _alloc(sAAPL, 3_000, true, 1);
        vm.prank(bob);
        reg.publishStrategy(bobAllocs);

        (StrategyRegistry.Allocation[] memory aliceStrat,) = reg.getLatestStrategy(alice);
        (StrategyRegistry.Allocation[] memory bobStrat,)   = reg.getLatestStrategy(bob);

        assertEq(aliceStrat[0].asset, sBTC);
        assertEq(bobStrat[0].asset,   sETH);
    }
}
