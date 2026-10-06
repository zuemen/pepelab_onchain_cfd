// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev The subset of AgentSessionManager this contract reads. `sessions(id)` is the
///      auto-generated getter of `mapping(uint256 => Session) public sessions`, whose
///      tuple order is the Session struct order (user, agent, maxMarginPerTrade,
///      totalMarginBudget, spentMargin, maxLeverage, expiry, revoked).
///      AgentSessionManager itself is NOT modified: this anchor is a separate, read-only
///      consumer of its public state.
interface IAgentSessionView {
    function sessions(uint256 sessionId)
        external
        view
        returns (
            address user,
            address agent,
            uint256 maxMarginPerTrade,
            uint256 totalMarginBudget,
            uint256 spentMargin,
            uint256 maxLeverage,
            uint256 expiry,
            bool revoked
        );
}

/// @title SessionCredentialAnchor
/// @notice On-chain anchor that binds an off-chain AgentDelegationCredential (W3C VC v3,
///         EIP-712 proof) to an AgentSessionManager session.
///
///         The VC is signed off-chain by the session user. Anyone can verify the signature,
///         but a third party (e.g. an x402 seller doing Know-Your-Agent) also wants to know
///         "is this the credential the session owner currently stands behind?". The session
///         user answers that publicly by anchoring the credential's hash here:
///
///           • only `sessions(id).user` may anchor / unanchor (read from AgentSessionManager);
///           • one current credential per session — anchoring a new hash supersedes the old
///             one (the old hash stops being `isAnchored`), with an auditable event trail;
///           • `isAnchored` is a *live* view: it is false once the session is revoked or
///             expired on chain, even if the hash is still recorded (see `currentCredential`).
///
///         `credentialHash` is the EIP-712 digest of the v3 credential (see
///         frontend/src/contracts/agentDelegation.ts → delegationCredentialHash). The contract
///         never sees the credential itself; it stores 32 bytes and an index of who/when.
contract SessionCredentialAnchor {
    // ── Immutables ───────────────────────────────────────────────────────────

    /// @notice The AgentSessionManager whose sessions this contract anchors.
    IAgentSessionView public immutable sessionManager;

    // ── Storage ──────────────────────────────────────────────────────────────

    /// @notice The credential hash the session user currently anchors (0 = none).
    ///         Kept after revocation / expiry for audit; use `isAnchored` for liveness.
    mapping(uint256 => bytes32) public currentCredential;

    /// @notice Block timestamp at which `currentCredential` was anchored (0 = none).
    mapping(uint256 => uint256) public anchoredAt;

    /// @notice How many times a credential has been anchored for the session (monotonic).
    mapping(uint256 => uint256) public anchorCount;

    // ── Events ───────────────────────────────────────────────────────────────

    /// @param previousHash the credential this one supersedes (0 if none).
    /// @param version      anchorCount after this anchor (1 for the first one).
    event CredentialAnchored(
        uint256 indexed sessionId,
        address indexed user,
        bytes32 indexed credentialHash,
        bytes32 previousHash,
        uint256 version
    );

    event CredentialUnanchored(
        uint256 indexed sessionId,
        address indexed user,
        bytes32 indexed credentialHash
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroSessionManager();
    error ZeroCredentialHash();
    error NotSessionUser(uint256 sessionId, address caller);
    error SessionNotLive(uint256 sessionId);
    error AlreadyAnchored(uint256 sessionId, bytes32 credentialHash);
    error NotCurrentCredential(uint256 sessionId, bytes32 credentialHash);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _sessionManager) {
        if (_sessionManager == address(0)) revert ZeroSessionManager();
        sessionManager = IAgentSessionView(_sessionManager);
    }

    // ── Session-user actions ─────────────────────────────────────────────────

    /// @notice Anchor `credentialHash` as the current credential of `sessionId`.
    ///         Supersedes any previously anchored credential for the session.
    /// @dev Only the session user, and only while the session is live — anchoring onto a
    ///      revoked or expired session would publish a binding no verifier should accept.
    function anchor(uint256 sessionId, bytes32 credentialHash) external {
        if (credentialHash == bytes32(0)) revert ZeroCredentialHash();
        (address user, uint256 expiry, bool revoked) = _session(sessionId);
        if (msg.sender != user || user == address(0)) revert NotSessionUser(sessionId, msg.sender);
        if (revoked || block.timestamp > expiry) revert SessionNotLive(sessionId);

        bytes32 previous = currentCredential[sessionId];
        if (previous == credentialHash) revert AlreadyAnchored(sessionId, credentialHash);

        currentCredential[sessionId] = credentialHash;
        anchoredAt[sessionId] = block.timestamp;
        uint256 version = ++anchorCount[sessionId];

        emit CredentialAnchored(sessionId, user, credentialHash, previous, version);
    }

    /// @notice Withdraw the anchor for `credentialHash` (must be the current one).
    /// @dev Allowed even after the session is revoked or expired, so the user can always
    ///      clean up. Passing the hash (not just the id) prevents a stale UI from removing
    ///      a credential it did not mean to.
    function unanchor(uint256 sessionId, bytes32 credentialHash) external {
        (address user,,) = _session(sessionId);
        if (msg.sender != user || user == address(0)) revert NotSessionUser(sessionId, msg.sender);
        if (credentialHash == bytes32(0) || currentCredential[sessionId] != credentialHash) {
            revert NotCurrentCredential(sessionId, credentialHash);
        }

        delete currentCredential[sessionId];
        delete anchoredAt[sessionId];

        emit CredentialUnanchored(sessionId, user, credentialHash);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice True iff `credentialHash` is the session's current anchor AND the session is
    ///         live on chain (not revoked, not expired). A superseded or unanchored hash, a
    ///         revoked session and an expired session all read false.
    function isAnchored(uint256 sessionId, bytes32 credentialHash) external view returns (bool) {
        if (credentialHash == bytes32(0) || currentCredential[sessionId] != credentialHash) return false;
        (, uint256 expiry, bool revoked) = _session(sessionId);
        return !revoked && block.timestamp <= expiry;
    }

    /// @notice Full status for verifiers that want to explain a rejection.
    /// @return recorded    `credentialHash` is the recorded current anchor (ignores liveness)
    /// @return sessionLive the session is neither revoked nor expired
    /// @return user        the session user (the only account allowed to anchor)
    /// @return since       when the current anchor was written (0 if none)
    function anchorStatus(uint256 sessionId, bytes32 credentialHash)
        external
        view
        returns (bool recorded, bool sessionLive, address user, uint256 since)
    {
        uint256 expiry;
        bool revoked;
        (user, expiry, revoked) = _session(sessionId);
        recorded = credentialHash != bytes32(0) && currentCredential[sessionId] == credentialHash;
        sessionLive = user != address(0) && !revoked && block.timestamp <= expiry;
        since = recorded ? anchoredAt[sessionId] : 0;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _session(uint256 sessionId) internal view returns (address user, uint256 expiry, bool revoked) {
        (user,,,,,, expiry, revoked) = sessionManager.sessions(sessionId);
    }
}
