// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TraderStake.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/AgentSessionManager.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/InsuranceVault.sol";

/// @notice Slash scoring on unfollow is taken from the exchange's per-position
///         records (realized PnL + close reason), never from the follower's
///         free-margin delta, and cannot be steered by which legs the
///         follower closes themselves.
contract CopyTrackerScoringTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    TraderStake       ts;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;
    InsuranceVault    vault;

    address alice = makeAddr("alice"); // trader
    address bob   = makeAddr("bob");   // follower

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    event SlashScoringWaived(address indexed follower, uint256 indexed recordIdx);
    event RecordDeactivatedWithoutScoring(address indexed follower, uint256 indexed recordIdx);
    event TraderSlashed(address indexed trader, address indexed follower, uint256 slashAmount);

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(ts));
        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        // Slashed stake goes to the InsuranceVault, never to the follower.
        vault = new InsuranceVault(address(usdc));
        vault.setExchange(address(exchange));
        vault.setCopyTracker(address(ct));
        exchange.setInsuranceVault(address(vault));
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
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 2);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
        registry.publishStrategy(a);
        vm.stopPrank();

        usdc.mint(bob, 100_000e18);
        usdc.mint(address(exchange), 200_000e18);
        vm.prank(bob);
        usdc.approve(address(ct), type(uint256).max);

        vm.prank(bob);
        ct.followTrader(alice, 1_000e18); // BTC 500 @2x, ETH 300 @1x, SOL 200 @1x
    }

    function _ids() internal view returns (uint256[] memory) {
        return ct.getCopyRecords(bob)[0].positionIds;
    }

    function _selfClose(uint256 id) internal {
        vm.prank(bob);
        exchange.closePosition(id);
    }

    function _unfollow() internal {
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
    }

    // ── follower-closed legs waive scoring ──────────────────────────────────

    /// Closing every leg first and then unfollowing (flat market) used to score
    /// a 100% loss and pay the follower half of it from the trader's stake.
    function test_unfollow_ignoresPositionsClosedByOwner() public {
        uint256[] memory ids = _ids();
        for (uint256 i; i < ids.length; ++i) _selfClose(ids[i]);
        uint256 bobUsdc = usdc.balanceOf(bob);

        vm.expectEmit(true, true, false, false, address(ct));
        emit SlashScoringWaived(bob, 0);
        _unfollow();

        assertEq(ts.getStake(alice).amount, 500e18, "no slash");
        assertEq(usdc.balanceOf(bob), bobUsdc, "no payout");
        assertFalse(ct.getCopyRecords(bob)[0].active);
    }

    /// Self-closing the winning leg and leaving only losers to the tracker
    /// cannot manufacture a slash.
    function test_unfollow_selfClosingWinnersCannotTriggerSlash() public {
        uint256[] memory ids = _ids();
        oracle.updatePrice(BTC, 150_000e8); // BTC leg wins
        oracle.updatePrice(ETH, 1_000e8);   // ETH leg -75%
        oracle.updatePrice(SOL, 250e8);     // SOL leg -75%
        _selfClose(ids[0]);
        _unfollow();
        assertEq(ts.getStake(alice).amount, 500e18);
    }

    /// The reverse ordering (self-close losers, tracker closes winners) is
    /// equally inert — any follower-closed leg waives scoring.
    function test_unfollow_selfClosingLosersWaivesScoring() public {
        uint256[] memory ids = _ids();
        oracle.updatePrice(BTC, 60_000e8);  // -80% on the 2x leg
        _selfClose(ids[0]);
        _unfollow();
        assertEq(ts.getStake(alice).amount, 500e18);
    }

    // ── tracker-closed and forced legs are scored on realized PnL ──────────

    function test_unfollow_trackerClosedLoss_slashesOnRealizedPnl() public {
        oracle.updatePrice(BTC, 60_000e8);  // BTC -400 on 500 margin; others flat
        uint256 bobUsdc = usdc.balanceOf(bob);
        vm.expectEmit(true, true, false, true, address(ct));
        emit TraderSlashed(alice, bob, 200e18); // 50% of the 400 loss
        _unfollow();
        assertEq(ts.getStake(alice).amount, 300e18);
        assertEq(usdc.balanceOf(bob), bobUsdc, "slash is not paid to the follower");
        assertEq(vault.totalAssets(), 200e18, "it goes to the InsuranceVault");
    }

    function test_unfollow_flatMarketWithFees_noSlash() public {
        exchange.setTradingFeeBps(100); // fees are not the trader's loss
        exchange.setBorrowFeePerHour(10);
        vm.warp(vm.getBlockTimestamp() + 20 hours);
        oracle.updatePrice(BTC, 100_000e8);
        oracle.updatePrice(ETH, 4_000e8);
        oracle.updatePrice(SOL, 1_000e8);
        _unfollow();
        assertEq(ts.getStake(alice).amount, 500e18);
    }

    /// A liquidated leg is an outcome of the strategy, not a follower choice:
    /// it is scored (the case slashing exists for).
    function test_unfollow_liquidatedLegIsScored() public {
        uint256[] memory ids = _ids();
        oracle.updatePrice(BTC, 50_000e8); // 2x leg -100%
        exchange.liquidatePosition(ids[0]);
        oracle.updatePrice(BTC, 100_000e8);
        _unfollow(); // realized -500 on basis 1,000 = 50% -> slash 250
        assertEq(ts.getStake(alice).amount, 250e18);
    }

    /// Review scenario: the follower opens a large opposite BTC position to
    /// drag the mark 2% below index, tipping a 29% loss over the 30% trigger.
    /// The slash still fires — but it is paid to the InsuranceVault, so the
    /// follower gains nothing from forcing it.
    function test_unfollow_markPushedByFollowerHedge_slashNotPaidToFollower() public {
        exchange.setMarkPremiumCapBps(200);
        // Re-follow so the legs open with the premium configured (record 1).
        vm.prank(bob);
        ct.followTrader(alice, 1_000e18);

        oracle.updatePrice(BTC, 71_000e8); // index loss on the 2x BTC leg: 29%
        vm.startPrank(bob);
        usdc.approve(address(exchange), type(uint256).max);
        exchange.depositMargin(10_000e18);
        exchange.openPosition(BTC, false, 10_000e18, 5); // 50k short drags the mark
        vm.stopPrank();

        vm.prank(bob);
        ct.deactivateWithoutScoring(0); // the first record is not part of this scenario

        uint256 bobUsdc = usdc.balanceOf(bob);
        uint256 stakeBefore = ts.getStake(alice).amount;
        vm.prank(bob);
        ct.unfollowAndCloseAll(1);

        uint256 slashed = stakeBefore - ts.getStake(alice).amount;
        assertGt(slashed, 0, "the pushed mark did trip the trigger");
        assertEq(usdc.balanceOf(bob), bobUsdc, "the follower receives nothing from it");
        assertEq(vault.totalAssets(), slashed, "the pool does");
    }

    // ── exit for records the tracker cannot close ───────────────────────────

    function test_deactivateWithoutScoring_whenLegHalted() public {
        uint256[] memory ids = _ids();
        exchange.setAssetMode(BTC, PerpetualExchange.AssetMode.Halted);
        oracle.updatePrice(ETH, 1_000e8); // a loss that would otherwise score

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, ids[0]));
        ct.unfollowAndCloseAll(0);

        vm.expectEmit(true, true, false, false, address(ct));
        emit RecordDeactivatedWithoutScoring(bob, 0);
        vm.prank(bob);
        ct.deactivateWithoutScoring(0);

        assertFalse(ct.getCopyRecords(bob)[0].active);
        assertEq(ts.getStake(alice).amount, 500e18);
        assertTrue(exchange.getPosition(ids[0]).isOpen, "legs stay the follower's");
        _selfClose(ids[1]); // and remain closable directly
    }

    function test_deactivateWithoutScoring_afterTrackerReplaced() public {
        uint256[] memory ids = _ids();
        exchange.setCopyTracker(makeAddr("newTracker"));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, ids[0]));
        ct.unfollowAndCloseAll(0);
        vm.prank(bob);
        ct.deactivateWithoutScoring(0);
        assertFalse(ct.getCopyRecords(bob)[0].active);
    }

    function test_deactivateWithoutScoring_guards() public {
        vm.prank(bob);
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.deactivateWithoutScoring(1);

        vm.prank(alice); // not alice's record
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.deactivateWithoutScoring(0);

        vm.prank(bob);
        ct.deactivateWithoutScoring(0);
        vm.prank(bob);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.deactivateWithoutScoring(0);
        vm.prank(bob);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.unfollowAndCloseAll(0);
    }

    // ── exchange close reasons ──────────────────────────────────────────────

    function test_closeReason_recordedForEverySettlementPath() public {
        uint256[] memory ids = _ids();
        assertEq(uint8(exchange.closeReasonOf(ids[0])), uint8(PerpetualExchange.CloseReason.None));

        _selfClose(ids[1]);
        assertEq(uint8(exchange.closeReasonOf(ids[1])), uint8(PerpetualExchange.CloseReason.Owner));

        oracle.updatePrice(BTC, 50_000e8);
        exchange.liquidatePosition(ids[0]);
        assertEq(uint8(exchange.closeReasonOf(ids[0])), uint8(PerpetualExchange.CloseReason.Liquidated));

        _unfollow();
        assertEq(uint8(exchange.closeReasonOf(ids[2])), uint8(PerpetualExchange.CloseReason.Agent));
    }

    function test_closeReason_deleveragedCounterparty() public {
        exchange.setAdlEnabled(true);
        address other = makeAddr("other");
        usdc.mint(other, 10_000e18);
        vm.startPrank(other);
        usdc.approve(address(exchange), type(uint256).max);
        exchange.depositMargin(10_000e18);
        uint256 loser = exchange.openPosition(ETH, false, 1_000e18, 5);
        vm.stopPrank();
        uint256 ethLong = _ids()[1];
        oracle.updatePrice(ETH, 6_000e8); // short -2,500 on 1,000 -> shortfall 1,500
        exchange.liquidatePosition(loser);
        assertEq(uint8(exchange.closeReasonOf(ethLong)), uint8(PerpetualExchange.CloseReason.Deleveraged));
    }
}
