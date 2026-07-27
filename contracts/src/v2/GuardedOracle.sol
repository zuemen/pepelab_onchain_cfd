// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface IPriceSource {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice Price oracle that removes the single-key failure mode of MockOracle.
///
///         MockOracle.updatePrice is `onlyOwner`, so one compromised key can set
///         any price and drain every contract that prices off it. That is the
///         most severe unmitigated risk in the system. This contract keeps the
///         same `getPrice(bytes32) -> (price, updatedAt)` interface so it is a
///         drop-in for anything that reads MockOracle, and adds:
///
///           - N keepers instead of one owner, each able to post
///           - a per-update deviation cap, so a single bad post cannot move the
///             price arbitrarily even from an authorized key
///           - quarantine: a post beyond the cap is rejected, not clamped, and
///             the asset can be frozen for review
///           - an optional reference source (e.g. the Chainlink/Pyth aggregator)
///             that posts must agree with
///           - pause, and role separation so the admin key can live in a
///             multisig behind a timelock while keepers stay hot
///
///         What it does NOT do: make prices trustless. Keepers are still trusted
///         parties. It converts "one key can do anything" into "one key can do
///         a little, and visibly". Full custody-grade pricing needs a
///         decentralized feed as the reference source — which is what
///         `referenceSource` is for.
contract GuardedOracle is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant BPS_DENOM = 10_000;

    struct Asset {
        uint256 price;      // 8 decimals, matching MockOracle
        uint256 updatedAt;
        bool    exists;
        bool    frozen;     // guardian halt for this asset only
    }

    mapping(bytes32 => Asset) private _assets;

    /// @notice Max move per update, in bps of the previous price. 0 = unlimited
    ///         (only sane before the first price is seeded).
    uint256 public maxDeviationBps = 1_000;   // 10%

    /// @notice Reject prices older than this when reading. 0 disables the check.
    uint256 public maxPriceAge = 1 hours;

    /// @notice Optional cross-check. When set, a keeper's post must agree with
    ///         this source within maxDeviationBps.
    address public referenceSource;

    bool public paused;

    event AssetAdded(bytes32 indexed assetId, uint256 price);
    event PriceUpdated(bytes32 indexed assetId, uint256 oldPrice, uint256 newPrice, address keeper);
    event PriceRejected(bytes32 indexed assetId, uint256 attempted, uint256 current, string reason);
    event AssetFrozen(bytes32 indexed assetId, bool frozen);
    event RiskParamsUpdated(uint256 maxDeviationBps, uint256 maxPriceAge);
    event ReferenceSourceSet(address source);
    event PausedSet(bool paused);

    error AssetNotFound(bytes32 assetId);
    error AssetAlreadyExists(bytes32 assetId);
    error InvalidPrice();
    error DeviationTooLarge(bytes32 assetId, uint256 attempted, uint256 current);
    error ReferenceDisagrees(bytes32 assetId, uint256 attempted, uint256 refPrice);
    error AssetIsFrozen(bytes32 assetId);
    error StalePrice(bytes32 assetId, uint256 updatedAt);
    error IsPaused();
    error InvalidParam();

    constructor(address admin) {
        if (admin == address(0)) revert InvalidParam();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // ── reads (MockOracle-compatible) ────────────────────────────────────────

    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (a.frozen) revert AssetIsFrozen(assetId);
        if (maxPriceAge != 0 && block.timestamp > a.updatedAt + maxPriceAge) {
            revert StalePrice(assetId, a.updatedAt);
        }
        return (a.price, a.updatedAt);
    }

    /// @notice Mirrors MockOracle.isStale so adapters can probe this the same way.
    function isStale(bytes32 assetId) external view returns (bool) {
        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (a.frozen) return true;
        if (maxPriceAge == 0) return false;
        return block.timestamp > a.updatedAt + maxPriceAge;
    }

    /// @notice Raw read that never reverts on staleness or freeze — for
    ///         dashboards that need to show why something is wrong.
    function peek(bytes32 assetId)
        external view
        returns (uint256 price, uint256 updatedAt, bool exists, bool frozen)
    {
        Asset storage a = _assets[assetId];
        return (a.price, a.updatedAt, a.exists, a.frozen);
    }

    // ── keeper writes ────────────────────────────────────────────────────────

    function addAsset(bytes32 assetId, uint256 initialPrice) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_assets[assetId].exists) revert AssetAlreadyExists(assetId);
        if (initialPrice == 0) revert InvalidPrice();
        _assets[assetId] = Asset({
            price: initialPrice, updatedAt: block.timestamp, exists: true, frozen: false
        });
        emit AssetAdded(assetId, initialPrice);
    }

    /// @notice Post a price. Any KEEPER_ROLE holder may call; the guards below
    ///         bound what a single compromised keeper can achieve.
    function updatePrice(bytes32 assetId, uint256 newPrice) external onlyRole(KEEPER_ROLE) {
        if (paused) revert IsPaused();

        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (a.frozen) revert AssetIsFrozen(assetId);
        if (newPrice == 0) revert InvalidPrice();

        uint256 old = a.price;

        // Reject rather than clamp: a clamped price is a fabricated price, and
        // the caller would have no way to know the number is not the market.
        if (maxDeviationBps != 0 && _deviationExceeded(old, newPrice, maxDeviationBps)) {
            emit PriceRejected(assetId, newPrice, old, "deviation");
            revert DeviationTooLarge(assetId, newPrice, old);
        }

        if (referenceSource != address(0)) {
            (bool ok, uint256 refPrice) = _reference(assetId);
            if (ok && _deviationExceeded(refPrice, newPrice, maxDeviationBps)) {
                emit PriceRejected(assetId, newPrice, refPrice, "reference");
                revert ReferenceDisagrees(assetId, newPrice, refPrice);
            }
        }

        a.price = newPrice;
        a.updatedAt = block.timestamp;
        emit PriceUpdated(assetId, old, newPrice, msg.sender);
    }

    // ── guardian ─────────────────────────────────────────────────────────────

    /// @notice Freeze one asset. Reads revert while frozen, so downstream
    ///         contracts fail closed instead of trading on a suspect price.
    function setAssetFrozen(bytes32 assetId, bool frozen) external onlyRole(GUARDIAN_ROLE) {
        if (!_assets[assetId].exists) revert AssetNotFound(assetId);
        _assets[assetId].frozen = frozen;
        emit AssetFrozen(assetId, frozen);
    }

    function setPaused(bool p) external onlyRole(GUARDIAN_ROLE) {
        paused = p;
        emit PausedSet(p);
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function setRiskParams(uint256 maxDeviationBps_, uint256 maxPriceAge_)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        // A 100% cap would let one post double or zero the price, defeating the
        // control. Keep it meaningfully below that.
        if (maxDeviationBps_ > 5_000) revert InvalidParam();
        maxDeviationBps = maxDeviationBps_;
        maxPriceAge = maxPriceAge_;
        emit RiskParamsUpdated(maxDeviationBps_, maxPriceAge_);
    }

    /// @notice Point at a decentralized feed (e.g. AggregatorOracleAdapter) that
    ///         keeper posts must agree with. address(0) disables the check.
    function setReferenceSource(address source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        referenceSource = source;
        emit ReferenceSourceSet(source);
    }

    // ── internal ─────────────────────────────────────────────────────────────

    function _reference(bytes32 assetId) internal view returns (bool ok, uint256 price) {
        try IPriceSource(referenceSource).getPrice(assetId) returns (uint256 p, uint256) {
            if (p == 0) return (false, 0);
            return (true, p);
        } catch {
            // Reference unavailable is not a reason to block price updates —
            // that would let an outage freeze the platform.
            return (false, 0);
        }
    }

    function _deviationExceeded(uint256 a, uint256 b, uint256 bps) internal pure returns (bool) {
        if (a == 0) return false;
        (uint256 hi, uint256 lo) = a > b ? (a, b) : (b, a);
        return (hi - lo) * BPS_DENOM > bps * lo;
    }
}
