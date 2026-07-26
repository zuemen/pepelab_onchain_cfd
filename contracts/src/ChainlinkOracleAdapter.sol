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
///         changes** — the exchange's `oracle` is an immutable `IOracle` set in
///         the constructor; deploy the exchange pointing at this adapter instead
///         of MockOracle.
///
///         Each asset maps to a Chainlink aggregator; feeds with non-8 decimals
///         are normalized to 8 (MockOracle's convention). Assets without a
///         configured feed revert `FeedNotSet`. On-chain staleness is still
///         enforced by the exchange's `maxPriceAge`; `isStale` here mirrors
///         MockOracle's 24h threshold for parity with existing readers.
contract ChainlinkOracleAdapter is Ownable {
    uint256 public constant STALE_THRESHOLD = 86400; // 24h, matches MockOracle

    mapping(bytes32 => address) public feeds; // assetId → Chainlink aggregator

    event FeedSet(bytes32 indexed assetId, address indexed feed);

    error FeedNotSet(bytes32 assetId);
    error InvalidPrice();

    constructor() Ownable(msg.sender) {}

    /// @notice Map an asset to a Chainlink aggregator (or address(0) to unset).
    function setFeed(bytes32 assetId, address feed) external onlyOwner {
        feeds[assetId] = feed;
        emit FeedSet(assetId, feed);
    }

    /// @notice 8-decimal price + feed updatedAt. Reverts if no feed or bad price.
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        address feed = feeds[assetId];
        if (feed == address(0)) revert FeedNotSet(assetId);

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        (, int256 answer, , uint256 ts, ) = agg.latestRoundData();
        if (answer <= 0) revert InvalidPrice();

        price     = _normalizeTo8(uint256(answer), agg.decimals());
        updatedAt = ts;
    }

    /// @notice Mirrors MockOracle.isStale (24h threshold) for reader parity.
    function isStale(bytes32 assetId) external view returns (bool) {
        address feed = feeds[assetId];
        if (feed == address(0)) revert FeedNotSet(assetId);
        (, , , uint256 ts, ) = AggregatorV3Interface(feed).latestRoundData();
        return block.timestamp - ts > STALE_THRESHOLD;
    }

    /// @dev Normalize an arbitrary-decimal feed answer to 8 decimals.
    function _normalizeTo8(uint256 v, uint8 dec) internal pure returns (uint256) {
        if (dec == 8) return v;
        if (dec > 8)  return v / (10 ** (uint256(dec) - 8));
        return v * (10 ** (8 - uint256(dec)));
    }
}
