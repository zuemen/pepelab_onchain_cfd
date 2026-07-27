// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PerpetualExchange.sol";

/// @notice Phase 2 proxy / session-key layer.
///         A user delegates a *bounded* session to an agent key: per-trade margin
///         cap, cumulative budget, max leverage and an expiry. The agent then
///         trades the user's positions only within those limits, routed through
///         the exchange's authorized-agent path. The agent never holds the user's
///         main wallet key, and is restricted to this protocol's `*For` calls.
///
///         Deployment wiring: the protocol owner registers this contract on the
///         exchange via `setAgentAuthorized(address(this), true)` (Phase 2 step 1).
///         The exchange's `copyTracker` must also be set (CopyTrackerNotSet guard).
contract AgentSessionManager is ReentrancyGuard {
    // ── Immutables ───────────────────────────────────────────────────────────

    PerpetualExchange public immutable exchange;

    // ── Data types ───────────────────────────────────────────────────────────

    struct Session {
        address user;              // positions are opened/closed for this user
        address agent;             // session-key holder authorized to act
        uint256 maxMarginPerTrade; // cap per openPositionForSession call
        uint256 totalMarginBudget; // cumulative margin cap for the session
        uint256 spentMargin;       // accumulated margin used so far
        uint256 maxLeverage;       // per-session leverage ceiling
        uint256 expiry;            // unix ts; session unusable once passed
        bool    revoked;           // user can revoke at any time
    }

    // ── State ────────────────────────────────────────────────────────────────

    uint256 public nextSessionId;
    mapping(uint256 => Session) public sessions;

    /// @notice Per-session asset allow-list. sessionId => assetId => allowed.
    /// @dev Deliberately opt-in: a session with an EMPTY list may trade any
    ///      asset, so existing sessions and callers of the original
    ///      createSession() behave exactly as before. Restriction is something
    ///      the user opts into, not something that silently changes under them.
    mapping(uint256 => mapping(bytes32 => bool)) private _assetAllowed;

    /// @notice How many assets a session has allow-listed. 0 = unrestricted.
    mapping(uint256 => uint256) public allowedAssetCount;

    /// @dev Enumerable copy of the allow-list, so replacing it can clear the
    ///      old entries and so the frontend can display what a session permits.
    mapping(uint256 => bytes32[]) private _assetList;

    // ── Events ───────────────────────────────────────────────────────────────

    event SessionCreated(
        uint256 indexed sessionId,
        address indexed user,
        address indexed agent,
        uint256         totalMarginBudget,
        uint256         expiry
    );
    event SessionRevoked(uint256 indexed sessionId);
    event SessionAssetsSet(uint256 indexed sessionId, bytes32[] assets);
    event SessionOpenedPosition(
        uint256 indexed sessionId,
        address indexed agent,
        uint256         positionId,
        uint256         margin
    );
    event SessionClosedPosition(
        uint256 indexed sessionId,
        address indexed agent,
        uint256         positionId
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAgent();
    error ZeroBudget();
    error InvalidExpiry();
    error NotSessionOwner();
    error NotSessionAgent();
    error SessionIsRevoked();
    error SessionExpired();
    error MarginExceedsPerTradeCap();
    error BudgetExceeded();
    error LeverageExceedsSessionCap();
    error NotSessionUserPosition();
    error AssetNotAllowed(uint256 sessionId, bytes32 asset);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _exchange) {
        exchange = PerpetualExchange(_exchange);
    }

    // ── Session lifecycle ──────────────────────────────────────────────────────

    /// @notice User delegates a bounded session to `agent`.
    function createSession(
        address agent,
        uint256 maxMarginPerTrade,
        uint256 totalMarginBudget,
        uint256 maxLeverage,
        uint256 expiry
    ) external returns (uint256 sessionId) {
        sessionId = _createSession(
            agent, maxMarginPerTrade, totalMarginBudget, maxLeverage, expiry
        );
    }

    function _createSession(
        address agent,
        uint256 maxMarginPerTrade,
        uint256 totalMarginBudget,
        uint256 maxLeverage,
        uint256 expiry
    ) internal returns (uint256 sessionId) {
        if (agent == address(0)) revert ZeroAgent();
        if (maxMarginPerTrade == 0 || totalMarginBudget == 0) revert ZeroBudget();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            user:              msg.sender,
            agent:             agent,
            maxMarginPerTrade: maxMarginPerTrade,
            totalMarginBudget: totalMarginBudget,
            spentMargin:       0,
            maxLeverage:       maxLeverage,
            expiry:            expiry,
            revoked:           false
        });

        emit SessionCreated(sessionId, msg.sender, agent, totalMarginBudget, expiry);
    }

    /// @notice Same as createSession, but restricts the agent to `allowedAssets`.
    /// @dev Pass an empty array for an unrestricted session (identical to
    ///      createSession). The three existing caps bound how much an agent can
    ///      lose; this bounds what it can lose it on — a budgeted agent could
    ///      otherwise put the whole allowance into an asset the user never
    ///      intended to hold.
    function createSessionWithAssets(
        address   agent,
        uint256   maxMarginPerTrade,
        uint256   totalMarginBudget,
        uint256   maxLeverage,
        uint256   expiry,
        bytes32[] calldata allowedAssets
    ) external returns (uint256 sessionId) {
        sessionId = _createSession(
            agent, maxMarginPerTrade, totalMarginBudget, maxLeverage, expiry
        );
        if (allowedAssets.length > 0) {
            _setSessionAssets(sessionId, allowedAssets);
        }
    }

    /// @notice Session owner sets or replaces the allow-list.
    /// @dev Only the user, never the agent — an agent that could widen its own
    ///      permissions would make the list decorative. Passing an empty array
    ///      clears the restriction.
    function setSessionAssets(uint256 sessionId, bytes32[] calldata assets) external {
        if (msg.sender != sessions[sessionId].user) revert NotSessionOwner();
        _setSessionAssets(sessionId, assets);
    }

    /// @notice Whether `asset` may be traded by `sessionId`.
    ///         True for every asset when the session has no allow-list.
    function isAssetAllowed(uint256 sessionId, bytes32 asset) public view returns (bool) {
        if (allowedAssetCount[sessionId] == 0) return true;
        return _assetAllowed[sessionId][asset];
    }

    /// @notice User revokes their session at any time.
    function revokeSession(uint256 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.user) revert NotSessionOwner();
        s.revoked = true;
        emit SessionRevoked(sessionId);
    }

    // ── Bounded agent actions ──────────────────────────────────────────────────

    /// @notice Agent opens a position for the session's user, within session limits.
    function openPositionForSession(
        uint256 sessionId,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) external payable nonReentrant returns (uint256 positionId) {
        Session storage s = _requireActiveAgent(sessionId);
        if (!isAssetAllowed(sessionId, asset)) revert AssetNotAllowed(sessionId, asset);
        if (margin > s.maxMarginPerTrade) revert MarginExceedsPerTradeCap();
        if (s.spentMargin + margin > s.totalMarginBudget) revert BudgetExceeded();
        if (leverage > s.maxLeverage) revert LeverageExceedsSessionCap();

        // Effects before interaction (CEI): book the spend before the external call.
        s.spentMargin += margin;
        positionId = exchange.openPositionFor{value: msg.value}(
            s.user, asset, isLong, margin, leverage, copiedFrom
        );

        emit SessionOpenedPosition(sessionId, msg.sender, positionId, margin);
    }

    /// @notice Agent closes one of the session user's positions.
    function closePositionForSession(uint256 sessionId, uint256 positionId)
        external
        nonReentrant
    {
        Session storage s = _requireActiveAgent(sessionId);
        PerpetualExchange.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != s.user) revert NotSessionUserPosition();

        exchange.closePositionFor(s.user, positionId);
        emit SessionClosedPosition(sessionId, msg.sender, positionId);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    /// @dev Replaces the list wholesale. The previous entries are cleared first
    ///      so a shorter list genuinely narrows permissions rather than leaving
    ///      stale assets allowed.
    function _setSessionAssets(uint256 sessionId, bytes32[] calldata assets) internal {
        bytes32[] storage prev = _assetList[sessionId];
        for (uint256 i = 0; i < prev.length; i++) {
            _assetAllowed[sessionId][prev[i]] = false;
        }
        delete _assetList[sessionId];

        for (uint256 i = 0; i < assets.length; i++) {
            if (!_assetAllowed[sessionId][assets[i]]) {
                _assetAllowed[sessionId][assets[i]] = true;
                _assetList[sessionId].push(assets[i]);
            }
        }
        allowedAssetCount[sessionId] = _assetList[sessionId].length;

        emit SessionAssetsSet(sessionId, assets);
    }

    /// @notice The assets a session has allow-listed (empty = unrestricted).
    function allowedAssets(uint256 sessionId) external view returns (bytes32[] memory) {
        return _assetList[sessionId];
    }

    /// @dev Reverts unless caller is the session agent and the session is live.
    function _requireActiveAgent(uint256 sessionId)
        internal
        view
        returns (Session storage s)
    {
        s = sessions[sessionId];
        if (msg.sender != s.agent) revert NotSessionAgent();
        if (s.revoked) revert SessionIsRevoked();
        if (block.timestamp > s.expiry) revert SessionExpired();
    }
}
