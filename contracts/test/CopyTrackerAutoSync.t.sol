// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../src/TraderStake.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";

/// @notice 共用夾具：交易者 alice（有質押）、跟隨者 bob、第三方執行者 keeper。
///         交易／借貸費預設 0、executionFee 非 0（油箱帳要對得上），沒有保險金庫。
abstract contract AutoSyncFixture is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    TraderStake       ts;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;
    KYCRegistry       kyc;

    address alice  = makeAddr("alice");   // 交易者
    address bob    = makeAddr("bob");     // 跟隨者
    address keeper = makeAddr("keeper");  // 第三方執行者
    address carol  = makeAddr("carol");   // 另一個跟隨者

    bytes32 constant BTC  = keccak256("BTC");
    bytes32 constant ETH  = keccak256("ETH");
    bytes32 constant SOL  = keccak256("SOL");
    bytes32 constant XAU  = keccak256("XAU");   // RWA：需要 KYC
    bytes32 constant AAPL = keccak256("AAPL");

    uint256 constant EXEC_FEE = 0.0001 ether;
    uint96  constant TIP      = 0.00005 ether;
    uint256 constant TANK     = 0.01 ether;
    /// 合約允許的最短冷卻（CopyTracker.MIN_SYNC_INTERVAL）。
    uint32  constant CD       = 1 hours;

    function setUp() public virtual {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        ts       = new TraderStake(address(usdc));
        registry = new StrategyRegistry(address(ts));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(ts));
        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setExecutionFee(EXEC_FEE);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        kyc = new KYCRegistry();
        exchange.setKycRegistry(address(kyc));
        exchange.setRwaAsset(XAU, true);

        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 1_000e8);
        oracle.addAsset(XAU, 2_000e8);
        oracle.addAsset(AAPL, 200e8);

        usdc.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(500e18);
        registry.registerTrader("Alice");
        registry.publishStrategy(_v0());
        vm.stopPrank();

        usdc.mint(address(exchange), 1_000_000e18);
        _fund(bob);
        _fund(carol);
    }

    function _fund(address who) internal {
        usdc.mint(who, 100_000e18);
        vm.deal(who, 10 ether);
        vm.startPrank(who);
        usdc.approve(address(ct), type(uint256).max);
        usdc.approve(address(exchange), type(uint256).max);
        vm.stopPrank();
    }

    /// v0：BTC 50% 多 2x、ETH 30% 多 1x、SOL 20% 多 1x。
    function _v0() internal pure returns (StrategyRegistry.Allocation[] memory a) {
        a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 2);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
    }

    /// v1：ETH 40% 多 2x、SOL 30% 空 1x、AAPL 30% 多 1x（不含 BTC）。
    function _v1() internal pure returns (StrategyRegistry.Allocation[] memory a) {
        a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(ETH, 4_000, true, 2);
        a[1] = StrategyRegistry.Allocation(SOL, 3_000, false, 1);
        a[2] = StrategyRegistry.Allocation(AAPL, 3_000, true, 1);
    }

    function _publish(StrategyRegistry.Allocation[] memory a) internal {
        vm.prank(alice);
        registry.publishStrategy(a);
    }

    function _latest() internal view returns (uint256 v) {
        (, v) = registry.getLatestStrategy(alice);
    }

    /// bob 以「跟單＋自動同步＋油箱」一筆完成；回傳 recordIdx。
    function _followAuto(address who, uint256 margin, uint8 maxLev, uint32 interval, uint96 tip)
        internal
        returns (uint256)
    {
        uint256 version = _latest();
        vm.prank(who);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3 + TANK}(
            alice, margin, version, maxLev, interval, tip, EXEC_FEE
        );
        return ct.getCopyRecords(who).length - 1;
    }

    /// 舊入口（快照式跟單，沒有自動同步）。
    function _followLegacy(address who) internal {
        vm.prank(who);
        ct.followTrader{value: EXEC_FEE * 3}(alice, 1_000e18);
    }

    function _rec(address who, uint256 idx) internal view returns (CopyTracker.CopyRecord memory) {
        return ct.getCopyRecords(who)[idx];
    }

    function _state(address who, uint256 idx) internal view returns (CopyTracker.SyncState memory) {
        return ct.getSyncState(who, idx);
    }

    function _pos(uint256 id) internal view returns (PerpetualExchange.Position memory) {
        return exchange.getPosition(id);
    }

    /// 第三方執行前先等到冷卻結束（合約強制冷卻 ≥ MIN_SYNC_INTERVAL）；本人不受冷卻限制。
    function _resyncAs(address executor, address follower, uint256 idx) internal {
        if (executor != follower) _waitCooldown(follower, idx);
        vm.prank(executor);
        ct.resyncFor(follower, idx);
    }

    /// 時間前進到第三方可以同步的時刻（價格在交易所的 24 小時有效期內，不必刷新）。
    function _waitCooldown(address follower, uint256 idx) internal {
        uint256 readyAt = ct.syncReadyAt(follower, idx);
        if (vm.getBlockTimestamp() < readyAt) vm.warp(readyAt);
    }

    function _sumMargins(uint256[] memory ids) internal view returns (uint256 s) {
        for (uint256 i; i < ids.length; ++i) s += _pos(ids[i]).margin;
    }
}

contract CopyTrackerAutoSyncTest is AutoSyncFixture {
    event AutoSyncSet(
        address indexed follower, uint256 indexed recordIdx, bool enabled,
        uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei
    );
    event SyncGasDeposited(address indexed follower, uint256 amount);
    event SyncGasWithdrawn(address indexed follower, uint256 amount);
    event Resynced(
        address indexed follower, uint256 indexed recordIdx, address indexed trader,
        uint256 fromVersion, uint256 toVersion, address executor, uint256 redeployedMargin, uint256 legs
    );
    event SlashScoringWaived(address indexed follower, uint256 indexed recordIdx);
    event TraderSlashed(address indexed trader, address indexed follower, uint256 slashAmount);
    event SyncExecutorSet(address indexed follower, uint256 indexed recordIdx, address indexed executor);

    // ── 一筆完成跟單＋自動同步 ───────────────────────────────────────────────

    function test_followWithAutoSync_oneTx_splitsValueIntoFeesAndTank() public {
        uint256 ethBefore = bob.balance;
        vm.expectEmit(true, true, false, true, address(ct));
        emit AutoSyncSet(bob, 0, true, 5, 1 hours, TIP);
        vm.expectEmit(true, false, false, true, address(ct));
        emit SyncGasDeposited(bob, TANK);
        vm.prank(bob);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3 + TANK}(alice, 1_000e18, 0, 5, 1 hours, TIP, EXEC_FEE);

        (bool on, uint8 lev, uint32 interval, uint96 tip) = ct.syncConfig(bob, 0);
        assertTrue(on);
        assertEq(lev, 5);
        assertEq(interval, 1 hours);
        assertEq(tip, TIP);
        assertEq(ct.syncGasBalance(bob), TANK, "everything above the open fees goes to the tank");
        assertEq(ct.totalSyncGas(), TANK);
        assertEq(address(ct).balance, TANK, "the tracker holds exactly the tank");
        assertEq(ethBefore - bob.balance, EXEC_FEE * 3 + TANK);

        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.versionId, 0);
        assertEq(r.positionIds.length, 3);
        assertEq(r.deployedAmount, 1_000e18);
    }

    /// 附帶的 ETH 不夠付開倉執行費：用專用錯誤，不沿用「油箱不足」（這時還沒有跟單、也沒有同步）。
    function test_followWithAutoSync_revertsWhenValueBelowOpenFees() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientExecutionFee.selector, EXEC_FEE * 3, EXEC_FEE));
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE}(alice, 1_000e18, 0, 5, CD, 0, EXEC_FEE);

        // 情境：使用者讀到 executionFee 之後 owner 調高了費率——先擋在「費率高於簽名同意的上限」
        exchange.setExecutionFee(EXEC_FEE * 2);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, EXEC_FEE * 2, EXEC_FEE));
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 5, CD, 0, EXEC_FEE);
        // 同意了新費率、附帶的 ETH 卻只夠舊費率：附帶的 ETH 不夠付開倉執行費
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientExecutionFee.selector, EXEC_FEE * 6, EXEC_FEE * 3));
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 5, CD, 0, EXEC_FEE * 2);
        assertEq(ct.getCopyRecords(bob).length, 0);
        assertEq(ct.syncGasBalance(bob), 0);
    }

    function test_followWithAutoSync_validatesConfig() public {
        assertEq(ct.MIN_SYNC_INTERVAL(), CD);
        vm.startPrank(bob);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 0, CD, 0, EXEC_FEE);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 6, CD, 0, EXEC_FEE);
        uint96 tooMuch = uint96(ct.MAX_TIP_WEI() + 1);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 5, CD, tooMuch, EXEC_FEE);
        // 冷卻低於合約下限（含 0）一律拒絕
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 5, 0, 0, EXEC_FEE);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 0, 5, CD - 1, 0, EXEC_FEE);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.StrategyVersionMismatch.selector, 7, 0));
        ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3}(alice, 1_000e18, 7, 5, CD, 0, EXEC_FEE);
        vm.stopPrank();
        assertEq(ct.getCopyRecords(bob).length, 0);
        assertEq(address(ct).balance, 0);
    }

    /// 舊入口的行為不變：msg.value 平均分給每條腿、餘數退回，油箱不動。
    function test_legacyFollow_unchangedEthHandling() public {
        uint256 ethBefore = bob.balance;
        vm.prank(bob);
        ct.followTrader{value: EXEC_FEE * 3 + 2}(alice, 1_000e18);
        assertEq(ethBefore - bob.balance, EXEC_FEE * 3, "dust refunded");
        assertEq(ct.syncGasBalance(bob), 0);
        assertEq(address(ct).balance, 0);
    }

    // ── 第三方同步成功、拿小費 ───────────────────────────────────────────────

    function test_resync_byStranger_movesToLatestAndPaysTip() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256[] memory oldIds = _rec(bob, 0).positionIds;
        _publish(_v1());

        uint256 keeperBefore = keeper.balance;
        vm.expectEmit(true, true, true, true, address(ct));
        emit Resynced(bob, 0, alice, 0, 1, keeper, 1_000e18, 3);
        _resyncAs(keeper, bob, 0);

        // 舊腿全部由 tracker 平掉（CloseReason.Agent）
        for (uint256 i; i < oldIds.length; ++i) {
            assertFalse(_pos(oldIds[i]).isOpen);
            assertEq(uint8(exchange.closeReasonOf(oldIds[i])), uint8(PerpetualExchange.CloseReason.Agent));
        }
        // 新腿完全照 v1：資產、方向、槓桿、權重、copiedFrom
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.versionId, 1);
        assertEq(r.deployedAmount, 1_000e18);
        assertEq(r.positionIds.length, 3);
        StrategyRegistry.Allocation[] memory v1 = _v1();
        for (uint256 i; i < 3; ++i) {
            PerpetualExchange.Position memory p = _pos(r.positionIds[i]);
            assertTrue(p.isOpen);
            assertEq(p.owner, bob);
            assertEq(p.asset, v1[i].asset);
            assertEq(p.isLong, v1[i].isLong);
            assertEq(p.leverage, v1[i].leverage);
            assertEq(p.margin, 1_000e18 * v1[i].weight / 10_000);
            assertEq(p.copiedFrom, alice, "performance fee still attributed to the trader");
            assertEq(exchange.positionAgent(r.positionIds[i]), address(ct));
        }
        // 油箱：3 份 executionFee ＋ 小費；小費進執行者口袋
        assertEq(ct.syncGasBalance(bob), TANK - EXEC_FEE * 3 - TIP);
        assertEq(ct.totalSyncGas(), ct.syncGasBalance(bob));
        assertEq(address(ct).balance, ct.totalSyncGas());
        assertEq(keeper.balance - keeperBefore, TIP);

        CopyTracker.SyncState memory st = _state(bob, 0);
        assertEq(st.lastSyncedAt, vm.getBlockTimestamp());
        assertEq(st.syncCount, 1);
        assertEq(st.scoredBasis, 1_000e18);
        assertEq(st.scoredRealized, 0);
        assertFalse(st.followerClosed);
    }

    /// 交易者連發好幾版：一次同步直接跳到最新版，不需要逐版走。
    function test_resync_jumpsStraightToLatest() public {
        _followAuto(bob, 1_000e18, 5, CD, 0);
        _publish(_v1());
        _publish(_v0());
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
        assertEq(_pos(_rec(bob, 0).positionIds[0]).asset, BTC);
    }

    // ── 防重放 ─────────────────────────────────────────────────────────────

    function test_resync_revertsAlreadySynced() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.AlreadySynced.selector, 0, 0));
        ct.resyncFor(bob, 0);

        _publish(_v1());
        _resyncAs(keeper, bob, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.AlreadySynced.selector, 1, 1));
        ct.resyncFor(bob, 0);
        // 本人也一樣：沒有新版就沒有東西可同步
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.AlreadySynced.selector, 1, 1));
        ct.resyncFor(bob, 0);
    }

    // ── 權限：未開啟時陌生人被拒、本人隨時可手動 ─────────────────────────────

    function test_resync_strangerRejectedWhenAutoSyncOff() public {
        _followLegacy(bob);
        _publish(_v1());
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.AutoSyncDisabled.selector);
        ct.resyncFor(bob, 0);

        // 開了又關，陌生人一樣被拒
        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE);
        vm.prank(bob);
        ct.setAutoSync(0, false, 0, 0, 0, EXEC_FEE);
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.AutoSyncDisabled.selector);
        ct.resyncFor(bob, 0);
    }

    /// 本人手動同步：不需開啟自動同步、不付小費、不受冷卻；executionFee 隨交易附上。
    /// 沒開自動同步就沒有同意過任何油箱代付的費率（syncExecFeeCap = 0）：經 resyncFor 同步時，
    /// 附帶的 ETH 必須付清執行費，油箱既有餘額不會被動用。
    function test_resync_followerManual_noTipNoCooldown_msgValueFundsTank() public {
        _followLegacy(bob);
        uint96 maxTip = uint96(ct.MAX_TIP_WEI());
        vm.prank(bob);
        ct.setAutoSync(0, false, 0, 1 days, maxTip, EXEC_FEE);
        _publish(_v1());

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, EXEC_FEE, 0));
        ct.resyncFor(bob, 0);
        // 油箱裡有錢也一樣：沒有同意過的費率，就只能用這筆交易附帶的 ETH 付
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, EXEC_FEE, 0));
        ct.resyncFor{value: EXEC_FEE * 3 - 1}(bob, 0);
        vm.prank(bob);
        ct.withdrawSyncGas(1 ether);

        vm.prank(bob);
        ct.resyncFor{value: EXEC_FEE * 3}(bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(ct.syncGasBalance(bob), 0, "exactly the open fees, no tip");
        assertEq(address(ct).balance, 0);

        _publish(_v0());   // 冷卻 1 天，但本人不受限
        vm.prank(bob);
        ct.resyncFor{value: EXEC_FEE * 3}(bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
        assertEq(_state(bob, 0).syncCount, 2);
    }

    /// 陌生人附上的 ETH 只會進 follower 的油箱（等於代付），不會讓他多拿什麼。
    function test_resync_strangerMsgValueCreditsFollowerTank() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _publish(_v1());
        _waitCooldown(bob, 0);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        ct.resyncFor{value: 1 ether}(bob, 0);
        assertEq(ct.syncGasBalance(bob), TANK + 1 ether - EXEC_FEE * 3 - TIP);
        assertEq(ct.syncGasBalance(keeper), 0);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    // ── 冷卻 ───────────────────────────────────────────────────────────────

    function test_resync_cooldownBlocksStranger() public {
        uint256 followedAt = vm.getBlockTimestamp();
        _followAuto(bob, 1_000e18, 5, 1 hours, TIP);
        _publish(_v1());
        // 從未同步：冷卻從跟單當下起算
        assertEq(ct.syncReadyAt(bob, 0), followedAt + 1 hours);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.SyncCooldown.selector, followedAt + 1 hours));
        ct.resyncFor(bob, 0);

        vm.warp(followedAt + 1 hours);
        _refreshPrices();
        _resyncAs(keeper, bob, 0);
        uint256 syncedAt = vm.getBlockTimestamp();
        assertEq(ct.syncReadyAt(bob, 0), syncedAt + 1 hours);

        _publish(_v0());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.SyncCooldown.selector, syncedAt + 1 hours));
        ct.resyncFor(bob, 0);

        vm.warp(syncedAt + 1 hours - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.SyncCooldown.selector, syncedAt + 1 hours));
        ct.resyncFor(bob, 0);

        // 本人不受冷卻限制
        uint256 snap = vm.snapshotState();
        _refreshPrices();
        _resyncAs(bob, bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
        vm.revertToState(snap);

        vm.warp(syncedAt + 1 hours);
        _refreshPrices();
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
    }

    // ── 油箱不足、存入、提領 ─────────────────────────────────────────────────

    function test_resync_insufficientSyncGas() public {
        _followLegacy(bob);
        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, TIP, EXEC_FEE);
        _publish(_v1());
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, EXEC_FEE * 3 + TIP, 0));
        ct.resyncFor(bob, 0);

        vm.prank(bob);
        ct.depositSyncGas{value: EXEC_FEE * 3 + TIP - 1}();
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, EXEC_FEE * 3 + TIP, EXEC_FEE * 3 + TIP - 1)
        );
        ct.resyncFor(bob, 0);

        vm.prank(bob);
        ct.depositSyncGas{value: 1}();
        _resyncAs(keeper, bob, 0);
        assertEq(ct.syncGasBalance(bob), 0);
    }

    function test_depositAndWithdrawSyncGas() public {
        vm.expectEmit(true, false, false, true, address(ct));
        emit SyncGasDeposited(bob, 1 ether);
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();
        assertEq(ct.syncGasBalance(bob), 1 ether);
        assertEq(ct.totalSyncGas(), 1 ether);

        uint256 before = bob.balance;
        vm.expectEmit(true, false, false, true, address(ct));
        emit SyncGasWithdrawn(bob, 0.4 ether);
        vm.prank(bob);
        ct.withdrawSyncGas(0.4 ether);
        assertEq(bob.balance - before, 0.4 ether);
        assertEq(ct.syncGasBalance(bob), 0.6 ether);
        assertEq(ct.totalSyncGas(), 0.6 ether);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, 0.7 ether, 0.6 ether));
        ct.withdrawSyncGas(0.7 ether);

        vm.prank(bob);
        ct.withdrawSyncGas(0.6 ether);
        assertEq(ct.syncGasBalance(bob), 0);
        assertEq(address(ct).balance, 0);
    }

    /// 只有 follower 能提領自己的油箱：別人（包括 owner）只能動自己的帳，而那是 0。
    function test_withdrawSyncGas_onlyOwnTank() public {
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();
        address[3] memory others = [keeper, carol, address(this)];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, 1, 0));
            ct.withdrawSyncGas(1);
        }
        assertEq(ct.syncGasBalance(bob), 1 ether);
    }

    /// 跟單結束不會自動退油箱（油箱是 per-follower），但隨時可以自行提領。
    function test_unfollow_keepsTankWithdrawable() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ct.syncGasBalance(bob), TANK);
        vm.prank(bob);
        ct.withdrawSyncGas(TANK);
        assertEq(address(ct).balance, 0);
    }

    // ── 槓桿三者取小；_follow 也夾值 ────────────────────────────────────────

    function test_resync_leverageIsMinOfStrategyExchangeAndFollowerCap() public {
        _followAuto(bob, 1_000e18, 4, CD, 0);
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 4_000, true, 5);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 2);
        a[2] = StrategyRegistry.Allocation(SOL, 3_000, false, 5);
        _publish(a);
        exchange.setMaxLeverageFor(BTC, 2);   // 交易所上限最小
        // ETH：策略 2 最小；SOL：跟隨者 4 最小
        _resyncAs(keeper, bob, 0);

        uint256[] memory ids = _rec(bob, 0).positionIds;
        assertEq(_pos(ids[0]).leverage, 2, "BTC: exchange cap");
        assertEq(_pos(ids[1]).leverage, 2, "ETH: strategy");
        assertEq(_pos(ids[2]).leverage, 4, "SOL: follower cap");
    }

    /// 修正：策略配 5 倍、但交易所（例如高碳評等）只允許 1 倍時，跟單原本整筆 revert。
    function test_follow_clampsLeverageToExchangeCeiling() public {
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 4_000, true, 5);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 5);
        a[2] = StrategyRegistry.Allocation(SOL, 3_000, true, 1);
        _publish(a);
        exchange.setMaxLeverageFor(BTC, 1);
        exchange.setTradingFeeBps(100);

        (, uint256 previewFee,,) = ct.previewCopyAllocation(alice, 1_000e18);
        // 緩衝按夾過的槓桿算：BTC 400×1 + ETH 300×5 + SOL 300×1 = 2,200 名目 × 1%
        assertEq(previewFee, 22e18);

        vm.prank(bob);
        ct.followTrader{value: EXEC_FEE * 3}(alice, 1_000e18);
        uint256[] memory ids = _rec(bob, 0).positionIds;
        assertEq(_pos(ids[0]).leverage, 1);
        assertEq(_pos(ids[1]).leverage, 5);
        assertEq(_rec(bob, 0).deployedAmount, 1_000e18 - 22e18);
    }

    /// 跟隨者的槓桿上限也套用在「跟單＋自動同步」那一次開倉。
    function test_followWithAutoSync_appliesFollowerCapToInitialLegs() public {
        _followAuto(bob, 1_000e18, 1, CD, 0);
        uint256[] memory ids = _rec(bob, 0).positionIds;
        assertEq(_pos(ids[0]).leverage, 1, "BTC 2x capped to 1x");
    }

    // ── RWA：未 KYC 整筆 revert，KYC 後再同步成功 ────────────────────────────

    function test_resync_rwaWithoutKyc_revertsAtomically_thenSucceedsAfterKyc() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256[] memory oldIds = _rec(bob, 0).positionIds;
        StrategyRegistry.Allocation[] memory a = _v1();
        a[2].asset = XAU;
        _publish(a);
        _waitCooldown(bob, 0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, bob));
        ct.resyncFor(bob, 0);

        // 部位維持舊版、油箱不動
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.versionId, 0);
        assertEq(r.positionIds, oldIds);
        for (uint256 i; i < oldIds.length; ++i) assertTrue(_pos(oldIds[i]).isOpen);
        assertEq(ct.syncGasBalance(bob), TANK);
        (bool syncable,,) = ct.pendingSync(bob, 0);
        assertTrue(syncable, "pendingSync cannot see exchange-side gates; eth_call does");

        address[] memory list = new address[](1);
        list[0] = bob;
        kyc.batchVerify(list);
        _resyncAs(keeper, bob, 0);
        r = _rec(bob, 0);
        assertEq(r.versionId, 1);
        assertEq(_pos(r.positionIds[2]).asset, XAU);
    }

    // ── 市場模式：ReduceOnly → 整筆 revert；舊腿在 ReduceOnly 仍可平 ─────────

    function test_resync_reduceOnlyNewAsset_reverts() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _publish(_v1());
        exchange.setAssetMode(AAPL, PerpetualExchange.AssetMode.ReduceOnly);
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(PerpetualExchange.AssetNotActive.selector, AAPL, PerpetualExchange.AssetMode.ReduceOnly)
        );
        ct.resyncFor(bob, 0);
        assertEq(_rec(bob, 0).versionId, 0);

        exchange.setAssetMode(AAPL, PerpetualExchange.AssetMode.Active);
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
    }

    function test_resync_oldLegReduceOnly_stillCloses() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _publish(_v1());   // v1 不含 BTC
        exchange.setAssetMode(BTC, PerpetualExchange.AssetMode.ReduceOnly);
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
    }

    function test_resync_oldLegHalted_revertsPositionStillOpen() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 btcLeg = _rec(bob, 0).positionIds[0];
        _publish(_v1());
        exchange.setAssetMode(BTC, PerpetualExchange.AssetMode.Halted);
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, btcLeg));
        ct.resyncFor(bob, 0);
    }

    function test_resync_traderNotEligible_reverts() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _publish(_v1());
        vm.prank(alice);
        ts.requestUnstake(100e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.TraderNotEligible.selector, alice));
        ct.resyncFor(bob, 0);
    }

    // ── 已被清算的腿：計分、不重新部署 ───────────────────────────────────────

    function test_resync_liquidatedLeg_scoredButNotRedeployed() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 btcLeg = _rec(bob, 0).positionIds[0];
        oracle.updatePrice(BTC, 50_000e8);    // 2x 腿 −100%
        exchange.liquidatePosition(btcLeg);
        oracle.updatePrice(BTC, 100_000e8);
        _publish(_v1());

        _resyncAs(keeper, bob, 0);
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.deployedAmount, 500e18, "only ETH 300 + SOL 200 came back");
        assertEq(_sumMargins(r.positionIds), 500e18);
        CopyTracker.SyncState memory st = _state(bob, 0);
        assertEq(st.scoredBasis, 1_000e18, "the liquidated leg is part of the basis");
        assertEq(st.scoredRealized, -500e18, "and of the score");
        assertFalse(st.followerClosed);
    }

    /// 跟單腿本身被 ADL（對手方破產）：照 unfollow 的規則以 haircut 前的損益計分，ADL 付回的
    /// 保證金早已回到 freeMargin、不算這次平倉釋出的錢，不會被重新部署。
    /// 情境：v1 的 SOL 空單 1x（300）；carol 的 SOL 5x 多單（100）在 SOL 跌到 700 時破產，
    /// 缺口 50 由 ADL 從 bob 的 SOL 空單 +90 扣（realizedPnL = +40、haircut = 50、付回 340）。
    function test_resync_adlLegOfRecord_scoredPreHaircutNotRedeployed() public {
        exchange.setAdlEnabled(true);        // 沒有保險金庫：壞帳直接走 ADL
        _publish(_v1());
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 solLeg = _rec(bob, 0).positionIds[1];
        assertFalse(_pos(solLeg).isLong);

        vm.startPrank(carol);
        exchange.depositMargin(100e18);
        uint256 carolLong = exchange.openPosition{value: EXEC_FEE}(SOL, true, 100e18, 5);
        vm.stopPrank();

        oracle.updatePrice(SOL, 700e8);      // carol 5x 多單 −150%：缺口 50
        exchange.liquidatePosition(carolLong);
        assertEq(uint8(exchange.closeReasonOf(solLeg)), uint8(PerpetualExchange.CloseReason.Deleveraged));
        assertEq(exchange.adlHaircutOf(solLeg), 50e18);
        assertEq(_pos(solLeg).realizedPnL, 40e18);
        uint256 freeBefore = exchange.freeMargin(bob);
        assertEq(freeBefore, 340e18, "ADL paid the leg back already");

        _publish(_v0());
        _resyncAs(keeper, bob, 0);

        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.versionId, 2);
        assertEq(r.deployedAmount, 700e18, "only ETH 400 + AAPL 300 came back from this sync");
        assertEq(_sumMargins(r.positionIds), 700e18);
        assertEq(exchange.freeMargin(bob), freeBefore, "the ADL payout is not redeployed");
        CopyTracker.SyncState memory st = _state(bob, 0);
        assertEq(st.scoredBasis, 1_000e18, "the ADL leg is part of the basis");
        assertEq(st.scoredRealized, 90e18, "scored before the haircut (+40 + 50)");
        assertFalse(st.followerClosed, "ADL is not the follower's own close");
    }

    /// 所有腿都已不在：沒有可重新部署的保證金，整筆 revert（該做的是 unfollow 計分）。
    function test_resync_nothingReleased_reverts() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256[] memory ids = _rec(bob, 0).positionIds;
        vm.startPrank(bob);
        for (uint256 i; i < ids.length; ++i) exchange.closePosition(ids[i]);
        vm.stopPrank();
        _publish(_v1());
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.NothingToRedeploy.selector);
        ct.resyncFor(bob, 0);
    }

    // ── follower 自己平過的腿 → 黏著免除計分 ───────────────────────────────

    function test_resync_followerClosedLeg_stickyWaiver() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 ethLeg = _rec(bob, 0).positionIds[1];
        vm.prank(bob);
        exchange.closePosition(ethLeg);
        uint256 freeAfterSelfClose = exchange.freeMargin(bob);
        _publish(_v1());

        _resyncAs(keeper, bob, 0);
        CopyTracker.SyncState memory st = _state(bob, 0);
        assertTrue(st.followerClosed);
        assertEq(st.scoredBasis, 700e18, "the self-closed leg is not scored");
        assertEq(_rec(bob, 0).deployedAmount, 700e18, "its proceeds stay with the follower");
        assertEq(exchange.freeMargin(bob), freeAfterSelfClose);

        // 新版大賠也不會 slash：自平過就整筆免除，換版洗不掉這個旗標
        oracle.updatePrice(ETH, 1_000e8);
        vm.expectEmit(true, true, false, false, address(ct));
        emit SlashScoringWaived(bob, 0);
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, 500e18);
    }

    // ── 跨版本累計計分：交易者靠改版洗虧損失敗 ─────────────────────────────

    /// v0 賠 40% 後交易者發新版想「洗掉」：同步後 v1 打平再 unfollow，仍以 40% 計 → slash。
    /// （若 unfollow 時把這一輪的基準也加進去，基準會變 1,000 + 600 = 1,600，虧損被稀釋成 25%、
    /// 低於門檻。「每次同步都把該輪基準加總」的寫法只同步一次時與正確寫法相同，要同步兩次以上才
    /// 看得出來，見 test_slash_basisStaysFirstRoundAcrossMultipleSyncs。）
    function test_slash_lossBeforeResyncIsNotWashedByNewVersion() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        oracle.updatePrice(BTC, 60_000e8);   // BTC 2x 腿：−400
        _publish(_v1());
        _resyncAs(keeper, bob, 0);

        CopyTracker.SyncState memory st = _state(bob, 0);
        assertEq(st.scoredBasis, 1_000e18);
        assertEq(st.scoredRealized, -400e18);
        assertEq(_rec(bob, 0).deployedAmount, 600e18);

        vm.expectEmit(true, true, false, true, address(ct));
        emit TraderSlashed(alice, bob, 200e18);
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, 300e18);
        assertEq(ct.slashReserve(), 200e18);
    }

    /// 每一輪單看都 < 30%（20%、20%），累計對原始投入 36% → slash。
    function test_slash_lossesAccumulateAcrossRounds() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        oracle.updatePrice(BTC, 80_000e8);   // round 0：BTC 2x −200（20%）
        _publish(_v1());
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).deployedAmount, 800e18);

        oracle.updatePrice(ETH, 3_000e8);    // round 1：ETH 320 @2x −25% → −160（20% of 800）
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, 500e18 - 180e18, "50% of the cumulative 360");
    }

    /// 沒賠的輪次也不會讓基準膨脹：獲利後再小賠，累計仍為正 → 不 slash。
    function test_slash_cumulativeGainOffsetsLaterLoss() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        oracle.updatePrice(BTC, 120_000e8);  // round 0：+200
        _publish(_v1());
        _resyncAs(keeper, bob, 0);
        oracle.updatePrice(ETH, 3_000e8);    // round 1：ETH 480 @2x −25% → −240
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);           // 累計 −40 / 1,000 = 4%
        assertEq(ts.getStake(alice).amount, 500e18);
    }

    /// 同步兩次以上：計分基準始終是第一輪的 1,000，不會隨每輪「釋出的保證金」加總。
    /// 三輪各小賠（12%、10%、25%，單看都 < 30%），累計 −406 對原始投入 = 40.6% → slash 203。
    /// 若同步時把每輪基準加總（1,000 + 880 = 1,880），累計虧損會被稀釋成 21.6%、低於門檻——
    /// 交易者只要多發幾版、讓跟隨者多同步幾次，就能讓虧損永遠不觸發 slash。這支測試在那種寫法下必定失敗。
    function test_slash_basisStaysFirstRoundAcrossMultipleSyncs() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);

        // round 0（v0）：BTC 2x 腿 500，100k → 88k：−12% × 2 → −120（12% of 1,000）
        oracle.updatePrice(BTC, 88_000e8);
        _publish(_v1());
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).deployedAmount, 880e18);
        CopyTracker.SyncState memory st = _state(bob, 0);
        assertEq(st.syncCount, 1);
        assertEq(st.scoredBasis, 1_000e18);
        assertEq(st.scoredRealized, -120e18);

        // round 1（v1）：ETH 2x 腿 352（880 × 40%），4,000 → 3,500：−12.5% × 2 → −88（10% of 880）
        oracle.updatePrice(ETH, 3_500e8);
        _publish(_v0());
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
        assertEq(_rec(bob, 0).deployedAmount, 792e18);
        st = _state(bob, 0);
        assertEq(st.syncCount, 2);
        assertEq(st.scoredBasis, 1_000e18, "basis stays the first round's, never 1,000 + 880");
        assertEq(st.scoredRealized, -208e18, "losses accumulate across rounds");

        // round 2（v2）：BTC 2x 腿 396（792 × 50%），88k → 66k：−25% × 2 → −198（25% of 792）
        oracle.updatePrice(BTC, 66_000e8);
        vm.expectEmit(true, true, false, true, address(ct));
        emit TraderSlashed(alice, bob, 203e18);  // 50% × 406，低於質押上限 250
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, 297e18);
        assertEq(ct.slashReserve(), 203e18);
    }

    // ── 只用平倉釋出的保證金 ─────────────────────────────────────────────────

    function test_resync_usesOnlyReleasedMargin() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(bob);
        exchange.depositMargin(5_000e18);    // follower 自己的其他資金
        oracle.updatePrice(BTC, 60_000e8);   // 釋出只剩 600
        _publish(_v1());

        _resyncAs(keeper, bob, 0);
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.deployedAmount, 600e18);
        assertEq(_sumMargins(r.positionIds), 600e18);
        assertEq(exchange.freeMargin(bob), 5_000e18, "the follower's other free margin is untouched");
    }

    /// 平倉時壞帳觸發 ADL、連帶平掉 follower 自己的其他部位：差額混進別的錢，整筆退回；
    /// keeper 清算壞帳腿之後就能同步。
    function test_resync_adlOfFollowersOtherPosition_reverts() public {
        exchange.setAdlEnabled(true);        // 沒有保險金庫：壞帳直接走 ADL
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 btcLeg = _rec(bob, 0).positionIds[0];
        vm.startPrank(bob);
        exchange.depositMargin(1_000e18);
        uint256 hedge = exchange.openPosition{value: EXEC_FEE}(BTC, false, 1_000e18, 1);
        vm.stopPrank();

        oracle.updatePrice(BTC, 40_000e8);   // 2x 多單 −120%：平倉缺口 100
        _publish(_v1());
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.SyncDisturbedOtherPositions.selector);
        ct.resyncFor(bob, 0);
        assertTrue(_pos(hedge).isOpen);

        // 壞帳腿被清算後（hedge 在清算裡被 ADL）就能同步
        exchange.liquidatePosition(btcLeg);
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(_rec(bob, 0).deployedAmount, 500e18);
    }

    // ── 重入 ───────────────────────────────────────────────────────────────

    function test_reentrancy_executorCannotReenterFromTip() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(carol);
        ct.depositSyncGas{value: 1 ether}();
        _publish(_v1());

        _waitCooldown(bob, 0);
        ReentrantExecutor ex = new ReentrantExecutor(ct, bob);
        // 執行者自己的油箱有錢：沒有 nonReentrant 的話，重入的 withdrawSyncGas 會成功（不是因為餘額不足才失敗）
        vm.deal(address(this), 0.5 ether);
        ex.fund{value: 0.5 ether}();
        ex.run();
        assertTrue(ex.attempted());
        assertEq(bytes4(ex.withdrawError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "withdraw re-entry");
        assertEq(bytes4(ex.resyncError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "resync re-entry");
        assertEq(address(ex).balance, TIP, "paid exactly once");
        assertEq(ct.syncGasBalance(address(ex)), 0.5 ether, "re-entrant withdraw moved nothing");
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(ct.syncGasBalance(bob), TANK - EXEC_FEE * 3 - TIP);
        assertEq(ct.syncGasBalance(carol), 1 ether);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    function test_executorThatCannotReceiveTip_revertsWholeSync() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _publish(_v1());
        _waitCooldown(bob, 0);
        NoReceive ex = new NoReceive();
        vm.prank(address(ex));
        vm.expectRevert(CopyTracker.EthTransferFailed.selector);
        ct.resyncFor(bob, 0);
        assertEq(_rec(bob, 0).versionId, 0);
        assertEq(ct.syncGasBalance(bob), TANK);
    }

    function test_reentrancy_withdrawCannotReenter() public {
        ReentrantWithdrawer w = new ReentrantWithdrawer(ct);
        vm.deal(address(w), 1 ether);
        vm.prank(carol);
        ct.depositSyncGas{value: 1 ether}();
        w.depositAndWithdraw(1 ether, 0.4 ether);
        assertEq(bytes4(w.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(ct.syncGasBalance(address(w)), 0.6 ether);
        assertEq(address(w).balance, 0.4 ether);
        assertEq(ct.syncGasBalance(carol), 1 ether);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    // ── setAutoSync ────────────────────────────────────────────────────────

    function test_setAutoSync_guards() public {
        _followLegacy(bob);

        vm.prank(carol);   // 不是自己的跟單
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE);

        vm.startPrank(bob);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.setAutoSync(0, true, 0, CD, 0, EXEC_FEE);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.setAutoSync(0, false, 6, 0, 0, EXEC_FEE);
        uint96 tooMuch = uint96(ct.MAX_TIP_WEI() + 1);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.setAutoSync(0, true, 3, CD, tooMuch, EXEC_FEE);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.setAutoSync(0, true, 3, 0, TIP, EXEC_FEE);
        vm.expectRevert(CopyTracker.InvalidSyncConfig.selector);
        ct.setAutoSync(0, true, 3, CD - 1, TIP, EXEC_FEE);

        vm.expectEmit(true, true, false, true, address(ct));
        emit AutoSyncSet(bob, 0, true, 3, CD, TIP);
        ct.setAutoSync(0, true, 3, CD, TIP, EXEC_FEE);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE, "consents to the current execution fee");
        ct.setAutoSync(0, true, 3, 6 hours, TIP, EXEC_FEE);
        ct.setAutoSync(0, false, 0, 0, 0, EXEC_FEE);   // 關閉時槓桿與冷卻可為 0
        assertEq(ct.syncExecFeeCap(bob, 0), 0);

        ct.deactivateWithoutScoring(0);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.setAutoSync(0, true, 3, CD, 0, EXEC_FEE);
        vm.stopPrank();
    }

    function test_unfollowAndDeactivate_clearAutoSync() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _followAuto(bob, 1_000e18, 5, CD, TIP);

        vm.expectEmit(true, true, false, true, address(ct));
        emit AutoSyncSet(bob, 0, false, 0, 0, 0);
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        vm.expectEmit(true, true, false, true, address(ct));
        emit AutoSyncSet(bob, 1, false, 0, 0, 0);
        vm.prank(bob);
        ct.deactivateWithoutScoring(1);

        (bool on,,,) = ct.syncConfig(bob, 0);
        assertFalse(on);
        assertEq(ct.syncExecFeeCap(bob, 0), 0);
        assertEq(ct.syncExecFeeCap(bob, 1), 0);
        _publish(_v1());
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.resyncFor(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.resyncFor(bob, 9);
    }

    // ── 指定執行者（personal 模式）：只讓自己的 agent 同步，別人都不行 ──────────

    function test_syncExecutor_onlyDesignatedOrFollower() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        address agent = makeAddr("bobAgent");   // bob 自己的 agent：另一把只放 gas 的熱錢包

        vm.expectEmit(true, true, true, true, address(ct));
        emit SyncExecutorSet(bob, 0, agent);
        vm.prank(bob);
        ct.setSyncExecutor(0, agent);
        assertEq(ct.syncExecutor(bob, 0), agent);

        _publish(_v1());
        // 冷卻照樣適用於指定的執行者
        uint256 readyAt = ct.syncReadyAt(bob, 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.SyncCooldown.selector, readyAt));
        ct.resyncFor(bob, 0);

        _waitCooldown(bob, 0);
        // 其他人（含平台 keeper、交易者本人）一律被拒，且不動任何狀態
        address[2] memory others = [keeper, alice];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CopyTracker.NotSyncExecutor.selector, agent));
            ct.resyncFor(bob, 0);
        }
        assertEq(_rec(bob, 0).versionId, 0);
        assertEq(ct.syncGasBalance(bob), TANK);

        uint256 before = agent.balance;
        vm.prank(agent);
        ct.resyncFor(bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(agent.balance - before, TIP, "the designated executor is paid the follower's tip");
        assertEq(ct.syncGasBalance(bob), TANK - EXEC_FEE * 3 - TIP);

        // 本人永遠可以同步（不受指定執行者限制）
        _publish(_v0());
        vm.prank(bob);
        ct.resyncAtVersion(0, 2, EXEC_FEE);
        assertEq(_rec(bob, 0).versionId, 2);
    }

    function test_syncExecutor_guardsAndClear() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        address agent = makeAddr("bobAgent");

        vm.prank(carol);   // 不是自己的跟單
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.setSyncExecutor(0, agent);
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.setSyncExecutor(0, keeper);

        vm.prank(bob);
        ct.setSyncExecutor(0, agent);
        // 解除限制：回到任何人都能代為同步
        vm.expectEmit(true, true, true, true, address(ct));
        emit SyncExecutorSet(bob, 0, address(0));
        vm.prank(bob);
        ct.setSyncExecutor(0, address(0));
        _publish(_v1());
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);

        vm.prank(bob);
        ct.deactivateWithoutScoring(0);
        vm.prank(bob);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.setSyncExecutor(0, agent);
    }

    /// 指定執行者只收窄「誰能按」：自動同步關閉時連指定的執行者也不能同步；關掉再開，限制仍在。
    function test_syncExecutor_survivesToggle_andStillNeedsAutoSync() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        address agent = makeAddr("bobAgent");
        vm.startPrank(bob);
        ct.setSyncExecutor(0, agent);
        ct.setAutoSync(0, false, 5, 0, 0, 0);
        vm.stopPrank();
        _publish(_v1());
        vm.warp(vm.getBlockTimestamp() + CD);

        vm.prank(agent);
        vm.expectRevert(CopyTracker.AutoSyncDisabled.selector);
        ct.resyncFor(bob, 0);
        assertEq(ct.syncExecutor(bob, 0), agent, "toggling auto-sync does not clear the designated executor");

        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, TIP, EXEC_FEE);
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.NotSyncExecutor.selector, agent));
        ct.resyncFor(bob, 0);
        vm.prank(agent);
        ct.resyncFor(bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
    }

    function test_syncExecutor_clearedWhenRecordEnds() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        address agent = makeAddr("bobAgent");
        vm.startPrank(bob);
        ct.setSyncExecutor(0, agent);
        ct.setSyncExecutor(1, agent);

        vm.expectEmit(true, true, true, true, address(ct));
        emit SyncExecutorSet(bob, 0, address(0));
        ct.unfollowAndCloseAll(0);
        vm.expectEmit(true, true, true, true, address(ct));
        emit SyncExecutorSet(bob, 1, address(0));
        ct.deactivateWithoutScoring(1);
        vm.stopPrank();
        assertEq(ct.syncExecutor(bob, 0), address(0));
        assertEq(ct.syncExecutor(bob, 1), address(0));
    }

    // ── pendingSync ────────────────────────────────────────────────────────

    function test_pendingSync() public {
        (bool s, uint256 v, uint256 c) = ct.pendingSync(bob, 0);
        assertFalse(s);
        assertEq(v, 0);
        assertEq(c, 0);

        _followAuto(bob, 1_000e18, 5, 1 hours, TIP);
        (s, v, c) = ct.pendingSync(bob, 0);
        assertFalse(s, "no new version");
        assertEq(v, 0);
        assertEq(c, EXEC_FEE * 3 + TIP);

        _publish(_v1());
        (s, v,) = ct.pendingSync(bob, 0);
        assertFalse(s, "cooling down since the follow");
        assertEq(v, 1);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _refreshPrices();
        (s,,) = ct.pendingSync(bob, 0);
        assertTrue(s);

        _resyncAs(keeper, bob, 0);
        _publish(_v0());
        (s, v,) = ct.pendingSync(bob, 0);
        assertFalse(s, "cooling down");
        assertEq(v, 2);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (s,,) = ct.pendingSync(bob, 0);
        assertTrue(s);

        (s,,) = ct.pendingSync(bob, 1);
        assertFalse(s, "index out of range");
        assertEq(ct.syncReadyAt(bob, 1), 0);

        uint256 tank = ct.syncGasBalance(bob);
        vm.prank(bob);
        ct.withdrawSyncGas(tank);
        (s,,) = ct.pendingSync(bob, 0);
        assertFalse(s, "tank empty");
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();

        vm.prank(bob);
        ct.setAutoSync(0, false, 0, 0, 0, EXEC_FEE);
        (s,,) = ct.pendingSync(bob, 0);
        assertFalse(s, "auto-sync off");
        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE);
        (s,,) = ct.pendingSync(bob, 0);
        assertTrue(s);

        vm.prank(alice);
        ts.requestUnstake(100e18);
        (s,,) = ct.pendingSync(bob, 0);
        assertFalse(s, "trader not eligible");
    }

    // ── 冷卻下限：交易者不能在同一區塊反覆發版＋自己同步 ─────────────────────

    /// 審查實測的攻擊：冷卻若可為 0，交易者在同一區塊重複「發版 → 自己呼叫 resyncFor」25 次，
    /// 價格不動也能用交易費磨掉跟隨者約 7% 的保證金，小費全進交易者口袋。冷卻現在至少
    /// MIN_SYNC_INTERVAL：同一個冷卻期內只有一次成功，交易者兼任執行者也一樣。
    function test_resync_traderCannotGrindInOneBlock() public {
        exchange.setTradingFeeBps(10);
        uint96 maxTip = uint96(ct.MAX_TIP_WEI());
        _followAuto(bob, 1_000e18, 5, CD, maxTip);
        uint256 deployed0 = _rec(bob, 0).deployedAmount;
        _waitCooldown(bob, 0);
        uint256 aliceBefore = alice.balance;

        uint256 ok;
        for (uint256 i; i < 25; ++i) {
            _publish(i % 2 == 0 ? _v1() : _v0());
            vm.prank(alice);
            try ct.resyncFor(bob, 0) {
                ++ok;
            } catch (bytes memory err) {
                assertEq(bytes4(err), CopyTracker.SyncCooldown.selector);
            }
        }
        assertEq(ok, 1, "one third-party sync per cooldown, even when the trader executes");
        assertEq(alice.balance - aliceBefore, maxTip, "a single tip");
        assertEq(_state(bob, 0).syncCount, 1);
        // 一輪的磨耗：平倉＋開倉各一次交易費（5x 以內、10 bps），不是 25 輪
        assertGt(_rec(bob, 0).deployedAmount, deployed0 * 99 / 100);
    }

    // ── 執行費上限：owner 調高 executionFee 不能多扣油箱 ─────────────────────

    /// 審查實測的攻擊：油箱 0.3 ETH，owner 把 executionFee 調到「油箱 ÷ 腿數」再當執行者，
    /// 一次同步就把油箱掃進交易所。現在第三方只能按跟隨者同意過的費率扣：revert
    /// ExecutionFeeAboveCap、油箱不動；費率回到同意的水準以下照常同步（按現行較低費率扣）；
    /// 跟隨者看過新費率、帶入新上限再呼叫一次 setAutoSync 之後，第三方才能按新費率扣。
    function test_resync_ownerRaisedExecutionFee_blocksThirdPartyUntilReconsent() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE, "consent snapshot at follow time");
        vm.prank(bob);
        ct.depositSyncGas{value: 0.29 ether}();
        uint256 tank = ct.syncGasBalance(bob);

        uint256 drainFee = (tank - TIP) / 3;
        exchange.setExecutionFee(drainFee);   // 本測試合約是交易所 owner
        _publish(_v1());
        _waitCooldown(bob, 0);

        (bool s,, uint256 cost) = ct.pendingSync(bob, 0);
        assertFalse(s, "pendingSync reflects the fee cap");
        assertEq(cost, drainFee * 3 + TIP);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, drainFee, EXEC_FEE));
        ct.resyncFor(bob, 0);
        // owner 自己當執行者也一樣
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, drainFee, EXEC_FEE));
        ct.resyncFor(bob, 0);
        assertEq(ct.syncGasBalance(bob), tank, "tank untouched");
        assertEq(_rec(bob, 0).versionId, 0);

        // 費率降回同意的水準以下：照常同步，按現行費率扣
        exchange.setExecutionFee(EXEC_FEE / 2);
        uint256 snap = vm.snapshotState();
        _resyncAs(keeper, bob, 0);
        assertEq(tank - ct.syncGasBalance(bob), EXEC_FEE / 2 * 3 + TIP);
        vm.revertToState(snap);

        // 調高後跟隨者重新同意，才按新費率扣
        uint256 newFee = EXEC_FEE * 2;
        exchange.setExecutionFee(newFee);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.resyncFor(bob, 0);
        // 以舊上限重送設定不算同意新費率
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.setAutoSync(0, true, 5, CD, TIP, EXEC_FEE);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE);
        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, TIP, newFee);
        assertEq(ct.syncExecFeeCap(bob, 0), newFee);
        (s,,) = ct.pendingSync(bob, 0);
        assertTrue(s);
        _resyncAs(keeper, bob, 0);
        assertEq(tank - ct.syncGasBalance(bob), newFee * 3 + TIP);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 本人手動同步也受執行費同意上限約束：「本人送出交易時看得到當下費率」不成立——owner 可以在
    /// 同一個區塊搶先調費。resyncFor（本人）從油箱扣時用 syncExecFeeCap；附帶的 ETH 付得清全部
    /// 成本則照常同步（油箱既有餘額不動）；resyncAtVersion 用這筆交易簽名帶入的上限。
    function test_resync_followerManual_boundBySignedExecFeeCap() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        uint256 newFee = EXEC_FEE * 2;
        exchange.setExecutionFee(newFee);
        _publish(_v1());

        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.resyncFor(bob, 0);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.resyncFor{value: newFee * 3 - 1}(bob, 0);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.resyncAtVersion(0, 1, EXEC_FEE);
        // 簽名上限明確給了，就不看附帶的 ETH
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, newFee, EXEC_FEE));
        ct.resyncAtVersion{value: 1 ether}(0, 1, EXEC_FEE);
        vm.stopPrank();
        assertEq(ct.syncGasBalance(bob), TANK, "tank untouched");
        assertEq(_rec(bob, 0).versionId, 0);

        // 附帶的 ETH 付得清：resyncFor（本人）照常同步，油箱淨額不變
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        ct.resyncFor{value: newFee * 3}(bob, 0);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(ct.syncGasBalance(bob), TANK);
        vm.revertToState(snap);

        // 看過新費率、簽名帶入新上限：從油箱扣
        vm.prank(bob);
        ct.resyncAtVersion(0, 1, newFee);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(ct.syncGasBalance(bob), TANK - newFee * 3);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 以舊入口跟單、之後才開啟自動同步：上限是簽名帶入的值，現行費率高於它整筆 revert；
    /// 成功時記下現行費率（簽名值給得再寬也一樣）；關閉後歸零，關閉不因費率被擋。
    function test_setAutoSync_storesConsentedExecFee() public {
        _followLegacy(bob);
        assertEq(ct.syncExecFeeCap(bob, 0), 0);
        exchange.setExecutionFee(EXEC_FEE * 3);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, EXEC_FEE * 3, EXEC_FEE));
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE);
        (bool on,,,) = ct.syncConfig(bob, 0);
        assertFalse(on, "nothing changed");

        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE * 3);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE * 3);
        vm.prank(bob);
        ct.setAutoSync(0, true, 5, CD, 0, 1 ether);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE * 3, "min(signed cap, current fee)");

        exchange.setExecutionFee(1 ether);
        vm.prank(bob);
        ct.setAutoSync(0, false, 5, CD, 0, 0);
        assertEq(ct.syncExecFeeCap(bob, 0), 0);
        (on,,,) = ct.syncConfig(bob, 0);
        assertFalse(on, "disabling never depends on the fee");
    }

    // ── 交易所 owner 搶先調高 executionFee（審查 PoC 的回歸測試）───────────────

    /// 審查 PoC：bob 油箱 3.01 ETH，畫面上的費率 0.0001 ETH／腿；owner 在同一個區塊搶先把
    /// executionFee 調到 1 ETH，bob 的「立即同步」原本會被扣 3 ETH、owner 再 withdrawExecutionFees
    /// 領走。現在 resyncAtVersion 帶著 bob 簽名的費率上限，整筆 revert；resyncFor（本人）也一樣。
    function test_ownerFrontRunsManualSync_cannotDrainTank() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(bob);
        ct.depositSyncGas{value: 3 ether}();
        uint256 tank = ct.syncGasBalance(bob);
        _publish(_v1());

        exchange.setExecutionFee(1 ether);   // 本測試合約是交易所 owner：搶先調費
        uint256 exchangeEth = address(exchange).balance;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 1 ether, EXEC_FEE));
        ct.resyncAtVersion(0, 1, EXEC_FEE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 1 ether, EXEC_FEE));
        ct.resyncFor(bob, 0);

        assertEq(ct.syncGasBalance(bob), tank, "tank untouched");
        assertEq(address(exchange).balance, exchangeEth, "nothing moved into the exchange");
        assertEq(_rec(bob, 0).versionId, 0);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 審查 PoC：bob 只是想改小費而呼叫 setAutoSync，owner 搶先調費，原本同意值會被記成 1 ETH，
    /// 之後第三方同步就按 1 ETH／腿扣油箱。現在 setAutoSync 帶著 bob 簽名的上限：整筆 revert、
    /// 設定與同意值都不變，第三方同步仍被擋。先存油箱、之後才開啟自動同步的情境也一樣。
    function test_ownerFrontRunsSetAutoSync_cannotRaiseConsent() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        vm.prank(bob);
        ct.depositSyncGas{value: 3 ether}();
        uint256 tank = ct.syncGasBalance(bob);

        exchange.setExecutionFee(1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 1 ether, EXEC_FEE));
        ct.setAutoSync(0, true, 5, CD, TIP * 2, EXEC_FEE);
        (,,, uint96 tip) = ct.syncConfig(bob, 0);
        assertEq(tip, TIP, "settings unchanged");
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE, "consent unchanged");

        _publish(_v1());
        _waitCooldown(bob, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 1 ether, EXEC_FEE));
        ct.resyncFor(bob, 0);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 1 ether, EXEC_FEE));
        ct.resyncFor(bob, 0);                 // owner 自己當執行者
        assertEq(ct.syncGasBalance(bob), tank, "tank untouched");

        // 情境二：carol 以舊入口跟單、先存 0.3 ETH，owner 搶在她開啟自動同步之前調費
        vm.prank(carol);
        ct.followTrader{value: 1 ether * 3}(alice, 1_000e18);
        vm.prank(carol);
        ct.depositSyncGas{value: 0.3 ether}();
        exchange.setExecutionFee(0.1 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, 0.1 ether, EXEC_FEE));
        ct.setAutoSync(0, true, 5, CD, 0, EXEC_FEE);
        _publish(_v0());
        vm.warp(vm.getBlockTimestamp() + CD);
        _refreshPrices();
        vm.expectRevert(CopyTracker.AutoSyncDisabled.selector);
        ct.resyncFor(carol, 0);
        assertEq(ct.syncGasBalance(carol), 0.3 ether, "carol's tank untouched");
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 審查 PoC：bob 送出「執行費 × 3 ＋ 0.01 ETH 油箱」，owner 搶先把費率調到「送出金額 ÷ 3」，
    /// 原本整筆 msg.value 都被當成開倉執行費收走、油箱只剩 1 wei，同意值也被記成調高後的費率。
    /// 現在整筆 revert：bob 的 ETH、USDC 與交易所的 ETH 都不變。
    function test_ownerFrontRunsFollowWithAutoSync_cannotTakeTank() public {
        uint256 sent = EXEC_FEE * 3 + 0.01 ether;
        uint256 frontRunFee = sent / 3;
        exchange.setExecutionFee(frontRunFee);
        uint256 bobEth = bob.balance;
        uint256 bobUsdc = usdc.balanceOf(bob);
        uint256 exchangeEth = address(exchange).balance;

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.ExecutionFeeAboveCap.selector, frontRunFee, EXEC_FEE));
        ct.followTraderAtVersionWithAutoSync{value: sent}(alice, 1_000e18, 0, 5, CD, TIP, EXEC_FEE);

        assertEq(bob.balance, bobEth);
        assertEq(usdc.balanceOf(bob), bobUsdc);
        assertEq(address(exchange).balance, exchangeEth);
        assertEq(ct.getCopyRecords(bob).length, 0);
        assertEq(ct.syncGasBalance(bob), 0);

        // 費率回到 bob 看到的水準：照常一筆完成，同意值是 bob 簽名帶入的上限內的現行費率
        exchange.setExecutionFee(EXEC_FEE);
        vm.prank(bob);
        ct.followTraderAtVersionWithAutoSync{value: sent}(alice, 1_000e18, 0, 5, CD, TIP, EXEC_FEE);
        assertEq(ct.syncGasBalance(bob), 0.01 ether);
        assertEq(ct.syncExecFeeCap(bob, 0), EXEC_FEE);
    }

    // ── 極小權重：pendingSync 不再誤報可同步 ─────────────────────────────────

    /// 交易者發布 5000／4999／1 bps 的版本：1 bps 那條腿的份額低於交易所的 MIN_MARGIN，
    /// resyncFor 必定 revert MarginTooLow。pendingSync 以 deployedAmount 估算、回報不可同步；
    /// 部位維持舊版（跟隨者可照常取消跟單），交易者發布正常的版本後同步恢復。
    function test_pendingSync_dustWeightLeg_reportsNotSyncable() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 1);
        a[1] = StrategyRegistry.Allocation(ETH, 4_999, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 1, true, 1);
        _publish(a);
        _waitCooldown(bob, 0);

        (bool s, uint256 v,) = ct.pendingSync(bob, 0);
        assertFalse(s, "a 1 bps leg is below MIN_MARGIN");
        assertEq(v, 1);
        vm.prank(keeper);
        vm.expectRevert(PerpetualExchange.MarginTooLow.selector);
        ct.resyncFor(bob, 0);
        assertEq(_rec(bob, 0).versionId, 0);
        assertEq(ct.syncGasBalance(bob), TANK);

        _publish(_v1());
        (s,,) = ct.pendingSync(bob, 0);
        assertTrue(s);
        _resyncAs(keeper, bob, 0);
        assertEq(_rec(bob, 0).versionId, 2);
    }

    // ── 既有入口與計分（沒有同步過的跟單）不變 ───────────────────────────────

    function test_unfollowWithoutAnySync_scoresAsBefore() public {
        _followAuto(bob, 1_000e18, 5, CD, TIP);
        oracle.updatePrice(BTC, 60_000e8);   // −400 / 1,000
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        assertEq(ts.getStake(alice).amount, 300e18);
    }

    // ── fuzz：金額、權重、槓桿、手續費 ─────────────────────────────────────

    function testFuzz_resync_amountsWeightsLeverages(
        uint256 margin,
        uint256 w0Seed,
        uint256 w1Seed,
        uint256 levSeed,
        uint8   capSeed,
        uint8   exCapSeed,
        uint16  feeSeed,
        uint256 otherSeed
    ) public {
        margin = bound(margin, 300e18, 50_000e18);
        uint256 w0 = bound(w0Seed, 1_000, 5_000);
        uint256 w1 = bound(w1Seed, w0 >= 4_000 ? 1_000 : 5_000 - w0, w0 <= 4_000 ? 5_000 : 9_000 - w0);
        uint256 w2 = 10_000 - w0 - w1;
        uint8 cap = uint8(bound(capSeed, 1, 5));
        uint256 exCap = bound(exCapSeed, 1, 5);
        uint256 feeBps = bound(feeSeed, 0, 100);
        uint256 other = bound(otherSeed, 0, 10_000e18);

        exchange.setTradingFeeBps(feeBps);
        _followAuto(bob, margin, 5, CD, TIP);
        if (other != 0) {
            vm.prank(bob);
            exchange.depositMargin(other);
        }

        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        uint256[3] memory levChoices = [uint256(1), 2, 5];
        a[0] = StrategyRegistry.Allocation(BTC, w0, true, levChoices[levSeed % 3]);
        a[1] = StrategyRegistry.Allocation(ETH, w1, false, levChoices[(levSeed / 3) % 3]);
        a[2] = StrategyRegistry.Allocation(AAPL, w2, true, levChoices[(levSeed / 9) % 3]);
        _publish(a);
        exchange.setMaxLeverageFor(BTC, exCap);
        vm.prank(bob);
        ct.setAutoSync(0, true, cap, CD, TIP, EXEC_FEE);
        _waitCooldown(bob, 0);

        // 平倉會釋出多少（價格不動、無借貸費與資金費）：margin − 平倉交易費
        uint256 released;
        uint256[] memory oldIds = _rec(bob, 0).positionIds;
        for (uint256 i; i < oldIds.length; ++i) {
            PerpetualExchange.Position memory p = _pos(oldIds[i]);
            released += p.margin - p.margin * p.leverage * p.tradingFeeBps / 10_000;
        }
        uint256 freeBefore = exchange.freeMargin(bob);
        uint256 tankBefore = ct.syncGasBalance(bob);
        uint256 keeperBefore = keeper.balance;

        _resyncAs(keeper, bob, 0);

        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        uint256 spent;
        for (uint256 i; i < 3; ++i) {
            PerpetualExchange.Position memory p = _pos(r.positionIds[i]);
            uint256 want = a[i].leverage;
            uint256 assetMax = exchange.maxLeverageForAsset(a[i].asset);
            if (want > assetMax) want = assetMax;
            if (want > cap) want = cap;
            assertEq(p.leverage, want, "leverage = min(strategy, exchange, follower)");
            assertEq(p.margin, r.deployedAmount * a[i].weight / 10_000);
            assertEq(p.isLong, a[i].isLong);
            spent += p.margin + p.margin * p.leverage * feeBps / 10_000;
        }
        assertLe(_sumMargins(r.positionIds), r.deployedAmount);
        assertLe(spent, released, "never more than the closes released");
        assertEq(exchange.freeMargin(bob), freeBefore + released - spent, "only the released margin moved");
        assertGe(exchange.freeMargin(bob), other, "the follower's other funds are never used");
        assertEq(tankBefore - ct.syncGasBalance(bob), EXEC_FEE * 3 + TIP);
        assertEq(keeper.balance - keeperBefore, TIP);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    // ── 本人手動同步釘版本（resyncAtVersion）──────────────────────────────────

    /// 全部空單 5 倍：交易者「搶在跟隨者按下同步之前」發布的版本。
    function _allShort5x() internal pure returns (StrategyRegistry.Allocation[] memory a) {
        a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 4_000, false, 5);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, false, 5);
        a[2] = StrategyRegistry.Allocation(SOL, 3_000, false, 5);
    }

    /// 審查 PoC 的反例：bob 看了 v1 才按「立即同步」，交易者在他按下之前又發了 v2（全空 5 倍）。
    /// resyncFor 會直接採用 v2；resyncAtVersion(0, 1) 整筆 revert，部位與油箱維持原狀。
    function test_resyncAtVersion_rejectsVersionPublishedAfterReview() public {
        _followLegacy(bob);
        uint256[] memory oldIds = _rec(bob, 0).positionIds;
        _publish(_v1());          // bob 在畫面上看到的版本
        _publish(_allShort5x());  // 交易者在他按下之前發布

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.StrategyVersionMismatch.selector, 1, 2));
        ct.resyncAtVersion{value: EXEC_FEE * 3}(0, 1, EXEC_FEE);
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.versionId, 0, "record untouched");
        assertEq(r.positionIds, oldIds);
        for (uint256 i; i < oldIds.length; ++i) assertTrue(_pos(oldIds[i]).isOpen);
        assertEq(ct.syncGasBalance(bob), 0, "msg.value reverted with the call");
        assertEq(_state(bob, 0).syncCount, 0);

        // 看過 v2、釘 v2 再送 → 成功
        vm.expectEmit(true, true, true, false, address(ct));
        emit Resynced(bob, 0, alice, 0, 2, bob, 0, 3);
        vm.prank(bob);
        ct.resyncAtVersion{value: EXEC_FEE * 3}(0, 2, EXEC_FEE);
        r = _rec(bob, 0);
        assertEq(r.versionId, 2);
        assertEq(_pos(r.positionIds[0]).leverage, 5);
        assertFalse(_pos(r.positionIds[0]).isLong);
        assertEq(_state(bob, 0).syncCount, 1);
        assertEq(ct.syncGasBalance(bob), 0, "exactly the open fees, no tip");
    }

    /// 釘版本的入口只能同步自己的跟單；不收小費、不受冷卻，與 resyncFor 的本人路徑相同。
    function test_resyncAtVersion_selfOnly_noTipNoCooldown() public {
        _followAuto(bob, 1_000e18, 5, 1 days, TIP);
        _publish(_v1());

        // 別人呼叫只會作用在他自己的（不存在的）紀錄上，碰不到 bob 的
        vm.prank(keeper);
        vm.expectRevert(CopyTracker.InvalidRecordIndex.selector);
        ct.resyncAtVersion(0, 1, EXEC_FEE);

        // 冷卻 1 天還沒過，本人仍可同步；只扣執行費、沒有小費
        uint256 tankBefore = ct.syncGasBalance(bob);
        uint256 keeperBefore = keeper.balance;
        vm.prank(bob);
        ct.resyncAtVersion(0, 1, EXEC_FEE);
        assertEq(_rec(bob, 0).versionId, 1);
        assertEq(tankBefore - ct.syncGasBalance(bob), EXEC_FEE * 3);
        assertEq(keeper.balance, keeperBefore);

        // 已是最新版：先回 AlreadySynced（不論釘哪一版）
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.AlreadySynced.selector, 1, 1));
        ct.resyncAtVersion(0, 1, EXEC_FEE);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.AlreadySynced.selector, 1, 1));
        ct.resyncAtVersion(0, 0, EXEC_FEE);
        vm.stopPrank();

        // 結束的跟單不能再同步
        vm.prank(bob);
        ct.unfollowAndCloseAll(0);
        _publish(_v0());
        vm.prank(bob);
        vm.expectRevert(CopyTracker.RecordAlreadyInactive.selector);
        ct.resyncAtVersion(0, 2, EXEC_FEE);
    }

    // ── 合約錢包跟隨者：提領到指定地址（withdrawSyncGasTo）────────────────────

    /// 審查 PoC：沒有 receive 的合約錢包存得進油箱、卻用 withdrawSyncGas 領不出來（取消跟單後也一樣）。
    /// withdrawSyncGasTo 讓它把自己的油箱領到別的地址。
    function test_withdrawSyncGasTo_contractWalletWithoutReceive() public {
        NoReceiveWallet w = new NoReceiveWallet(ct, usdc);
        usdc.mint(address(w), 10_000e18);
        vm.deal(address(w), 1 ether);
        w.followAuto{value: EXEC_FEE * 3 + TANK}(alice, 1_000e18, 0, 5, CD, TIP, EXEC_FEE);
        assertEq(ct.syncGasBalance(address(w)), TANK);

        vm.expectRevert(CopyTracker.EthTransferFailed.selector);
        w.withdraw(TANK);
        assertEq(ct.syncGasBalance(address(w)), TANK, "failed withdrawal leaves the tank intact");

        address treasury = makeAddr("walletTreasury");
        vm.expectEmit(true, false, false, true, address(ct));
        emit SyncGasWithdrawn(address(w), TANK / 2);
        w.withdrawTo(treasury, TANK / 2);
        assertEq(treasury.balance, TANK / 2);
        assertEq(ct.syncGasBalance(address(w)), TANK - TANK / 2);

        // 取消跟單之後一樣領得出來
        w.unfollow(0);
        vm.expectRevert(CopyTracker.EthTransferFailed.selector);
        w.withdraw(1);
        w.withdrawTo(treasury, TANK - TANK / 2);
        assertEq(treasury.balance, TANK);
        assertEq(ct.syncGasBalance(address(w)), 0);
        assertEq(ct.totalSyncGas(), 0);
        assertEq(address(ct).balance, 0);
    }

    /// withdrawSyncGasTo 只扣呼叫者自己的帳：把別人填成收款人也動不了別人的油箱；收款地址不能是 0。
    function test_withdrawSyncGasTo_onlyDebitsCallerAndRejectsZero() public {
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, 1, 0));
        ct.withdrawSyncGasTo(keeper, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.InsufficientSyncGas.selector, 1, 0));
        ct.withdrawSyncGasTo(bob, 1);

        vm.prank(bob);
        vm.expectRevert(CopyTracker.InvalidRecipient.selector);
        ct.withdrawSyncGasTo(address(0), 1);

        uint256 before = carol.balance;
        vm.prank(bob);
        ct.withdrawSyncGasTo(carol, 0.25 ether);
        assertEq(carol.balance - before, 0.25 ether);
        assertEq(ct.syncGasBalance(bob), 0.75 ether);
        assertEq(ct.syncGasBalance(carol), 0);
        assertEq(ct.totalSyncGas(), 0.75 ether);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 收款合約在 receive 裡重入提領：被 nonReentrant 擋下，只付一次。
    function test_reentrancy_withdrawToCannotReenter() public {
        ReentrantWithdrawer r = new ReentrantWithdrawer(ct);
        vm.deal(address(r), 1 ether);
        vm.prank(address(r));
        ct.depositSyncGas{value: 1 ether}();
        vm.prank(bob);
        ct.depositSyncGas{value: 1 ether}();
        vm.prank(bob);
        ct.withdrawSyncGasTo(address(r), 0.3 ether);
        assertEq(bytes4(r.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(r).balance, 0.3 ether);
        assertEq(ct.syncGasBalance(address(r)), 1 ether, "the recipient's own tank is untouched");
        assertEq(ct.syncGasBalance(bob), 0.7 ether);
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    // ── 預覽套用跟隨者槓桿上限（previewCopyAllocationWithCap）─────────────────

    /// 預覽與「跟單＋自動同步」上鏈結果一致：緩衝、實際投入保證金、各腿份額與槓桿。
    function test_previewWithCap_matchesFollowWithAutoSync() public {
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 4_000, true, 5);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, false, 2);
        a[2] = StrategyRegistry.Allocation(SOL, 3_000, true, 1);
        _publish(a);
        exchange.setTradingFeeBps(100);

        // 不設上限：BTC 400×5 + ETH 300×2 + SOL 300×1 = 2,900 名目 × 1%
        (, uint256 uncappedFee,,) = ct.previewCopyAllocation(alice, 1_000e18);
        assertEq(uncappedFee, 29e18);
        (, uint256 zeroCapFee,,) = ct.previewCopyAllocationWithCap(alice, 1_000e18, 0);
        assertEq(zeroCapFee, uncappedFee, "cap 0 = no cap");

        // 上限 1 倍：1,000 名目 × 1%
        (uint256 copyFee, uint256 fee, uint256 deployed, uint256[] memory portions) =
            ct.previewCopyAllocationWithCap(alice, 1_000e18, 1);
        assertEq(copyFee, 0);
        assertEq(fee, 10e18);
        assertEq(deployed, 990e18);

        _followAuto(bob, 1_000e18, 1, CD, 0);
        CopyTracker.CopyRecord memory r = _rec(bob, 0);
        assertEq(r.deployedAmount, deployed, "preview = on-chain deployed margin");
        for (uint256 i; i < r.positionIds.length; ++i) {
            assertEq(_pos(r.positionIds[i]).margin, portions[i]);
            assertEq(_pos(r.positionIds[i]).leverage, 1);
        }

        // 上限高於策略與交易所上限時等同不設；交易所上限仍然生效
        exchange.setMaxLeverageFor(BTC, 2);
        (, uint256 capFiveFee,,) = ct.previewCopyAllocationWithCap(alice, 1_000e18, 5);
        (, uint256 noCapFee,,) = ct.previewCopyAllocation(alice, 1_000e18);
        assertEq(capFiveFee, noCapFee);
        assertEq(noCapFee, 17e18, "BTC 400x2 + ETH 300x2 + SOL 300x1 = 1,700");
    }

    function _refreshPrices() internal {
        oracle.updatePrice(BTC, 100_000e8);
        oracle.updatePrice(ETH, 4_000e8);
        oracle.updatePrice(SOL, 1_000e8);
        oracle.updatePrice(XAU, 2_000e8);
        oracle.updatePrice(AAPL, 200e8);
    }
}

/// @dev 收到小費時嘗試重入 withdrawSyncGas 與 resyncFor，兩次的失敗原因分開記下（不讓 receive 失敗）。
contract ReentrantExecutor {
    CopyTracker immutable ct;
    address immutable follower;
    bool public attempted;
    bytes public withdrawError;
    bytes public resyncError;

    constructor(CopyTracker _ct, address _follower) {
        ct = _ct;
        follower = _follower;
    }

    /// 存進自己的油箱：讓重入的提領「若沒有 nonReentrant 就會成功」，斷言才有意義。
    function fund() external payable {
        ct.depositSyncGas{value: msg.value}();
    }

    function run() external {
        ct.resyncFor(follower, 0);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try ct.withdrawSyncGas(1) {} catch (bytes memory e) { withdrawError = e; }
        try ct.resyncFor(follower, 0) {} catch (bytes memory e) { resyncError = e; }
    }
}

contract NoReceive {}

/// @dev 提領時在 receive 裡再提一次。
contract ReentrantWithdrawer {
    CopyTracker immutable ct;
    bool entered;
    bytes public lastError;

    constructor(CopyTracker _ct) {
        ct = _ct;
    }

    function depositAndWithdraw(uint256 deposit, uint256 amount) external {
        ct.depositSyncGas{value: deposit}();
        ct.withdrawSyncGas(amount);
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        try ct.withdrawSyncGas(msg.value) {} catch (bytes memory e) { lastError = e; }
    }
}

/// @dev 沒有 receive／payable fallback 的合約錢包跟隨者（部分多簽、自訂 AA 錢包）。
contract NoReceiveWallet {
    CopyTracker immutable ct;

    constructor(CopyTracker _ct, MockUSDC _usdc) {
        ct = _ct;
        _usdc.approve(address(_ct), type(uint256).max);
    }

    function followAuto(
        address trader,
        uint256 margin,
        uint256 version,
        uint8 maxLev,
        uint32 interval,
        uint96 tip,
        uint256 maxExecFee
    ) external payable {
        ct.followTraderAtVersionWithAutoSync{value: msg.value}(trader, margin, version, maxLev, interval, tip, maxExecFee);
    }

    function withdraw(uint256 amount) external {
        ct.withdrawSyncGas(amount);
    }

    function withdrawTo(address to, uint256 amount) external {
        ct.withdrawSyncGasTo(to, amount);
    }

    function unfollow(uint256 idx) external {
        ct.unfollowAndCloseAll(idx);
    }
}
