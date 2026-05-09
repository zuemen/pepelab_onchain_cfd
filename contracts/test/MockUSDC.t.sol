// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_nameAndSymbol() public view {
        assertEq(usdc.name(), "Mock USDC");
        assertEq(usdc.symbol(), "mUSDC");
        assertEq(usdc.decimals(), 18);
    }

    function test_mintIncreasesBalance() public {
        usdc.mint(alice, 1000e18);
        assertEq(usdc.balanceOf(alice), 1000e18);
    }

    function test_mintIncreasesTotalSupply() public {
        usdc.mint(alice, 500e18);
        usdc.mint(bob, 300e18);
        assertEq(usdc.totalSupply(), 800e18);
    }

    function test_anyoneCanMint() public {
        vm.prank(alice);
        usdc.mint(alice, 1e18);
        assertEq(usdc.balanceOf(alice), 1e18);
    }

    function test_transfer() public {
        usdc.mint(alice, 100e18);
        vm.prank(alice);
        usdc.transfer(bob, 40e18);
        assertEq(usdc.balanceOf(alice), 60e18);
        assertEq(usdc.balanceOf(bob), 40e18);
    }

    // ── Faucet tests ──────────────────────────────────────────────────────────

    function test_faucetMintsCorrectAmount() public {
        vm.prank(alice);
        usdc.faucet();
        assertEq(usdc.balanceOf(alice), usdc.FAUCET_AMOUNT());
    }

    function test_faucetCooldown() public {
        vm.startPrank(alice);
        usdc.faucet();
        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDC.FaucetCooldown.selector,
                block.timestamp + usdc.FAUCET_COOLDOWN()
            )
        );
        usdc.faucet();
        vm.stopPrank();
    }

    function test_faucetCanCallAfterCooldown() public {
        vm.startPrank(alice);
        usdc.faucet();
        vm.warp(block.timestamp + usdc.FAUCET_COOLDOWN() + 1);
        usdc.faucet();
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 2 * usdc.FAUCET_AMOUNT());
    }

    function test_faucetIndependentPerAddress() public {
        vm.prank(alice);
        usdc.faucet();
        vm.prank(bob);
        usdc.faucet();   // bob has no cooldown yet — should not revert
        assertEq(usdc.balanceOf(bob), usdc.FAUCET_AMOUNT());
    }
}
