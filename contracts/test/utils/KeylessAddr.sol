// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test addresses that nobody holds a private key for.
///
///         forge-std's `makeAddr(label)` is `vm.addr(uint256(keccak256(label)))`:
///         the private key is the hash of a public string. On a public testnet
///         such keys get used — Base Sepolia has EOAs for public keys that are
///         EIP-7702-delegated to someone's contract (docs/RUNBOOK_FREEZE_LEGACY.md).
///         Fork tests that prank one of those addresses then run against an
///         account that has code, which is not the plain EOA the test meant.
///
///         Hashing straight to 160 bits gives an address with no known key, so
///         nobody can ever sign a 7702 authorization for it. Use it for every
///         role a fork test pranks. Tests that need to SIGN keep `makeAddrAndKey`.
library KeylessAddr {
    function addr(string memory label) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("pepelab:keyless:", label)))));
    }
}
