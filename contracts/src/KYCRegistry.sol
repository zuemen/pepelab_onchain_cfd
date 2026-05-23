// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract KYCRegistry is Ownable {
    struct KYCRecord {
        bool    verified;
        string  fullName;     // mock — demo only
        string  nationality;
        uint256 verifiedAt;
    }

    mapping(address => KYCRecord) public records;

    event KYCVerified(address indexed user, string nationality, uint256 timestamp);
    event KYCBatchVerified(uint256 count, uint256 timestamp);

    constructor() Ownable(msg.sender) {}

    // 使用者自助 KYC（mock,即時通過）
    function submitKYC(string calldata fullName, string calldata nationality) external {
        records[msg.sender] = KYCRecord(true, fullName, nationality, block.timestamp);
        emit KYCVerified(msg.sender, nationality, block.timestamp);
    }

    // admin 批次認證（給 seed 假帳戶用）
    function batchVerify(address[] calldata users) external onlyOwner {
        for (uint256 i; i < users.length; ++i) {
            records[users[i]] = KYCRecord(true, "Seed Account", "TW", block.timestamp);
        }
        emit KYCBatchVerified(users.length, block.timestamp);
    }

    function isVerified(address user) external view returns (bool) {
        return records[user].verified;
    }
}
