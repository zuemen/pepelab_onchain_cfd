// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/KYCRegistry.sol";

contract KYCRegistryTest is Test {
    KYCRegistry kyc;

    address alice = address(0xA11CE);

    function setUp() public {
        kyc = new KYCRegistry();
    }

    function testIsVerified_falseBeforeSubmit() public view {
        assertFalse(kyc.isVerified(alice));
    }

    function testSubmitKYC_marksVerified() public {
        vm.prank(alice);
        kyc.submitKYC("Alice Wang", "TW");
        assertTrue(kyc.isVerified(alice));

        (bool verified, string memory fullName, string memory nationality, uint256 verifiedAt) = kyc.records(alice);
        assertTrue(verified);
        assertEq(fullName, "Alice Wang");
        assertEq(nationality, "TW");
        assertGt(verifiedAt, 0);
    }

    function testKYCEventEmitted() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit KYCRegistry.KYCSubmitted(alice, "TW", block.timestamp);
        kyc.submitKYC("Alice Wang", "TW");
    }
}
