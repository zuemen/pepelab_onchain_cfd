// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/KYCRegistry.sol";

contract KYCRegistryTest is Test {
    KYCRegistry kyc;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    function setUp() public {
        kyc = new KYCRegistry();
    }

    function testIsVerifiedFalseBeforeSubmit() public view {
        assertFalse(kyc.isVerified(alice));
    }

    /// @dev M8: submitting used to verify in the same call. It now only records
    ///      the application; the verified flag stays false until a reviewer
    ///      approves. This is the whole point of the fix, so the assertion is
    ///      deliberately the opposite of what it used to be.
    function testSubmitKYC_doesNotSelfVerify() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");
        assertFalse(kyc.isVerified(alice), "submission must not grant verification");
        assertTrue(kyc.isPending(alice));

        (bool verified, string memory fullName, string memory nationality, uint256 verifiedAt) = kyc.records(alice);
        assertFalse(verified);
        assertEq(fullName, "Alice Wang");
        assertEq(nationality, "TW");
        assertEq(verifiedAt, 0);
    }

    function testApproveKYC_byOwner() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");

        kyc.approveKYC(alice);   // test contract is the owner
        assertTrue(kyc.isVerified(alice));
        assertFalse(kyc.isPending(alice));

        (, , , uint256 verifiedAt) = kyc.records(alice);
        assertGt(verifiedAt, 0);
    }

    function testApproveKYC_byStranger_revert() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(KYCRegistry.NotVerifier.selector, bob));
        kyc.approveKYC(alice);
        assertFalse(kyc.isVerified(alice));
    }

    function testApproveKYC_withoutSubmission_revert() public {
        vm.expectRevert(abi.encodeWithSelector(KYCRegistry.NoSubmission.selector, alice));
        kyc.approveKYC(alice);
    }

    function testAppointedVerifierCanApprove() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");

        kyc.setVerifier(bob, true);
        vm.prank(bob);
        kyc.approveKYC(alice);
        assertTrue(kyc.isVerified(alice));
    }

    function testRevokeKYC() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");
        kyc.approveKYC(alice);
        assertTrue(kyc.isVerified(alice));

        kyc.revokeKYC(alice);
        assertFalse(kyc.isVerified(alice));
    }

    function testSubmitKYC_emitsKYCSubmitted() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit KYCRegistry.KYCSubmitted(alice, "TW", block.timestamp);
        kyc.submitKYC("Alice Wang", "TW");
    }

    function testApproveKYC_emitsKYCVerified() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");

        vm.expectEmit(true, false, false, true);
        emit KYCRegistry.KYCVerified(alice, "TW", block.timestamp);
        kyc.approveKYC(alice);
    }

    function testBatchVerify_byOwner() public {
        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;

        // test contract is the owner (Ownable(msg.sender) in constructor)
        kyc.batchVerify(users);

        assertTrue(kyc.isVerified(alice));
        assertTrue(kyc.isVerified(bob));

        (bool v, string memory name, string memory nat,) = kyc.records(alice);
        assertTrue(v);
        assertEq(name, "Seed Account");
        assertEq(nat, "TW");
    }

    function testBatchVerify_byNonOwner_revert() public {
        address[] memory users = new address[](1);
        users[0] = bob;

        vm.prank(alice);
        vm.expectRevert();
        kyc.batchVerify(users);
    }
}
