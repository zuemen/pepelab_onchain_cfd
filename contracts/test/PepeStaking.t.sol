// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PepeStaking.sol";

// ── Minimal ERC20 ─────────────────────────────────────────────────────────────

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "insufficient");
        balanceOf[from] -= amt;
        balanceOf[to]   += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract PepeStakingTest is Test {
    MockToken  pepe;
    PepeStaking staking;

    address alice = address(0xA);
    address bob   = address(0xB);
    address owner = address(this);

    function setUp() public {
        pepe    = new MockToken();
        staking = new PepeStaking(address(pepe));

        pepe.mint(alice,   10_000e18);
        pepe.mint(bob,     10_000e18);
        pepe.mint(owner,  100_000e18);
    }

    function test_stake_happy() public {
        vm.prank(alice);
        staking.stake(1000e18);
        assertEq(staking.balanceOf(alice), 1000e18);
        assertEq(staking.totalStaked(),    1000e18);
    }

    function test_stake_revert_zero() public {
        vm.prank(alice);
        vm.expectRevert(PepeStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    function test_withdraw_happy() public {
        vm.prank(alice);
        staking.stake(1000e18);
        vm.prank(alice);
        staking.withdraw(500e18);
        assertEq(staking.balanceOf(alice), 500e18);
    }

    function test_withdraw_revert_insufficient() public {
        vm.prank(alice);
        staking.stake(100e18);
        vm.prank(alice);
        vm.expectRevert(PepeStaking.InsufficientStake.selector);
        staking.withdraw(200e18);
    }

    function test_notifyRewardAmount_and_earn() public {
        // Alice stakes 1000
        vm.prank(alice);
        staking.stake(1000e18);

        // Owner funds 7000 PEPE reward for 7 days
        staking.notifyRewardAmount(7000e18);

        // Advance 7 days
        vm.warp(block.timestamp + 7 days);

        uint256 earned = staking.earned(alice);
        // Should be approximately 7000e18 (sole staker)
        assertGt(earned, 6900e18);
        assertLt(earned, 7100e18);
    }

    function test_claimYield() public {
        vm.prank(alice);
        staking.stake(1000e18);
        staking.notifyRewardAmount(7000e18);
        vm.warp(block.timestamp + 7 days);

        uint256 balBefore = pepe.balanceOf(alice);
        vm.prank(alice);
        staking.claimYield();
        assertGt(pepe.balanceOf(alice), balBefore);
    }

    function test_two_stakers_proportional() public {
        vm.prank(alice);
        staking.stake(1000e18);
        vm.prank(bob);
        staking.stake(1000e18);

        staking.notifyRewardAmount(14_000e18);
        vm.warp(block.timestamp + 7 days);

        uint256 aliceEarned = staking.earned(alice);
        uint256 bobEarned   = staking.earned(bob);
        // Should each get ~7000
        assertApproxEqRel(aliceEarned, bobEarned, 1e15); // 0.1% tolerance
    }

    function test_exit() public {
        vm.prank(alice);
        staking.stake(500e18);
        staking.notifyRewardAmount(3500e18);
        vm.warp(block.timestamp + 7 days);

        vm.prank(alice);
        staking.exit();
        assertEq(staking.balanceOf(alice), 0);
        assertGt(pepe.balanceOf(alice), 10_000e18); // original + yield
    }
}
