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
///
///         2026-10-07 (opt-in, defaults keep the old behaviour):
///           * L2 sequencer uptime. On an L2 (Base) a sequencer outage freezes
///             every feed, and the first prices after it resumes can be posted
///             before anyone has had a chance to react. With
///             `sequencerUptimeFeed` set, reads revert while the sequencer is
///             reported down and for `sequencerGracePeriod` after it comes back
///             (Chainlink's documented L2 pattern), and `isStale` reports true.
///           * Per-feed max age. One global threshold either refuses a healthy
///             slow-heartbeat feed or lets a fast one go hours stale.
///             `maxAgeOf[assetId]` overrides `staleThreshold` for that asset.
contract ChainlinkOracleAdapter is Ownable {
    uint256 public constant MIN_STALE_THRESHOLD = 5 minutes;
    uint256 public constant MAX_STALE_THRESHOLD = 24 hours;

    /// @notice Quotes older than this are refused. Default 1h.
    uint256 public staleThreshold = 1 hours;

    mapping(bytes32 => address) public feeds; // assetId → Chainlink aggregator

    /// @notice Per-asset max quote age; 0 = use `staleThreshold`. Bounded like
    ///         `staleThreshold`.
    mapping(bytes32 => uint256) public maxAgeOf;

    /// @notice Chainlink L2 sequencer uptime feed (answer 0 = up, 1 = down;
    ///         `startedAt` = when that status began). address(0) = not checked
    ///         (L1, or not configured).
    address public sequencerUptimeFeed;

    /// @notice After the sequencer comes back up, reads keep reverting this long.
    uint256 public sequencerGracePeriod = 1 hours;

    event FeedSet(bytes32 indexed assetId, address indexed feed);
    event StaleThresholdSet(uint256 oldValue, uint256 newValue);
    event MaxAgeSet(bytes32 indexed assetId, uint256 maxAge);
    event SequencerUptimeFeedSet(address indexed feed, uint256 gracePeriod);

    error FeedNotSet(bytes32 assetId);
    error InvalidPrice();
    error IncompleteRound(uint80 roundId, uint80 answeredInRound);
    error InvalidTimestamp();
    error PriceIsStale(bytes32 assetId, uint256 updatedAt, uint256 threshold);
    error InvalidParam();
    error SequencerDown();
    error SequencerGracePeriod(uint256 resumedAt, uint256 gracePeriod);
    error SequencerStatusInvalid();

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

    /// @notice Per-asset max age (0 clears the override). Same bounds as
    ///         `setStaleThreshold`.
    function setMaxAge(bytes32 assetId, uint256 maxAge) external onlyOwner {
        if (maxAge != 0 && (maxAge < MIN_STALE_THRESHOLD || maxAge > MAX_STALE_THRESHOLD)) revert InvalidParam();
        maxAgeOf[assetId] = maxAge;
        emit MaxAgeSet(assetId, maxAge);
    }

    /// @notice Enable (or disable with address(0)) the L2 sequencer check.
    ///         The grace period is bounded to [5 min, 24 h].
    function setSequencerUptimeFeed(address feed, uint256 gracePeriod) external onlyOwner {
        if (gracePeriod < MIN_STALE_THRESHOLD || gracePeriod > MAX_STALE_THRESHOLD) revert InvalidParam();
        sequencerUptimeFeed = feed;
        sequencerGracePeriod = gracePeriod;
        emit SequencerUptimeFeedSet(feed, gracePeriod);
    }

    /// @notice The max age actually applied to `assetId`.
    function effectiveMaxAge(bytes32 assetId) public view returns (uint256) {
        uint256 m = maxAgeOf[assetId];
        return m == 0 ? staleThreshold : m;
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
        _requireSequencerUp();

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        (uint80 roundId, int256 answer, , uint256 ts, uint80 answeredInRound) = agg.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (ts == 0 || ts > block.timestamp) revert InvalidTimestamp();
        if (answeredInRound < roundId) revert IncompleteRound(roundId, answeredInRound);
        uint256 maxAge = effectiveMaxAge(assetId);
        if (block.timestamp - ts > maxAge) revert PriceIsStale(assetId, ts, maxAge);

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
        if (!_sequencerUp()) return true;
        return block.timestamp - ts > effectiveMaxAge(assetId);
    }

    /// @dev Reverts while the sequencer is down, its status is unreadable, or
    ///      it came back less than `sequencerGracePeriod` ago. No-op when no
    ///      uptime feed is configured.
    function _requireSequencerUp() internal view {
        address f = sequencerUptimeFeed;
        if (f == address(0)) return;
        (, int256 status, uint256 startedAt, , ) = AggregatorV3Interface(f).latestRoundData();
        // startedAt == 0: the uptime feed has no valid round yet; a status in
        // the future cannot be real. Neither tells us the sequencer is up.
        if (startedAt == 0 || startedAt > block.timestamp) revert SequencerStatusInvalid();
        if (status != 0) revert SequencerDown();
        if (block.timestamp - startedAt <= sequencerGracePeriod) {
            revert SequencerGracePeriod(startedAt, sequencerGracePeriod);
        }
    }

    function _sequencerUp() internal view returns (bool) {
        address f = sequencerUptimeFeed;
        if (f == address(0)) return true;
        try AggregatorV3Interface(f).latestRoundData() returns (uint80, int256 status, uint256 startedAt, uint256, uint80) {
            if (startedAt == 0 || startedAt > block.timestamp || status != 0) return false;
            return block.timestamp - startedAt > sequencerGracePeriod;
        } catch {
            return false;
        }
    }

    /// @dev Normalize an arbitrary-decimal feed answer to 8 decimals.
    function _normalizeTo8(uint256 v, uint8 dec) internal pure returns (uint256) {
        if (dec == 8) return v;
        if (dec > 8)  return v / (10 ** (uint256(dec) - 8));
        return v * (10 ** (8 - uint256(dec)));
    }
}
