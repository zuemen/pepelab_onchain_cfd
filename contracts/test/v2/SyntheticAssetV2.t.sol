// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../../src/v2/SyntheticAssetV2.sol";

contract SyntheticAssetV2Test is Test {
    SyntheticAssetV2 token;
    address admin    = makeAddr("admin");
    address vaultOld = makeAddr("vaultOld");
    address vaultNew = makeAddr("vaultNew");
    address alice    = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");

    /// @dev Cached because vm.prank applies to the NEXT call only — reading
    ///      token.MINTER_ROLE() inline would consume the prank and the
    ///      grantRole beneath it would run as address(this).
    bytes32 minterRole;

    function setUp() public {
        token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        minterRole = token.MINTER_ROLE();
        vm.prank(admin);
        token.grantRole(minterRole, vaultOld);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Synthetic Apple");
        assertEq(token.symbol(), "sAAPL");
        assertEq(token.decimals(), 18);
        assertEq(token.assetId(), AID);
    }

    function test_minterCanMintAndBurn() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);
        assertEq(token.balanceOf(alice), 10e18);

        vm.prank(vaultOld);
        token.burn(alice, 4e18);
        assertEq(token.balanceOf(alice), 6e18);
    }

    function test_nonMinterCannotMint() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    /// @dev The whole reason V2 exists: swapping the vault must not require
    ///      redeploying the token or touching holder balances.
    function test_vaultCanBeRotatedWithoutRedeploy() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);

        vm.startPrank(admin);
        token.revokeRole(minterRole, vaultOld);
        token.grantRole(minterRole, vaultNew);
        vm.stopPrank();

        // old vault is now powerless
        vm.prank(vaultOld);
        vm.expectRevert();
        token.mint(alice, 1e18);

        // new vault works, balance preserved
        vm.prank(vaultNew);
        token.mint(alice, 5e18);
        assertEq(token.balanceOf(alice), 15e18);
    }

    function test_onlyAdminCanGrantMinter() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                bytes32(0)   // DEFAULT_ADMIN_ROLE
            )
        );
        token.grantRole(minterRole, alice);
    }

    function test_holderCanTransfer() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);
        address bob = makeAddr("bob");
        vm.prank(alice);
        token.transfer(bob, 4e18);
        assertEq(token.balanceOf(bob), 4e18);
    }
}
