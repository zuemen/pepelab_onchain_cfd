// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/ESGRegistryV2.sol";
import "../src/CarbonTiers.sol";

/// @notice The per-asset carbon attestations the team writes (ADR-006):
///         tier + basis, from docs/data/carbon-intensity.md
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
        string  retrieved; // the date the figure was read, ISO — part of `sourceHash`
    }

    function assets() internal pure returns (A[11] memory a) {
        // *1e15 writes 3-decimal revenue-basis figures without float; the two
        // ETFs carry MSCI's 2-decimal figures, written *1e16. For
        // Basis.Revenue the registry cross-checks tier == tierOf(intensity);
        // the others carry no comparable intensity, so the tier is asserted
        // directly.
        CarbonTiers.Tier L = CarbonTiers.Tier.Low;
        CarbonTiers.Tier H = CarbonTiers.Tier.High;
        ESGRegistryV2.Basis REV = ESGRegistryV2.Basis.Revenue;
        ESGRegistryV2.Basis ABS = ESGRegistryV2.Basis.Absolute;
        ESGRegistryV2.Basis QUA = ESGRegistryV2.Basis.Qualitative;
        string memory D0 = "2026-09-02"; // #94's collection
        string memory D1 = "2026-10-16"; // the ETFs re-sourced to iShares' own WACI (docs/data/carbon-tier-etf-waci.md)
        a[0]  = A("sBTC", 0, H, ABS, D0); // ~39.8 Mt CO2e/yr absolute
        a[1]  = A("sETH", 0, L, ABS, D0); // ~2,370 tCO2e/yr absolute
        a[2]  = A("sAAPL", 150 * 1e15, L, REV, D0); // 0.150 -> Low
        a[3]  = A("sTSLA", 10_021 * 1e15, H, REV, D0); // 10.021 -> High
        a[4]  = A("sGOLD", 0, H, ABS, D0); // 0.85 tCO2e/oz sector benchmark
        a[5]  = A("sBOND", 0, L, QUA, D0); // #106 green bond ETF, qualitative
        a[6]  = A("sNVDA", 99 * 1e15, L, REV, D0); // 0.099 -> Low
        a[7]  = A("sMSFT", 10_226 * 1e15, H, REV, D0); // 10.226 -> High
        a[8]  = A("sGOOGL", 8_949 * 1e15, H, REV, D0); // 8.949 -> High
        a[9]  = A("sICLN", 24_174 * 1e16, H, REV, D1); // 241.74 MSCI WACI, 92.81% coverage -> High
        a[10] = A("sESGU", 7_105 * 1e16, H, REV, D1); // 71.05 MSCI WACI, 99.73% coverage -> High
    }

    /// @dev The attestation's source: the asset, the retrieval date and the
    ///      document the figures are pinned in.
    function sourceHash(A memory x) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(x.symbol, "|", x.retrieved, "|docs/data/carbon-intensity.md"));
    }

    function attest(ESGRegistryV2 registry, A memory x) internal {
        // E/S/G are written as 0. #383: the platform no longer scores assets itself — the old
        // figures here were the team's own opinion, and ESG ratings are specialist research.
        // The registry still has the fields (they never fed pricing); the frontend quotes
        // third-party ratings instead (frontend/src/lib/pepefi/esgRatingsData.ts).
        registry.attest(keccak256(bytes(x.symbol)), x.intensity1e18, x.tier, x.basis, 0, 0, 0, sourceHash(x));
    }
}
