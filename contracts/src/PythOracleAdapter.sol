// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal Pyth interface (pull-based oracle). Prices are pushed on-chain
///         by `updatePriceFeeds` (payable, off-chain keeper) and read here via the
///         view `getPriceUnsafe`. Staleness is handled by the exchange's
///         `maxPriceAge` plus this adapter's `isStale`.
interface IPyth {
    struct Price {
        int64  price;       // price * 10^expo
        uint64 conf;        // confidence interval
        int32  expo;        // exponent (usually negative, e.g. -8)
        uint256 publishTime;
    }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice Production oracle: drop-in `IOracle` replacement backed by Pyth feeds.
///         Same interface as MockOracle (`getPrice` → 8-decimal price + updatedAt,
///         and `isStale`), so `PerpetualExchange` can be deployed against it with
///         **zero core changes**. Complements ChainlinkOracleAdapter: Pyth has
///         feeds for synthetic / equity assets (e.g. AAPL, TSLA) that Chainlink
///         testnets lack.
///
///         Each asset maps to a Pyth price id; the adapter normalizes Pyth's
///         exponent-encoded price to 8 decimals (MockOracle's convention).
contract PythOracleAdapter is Ownable {
    uint256 public constant STALE_THRESHOLD = 86400; // 24h, matches MockOracle

    IPyth public immutable pyth;
    mapping(bytes32 => bytes32) public priceIds; // assetId → Pyth price id

    event PriceIdSet(bytes32 indexed assetId, bytes32 priceId);

    error PriceIdNotSet(bytes32 assetId);
    error InvalidPrice();

    constructor(address _pyth) Ownable(msg.sender) {
        pyth = IPyth(_pyth);
    }

    /// @notice Map an asset to a Pyth price id (or bytes32(0) to unset).
    function setPriceId(bytes32 assetId, bytes32 priceId) external onlyOwner {
        priceIds[assetId] = priceId;
        emit PriceIdSet(assetId, priceId);
    }

    /// @notice 8-decimal price + Pyth publishTime. Reverts if no id or bad price.
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        bytes32 id = priceIds[assetId];
        if (id == bytes32(0)) revert PriceIdNotSet(assetId);

        IPyth.Price memory p = pyth.getPriceUnsafe(id);
        if (p.price <= 0) revert InvalidPrice();

        price     = _normalizeTo8(uint256(uint64(p.price)), p.expo);
        updatedAt = p.publishTime;
    }

    /// @notice Mirrors MockOracle.isStale (24h threshold) for reader parity.
    function isStale(bytes32 assetId) external view returns (bool) {
        bytes32 id = priceIds[assetId];
        if (id == bytes32(0)) revert PriceIdNotSet(assetId);
        IPyth.Price memory p = pyth.getPriceUnsafe(id);
        return block.timestamp - p.publishTime > STALE_THRESHOLD;
    }

    /// @dev Normalize a Pyth (mantissa, expo) price to 8 decimals.
    ///      value = mantissa * 10^expo ; want 8-dec → scale by 10^(expo + 8).
    function _normalizeTo8(uint256 mantissa, int32 expo) internal pure returns (uint256) {
        int256 e = int256(expo) + 8;
        if (e >= 0) return mantissa * (10 ** uint256(e));
        return mantissa / (10 ** uint256(-e));
    }
}
