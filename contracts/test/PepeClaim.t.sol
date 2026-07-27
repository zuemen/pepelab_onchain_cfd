// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PepeClaim.sol";
import "../src/PepeToken.sol";

/// @dev Minimal KYC stub — PepeClaim only calls isVerified.
contract KycStub {
    mapping(address => bool) public isVerified;

    function setVerified(address user, bool ok) external {
        isVerified[user] = ok;
    }
}

/// @notice PepeClaim had zero test coverage despite gating a token airdrop on
///         KYC — flagged in the 2026-07-27 review alongside EsgRewardDistributor.
contract PepeClaimTest is Test {
    PepeClaim claimC;
    PepeToken pepe;
    KycStub   kyc;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        pepe   = new PepeToken();
        kyc    = new KycStub();
        claimC = new PepeClaim(address(pepe), address(kyc));

        pepe.transfer(address(claimC), 1_000_000e18);
        kyc.setVerified(alice, true);
    }

    function test_verifiedUserCanClaimDefaultAmount() public {
        vm.prank(alice);
        claimC.claim();
        assertEq(pepe.balanceOf(alice), 1_000e18);
        assertTrue(claimC.claimed(alice));
    }

    /// @dev The gate that gives the airdrop its meaning.
    function test_unverifiedUserCannotClaim() public {
        vm.prank(bob);
        vm.expectRevert(bytes("KYC required"));
        claimC.claim();
        assertEq(pepe.balanceOf(bob), 0);
    }

    function test_cannotClaimTwice() public {
        vm.startPrank(alice);
        claimC.claim();
        vm.expectRevert(bytes("already claimed"));
        claimC.claim();
        vm.stopPrank();
        assertEq(pepe.balanceOf(alice), 1_000e18);
    }

    /// @dev Losing KYC after claiming must not let the slot be reused.
    function test_claimedFlagSurvivesKycRevocation() public {
        vm.prank(alice);
        claimC.claim();

        kyc.setVerified(alice, false);
        kyc.setVerified(alice, true);

        vm.prank(alice);
        vm.expectRevert(bytes("already claimed"));
        claimC.claim();
    }

    function test_ownerCanChangeClaimAmount() public {
        claimC.setClaimAmount(250e18);
        vm.prank(alice);
        claimC.claim();
        assertEq(pepe.balanceOf(alice), 250e18);
    }

    function test_claimRevertsWhenPoolIsDry() public {
        claimC.withdraw(pepe.balanceOf(address(claimC)));
        vm.prank(alice);
        vm.expectRevert();                 // ERC20InsufficientBalance
        claimC.claim();
    }

    function test_onlyOwnerCanAdminister() public {
        vm.startPrank(alice);
        vm.expectRevert();
        claimC.setClaimAmount(1e18);
        vm.expectRevert();
        claimC.withdraw(1e18);
        vm.stopPrank();
    }

    function test_ownerCanWithdraw() public {
        uint256 before = pepe.balanceOf(owner);
        claimC.withdraw(5_000e18);
        assertEq(pepe.balanceOf(owner) - before, 5_000e18);
    }

    function test_claimIsPerAddress() public {
        kyc.setVerified(bob, true);
        vm.prank(alice);
        claimC.claim();
        vm.prank(bob);
        claimC.claim();                    // bob unaffected by alice's claim
        assertEq(pepe.balanceOf(bob), 1_000e18);
    }
}
