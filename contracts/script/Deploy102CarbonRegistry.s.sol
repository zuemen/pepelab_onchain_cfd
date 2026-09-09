// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ESGRegistryV2.sol";
import "../src/CarbonTiers.sol";
import "../src/SustainabilityBadge.sol";

/// @notice #102 step 1 — deploy the carbon-attestation stack and seed it.
///
///         Deploys `ESGRegistryV2` (multi-attestation carbon + E/S/G) and
///         `SustainabilityBadge` (non-transferable achievement token), then
///         grants the deployer `ATTESTOR_ROLE` and writes one attestation per
///         asset. `Redeploy102Exchange.s.sol` reads the registry address
///         (`ESG_REGISTRY_V2` env) as the carbon source for the new exchange,
///         so this MUST run — and the attestations MUST be in — before the
///         exchange deploys, or every asset prices at the most conservative
///         tier (`Unrated`).
///
///         ## About the tier + basis (ADR-006)
///
///         Each attestation carries the WITNESSED `tier` (the on-chain fact
///         the exchange and vault price against, via `medianCarbonTier`) and
///         the `basis` it was determined on:
///           - `Revenue`     — the five equities and sESGU have a real
///             tCO2e/$1M-revenue figure (pinned in
///             docs/data/carbon-intensity.md). The registry cross-checks
///             `tier == tierOf(intensity)` on submission, so both are filled.
///           - `Absolute`    — gold and BTC/ETH have no revenue; placed by
///             absolute annualized emissions + sector benchmark. `intensity`
///             is left 0 — there is no comparable number to record.
///           - `Qualitative` — sICLN and sBOND (green bond ETF, #106) placed
///             by sector / instrument class. Also `intensity` 0.
///         The absolute / qualitative placements are decisions, documented in
///         carbon-intensity.md and ADR-006, not measurements. Flagged on
///         screen; needs team sign-off before the defence.
///
///         ## Multi-attestor "agencies disagree" demo
///
///         By default only the deployer attests (median = one value). To make
///         "three agencies gave 82 / 61 / 79" a real on-chain state, set
///         `ATTESTOR_2` / `ATTESTOR_3` to two more EOAs and run this again
///         from each of those keys (the deployer's grant of ATTESTOR_ROLE to
///         them happens on the first run). Their attestations are the team's
///         own keys — say so; it is staging, not institutional independence.
///
///         Run:
///           forge script script/Deploy102CarbonRegistry.s.sol:Deploy102CarbonRegistry \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast -vvv
contract Deploy102CarbonRegistry is Script {
    // Align with frontend/src/lib/pepefi/carbon.ts MAX_ATTESTATION_AGE_DAYS.
    uint256 constant MAX_ATTESTATION_AGE = 365 days;

    struct A {
        string  symbol;
        uint256 intensity1e18; // revenue-basis figure; 0 (or any value) when basis != Revenue
        CarbonTiers.Tier tier; // the witnessed tier — the on-chain fact (ADR-006)
        ESGRegistryV2.Basis basis;
        uint8   e;
        uint8   s;
        uint8   g;
    }

    function _assets() internal pure returns (A[11] memory a) {
        // Tier + basis: docs/data/carbon-intensity.md "Proposed carbon tiers",
        // aligned with frontend/src/lib/pepefi/assetMeta.ts. *1e15 writes
        // 3-decimal revenue-basis figures without float. For Basis.Revenue the
        // registry cross-checks tier == tierOf(intensity); the others carry no
        // comparable intensity, so the tier is asserted directly.
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

    function run() external {
        // Reuse an already-deployed registry/badge if the env points at one,
        // so a re-run (e.g. adding a second attestor) does not fork the stack.
        address existingRegistry = vm.envOr("ESG_REGISTRY_V2", address(0));
        address existingBadge    = vm.envOr("SUSTAINABILITY_BADGE", address(0));

        vm.startBroadcast();
        address me = msg.sender;

        ESGRegistryV2 registry = existingRegistry == address(0)
            ? new ESGRegistryV2(me)
            : ESGRegistryV2(existingRegistry);

        SustainabilityBadge badge = existingBadge == address(0)
            ? new SustainabilityBadge(me)
            : SustainabilityBadge(existingBadge);

        if (existingRegistry == address(0)) {
            registry.setMaxAttestationAge(MAX_ATTESTATION_AGE);
        }

        // Grant this caller ATTESTOR_ROLE if it does not have it yet. Safe to
        // re-run: grantRole is idempotent.
        if (!registry.hasRole(registry.ATTESTOR_ROLE(), me)) {
            registry.grantRole(registry.ATTESTOR_ROLE(), me);
        }

        // Optional extra attestors — granted here, but they must run this
        // script themselves (with their own key) to actually attest.
        address a2 = vm.envOr("ATTESTOR_2", address(0));
        address a3 = vm.envOr("ATTESTOR_3", address(0));
        if (a2 != address(0) && !registry.hasRole(registry.ATTESTOR_ROLE(), a2)) {
            registry.grantRole(registry.ATTESTOR_ROLE(), a2);
        }
        if (a3 != address(0) && !registry.hasRole(registry.ATTESTOR_ROLE(), a3)) {
            registry.grantRole(registry.ATTESTOR_ROLE(), a3);
        }

        A[11] memory list = _assets();
        for (uint256 i = 0; i < 11; i++) {
            bytes32 id = keccak256(bytes(list[i].symbol));
            bytes32 sourceHash = keccak256(
                abi.encodePacked(list[i].symbol, "|2026-09-02|docs/data/carbon-intensity.md")
            );
            registry.attest(
                id, list[i].intensity1e18, list[i].tier, list[i].basis, list[i].e, list[i].s, list[i].g, sourceHash
            );
        }

        vm.stopBroadcast();

        console.log("=== #102 carbon stack ===");
        console.log("ESGRegistryV2       :", address(registry));
        console.log("SustainabilityBadge :", address(badge));
        console.log("attestor            :", me);
        console.log("maxAttestationAge   :", registry.maxAttestationAge());
        console.log("");
        console.log("Set for the next steps:");
        console.log("  export ESG_REGISTRY_V2=", address(registry));
        console.log("  export SUSTAINABILITY_BADGE=", address(badge));
        console.log("");

        // Read a couple back so a silent mis-attestation surfaces now. sBTC is
        // an absolute-basis placement (High), sNVDA a revenue-basis measurement
        // (Low) — check the tier read the exchange and vault actually price on.
        (CarbonTiers.Tier tBtc, , , bool rBtc)  = registry.medianCarbonTier(keccak256("sBTC"));
        (CarbonTiers.Tier tNvda, , , bool rNvda) = registry.medianCarbonTier(keccak256("sNVDA"));
        console.log("sBTC  tier (want High=3) :", uint256(tBtc));
        console.log("sNVDA tier (want Low=1)  :", uint256(tNvda));
        require(rBtc && rNvda, "attestations did not land");
        require(tBtc == CarbonTiers.Tier.High && tNvda == CarbonTiers.Tier.Low, "tier readback wrong");
    }
}
