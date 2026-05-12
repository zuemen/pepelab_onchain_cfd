// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MockOracle is Ownable {
    struct Asset {
        uint256 price;        // 8 decimals (e.g. 1e8 = $1.00)
        uint256 updatedAt;
        bool exists;
    }

    uint256 public constant STALE_THRESHOLD = 86400;   // 24 hours

    mapping(bytes32 => Asset) private _assets;

    event PriceUpdated(bytes32 indexed assetId, uint256 oldPrice, uint256 newPrice, uint256 timestamp);
    event AssetAdded(bytes32 indexed assetId, uint256 initialPrice);

    error AssetNotFound(bytes32 assetId);
    error AssetAlreadyExists(bytes32 assetId);
    error InvalidPrice();

    constructor() Ownable(msg.sender) {}

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
        return block.timestamp - asset.updatedAt > STALE_THRESHOLD;
    }
}
