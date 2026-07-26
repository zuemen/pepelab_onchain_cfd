// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/PythOracleAdapter.sol";

/// @notice Test helper mimicking a Pyth pull-oracle's read path.
contract MockPyth is IPyth {
    mapping(bytes32 => Price) private _prices;

    function setPrice(bytes32 id, int64 price, int32 expo) external {
        _prices[id] = Price({
            price:       price,
            conf:        0,
            expo:        expo,
            publishTime: block.timestamp
        });
    }

    function setPublishTime(bytes32 id, uint256 ts) external {
        _prices[id].publishTime = ts;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        return _prices[id];
    }
}
