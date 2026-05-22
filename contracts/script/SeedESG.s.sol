// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ESGRegistry.sol";

/// @notice Seeds ESG scores for all 11 assets on an already-deployed ESGRegistry.
///         Usage: forge script script/SeedESG.s.sol --rpc-url $SEPOLIA_RPC --broadcast
///         Requires env var: ESG_REGISTRY (address of deployed ESGRegistry)
///
/// ESG Methodology (0-100 per axis):
///   Environmental — carbon footprint, energy mix, physical climate risk
///   Social        — labour practices, community impact, data privacy
///   Governance    — board independence, transparency, shareholder rights
///
/// Rating tiers: AAA ≥ 80 · AA ≥ 65 · A ≥ 50 · BBB ≥ 35 · CCC < 35
contract SeedESG is Script {
    // keccak256(symbol) — must match on-chain asset IDs
    bytes32 constant SBTC   = 0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1;
    bytes32 constant SETH   = 0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;
    bytes32 constant SAAPL  = 0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220;
    bytes32 constant STSLA  = 0xd3cea6476633c192bfd36c9af4a9d0ee6e1863484325ee0f546a36393d1df1e9;
    bytes32 constant SGOLD  = 0x12b611f69af3b5e84f9d2d8a8818b4ad7f2cf0b45274bc7c3b9616f67c7baa1a;
    bytes32 constant SBOND  = 0xc310184149786e37d3493804e896dd8582e216011114ff6a7b6b8c02678bf6bb;
    bytes32 constant SNVDA  = 0x59367feafbd2791db3a7462e596e9514b8f32a0dd24dcb4fd34af4725e59388d;
    bytes32 constant SMSFT  = 0x9148a0fa033f72a846b348bb77b949e9dde2f4cd70a6045eb9e25ee5215b5b0b;
    bytes32 constant SGOOGL = 0xa0934421d87a4a6d14ebffa8df8f7aeda1ab515b1a348ca82620b23a527b6875;
    bytes32 constant SICLN  = 0x61663214831fdd7b1dd003226fb7436774c5b030f5858cf47d7aee23934564cb;
    bytes32 constant SESGU  = 0x5820b70264a0c106d7ef7036e13c03b5d9018e2b51178ed68526cf915d594ca2;

    function run() external {
        address registryAddr = vm.envAddress("ESG_REGISTRY");
        ESGRegistry esg = ESGRegistry(registryAddr);

        vm.startBroadcast();

        // ── Crypto ────────────────────────────────────────────────────────────
        // sBTC: high energy consumption (PoW), moderate community, moderate governance
        esg.setESG(SBTC,  15, 40, 60, "CCC");   // composite 38

        // sETH: PoS transition cuts energy use dramatically
        esg.setESG(SETH,  35, 55, 70, "A");      // composite 53

        // ── Equity ───────────────────────────────────────────────────────────
        // sAAPL: strong sustainability commitments, high governance standards
        esg.setESG(SAAPL, 72, 78, 85, "AA");     // composite 78

        // sTSLA: EV mission but supply chain / labour controversies
        esg.setESG(STSLA, 60, 52, 65, "A");      // composite 59

        // sNVDA: moderate energy efficiency roadmap, good governance
        esg.setESG(SNVDA, 55, 60, 75, "A");      // composite 63

        // sMSFT: carbon-negative pledge, strong disclosure, high governance
        esg.setESG(SMSFT, 78, 72, 88, "AA");     // composite 79

        // sGOOGL: renewable energy leader, some antitrust/data concerns
        esg.setESG(SGOOGL, 68, 65, 80, "AA");    // composite 71

        // ── Commodity ────────────────────────────────────────────────────────
        // sGOLD: mining impact on land/water, community tensions
        esg.setESG(SGOLD, 40, 50, 55, "BBB");    // composite 48

        // ── Bond ─────────────────────────────────────────────────────────────
        // sBOND: US Treasuries — stable governance, no direct env/social harm
        esg.setESG(SBOND, 65, 70, 80, "AA");     // composite 72

        // ── ESG ETFs ─────────────────────────────────────────────────────────
        // sICLN: clean-energy focused; land use & grid stability concerns
        esg.setESG(SICLN, 90, 75, 78, "AAA");    // composite 81

        // sESGU: broad MSCI USA ESG screened index
        esg.setESG(SESGU, 88, 80, 82, "AAA");    // composite 83

        vm.stopBroadcast();

        console.log("SeedESG complete on:", registryAddr);
    }
}
