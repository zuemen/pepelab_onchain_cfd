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
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        // StrategyRegistry with stake gate = ts
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        // CopyTracker with traderStake = ts (slash enabled)
        ct       = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(0), address(ts)
        );

        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));

        oracle.addAsset(BTC, BTC_PRICE);

        // Alice: stake → register → publish
        usdc.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(500e18);
        registry.registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = StrategyRegistry.Allocation(BTC, 10_000, true, 1);
        registry.publishStrategy(allocs);
        vm.stopPrank();

        // Fund follower + exchange reserve
        usdc.mint(bob, 100_000e18);
        usdc.mint(address(exchange), 200_000e18);
        vm.prank(bob); usdc.approve(address(ct), type(uint256).max);
    }

    function _follow(uint256 amount) internal {
        vm.prank(bob); ct.followTrader(alice, amount);
    }

    function _unfollow() internal {
        vm.prank(bob); ct.unfollowAndCloseAll(0);
    }

    // ── Test 1: slash triggered when loss > SLASH_TRIGGER_BPS ───────────────

    function test_slash_triggeredWhenLossExceedsThreshold() public {
        _follow(1_000e18);

        // BTC drops 40 % → return = 600e18 → loss 40 % > 30 % threshold
        oracle.updatePrice(BTC, 60_000e8);

        uint256 stakeBefore = ts.getStake(alice).stakedAmount;
        _unfollow();
        uint256 stakeAfter = ts.getStake(alice).stakedAmount;

        assertLt(stakeAfter, stakeBefore, "stake should be reduced by slash");
    }

    // ── Test 2: slash NOT triggered when loss < SLASH_TRIGGER_BPS ───────────

    function test_slash_notTriggeredWhenLossBelowThreshold() public {
        _follow(1_000e18);

        // BTC drops 20 % → loss 20 % < 30 % threshold → no slash
        oracle.updatePrice(BTC, 80_000e8);

        uint256 stakeBefore = ts.getStake(alice).stakedAmount;
        _unfollow();
        uint256 stakeAfter = ts.getStake(alice).stakedAmount;

        assertEq(stakeAfter, stakeBefore, "stake should be unchanged below threshold");
    }

    // ── Test 3: slash USDC sent directly to follower ─────────────────────────

    function test_slash_tokenSentToFollower() public {
        _follow(1_000e18);
        oracle.updatePrice(BTC, 60_000e8);   // 40 % drop → slash triggered

        uint256 bobBefore = usdc.balanceOf(bob);
        _unfollow();
        uint256 bobAfter = usdc.balanceOf(bob);

        assertGt(bobAfter, bobBefore, "follower should receive slash compensation");
    }

    // ── Test 4: slash skipped when traderStake == address(0) ────────────────

    function test_slash_skippedWhenTraderStakeIsZero() public {
        // Deploy ct2 without traderStake — slash disabled
        CopyTracker ct2 = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(0), address(0)
        );
        exchange.setCopyTracker(address(ct2));

        vm.prank(bob); usdc.approve(address(ct2), type(uint256).max);
        vm.prank(bob); ct2.followTrader(alice, 1_000e18);

        oracle.updatePrice(BTC, 60_000e8);   // 40 % drop — would trigger slash

        uint256 stakeBefore = ts.getStake(alice).stakedAmount;
        vm.prank(bob); ct2.unfollowAndCloseAll(0);
        uint256 stakeAfter = ts.getStake(alice).stakedAmount;

        assertEq(stakeAfter, stakeBefore, "no slash when traderStake is address(0)");
    }

    // ── Test 5: TraderSlashed event emitted on slash ─────────────────────────

    function test_TraderSlashed_event_emitted() public {
        _follow(1_000e18);
        oracle.updatePrice(BTC, 60_000e8);   // 40 % drop → slash triggered

        vm.expectEmit(true, true, false, false);   // check trader + follower indexed args
        emit CopyTracker.TraderSlashed(alice, bob, 0);
        _unfollow();
    }
}
