// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/TraderStake.sol";
import "../src/InsuranceVault.sol";
import "../src/FeeRouter.sol";
import "../src/CopyTracker.sol";
import "../script/RedeployCopyTrackerAutoSync.s.sol";

/// @dev 只有 copyTracker()／usdc()／owner() 的假交易所：沒有自動同步需要的函式。
contract LegacyExchangeStub {
    address public copyTracker;
    address public usdc;
    address public owner;

    constructor(address _ct, address _usdc) {
        copyTracker = _ct;
        usdc = _usdc;
        owner = msg.sender;
    }
}

/// 部署腳本端到端：只部署、不改接；印出的 owner 呼叫照送之後，新 tracker 的
/// 跟單＋自動同步整條路徑可用；每一道防呆都有一個會觸發它的案例。
contract RedeployCopyTrackerAutoSyncTest is Test {
    RedeployCopyTrackerAutoSync script;
    MockUSDC          usdc;
    MockOracle        oracle;
    TraderStake       ts;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    InsuranceVault    vault;
    FeeRouter         router;
    CopyTracker       oldCt;

    address deployer = makeAddr("deployer");
    address treasury = makeAddr("treasury");
    address governance = makeAddr("governance");
    address trader = makeAddr("trader");
    address follower = makeAddr("follower");
    address keeper = makeAddr("keeper");
    address constant LEAKED = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        vault    = new InsuranceVault(address(usdc));
        router   = new FeeRouter(address(usdc), treasury, address(vault));
        oldCt    = new CopyTracker(address(usdc), address(exchange), address(registry), address(router), address(ts));

        vault.setFeeRouter(address(router));
        vault.setExchange(address(exchange));
        router.setExchange(address(exchange));
        router.setCopyTracker(address(oldCt));
        ts.setCopyTracker(address(oldCt));
        exchange.setCopyTracker(address(oldCt));
        exchange.setFeeRouter(address(router));
        exchange.setInsuranceVault(address(vault));
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 1_000e8);
        usdc.mint(address(exchange), 1_000_000e18);

        usdc.mint(trader, 1_000e18);
        vm.startPrank(trader);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(500e18);
        registry.registerTrader("Trader");
        registry.publishStrategy(_allocs(true));
        vm.stopPrank();

        usdc.mint(follower, 100_000e18);
        vm.deal(follower, 10 ether);
        vm.prank(follower);
        usdc.approve(address(oldCt), type(uint256).max);

        script = new RedeployCopyTrackerAutoSync();
    }

    function _allocs(bool btcLong) internal pure returns (StrategyRegistry.Allocation[] memory a) {
        a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, btcLong, 2);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
    }

    function _cfg() internal view returns (RedeployCopyTrackerAutoSync.Config memory c) {
        c.deployer = deployer;
        c.exchange = address(exchange);
    }

    function _sendOwnerCalls(RedeployCopyTrackerAutoSync.Config memory cfg, address newCt) internal {
        RedeployCopyTrackerAutoSync.OwnerCall[] memory calls = script.ownerCalls(script.resolve(cfg), newCt);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(calls[i].owner);
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].payload);
            assertTrue(ok, string(ret));
        }
    }

    // ── 只部署、不改接 ───────────────────────────────────────────────────────

    function test_deploysWithLiveImmutables_andDoesNotRewire() public {
        address newCt = script.runWith(_cfg());
        CopyTracker ct = CopyTracker(newCt);

        assertEq(address(ct.exchange()), address(exchange));
        assertEq(address(ct.usdc()), address(usdc));
        assertEq(address(ct.registry()), address(registry));
        assertEq(address(ct.traderStake()), address(ts));
        assertEq(address(ct.feeRouter()), address(router));
        assertEq(ct.owner(), exchange.owner(), "same governance as the exchange");
        assertEq(ct.MAX_TIP_WEI(), 0.001 ether);
        assertEq(ct.MIN_SYNC_INTERVAL(), 1 hours);

        // 沒有任何 owner 呼叫被送出
        assertEq(exchange.copyTracker(), address(oldCt));
        assertFalse(exchange.authorizedAgents(newCt));
        assertEq(ts.copyTracker(), address(oldCt));
        assertEq(router.copyTracker(), address(oldCt));
    }

    function test_ownerCalls_targetsAndPayloads() public {
        address newCt = script.runWith(_cfg());
        RedeployCopyTrackerAutoSync.OwnerCall[] memory calls = script.ownerCalls(script.resolve(_cfg()), newCt);
        assertEq(calls.length, 3);
        // 順序：FeeRouter → TraderStake → exchange（最後）。exchange 那一筆撤銷舊 tracker，放最後才 fail closed。
        assertEq(calls[0].target, address(router));
        assertEq(calls[0].owner, router.owner());
        assertEq(calls[0].payload, abi.encodeCall(FeeRouter.setCopyTracker, (newCt)));
        assertEq(calls[1].target, address(ts));
        assertEq(calls[1].owner, ts.owner());
        assertEq(calls[1].payload, abi.encodeCall(TraderStake.setCopyTracker, (newCt)));
        assertEq(calls[2].target, address(exchange));
        assertEq(calls[2].owner, exchange.owner());
        assertEq(calls[2].payload, abi.encodeCall(PerpetualExchange.setCopyTracker, (newCt)));

        RedeployCopyTrackerAutoSync.Config memory resolved = script.resolve(_cfg());
        vm.expectRevert(bytes("not wired: exchange.copyTracker()"));
        script.requireWired(resolved, newCt);
        _sendOwnerCalls(_cfg(), newCt);
        script.requireWired(resolved, newCt);
    }

    /// 改接之後，新 tracker 上「跟單＋自動同步 → 交易者發新版 → 第三方同步」整條可用。
    function test_afterOwnerCalls_autoSyncWorksEndToEnd() public {
        address newCtAddr = script.runWith(_cfg());
        _sendOwnerCalls(_cfg(), newCtAddr);
        CopyTracker ct = CopyTracker(newCtAddr);

        vm.startPrank(follower);
        usdc.approve(newCtAddr, type(uint256).max);
        uint256 fee = exchange.executionFee();
        ct.followTraderAtVersionWithAutoSync{value: fee * 3 + 0.01 ether}(trader, 1_000e18, 0, 5, 1 hours, 0.0001 ether, fee);
        vm.stopPrank();
        assertGt(router.traderEarnings(trader), 0, "copy fee routed: FeeRouter accepted the new tracker");

        vm.prank(trader);
        registry.publishStrategy(_allocs(false));
        vm.warp(ct.syncReadyAt(follower, 0));   // 跟隨者設定的冷卻（合約下限 1 小時）
        vm.prank(keeper);
        ct.resyncFor(follower, 0);
        assertEq(ct.getCopyRecords(follower)[0].versionId, 1);
        assertEq(keeper.balance, 0.0001 ether);
    }

    /// 照腳本印出的順序送到一半就停（exchange 那一筆還沒送）：舊 tracker 仍有授權、既有跟單照常
    /// 取消；新 tracker 還不能開倉。這就是 exchange 放最後的理由（fail closed）。
    function test_ownerCalls_partialRunFailsClosed() public {
        uint256 fee = exchange.executionFee();
        vm.prank(follower);
        oldCt.followTrader{value: fee * 3}(trader, 1_000e18);

        address newCtAddr = script.runWith(_cfg());
        RedeployCopyTrackerAutoSync.OwnerCall[] memory calls = script.ownerCalls(script.resolve(_cfg()), newCtAddr);
        assertEq(calls[calls.length - 1].target, address(exchange), "exchange call is last");
        for (uint256 i; i + 1 < calls.length; ++i) {
            vm.prank(calls[i].owner);
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].payload);
            assertTrue(ok, string(ret));
        }

        assertEq(exchange.copyTracker(), address(oldCt));
        assertTrue(exchange.authorizedAgents(address(oldCt)));
        assertFalse(exchange.authorizedAgents(newCtAddr));
        // 舊 tracker 上的既有跟單仍關得掉（tracker 還有交易所授權）
        vm.prank(follower);
        oldCt.unfollowAndCloseAll(0);
        assertEq(exchange.getUserPositions(follower).length, 0);
        // 新 tracker 還沒有授權：跟單開不起來
        vm.startPrank(follower);
        usdc.approve(newCtAddr, type(uint256).max);
        vm.expectRevert();
        CopyTracker(newCtAddr).followTraderAtVersionWithAutoSync{value: fee * 3}(trader, 1_000e18, 0, 5, 1 hours, 0, fee);
        vm.stopPrank();
    }

    /// FeeRouter 若沒改接，新 tracker 的每一筆跟單都會在收跟單費時 revert
    /// ——所以腳本把它列為第一筆 owner 呼叫。
    function test_withoutFeeRouterCall_newFollowsRevert() public {
        address newCtAddr = script.runWith(_cfg());
        vm.prank(exchange.owner());
        exchange.setCopyTracker(newCtAddr);
        vm.prank(ts.owner());
        ts.setCopyTracker(newCtAddr);

        vm.startPrank(follower);
        usdc.approve(newCtAddr, type(uint256).max);
        uint256 fee = exchange.executionFee();
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        CopyTracker(newCtAddr).followTraderAtVersionWithAutoSync{value: fee * 3}(trader, 1_000e18, 0, 5, 1 hours, 0, fee);
        vm.stopPrank();
    }

    /// 舊 tracker 上的跟單：改接後 tracker 無法再平倉；出口是 deactivateWithoutScoring
    /// 之後自己在交易所平倉。
    function test_oldTrackerFollowers_exitAfterSwitch() public {
        uint256 fee = exchange.executionFee();
        vm.prank(follower);
        oldCt.followTrader{value: fee * 3}(trader, 1_000e18);
        uint256[] memory ids = oldCt.getCopyRecords(follower)[0].positionIds;

        address newCt = script.runWith(_cfg());
        _sendOwnerCalls(_cfg(), newCt);

        vm.prank(follower);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, ids[0]));
        oldCt.unfollowAndCloseAll(0);

        vm.prank(follower);
        oldCt.deactivateWithoutScoring(0);
        vm.startPrank(follower);
        for (uint256 i; i < ids.length; ++i) exchange.closePosition(ids[i]);
        vm.stopPrank();
        assertEq(exchange.getUserPositions(follower).length, 0);
    }

    // ── 擁有權 ─────────────────────────────────────────────────────────────

    function test_newOwnerDefaultsToExchangeOwner_andIsTransferredInTheSameBroadcast() public {
        exchange.transferOwnership(governance);
        address newCt = script.runWith(_cfg());
        assertEq(CopyTracker(newCt).owner(), governance);
    }

    function test_explicitNewOwner() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.newOwner = deployer;
        address newCt = script.runWith(c);
        assertEq(CopyTracker(newCt).owner(), deployer);
    }

    // ── 防呆 ───────────────────────────────────────────────────────────────

    function test_refusesExchangeWithoutCode() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.exchange = makeAddr("nothing");
        vm.expectRevert(bytes("EXCHANGE has no code"));
        script.runWith(c);
    }

    function test_refusesLegacyExchangeWithoutAutoSyncGetters() public {
        LegacyExchangeStub stub = new LegacyExchangeStub(address(0), address(usdc));
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.exchange = address(stub);
        c.usdc = address(usdc);
        c.registry = address(registry);
        c.traderStake = address(ts);
        vm.expectRevert(bytes("EXCHANGE lacks maxLeverageForAsset - redeploy the exchange from this revision first"));
        script.runWith(c);
    }

    function test_refusesDifferentRegistry() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.registry = address(new StrategyRegistry(address(ts)));
        vm.expectRevert(bytes("REGISTRY differs from the exchange's current CopyTracker.registry()"));
        script.runWith(c);
    }

    function test_refusesStakeThatIsNotTheRegistryGate() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.traderStake = address(new TraderStake(address(usdc)));
        vm.expectRevert(bytes("TRADER_STAKE is not REGISTRY.stakeContract() - slashing would target a different stake"));
        script.runWith(c);
    }

    function test_refusesFeeRouterForAnotherExchange() public {
        FeeRouter other = new FeeRouter(address(usdc), treasury, address(vault));
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.feeRouter = address(other);
        c.feeRouterSet = true;
        vm.expectRevert(bytes("FEE_ROUTER.exchange() is not EXCHANGE"));
        script.runWith(c);
    }

    /// FEE_ROUTER=0 明確給定：新 tracker 不收跟單費，owner 呼叫只剩兩筆。
    function test_explicitZeroFeeRouter() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.feeRouterSet = true;
        address newCt = script.runWith(c);
        assertEq(address(CopyTracker(newCt).feeRouter()), address(0));
        RedeployCopyTrackerAutoSync.OwnerCall[] memory calls = script.ownerCalls(script.resolve(c), newCt);
        assertEq(calls.length, 2);
        assertEq(calls[0].target, address(ts));
        assertEq(calls[1].target, address(exchange), "exchange call is still last");
    }

    function test_refusesCompromisedDeployerOrOwner() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.deployer = LEAKED;
        vm.expectRevert(bytes("deployer is a known-compromised address"));
        script.runWith(c);

        c = _cfg();
        c.newOwner = LEAKED;
        vm.expectRevert(bytes("NEW_OWNER is a known-compromised address"));
        script.runWith(c);
    }

    function test_refusesWrongUsdc() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.usdc = address(new MockUSDC());
        vm.expectRevert(bytes("USDC is not the exchange's settlement token"));
        script.runWith(c);
    }

    // ── 續跑 ───────────────────────────────────────────────────────────────

    function test_resumeReusesTracker() public {
        address first = script.runWith(_cfg());
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        c.resumeCopyTracker = first;
        c.newOwner = CopyTracker(first).owner();
        assertEq(script.runWith(c), first);
    }

    function test_resumeRefusesOldTrackerOrMismatch() public {
        RedeployCopyTrackerAutoSync.Config memory c = _cfg();
        // 舊版（沒有 MAX_TIP_WEI）的 tracker 用一個只有基本 getter 的 stub 模擬不到，
        // 改用「不同 fee router」驗證 immutable 逐一比對。
        CopyTracker mismatched =
            new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(ts));
        c.resumeCopyTracker = address(mismatched);
        vm.expectRevert(bytes("RESUME_COPY_TRACKER: different fee router"));
        script.runWith(c);

        c.resumeCopyTracker = address(vault);
        vm.expectRevert(bytes("RESUME_COPY_TRACKER is not an auto-sync CopyTracker (no MAX_TIP_WEI)"));
        script.runWith(c);

        // 審查修正前的自動同步版（有 MAX_TIP_WEI、沒有冷卻下限與執行費上限）也不能續跑
        c.resumeCopyTracker = address(new PreReviewAutoSyncStub());
        vm.expectRevert(
            bytes("RESUME_COPY_TRACKER predates the auto-sync fee-cap/cooldown fixes (no MIN_SYNC_INTERVAL)")
        );
        script.runWith(c);

        // 有冷卻下限、沒有指定執行者（syncExecutor）的版本也不能續跑
        c.resumeCopyTracker = address(new PreExecutorAutoSyncStub());
        vm.expectRevert(bytes("RESUME_COPY_TRACKER predates the designated-executor fix (no syncExecutor)"));
        script.runWith(c);
    }
}

/// @dev 有 MAX_TIP_WEI 與 MIN_SYNC_INTERVAL、沒有 syncExecutor：代表指定執行者之前編出來的 tracker。
contract PreExecutorAutoSyncStub {
    function MAX_TIP_WEI() external pure returns (uint256) {
        return 0.001 ether;
    }

    function MIN_SYNC_INTERVAL() external pure returns (uint32) {
        return 1 hours;
    }
}

/// @dev 只回答 MAX_TIP_WEI 的 stub：代表審查修正前編出來的自動同步版 tracker。
contract PreReviewAutoSyncStub {
    function MAX_TIP_WEI() external pure returns (uint256) {
        return 0.001 ether;
    }
}
