// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal Pyth interface (pull-based oracle). Prices are pushed
///         on-chain by `updatePriceFeeds` (payable, off-chain keeper) and read
///         here via the view `getPriceUnsafe`.
interface IPyth {
    struct Price {
        int64  price;       // price * 10^expo
        uint64 conf;        // confidence interval, same units as `price`
        int32  expo;        // exponent (usually negative, e.g. -8)
        uint256 publishTime;
    }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice Production oracle: drop-in `IOracle` replacement backed by Pyth
///         feeds. Same interface as MockOracle (`getPrice` → 8-decimal price +
///         updatedAt, and `isStale`), so `PerpetualExchange` can be deployed
///         against it with **zero core changes**. Complements
///         ChainlinkOracleAdapter: Pyth has feeds for synthetic / equity assets
///         (e.g. AAPL, TSLA) that Chainlink testnets lack.
///
/// @dev    Audit 2026-08-06 (Medium, oracle layer):
///           * The confidence interval was read into the struct and thrown
///             away. `conf` is Pyth's own statement of how much it trusts the
///             number; during a halt, a thin book, or a feed under stress it
///             widens dramatically while `price` stays superficially sane. A
///             quote whose confidence exceeds `maxConfBps` of the price is now
///             refused.
///           * `getPriceUnsafe` + "the caller will check the timestamp" is the
///             same fail-open shape the rest of the audit flagged. Pyth's
///             `getPriceNoOlderThan(id, age)` is the time-checked API; rather
///             than depend on which Pyth version is deployed, the equivalent
///             check is enforced here against this adapter's own owner-tunable
///             `staleThreshold`, which keeps a single source of truth for the
///             threshold and works against every Pyth deployment.
///           * `staleThreshold` was a 24h constant. Default is now 1h,
///             adjustable inside [5 min, 24 h]. `STALE_THRESHOLD()` remains as
///             a deprecated alias for existing ABIs.
contract PythOracleAdapter is Ownable {
    uint256 public constant MIN_STALE_THRESHOLD = 5 minutes;
    uint256 public constant MAX_STALE_THRESHOLD = 24 hours;
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Quotes older than this are refused. Default 1h.
    uint256 public staleThreshold = 1 hours;

    /// @notice Max tolerated `conf / price`, in bps. Default 100 = 1%.
    uint256 public maxConfBps = 100;

    IPyth public immutable pyth;
    mapping(bytes32 => bytes32) public priceIds; // assetId → Pyth price id

    event PriceIdSet(bytes32 indexed assetId, bytes32 priceId);
    event StaleThresholdSet(uint256 oldValue, uint256 newValue);
    event MaxConfBpsSet(uint256 oldValue, uint256 newValue);

    error PriceIdNotSet(bytes32 assetId);
    error InvalidPrice();
    error InvalidTimestamp();
    error PriceIsStale(bytes32 assetId, uint256 publishTime, uint256 threshold);
    error ConfidenceTooWide(bytes32 assetId, uint256 conf, uint256 price);
    error InvalidParam();

    constructor(address _pyth) Ownable(msg.sender) {
        pyth = IPyth(_pyth);
    }

    /// @notice Map an asset to a Pyth price id (or bytes32(0) to unset).
    function setPriceId(bytes32 assetId, bytes32 priceId) external onlyOwner {
        priceIds[assetId] = priceId;
        emit PriceIdSet(assetId, priceId);
    }

    function setStaleThreshold(uint256 threshold) external onlyOwner {
        if (threshold < MIN_STALE_THRESHOLD || threshold > MAX_STALE_THRESHOLD) {
            revert InvalidParam();
        }
        emit StaleThresholdSet(staleThreshold, threshold);
        staleThreshold = threshold;
    }

    function setMaxConfBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > BPS_DENOM) revert InvalidParam();
        emit MaxConfBpsSet(maxConfBps, bps);
        maxConfBps = bps;
    }

    /// @notice Deprecated alias kept for ABI/reader compatibility.
    function STALE_THRESHOLD() external view returns (uint256) {
        return staleThreshold;
    }

    /// @notice 8-decimal price + Pyth publishTime. Fails closed on a bad
    ///         quote, a wide confidence interval, or a stale publish time.
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        bytes32 id = priceIds[assetId];
        if (id == bytes32(0)) revert PriceIdNotSet(assetId);

        IPyth.Price memory p = pyth.getPriceUnsafe(id);
        if (p.price <= 0) revert InvalidPrice();
        if (p.publishTime == 0 || p.publishTime > block.timestamp) revert InvalidTimestamp();
        if (block.timestamp - p.publishTime > staleThreshold) {
            revert PriceIsStale(assetId, p.publishTime, staleThreshold);
        }

        // `conf` and `price` share the same exponent, so the ratio can be taken
        // on the raw mantissas without normalising either.
        uint256 mantissa = uint256(uint64(p.price));
        if (uint256(p.conf) * BPS_DENOM > maxConfBps * mantissa) {
            revert ConfidenceTooWide(assetId, p.conf, mantissa);
        }

        price = _normalizeTo8(mantissa, p.expo);
        // A very negative exponent on a tiny mantissa truncates to zero; zero
        // is not a price.
        if (price == 0) revert InvalidPrice();
        updatedAt = p.publishTime;
    }

    /// @notice Staleness probe used by the aggregator and by monitoring. Also
    ///         reports true for a quote whose confidence is too wide to trust.
    function isStale(bytes32 assetId) external view returns (bool) {
        bytes32 id = priceIds[assetId];
        if (id == bytes32(0)) revert PriceIdNotSet(assetId);
        IPyth.Price memory p = pyth.getPriceUnsafe(id);
        if (p.price <= 0 || p.publishTime == 0 || p.publishTime > block.timestamp) return true;
        if (uint256(p.conf) * BPS_DENOM > maxConfBps * uint256(uint64(p.price))) return true;
        return block.timestamp - p.publishTime > staleThreshold;
    }

    /// @dev Normalize a Pyth (mantissa, expo) price to 8 decimals.
    ///      value = mantissa * 10^expo ; want 8-dec → scale by 10^(expo + 8).
    function _normalizeTo8(uint256 mantissa, int32 expo) internal pure returns (uint256) {
        int256 e = int256(expo) + 8;
        if (e >= 0) return mantissa * (10 ** uint256(e));
        return mantissa / (10 ** uint256(-e));
    }
}
