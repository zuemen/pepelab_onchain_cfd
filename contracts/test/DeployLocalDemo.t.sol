// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployLocalDemo.s.sol";

contract DeployLocalDemoTest is Test {
    DeployLocalDemo internal script;
    DeployLocalDemo.Deployed internal d;
    address internal deployer = makeAddr("deployer");
    address internal trader = makeAddr("trader");

    string[11] internal SYMBOLS =
        ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

    function setUp() public {
        script = new DeployLocalDemo();
        d = script.deploy(deployer);
    }

    function _id(string memory symbol) internal pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    function _exchange() internal view returns (PerpetualExchange) {
        return PerpetualExchange(payable(d.exchange));
    }

    function _fund(address who, bool verified) internal {
        vm.deal(who, 1 ether);
        vm.prank(deployer);
        MockUSDC(d.usdc).mint(who, 10_000e18);
        if (verified) {
            address[] memory list = new address[](1);
            list[0] = who;
            vm.prank(deployer);
            KYCRegistry(d.kyc).batchVerify(list);
        }
        vm.startPrank(who);
        MockUSDC(d.usdc).approve(d.exchange, 10_000e18);
        _exchange().depositMargin(10_000e18);
        vm.stopPrank();
    }

    function test_everyAssetHasAPrice() public view {
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            (uint256 price,) = MockOracle(d.oracle).getPrice(_id(SYMBOLS[i]));
            assertGt(price, 0, SYMBOLS[i]);
        }
    }

    function test_carbonTierSetsTheLeverageCeilingAndTheFee() public view {
        PerpetualExchange ex = _exchange();
        // Low
        assertEq(ex.maxLeverageForAsset(_id("sETH")), 5);
        assertEq(ex.tradingFeeBpsForAsset(_id("sETH")), 10);
        // High
        assertEq(ex.maxLeverageForAsset(_id("sBTC")), 1);
        assertEq(ex.tradingFeeBpsForAsset(_id("sBTC")), 100);
        // The two equity ETFs are High on iShares' own WACI (docs/data/carbon-tier-etf-waci.md).
        // No listed asset is Mid; CarbonPricing.t.sol covers that tier with its own fixtures.
        assertEq(ex.maxLeverageForAsset(_id("sICLN")), 1);
        assertEq(ex.tradingFeeBpsForAsset(_id("sICLN")), 100);
        assertEq(ex.maxLeverageForAsset(_id("sESGU")), 1);
        assertEq(ex.tradingFeeBpsForAsset(_id("sESGU")), 100);
    }

    function test_attestationsOutliveATwoYearReplay() public {
        vm.warp(block.timestamp + 800 days);
        assertEq(_exchange().maxLeverageForAsset(_id("sETH")), 5);
    }

    function test_aVerifiedTraderCanOpenOnEveryAsset() public {
        _fund(trader, true);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            _exchange().openPosition{value: fee}(_id(SYMBOLS[i]), true, 20e18, 1);
        }
        vm.stopPrank();
        assertEq(_exchange().getUserPositions(trader).length, 11);
    }

    function test_regulatedMarketsNeedKycAndCryptoDoesNot() public {
        _fund(trader, false);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        _exchange().openPosition{value: fee}(_id("sBTC"), true, 20e18, 1);
        _exchange().openPosition{value: fee}(_id("sGOLD"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sAAPL"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sBOND"), true, 20e18, 1);
        vm.stopPrank();
    }

    function test_theCopyStackIsWiredAndTheInsuranceVaultIsFunded() public view {
        assertEq(TraderStake(d.traderStake).copyTracker(), d.copyTracker);
        assertEq(address(CopyTracker(payable(d.copyTracker)).exchange()), d.exchange);
        assertEq(address(CopyTracker(payable(d.copyTracker)).registry()), d.strategyRegistry);
        assertTrue(_exchange().authorizedAgents(d.copyTracker));
        assertEq(InsuranceVault(payable(d.insuranceVault)).totalAssets(), 500_000e18);
        assertEq(_exchange().maxPriceAge(), 7 days);
    }

    // ── #333：跟單手續費的平台份額經分流合約導向碳權退役（ADR-022） ─────────────

    address internal alice = makeAddr("alice");
    address internal follower = makeAddr("follower");

    /// alice 質押、註冊、發布三個不需 KYC 的資產；follower 跟單 `amount`。
    function _followOnce(uint256 amount) internal {
        vm.startPrank(deployer);
        MockUSDC(d.usdc).mint(alice, 1_000e18);
        MockUSDC(d.usdc).mint(follower, amount);
        vm.stopPrank();
        vm.startPrank(alice);
        MockUSDC(d.usdc).approve(d.traderStake, 1_000e18);
        TraderStake(d.traderStake).stake(1_000e18);
        StrategyRegistry(d.strategyRegistry).registerTrader("Alice");
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation(_id("sETH"), 4_000, true, 1);
        allocs[1] = StrategyRegistry.Allocation(_id("sBTC"), 3_000, true, 1);
        allocs[2] = StrategyRegistry.Allocation(_id("sGOLD"), 3_000, true, 1);
        StrategyRegistry(d.strategyRegistry).publishStrategy(allocs);
        vm.stopPrank();

        vm.deal(follower, 1 ether);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(follower);
        MockUSDC(d.usdc).approve(d.copyTracker, amount);
        CopyTracker(payable(d.copyTracker)).followTrader{value: fee * 3}(alice, amount);
        vm.stopPrank();
    }

    function test_thePlatformPayeeIsTheSplitterAndItsShareIsFixed() public view {
        PlatformFeeSplitter splitter = PlatformFeeSplitter(d.feeSplitter);
        assertEq(FeeRouter(d.feeRouter).platformTreasury(), d.feeSplitter);
        assertEq(address(splitter.feeRouter()), d.feeRouter);
        assertEq(splitter.carbonRetirement(), d.carbonRetirement);
        assertEq(splitter.carbonShareBps(), 2500);
        assertEq(splitter.treasury(), deployer);
        assertTrue(CarbonRetirement(d.carbonRetirement).SIMULATED());
        assertEq(address(CarbonRetirement(d.carbonRetirement).credit()), d.carbonCredit);
    }

    function test_aFollowFundsRetirementAndTheRetirementBurnsCredits() public {
        _followOnce(10_000e18);
        PlatformFeeSplitter splitter = PlatformFeeSplitter(d.feeSplitter);
        CarbonRetirement retirement = CarbonRetirement(d.carbonRetirement);
        MockCarbonCredit credit = MockCarbonCredit(d.carbonCredit);

        // 跟單費 0.3% = 30；平台 20% = 6；其中 25% = 1.5 進退役預算，4.5 給 treasury。
        assertEq(splitter.pending(), 6e18);
        uint256 treasuryBefore = MockUSDC(d.usdc).balanceOf(deployer);
        splitter.distribute();
        assertEq(retirement.budget(), 1.5e18);
        assertEq(MockUSDC(d.usdc).balanceOf(deployer) - treasuryBefore, 4.5e18);

        uint256 supplyBefore = credit.totalSupply();
        uint256 tonnes = retirement.retire(retirement.budget());
        // 每公噸 10 枚結算幣：1.5 → 0.15 公噸。
        assertEq(tonnes, 0.15e18);
        assertEq(retirement.totalRetiredTonnes(), 0.15e18);
        assertEq(credit.totalBurned(), 0.15e18);
        assertEq(supplyBefore - credit.totalSupply(), 0.15e18);
        assertEq(retirement.budget(), 0);
    }

    function test_theTreasuryHasNoPathAroundTheCarbonShare() public {
        _followOnce(10_000e18);
        vm.prank(deployer);
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        FeeRouter(d.feeRouter).withdrawPlatformFees();
    }

    function test_theSellerCanDeliverEveryRetirementTheReplayFunds() public view {
        // 庫存給模擬賣方（部署者）並授權給退役合約；兩年回放的退役量遠小於這個數字。
        assertGe(CarbonRetirement(d.carbonRetirement).availableTonnes(), 100_000e18);
    }

    function test_refusesToRunOffTheLocalChain() public {
        vm.chainId(84532);
        DeployLocalDemo other = new DeployLocalDemo();
        vm.expectRevert(abi.encodeWithSelector(DeployLocalDemo.NotLocalChain.selector, uint256(84532)));
        other.deploy(deployer);
    }
}
