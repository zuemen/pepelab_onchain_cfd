// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "../../src/PerpetualExchange.sol";
import "../../script/Redeploy130Hardened.s.sol";
import "../../script/Verify130.s.sol";
import "../../script/DeployGovernance.s.sol";
import "../../script/HandoverToTimelock.s.sol";
import "../../script/VerifyHandover.s.sol";

/// @notice Fork simulation of the whole #130 sequence against live Base
///         Sepolia state: cutover → Verify130 → caps/guardian behave →
///         DeployGovernance → handover phase 1 → a real timelock proposal →
///         handover phase 2. Nothing is broadcast; the scripts run in-process.
///
///         Skipped unless the suite itself runs on a Base Sepolia fork:
///           forge test --match-path test/fork/CutoverGovernanceFork.t.sol \
///             --fork-url https://sepolia.base.org -vv
contract CutoverGovernanceForkTest is Test {
    address constant OWNER    = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER   = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant USDC     = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant INS      = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant FEE_R    = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant TSTAKE   = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address constant KYC_REG  = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address constant VAULT    = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;
    address constant G_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;
    address constant ESG_V2   = 0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf;

    address guardian = makeAddr("guardian");
    address safe     = makeAddr("safe");
    address trader   = makeAddr("trader");

    bytes32 constant BTC = keccak256("sBTC");

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
        // Keeper heartbeat: the live MockOracle may be more than 6h old at the
        // fork block, which the cutover preflight rightly refuses. Re-post the
        // current prices from the keeper (MockOracle's owner), as the runbook
        // tells the operator to do before broadcasting.
        address mock = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
        string[11] memory syms = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p, ) = IOracle(mock).getPrice(id);
            vm.prank(KEEPER);
            (bool ok, ) = mock.call(abi.encodeWithSignature("updatePrice(bytes32,uint256)", id, p));
            require(ok, "keeper heartbeat failed");
        }
    }

    function _cutover() internal returns (Cutover130Base.Deployed130 memory d) {
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        Redeploy130Hardened r = new Redeploy130Hardened();
        r.setBroadcasterOverride(OWNER);
        r.run();
        (d.exchange, d.copyTracker, d.strategyRegistry, d.sessionManager, d.traderStake) = r.lastDeployed();
    }

    function test_fork_cutoverThenTimelockHandover() public {
        // ── A. cutover + standalone Verify130 ─────────────────────────────
        Cutover130Base.Deployed130 memory d = _cutover();
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        vm.setEnv("EXCHANGE_NEW", vm.toString(d.exchange));
        vm.setEnv("COPYTRACKER_NEW", vm.toString(d.copyTracker));
        vm.setEnv("STRATEGY_REGISTRY_NEW", vm.toString(d.strategyRegistry));
        vm.setEnv("SESSION_MANAGER_NEW", vm.toString(d.sessionManager));
        vm.setEnv("EXPECTED_OWNER", vm.toString(OWNER));
        // Exactly the runbook sec.5.4 command: the whole-USDC caps the cutover printed.
        vm.setEnv("OI_CAP_NON_RWA_USDC", vm.toString(ex.maxLongOI(BTC) / 1e18));
        vm.setEnv("OI_CAP_RWA_USDC", vm.toString(ex.maxLongOI(keccak256("sAAPL")) / 1e18));
        assertEq(ex.maxLongOI(keccak256("sAAPL")) % 1e18, 0, "RWA cap is whole USDC");
        new Verify130().run();

        // OI cap is enforced (1,499 USDC per side on sBTC at today's insurance).
        uint256 cap = ex.maxLongOI(BTC);
        assertGt(cap, 0);
        deal(USDC, trader, 3_000e18);
        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        IERC20(USDC).approve(d.exchange, type(uint256).max);
        ex.depositMargin(2_500e18);
        // sBTC is carbon tier High on the live registry → max leverage 1x.
        ex.openPosition{value: 1e14}(BTC, true, 500e18, 1);                 // ~500 notional: fits
        vm.expectRevert();                                                  // OpenInterestCapExceeded
        ex.openPosition{value: 1e14}(BTC, true, 1_100e18, 1);               // +1,100 > cap
        vm.stopPrank();
        assertEq(ex.profitCapOf(0), ex.getPosition(0).margin * 5, "profit cap frozen at 5x margin");

        // Guardian can brake, cannot release.
        vm.prank(guardian); ex.pause();
        assertTrue(ex.paused());
        vm.prank(guardian); vm.expectRevert(); ex.unpause();
        vm.prank(OWNER); ex.unpause();

        // ── B. governance ──────────────────────────────────────────────────
        vm.setEnv("TIMELOCK_PROPOSER", vm.toString(safe));
        vm.setEnv("TIMELOCK_EXECUTOR", vm.toString(safe));
        vm.setEnv("ALLOW_EOA_ROLES", "true");   // `safe` is a plain address on the fork
        DeployGovernance g = new DeployGovernance();
        g.setBroadcasterOverride(OWNER);
        TimelockController tl = g.run();
        assertEq(tl.getMinDelay(), 48 hours);

        HandoverToTimelock h = new HandoverToTimelock();
        h.setBroadcasterOverride(OWNER);
        vm.setEnv("TIMELOCK", vm.toString(address(tl)));

        // phase 2 before phase 1 must refuse (would orphan nothing yet, but the order is the guard).
        vm.setEnv("HANDOVER_PHASE", "2");
        vm.expectRevert(bytes("PerpetualExchange: owner != timelock - run phase 1 first"));
        h.run();

        vm.setEnv("HANDOVER_PHASE", "1");
        h.run();
        address[6] memory owned = [d.exchange, d.copyTracker, INS, FEE_R, TSTAKE, KYC_REG];
        for (uint256 i; i < owned.length; i++) assertEq(Ownable(owned[i]).owner(), address(tl));
        assertTrue(IAccessControl(VAULT).hasRole(0x00, address(tl)));
        assertTrue(IAccessControl(VAULT).hasRole(0x00, OWNER), "phase 1 keeps the deployer admin");
        assertTrue(IAccessControl(ESG_V2).hasRole(0x00, address(tl)), "ESGRegistryV2 admin granted");
        vm.setEnv("EXPECT_PHASE", "1");
        new VerifyHandover().run();

        vm.setEnv("EXPECTED_OWNER", vm.toString(address(tl)));
        new Verify130().run();

        // The deployer key is now powerless on the exchange; the guardian is not.
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        ex.setMaxProfitBps(BTC, 60_000);
        vm.warp(block.timestamp + 25 hours);   // past the 24h guardian cooldown from the first pause
        vm.prank(guardian); ex.pause();
        assertTrue(ex.paused(), "guardian stays a hot key after handover");

        // A real proposal, end to end: unpause + retune through the 48h delay.
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        targets[0] = d.exchange; datas[0] = abi.encodeCall(PerpetualExchange.unpause, ());
        targets[1] = d.exchange; datas[1] = abi.encodeCall(PerpetualExchange.setMaxProfitBps, (BTC, 60_000));
        vm.prank(safe); tl.scheduleBatch(targets, values, datas, bytes32(0), bytes32("p1"), 48 hours);
        vm.prank(safe); vm.expectRevert(); tl.executeBatch(targets, values, datas, bytes32(0), bytes32("p1"));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(safe); tl.executeBatch(targets, values, datas, bytes32(0), bytes32("p1"));
        assertFalse(ex.paused());
        assertEq(ex.maxProfitBps(BTC), 60_000);

        // phase 2: the deployer drops its admin only now.
        vm.setEnv("HANDOVER_PHASE", "2");
        h.run();
        assertFalse(IAccessControl(VAULT).hasRole(0x00, OWNER));
        assertFalse(IAccessControl(G_ORACLE).hasRole(0x00, OWNER));
        assertTrue(IAccessControl(VAULT).hasRole(0x00, address(tl)));
        assertTrue(IAccessControl(G_ORACLE).hasRole(0x00, address(tl)));
        assertFalse(IAccessControl(ESG_V2).hasRole(0x00, OWNER));
        vm.setEnv("EXPECT_PHASE", "2");
        new VerifyHandover().run();
        // Hot keeper role on the oracle untouched.
        assertTrue(IAccessControl(G_ORACLE).hasRole(keccak256("KEEPER_ROLE"), KEEPER));
    }

    /// @dev Interrupted broadcast, then re-run. Two cut points:
    ///      (a) after the CopyTracker exists (step 6) — nothing shared touched yet;
    ///      (b) after InsuranceVault was re-pointed but FeeRouter was not (step 9)
    ///          — the worst place to die. A plain re-run must refuse; a RESUME
    ///          run must finish on the SAME exchange.
    function test_fork_interruptedCutoverResumes() public {
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        uint256 snap = vm.snapshotState();

        for (uint256 k; k < 2; k++) {
            uint256 cut = k == 0 ? 6 : 9;
            vm.revertToState(snap);

            Redeploy130Hardened r1 = new Redeploy130Hardened();
            r1.setBroadcasterOverride(OWNER);
            r1.setHaltAfterStep(cut);
            r1.run();
            Cutover130Base.Deployed130 memory d1;
            (d1.exchange, d1.copyTracker, d1.strategyRegistry, d1.sessionManager, d1.traderStake) = r1.lastDeployed();
            assertTrue(d1.exchange != address(0));

            if (cut == 9) {
                assertEq(IInsVault130(INS).exchange(), d1.exchange, "half re-pointed: vault moved");
                assertEq(FeeRouter(FEE_R).exchange(), 0x827eA0c62a32e995927101259042F8A27D99124D, "half re-pointed: router not");
                Redeploy130Hardened fresh = new Redeploy130Hardened();
                fresh.setBroadcasterOverride(OWNER);
                vm.expectRevert(bytes("InsuranceVault.exchange != old exchange - partial cutover detected; re-run with RESUME_* (runbook sec.9), never from scratch"));
                fresh.run();
            }

            Redeploy130Hardened r2 = new Redeploy130Hardened();
            r2.setBroadcasterOverride(OWNER);
            r2.setResumeOverride(d1);
            r2.run();   // ends with the full Verify130 assertion set
            Cutover130Base.Deployed130 memory d2;
            (d2.exchange, d2.copyTracker, d2.strategyRegistry, d2.sessionManager, d2.traderStake) = r2.lastDeployed();
            assertEq(d2.exchange, d1.exchange, "no second exchange");
            assertEq(d2.copyTracker, d1.copyTracker);
            if (cut == 6) assertTrue(d2.sessionManager != address(0));
            else assertEq(d2.sessionManager, d1.sessionManager);
            assertEq(FeeRouter(FEE_R).copyTracker(), d1.copyTracker);
        }
    }
}
