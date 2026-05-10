// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TraderStake.sol";
import "../src/MockUSDC.sol";

contract TraderStakeTest is Test {
    MockUSDC    usdc;
    TraderStake ts;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address ct    = makeAddr("ct");   // mock CopyTracker

    function setUp() public {
        usdc = new MockUSDC();
        ts   = new TraderStake(address(usdc));
        ts.setCopyTracker(ct);

        usdc.mint(alice, 10_000e18);
        usdc.mint(bob,   10_000e18);
        vm.prank(alice); usdc.approve(address(ts), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(ts), type(uint256).max);
    }

    function _stake(address who, uint256 amt) internal {
        vm.prank(who);
        ts.stake(amt);
    }

    // ── 1. stake MIN_STAKE → isEligible ──────────────────────────────────────

    function test_stake_basic_isEligible() public {
        _stake(alice, ts.MIN_STAKE());
        assertTrue(ts.isEligible(alice));
        assertEq(ts.getStake(alice).stakedAmount, ts.MIN_STAKE());
    }

    // ── 2. stake below MIN_STAKE reverts ─────────────────────────────────────
    // NOTE: pre-compute value before vm.prank — otherwise the MIN_STAKE()
    //       staticcall consumes the prank, leaving stake() called as test contract.

    function test_stake_belowMin_reverts() public {
        uint256 belowMin = ts.MIN_STAKE() - 1;
        vm.prank(alice);
        vm.expectRevert(TraderStake.BelowMinStake.selector);
        ts.stake(belowMin);
    }

    // ── 3. stake twice accumulates ────────────────────────────────────────────

    function test_stake_accumulates() public {
        _stake(alice, ts.MIN_STAKE());
        _stake(alice, 50e18);
        assertEq(ts.getStake(alice).stakedAmount, ts.MIN_STAKE() + 50e18);
    }

    // ── 4. requestUnstake sets pendingUnstake ─────────────────────────────────

    function test_requestUnstake_setsPending() public {
        _stake(alice, ts.MIN_STAKE());
        vm.prank(alice);
        ts.requestUnstake(50e18);
        assertEq(ts.getStake(alice).pendingUnstake, 50e18);
    }

    // ── 5. executeUnstake after cooldown returns USDC ─────────────────────────
    // NOTE: pre-compute MIN_STAKE before vm.prank to avoid consuming the prank.

    function test_executeUnstake_afterCooldown_returnsUSDC() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.warp(block.timestamp + ts.UNSTAKE_COOLDOWN() + 1);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); ts.executeUnstake();

        assertEq(usdc.balanceOf(alice), before + minStake);
        assertEq(ts.getStake(alice).stakedAmount, 0);
        assertFalse(ts.isEligible(alice));
    }

    // ── 6. executeUnstake before cooldown reverts ─────────────────────────────

    function test_executeUnstake_beforeCooldown_reverts() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.prank(alice);
        vm.expectRevert();   // CooldownNotElapsed
        ts.executeUnstake();
    }

    // ── 7. cancelUnstake clears pendingUnstake ────────────────────────────────

    function test_cancelUnstake_clearsPending() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.prank(alice); ts.cancelUnstake();

        assertEq(ts.getStake(alice).pendingUnstake, 0);
        assertEq(ts.getStake(alice).stakedAmount, minStake);
    }

    // ── 8. slash reduces stake and sends USDC to recipient ───────────────────

    function test_slash_reducesStakeAndSendsUSDC() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        uint256 slashAmt  = minStake * ts.MAX_SLASH_BPS() / 10_000;   // 50 %
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        assertEq(ts.getStake(alice).stakedAmount, minStake - slashAmt);
        assertEq(usdc.balanceOf(bob), bobBefore + slashAmt);
        assertEq(ts.getStake(alice).totalSlashed, slashAmt);
        assertEq(ts.getStake(alice).slashCount, 1);
    }

    // ── 9. slash > MAX_SLASH_BPS reverts ─────────────────────────────────────

    function test_slash_exceedsMax_reverts() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        uint256 tooMuch = minStake * ts.MAX_SLASH_BPS() / 10_000 + 1;

        vm.prank(ct);
        vm.expectRevert(TraderStake.SlashExceedsMax.selector);
        ts.slash(alice, tooMuch, bob);
    }

    // ── 10. slash from non-CopyTracker reverts ────────────────────────────────

    function test_slash_notCopyTracker_reverts() public {
        _stake(alice, ts.MIN_STAKE());

        vm.prank(alice);
        vm.expectRevert(TraderStake.NotCopyTracker.selector);
        ts.slash(alice, 50e18, bob);
    }

    // ── 11. isEligible false after stake drops below MIN ─────────────────────

    function test_isEligible_falseAfterSlashBelowMin() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        assertTrue(ts.isEligible(alice));

        // Slash 50 % (= MAX_SLASH_BPS) → 50e18 remaining < MIN_STAKE(100e18)
        uint256 slashAmt = minStake / 2;   // 50e18
        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        assertFalse(ts.isEligible(alice));
    }

    // ── 12. reputationScore decreases with each slash ─────────────────────────

    function test_reputationScore_decreasesWithSlash() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        assertEq(ts.reputationScore(alice), 100);   // 100e18*100/100e18 = 100

        // Slash 25 % of stake (within MAX_SLASH_BPS cap of 50 %)
        uint256 slashAmt = minStake * ts.MAX_SLASH_BPS() / 10_000 / 2;   // 25e18
        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        // stakedAmount = 75e18 → base = 75; slashCount = 1 → penalty = 10 → score = 65
        assertLt(ts.reputationScore(alice), 100);
        assertEq(ts.reputationScore(alice), 65);
    }
}
