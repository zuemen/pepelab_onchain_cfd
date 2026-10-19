// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/PerpetualExchange.sol";
import "../../src/FeeRouter.sol";
import "../../src/MockOracle.sol";
import "../../src/PlatformFeeSplitter.sol";
import "../../src/PepeIncentives.sol";
import "../../src/EsgRewardDistributor.sol";
import "../../script/Redeploy130Hardened.s.sol";
import "../../script/DeployCarbonRetirement.s.sol";
import "../../script/RedeployInsuranceStack.s.sol";
import "../../script/DeployPepeIncentives.s.sol";
import "../../script/Deploy102RewardDistributor.s.sol";

/// @notice #344 against live Base Sepolia state: OWNER_ACTIONS step 5 with
///         ORACLE_KIND=fresh, the contract half of putting the simulated
///         traders on the public site. Reads back what the issue's testing
///         decisions ask for: the new exchange reads a NEW MockOracle (owned by
///         the deployer, seeded at today's prices, separate from the shared
///         one), keeps the existing KYC registry, the platform FeeRouter pays
///         #333's splitter, and PepeIncentives / EsgRewardDistributor bind the
///         new exchange. Nothing is broadcast; the scripts run in-process.
///
///         No process-wide env for anything another fork test also reads
///         (ORACLE_KIND, RESUME_*, EXCHANGE_NEW, PERPETUAL_EXCHANGE…): forge
///         runs the suites in parallel and vm.setEnv is shared. The scripts'
///         override hooks / runWith take those instead.
///
///         Skipped unless the suite itself runs on a Base Sepolia fork:
///           forge test --match-path test/fork/HeroesCutoverFork.t.sol \
///             --fork-url https://sepolia.base.org -vv
contract HeroesCutoverForkTest is Test {
    address constant OWNER  = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant USDC   = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant KYC    = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address constant ESG_V2 = 0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf;
    address constant MOCK_ORACLE    = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
    address constant GUARDED_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;
    address constant PEPE_TOKEN     = 0xCCD05CBdC2f7961a4C27D3633694022722786A0F;
    address constant BADGE          = 0x0a4aE14a413a03c20ccF43E8134BfbD7bCB89820;

    // Same name as CarbonCutoverFork / CutoverGovernanceFork, which also set GUARDIAN:
    // makeAddr is deterministic, so the shared env holds one value whichever runs first.
    address guardian = makeAddr("guardian");

    string[11] syms = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
        // Keeper heartbeat (as CarbonCutoverFork): the preflight refuses a seed
        // source older than 6h, and the live MockOracle may be.
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p,) = IOracle(MOCK_ORACLE).getPrice(id);
            vm.prank(KEEPER);
            MockOracle(MOCK_ORACLE).updatePrice(id, p);
        }
        vm.deal(guardian, 1 ether);
        vm.setEnv("GUARDIAN", vm.toString(guardian));
    }

    function _cutover() internal returns (Redeploy130Hardened cut) {
        cut = new Redeploy130Hardened();
        cut.setBroadcasterOverride(OWNER);
        cut.setOracleKindOverride("fresh");
        cut.run();
    }

    function test_fork_freshOracle_isDedicatedSeededAndOwnedByTheDeployer() public {
        Redeploy130Hardened cut = _cutover();
        (address exchange,,,,) = cut.lastDeployed();
        address oracle = cut.lastOracle();

        PerpetualExchange ex = PerpetualExchange(payable(exchange));
        assertEq(address(ex.oracle()), oracle, "exchange reads the fresh oracle");
        assertTrue(oracle != MOCK_ORACLE && oracle != GUARDED_ORACLE, "not a shared oracle");
        assertEq(MockOracle(oracle).owner(), OWNER, "the deployer writes the replay's prices");
        assertEq(address(ex.kyc()), KYC, "existing KYC registry kept");
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 seeded,) = IOracle(oracle).getPrice(id);
            (uint256 shared,) = IOracle(MOCK_ORACLE).getPrice(id);
            assertEq(seeded, shared, string.concat("seeded at today's price: ", syms[i]));
        }

        // The point of a dedicated oracle: the replay's 2024 prices never reach the shared one.
        bytes32 btc = keccak256("sBTC");
        (uint256 sharedBefore, uint256 sharedAt) = IOracle(MOCK_ORACLE).getPrice(btc);
        vm.prank(OWNER);
        MockOracle(oracle).updatePrice(btc, 60_000e8);
        (uint256 replayPrice,) = IOracle(oracle).getPrice(btc);
        (uint256 sharedAfter, uint256 sharedAtAfter) = IOracle(MOCK_ORACLE).getPrice(btc);
        assertEq(replayPrice, 60_000e8);
        assertEq(sharedAfter, sharedBefore, "shared oracle untouched");
        assertEq(sharedAtAfter, sharedAt);

        // After the replay the keeper takes it over (OWNER_ACTIONS step 5, #344).
        vm.prank(OWNER);
        MockOracle(oracle).transferOwnership(KEEPER);
        assertEq(MockOracle(oracle).owner(), KEEPER);
    }

    function test_fork_freshOracle_resumesOnTheSameOracleAndExchange() public {
        Redeploy130Hardened first = new Redeploy130Hardened();
        first.setBroadcasterOverride(OWNER);
        first.setOracleKindOverride("fresh");
        first.setHaltAfterStep(1);
        first.run();
        (address exchange,,,,) = first.lastDeployed();
        address oracle = first.lastOracle();
        assertTrue(oracle != address(0) && exchange != address(0));

        // RESUME_EXCHANGE without RESUME_ORACLE would deploy a second oracle the
        // exchange can never read: refused before anything is sent.
        Redeploy130Hardened noOracle = new Redeploy130Hardened();
        noOracle.setBroadcasterOverride(OWNER);
        noOracle.setOracleKindOverride("fresh");
        Cutover130Base.Deployed130 memory r;
        r.exchange = exchange;
        noOracle.setResumeOverride(r);
        vm.expectRevert(bytes("RESUME_EXCHANGE with ORACLE_KIND=fresh needs RESUME_ORACLE (the exchange holds it immutable)"));
        noOracle.run();

        Redeploy130Hardened resumed = new Redeploy130Hardened();
        resumed.setBroadcasterOverride(OWNER);
        resumed.setOracleKindOverride("fresh");
        resumed.setResumeOverride(r);
        resumed.setResumeOracleOverride(oracle);
        resumed.run();
        (address exchange2,,,,) = resumed.lastDeployed();
        assertEq(exchange2, exchange, "same exchange");
        assertEq(resumed.lastOracle(), oracle, "same oracle");
    }

    function test_fork_freshOracle_refusesASharedOracleAsResume() public {
        Redeploy130Hardened cut = new Redeploy130Hardened();
        cut.setBroadcasterOverride(OWNER);
        cut.setOracleKindOverride("fresh");
        cut.setResumeOracleOverride(MOCK_ORACLE);
        vm.expectRevert(bytes("RESUME_ORACLE is a shared oracle - ORACLE_KIND=fresh means a dedicated one"));
        cut.run();
    }

    function test_fork_fullStep5_splitterIncentivesAndRewardsBindTheNewExchange() public {
        Redeploy130Hardened cut = _cutover();
        (address exchange,, address registry,, address traderStake) = cut.lastDeployed();

        // #333 carbon stack as the owner, then the platform FeeRouter paying its splitter.
        vm.setEnv("BROADCASTER", vm.toString(OWNER));
        vm.setEnv("CARBON_USDC", vm.toString(USDC));
        vm.setEnv("CARBON_TREASURY", vm.toString(OWNER));
        vm.setEnv("CARBON_DEPLOY_ROUTER", "false");
        vm.setEnv("CARBON_CHAIN_ID", "84532");
        DeployCarbonRetirement.Deployment memory carbon = new DeployCarbonRetirement().run();
        PlatformFeeSplitter splitter = carbon.splitter;

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
        (address[] memory targets,, bytes[] memory payloads,,,) = stack.followUpBatch(c, d);
        for (uint256 i; i < targets.length; i++) {
            vm.prank(OWNER);
            (bool ok,) = targets[i].call(payloads[i]);
            require(ok, "follow-up call failed");
        }

        PerpetualExchange ex = PerpetualExchange(payable(exchange));
        assertEq(address(ex.feeRouter()), d.router, "exchange pays the new platform FeeRouter");
        assertEq(FeeRouter(d.router).platformTreasury(), address(splitter), "platform share goes to #333's splitter");
        assertEq(address(splitter.feeRouter()), d.router, "splitter bound to it");
        assertEq(ex.copyTracker(), d.copyTracker);
        assertEq(address(ex.oracle()), cut.lastOracle(), "still the fresh oracle");
        assertEq(address(ex.kyc()), KYC, "still the existing KYC registry");

        // PepeIncentives and EsgRewardDistributor hold the exchange immutable: redeployed onto the new one.
        DeployPepeIncentives inc = new DeployPepeIncentives();
        inc.setBroadcasterOverride(OWNER);
        PepeIncentives incentives = inc.runWith(PEPE_TOKEN, exchange, d.copyTracker, address(0));
        assertEq(address(incentives.exchange()), exchange, "PepeIncentives -> new exchange");
        assertEq(address(incentives.copyTracker()), d.copyTracker, "PepeIncentives -> final CopyTracker");

        Deploy102RewardDistributor rew = new Deploy102RewardDistributor();
        rew.setBroadcasterOverride(OWNER);
        EsgRewardDistributor distributor = rew.runWith(exchange, ESG_V2, BADGE);
        assertEq(address(distributor.exchange()), exchange, "EsgRewardDistributor -> new exchange");
        assertEq(address(distributor.esgRegistry()), ESG_V2);
        assertEq(address(distributor.badge()), BADGE);
    }
}
