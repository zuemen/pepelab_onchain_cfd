// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ESGRegistryV2.sol";

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

    // ── access control ───────────────────────────────────────────────────────

    function testAttest_byNonAttestor_reverts() public {
        vm.prank(nonAttestor);
        vm.expectRevert();
        registry.attest(SBTC, 39.8e18, 20, 30, 40, SRC_A);
    }

    function testAttest_byAttestor_succeeds() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 39.8e18, 20, 30, 40, SRC_A);
        assertTrue(registry.hasAttested(SBTC, attestor1));
    }

    // ── e/s/g bounds ─────────────────────────────────────────────────────────

    function testAttest_scoreOutOfRange_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(ESGRegistryV2.ScoreOutOfRange.selector);
        registry.attest(SBTC, 1e18, 101, 30, 40, SRC_A);
    }

    // ── source hash is mandatory ─────────────────────────────────────────────

    /// @dev docs/data/carbon-intensity.md's entire argument for pricing on
    ///      carbon rather than an ESG composite is that carbon "carries an
    ///      auditable source". An attestation with no source hash would be
    ///      exactly the un-auditable opinion this design exists to avoid.
    function testAttest_missingSourceHash_reverts() public {
        vm.prank(attestor1);
        vm.expectRevert(ESGRegistryV2.MissingSourceHash.selector);
        registry.attest(SBTC, 1e18, 20, 30, 40, bytes32(0));
    }

    // ── one attestor, one live attestation per asset (update, not append) ────

    function testAttest_sameAttestorTwice_updatesInPlace() public {
        vm.startPrank(attestor1);
        registry.attest(SBTC, 30e18, 20, 30, 40, SRC_A);
        registry.attest(SBTC, 50e18, 25, 35, 45, SRC_B);
        vm.stopPrank();

        address[] memory attestors = registry.getAttestors(SBTC);
        assertEq(attestors.length, 1, "re-attesting must not duplicate the attestor entry");

        ESGRegistryV2.Attestation memory a = registry.getAttestation(SBTC, attestor1);
        assertEq(a.carbonIntensity, 50e18, "second attest must overwrite, not accumulate");
        assertEq(a.sourceHash, SRC_B);
    }

    // ── source hash and observedAt are preserved verbatim ────────────────────

    function testAttest_preservesSourceHashAndObservedAt() public {
        vm.warp(1_000_000);
        vm.prank(attestor1);
        registry.attest(SAAPL, 0.150e18, 60, 65, 70, SRC_A);

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
        vm.prank(attestor1);
        registry.attest(SBTC, 30e18, 10, 10, 10, SRC_A);
        vm.prank(attestor2);
        registry.attest(SBTC, 61e18, 10, 10, 10, SRC_B);
        vm.prank(attestor3);
        registry.attest(SBTC, 79e18, 10, 10, 10, SRC_C);

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
        vm.prank(attestor1);
        registry.attest(SBTC, 82e18, 10, 10, 10, SRC_A);
        vm.prank(attestor2);
        registry.attest(SBTC, 61e18, 10, 10, 10, SRC_B);
        vm.prank(attestor3);
        registry.attest(SBTC, 79e18, 10, 10, 10, SRC_C);

        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 79e18, "sorted {61,79,82}, middle is 79");
        assertEq(count, 3);
        assertEq(dispersion, 21e18, "max(82) - min(61) = 21");
        assertTrue(isRated);
    }

    // ── median: even count averages the two middle values ───────────────────

    function testMedianCarbonIntensity_evenCount_averagesTwoMiddle() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 40e18, 10, 10, 10, SRC_A);
        vm.prank(attestor2);
        registry.attest(SBTC, 60e18, 10, 10, 10, SRC_B);

        (uint256 median, uint256 count, uint256 dispersion, bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(median, 50e18, "(40 + 60) / 2 = 50");
        assertEq(count, 2);
        assertEq(dispersion, 20e18);
        assertTrue(isRated);
    }

    // ── dispersion is zero with a single attestor ────────────────────────────

    function testMedianCarbonIntensity_singleAttestor_dispersionIsZero() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 39.8e18, 10, 10, 10, SRC_A);

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
        vm.prank(attestor1);
        registry.attest(SBTC, 30e18, 10, 10, 10, SRC_A); // will go stale

        vm.warp(1_000_000 + 31 days);
        vm.prank(attestor2);
        registry.attest(SBTC, 90e18, 10, 10, 10, SRC_B); // fresh

        (uint256 median, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(count, 1, "attestor1's attestation is 31 days old against a 30-day window");
        assertEq(median, 90e18, "only the fresh attestation counts");
        assertTrue(isRated);
    }

    function testMedianCarbonIntensity_allExpired_isNotRated() public {
        registry.setMaxAttestationAge(30 days);

        vm.warp(1_000_000);
        vm.prank(attestor1);
        registry.attest(SBTC, 30e18, 10, 10, 10, SRC_A);

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
        vm.prank(attestor1);
        registry.attest(SBTC, 30e18, 10, 10, 10, SRC_A);

        vm.warp(1_000_000 + 3650 days);

        (, uint256 count, , bool isRated) = registry.medianCarbonIntensity(SBTC);
        assertEq(count, 1);
        assertTrue(isRated);
    }

    function testIsAttestationFresh_perAttestor() public {
        registry.setMaxAttestationAge(30 days);
        vm.warp(1_000_000);
        vm.prank(attestor1);
        registry.attest(SBTC, 30e18, 10, 10, 10, SRC_A);
        vm.prank(attestor2);
        registry.attest(SBTC, 60e18, 10, 10, 10, SRC_B);

        vm.warp(1_000_000 + 31 days);
        vm.prank(attestor2);
        registry.attest(SBTC, 65e18, 10, 10, 10, SRC_B); // attestor2 refreshes, attestor1 does not

        assertFalse(registry.isAttestationFresh(SBTC, attestor1), "attestor1 last spoke 31 days ago");
        assertTrue(registry.isAttestationFresh(SBTC, attestor2), "attestor2 just refreshed");
    }

    // ── median ESG, symmetric to median carbon intensity ─────────────────────

    function testMedianESG_oddCount() public {
        vm.prank(attestor1);
        registry.attest(SBTC, 1e18, 20, 30, 40, SRC_A);
        vm.prank(attestor2);
        registry.attest(SBTC, 1e18, 50, 60, 70, SRC_B);
        vm.prank(attestor3);
        registry.attest(SBTC, 1e18, 80, 90, 10, SRC_C);

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
        vm.prank(attestor1);
        registry.attest(SBTC, 1e18, 10, 10, 10, SRC_A);
        vm.prank(attestor1);
        registry.attest(SAAPL, 1e18, 10, 10, 10, SRC_A);
        // Re-attesting the same asset must not duplicate the asset entry either.
        vm.prank(attestor2);
        registry.attest(SBTC, 2e18, 10, 10, 10, SRC_B);

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
