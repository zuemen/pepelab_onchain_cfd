// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/ESGRegistryV2.sol";
import "../src/CarbonTiers.sol";

/// @notice The per-asset carbon attestations the team writes (ADR-006):
///         tier + basis + E/S/G scores, from docs/data/carbon-intensity.md
///         "Proposed carbon tiers", aligned with frontend/src/lib/pepefi/assetMeta.ts.
///         One list for every script that attests — the platform's
///         `Deploy102CarbonRegistry` and a tenant's `AttestTenantCarbon` —
///         so the two can never drift apart.
library CarbonAttestations {
    struct A {
        string  symbol;
        uint256 intensity1e18; // revenue-basis figure; 0 (or any value) when basis != Revenue
        CarbonTiers.Tier tier; // the witnessed tier — the on-chain fact (ADR-006)
        ESGRegistryV2.Basis basis;
        uint8   e;
        uint8   s;
        uint8   g;
    }

    function assets() internal pure returns (A[11] memory a) {
        // *1e15 writes 3-decimal revenue-basis figures without float. For
        // Basis.Revenue the registry cross-checks tier == tierOf(intensity);
        // the others carry no comparable intensity, so the tier is asserted
        // directly.
        CarbonTiers.Tier L = CarbonTiers.Tier.Low;
        CarbonTiers.Tier M = CarbonTiers.Tier.Mid;
        CarbonTiers.Tier H = CarbonTiers.Tier.High;
        ESGRegistryV2.Basis REV = ESGRegistryV2.Basis.Revenue;
        ESGRegistryV2.Basis ABS = ESGRegistryV2.Basis.Absolute;
        ESGRegistryV2.Basis QUA = ESGRegistryV2.Basis.Qualitative;
        a[0]  = A("sBTC",        0,        H, ABS, 15, 40, 60); // ~39.8 Mt CO2e/yr absolute
        a[1]  = A("sETH",        0,        L, ABS, 35, 55, 70); // ~2,370 tCO2e/yr absolute
        a[2]  = A("sAAPL",    150 * 1e15,  L, REV, 72, 78, 85); // 0.150 -> Low
        a[3]  = A("sTSLA", 10_021 * 1e15,  H, REV, 60, 52, 65); // 10.021 -> High
        a[4]  = A("sGOLD",       0,        H, ABS, 40, 50, 55); // 0.85 tCO2e/oz sector benchmark
        a[5]  = A("sBOND",       0,        L, QUA, 86, 74, 80); // #106 green bond ETF, qualitative
        a[6]  = A("sNVDA",     99 * 1e15,  L, REV, 55, 60, 75); // 0.099 -> Low
        a[7]  = A("sMSFT", 10_226 * 1e15,  H, REV, 78, 72, 88); // 10.226 -> High
        a[8]  = A("sGOOGL", 8_949 * 1e15,  H, REV, 68, 65, 80); // 8.949 -> High
        a[9]  = A("sICLN",       0,        L, QUA, 90, 75, 78); // sector composition, qualitative
        a[10] = A("sESGU",  4_340 * 1e15,  M, REV, 88, 80, 82); // 4.34 (partial estimate) -> Mid
    }

    /// @dev The attestation's source: the asset, the retrieval date and the
    ///      document the figures are pinned in.
    function sourceHash(string memory symbol) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(symbol, "|2026-09-02|docs/data/carbon-intensity.md"));
    }

    function attest(ESGRegistryV2 registry, A memory x) internal {
        registry.attest(keccak256(bytes(x.symbol)), x.intensity1e18, x.tier, x.basis, x.e, x.s, x.g, sourceHash(x.symbol));
    }
}
