// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "./PerpetualExchange.sol";

/// @notice Read-only helpers for `PerpetualExchange` that the exchange itself
///         never uses, kept out of its bytecode (EIP-170). Every function
///         reads the exchange through its public getters. Parameters are plain
///         `address` so the ABI is standard (callable from viem/ethers via
///         eth_call on the deployed library, or linked into another contract).
library PerpetualExchangeLens {
    /// @notice Open interest of `asset` valued at the current oracle index
    ///         price — the quantity `maxLongOI` / `maxShortOI` bound at open
    ///         (Σ open size × index). Returns zeros while the feed reports a
    ///         zero price.
    function openInterestValue(address exchange, bytes32 asset)
        external
        view
        returns (uint256 longValue, uint256 shortValue)
    {
        PerpetualExchange ex = PerpetualExchange(exchange);
        (uint256 rawPrice,) = ex.oracle().getPrice(asset);
        uint256 price = rawPrice * 1e10;
        longValue  = ex.longOpenSize(asset)  * price / 1e18;
        shortValue = ex.shortOpenSize(asset) * price / 1e18;
    }

    /// @notice True when `asset`'s feed is non-zero and within the exchange's
    ///         `maxPriceAge`. The exchange's views return conservative values
    ///         instead of reverting when it is not (a zero price reads as a
    ///         total loss, never a gain); this tells a caller which it is
    ///         looking at.
    function hasValidPrice(address exchange, bytes32 asset) external view returns (bool) {
        PerpetualExchange ex = PerpetualExchange(exchange);
        (uint256 rawPrice, uint256 updatedAt) = ex.oracle().getPrice(asset);
        // forge-lint: disable-next-line(block-timestamp)
        return rawPrice != 0 && block.timestamp <= updatedAt + ex.maxPriceAge();
    }
}
