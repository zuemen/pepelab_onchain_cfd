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

    // ── 1. stake MIN_STAKE → isEligible, amount set ──────────────────────────
    function testStake_increases() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        assertTrue(ts.isEligible(alice));
        assertEq(ts.getStake(alice).amount, minStake);
    }

    // ── 2. stake below MIN_STAKE → not eligible (reverts) ────────────────────
    // NOTE: pre-compute value before vm.prank to avoid staticcall consuming prank.
    function testStake_belowMin_notEligible() public {
        uint256 belowMin = ts.MIN_STAKE() - 1;
        vm.prank(alice);
        vm.expectRevert(TraderStake.BelowMinStake.selector);
        ts.stake(belowMin);
    }

    // ── 3. stake above MIN_STAKE → eligible ──────────────────────────────────
    function testStake_aboveMin_eligible() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake + 50e18);
        assertTrue(ts.isEligible(alice));
        assertEq(ts.getStake(alice).amount, minStake + 50e18);
    }

    // ── 4. requestUnstake sets unstakeAmount ─────────────────────────────────
    function testRequestUnstake() public {
        _stake(alice, ts.MIN_STAKE());
        vm.prank(alice);
        ts.requestUnstake(50e18);
        assertEq(ts.getStake(alice).unstakeAmount, 50e18);
        assertGt(ts.getStake(alice).unstakeRequestedAt, 0);
    }

    // ── 5. executeUnstake before cooldown reverts ─────────────────────────────
    function testExecuteUnstake_beforeCooldown_revert() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.prank(alice);
        vm.expectRevert();   // CooldownNotElapsed
        ts.executeUnstake();
    }

    // ── 6. executeUnstake after cooldown returns USDC ────────────────────────
    function testExecuteUnstake_afterCooldown_works() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.warp(block.timestamp + ts.UNSTAKE_COOLDOWN() + 1);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); ts.executeUnstake();

        assertEq(usdc.balanceOf(alice), before + minStake);
        assertEq(ts.getStake(alice).amount, 0);
        assertFalse(ts.isEligible(alice));
    }

    // ── 7. cancelUnstake clears unstakeAmount ─────────────────────────────────
    function testCancelUnstake() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        vm.prank(alice); ts.requestUnstake(minStake);

        vm.prank(alice); ts.cancelUnstake();

        assertEq(ts.getStake(alice).unstakeAmount, 0);
        assertEq(ts.getStake(alice).amount, minStake);
    }

    // ── 8. slash reduces stake and sends USDC to recipient ───────────────────
    function testSlash_byCopyTracker() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        uint256 slashAmt  = minStake * ts.MAX_SLASH_BPS() / 10_000;   // 50%
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        assertEq(ts.getStake(alice).amount, minStake - slashAmt);
        assertEq(usdc.balanceOf(bob), bobBefore + slashAmt);
        assertEq(ts.getStake(alice).totalSlashed, slashAmt);
    }

    // ── 9. slash from non-CopyTracker reverts ────────────────────────────────
    function testSlash_byOther_revert() public {
        _stake(alice, ts.MIN_STAKE());

        vm.prank(alice);
        vm.expectRevert(TraderStake.NotCopyTracker.selector);
        ts.slash(alice, 50e18, bob);
    }

    // ── 10. slash > MAX_SLASH_BPS reverts ────────────────────────────────────
    function testSlash_exceedsMaxBps_revert() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        uint256 tooMuch = minStake * ts.MAX_SLASH_BPS() / 10_000 + 1;

        vm.prank(ct);
        vm.expectRevert(TraderStake.SlashExceedsMax.selector);
        ts.slash(alice, tooMuch, bob);
    }

    // ── 11. isEligible drops to false after stake slashed below MIN ───────────
    function testReputationDecreasesAfterSlash() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);
        assertEq(ts.reputationScore(alice), 100);   // 100e18 / (100e18 + 0) * 100 = 100

        uint256 slashAmt = minStake / 2;             // 50e18 (within MAX_SLASH_BPS = 50%)
        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        assertLt(ts.reputationScore(alice), 100);
    }

    // ── 12. reputationScore formula: stake * 100 / (stake + totalSlashed * 5) ──
    function testReputationFormula() public {
        uint256 minStake = ts.MIN_STAKE();
        _stake(alice, minStake);

        // Slash 50e18 → amount = 50e18, totalSlashed = 50e18
        // score = 50e18 * 100 / (50e18 + 50e18 * 5) = 5000e18 / 300e18 = 16
        uint256 slashAmt = minStake * ts.MAX_SLASH_BPS() / 10_000;   // 50e18
        vm.prank(ct);
        ts.slash(alice, slashAmt, bob);

        // stake = 50e18, totalSlashed = 50e18
        // score = 50e18 * 100 / (50e18 + 50e18*5) = 5000/300 = 16
        uint256 remain   = minStake - slashAmt;
        uint256 expected = remain * 100 / (remain + slashAmt * 5);
        assertEq(ts.reputationScore(alice), expected);

        // Unstaked completely → score = 0
        vm.prank(alice); ts.requestUnstake(50e18);
        vm.warp(block.timestamp + ts.UNSTAKE_COOLDOWN() + 1);
        vm.prank(alice); ts.executeUnstake();
        assertEq(ts.reputationScore(alice), 0);
    }
}
