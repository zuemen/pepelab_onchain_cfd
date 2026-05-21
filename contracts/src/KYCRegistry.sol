// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KYCRegistry {
    struct KYCRecord {
        bool verified;
        string fullName;
        string nationality;
        uint256 verifiedAt;
    }

    mapping(address => KYCRecord) public records;

    event KYCSubmitted(address indexed user, string nationality, uint256 timestamp);

    function submitKYC(string calldata fullName, string calldata nationality) external {
        records[msg.sender] = KYCRecord({
            verified: true,
            fullName: fullName,
            nationality: nationality,
            verifiedAt: block.timestamp
        });
        emit KYCSubmitted(msg.sender, nationality, block.timestamp);
    }

    function isVerified(address user) external view returns (bool) {
        return records[user].verified;
    }
}
