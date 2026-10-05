// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/TraderStake.sol";
import "../src/InsuranceVault.sol";
import "../src/FeeRouter.sol";
import "../src/CopyTracker.sol";
import "../script/RedeployInsuranceStack.s.sol";

/// Exercises the OWNER_ACTIONS step 5 item 4 batch end to end on a local chain.
/// Each guard gets a case that proves it fires — the script exists to refuse the
/// unsafe orderings in INSURANCE_VAULT_SHARES.md §5.3, so "it deploys" is the
/// least interesting thing to test.
contract RedeployInsuranceStackTest is Test {
    RedeployInsuranceStack script;
    MockUSDC usdc;
    PerpetualExchange exchange;
    StrategyRegistry registry;
    TraderStake stake;
    TimelockController timelock;

    address deployer = makeAddr("deployer");
    address treasury = makeAddr("treasury");
    address constant LEAKED = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    function setUp() public {
        usdc = new MockUSDC();
        MockOracle oracle = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        stake = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(stake));
        timelock = new TimelockController(2 days, new address[](0), new address[](0), address(0));
        script = new RedeployInsuranceStack();
        usdc.mint(deployer, 10e18);
        // HandoverToTimelock phase 1 has run: the timelock governs the exchange.
        exchange.transferOwnership(address(timelock));
    }

    function _cfg() internal view returns (RedeployInsuranceStack.Config memory c) {
        c.deployer         = deployer;
        c.usdc             = address(usdc);
        c.exchange         = address(exchange);
        c.registry         = address(registry);
        c.traderStake      = address(stake);
        c.treasury         = treasury;
        c.timelock         = address(timelock);
        c.minTimelockDelay = 24 hours;
    }

    // ── Happy path ───────────────────────────────────────────────────────────

    function test_fullBatch_seedsWiresAndHandsOverToTimelock() public {
        RedeployInsuranceStack.Deployed memory d = script.runWith(_cfg());

        InsuranceVault v = InsuranceVault(d.vault);
        FeeRouter r = FeeRouter(d.router);
        CopyTracker ct = CopyTracker(d.copyTracker);

        assertEq(v.owner(), address(timelock), "vault handed to timelock");
        assertEq(r.owner(), address(timelock), "router handed to timelock");
        assertEq(ct.owner(), address(timelock), "copyTracker handed to timelock (slash reserve)");
        assertEq(r.platformTreasury(), treasury, "treasury is the new one");
        assertEq(address(r.insuranceVault()), d.vault);
        assertEq(address(ct.feeRouter()), d.router);
        assertEq(v.feeRouter(), d.router);
        assertEq(v.exchange(), address(exchange));
        assertEq(v.balanceOf(deployer), v.totalSupply(), "every share belongs to the seeder");
        assertEq(usdc.balanceOf(deployer), 9e18, "exactly one whole token seeded by default");
    }

    function test_keepDeployerOwner_leavesDeployerAsOwner() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        c.keepDeployerOwner = true;
        RedeployInsuranceStack.Deployed memory d = script.runWith(c);
        assertEq(InsuranceVault(d.vault).owner(), deployer);
        assertEq(FeeRouter(d.router).owner(), deployer);
        assertEq(CopyTracker(d.copyTracker).owner(), deployer);
    }

    // ── Treasury guards: the reason this batch exists ───────────────────────

    function test_rejects_zeroTreasury() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.treasury = address(0);
        vm.expectRevert(bytes("TREASURY is required and must not be zero"));
        script.runWith(c);
    }

    function test_rejects_leakedDeployerAsTreasury() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.treasury = LEAKED;
        vm.expectRevert(bytes("TREASURY is a known-compromised address"));
        script.runWith(c);
    }

    function test_rejects_7702DelegatedTreasury() public {
        address delegated = makeAddr("delegated");
        // 0xef0100 ‖ delegate — what the sweeper put on 0xE80A…Eb93.
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        RedeployInsuranceStack.Config memory c = _cfg();
        c.treasury = delegated;
        vm.expectRevert(bytes("TREASURY is EIP-7702 delegated - treated as taken over"));
        script.runWith(c);
    }

    // ── Exchange / timelock / seed guards ───────────────────────────────────

    function test_rejects_pre130Exchange() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.exchange = address(registry); // has code, has no marketOperator()
        vm.expectRevert(bytes(
            "EXCHANGE predates #130 (no marketOperator) - run Redeploy130Hardened first, INSURANCE_VAULT_SHARES.md 5.3"));
        script.runWith(c);
    }

    function test_rejects_missingTimelockWithoutOptOut() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        vm.expectRevert(bytes("TIMELOCK is required (or KEEP_DEPLOYER_OWNER=true where governance is not live)"));
        script.runWith(c);
    }

    function test_rejects_shortTimelock() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(new TimelockController(1 hours, new address[](0), new address[](0), address(0)));
        vm.expectRevert(bytes("timelock minDelay below MIN_TIMELOCK_DELAY"));
        script.runWith(c);
    }

    function test_rejects_seedBelowOneWholeToken() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.seedAmount = 1e18 - 1;
        vm.expectRevert(bytes("SEED_AMOUNT below one whole token (INSURANCE_VAULT_SHARES.md 5.2)"));
        script.runWith(c);
    }

    function test_rejects_deployerWithoutSeedFunds() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.deployer = makeAddr("broke");
        vm.expectRevert(bytes(
            "deployer holds less USDC than SEED_AMOUNT - seed must be NEW funds, not withdrawn from the old vault"));
        script.runWith(c);
    }

    /// The §3.3 trap: a zero-supply vault that already has an inflow source must
    /// not be seeded — anything that arrived first belongs to virtual shares forever.
    function test_refuses_toSeedVaultThatAlreadyHasInflowSource() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        pre.setFeeRouter(makeAddr("someRouter"));
        vm.stopPrank();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        vm.expectRevert(bytes(
            "vault has zero supply but an inflow source is wired - inflows would accrue to virtual shares forever"));
        script.runWith(c);
    }

    // ── Resume ───────────────────────────────────────────────────────────────

    /// Interrupted after the seed: resuming must not seed twice.
    function test_resume_afterSeed_doesNotSeedAgain() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        usdc.approve(address(pre), 1e18);
        pre.deposit(1e18);
        vm.stopPrank();
        uint256 supplyBefore = pre.totalSupply();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        RedeployInsuranceStack.Deployed memory d = script.runWith(c);

        assertEq(d.vault, address(pre), "kept the resumed vault");
        assertEq(pre.totalSupply(), supplyBefore, "no second seed");
        assertEq(usdc.balanceOf(deployer), 9e18, "only the original seed left the wallet");
        assertEq(pre.owner(), address(timelock));
    }

    function test_resume_rejectsRouterBuiltForAnotherVault() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        FeeRouter wrong = new FeeRouter(address(usdc), treasury, makeAddr("otherVault"));
        vm.stopPrank();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        c.resumeRouter = address(wrong);
        vm.expectRevert(bytes("RESUME_FEE_ROUTER: built for a different vault"));
        script.runWith(c);
    }

    function test_resume_rejectsRouterWithDifferentTreasury() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        FeeRouter wrong = new FeeRouter(address(usdc), LEAKED, address(pre));
        vm.stopPrank();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        c.resumeRouter = address(wrong);
        vm.expectRevert(bytes("RESUME_FEE_ROUTER: different TREASURY"));
        script.runWith(c);
    }

    // ── Verify catches drift on the real chain ──────────────────────────────

    function test_verify_catchesRewiredVault() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        c.keepDeployerOwner = true;
        RedeployInsuranceStack.Deployed memory d = script.runWith(c);

        vm.prank(deployer);
        InsuranceVault(d.vault).setExchange(makeAddr("attacker"));

        vm.expectRevert(bytes("readback: vault.exchange()"));
        script.verify(c, d);
    }

    // ── Review round 1 (PR #254) ─────────────────────────────────────────────

    function test_rejects_treasuryThatIsAProtocolContract() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.treasury = address(usdc);
        vm.expectRevert(bytes("TREASURY is a protocol contract - the router's treasury is immutable, fees would be stuck"));
        script.runWith(c);
    }

    function test_rejects_leakedDeployer() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.deployer = LEAKED;
        vm.expectRevert(bytes("deployer is a known-compromised address"));
        script.runWith(c);
    }

    function test_rejects_7702DelegatedDeployer() public {
        vm.etch(deployer, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        vm.expectRevert(bytes("deployer is EIP-7702 delegated - a sweeper would take the seed"));
        script.runWith(_cfg());
    }

    function test_rejects_timelockThatDoesNotOwnTheExchange() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        // Valid delay, but role-less and unrelated to the exchange: handing
        // ownership to it would brick the stack.
        c.timelock = address(new TimelockController(2 days, new address[](0), new address[](0), address(0)));
        vm.expectRevert(bytes(
            "EXCHANGE is not owned by TIMELOCK - run HandoverToTimelock phase 1 first; a wrong or role-less timelock would brick the stack"));
        script.runWith(c);
    }

    function test_rejects_timelockAndKeepDeployerOwnerTogether() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.keepDeployerOwner = true;
        vm.expectRevert(bytes("set TIMELOCK or KEEP_DEPLOYER_OWNER, not both"));
        script.runWith(c);
    }

    function test_rejects_exchangeOnAnotherUsdc() public {
        MockUSDC other = new MockUSDC();
        RedeployInsuranceStack.Config memory c = _cfg();
        c.usdc = address(other);
        vm.expectRevert(bytes("EXCHANGE settles in a different USDC"));
        script.runWith(c);
    }

    /// A stranger's dust deposit makes totalSupply > 0. It must not count as
    /// the platform seed: the deployer still seeds.
    function test_resume_strangerDust_isNotTheSeed() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        vm.stopPrank();
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 1);
        vm.startPrank(stranger);
        usdc.approve(address(pre), 1);
        pre.deposit(1);
        vm.stopPrank();
        assertGt(pre.totalSupply(), 0);

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        script.runWith(c);

        assertEq(usdc.balanceOf(deployer), 9e18, "the deployer seeded anyway");
        assertGe(pre.previewWithdraw(pre.balanceOf(deployer)), 1e18 - 1e15);
    }

    function test_resume_rejectsZeroSupplyVaultHoldingAssets() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        usdc.approve(address(pre), 1);
        pre.recapitalize(1);
        vm.stopPrank();
        assertEq(pre.totalSupply(), 0);

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        vm.expectRevert(bytes(
            "vault has zero supply but holds assets - they already belong to the virtual shares; deploy a fresh vault"));
        script.runWith(c);
    }

    function test_resume_rejectsZeroSupplyVaultWiredToAnExchange() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        pre.setExchange(makeAddr("someExchange"));
        vm.stopPrank();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        vm.expectRevert(bytes(
            "vault has zero supply but an inflow source is wired - inflows would accrue to virtual shares forever"));
        script.runWith(c);
    }

    function test_resume_rejectsSomethingThatIsNotAVirtualShareVault() public {
        // Has a matching usdc(), but is not an InsuranceVault at all.
        FeeRouter notAVault = new FeeRouter(address(usdc), treasury, makeAddr("v"));
        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(notAVault);
        vm.expectRevert(bytes("RESUME_VAULT is not a virtual-share InsuranceVault (no DECIMALS_OFFSET 6)"));
        script.runWith(c);
    }

    function test_resume_rejectsTheExchangesCurrentVault() public {
        vm.startPrank(deployer);
        InsuranceVault live = new InsuranceVault(address(usdc));
        vm.stopPrank();
        vm.prank(address(timelock));
        exchange.setInsuranceVault(address(live));

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(live);
        vm.expectRevert(bytes("RESUME_VAULT is the exchange's current vault - the one this batch replaces"));
        script.runWith(c);
    }

    function test_resume_fullStack_endToEnd() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        c.keepDeployerOwner = true;
        RedeployInsuranceStack.Deployed memory first = script.runWith(c);

        // Re-run against everything the first run produced: nothing new, no second seed.
        c.resumeVault = first.vault;
        c.resumeRouter = first.router;
        c.resumeCopyTracker = first.copyTracker;
        RedeployInsuranceStack.Deployed memory again = script.runWith(c);
        assertEq(again.vault, first.vault);
        assertEq(again.router, first.router);
        assertEq(again.copyTracker, first.copyTracker);
        assertEq(usdc.balanceOf(deployer), 9e18, "seeded exactly once");
    }

    function test_resume_rejectsCopyTrackerOnAnotherRouter() public {
        vm.startPrank(deployer);
        InsuranceVault pre = new InsuranceVault(address(usdc));
        FeeRouter router = new FeeRouter(address(usdc), treasury, address(pre));
        CopyTracker wrong = new CopyTracker(
            address(usdc), address(exchange), address(registry), makeAddr("otherRouter"), address(stake));
        vm.stopPrank();

        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeVault = address(pre);
        c.resumeRouter = address(router);
        c.resumeCopyTracker = address(wrong);
        vm.expectRevert(bytes("RESUME_COPY_TRACKER: different fee router"));
        script.runWith(c);
    }

    function test_rejects_resumeCopyTrackerWithoutRouter() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.resumeCopyTracker = makeAddr("ct");
        vm.expectRevert(bytes("RESUME_COPY_TRACKER needs RESUME_FEE_ROUTER - its feeRouter is immutable"));
        script.runWith(c);
    }

    function test_verify_catchesCopyTrackerLeftWithDeployer() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        c.keepDeployerOwner = true;
        RedeployInsuranceStack.Deployed memory d = script.runWith(c);

        // Read back as if the run had targeted the timelock: vault and router
        // moved, the CopyTracker did not — that must be caught.
        vm.startPrank(deployer);
        InsuranceVault(d.vault).transferOwnership(address(timelock));
        FeeRouter(d.router).transferOwnership(address(timelock));
        vm.stopPrank();
        c.timelock = address(timelock);
        c.keepDeployerOwner = false;
        vm.expectRevert(bytes("readback: copyTracker.owner()"));
        script.verify(c, d);
    }

    function test_verify_catchesSeedWithdrawnAfterwards() public {
        RedeployInsuranceStack.Config memory c = _cfg();
        c.timelock = address(0);
        c.keepDeployerOwner = true;
        RedeployInsuranceStack.Deployed memory d = script.runWith(c);

        InsuranceVault v = InsuranceVault(d.vault);
        uint256 shares = v.balanceOf(deployer);
        vm.prank(deployer);
        v.withdraw(shares / 2);
        vm.expectRevert(bytes("readback: deployer's seed position below SEED_AMOUNT"));
        script.verify(c, d);
    }

    // No 6-decimal case: PerpetualExchange's constructor refuses any USDC that
    // is not 18 decimals, so the seed default is always 1e18 on this stack.
}
