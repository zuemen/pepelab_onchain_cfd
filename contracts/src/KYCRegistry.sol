// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title  KYCRegistry
/// @notice Verification registry consumed by `PerpetualExchange`'s RWA gate
///         (`isVerified`) and by `PepeClaim`'s airdrop.
///
/// @dev    M8: `submitKYC` used to write `verified = true` in the same call, so
///         "KYC" was a self-service boolean. Two consequences, both real:
///           1. The RWA compliance gate on the exchange was decorative — any
///              address could clear it in one transaction with made-up data.
///           2. `PepeClaim` became a free-for-all: N addresses, N airdrops, at
///              the cost of gas only.
///         Submission and approval are now separate. A submission records the
///         applicant's data and marks them pending; only the owner or an
///         owner-appointed verifier can flip `verified`. `isVerified` keeps its
///         exact signature and semantics, so the exchange's gate is untouched.
contract KYCRegistry is Ownable {
    struct KYCRecord {
        bool    verified;
        string  fullName;     // mock — demo only
        string  nationality;
        uint256 verifiedAt;
    }

    mapping(address => KYCRecord) public records;

    /// @notice Applicant has submitted data and is awaiting review.
    mapping(address => bool) public pending;

    /// @notice Addresses allowed to approve/revoke besides the owner. Lets the
    ///         compliance operator run on a hot key while ownership stays cold.
    mapping(address => bool) public verifiers;

    event KYCSubmitted(address indexed user, string nationality, uint256 timestamp);
    event KYCVerified(address indexed user, string nationality, uint256 timestamp);
    event KYCRevoked(address indexed user, uint256 timestamp);
    event KYCBatchVerified(uint256 count, uint256 timestamp);
    event VerifierSet(address indexed verifier, bool allowed);

    error NoSubmission(address user);
    error NotVerifier(address caller);
    error ZeroAddress();

    constructor() Ownable(msg.sender) {}

    modifier onlyVerifier() {
        if (msg.sender != owner() && !verifiers[msg.sender]) revert NotVerifier(msg.sender);
        _;
    }

    // ── Applicant ────────────────────────────────────────────────────────────

    /// @notice Submit KYC data for review. Does NOT grant verification.
    function submitKYC(string calldata fullName, string calldata nationality) external {
        records[msg.sender] = KYCRecord({
            verified:    false,
            fullName:    fullName,
            nationality: nationality,
            verifiedAt:  0
        });
        pending[msg.sender] = true;
        emit KYCSubmitted(msg.sender, nationality, block.timestamp);
    }

    // ── Reviewer ─────────────────────────────────────────────────────────────

    /// @notice Approve a pending submission. Owner or an appointed verifier.
    function approveKYC(address user) public onlyVerifier {
        KYCRecord storage r = records[user];
        if (!pending[user] && !r.verified) revert NoSubmission(user);
        pending[user]  = false;
        r.verified     = true;
        r.verifiedAt   = block.timestamp;
        emit KYCVerified(user, r.nationality, block.timestamp);
    }

    function approveKYCBatch(address[] calldata users) external onlyVerifier {
        for (uint256 i; i < users.length; ++i) approveKYC(users[i]);
    }

    /// @notice Withdraw verification (sanctions hit, expired documents, fraud).
    function revokeKYC(address user) external onlyVerifier {
        records[user].verified   = false;
        records[user].verifiedAt = 0;
        pending[user]            = false;
        emit KYCRevoked(user, block.timestamp);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    /// @notice Admin batch verification for seeded demo accounts. Unchanged.
    function batchVerify(address[] calldata users) external onlyOwner {
        for (uint256 i; i < users.length; ++i) {
            records[users[i]] = KYCRecord(true, "Seed Account", "TW", block.timestamp);
            pending[users[i]] = false;
        }
        emit KYCBatchVerified(users.length, block.timestamp);
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    function isVerified(address user) external view returns (bool) {
        return records[user].verified;
    }

    function isPending(address user) external view returns (bool) {
        return pending[user];
    }
}
