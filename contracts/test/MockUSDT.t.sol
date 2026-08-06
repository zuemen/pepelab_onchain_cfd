// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDT.sol";

contract MockUSDTTest is Test {
    MockUSDT usdt;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdt = new MockUSDT();
    }

    function test_nameAndSymbol() public view {
        assertEq(usdt.name(), "Mock Tether USD");
        assertEq(usdt.symbol(), "USDT");
        assertEq(usdt.decimals(), 18);
    }

    function test_mintIncreasesBalance() public {
        usdt.mint(alice, 1000e18);
        assertEq(usdt.balanceOf(alice), 1000e18);
    }

    function test_mintIncreasesTotalSupply() public {
        usdt.mint(alice, 500e18);
        usdt.mint(bob, 300e18);
        assertEq(usdt.totalSupply(), 800e18);
    }

    /// @dev PA-3: mirrors MockUSDC — `mint` is no longer permissionless.
    function test_strangerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDT.NotMinter.selector, alice));
        usdt.mint(alice, 1e18);
        assertEq(usdt.balanceOf(alice), 0);
    }

    function test_ownerCanMint() public {
        usdt.mint(alice, 1e18);
        assertEq(usdt.balanceOf(alice), 1e18);
    }

    function test_transfer() public {
        usdt.mint(alice, 100e18);
        vm.prank(alice);
        usdt.transfer(bob, 40e18);
        assertEq(usdt.balanceOf(alice), 60e18);
        assertEq(usdt.balanceOf(bob), 40e18);
    }

    // ── Faucet tests ──────────────────────────────────────────────────────────

    function test_faucetMintsCorrectAmount() public {
        vm.prank(alice, alice);
        usdt.faucet();
        assertEq(usdt.balanceOf(alice), usdt.FAUCET_AMOUNT());
    }

    function test_faucetCooldown() public {
        vm.startPrank(alice, alice);
        usdt.faucet();
        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDT.FaucetCooldown.selector,
                block.timestamp + usdt.FAUCET_COOLDOWN()
            )
        );
        usdt.faucet();
        vm.stopPrank();
    }

    function test_faucetCanCallAfterCooldown() public {
        vm.startPrank(alice, alice);
        usdt.faucet();
        vm.warp(block.timestamp + usdt.FAUCET_COOLDOWN() + 1);
        usdt.faucet();
        vm.stopPrank();
        assertEq(usdt.balanceOf(alice), 2 * usdt.FAUCET_AMOUNT());
    }

    function test_faucetIndependentPerAddress() public {
        vm.prank(alice, alice);
        usdt.faucet();
        vm.prank(bob, bob);
        usdt.faucet();   // bob has no cooldown yet — should not revert
        assertEq(usdt.balanceOf(bob), usdt.FAUCET_AMOUNT());
    }
}
