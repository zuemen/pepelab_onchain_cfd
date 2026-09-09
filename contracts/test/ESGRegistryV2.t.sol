// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ESGRegistryV2.sol";
import "../src/CarbonTiers.sol";

contract ESGRegistryV2Test is Test {
    ESGRegistryV2 registry;

    address admin = address(this);
    address attestor1 = makeAddr("attestor1");
    address attestor2 = makeAddr("attestor2");
    address attestor3 = makeAddr("attestor3");
    address nonAttestor = makeAddr("nonAttestor");

    bytes32 constant SBTC = keccak256("sBTC");
    bytes32 constant SAAPL = keccak256("sAAPL");

    bytes32 constant SRC_A = keccak256("https://example.com/a|2026-09-02");
    bytes32 constant SRC_B = keccak256("https://example.com/b|2026-09-02");
    bytes32 constant SRC_C = keccak256("https://example.com/c|2026-09-02");

    function setUp() public {
        registry = new ESGRegistryV2(admin);
        registry.grantRole(registry.ATTESTOR_ROLE(), attestor1);
        registry.grantRole(registry.ATTESTOR_ROLE(), attestor2);
        registry.grantRole(registry.ATTESTOR_ROLE(), attestor3);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// @dev Intensity-focused attestation: `Basis.Absolute` so the
    ///      tier/intensity cross-check does not fire, tier arbitrary. Used by
    ///      the tests that are about `medianCarbonIntensity` / `medianESG`,
    ///      where the carbon-intensity number is the subject and the tier is
    ///      not.
    function _attestI(address who, bytes32 id, uint256 intensity, uint8 e, uint8 s, uint8 g, bytes32 src) internal {
        vm.prank(who);
        registry.attest(id, intensity, CarbonTiers.Tier.Mid, ESGRegistryV2.Basis.Absolute, e, s, g, src);
    }

    /// @dev Tier-focused attestation: declares `tier` on `Basis.Absolute`
    ///      (no cross-check), intensity 0. Used by the `medianCarbonTier`
    ///      tests.
    function _attestT(address who, bytes32 id, CarbonTiers.Tier tier, bytes32 src) internal {
        vm.prank(who);
        registry.attest(id, 0, tier, ESGRegistryV2.Basis.Absolute, 10, 10, 10, src);
    }

    // ── access control ───────────────────────────────────────────────────────

    function testAttest_byNonAttestor_reverts() public {
        vm.prank(nonAttestor);
        vm.expectRevert();
        registry.attest(SBTC, 39.8e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Absolute, 20, 30, 40, SRC_A);
    }

    function testAttest_byAttestor_succeeds() public {
        _attestI(attestor1, SBTC, 39.8e18, 20, 30, 40, SRC_A);
        assertTrue(registry.hasAttested(SBTC, attestor1));
    }

    // ── e/s/g bounds ─────────────────────────────────────────────────────────

    function testAttest_scoreOutOfRange_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(ESGRegistryV2.ScoreOutOfRange.selector);
        registry.attest(SBTC, 1e18, CarbonTiers.Tier.Mid, ESGRegistryV2.Basis.Absolute, 101, 30, 40, SRC_A);
    }

    // ── source hash is mandatory ─────────────────────────────────────────────

    /// @dev docs/data/carbon-intensity.md's entire argument for pricing on
    ///      carbon rather than an ESG composite is that carbon "carries an
    ///      auditable source". An attestation with no source hash would be
    ///      exactly the un-auditable opinion this design exists to avoid.
    function testAttest_missingSourceHash_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(ESGRegistryV2.MissingSourceHash.selector);
        registry.attest(SBTC, 1e18, CarbonTiers.Tier.Mid, ESGRegistryV2.Basis.Absolute, 20, 30, 40, bytes32(0));
    }

    // ── tier + basis are stored and returned verbatim ────────────────────────

    function testAttest_storesTierAndBasisVerbatim() public {
        vm.warp(1_000_000);
        vm.prank(attestor1);
        registry.attest(SBTC, 0, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Absolute, 15, 40, 60, SRC_A);

        ESGRegistryV2.Attestation memory a = registry.getAttestation(SBTC, attestor1);
        assertTrue(a.tier == CarbonTiers.Tier.High, "tier stored verbatim");
        assertTrue(a.basis == ESGRegistryV2.Basis.Absolute, "basis stored verbatim");
        assertEq(a.carbonIntensity, 0, "absolute-basis attestation carries no intensity");
        assertEq(a.observedAt, 1_000_000);
    }

    function testAttest_revenueBasis_keepsIntensityAlongsideTier() public {
        vm.prank(attestor1);
        registry.attest(SAAPL, 0.150e18, CarbonTiers.Tier.Low, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC_A);

        ESGRegistryV2.Attestation memory a = registry.getAttestation(SAAPL, attestor1);
        assertEq(a.carbonIntensity, 0.150e18, "revenue-basis attestation still records the auditable quantity");
        assertTrue(a.tier == CarbonTiers.Tier.Low);
        assertTrue(a.basis == ESGRegistryV2.Basis.Revenue);
    }

    // ── revenue-basis: declared tier must match tierOf(intensity) ────────────

    /// @dev The gate that stops the two on-chain representations of carbon
    ///      intensity from drifting apart again (ADR-006). 0.150e18 is deep in
    ///      Low; declaring High for it is the exact bug this reverts.
    function testAttest_revenueBasis_tierContradictsIntensity_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ESGRegistryV2.TierIntensityMismatch.selector, CarbonTiers.Tier.High, CarbonTiers.Tier.Low
            )
        );
        registry.attest(SAAPL, 0.150e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC_A);
    }

    function testAttest_revenueBasis_zeroIntensity_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(ESGRegistryV2.MissingIntensity.selector);
        registry.attest(SAAPL, 0, CarbonTiers.Tier.Low, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC_A);
    }

    function testAttest_revenueBasis_tierMatchesIntensity_succeeds() public {
        // 10.226e18 > 8e18 -> High
        vm.prank(attestor1);
        registry.attest(SBTC, 10.226e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC_A);
        assertTrue(registry.getAttestation(SBTC, attestor1).tier == CarbonTiers.Tier.High);
    }

    /// @dev Non-revenue bases carry no comparable intensity, so the
    ///      consistency check does not apply — an `Absolute` attestation may
    ///      declare any tier next to any intensity (typically 0).
    function testAttest_absoluteBasis_tierIntensityInconsistency_isAllowed() public {
        // intensity 0 would be tierOf-Low, but tier High is declared and accepted
        vm.prank(attestor1);
        registry.attest(SBTC, 0, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Absolute, 15, 40, 60, SRC_A);
        assertTrue(registry.getAttestation(SBTC, attestor1).tier == CarbonTiers.Tier.High);
    }

    function testAttest_qualitativeBasis_tierIntensityInconsistency_isAllowed() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 5e18, CarbonTiers.Tier.Low, ESGRegistryV2.Basis.Qualitative, 90, 75, 78, SRC_A);
        assertTrue(registry.getAttestation(SBTC, attestor1).tier == CarbonTiers.Tier.Low);
        assertTrue(registry.getAttestation(SBTC, attestor1).basis == ESGRegistryV2.Basis.Qualitative);
    }

    // ── one attestor, one live attestation per asset (update, not append) ────

    function testAttest_sameAttestorTwice_updatesInPlace() public {
        _attestI(attestor1, SBTC, 30e18, 20, 30, 40, SRC_A);
        _attestI(attestor1, SBTC, 50e18, 25, 35, 45, SRC_B);

        address[] memory attestors = registry.getAttestors(SBTC);
        assertEq(attestors.length, 1, "re-attesting must not duplicate the attestor entry");

        ESGRegistryV2.Attestation memory a = registry.getAttestation(SBTC, attestor1);
        assertEq(a.carbonIntensity, 50e18, "second attest must overwrite, not accumulate");
        assertEq(a.sourceHash, SRC_B);
    }

    // ── source hash and observedAt are preserved verbatim ────────────────────

    function testAttest_preservesSourceHashAndObservedAt() public {
        vm.warp(1_000_000);
        _attestI(attestor1, SAAPL, 0.150e18, 60, 65, 70, SRC_A);

        ESGRegistryV2.Attestation memory a = registry.getAttestation(SAAPL, attestor1);
        assertEq(a.sourceHash, SRC_A);
        assertEq(a.observedAt, 1_000_000);
        assertEq(a.attestor, attestor1);
        assertEq(a.environmental, 60);
        assertEq(a.social, 65);
        assertEq(a.governance, 70);
    }

    // ── median: odd count ────────────────────────────────────────────────────

    function testMedianCarbonIntensity_oddCount_isMiddleValue() public {
        _attestI(attestor1, SBTC, 30e18, 10, 10, 10, SRC_A);
        _attestI(attestor2, SBTC, 61e18, 10, 10, 10, SRC_B);
        _attestI(attestor3, SBTC, 79e18, 10, 10, 10, SRC_C);

        (uint256 median, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 61e18, "median of {30,61,79} sorted is the middle value 61");
        assertEq(count, 3);
        assertTrue(isRated);
    }

    /// @dev The exact scenario this design exists for: three attestors
    ///      disagreeing about the same asset, per docs/data/carbon-
    ///      intensity.md's "Dispersion" concept. Order of submission must
    ///      not affect the result — the registry sorts internally.
    function testMedianCarbonIntensity_realisticDisagreement_82_61_79() public {
        _attestI(attestor1, SBTC, 82e18, 10, 10, 10, SRC_A);
        _attestI(attestor2, SBTC, 61e18, 10, 10, 10, SRC_B);
        _attestI(attestor3, SBTC, 79e18, 10, 10, 10, SRC_C);

        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 79e18, "sorted {61,79,82}, middle is 79");
        assertEq(count, 3);
        assertEq(dispersion, 21e18, "max(82) - min(61) = 21");
        assertTrue(isRated);
    }

    // ── median: even count averages the two middle values ───────────────────

    function testMedianCarbonIntensity_evenCount_averagesTwoMiddle() public {
        _attestI(attestor1, SBTC, 40e18, 10, 10, 10, SRC_A);
        _attestI(attestor2, SBTC, 60e18, 10, 10, 10, SRC_B);

        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 50e18, "(40 + 60) / 2 = 50");
        assertEq(count, 2);
        assertEq(dispersion, 20e18);
        assertTrue(isRated);
    }

    // ── dispersion is zero with a single attestor ────────────────────────────

    function testMedianCarbonIntensity_singleAttestor_dispersionIsZero() public {
        _attestI(attestor1, SBTC, 39.8e18, 10, 10, 10, SRC_A);

        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 39.8e18);
        assertEq(count, 1);
        assertEq(dispersion, 0, "one data point, nothing to disagree with");
        assertTrue(isRated);
    }

    // ── never attested: fail-closed, not a revert ────────────────────────────

    /// @dev A view function that reverts on "no data yet" would force every
    ///      caller (including a UI reading many assets at once) into
    ///      try/catch. Returning isRated=false lets the caller fail closed
    ///      on their own terms — exactly the pattern `CarbonTiers.tierOf`'s
    ///      `isRated` parameter is built to consume directly.
    function testMedianCarbonIntensity_neverAttested_isNotRated() public view {
        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SAAPL);
        assertEq(median, 0);
        assertEq(count, 0);
        assertEq(dispersion, 0);
        assertFalse(isRated);
    }

    // ── staleness: fail-closed on expiry ─────────────────────────────────────

    function testMedianCarbonIntensity_expiredAttestation_excludedFromMedian() public {
        registry.setMaxAttestationAge(30 days);

        vm.warp(1_000_000);
        _attestI(attestor1, SBTC, 30e18, 10, 10, 10, SRC_A); // will go stale

        vm.warp(1_000_000 + 31 days);
        _attestI(attestor2, SBTC, 90e18, 10, 10, 10, SRC_B); // fresh

        (uint256 median, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(count, 1, "attestor1's attestation is 31 days old against a 30-day window");
        assertEq(median, 90e18, "only the fresh attestation counts");
        assertTrue(isRated);
    }

    function testMedianCarbonIntensity_allExpired_isNotRated() public {
        registry.setMaxAttestationAge(30 days);

        vm.warp(1_000_000);
        _attestI(attestor1, SBTC, 30e18, 10, 10, 10, SRC_A);

        vm.warp(1_000_000 + 31 days);

        (, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(count, 0);
        assertFalse(isRated, "an asset with only expired attestations must fail closed, not report the stale median");
    }

    /// @dev maxAttestationAge = 0 disables the staleness check entirely —
    ///      same convention as GuardedOracle.maxPriceAge, so the two
    ///      "freshness gate" contracts in this codebase read the same way.
    function testMedianCarbonIntensity_maxAgeZero_disablesStaleness() public {
        registry.setMaxAttestationAge(0);

        vm.warp(1_000_000);
        _attestI(attestor1, SBTC, 30e18, 10, 10, 10, SRC_A);

        vm.warp(1_000_000 + 3650 days);

        (, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(count, 1);
        assertTrue(isRated);
    }

    function testIsAttestationFresh_perAttestor() public {
        registry.setMaxAttestationAge(30 days);
        vm.warp(1_000_000);
        _attestI(attestor1, SBTC, 30e18, 10, 10, 10, SRC_A);
        _attestI(attestor2, SBTC, 60e18, 10, 10, 10, SRC_B);

        vm.warp(1_000_000 + 31 days);
        _attestI(attestor2, SBTC, 65e18, 10, 10, 10, SRC_B); // attestor2 refreshes, attestor1 does not

        assertFalse(registry.isAttestationFresh(SBTC, attestor1), "attestor1 last spoke 31 days ago");
        assertTrue(registry.isAttestationFresh(SBTC, attestor2), "attestor2 just refreshed");
    }

    // ── median carbon TIER (ADR-006) ─────────────────────────────────────────

    /// @dev Median taken over the tier enum's ordinals: {Low:1, Mid:2, High:3}
    ///      sorted, middle is Mid.
    function testMedianCarbonTier_threeAttestors_lowMidHigh_isMid() public {
        _attestT(attestor1, SBTC, CarbonTiers.Tier.Low, SRC_A);
        _attestT(attestor2, SBTC, CarbonTiers.Tier.High, SRC_B);
        _attestT(attestor3, SBTC, CarbonTiers.Tier.Mid, SRC_C);

        (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonTier(SBTC);
        assertTrue(tier == CarbonTiers.Tier.Mid, "sorted {Low,Mid,High}, middle is Mid");
        assertEq(count, 3);
        assertEq(dispersion, 2, "ordinal spread High(3) - Low(1) = 2");
        assertTrue(isRated);
    }

    function testMedianCarbonTier_agreement_dispersionZero() public {
        _attestT(attestor1, SBTC, CarbonTiers.Tier.High, SRC_A);
        _attestT(attestor2, SBTC, CarbonTiers.Tier.High, SRC_B);

        (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonTier(SBTC);
        assertTrue(tier == CarbonTiers.Tier.High);
        assertEq(count, 2);
        assertEq(dispersion, 0, "both say High");
        assertTrue(isRated);
    }

    /// @dev Even count averages the two middle ordinals and floors, matching
    ///      medianCarbonIntensity's even-count rule: {Low:1, High:3} -> 2 = Mid.
    function testMedianCarbonTier_evenCount_averagesMiddleOrdinals() public {
        _attestT(attestor1, SBTC, CarbonTiers.Tier.Low, SRC_A);
        _attestT(attestor2, SBTC, CarbonTiers.Tier.High, SRC_B);

        (CarbonTiers.Tier tier,,,) = registry.medianCarbonTier(SBTC);
        assertTrue(tier == CarbonTiers.Tier.Mid, "(1 + 3) / 2 = 2 = Mid");
    }

    function testMedianCarbonTier_neverAttested_isUnratedNotRevert() public view {
        (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonTier(SAAPL);
        assertTrue(tier == CarbonTiers.Tier.Unrated, "no data fails closed to the most conservative tier");
        assertEq(count, 0);
        assertEq(dispersion, 0);
        assertFalse(isRated);
    }

    function testMedianCarbonTier_expiredExcluded_allExpiredIsUnrated() public {
        registry.setMaxAttestationAge(30 days);

        vm.warp(1_000_000);
        _attestT(attestor1, SBTC, CarbonTiers.Tier.Low, SRC_A); // will go stale

        vm.warp(1_000_000 + 31 days);
        _attestT(attestor2, SBTC, CarbonTiers.Tier.High, SRC_B); // fresh

        (CarbonTiers.Tier tier, uint256 count,, bool isRated) = registry.medianCarbonTier(SBTC);
        assertTrue(tier == CarbonTiers.Tier.High, "only the fresh attestation counts");
        assertEq(count, 1);
        assertTrue(isRated);

        vm.warp(1_000_000 + 31 days + 31 days); // now attestor2 is stale too
        (CarbonTiers.Tier tier2,, , bool isRated2) = registry.medianCarbonTier(SBTC);
        assertTrue(tier2 == CarbonTiers.Tier.Unrated, "all stale -> Unrated, marked unrated");
        assertFalse(isRated2);
    }

    /// @dev The tier read a revenue-basis attestation produces agrees with
    ///      the tier its own intensity would give through `tierOf` — the
    ///      submission-time invariant makes any other outcome unreachable.
    function testMedianCarbonTier_revenueBasis_matchesTierOfIntensity() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 4.34e18, CarbonTiers.Tier.Mid, ESGRegistryV2.Basis.Revenue, 10, 10, 10, SRC_A);

        (CarbonTiers.Tier tier,,, bool isRated) = registry.medianCarbonTier(SBTC);
        assertTrue(tier == CarbonTiers.Tier.Mid);
        assertTrue(isRated);
        (uint256 median,,, bool ri) = registry.medianCarbonIntensity(SBTC);
        assertTrue(CarbonTiers.tierOf(median, ri) == tier, "the two reads cannot disagree for a revenue-basis asset");
    }

    // ── median ESG, symmetric to median carbon intensity ─────────────────────

    function testMedianESG_oddCount() public {
        _attestI(attestor1, SBTC, 1e18, 20, 30, 40, SRC_A);
        _attestI(attestor2, SBTC, 1e18, 50, 60, 70, SRC_B);
        _attestI(attestor3, SBTC, 1e18, 80, 90, 10, SRC_C);

        (uint8 e, uint8 s, uint8 g, uint256 count, bool isRated) = registry.medianESG(SBTC);
        assertEq(e, 50); // sorted {20,50,80} -> 50
        assertEq(s, 60); // sorted {30,60,90} -> 60
        assertEq(g, 40); // sorted {10,40,70} -> 40
        assertEq(count, 3);
        assertTrue(isRated);
    }

    function testMedianESG_neverAttested_isNotRated() public view {
        (, , , uint256 count, bool isRated) = registry.medianESG(SAAPL);
        assertEq(count, 0);
        assertFalse(isRated);
    }

    // ── enumeration, mirroring the old ESGRegistry's getAllRatedAssets ───────

    function testGetAllAttestedAssets() public {
        _attestI(attestor1, SBTC, 1e18, 10, 10, 10, SRC_A);
        _attestI(attestor1, SAAPL, 1e18, 10, 10, 10, SRC_A);
        // Re-attesting the same asset must not duplicate the asset entry either.
        _attestI(attestor2, SBTC, 2e18, 10, 10, 10, SRC_B);

        bytes32[] memory assets = registry.getAllAttestedAssets();
        assertEq(assets.length, 2);
        assertEq(assets[0], SBTC);
        assertEq(assets[1], SAAPL);
    }

    // ── admin surface ─────────────────────────────────────────────────────────

    function testSetMaxAttestationAge_byNonAdmin_reverts() public {
        vm.prank(nonAttestor);
        vm.expectRevert();
        registry.setMaxAttestationAge(1 days);
    }

    function testGrantAttestorRole_byNonAdmin_reverts() public {
        // `registry.ATTESTOR_ROLE()` is itself an external call. Inlined
        // inside grantRole's argument list, it would be evaluated first and
        // consume vm.prank's single-call effect — grantRole would then run
        // as the test contract (admin), succeed, and this test would pass
        // for the wrong reason. Reading the role into a local first ensures
        // the prank lands on the call this test actually means to check.
        bytes32 role = registry.ATTESTOR_ROLE();
        vm.prank(nonAttestor);
        vm.expectRevert();
        registry.grantRole(role, nonAttestor);
    }
}
