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
}
