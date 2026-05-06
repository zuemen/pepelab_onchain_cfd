// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract CopyTrackerTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;

    address owner = address(this);
    address alice = makeAddr("alice");   // trader
    address bob   = makeAddr("bob");     // follower
    address carol = makeAddr("carol");   // second follower

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");

    // Clean prices: size = notional*1e18/entryPrice has no remainder
    // BTC 100_000e8 → entryPrice 100_000e18; 600e18*1e18/100_000e18 = 6e15 (exact)
    // ETH   4_000e8 → entryPrice   4_000e18; 400e18*2*1e18/4_000e18 = 2e17 (exact)
    uint256 constant BTC_PRICE = 100_000e8;
    uint256 constant ETH_PRICE =   4_000e8;

    // Strategy: 60% BTC long 1×, 40% ETH short 2×
    StrategyRegistry.Allocation[] baseAllocs;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        registry = new StrategyRegistry();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry));

        // CRITICAL: authorise CopyTracker on exchange
        exchange.setCopyTracker(address(ct));

        oracle.addAsset(BTC, BTC_PRICE);
        oracle.addAsset(ETH, ETH_PRICE);

        // Register alice and publish strategy
        vm.prank(alice);
        registry.registerTrader("Alice");

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](2);
        allocs[0] = StrategyRegistry.Allocation(BTC, 6_000, true,  1);
        allocs[1] = StrategyRegistry.Allocation(ETH, 4_000, false, 2);
        vm.prank(alice);
        registry.publishStrategy(allocs);

        // Fund followers
        usdc.mint(bob,   100_000e18);
        usdc.mint(carol, 100_000e18);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _follow(address follower, uint256 amount) internal {
        vm.startPrank(follower);
        usdc.approve(address(ct), type(uint256).max);
        ct.followTrader(alice, amount);
        vm.stopPrank();
    }

    function _record(address follower, uint256 idx) internal view returns (CopyTracker.CopyRecord memory) {
        return ct.getCopyRecords(follower)[idx];
    }

    // ── Test 1: position count matches allocation count ───────────────────────

    function test_followTrader_positionCountMatchesAllocations() public {
        _follow(bob, 1_000e18);

        CopyTracker.CopyRecord memory rec = _record(bob, 0);
        assertEq(rec.positionIds.length, 2);   // 2 allocations → 2 positions
        assertTrue(rec.active);
        assertEq(rec.trader, alice);
    }

    // ── Test 2: margin proportions match weights ───────────────────────────────

    function test_followTrader_marginProportions() public {
        _follow(bob, 1_000e18);

        CopyTracker.CopyRecord memory rec = _record(bob, 0);
        PerpetualExchange.Position memory btcPos = exchange.getPosition(rec.positionIds[0]);
        PerpetualExchange.Position memory ethPos = exchange.getPosition(rec.positionIds[1]);

        // 60 % of 1 000e18 = 600e18 ; 40 % = 400e18
        assertEq(btcPos.margin, 600e18);
        assertEq(ethPos.margin, 400e18);
        assertEq(btcPos.leverage, 1);
        assertEq(ethPos.leverage, 2);
    }

    // ── Test 3: entryPrice locked at oracle price at open time ────────────────

    function test_followTrader_entryPriceLockedAtCurrentOraclePrice() public {
        _follow(bob, 1_000e18);

        CopyTracker.CopyRecord memory rec = _record(bob, 0);
        PerpetualExchange.Position memory btcPos = exchange.getPosition(rec.positionIds[0]);
        PerpetualExchange.Position memory ethPos = exchange.getPosition(rec.positionIds[1]);

        assertEq(btcPos.entryPrice, BTC_PRICE * 1e10);   // 100_000e18
        assertEq(ethPos.entryPrice, ETH_PRICE * 1e10);   //   4_000e18
    }

    // ── Test 4: followTrader without USDC approval reverts ────────────────────

    function test_followTrader_revertsWithoutUSDCApproval() public {
        vm.prank(bob);
        vm.expectRevert();   // ERC20InsufficientAllowance
        ct.followTrader(alice, 1_000e18);
    }

    // ── Test 5: unfollow closes all positions and returns margin ──────────────

    function test_unfollowAndCloseAll_closesPositionsAndRestoresFreeMargin() public {
        _follow(bob, 1_000e18);

        // No price change → pnl = 0 → full margin returned
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);

        // Record marked inactive
        assertFalse(_record(bob, 0).active);

        // freeMargin: 600e18 + 400e18 = 1000e18
        assertEq(exchange.freeMargin(bob), 1_000e18);

        // Positions are marked closed on exchange
        CopyTracker.CopyRecord memory rec = ct.getCopyRecords(bob)[0];
        assertFalse(exchange.getPosition(rec.positionIds[0]).isOpen);
        assertFalse(exchange.getPosition(rec.positionIds[1]).isOpen);
    }

    // ── Additional cases ─────────────────────────────────────────────────────

    function test_followTrader_positionsOwnedByFollower() public {
        _follow(bob, 1_000e18);

        CopyTracker.CopyRecord memory rec = _record(bob, 0);
        assertEq(exchange.getPosition(rec.positionIds[0]).owner, bob);
        assertEq(exchange.getPosition(rec.positionIds[1]).owner, bob);
    }

    function test_followTrader_directionsMirrorStrategy() public {
        _follow(bob, 1_000e18);

        CopyTracker.CopyRecord memory rec = _record(bob, 0);
        assertTrue(exchange.getPosition(rec.positionIds[0]).isLong);    // BTC long
        assertFalse(exchange.getPosition(rec.positionIds[1]).isLong);   // ETH short
    }

    function test_getFollowerCount_incrementsOnFollow() public {
        assertEq(ct.getFollowerCount(alice), 0);
        _follow(bob,   1_000e18);
        assertEq(ct.getFollowerCount(alice), 1);
        _follow(carol, 500e18);
        assertEq(ct.getFollowerCount(alice), 2);
    }

    function test_unfollowAndCloseAll_revertsOnAlreadyInactive() public {
        _follow(bob, 1_000e18);
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);

        vm.prank(bob);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.unfollowAndCloseAll(0);
    }

    function test_unfollowAndCloseAll_revertsOnInvalidIndex() public {
        _follow(bob, 1_000e18);

        vm.prank(bob);
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.unfollowAndCloseAll(5);
    }

    function test_unfollowAndCloseAll_withPriceChangeReturnsPnL() public {
        _follow(bob, 1_000e18);

        // BTC +10 %: BTC position PnL = 60e18 (600e18 * 10 %)
        oracle.updatePrice(BTC, 110_000e8);

        vm.prank(bob);
        ct.unfollowAndCloseAll(0);

        // ETH price unchanged → ethPos PnL = 0
        // BTC closeAmount = 600e18 + 60e18 = 660e18
        // ETH closeAmount = 400e18
        assertEq(exchange.freeMargin(bob), 660e18 + 400e18);
    }

    function test_followTrader_versionIdRecorded() public {
        _follow(bob, 1_000e18);
        // alice published one strategy → versionId = 0
        assertEq(_record(bob, 0).versionId, 0);
    }

    function test_multipleFollowsSameTrader_independentRecords() public {
        _follow(bob, 1_000e18);
        _follow(bob,   500e18);

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        assertEq(recs.length, 2);
        assertEq(recs[0].initialAmount, 1_000e18);
        assertEq(recs[1].initialAmount,   500e18);

        // Close first record only
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);

        assertFalse(ct.getCopyRecords(bob)[0].active);
        assertTrue(ct.getCopyRecords(bob)[1].active);
    }

    function test_withdrawAfterUnfollow_returnsUSDC() public {
        uint256 balBefore = usdc.balanceOf(bob);
        _follow(bob, 1_000e18);

        vm.prank(bob);
        ct.unfollowAndCloseAll(0);

        // freeMargin = 1000e18; withdraw it all
        vm.prank(bob);
        exchange.withdrawMargin(1_000e18);

        assertEq(usdc.balanceOf(bob), balBefore);  // got everything back
    }
}
