// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CarbonTiers.sol";

/// @dev Thresholds and per-tier params here are the source of truth this
///      library is built against — see docs/data/carbon-intensity.md
///      ("Proposed carbon tiers"). `frontend/src/lib/pepefi/carbon.test.ts`
///      pins the same boundary values on the TypeScript side; there is no
///      compile-time link between the two languages, so a threshold changed
///      here without changing it there will pass both suites and silently
///      drift. Changing a threshold means changing it in both files.
contract CarbonTiersTest is Test {
    // ── tierOf: boundary behaviour ───────────────────────────────────────────

    function testTierOf_belowOne_isLow() public {
        assertTrue(CarbonTiers.tierOf(0, true) == CarbonTiers.Tier.Low);
        assertTrue(CarbonTiers.tierOf(0.099e18, true) == CarbonTiers.Tier.Low);
        assertTrue(CarbonTiers.tierOf(0.999e18, true) == CarbonTiers.Tier.Low);
    }

    function testTierOf_exactlyOne_isMid() public {
        // Low is "< 1", so the boundary itself belongs to Mid.
        assertTrue(CarbonTiers.tierOf(1e18, true) == CarbonTiers.Tier.Mid);
    }

    function testTierOf_betweenOneAndEight_isMid() public {
        assertTrue(CarbonTiers.tierOf(4.34e18, true) == CarbonTiers.Tier.Mid); // sESGU, docs/data/carbon-intensity.md
    }

    function testTierOf_exactlyEight_isMid() public {
        // High is "> 8", so the boundary itself belongs to Mid.
        assertTrue(CarbonTiers.tierOf(8e18, true) == CarbonTiers.Tier.Mid);
    }

    function testTierOf_aboveEight_isHigh() public {
        assertTrue(CarbonTiers.tierOf(8.001e18, true) == CarbonTiers.Tier.High);
        assertTrue(CarbonTiers.tierOf(10.226e18, true) == CarbonTiers.Tier.High); // sMSFT
    }

    /// @dev The exact figures from docs/data/carbon-intensity.md, so the
    ///      tier split this ADR-003 rests on is pinned to real, sourced
    ///      numbers rather than to round test values only.
    function testTierOf_realAssets_fromCarbonIntensityData() public {
        assertTrue(CarbonTiers.tierOf(0.099e18, true) == CarbonTiers.Tier.Low);   // sNVDA
        assertTrue(CarbonTiers.tierOf(0.150e18, true) == CarbonTiers.Tier.Low);   // sAAPL
        assertTrue(CarbonTiers.tierOf(8.949e18, true) == CarbonTiers.Tier.High);  // sGOOGL
        assertTrue(CarbonTiers.tierOf(10.021e18, true) == CarbonTiers.Tier.High); // sTSLA
        assertTrue(CarbonTiers.tierOf(10.226e18, true) == CarbonTiers.Tier.High); // sMSFT
    }

    // ── tierOf: fail-closed on unrated ───────────────────────────────────────

    /// @dev The whole point of a separate `isRated` flag rather than reading
    ///      Unrated off of `carbonIntensity == 0`: zero is deep inside the Low
    ///      bucket, so a caller who forgot to check "is this asset actually
    ///      rated" before calling tierOf would hand an unrated asset the
    ///      cheapest fee and the highest leverage — the exact opposite of
    ///      fail-closed. Threading `isRated` through the signature makes that
    ///      mistake impossible to make silently: the caller must have an
    ///      explicit "rated or not" answer in hand already.
    function testTierOf_unrated_isNeverLow_regardlessOfIntensityValue() public {
        assertTrue(CarbonTiers.tierOf(0, false) == CarbonTiers.Tier.Unrated);
        assertTrue(CarbonTiers.tierOf(0.099e18, false) == CarbonTiers.Tier.Unrated);
        assertTrue(CarbonTiers.tierOf(100e18, false) == CarbonTiers.Tier.Unrated);
    }

    // ── paramsFor: monotonic, and bounded by PerpetualExchange's own ceilings ─

    /// @dev Mirrors PerpetualExchange.MAX_TRADING_FEE_BPS /
    ///      MAX_BORROW_FEE_BPS_PER_HOUR (100 / 10) — literal values, not an
    ///      import, because CarbonTiers must not depend on PerpetualExchange
    ///      (the exchange will depend on this library, not the reverse).
    ///      If those ceilings ever change, this assertion is the thing that
    ///      will need re-checking by hand.
    function testParamsFor_highTier_sitsAtExchangeCeilings() public {
        (uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, ) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);
        assertEq(tradingFeeBps, 100, "must equal PerpetualExchange.MAX_TRADING_FEE_BPS");
        assertEq(borrowFeeBpsPerHour, 10, "must equal PerpetualExchange.MAX_BORROW_FEE_BPS_PER_HOUR");
    }

    function testParamsFor_lowTier_matchesTodaysExchangeDefault() public {
        // Shipping this must not silently change the cost of holding an
        // already-lowest-tier asset relative to what PerpetualExchange
        // charges today (TRADING_FEE_BPS = 10, BORROW_FEE_BPS_PER_HOUR = 1).
        (uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, ) = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);
        assertEq(tradingFeeBps, 10);
        assertEq(borrowFeeBpsPerHour, 1);
    }

    /// @dev Leverage values are exactly {1, 2, 5} to match
    ///      StrategyRegistry._validLeverage — a published Allocation can only
    ///      ever ask for one of those three, so the per-tier ceiling must be
    ///      drawn from the same set or a valid strategy leverage could exceed
    ///      what its own asset's tier permits with no valid value to fall
    ///      back to.
    function testParamsFor_leverageMatchesStrategyRegistryAllowedSet() public {
        (, , uint256 lowLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);
        (, , uint256 midLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.Mid);
        (, , uint256 highLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);
        assertEq(lowLev, 5);
        assertEq(midLev, 2);
        assertEq(highLev, 1);
    }

    function testParamsFor_feesAndLeverage_areMonotonicAcrossTiers() public {
        (uint256 lowFee, uint256 lowBorrow, uint256 lowLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);
        (uint256 midFee, uint256 midBorrow, uint256 midLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.Mid);
        (uint256 highFee, uint256 highBorrow, uint256 highLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);

        assertTrue(lowFee < midFee && midFee < highFee, "fee must strictly increase with carbon");
        assertTrue(lowBorrow < midBorrow && midBorrow < highBorrow, "borrow fee must strictly increase with carbon");
        assertTrue(lowLev > midLev && midLev > highLev, "leverage ceiling must strictly decrease with carbon");
    }

    /// @dev The ticket's own words: "未評等資產一律落到最保守級(1x、最高費率)".
    ///      Unrated must be numerically indistinguishable from High in cost
    ///      and leverage — it is a distinct enum value purely so an
    ///      observer/UI can say "unrated" instead of misreporting "high".
    function testParamsFor_unrated_isNumericallyIdenticalToHigh() public {
        (uint256 highFee, uint256 highBorrow, uint256 highLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);
        (uint256 unratedFee, uint256 unratedBorrow, uint256 unratedLev) = CarbonTiers.paramsFor(CarbonTiers.Tier.Unrated);
        assertEq(unratedFee, highFee);
        assertEq(unratedBorrow, highBorrow);
        assertEq(unratedLev, highLev);
    }

    // ── paramsForIntensity: the one-call convenience wrapper ─────────────────

    function testParamsForIntensity_composesTierOfAndParamsFor() public {
        (CarbonTiers.Tier tier, uint256 fee, uint256 borrow, uint256 lev) =
            CarbonTiers.paramsForIntensity(0.150e18, true); // sAAPL
        assertTrue(tier == CarbonTiers.Tier.Low);
        assertEq(fee, 10);
        assertEq(borrow, 1);
        assertEq(lev, 5);
    }

    function testParamsForIntensity_unrated_ignoresIntensityValue() public {
        (CarbonTiers.Tier tier, uint256 fee, , uint256 lev) =
            CarbonTiers.paramsForIntensity(0.001e18, false);
        assertTrue(tier == CarbonTiers.Tier.Unrated);
        assertEq(fee, 100);
        assertEq(lev, 1);
    }

    // ── no discretion: fuzz that params never depend on anything but the tier ─

    /// @dev ADR-003: thresholds are constants, not settable parameters, and
    ///      there is deliberately no per-asset or per-caller override path
    ///      anywhere in this library. This fuzz test is the closest a unit
    ///      test can come to proving a negative — two arbitrary intensities
    ///      that land in the same tier must always produce byte-identical
    ///      params, for any caller, with no hidden state consulted.
    function testFuzz_sameTier_alwaysSameParams(uint256 a, uint256 b) public {
        vm.assume(a <= 1e30 && b <= 1e30); // keep inputs in a realistic range
        CarbonTiers.Tier tierA = CarbonTiers.tierOf(a, true);
        CarbonTiers.Tier tierB = CarbonTiers.tierOf(b, true);
        vm.assume(tierA == tierB);

        (uint256 feeA, uint256 borrowA, uint256 levA) = CarbonTiers.paramsFor(tierA);
        (uint256 feeB, uint256 borrowB, uint256 levB) = CarbonTiers.paramsFor(tierB);
        assertEq(feeA, feeB);
        assertEq(borrowA, borrowB);
        assertEq(levA, levB);
    }

    // ── qualifiesAtOrBelow: #98's "does this qualify under a ceiling" seam ───

    function testQualifiesAtOrBelow_ratedBelowCeiling_true() public {
        assertTrue(CarbonTiers.qualifiesAtOrBelow(0.150e18, true, CarbonTiers.Tier.Low)); // sAAPL, Low <= Low
        assertTrue(CarbonTiers.qualifiesAtOrBelow(4.34e18, true, CarbonTiers.Tier.Mid)); // sESGU, Mid <= Mid
    }

    function testQualifiesAtOrBelow_ratedAboveCeiling_false() public {
        assertFalse(CarbonTiers.qualifiesAtOrBelow(4.34e18, true, CarbonTiers.Tier.Low)); // Mid > Low ceiling
        assertFalse(CarbonTiers.qualifiesAtOrBelow(10.021e18, true, CarbonTiers.Tier.Mid)); // High > Mid ceiling
    }

    /// @dev The exact trap this helper exists to close: Unrated sits at enum
    ///      value 0, below every real tier, so a bare ordinal `tierOf(...) <=
    ///      ceiling` would let an unrated asset satisfy ANY ceiling — even
    ///      the strictest one (Low). This must stay false no matter how low
    ///      the ceiling is set.
    function testQualifiesAtOrBelow_unrated_neverQualifies_evenAtLowestCeiling() public {
        assertFalse(CarbonTiers.qualifiesAtOrBelow(0, false, CarbonTiers.Tier.Low));
        assertFalse(CarbonTiers.qualifiesAtOrBelow(0, false, CarbonTiers.Tier.High));
        assertFalse(CarbonTiers.qualifiesAtOrBelow(0, false, CarbonTiers.Tier.Unrated));
    }

    function testQualifiesAtOrBelow_exactlyAtCeiling_true() public {
        assertTrue(CarbonTiers.qualifiesAtOrBelow(8e18, true, CarbonTiers.Tier.Mid)); // boundary: 8e18 is Mid
    }
}
