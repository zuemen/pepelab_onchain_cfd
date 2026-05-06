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

    // ── helpers ──────────────────────────────────────────────────────────────

    function _alloc(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)
        internal
        pure
        returns (StrategyRegistry.Allocation memory)
    {
        return StrategyRegistry.Allocation(asset, weight, isLong, leverage);
    }

    function _singleAlloc(bytes32 asset, bool isLong, uint256 leverage)
        internal
        pure
        returns (StrategyRegistry.Allocation[] memory)
    {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(asset, 10_000, isLong, leverage);
        return allocs;
    }

    function setUp() public {
        reg = new StrategyRegistry();
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
        reg.publishStrategy(_singleAlloc(sBTC, true, 1));
    }

    function test_publish_revertsOnEmptyAllocations() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory empty = new StrategyRegistry.Allocation[](0);
        vm.expectRevert(StrategyRegistry.EmptyAllocations.selector);
        reg.publishStrategy(empty);
        vm.stopPrank();
    }

    function test_publish_revertsOnWeightSumNot10000_low() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(sBTC, 9_999, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidWeightSum.selector, 9_999));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnWeightSumNot10000_high() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(sBTC, 10_001, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidWeightSum.selector, 10_001));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnZeroWeight() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](2);
        allocs[0] = _alloc(sBTC,      0, true, 1);
        allocs[1] = _alloc(sETH, 10_000, true, 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.ZeroWeight.selector, 0));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnLeverageZero() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(sBTC, 10_000, true, 0); // leverage = 0
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidLeverage.selector, 0, 0));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    function test_publish_revertsOnLeverageSix() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = _alloc(sBTC, 10_000, true, 6); // leverage = 6
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.InvalidLeverage.selector, 0, 6));
        reg.publishStrategy(allocs);
        vm.stopPrank();
    }

    // ── publishStrategy – happy paths ────────────────────────────────────────

    function test_publish_singleAsset() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");
        reg.publishStrategy(_singleAlloc(sBTC, true, 5));

        (StrategyRegistry.Allocation[] memory allocs, uint256 vid) = reg.getLatestStrategy(alice);
        assertEq(vid, 0);
        assertEq(allocs.length, 1);
        assertEq(allocs[0].asset,    sBTC);
        assertEq(allocs[0].weight,   10_000);
        assertTrue(allocs[0].isLong);
        assertEq(allocs[0].leverage, 5);
        vm.stopPrank();
    }

    function test_publish_mixedLongShort() public {
        // [(sBTC, 5000, true, 2), (sETH, 5000, false, 1)]
        vm.startPrank(alice);
        reg.registerTrader("Alice");

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](2);
        allocs[0] = _alloc(sBTC, 5_000, true,  2);
        allocs[1] = _alloc(sETH, 5_000, false, 1);
        reg.publishStrategy(allocs);

        (StrategyRegistry.Allocation[] memory got,) = reg.getLatestStrategy(alice);
        assertEq(got.length, 2);

        assertEq(got[0].asset,    sBTC);
        assertEq(got[0].weight,   5_000);
        assertTrue(got[0].isLong);
        assertEq(got[0].leverage, 2);

        assertEq(got[1].asset,    sETH);
        assertEq(got[1].weight,   5_000);
        assertFalse(got[1].isLong);
        assertEq(got[1].leverage, 1);
        vm.stopPrank();
    }

    function test_publish_versionHistory() public {
        vm.startPrank(alice);
        reg.registerTrader("Alice");

        // v0: 100% BTC long
        reg.publishStrategy(_singleAlloc(sBTC, true, 1));
        // v1: 100% ETH short
        reg.publishStrategy(_singleAlloc(sETH, false, 2));
        // v2: 100% SOL long x5
        reg.publishStrategy(_singleAlloc(sSOL, true, 5));

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
        reg.publishStrategy(_singleAlloc(sBTC, true, 1));
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
        reg.publishStrategy(_singleAlloc(sBTC, true, 1));

        vm.prank(bob);
        reg.registerTrader("Bob");
        vm.prank(bob);
        reg.publishStrategy(_singleAlloc(sETH, false, 2));

        (StrategyRegistry.Allocation[] memory aliceStrat,) = reg.getLatestStrategy(alice);
        (StrategyRegistry.Allocation[] memory bobStrat,)   = reg.getLatestStrategy(bob);

        assertEq(aliceStrat[0].asset, sBTC);
        assertEq(bobStrat[0].asset,   sETH);
    }
}
