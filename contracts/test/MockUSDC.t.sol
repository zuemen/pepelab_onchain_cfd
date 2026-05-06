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
}
