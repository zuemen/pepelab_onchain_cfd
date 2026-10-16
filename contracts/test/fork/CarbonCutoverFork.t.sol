// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/PerpetualExchange.sol";
import "../../src/StrategyRegistry.sol";
import "../../src/TraderStake.sol";
import "../../src/CopyTracker.sol";
import "../../src/FeeRouter.sol";
import "../../src/PlatformFeeSplitter.sol";
import "../../src/CarbonRetirement.sol";
import "../../src/MockCarbonCredit.sol";
import "../../script/Redeploy130Hardened.s.sol";
import "../../script/DeployCarbonRetirement.s.sol";
import "../../script/RedeployInsuranceStack.s.sol";

/// @notice #333 against live Base Sepolia state: the part of the #344 cutover
///         (OWNER_ACTIONS step 5) that puts carbon retirement behind the new
///         platform FeeRouter. #130 cutover → DeployCarbonRetirement
///         (CARBON_DEPLOY_ROUTER=false, treasury = owner) → RedeployInsuranceStack
///         with CARBON_SPLITTER → read back → one real follow → distribute →
///         retire. Nothing is broadcast; the scripts run in-process.
///
///         Governance is not live on the fork, so the insurance stack keeps the
///         deployer as owner (KEEP_DEPLOYER_OWNER) and the follow-up batch is sent
///         by the owner directly. The real cutover routes the same four calls
///         through the timelock; the carbon wiring does not depend on who sends them.
///
///         Skipped unless the suite itself runs on a Base Sepolia fork:
///           forge test --match-path test/fork/CarbonCutoverFork.t.sol \
///             --fork-url https://sepolia.base.org -vv
contract CarbonCutoverForkTest is Test {
    address constant OWNER  = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant USDC   = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant MOCK_ORACLE = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;

    address guardian = makeAddr("guardian");
    address trader   = makeAddr("carbon-trader");
    address follower = makeAddr("carbon-follower");

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
        // Keeper heartbeat, as in CutoverGovernanceFork: the cutover preflight
        // refuses prices older than 6h, and the live MockOracle may be.
        string[11] memory syms =
            ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p,) = IOracle(MOCK_ORACLE).getPrice(id);
            vm.prank(KEEPER);
            (bool ok,) = MOCK_ORACLE.call(abi.encodeWithSignature("updatePrice(bytes32,uint256)", id, p));
            require(ok, "keeper heartbeat failed");
        }
        // Pranked callers with no ETH revert with 0 gas on a Base Sepolia fork
        // (see CutoverGovernanceFork). Fund every one of them.
        vm.deal(guardian, 1 ether);
        vm.deal(trader, 1 ether);
        vm.deal(follower, 1 ether);
    }

    function test_fork_followFeesReachCarbonRetirementThroughTheNewRouter() public {
        // ── 1. #130 cutover: the post-#130 exchange RedeployInsuranceStack requires ──
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        Redeploy130Hardened cut = new Redeploy130Hardened();
        cut.setBroadcasterOverride(OWNER);
        cut.run();
        (address exchange,, address registry,, address traderStake) = cut.lastDeployed();

        // ── 2. Carbon stack, as the owner, without a router of its own ──────────
        vm.setEnv("BROADCASTER", vm.toString(OWNER));
        vm.setEnv("CARBON_USDC", vm.toString(USDC));
        vm.setEnv("CARBON_TREASURY", vm.toString(OWNER));
        vm.setEnv("CARBON_DEPLOY_ROUTER", "false");
        vm.setEnv("CARBON_CHAIN_ID", "84532");
        DeployCarbonRetirement.Deployment memory carbon = new DeployCarbonRetirement().run();
        assertEq(address(carbon.router), address(0), "no stand-alone router on this path");
        PlatformFeeSplitter splitter = carbon.splitter;
        assertEq(splitter.deployer(), OWNER, "the owner can bind it");

        // ── 3. The platform FeeRouter, paying the splitter ──────────────────────
        deal(USDC, OWNER, IERC20(USDC).balanceOf(OWNER) + 10e18); // the vault seed
        RedeployInsuranceStack stack = new RedeployInsuranceStack();
        RedeployInsuranceStack.Config memory c;
        c.deployer          = OWNER;
        c.usdc              = USDC;
        c.exchange          = exchange;
        c.registry          = registry;
        c.traderStake       = traderStake;
        c.treasury          = OWNER;
        c.carbonSplitter    = address(splitter);
        c.keepDeployerOwner = true;
        c.minTimelockDelay  = 24 hours;
        RedeployInsuranceStack.Deployed memory d = stack.runWith(c);

        // Read back what the issue asks for.
        assertEq(FeeRouter(d.router).platformTreasury(), address(splitter), "router pays the splitter");
        assertEq(splitter.treasury(), OWNER, "the splitter's remainder goes to the owner");
        assertTrue(splitter.treasury() != 0xE80A81360608C1342e66743F70a00f75d792Eb93, "not the leaked address");
        assertEq(address(splitter.feeRouter()), d.router, "bound");
        assertEq(splitter.carbonShareBps(), 2500);

        // ── 4. Follow-up batch, sent by the owner (no timelock on the fork) ─────
        (address[] memory targets,, bytes[] memory payloads,,,) = stack.followUpBatch(c, d);
        for (uint256 i; i < targets.length; i++) {
            vm.prank(OWNER);
            (bool ok,) = targets[i].call(payloads[i]);
            require(ok, "follow-up call failed");
        }
        assertEq(PerpetualExchange(payable(exchange)).copyTracker(), d.copyTracker);

        // ── 5. One follow → distribute → retire ─────────────────────────────────
        deal(USDC, trader, 1_000e18);
        vm.startPrank(trader);
        IERC20(USDC).approve(traderStake, 1_000e18);
        TraderStake(traderStake).stake(1_000e18);
        StrategyRegistry(registry).registerTrader("Carbon Fork");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation(keccak256("sETH"), 4_000, true, 1);
        allocs[1] = StrategyRegistry.Allocation(keccak256("sBTC"), 3_000, true, 1);
        allocs[2] = StrategyRegistry.Allocation(keccak256("sGOLD"), 3_000, true, 1);
        StrategyRegistry(registry).publishStrategy(allocs);
        vm.stopPrank();

        uint256 amount = 1_000e18;
        deal(USDC, follower, amount);
        uint256 execFee = PerpetualExchange(payable(exchange)).executionFee();
        vm.startPrank(follower);
        IERC20(USDC).approve(d.copyTracker, amount);
        CopyTracker(payable(d.copyTracker)).followTrader{value: execFee * 3}(trader, amount);
        vm.stopPrank();

        // 0.3% copy fee = 3; platform 20% = 0.6; carbon 25% of that = 0.15.
        assertEq(splitter.pending(), 0.6e18, "platform share accrued for the splitter");
        uint256 ownerBefore = IERC20(USDC).balanceOf(OWNER);
        splitter.distribute();
        CarbonRetirement retirement = carbon.retirement;
        assertEq(retirement.budget(), 0.15e18, "carbon slice funded");
        assertEq(IERC20(USDC).balanceOf(OWNER) - ownerBefore, 0.45e18, "remainder to the owner");

        MockCarbonCredit credit = carbon.credit;
        uint256 burnedBefore = credit.totalBurned();
        uint256 tonnes = retirement.retire(retirement.budget());
        // Default simulated price: 10 MockUSDC per tonne.
        assertEq(tonnes, 0.015e18);
        assertEq(retirement.totalRetiredTonnes(), 0.015e18);
        assertEq(credit.totalBurned() - burnedBefore, 0.015e18);
    }
}
