// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MockOracle is Ownable {
    struct Asset {
        uint256 price;        // 8 decimals (e.g. 1e8 = $1.00)
        uint256 updatedAt;
        bool exists;
    }

    uint256 public constant MIN_STALE_THRESHOLD = 5 minutes;
    uint256 public constant MAX_STALE_THRESHOLD = 24 hours;

    /// @notice Age above which `isStale` reports true.
    /// @dev The default stays at 24h so every existing reader keeps the
    ///      behaviour it was written against — this is the mock, and the
    ///      on-chain protection that actually matters for the exchange is its
    ///      own `maxPriceAge`. It is settable so an operator can tighten it to
    ///      the keeper cadence (the real adapters now default to 1h) without a
    ///      redeploy. Audit 2026-08-06, oracle layer.
    uint256 public staleThreshold = 24 hours;

    mapping(bytes32 => Asset) private _assets;

    event PriceUpdated(bytes32 indexed assetId, uint256 oldPrice, uint256 newPrice, uint256 timestamp);
    event AssetAdded(bytes32 indexed assetId, uint256 initialPrice);
    event StaleThresholdSet(uint256 oldValue, uint256 newValue);

    error AssetNotFound(bytes32 assetId);
    error AssetAlreadyExists(bytes32 assetId);
    error InvalidPrice();
    error InvalidParam();

    constructor() Ownable(msg.sender) {}

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

    function addAsset(bytes32 assetId, uint256 initialPrice) external onlyOwner {
        if (_assets[assetId].exists) revert AssetAlreadyExists(assetId);
        if (initialPrice == 0) revert InvalidPrice();

        _assets[assetId] = Asset({
            price: initialPrice,
            updatedAt: block.timestamp,
            exists: true
        });

        emit AssetAdded(assetId, initialPrice);
    }

    function updatePrice(bytes32 assetId, uint256 newPrice) external onlyOwner {
        Asset storage asset = _assets[assetId];
        if (!asset.exists) revert AssetNotFound(assetId);
        if (newPrice == 0) revert InvalidPrice();

        uint256 oldPrice = asset.price;

        asset.price = newPrice;
        asset.updatedAt = block.timestamp;

        emit PriceUpdated(assetId, oldPrice, newPrice, block.timestamp);
    }

    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        Asset storage asset = _assets[assetId];
        if (!asset.exists) revert AssetNotFound(assetId);
        return (asset.price, asset.updatedAt);
    }

    function isStale(bytes32 assetId) external view returns (bool) {
        Asset storage asset = _assets[assetId];
        if (!asset.exists) revert AssetNotFound(assetId);
        return block.timestamp - asset.updatedAt > staleThreshold;
    }
}
