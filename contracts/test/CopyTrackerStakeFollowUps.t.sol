// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TraderStake.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev A stake contract whose `slash` reports success but moves only part
///      of the requested USDC (fee-on-transfer, buggy or partial
///      implementation). Stands in for "the nominal amount did not arrive".
contract ShortPayingStake {
    MockUSDC public immutable usdc;
    uint256 public immutable payBps;
    constructor(MockUSDC u, uint256 bps) { usdc = u; payBps = bps; }
    function isEligible(address) external pure returns (bool) { return true; }
    function stakedAmount(address) external pure returns (uint256) { return 1_000e18; }
    function slash(address, uint256 amount, address recipient) external {
        usdc.transfer(recipient, amount * payBps / 10_000);
    }
}

/// @notice Follow-ups to PR #191: M2 (unstake request), M10 (version-pinned
///         follow) and the Low items (balance-delta slash reserve, no
///         renounce, follower margin independent of the slash outcome).
contract CopyTrackerStakeFollowUpsTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    TraderStake       ts;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;

    address alice = makeAddr("alice");  // trader
    address bob   = makeAddr("bob");    // follower

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(ts));

        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 1_000e8);

        usdc.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(500e18);
        registry.registerTrader("Alice");
        registry.publishStrategy(_allocs(true));
        vm.stopPrank();

        usdc.mint(bob, 100_000e18);
        usdc.mint(address(exchange), 200_000e18);
        vm.prank(bob); usdc.approve(address(ct), type(uint256).max);
    }

    function _allocs(bool btcLong) internal pure returns (StrategyRegistry.Allocation[] memory a) {
        a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, btcLong, 2);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
    }

    function _followAndLose40() internal {
        vm.prank(bob); ct.followTrader(alice, 1_000e18);
        oracle.updatePrice(BTC, 60_000e8);   // 40% down at 2x on 500 → −400 of 1,000 deployed
    }

    // ── M2: a pending unstake stays slashable ──────────────────────────────

    function test_M2_requestedStakeIsStillSlashed() public {
        _followAndLose40();
        vm.prank(alice); ts.requestUnstake(500e18);   // try to pull the whole stake out first

        vm.prank(bob); ct.unfollowAndCloseAll(0);
        assertEq(ct.slashReserve(), 200e18, "50% of the 400 loss, capped at 250");
        assertEq(ts.stakedAmount(alice), 300e18, "slash came out of the requested stake");

        vm.warp(block.timestamp + ts.UNSTAKE_COOLDOWN());
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); ts.executeUnstake();
        assertEq(usdc.balanceOf(alice) - before, 300e18, "only what survived the slash is paid out");
    }

    // ── M2: requesting an unstake forfeits eligibility ─────────────────────

    function test_M2_pendingUnstakeForfeitsEligibility() public {
        assertTrue(ts.isEligible(alice));
        vm.prank(alice); ts.requestUnstake(1e18);    // even a sliver
        assertFalse(ts.isEligible(alice), "pending request -> not eligible");
        assertFalse(registry.isEligibleTrader(alice));

        vm.prank(alice);
        vm.expectRevert(StrategyRegistry.InsufficientStake.selector);
        registry.publishStrategy(_allocs(false));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.TraderNotEligible.selector, alice));
        ct.followTrader(alice, 1_000e18);

        vm.prank(alice); ts.cancelUnstake();
        assertTrue(ts.isEligible(alice), "cancel restores eligibility");
        vm.prank(bob); ct.followTrader(alice, 1_000e18);
    }

    function test_M2_existingFollowerCanStillExitAfterRequest() public {
        vm.prank(bob); ct.followTrader(alice, 1_000e18);
        vm.prank(alice); ts.requestUnstake(500e18);
        vm.prank(bob); ct.unfollowAndCloseAll(0);   // no new-follow gate on the way out
        assertFalse(ct.getCopyRecords(bob)[0].active);
    }

    // ── M10: version-pinned follow ─────────────────────────────────────────

    function test_M10_followAtCurrentVersionSucceeds() public {
        (, uint256 v) = registry.getLatestStrategy(alice);
        vm.prank(bob); ct.followTraderAtVersion(alice, 1_000e18, v);
        assertEq(ct.getCopyRecords(bob)[0].versionId, v);
        assertTrue(exchange.getPosition(ct.getCopyRecords(bob)[0].positionIds[0]).isLong);
    }

    function test_M10_republishBetweenReviewAndFollowReverts() public {
        (, uint256 reviewed) = registry.getLatestStrategy(alice);

        // Trader flips BTC to short in the same block, ahead of the follower.
        vm.prank(alice); registry.publishStrategy(_allocs(false));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.StrategyVersionMismatch.selector, reviewed, reviewed + 1));
        ct.followTraderAtVersion(alice, 1_000e18, reviewed);

        // The unpinned entry point copies whatever is latest — the documented risk.
        vm.prank(bob); ct.followTrader(alice, 1_000e18);
        assertFalse(exchange.getPosition(ct.getCopyRecords(bob)[0].positionIds[0]).isLong);
    }

    // ── Low: slash reserve books what arrived, not what was asked ──────────

    function test_slashReserveCountsReceivedUsdcOnly() public {
        ShortPayingStake shortStake = new ShortPayingStake(usdc, 6_000);   // pays 60%
        usdc.mint(address(shortStake), 1_000e18);
        StrategyRegistry reg2 = new StrategyRegistry(address(shortStake));
        CopyTracker ct2 = new CopyTracker(address(usdc), address(exchange), address(reg2), address(0), address(shortStake));
        exchange.setCopyTracker(address(ct2));   // only the primary tracker may set copiedFrom

        vm.prank(alice); reg2.registerTrader("Alice");
        vm.prank(alice); reg2.publishStrategy(_allocs(true));
        vm.prank(bob); usdc.approve(address(ct2), type(uint256).max);
        vm.prank(bob); ct2.followTrader(alice, 1_000e18);
        oracle.updatePrice(BTC, 60_000e8);

        vm.prank(bob); ct2.unfollowAndCloseAll(0);
        assertEq(ct2.slashReserve(), 120e18, "60% of the 200 requested");
        assertEq(ct2.slashReserve(), usdc.balanceOf(address(ct2)), "reserve fully backed");

        ct2.withdrawSlashReserve(address(this), ct2.slashReserve());   // does not revert
        assertEq(ct2.slashReserve(), 0);
    }

    // ── Low: ownership cannot be renounced ─────────────────────────────────

    function test_renounceOwnershipReverts() public {
        vm.expectRevert(CopyTracker.RenounceOwnershipDisabled.selector);
        ct.renounceOwnership();
        assertEq(ct.owner(), address(this));

        address tl = makeAddr("timelock");
        ct.transferOwnership(tl);   // transfer still works
        assertEq(ct.owner(), tl);
    }

    // ── Low: the follower's margin does not depend on the slash outcome ────

    function test_followerFreeMarginSameWhetherSlashSucceedsOrFails() public {
        _followAndLose40();
        uint256 snap = vm.snapshotState();

        // (a) slash succeeds
        vm.prank(bob); ct.unfollowAndCloseAll(0);
        uint256 freeWithSlash = exchange.freeMargin(bob);
        assertEq(ct.slashReserve(), 200e18, "slash landed");

        vm.revertToState(snap);

        // (b) slash refused: TraderStake no longer recognises this tracker
        ts.setCopyTracker(makeAddr("otherTracker"));
        vm.expectEmit(true, true, false, true, address(ct));
        emit CopyTracker.SlashFailed(alice, bob, 200e18);
        vm.prank(bob); ct.unfollowAndCloseAll(0);
        uint256 freeWithoutSlash = exchange.freeMargin(bob);
        assertEq(ct.slashReserve(), 0, "slash refused");

        assertEq(freeWithSlash, freeWithoutSlash, "follower margin independent of the slash outcome");
        assertGt(freeWithSlash, 0);
    }
}
