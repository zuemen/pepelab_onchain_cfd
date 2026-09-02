// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CarbonTiers
/// @notice The single definition of "carbon intensity → holding cost and
///         leverage ceiling" for the whole platform. ADR-003 prices what it
///         costs to hold an asset — and how much leverage it may carry — on
///         Carbon Intensity rather than on an aggregate ESG score, because a
///         composite score is opinion while carbon intensity has a unit and
///         an auditable source. That argument only holds if the rule turning
///         a number into a cost is itself non-discretionary: thresholds
///         below are `internal constant`, not owner-settable storage. A
///         settable threshold is a policy an operator could adjust for one
///         asset without anyone noticing; a constant cannot be.
///
///         `PerpetualExchange` and `CopyTracker` (see #96, #97) must both
///         call into this library rather than each hard-coding their own
///         copy of the fee/leverage numbers — the whole point of a single
///         seam is that there is nowhere else these numbers can live.
///
///         Thresholds and per-tier params are pinned against real, sourced
///         data in docs/data/carbon-intensity.md ("Proposed carbon tiers")
///         and in `contracts/test/CarbonTiers.t.sol`. There is a
///         TypeScript mirror at `frontend/src/lib/pepefi/carbon.ts` with its
///         own pinned test — the two are not linked at compile time, so a
///         threshold changed in one without the other will pass both test
///         suites and silently drift. Anyone changing a threshold here must
///         change it there too.
///
/// @dev    UNITS, AND THE ONE THING THIS LIBRARY DELIBERATELY DOES NOT DO:
///         `carbonIntensity` here is a fixed-point 1e18-scaled figure in
///         tCO2e per $1,000,000 of trailing revenue — the basis used for the
///         five equities and the two ETFs in docs/data/carbon-intensity.md.
///         That basis has no meaning for a commodity or a cryptocurrency,
///         which have no revenue: normalizing Bitcoin's annual emissions by
///         its market capitalization computes to a LOWER figure than Apple's,
///         because market cap is an accumulated valuation (a stock) and not
///         an ongoing output (a flow) — the distortion is documented in
///         detail in docs/data/carbon-intensity.md's "Open questions for
///         #95". This library does not attempt to solve that: `tierOf` must
///         only ever be called with a revenue-basis intensity. Whoever wires
///         a commodity or crypto asset's tier into PerpetualExchange (#96)
///         must assign that asset's `Tier` directly — by whatever basis is
///         defensible for that asset class — rather than feeding a
///         cross-class-normalized number into `tierOf`. Feeding the wrong
///         number in will not revert; it will silently produce a tier that
///         is numerically consistent and substantively wrong, which is
///         exactly the failure mode this NatSpec exists to prevent.
library CarbonTiers {
    /// @notice `Unrated` is reachable only through the explicit `isRated`
    ///         flag on `tierOf`/`paramsForIntensity`, never by a carbon
    ///         intensity value alone — see `tierOf`'s NatSpec for why.
    enum Tier {
        Unrated,
        Low,
        Mid,
        High
    }

    // ── Thresholds — fixed, not settable. See docs/data/carbon-intensity.md ──

    uint256 internal constant ONE_SCALE = 1e18;

    /// @dev Low is "< 1.0 tCO2e/$M revenue".
    uint256 internal constant LOW_MAX_INTENSITY = 1 * ONE_SCALE;

    /// @dev Mid is "1.0 – 8.0 tCO2e/$M revenue" inclusive of both ends;
    ///      anything above this is High.
    uint256 internal constant MID_MAX_INTENSITY = 8 * ONE_SCALE;

    // ── Per-tier params ──────────────────────────────────────────────────────
    //
    // Low sits at PerpetualExchange's CURRENT defaults
    // (TRADING_FEE_BPS = 10, BORROW_FEE_BPS_PER_HOUR = 1, MAX_LEVERAGE = 5) —
    // shipping this must not silently raise the cost of holding an
    // already-lowest-tier asset. High sits exactly at PerpetualExchange's
    // hard ceilings (MAX_TRADING_FEE_BPS = 100, MAX_BORROW_FEE_BPS_PER_HOUR
    // = 10) — the most conservative value the exchange's own bounds allow.
    // Leverage values are drawn from {1, 2, 5} to match
    // StrategyRegistry._validLeverage exactly: a published Allocation can
    // only ever request one of those three, so a tier ceiling outside that
    // set would leave a valid strategy with no valid leverage to fall back
    // to on that asset.

    uint256 internal constant LOW_TRADING_FEE_BPS = 10; // 0.10%
    uint256 internal constant LOW_BORROW_FEE_BPS_PER_HOUR = 1; // 0.01%/h
    uint256 internal constant LOW_MAX_LEVERAGE = 5;

    uint256 internal constant MID_TRADING_FEE_BPS = 40; // 0.40%
    uint256 internal constant MID_BORROW_FEE_BPS_PER_HOUR = 4; // 0.04%/h
    uint256 internal constant MID_MAX_LEVERAGE = 2;

    uint256 internal constant HIGH_TRADING_FEE_BPS = 100; // 1.00% — exchange ceiling
    uint256 internal constant HIGH_BORROW_FEE_BPS_PER_HOUR = 10; // 0.10%/h — exchange ceiling
    uint256 internal constant HIGH_MAX_LEVERAGE = 1;

    /// @notice Maps a revenue-basis carbon intensity to a Tier.
    /// @dev `isRated` must be the caller's own, already-determined answer to
    ///      "does this asset have a current, unexpired attestation?" —
    ///      typically `ESGRegistryV2`'s median-with-staleness read. It is a
    ///      required parameter rather than inferred from `carbonIntensity`
    ///      because zero is deep inside the Low bucket: an unrated asset
    ///      read as `tierOf(0, <implicit true>)` would silently get the
    ///      cheapest fee and the highest leverage, the exact opposite of
    ///      "未評等資產一律落到最保守級" (an unrated asset always falls to
    ///      the most conservative tier). Threading the flag through the
    ///      signature makes that mistake impossible to make by accident.
    function tierOf(uint256 carbonIntensity, bool isRated) internal pure returns (Tier) {
        if (!isRated) return Tier.Unrated;
        if (carbonIntensity < LOW_MAX_INTENSITY) return Tier.Low;
        if (carbonIntensity <= MID_MAX_INTENSITY) return Tier.Mid;
        return Tier.High;
    }

    /// @notice Maps a Tier to the params that must apply to it.
    /// @dev Unrated and High are numerically identical on purpose — the
    ///      ticket's own words are "未評等資產一律落到最保守級(1x、最高費
    ///      率)" (an unrated asset always falls to the most conservative
    ///      tier: 1x leverage, the highest fee). They stay separate enum
    ///      values so a UI or event log can say "unrated" rather than
    ///      misreporting an unrated asset as having been rated High.
    function paramsFor(Tier tier)
        internal
        pure
        returns (uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, uint256 maxLeverage)
    {
        if (tier == Tier.Low) {
            return (LOW_TRADING_FEE_BPS, LOW_BORROW_FEE_BPS_PER_HOUR, LOW_MAX_LEVERAGE);
        }
        if (tier == Tier.Mid) {
            return (MID_TRADING_FEE_BPS, MID_BORROW_FEE_BPS_PER_HOUR, MID_MAX_LEVERAGE);
        }
        // Tier.High and Tier.Unrated share this row deliberately — see NatSpec.
        return (HIGH_TRADING_FEE_BPS, HIGH_BORROW_FEE_BPS_PER_HOUR, HIGH_MAX_LEVERAGE);
    }

    /// @notice Convenience: `tierOf` and `paramsFor` composed into one call,
    ///         for a caller (e.g. PerpetualExchange.openPosition) that wants
    ///         the tier for observability (an event, a view function) and
    ///         the params in the same call.
    function paramsForIntensity(uint256 carbonIntensity, bool isRated)
        internal
        pure
        returns (Tier tier, uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, uint256 maxLeverage)
    {
        tier = tierOf(carbonIntensity, isRated);
        (tradingFeeBps, borrowFeeBpsPerHour, maxLeverage) = paramsFor(tier);
    }

    /// @notice Whether a carbon intensity qualifies at or below a ceiling
    ///         tier — e.g. "is this asset Low enough to earn a reward gated
    ///         at Low".
    /// @dev Centralizes a trap that is easy to reproduce ad hoc: `Tier`'s
    ///      ordinal values put `Unrated` at 0, below every real tier, so a
    ///      bare `tierOf(intensity, isRated) <= ceiling` comparison lets an
    ///      unrated asset satisfy any ceiling by numeric accident — the same
    ///      "zero sits in the cheap bucket" trap `tierOf` itself exists to
    ///      close for its own callers. Any consumer that needs "does this
    ///      asset qualify under a settable tier cap" (#98's
    ///      EsgRewardDistributor today; plausibly more later, per this
    ///      library's own mandate to be the single place this logic lives)
    ///      should call this rather than re-deriving the guard.
    function qualifiesAtOrBelow(uint256 carbonIntensity, bool isRated, Tier ceiling) internal pure returns (bool) {
        if (!isRated) return false;
        return tierOf(carbonIntensity, isRated) <= ceiling;
    }
}
