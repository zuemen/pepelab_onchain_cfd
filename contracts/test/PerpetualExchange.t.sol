// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract PerpetualExchangeTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address owner       = address(this);
    address alice       = makeAddr("alice");
    address bob         = makeAddr("bob");
    address tracker     = makeAddr("tracker");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");

    // Use 100_000e8 so that size = notional * 1e18 / entryPrice divides exactly (no rounding)
    // e.g. 100e18 * 1e18 / 100_000e18 = 1e15 (exact), avoiding off-by-dust assertions
    uint256 constant BTC_PRICE = 100_000e8;
    uint256 constant ETH_PRICE =   3_000e8;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));

        oracle.addAsset(BTC, BTC_PRICE);
        oracle.addAsset(ETH, ETH_PRICE);

        usdc.mint(alice,            100_000e18);
        usdc.mint(bob,              100_000e18);
        usdc.mint(tracker,          100_000e18);
        // protocol reserves so profitable positions can be paid out
        usdc.mint(address(exchange), 1_000_000e18);

        vm.prank(alice);   usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);     usdc.approve(address(exchange), type(uint256).max);
        vm.prank(tracker); usdc.approve(address(exchange), type(uint256).max);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        exchange.depositMargin(amount);
    }

    function _open(address user, bytes32 asset, bool isLong, uint256 margin, uint256 lev)
        internal returns (uint256)
    {
        vm.prank(user);
        return exchange.openPosition(asset, isLong, margin, lev);
    }

    function _close(address user, uint256 pid) internal {
        vm.prank(user);
        exchange.closePosition(pid);
    }

    // ── 1. depositMargin / withdrawMargin ────────────────────────────────────

    function test_depositMargin_updatesFreeMargin() public {
        _deposit(alice, 1_000e18);
        assertEq(exchange.freeMargin(alice), 1_000e18);
    }

    function test_withdrawMargin_transfersUSDC() public {
        _deposit(alice, 1_000e18);
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        exchange.withdrawMargin(600e18);
        assertEq(exchange.freeMargin(alice),  400e18);
        assertEq(usdc.balanceOf(alice), balBefore + 600e18);
    }

    function test_withdrawMargin_revertsIfInsufficient() public {
        _deposit(alice, 50e18);
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InsufficientFreeMargin.selector);
        exchange.withdrawMargin(51e18);
    }

    // ── 2. openPosition – long, entryPrice locked correctly ─────────────────

    function test_openPosition_long_entryPrice() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.entryPrice, BTC_PRICE * 1e10);   // 8-dec → 18-dec
        assertEq(pos.margin,     100e18);
        assertEq(pos.leverage,   1);
        assertTrue(pos.isLong);
        assertTrue(pos.isOpen);
        assertEq(pos.owner, alice);
    }

    // ── 3. openPosition – short ──────────────────────────────────────────────

    function test_openPosition_short() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, false, 100e18, 2);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertFalse(pos.isLong);
        assertEq(pos.leverage, 2);
        assertEq(exchange.freeMargin(alice), 400e18);
    }

    // ── 4. closePosition – price up, long profits ────────────────────────────
    // BTC: 100 000 → 110 000 (+10%)
    // margin=100e18, lev=1 → notional=100e18
    // size = 100e18 * 1e18 / 100_000e18 = 1e15 (exact, no rounding)
    // pnl = 10_000e18 * 1e15 / 1e18 = 10e18

    function test_closePosition_longProfit() public {
        _deposit(alice, 1_000e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        uint256 marginBefore = exchange.freeMargin(alice); // 900e18
        _close(alice, pid);

        assertEq(exchange.freeMargin(alice), marginBefore + 110e18);
    }

    // ── 5. closePosition – price up, short loses ─────────────────────────────

    function test_closePosition_shortLoss() public {
        _deposit(alice, 1_000e18);
        uint256 pid = _open(alice, BTC, false, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        uint256 marginBefore = exchange.freeMargin(alice);
        _close(alice, pid);

        assertEq(exchange.freeMargin(alice), marginBefore + 90e18);
    }

    // ── 6. closePosition – price down, short profits ──────────────────────────

    function test_closePosition_shortProfit() public {
        _deposit(alice, 1_000e18);
        uint256 pid = _open(alice, BTC, false, 100e18, 1);

        oracle.updatePrice(BTC, 90_000e8);   // -10 %

        uint256 marginBefore = exchange.freeMargin(alice);
        _close(alice, pid);

        assertEq(exchange.freeMargin(alice), marginBefore + 110e18);
    }

    // ── 7. 2× leverage PnL is double of 1× ───────────────────────────────────
    // 1x: size=1e15, pnl=10_000e18*1e15/1e18 = 10e18
    // 2x: size=2e15, pnl=10_000e18*2e15/1e18 = 20e18

    function test_leverage2x_doublesProfit() public {
        _deposit(alice, 1_000e18);
        uint256 pid1 = _open(alice, BTC, true, 100e18, 1);
        uint256 pid2 = _open(alice, BTC, true, 100e18, 2);

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        uint256 before1 = exchange.freeMargin(alice);
        _close(alice, pid1);
        uint256 after1 = exchange.freeMargin(alice);

        uint256 before2 = exchange.freeMargin(alice);
        _close(alice, pid2);
        uint256 after2 = exchange.freeMargin(alice);

        uint256 profit1 = (after1 - before1) - 100e18;  // 10e18
        uint256 profit2 = (after2 - before2) - 100e18;  // 20e18

        assertEq(profit2, profit1 * 2);
    }

    // ── 8. severe price drop – closeAmount clamped to 0 ──────────────────────
    // 5× long, price -50 %: loss = 2.5× margin → clamped to 0
    // size = 500e18 * 1e18 / 100_000e18 = 5e15
    // pnl = -50_000e18 * 5e15 / 1e18 = -250e18

    function test_closePosition_clampedToZero() public {
        _deposit(alice, 1_000e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 5);

        oracle.updatePrice(BTC, 50_000e8);   // -50 % (at MockOracle ±50 % limit)

        uint256 marginBefore = exchange.freeMargin(alice);  // 900e18
        _close(alice, pid);

        assertEq(exchange.freeMargin(alice), marginBefore);   // got 0 back

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.realizedPnL, -int256(250e18));
    }

    // ── 9. leverage > 5 reverts ───────────────────────────────────────────────

    function test_openPosition_revertsOnLeverageAboveMax() public {
        _deposit(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(BTC, true, 100e18, 6);
    }

    function test_openPosition_revertsOnLeverageZero() public {
        _deposit(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(BTC, true, 100e18, 0);
    }

    // ── 10. margin < MIN_MARGIN reverts ──────────────────────────────────────

    function test_openPosition_revertsOnLowMargin() public {
        _deposit(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.MarginTooLow.selector);
        exchange.openPosition(BTC, true, 9e18, 1);
    }

    // ── 11. openPositionFor – copyTracker not set → revert ───────────────────

    function test_openPositionFor_revertsWhenCopyTrackerNotSet() public {
        _deposit(alice, 500e18);
        vm.prank(tracker);
        vm.expectRevert(PerpetualExchange.CopyTrackerNotSet.selector);
        exchange.openPositionFor(alice, BTC, true, 100e18, 1);
    }

    function test_openPositionFor_revertsForNonTracker() public {
        exchange.setCopyTracker(tracker);
        _deposit(alice, 500e18);
        vm.prank(alice);   // alice is not the copyTracker
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        exchange.openPositionFor(alice, BTC, true, 100e18, 1);
    }

    function test_openPositionFor_success() public {
        exchange.setCopyTracker(tracker);
        _deposit(alice, 500e18);

        vm.prank(tracker);
        uint256 pid = exchange.openPositionFor(alice, BTC, true, 100e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        assertEq(exchange.freeMargin(alice), 400e18);
    }

    // ── 12. multiple positions settle independently ───────────────────────────

    function test_multiplePositions_independentSettlement() public {
        _deposit(alice, 1_000e18);

        uint256 longPid  = _open(alice, BTC, true,  100e18, 1);
        uint256 shortPid = _open(alice, BTC, false, 100e18, 1);
        // freeMargin = 800e18

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        _close(alice, longPid);   // +10e18 → 110e18 back
        _close(alice, shortPid);  // -10e18 →  90e18 back

        // net PnL = 0 → back to 1000e18
        assertEq(exchange.freeMargin(alice), 1_000e18);
    }

    function test_multiplePositions_twoUsers_isolated() public {
        _deposit(alice, 500e18);
        _deposit(bob,   500e18);

        uint256 aPid = _open(alice, BTC, true,  100e18, 1);
        uint256 bPid = _open(bob,   BTC, false, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        _close(alice, aPid);  // +10e18
        _close(bob,   bPid);  // -10e18

        assertEq(exchange.freeMargin(alice), 400e18 + 110e18);
        assertEq(exchange.freeMargin(bob),   400e18 +  90e18);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function test_getUnrealizedPnL_openPosition() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);  // +10 %

        int256 pnl = exchange.getUnrealizedPnL(pid);
        assertEq(pnl, 10e18);
    }

    function test_getPositionValue_openPosition() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);

        assertEq(exchange.getPositionValue(pid), 110e18);
    }

    function test_getUserPositions_tracksAll() public {
        _deposit(alice, 1_000e18);
        _open(alice, BTC, true,  100e18, 1);
        _open(alice, ETH, false, 100e18, 2);

        uint256[] memory ids = exchange.getUserPositions(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], 0);
        assertEq(ids[1], 1);
    }

    function test_closePosition_revertsIfNotOwner() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);

        vm.prank(bob);
        vm.expectRevert(PerpetualExchange.NotPositionOwner.selector);
        exchange.closePosition(pid);
    }

    function test_closePosition_revertsIfAlreadyClosed() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1);
        _close(alice, pid);

        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.PositionAlreadyClosed.selector);
        exchange.closePosition(pid);
    }

    function test_depositMarginFor_success() public {
        exchange.setCopyTracker(tracker);

        vm.prank(tracker);
        exchange.depositMarginFor(alice, 200e18);

        assertEq(exchange.freeMargin(alice), 200e18);
    }

    function test_depositMarginFor_revertsForNonTracker() public {
        exchange.setCopyTracker(tracker);
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        exchange.depositMarginFor(alice, 200e18);
    }
}
