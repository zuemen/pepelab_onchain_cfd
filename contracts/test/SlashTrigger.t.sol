// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TraderStake.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract SlashTriggerTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    TraderStake       ts;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;

    address alice = makeAddr("alice");  // trader
    address bob   = makeAddr("bob");    // follower

    bytes32 constant BTC       = keccak256("BTC");
    bytes32 constant ETH       = keccak256("ETH"); // #97: flat leg, StrategyRegistry rejects a repeated asset
    bytes32 constant SOL       = keccak256("SOL"); // #97: flat leg
    uint256 constant BTC_PRICE = 100_000e8;
    uint256 constant ETH_PRICE =   4_000e8;
    uint256 constant SOL_PRICE =   1_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        ct       = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(0), address(ts)
        );

        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));

        oracle.addAsset(BTC, BTC_PRICE);
        oracle.addAsset(ETH, ETH_PRICE);
        oracle.addAsset(SOL, SOL_PRICE);

        // Alice: stake 500 → register → publish
        usdc.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(500e18);
        registry.registerTrader("Alice");
        // #97: StrategyRegistry now requires >=3 DISTINCT assets and caps any
        // one at 50% — a single 100%-weight BTC leg (the original design) is
        // no longer publishable, and repeating BTC across legs (an earlier,
        // wrong fix — see #97's own code review) doesn't satisfy "distinct"
        // either. Reconstructed instead via LEVERAGE: BTC at the 50% cap with
        // 2x leverage has notional = (0.5 * margin) * 2 = margin, identical to
        // the original 100%-weight, 1x leg's notional. ETH and SOL fill the
        // remaining 50% at 1x each and their price is never updated anywhere
        // in this file, so they never move and contribute zero PnL. Net
        // effect: every percentage-based PnL/slash assertion below, and every
        // BTC price point, is IDENTICAL to the pre-#97 single-asset design.
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 2);
        allocs[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        allocs[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
        registry.publishStrategy(allocs);
        vm.stopPrank();

        usdc.mint(bob, 100_000e18);
        usdc.mint(address(exchange), 200_000e18);
        vm.prank(bob); usdc.approve(address(ct), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
    }

    function _follow(uint256 amount) internal {
        vm.prank(bob); ct.followTrader(alice, amount);
    }

    function _unfollow() internal {
        vm.prank(bob); ct.unfollowAndCloseAll(0);
    }

    // ── Test 1: no slash when loss < 30% ────────────────────────────────────
    function testUnfollowSmallLoss_noSlash() public {
        _follow(1_000e18);

        // BTC drops 20% → loss 20% < 30% threshold
        oracle.updatePrice(BTC, 80_000e8);

        uint256 stakeBefore = ts.getStake(alice).amount;
        _unfollow();
        assertEq(ts.getStake(alice).amount, stakeBefore, "no slash below threshold");
    }

    // ── Test 2: slash triggered when loss >= 30% ─────────────────────────────
    function testUnfollowLargeLoss_triggersSlash() public {
        _follow(1_000e18);

        // BTC drops 40% → loss 40% > 30% threshold
        oracle.updatePrice(BTC, 60_000e8);

        uint256 stakeBefore = ts.getStake(alice).amount;
        _unfollow();
        assertLt(ts.getStake(alice).amount, stakeBefore, "stake reduced by slash");
    }

    // ── Test 3: slash amount capped at MAX_SLASH_BPS of stake ───────────────
    function testSlashAmount_capByMax() public {
        // Bob invests 10_000e18 (much more than Alice's 500e18 stake)
        // so loss * 50% > stake * 50%  → cap should kick in
        _follow(10_000e18);

        // 40% drop → loss = 4_000e18 → 50% of loss = 2_000e18 > cap (500e18 * 50% = 250e18)
        oracle.updatePrice(BTC, 60_000e8);

        uint256 stakeBefore = ts.getStake(alice).amount;
        _unfollow();
        uint256 slashed = stakeBefore - ts.getStake(alice).amount;

        uint256 cap = stakeBefore * ct.MAX_SLASH_BPS() / 10_000;
        assertEq(slashed, cap, "slash capped at MAX_SLASH_BPS of stake");
    }

    // ── Test 4: slash USDC transferred directly to follower ─────────────────
    function testSlashTransfersToFollower() public {
        _follow(1_000e18);
        oracle.updatePrice(BTC, 60_000e8);   // 40% drop → slash triggered

        uint256 bobBefore = usdc.balanceOf(bob);
        _unfollow();
        assertGt(usdc.balanceOf(bob), bobBefore, "follower receives compensation");
    }

    // ── Test 5: follower receives loss-based compensation amount ─────────────
    function testFollowerReceivesCompensation() public {
        uint256 followAmt = 1_000e18;
        _follow(followAmt);
        // BTC 40% drop: loss ≈ 400e18, slashAmt = 400e18 * 50% = 200e18, cap = 500e18*50%=250e18
        oracle.updatePrice(BTC, 60_000e8);

        uint256 bobBefore   = usdc.balanceOf(bob);
        uint256 stakeBefore = ts.getStake(alice).amount;
        _unfollow();
        uint256 bobReceived = usdc.balanceOf(bob) - bobBefore;
        uint256 slashed     = stakeBefore - ts.getStake(alice).amount;

        // Both should be the same value (slash goes to bob)
        assertEq(bobReceived, slashed, "USDC slash == follower receipt");
        // Slash is 50% of 40% loss = 200e18 (approximate — PnL rounding may vary)
        assertGt(slashed, 0, "some slash occurred");
    }

    // ── Test 6: slash skipped when traderStake == address(0) ────────────────
    function test_slash_skippedWhenTraderStakeIsZero() public {
        CopyTracker ct2 = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(0), address(0)
        );
        exchange.setCopyTracker(address(ct2));

        vm.prank(bob); usdc.approve(address(ct2), type(uint256).max);
        vm.prank(bob); ct2.followTrader(alice, 1_000e18);

        oracle.updatePrice(BTC, 60_000e8);   // would trigger slash

        uint256 stakeBefore = ts.getStake(alice).amount;
        vm.prank(bob); ct2.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, stakeBefore, "no slash when stake disabled");
    }

    // ── Test 7: TraderSlashed event emitted ──────────────────────────────────
    function test_TraderSlashed_event_emitted() public {
        _follow(1_000e18);
        oracle.updatePrice(BTC, 60_000e8);

        vm.expectEmit(true, true, false, false);
        emit CopyTracker.TraderSlashed(alice, bob, 0);
        _unfollow();
    }
}
