// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ESGRegistry
/// @notice On-chain ESG score store for synthetic assets. Scores are 0-100.
contract ESGRegistry is Ownable {
    // ── Data types ───────────────────────────────────────────────────────────

    struct ESGData {
        uint8  environmental;  // 0-100
        uint8  social;         // 0-100
        uint8  governance;     // 0-100
        string rating;         // e.g. "AAA", "BBB", "CCC"
        bool   exists;
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(bytes32 => ESGData) private _scores;
    bytes32[] private _ratedAssets;

    // ── Events ───────────────────────────────────────────────────────────────

    event ESGUpdated(
        bytes32 indexed assetId,
        uint8 environmental,
        uint8 social,
        uint8 governance,
        string rating
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error AssetNotRated(bytes32 assetId);
    error ScoreOutOfRange();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── Write ────────────────────────────────────────────────────────────────

    function setESG(
        bytes32 assetId,
        uint8   environmental,
        uint8   social,
        uint8   governance,
        string calldata rating
    ) external onlyOwner {
        if (environmental > 100 || social > 100 || governance > 100) revert ScoreOutOfRange();

        bool isNew = !_scores[assetId].exists;
        _scores[assetId] = ESGData({
            environmental: environmental,
            social:        social,
            governance:    governance,
            rating:        rating,
            exists:        true
        });

        if (isNew) _ratedAssets.push(assetId);

        emit ESGUpdated(assetId, environmental, social, governance, rating);
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    function getESG(bytes32 assetId) external view returns (
        uint8  environmental,
        uint8  social,
        uint8  governance,
        string memory rating
    ) {
        ESGData storage d = _scores[assetId];
        if (!d.exists) revert AssetNotRated(assetId);
        return (d.environmental, d.social, d.governance, d.rating);
    }

    /// @notice Returns (e+s+g)/3 rounded to nearest. Reverts if asset not rated.
    /// @dev Low: this used to floor. Because every consumer compares the result
    ///      against a `>=` threshold (`PepeIncentives.esgMinScore`,
    ///      `EsgRewardDistributor.highEsgThreshold`, both 70), flooring shifted
    ///      the real bar up by up to two thirds of a point and made it depend on
    ///      the sum's remainder: 70/70/69 averages 69.67 and was rejected by a
    ///      "70 or better" gate, while 70/70/70 passed. Round-to-nearest makes
    ///      the boundary mean what it says. Range is unchanged (0-100), so the
    ///      uint8 cast still cannot truncate.
    function compositeScore(bytes32 assetId) external view returns (uint8) {
        ESGData storage d = _scores[assetId];
        if (!d.exists) revert AssetNotRated(assetId);
        uint16 sum = uint16(d.environmental) + d.social + d.governance;
        return uint8((sum + 1) / 3);
    }

    function getAllRatedAssets() external view returns (bytes32[] memory) {
        return _ratedAssets;
    }

    function isRated(bytes32 assetId) external view returns (bool) {
        return _scores[assetId].exists;
    }
}
