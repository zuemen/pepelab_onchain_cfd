// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice P1 fairness while a market is stopped: funding and borrow fees do
///         not accrue over paused / Halted time, deposits stay open during a
///         pause, liquidations wait out a grace period after a pause or a
///         Halt, and a guardian pause lapses after 72 hours.
contract ExchangeDowntimeTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address guardian   = makeAddr("guardian");
    address user       = makeAddr("user");
    address other      = makeAddr("other");
    address liquidator = makeAddr("liquidator");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");

    PerpetualExchange.AssetMode constant ACTIVE = PerpetualExchange.AssetMode.Active;
    PerpetualExchange.AssetMode constant HALTED = PerpetualExchange.AssetMode.Halted;

    event PauseExpiryCleared(address indexed by);

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(10); // 0.10%/h on the borrowed notional
        exchange.setGuardian(guardian);

        usdc.mint(address(exchange), 1_000_000e18);
        address[2] memory who = [user, other];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 100_000e18);
            vm.startPrank(who[i]);
            usdc.approve(address(exchange), type(uint256).max);
            exchange.depositMargin(50_000e18);
            vm.stopPrank();
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _warpBy(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    /// Advances time and refreshes both feeds at their current price.
    function _elapse(uint256 secs) internal {
        _warpBy(secs);
        (uint256 b,) = oracle.getPrice(BTC);
        (uint256 e,) = oracle.getPrice(ETH);
        oracle.updatePrice(BTC, b);
        oracle.updatePrice(ETH, e);
    }

    function _open(address who, bytes32 asset, bool isLong, uint256 margin) internal returns (uint256) {
        vm.prank(who);
        return exchange.openPosition(asset, isLong, margin, 5);
    }

    /// Opens an imbalanced BTC book (longs pay) and returns the payer charge
    /// of one funding interval.
    function _imbalancedBook() internal returns (int256 perInterval) {
        _open(user, BTC, true, 2_000e18);
        _open(other, BTC, false, 1_000e18);
        perInterval = int256(24 * 1e14); // |rate| = 75 bps × (5k/15k) = 24 bps
    }

    function _closeValue(uint256 id) internal returns (uint256) {
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.closePosition(id);
        return exchange.freeMargin(user) - before;
    }

    function _grace(bytes32 asset, uint256 until) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PerpetualExchange.GracePeriodActive.selector, asset, until);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Funding freezes during a global pause
    // ═════════════════════════════════════════════════════════════════════════

    function test_pause_fundingDoesNotAccrueWhilePaused() public {
        int256 one = _imbalancedBook();
        _elapse(8 hours);
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), one);

        exchange.pause(); // owner pause: no expiry
        _elapse(10 days);
        exchange.unpause();

        // Right after the pause no further interval is owed…
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), one);
        // …and one active interval later exactly one more accrues.
        _elapse(8 hours);
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), 2 * one);
    }

    /// A pause in the middle of an interval: only the active time counts.
    function test_pause_midIntervalCountsOnlyActiveTime() public {
        int256 one = _imbalancedBook();
        _elapse(6 hours);
        exchange.pause();
        _elapse(10 days);
        exchange.unpause();
        _elapse(1 hours);          // 7h active: not yet an interval
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), 0);
        _elapse(1 hours);          // 8h active
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), one);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Borrow fee excludes paused and Halted time
    // ═════════════════════════════════════════════════════════════════════════

    // 1,000 margin at 5x borrows 4,000; 10 bps/h = 4 USDC per active hour.

    function test_borrowFee_excludesPausedTime() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _elapse(2 hours);
        exchange.pause();
        _elapse(10 hours);
        exchange.unpause();
        assertEq(_closeValue(id), 1_000e18 - 8e18); // 2 active hours
    }

    function test_borrowFee_excludesHaltedTime() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _elapse(3 hours);
        exchange.setAssetMode(BTC, HALTED);
        _elapse(20 hours);
        exchange.setAssetMode(BTC, ACTIVE);
        _elapse(1 hours);
        assertEq(_closeValue(id), 1_000e18 - 16e18); // 4 active hours
    }

    /// Pause [1h,4h] and Halt [2h,5h] overlap: downtime is their union (4h),
    /// never the 6h sum.
    function test_borrowFee_overlappingPauseAndHaltCountedOnce() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        uint256 downAtOpen = exchange.downtimeOf(BTC);
        _elapse(1 hours);
        exchange.pause();
        _elapse(1 hours);
        vm.prank(guardian);
        exchange.setAssetMode(BTC, HALTED);
        _elapse(2 hours);
        exchange.unpause();
        _elapse(1 hours);
        exchange.setAssetMode(BTC, ACTIVE);
        _elapse(3 hours);
        assertEq(exchange.downtimeOf(BTC) - downAtOpen, 4 hours);
        assertEq(_closeValue(id), 1_000e18 - 16e18); // 8h elapsed - 4h down
    }

    function test_borrowFee_otherAssetHaltDoesNotApply() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.setAssetMode(ETH, HALTED);
        _elapse(2 hours);
        assertEq(_closeValue(id), 1_000e18 - 8e18);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Deposits during a pause; grace period after it
    // ═════════════════════════════════════════════════════════════════════════

    function test_pause_depositAllowed_withdrawRefused() public {
        exchange.pause();
        vm.prank(user);
        exchange.depositMargin(1_000e18);
        vm.prank(user);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.withdrawMargin(1e18);
    }

    function test_unpause_gracePeriodRefusesLiquidationOpenAndWithdraw() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.pause();
        _elapse(1 hours);
        oracle.updatePrice(BTC, 80_000e8); // reopening print puts the long underwater
        exchange.unpause();
        uint256 until = vm.getBlockTimestamp() + exchange.LIQUIDATION_GRACE_PERIOD();

        vm.prank(liquidator);
        vm.expectRevert(_grace(bytes32(0), until));
        exchange.liquidatePosition(id);

        vm.prank(other);
        vm.expectRevert(_grace(bytes32(0), until));
        exchange.openPosition(ETH, true, 1_000e18, 5);

        vm.prank(other);
        vm.expectRevert(_grace(bytes32(0), until));
        exchange.withdrawMargin(1e18);

        vm.prank(user); // the trader can still top up and exit
        exchange.depositMargin(1_000e18);

        _warpBy(exchange.LIQUIDATION_GRACE_PERIOD());
        vm.prank(liquidator);
        exchange.liquidatePosition(id);
        assertFalse(exchange.getPosition(id).isOpen);
    }

    function test_unpause_closeAllowedDuringGrace() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.pause();
        exchange.unpause();
        vm.prank(user);
        exchange.closePosition(id);
    }

    function test_haltLift_gracePeriodIsPerAsset() public {
        uint256 btcId = _open(user, BTC, true, 1_000e18);
        uint256 ethId = _open(user, ETH, true, 1_000e18);
        exchange.setAssetMode(BTC, HALTED);
        oracle.updatePrice(BTC, 80_000e8);
        oracle.updatePrice(ETH, 3_200e8);
        exchange.setAssetMode(BTC, ACTIVE);
        uint256 until = vm.getBlockTimestamp() + exchange.LIQUIDATION_GRACE_PERIOD();

        vm.expectRevert(_grace(BTC, until));
        exchange.liquidatePosition(btcId);
        vm.prank(other);
        vm.expectRevert(_grace(BTC, until));
        exchange.openPosition(BTC, true, 1_000e18, 5);

        exchange.liquidatePosition(ethId);          // other markets unaffected
        _open(other, ETH, true, 1_000e18);
        vm.prank(user);
        exchange.withdrawMargin(1e18);              // no global grace

        _warpBy(exchange.LIQUIDATION_GRACE_PERIOD());
        exchange.liquidatePosition(btcId);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Guardian pause expiry
    // ═════════════════════════════════════════════════════════════════════════

    function test_guardianPause_lapsesAfter72Hours() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        vm.prank(guardian);
        exchange.pause();
        uint256 expiry = vm.getBlockTimestamp() + exchange.GUARDIAN_PAUSE_DURATION();
        assertEq(exchange.pauseExpiresAt(), expiry);

        _elapse(72 hours - 1);
        assertTrue(exchange.paused());
        _elapse(1);
        assertFalse(exchange.paused());

        vm.prank(user);
        exchange.closePosition(id);
        // Grace runs from the lapse, like an explicit unpause.
        vm.prank(other);
        vm.expectRevert(_grace(bytes32(0), expiry + exchange.LIQUIDATION_GRACE_PERIOD()));
        exchange.openPosition(BTC, true, 1_000e18, 5);
    }

    function test_guardianPause_cannotBeExtendedByGuardian() public {
        vm.prank(guardian);
        exchange.pause();
        _elapse(71 hours);
        vm.prank(guardian);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.pause();
        assertEq(exchange.pauseExpiresAt(), vm.getBlockTimestamp() + 1 hours);
    }

    function test_guardianPause_ownerTakesOver_noExpiry() public {
        vm.prank(guardian);
        exchange.pause();
        vm.expectEmit(true, false, false, false, address(exchange));
        emit PauseExpiryCleared(address(this));
        exchange.pause();
        assertEq(exchange.pauseExpiresAt(), 0);
        _elapse(30 days);
        assertTrue(exchange.paused());
    }

    function test_ownerPause_neverLapses_andCannotBeDoubled() public {
        exchange.pause();
        assertEq(exchange.pauseExpiresAt(), 0);
        _elapse(365 days);
        assertTrue(exchange.paused());
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.pause();
        vm.prank(guardian);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.pause();
    }

    function test_guardianPause_afterLapse_unpauseRevertsAndPausedTimeIsBounded() public {
        vm.prank(guardian);
        exchange.pause();
        _elapse(100 hours);
        vm.expectRevert(PerpetualExchange.ExpectedPause.selector);
        exchange.unpause();
        assertEq(exchange.downtimeOf(BTC), 72 hours);
        vm.prank(guardian); // a fresh pause starts a fresh window
        exchange.pause();
        _elapse(1 hours);
        assertEq(exchange.downtimeOf(BTC), 73 hours);
    }
}
