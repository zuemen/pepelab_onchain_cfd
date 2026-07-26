// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SyntheticAsset.sol";

contract SyntheticAssetTest is Test {
    SyntheticAsset token;
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        token = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, vault);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Synthetic Apple");
        assertEq(token.symbol(), "sAAPL");
        assertEq(token.decimals(), 18);
        assertEq(token.assetId(), AID);
        assertEq(token.vault(), vault);
    }

    function test_onlyVaultCanMint() public {
        vm.prank(alice);
        vm.expectRevert(bytes("only vault"));
        token.mint(alice, 1e18);

        vm.prank(vault);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_onlyVaultCanBurn() public {
        vm.prank(vault);
        token.mint(alice, 5e18);

        vm.prank(alice);
        vm.expectRevert(bytes("only vault"));
        token.burn(alice, 1e18);

        vm.prank(vault);
        token.burn(alice, 2e18);
        assertEq(token.balanceOf(alice), 3e18);
    }

    /// @dev The token is a plain ERC-20 once minted — users can transfer it,
    ///      which is the whole point of the tokenized-asset layer.
    function test_holderCanTransfer() public {
        vm.prank(vault);
        token.mint(alice, 10e18);

        address bob = makeAddr("bob");
        vm.prank(alice);
        token.transfer(bob, 4e18);

        assertEq(token.balanceOf(alice), 6e18);
        assertEq(token.balanceOf(bob), 4e18);
    }
}
