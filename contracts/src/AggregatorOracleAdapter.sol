// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Common shape of every PepeLab oracle adapter (MockOracle,
///         ChainlinkOracleAdapter, PythOracleAdapter): an 8-decimal price plus
///         the source's `updatedAt`, and a staleness probe. This aggregator
///         consumes two such sources and is itself a drop-in `IOracle`.
interface IOracleSource {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
    function isStale(bytes32 assetId) external view returns (bool);
}

/// @notice RWA-grade oracle: aggregates two underlying adapters (e.g. a
///         Chainlink-backed source and a Pyth-backed source) behind the **same
///         `IOracle` interface as MockOracle** (`getPrice` → 8-decimal price +
///         updatedAt, plus `isStale`). `PerpetualExchange` can therefore be
///         deployed against it with **zero core changes** — just point the
///         exchange's `oracle` at this adapter.
///
///         Robustness rules, evaluated per read:
///           1. Each source may be unconfigured/reverting for a given asset
///              (e.g. Chainlink testnet lacks an equity feed). Such a source is
///              skipped, so the aggregator **degrades to the single live source**.
///           2. When **both** sources are live and fresh, their prices must agree
///              within `maxDeviationBps`. A larger spread means one feed is
///              compromised, so the read is treated as untrustworthy and
///              `getPrice` reverts `PriceDeviationTooHigh` (fail-closed, like the
///              exchange's existing `StalePrice` guard blocks the trade).
///              `isStale` reports true for the same condition, so monitoring
///              readers can detect the divergence without reverting.
///           3. With both sources fresh and in agreement, the **newer** price is
///              returned (freshest mark), and `isStale` is false.
///           4. If neither source is live, `getPrice` reverts `NoLiveSource`.
contract AggregatorOracleAdapter is Ownable {
    IOracleSource public immutable sourceA;
    IOracleSource public immutable sourceB;

    /// @notice Max tolerated divergence between the two sources, in basis points
    ///         of the lower price. Default 100 = 1%. Owner-adjustable.
    uint256 public maxDeviationBps = 100;

    event MaxDeviationBpsSet(uint256 oldBps, uint256 newBps);

    error NoLiveSource(bytes32 assetId);
    error PriceDeviationTooHigh(bytes32 assetId, uint256 priceA, uint256 priceB);

    constructor(address _sourceA, address _sourceB) Ownable(msg.sender) {
        require(_sourceA != address(0) && _sourceB != address(0), "zero source");
        sourceA = IOracleSource(_sourceA);
        sourceB = IOracleSource(_sourceB);
    }

    /// @notice Set the max cross-source deviation (bps). onlyOwner, like the
    ///         other adapters' config setters.
    function setMaxDeviationBps(uint256 bps) external onlyOwner {
        require(bps > 0, "zero deviation");
        emit MaxDeviationBpsSet(maxDeviationBps, bps);
        maxDeviationBps = bps;
    }

    /// @notice 8-decimal aggregated price + updatedAt. See contract docs for the
    ///         degrade / deviation rules. Reverts only when no source is live.
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        (bool okA, uint256 pA, uint256 tA) = _probe(sourceA, assetId);
        (bool okB, uint256 pB, uint256 tB) = _probe(sourceB, assetId);

        if (okA && okB) {
            // Both live: enforce agreement, otherwise fail closed.
            if (_deviationExceeded(pA, pB)) revert PriceDeviationTooHigh(assetId, pA, pB);
            // Agreed: take the newer (freshest) quote.
            return tA >= tB ? (pA, tA) : (pB, tB);
        }
        if (okA) return (pA, tA);
        if (okB) return (pB, tB);
        revert NoLiveSource(assetId);
    }

    /// @notice Stale when no source is live, or when both are live but diverge
    ///         beyond `maxDeviationBps`. Mirrors the other adapters' `isStale`.
    function isStale(bytes32 assetId) external view returns (bool) {
        (bool okA, uint256 pA, ) = _probe(sourceA, assetId);
        (bool okB, uint256 pB, ) = _probe(sourceB, assetId);
        if (okA && okB) return _deviationExceeded(pA, pB);
        return !(okA || okB);
    }

    /// @dev A source is "live" for an asset when getPrice succeeds, returns a
    ///      positive price, and the source itself does not report it stale.
    function _probe(IOracleSource src, bytes32 assetId)
        internal
        view
        returns (bool ok, uint256 price, uint256 updatedAt)
    {
        try src.getPrice(assetId) returns (uint256 p, uint256 t) {
            if (p == 0) return (false, 0, 0);
            try src.isStale(assetId) returns (bool stale) {
                if (stale) return (false, 0, 0);
            } catch {
                return (false, 0, 0);
            }
            return (true, p, t);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev True when |a-b| exceeds maxDeviationBps of the lower price.
    function _deviationExceeded(uint256 a, uint256 b) internal view returns (bool) {
        uint256 hi = a >= b ? a : b;
        uint256 lo = a >= b ? b : a;
        if (lo == 0) return true;
        return (hi - lo) * 10_000 > maxDeviationBps * lo;
    }
}
