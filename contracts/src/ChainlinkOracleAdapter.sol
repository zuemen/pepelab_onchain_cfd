// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal Chainlink AggregatorV3 interface (price feeds).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        );
}

/// @notice Production oracle: drop-in `IOracle` replacement backed by Chainlink
///         price feeds. Exposes the **same interface as MockOracle**
///         (`getPrice` → 8-decimal price + updatedAt, and `isStale`), so
///         `PerpetualExchange` can be deployed against it with **zero core
///         changes**.
///
///         Each asset maps to a Chainlink aggregator; feeds with non-8 decimals
///         are normalized to 8 (MockOracle's convention). Assets without a
///         configured feed revert `FeedNotSet`.
///
/// @dev    Audit 2026-08-06 (Medium, oracle layer):
///           * Round integrity. `latestRoundData` was destructured down to
///             `answer` alone. A feed that has stopped updating still returns
///             its last answer with `answeredInRound < roundId`, and a
///             never-initialised round returns `updatedAt == 0` — both were
///             indistinguishable from a healthy quote. Both now revert.
///           * `staleThreshold` was a 24h constant, chosen to "match
///             MockOracle". Chainlink's own heartbeat for the majors is ~1h; a
///             24h window on a perpetual means the mark can be a full day old
///             while every liveness check reports green. Default is now 1h and
///             owner-tunable inside [5 min, 24 h].
///           * `getPrice` now fails closed on staleness instead of returning a
///             stale quote and trusting the caller to look at `updatedAt`.
///             `STALE_THRESHOLD()` is kept as a deprecated alias so existing
///             ABIs and readers keep working.
contract ChainlinkOracleAdapter is Ownable {
    uint256 public constant MIN_STALE_THRESHOLD = 5 minutes;
    uint256 public constant MAX_STALE_THRESHOLD = 24 hours;

    /// @notice Quotes older than this are refused. Default 1h.
    uint256 public staleThreshold = 1 hours;

    mapping(bytes32 => address) public feeds; // assetId → Chainlink aggregator

    event FeedSet(bytes32 indexed assetId, address indexed feed);
    event StaleThresholdSet(uint256 oldValue, uint256 newValue);

    error FeedNotSet(bytes32 assetId);
    error InvalidPrice();
    error IncompleteRound(uint80 roundId, uint80 answeredInRound);
    error InvalidTimestamp();
    error PriceIsStale(bytes32 assetId, uint256 updatedAt, uint256 threshold);
    error InvalidParam();

    constructor() Ownable(msg.sender) {}

    /// @notice Map an asset to a Chainlink aggregator (or address(0) to unset).
    function setFeed(bytes32 assetId, address feed) external onlyOwner {
        feeds[assetId] = feed;
        emit FeedSet(assetId, feed);
    }

    function setStaleThreshold(uint256 threshold) external onlyOwner {
        if (threshold < MIN_STALE_THRESHOLD || threshold > MAX_STALE_THRESHOLD) {
            revert InvalidParam();
        }
        emit StaleThresholdSet(staleThreshold, threshold);
        staleThreshold = threshold;
    }

    /// @notice Deprecated alias kept for ABI/reader compatibility.
    function STALE_THRESHOLD() external view returns (uint256) {
        return staleThreshold;
    }

    /// @notice 8-decimal price + feed updatedAt. Fails closed on a bad feed, an
    ///         incomplete round, or a stale quote.
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        address feed = feeds[assetId];
        if (feed == address(0)) revert FeedNotSet(assetId);

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        (uint80 roundId, int256 answer, , uint256 ts, uint80 answeredInRound) = agg.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (ts == 0 || ts > block.timestamp) revert InvalidTimestamp();
        if (answeredInRound < roundId) revert IncompleteRound(roundId, answeredInRound);
        if (block.timestamp - ts > staleThreshold) revert PriceIsStale(assetId, ts, staleThreshold);

        price = _normalizeTo8(uint256(answer), agg.decimals());
        // A high-decimal feed quoting a sub-1e-8 value truncates to zero. Zero
        // is not a price; returning it would let downstream maths divide by it.
        if (price == 0) revert InvalidPrice();
        updatedAt = ts;
    }

    /// @notice Staleness probe used by the aggregator and by monitoring.
    function isStale(bytes32 assetId) external view returns (bool) {
        address feed = feeds[assetId];
        if (feed == address(0)) revert FeedNotSet(assetId);
        (uint80 roundId, int256 answer, , uint256 ts, uint80 answeredInRound) =
            AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || ts == 0 || answeredInRound < roundId) return true;
        if (ts > block.timestamp) return true;
        return block.timestamp - ts > staleThreshold;
    }

    /// @dev Normalize an arbitrary-decimal feed answer to 8 decimals.
    function _normalizeTo8(uint256 v, uint8 dec) internal pure returns (uint256) {
        if (dec == 8) return v;
        if (dec > 8)  return v / (10 ** (uint256(dec) - 8));
        return v * (10 ** (8 - uint256(dec)));
    }
}
