// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ESGRegistryV2.sol";
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
///         ## About the intensity numbers
///
///         `ESGRegistryV2.medianCarbonIntensity` feeds straight into
///         `CarbonTiers.tierOf`, which only understands a **revenue-basis**
///         intensity (tCO2e per $1M trailing revenue, 1e18-scaled). The five
///         equities and sESGU have a real such figure — pinned in
///         `docs/data/carbon-intensity.md`. The commodity and the two crypto
///         assets do NOT: gold and BTC/ETH have no revenue. For those, and
///         for the two ETFs placed qualitatively, this script attests an
///         intensity **chosen to land the asset in the tier its
///         absolute-emissions / sector basis warrants** — BTC and gold in
///         High, ETH / sICLN / sBOND(green bond, #106) in Low. That is a
///         placement decision, documented in carbon-intensity.md's "Open
///         questions for #95", not a $/M-revenue measurement. Flagged here
///         and on screen; needs team sign-off before the defence.
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
        uint256 intensity1e18; // revenue-basis figure, OR a placement value (see NatSpec)
        uint8   e;
        uint8   s;
        uint8   g;
        bool    revenueBasis;  // false = intensity is a tier-placement value, not a measurement
    }

    function _assets() internal pure returns (A[11] memory a) {
        // intensity numbers: docs/data/carbon-intensity.md "Proposed carbon tiers".
        // *1e15 lets us write 3-decimal figures without float.
        a[0]  = A("sBTC",   9_000 * 1e15,   15, 40, 60, false); // High  (absolute-basis placement)
        a[1]  = A("sETH",     500 * 1e15,   35, 55, 70, false); // Low   (absolute-basis placement)
        a[2]  = A("sAAPL",    150 * 1e15,   72, 78, 85, true);  // 0.150 -> Low
        a[3]  = A("sTSLA", 10_021 * 1e15,   60, 52, 65, true);  // 10.021 -> High
        a[4]  = A("sGOLD",  9_000 * 1e15,   40, 50, 55, false); // High  (per-ounce basis placement)
        a[5]  = A("sBOND",    500 * 1e15,   86, 74, 80, false); // Low   (#106 green bond ETF, qualitative)
        a[6]  = A("sNVDA",     99 * 1e15,   55, 60, 75, true);  // 0.099 -> Low
        a[7]  = A("sMSFT", 10_226 * 1e15,   78, 72, 88, true);  // 10.226 -> High
        a[8]  = A("sGOOGL", 8_949 * 1e15,   68, 65, 80, true);  // 8.949 -> High
        a[9]  = A("sICLN",    500 * 1e15,   90, 75, 78, false); // Low   (sector-composition placement)
        a[10] = A("sESGU",  4_340 * 1e15,   88, 80, 82, true);  // 4.34 (partial estimate) -> Mid
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
            registry.attest(id, list[i].intensity1e18, list[i].e, list[i].s, list[i].g, sourceHash);
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

        // Read a couple back so a silent mis-attestation surfaces now.
        (uint256 mBtc, , , bool rBtc)  = registry.medianCarbonIntensity(keccak256("sBTC"));
        (uint256 mNvda, , , bool rNvda) = registry.medianCarbonIntensity(keccak256("sNVDA"));
        console.log("sBTC  median :", mBtc);
        console.log("sNVDA median :", mNvda);
        require(rBtc && rNvda, "attestations did not land");
    }
}
