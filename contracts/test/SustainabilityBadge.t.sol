// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SustainabilityBadge.sol";

/// @notice Decision #05/#10 (spec #93) has exactly one enforcement point:
///         no transfer path on this token may ever succeed. Every test
///         below tries a different path a transfer could otherwise take.
contract SustainabilityBadgeTest is Test {
    SustainabilityBadge badge;

    address admin   = address(this);
    address minter  = makeAddr("minter");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        badge = new SustainabilityBadge(admin);
        badge.grantRole(badge.MINTER_ROLE(), minter);
    }

    function _mintToAlice() internal returns (uint256 tokenId) {
        vm.prank(minter);
        tokenId = badge.mint(alice, "30+ day hold on a Low-carbon-tier position");
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    function test_mint_onlyMinterRole() public {
        vm.prank(alice);
        vm.expectRevert();
        badge.mint(alice, "not a minter");
    }

    function test_mint_assignsSequentialTokenIds() public {
        vm.startPrank(minter);
        uint256 id1 = badge.mint(alice, "first");
        uint256 id2 = badge.mint(bob, "second");
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    function test_mint_setsOwnerAndBalance() public {
        uint256 id = _mintToAlice();
        assertEq(badge.ownerOf(id), alice);
        assertEq(badge.balanceOf(alice), 1);
    }

    function test_mint_recordsReason() public {
        uint256 id = _mintToAlice();
        assertEq(badge.reasonFor(id), "30+ day hold on a Low-carbon-tier position");
    }

    function test_mint_emitsBadgeMinted() public {
        vm.expectEmit(true, true, false, true);
        emit SustainabilityBadge.BadgeMinted(alice, 1, "reason");
        vm.prank(minter);
        badge.mint(alice, "reason");
    }

    // ── Non-transferability ──────────────────────────────────────────────────

    function test_transferFrom_reverts() public {
        uint256 id = _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.transferFrom(alice, bob, id);
    }

    function test_safeTransferFrom_reverts() public {
        uint256 id = _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.safeTransferFrom(alice, bob, id);
    }

    function test_safeTransferFromWithData_reverts() public {
        uint256 id = _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.safeTransferFrom(alice, bob, id, "");
    }

    /// @dev `approve` is rejected outright rather than left to silently
    ///      succeed-but-be-useless: an approval nothing can ever act on
    ///      would still make `getApproved` report a live approval to any
    ///      marketplace or dashboard reading it as a transferability signal.
    ///      This also means "approve then transfer" (the ticket's own
    ///      explicit path to guard: 含 approve 後轉移) can never even reach
    ///      the transfer step — approving is the first thing to fail.
    function test_approve_reverts() public {
        uint256 id = _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.approve(stranger, id);
    }

    /// @dev Same reasoning for the blanket operator approval.
    function test_setApprovalForAll_reverts() public {
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.setApprovalForAll(stranger, true);
    }

    function test_ownershipUnchangedAfterFailedTransfer() public {
        uint256 id = _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.transferFrom(alice, bob, id);

        assertEq(badge.ownerOf(id), alice);
        assertEq(badge.balanceOf(alice), 1);
        assertEq(badge.balanceOf(bob), 0);
    }
}
