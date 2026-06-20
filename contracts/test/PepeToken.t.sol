// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PepeToken.sol";

contract PepeTokenTest is Test {
    PepeToken pepe;
    address owner = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        pepe = new PepeToken();
    }

    function test_metadataAndInitialSupply() public view {
        assertEq(pepe.name(), "Pepe RWA Token");
        assertEq(pepe.symbol(), "PEPE");
        assertEq(pepe.decimals(), 18);
        assertEq(pepe.totalSupply(), pepe.INITIAL_SUPPLY());
        assertEq(pepe.balanceOf(owner), pepe.INITIAL_SUPPLY());
    }

    function test_onlyOwnerCanMint() public {
        vm.prank(alice);
        vm.expectRevert();
        pepe.mint(alice, 1e18);
    }

    // ── Faucet ──────────────────────────────────────────────────────────────
    function test_faucetMintsFixedAmount() public {
        vm.prank(alice);
        pepe.faucet();
        assertEq(pepe.balanceOf(alice), pepe.FAUCET_AMOUNT());
    }

    function test_faucetCooldown() public {
        vm.startPrank(alice);
        pepe.faucet();
        vm.expectRevert(
            abi.encodeWithSelector(
                PepeToken.FaucetCooldown.selector,
                block.timestamp + pepe.FAUCET_COOLDOWN()
            )
        );
        pepe.faucet();
        vm.stopPrank();
    }

    function test_faucetAfterCooldown() public {
        vm.startPrank(alice);
        pepe.faucet();
        vm.warp(block.timestamp + pepe.FAUCET_COOLDOWN() + 1);
        pepe.faucet();
        vm.stopPrank();
        assertEq(pepe.balanceOf(alice), 2 * pepe.FAUCET_AMOUNT());
    }

    function test_faucetIndependentPerAddress() public {
        vm.prank(alice);
        pepe.faucet();
        vm.prank(bob);
        pepe.faucet(); // bob has no cooldown — must not revert
        assertEq(pepe.balanceOf(bob), pepe.FAUCET_AMOUNT());
    }
}
