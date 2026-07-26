// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/PerpetualExchange.sol";
import "../src/InsuranceVault.sol";
import "../src/KYCRegistry.sol";
import "../src/AgentSessionManager.sol";

/// @notice P3-3: one-command end-to-end capstone narrative. Deploys a fresh
///         stack and walks the full PepeLab story, printing the key numbers at
///         every step:
///           ① seed an RWA market (XAU) with a tighter leverage cap (N3)
///           ② account KYC, gated open on the RWA market (G2)
///           ③ LP seeds the market-making vault (N1)
///           ④ user delegates a bounded agent session (Phase 2)
///           ⑤ agent opens a position THROUGH the session — autonomous order
///           ⑥ mark vs index price from OI imbalance (G6)
///           ⑦ MM vault share price rises from routed trading fees (N1)
///           ⑧ a crash liquidates a losing leg and ADL haircuts a winner (N2)
///
///         Run (pure simulation, deterministic, no node needed):
///           forge script script/DemoE2E.s.sol -vvv
///         Or against a local node for real tx hashes:
///           forge script script/DemoE2E.s.sol --broadcast --rpc-url http://localhost:8545
///
///         The x402 "paid signal → decision" leg is the off-chain agent stack
///         (see agent/README.md: `npm run signal-api` + `npm run demo-agent`);
///         this script covers the on-chain half that the agent's order lands in.
contract DemoE2E is Script {
    bytes32 constant SBTC = keccak256("sBTC");
    bytes32 constant XAU  = keccak256("XAU"); // RWA: gold

    MockUSDC          usdc;
    MockOracle        oracle;
    PerpetualExchange exchange;
    InsuranceVault    vault;
    KYCRegistry       kyc;
    AgentSessionManager sessions;

    // Actors (deterministic).
    address owner   = address(this);
    address alice   = vm.addr(0xA11CE);   // trader / LP / session owner
    address agent   = vm.addr(0xA6E47);   // session key (self-custodied EOA)
    address bear    = vm.addr(0xB4A7);    // winning counterparty (gets ADL'd)
    address keeper  = vm.addr(0x4EE9E5);  // liquidation keeper

    function run() external {
        _deployAndConfigure();
        _step1_seedRwa();
        _step2_kycAndGating();
        _step3_lpSeedsVault();
        _step4_createSession();
        _step5_agentOpensThroughSession();
        _step6_markVsIndex();
        _step7_vaultYield();
        _step8_crashLiquidationAdl();
        console.log("\n=== DEMO COMPLETE ===");
    }

    // ──────────────────────────────────────────────────────────────────────────

    function _deployAndConfigure() internal {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        vault    = new InsuranceVault(address(usdc));
        kyc      = new KYCRegistry();
        sessions = new AgentSessionManager(address(exchange));

        // Wiring (same setters Deploy.s.sol uses).
        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));
        exchange.setKycRegistry(address(kyc));
        exchange.setCopyTracker(address(sessions));        // primary agent + authorizes it
        exchange.setAgentAuthorized(address(sessions), true);

        // Demo economics: no gas/exec fee noise, 0.1% trading fee, half to LPs,
        // a small OI mark premium, ADL on.
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(10);
        exchange.setVaultFeeShareBps(5_000);   // N1: 50% of fee → LP vault
        exchange.setMarkPremiumCapBps(50);     // G6: ±0.5% mark premium cap
        exchange.setAdlEnabled(true);          // N2

        oracle.addAsset(SBTC, 100_000e8);
        oracle.addAsset(XAU,    2_000e8);

        // Fund actors + protocol reserves.
        usdc.mint(alice, 1_000_000e18);
        usdc.mint(bear,  1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); usdc.approve(address(vault),    type(uint256).max);
        vm.prank(bear);  usdc.approve(address(exchange), type(uint256).max);

        console.log("=== PepeLab on-chain CFD - end-to-end demo ===");
        console.log("exchange :", address(exchange));
        console.log("vault    :", address(vault));
        console.log("sessions :", address(sessions));
    }

    function _step1_seedRwa() internal {
        // N3: gold is an RWA → tighter 2x leverage cap + KYC required.
        exchange.setRwaAsset(XAU, true);
        exchange.setMaxLeverageFor(XAU, 2);
        console.log("\n[1] Seeded RWA market XAU (gold): RWA=true, maxLeverage=%s", exchange.maxLeverageForAsset(XAU));
    }

    function _step2_kycAndGating() internal {
        vm.prank(alice); exchange.depositMargin(50_000e18);

        // Before KYC: opening the RWA market reverts.
        vm.prank(alice);
        try exchange.openPosition(XAU, true, 1_000e18, 2) returns (uint256) {
            console.log("[2] UNEXPECTED: RWA open succeeded without KYC");
        } catch {
            console.log("\n[2] Pre-KYC open on XAU correctly BLOCKED (compliance gate)");
        }

        // Complete (mock) KYC, then the RWA open succeeds.
        vm.prank(alice); kyc.submitKYC("Alice", "TW");
        vm.prank(alice); uint256 pid = exchange.openPosition(XAU, true, 1_000e18, 2);
        console.log("    KYC verified -> XAU position opened, id=%s", pid);
    }

    function _step3_lpSeedsVault() internal {
        vm.prank(alice); uint256 shares = vault.deposit(20_000e18);
        console.log("\n[3] LP seeded MM vault: deposited 20000 USDC, shares=%s, sharePrice=%s",
            shares / 1e18, vault.getSharePrice());
    }

    function _step4_createSession() internal {
        // Bounded delegation: 2k per trade, 10k budget, max 5x, 1 day.
        vm.prank(alice);
        uint256 sid = sessions.createSession(agent, 2_000e18, 10_000e18, 5, block.timestamp + 1 days);
        console.log("\n[4] Alice delegated bounded agent session id=%s (perTrade=2000, budget=10000, maxLev=5)", sid);
    }

    function _step5_agentOpensThroughSession() internal {
        // The agent (session key) opens a sBTC long FOR alice, inside the limits.
        vm.prank(agent);
        uint256 pid = sessions.openPositionForSession(0, SBTC, true, 1_500e18, 5, address(0));
        console.log("\n[5] Agent opened sBTC LONG through session: positionId=%s, margin=1500, lev=5", pid);
        (, , uint256 spent, uint256 budget, , , ) = _session(0);
        console.log("    session budget used: %s / %s USDC", spent / 1e18, budget / 1e18);
    }

    function _step6_markVsIndex() internal view {
        uint256 idx  = 100_000e18;
        uint256 mark = exchange.getMarkPrice(SBTC);
        // sBTC book is long-heavy (alice's long) → mark trades above index.
        console.log("\n[6] sBTC index=%s, mark=%s (mark > index: longs pay the OI premium)",
            idx / 1e18, mark / 1e18);
    }

    function _step7_vaultYield() internal {
        // Open + close a round trip to realize trading fees → routed to the vault.
        vm.prank(bear); exchange.depositMargin(50_000e18);
        uint256 before_ = vault.getSharePrice();
        vm.prank(bear); uint256 pid = exchange.openPosition(SBTC, false, 2_000e18, 5);
        vm.prank(bear); exchange.closePosition(pid);
        console.log("\n[7] After trading activity, MM vault sharePrice: %s -> %s (LP yield from fees)",
            before_, vault.getSharePrice());
        console.log("    cumulative fees routed to LPs: %s USDC", exchange.cumulativeVaultFees() / 1e18);
    }

    function _step8_crashLiquidationAdl() internal {
        // A large losing long (alice) and a large winning short (bear): on the
        // crash the long's loss dwarfs the vault, so ADL must haircut the winner.
        vm.prank(alice); uint256 loserId  = exchange.openPosition(SBTC, true,  40_000e18, 5); // 200k long
        vm.prank(bear);  uint256 winnerId = exchange.openPosition(SBTC, false, 40_000e18, 5); // 200k short

        // Crash sBTC -40%.
        oracle.updatePrice(SBTC, 60_000e8);
        console.log("\n[8] sBTC crashes -40%% -> liquidate Alice's losing long with ADL backstop");

        uint256 shortOiBefore = exchange.globalShortNotional(SBTC);
        uint256 vaultBefore   = vault.totalAssets();

        vm.prank(keeper);
        exchange.liquidatePosition(loserId);

        PerpetualExchange.Position memory w = exchange.getPosition(winnerId);
        console.log("    loser long liquidated; vault drawn %s -> %s USDC (insurance first)",
            vaultBefore / 1e18, vault.totalAssets() / 1e18);
        console.log("    ADL force-closed winner id=%s: open=%s, realizedPnL(after haircut)=%s",
            winnerId, w.isOpen, _u(w.realizedPnL) / 1e18);
        console.log("    sBTC short OI %s -> %s", shortOiBefore / 1e18, exchange.globalShortNotional(SBTC) / 1e18);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _session(uint256 id)
        internal
        view
        returns (address, address, uint256, uint256, uint256, uint256, bool)
    {
        (address u, address a, uint256 perTrade, uint256 budget, uint256 spent, uint256 maxLev, uint256 expiry, bool revoked)
            = sessions.sessions(id);
        u; a; perTrade; maxLev; expiry;
        return (u, a, spent, budget, maxLev, expiry, revoked);
    }

    function _u(int256 v) internal pure returns (uint256) {
        return v < 0 ? uint256(-v) : uint256(v);
    }
}
