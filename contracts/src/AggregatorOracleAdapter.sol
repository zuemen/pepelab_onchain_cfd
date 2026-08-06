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

/// @notice Errors a source raises when it is *deliberately* refusing to serve —
///         as opposed to being unconfigured or broken. Declared here purely so
///         their selectors can be recognised in a `catch`.
/// @dev    Matches `v2/GuardedOracle`'s `AssetIsFrozen` / `IsPaused`.
interface IFailClosedSource {
    error AssetIsFrozen(bytes32 assetId);
    error IsPaused();
}

/// @notice RWA-grade oracle: aggregates two underlying adapters (e.g. a
///         Chainlink-backed source and a Pyth-backed source) behind the **same
///         `IOracle` interface as MockOracle**. `PerpetualExchange` can be
///         deployed against it with zero core changes.
///
///         Rules, evaluated per read:
///
///           1. **Single-source degradation is opt-in** (`allowSingleSource`,
///              default false). See PA-7 below.
///           2. **Two-tier disagreement handling.** With both sources live:
///                - within `maxDeviationBps` → agreement, serve the fresher
///                  quote;
///                - beyond `maxDeviationBps` but within `haltDeviationBps` →
///                  **degraded**: still serve the fresher quote, and report it
///                  through `isDegraded` / `isStale`;
///                - beyond `haltDeviationBps` → fail closed with
///                  `PriceDeviationTooHigh`.
///           3. If no source is usable, `getPrice` reverts `NoLiveSource`.
///
/// @dev    Audit 2026-08-06:
///
///         **PA-7 — single-source degradation was fail-open.** The old contract
///         silently served whichever source happened to answer. That turns the
///         entire two-source design into decoration the moment one feed is
///         misconfigured: `DeployWithPyth.s.sol` never called `setFeed`, so on
///         the live deployment the "dual-source aggregator" was a bare Pyth
///         passthrough and `maxDeviationBps` never once ran. Degrading to one
///         source is now an explicit, owner-set decision.
///
///         **PA-7 (second half) — `_probe`'s catch swallowed the kill switch.**
///         `GuardedOracle.getPrice` reverts `AssetIsFrozen` when a guardian
///         freezes an asset; that is the emergency stop. The old catch-all
///         `catch { return (false, ...) }` read that as "source down" and
///         happily served the *other* source, so freezing an asset achieved
///         nothing as long as one feed still answered. `_probe` now inspects
///         the revert selector and re-raises deliberate fail-closed refusals,
///         while genuine unavailability (unset feed, reverting call, stale
///         quote) still degrades.
///
///         **M-1 — the deviation revert also blocked liquidations.** A hard
///         revert on a 1% cross-source spread is fine for *opening* risk and
///         catastrophic for *reducing* it: during exactly the volatility that
///         makes two feeds disagree, `closePosition` and `liquidatePosition`
///         read the same `oracle.getPrice` and reverted too, so nobody could
///         cut risk and no liquidator could act. Positions would sit past
///         bankruptcy until the feeds reconverged.
///
///         Of the two remedies the audit offered, a liquidation-only relaxed
///         path is not implementable from here: `PerpetualExchange` is
///         immutable-wired to a single `IOracle` and calls the same `getPrice`
///         for every action, and this work stream may not modify the exchange.
///         So: **degraded mode**. A 1-5% spread is ordinary volatility noise —
///         serve the fresher quote, keep the system liquid, and surface the
///         condition through `isDegraded()`/`isStale()` for monitoring and for
///         the vault ratio checks that already read `isStale`. A spread beyond
///         `haltDeviationBps` (default 20%) is not noise — one feed is
///         compromised or broken — and there the fail-closed revert is kept.
contract AggregatorOracleAdapter is Ownable {
    IOracleSource public immutable sourceA;
    IOracleSource public immutable sourceB;

    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Spread above which the aggregate is marked *degraded* (still
    ///         served). Default 100 = 1%.
    uint256 public maxDeviationBps = 100;

    /// @notice Spread above which the aggregate fails closed. Default 2000 =
    ///         20%. Must always be >= maxDeviationBps.
    uint256 public haltDeviationBps = 2_000;

    /// @notice Whether a single live source may serve the price on its own.
    ///         Default false: fail closed rather than silently become a
    ///         single-feed oracle (PA-7).
    bool public allowSingleSource;

    event MaxDeviationBpsSet(uint256 oldBps, uint256 newBps);
    event HaltDeviationBpsSet(uint256 oldBps, uint256 newBps);
    event AllowSingleSourceSet(bool allowed);

    error NoLiveSource(bytes32 assetId);
    error SingleSourceNotAllowed(bytes32 assetId);
    error PriceDeviationTooHigh(bytes32 assetId, uint256 priceA, uint256 priceB);
    error InvalidParam();

    constructor(address _sourceA, address _sourceB) Ownable(msg.sender) {
        require(_sourceA != address(0) && _sourceB != address(0), "zero source");
        sourceA = IOracleSource(_sourceA);
        sourceB = IOracleSource(_sourceB);
    }

    // ── config ───────────────────────────────────────────────────────────────

    function setMaxDeviationBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > haltDeviationBps) revert InvalidParam();
        emit MaxDeviationBpsSet(maxDeviationBps, bps);
        maxDeviationBps = bps;
    }

    function setHaltDeviationBps(uint256 bps) external onlyOwner {
        if (bps < maxDeviationBps || bps > BPS_DENOM) revert InvalidParam();
        emit HaltDeviationBpsSet(haltDeviationBps, bps);
        haltDeviationBps = bps;
    }

    /// @notice Opt in to serving a price from one source when the other is
    ///         unavailable. Off by default — turning it on is a conscious
    ///         acceptance that the cross-check is not running.
    function setAllowSingleSource(bool allowed) external onlyOwner {
        allowSingleSource = allowed;
        emit AllowSingleSourceSet(allowed);
    }

    // ── reads ────────────────────────────────────────────────────────────────

    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        (bool okA, uint256 pA, uint256 tA) = _probe(sourceA, assetId);
        (bool okB, uint256 pB, uint256 tB) = _probe(sourceB, assetId);

        if (okA && okB) {
            // Hard divergence: one feed is broken, not merely noisy.
            if (_deviationExceeded(pA, pB, haltDeviationBps)) {
                revert PriceDeviationTooHigh(assetId, pA, pB);
            }
            // Agreed, or degraded-but-usable: take the fresher quote either way.
            return tA >= tB ? (pA, tA) : (pB, tB);
        }

        if (okA || okB) {
            if (!allowSingleSource) revert SingleSourceNotAllowed(assetId);
            return okA ? (pA, tA) : (pB, tB);
        }
        revert NoLiveSource(assetId);
    }

    /// @notice Stale when the aggregate is not fully trustworthy: no usable
    ///         source, a single source while that is not allowed, or a
    ///         degraded (soft-divergent) read.
    function isStale(bytes32 assetId) external view returns (bool) {
        (bool okA, uint256 pA, ) = _probe(sourceA, assetId);
        (bool okB, uint256 pB, ) = _probe(sourceB, assetId);
        if (okA && okB) return _deviationExceeded(pA, pB, maxDeviationBps);
        if (okA || okB) return !allowSingleSource;
        return true;
    }

    /// @notice True when both sources are live but disagree beyond
    ///         `maxDeviationBps` — the price is still served, but it is one of
    ///         two numbers that cannot both be right.
    function isDegraded(bytes32 assetId) external view returns (bool) {
        (bool okA, uint256 pA, ) = _probe(sourceA, assetId);
        (bool okB, uint256 pB, ) = _probe(sourceB, assetId);
        if (!(okA && okB)) return false;
        return _deviationExceeded(pA, pB, maxDeviationBps)
            && !_deviationExceeded(pA, pB, haltDeviationBps);
    }

    /// @notice Per-source health, for dashboards and keeper alerting.
    function sourceStatus(bytes32 assetId)
        external view
        returns (bool liveA, uint256 priceA, bool liveB, uint256 priceB)
    {
        uint256 t;
        (liveA, priceA, t) = _probe(sourceA, assetId);
        (liveB, priceB, t) = _probe(sourceB, assetId);
    }

    // ── internal ─────────────────────────────────────────────────────────────

    /// @dev A source is "live" for an asset when getPrice succeeds, returns a
    ///      positive price, and the source itself does not report it stale.
    ///      A source that refuses *deliberately* (frozen / paused) is not
    ///      "down": that refusal is propagated so the emergency stop cannot be
    ///      routed around by the other source.
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
        } catch (bytes memory reason) {
            _bubbleFailClosed(reason);
            return (false, 0, 0);
        }
    }

    /// @dev Re-raises the original revert when it is a deliberate refusal.
    function _bubbleFailClosed(bytes memory reason) internal pure {
        if (reason.length < 4) return;
        bytes4 sel;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sel := mload(add(reason, 0x20))
        }
        if (sel == IFailClosedSource.AssetIsFrozen.selector || sel == IFailClosedSource.IsPaused.selector) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// @dev True when |a-b| exceeds `bps` of the lower price.
    function _deviationExceeded(uint256 a, uint256 b, uint256 bps) internal pure returns (bool) {
        uint256 hi = a >= b ? a : b;
        uint256 lo = a >= b ? b : a;
        if (lo == 0) return true;
        return (hi - lo) * BPS_DENOM > bps * lo;
    }
}
