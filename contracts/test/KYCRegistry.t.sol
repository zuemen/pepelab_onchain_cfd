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

    function testSubmitKYC() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");
        assertTrue(kyc.isVerified(alice));

        (bool verified, string memory fullName, string memory nationality, uint256 verifiedAt) = kyc.records(alice);
        assertTrue(verified);
        assertEq(fullName, "Alice Wang");
        assertEq(nationality, "TW");
        assertGt(verifiedAt, 0);
    }

    function testSubmitKYC_emitsKYCVerified() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit KYCRegistry.KYCVerified(alice, "TW", block.timestamp);
        kyc.submitKYC("Alice Wang", "TW");
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
