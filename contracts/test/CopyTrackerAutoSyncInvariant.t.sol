// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice 自動同步的油箱與部位不變量。處理器隨機穿插：存入／提領油箱、
///         試圖提領別人的油箱、交易者發新版、第三方或本人同步（可附 ETH）、
///         改設定（簽名帶入的執行費上限時高時低）、交易所 owner 調費、價格小幅波動、時間前進。所有對 tracker 的呼叫都包在 try 裡，
///         只有成功時才記帳，處理器本身永不 revert（fail-on-revert）。
contract AutoSyncHandler is Test {
    CopyTracker       public ct;
    PerpetualExchange public exchange;
    StrategyRegistry  public registry;
    MockOracle        public oracle;
    address           public trader;
    address           public owner;

    address[] public followers;
    address[] public strangers;

    bytes32[4] internal assets = [keccak256("BTC"), keccak256("ETH"), keccak256("SOL"), keccak256("AAPL")];
    uint256[4] internal basePrices = [uint256(100_000e8), 4_000e8, 1_000e8, 200e8];

    // ── ghost 帳 ────────────────────────────────────────────────────────────
    mapping(address => uint256) public credited;    // 進入此人油箱的 ETH（本人存入或別人代付）
    mapping(address => uint256) public withdrawn;   // 此人從油箱提領出的 ETH
    mapping(address => uint256) public charged;     // 同步時從此人油箱扣掉的 ETH
    mapping(address => uint256) public tipsEarned;  // 此人作為執行者拿到的小費
    mapping(address => uint256) public valueSent;   // 此人送進 tracker 的 ETH（存入、代付）
    uint256 public syncs;
    uint256 public pinnedSyncs;   // 其中走 resyncAtVersion 的次數
    uint256 public foreignWithdrawAttempts;
    bool    public foreignWithdrawSucceeded;
    /// 同步成功、而且從油箱付了高於跟隨者同意費率的 executionFee（不該發生）：第三方高於
    /// syncExecFeeCap；本人經 resyncFor 高於 syncExecFeeCap 且附帶的 ETH 付不清；resyncAtVersion
    /// 高於這筆交易簽名帶入的上限。
    bool    public paidAboveConsent;
    /// setAutoSync 成功開啟後記下的 syncExecFeeCap 高於跟隨者簽名帶入的上限（不該發生）。
    bool    public storedCapAboveSigned;
    uint256 public consentRejections;   // setAutoSync／resyncAtVersion 因簽名上限被擋下的次數
    uint256 public feeChanges;

    constructor(
        CopyTracker _ct,
        PerpetualExchange _exchange,
        StrategyRegistry _registry,
        MockOracle _oracle,
        address _trader,
        address _owner,
        address[] memory _followers,
        address[] memory _strangers
    ) {
        ct = _ct;
        exchange = _exchange;
        registry = _registry;
        oracle = _oracle;
        trader = _trader;
        owner = _owner;
        followers = _followers;
        strangers = _strangers;
    }

    function followerCount() external view returns (uint256) { return followers.length; }
    function strangerCount() external view returns (uint256) { return strangers.length; }

    /// setUp 裡 follow 時存進油箱的金額。
    function bookInitialTank(address follower, uint256 amount, uint256 sent) external {
        credited[follower] += amount;
        valueSent[follower] += sent;
    }

    function _actor(uint256 seed) internal view returns (address) {
        uint256 n = followers.length + strangers.length;
        uint256 i = seed % n;
        return i < followers.length ? followers[i] : strangers[i - followers.length];
    }

    // ── 動作 ───────────────────────────────────────────────────────────────

    function deposit(uint256 who, uint256 amount) external {
        address a = _actor(who);
        amount = bound(amount, 0, 0.05 ether);
        vm.deal(a, a.balance + amount);
        vm.prank(a);
        try ct.depositSyncGas{value: amount}() {
            credited[a] += amount;
            valueSent[a] += amount;
        } catch {}
    }

    /// 提領自己的油箱：一半走 withdrawSyncGas，一半走 withdrawSyncGasTo（付到另一個參與者）。
    function withdraw(uint256 who, uint256 amount, uint256 toSeed) external {
        address a = _actor(who);
        amount = bound(amount, 0, ct.syncGasBalance(a) + 1);   // 偶爾超額 → revert
        vm.prank(a);
        if (toSeed % 2 == 0) {
            try ct.withdrawSyncGas(amount) {
                withdrawn[a] += amount;
            } catch {}
        } else {
            try ct.withdrawSyncGasTo(_actor(toSeed / 2), amount) {
                withdrawn[a] += amount;
            } catch {}
        }
    }

    /// 「小偷」只能動自己的帳——不論是 withdrawSyncGas，還是把收款人填成自己的 withdrawSyncGasTo；
    /// 目標的油箱必須原封不動。
    function withdrawForeign(uint256 thiefSeed, uint256 victimSeed, uint256 amount) external {
        address thief = _actor(thiefSeed);
        address victim = followers[victimSeed % followers.length];
        if (thief == victim) return;
        uint256 victimBefore = ct.syncGasBalance(victim);
        amount = bound(amount, ct.syncGasBalance(thief) + 1, ct.syncGasBalance(thief) + victimBefore + 1);
        foreignWithdrawAttempts++;
        vm.prank(thief);
        if (amount % 2 == 0) {
            try ct.withdrawSyncGas(amount) {
                foreignWithdrawSucceeded = true;
            } catch {}
        } else {
            try ct.withdrawSyncGasTo(thief, amount) {
                foreignWithdrawSucceeded = true;
            } catch {}
        }
        if (ct.syncGasBalance(victim) != victimBefore) foreignWithdrawSucceeded = true;
    }

    function publish(uint256 seed) external {
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        uint256 skip = seed % 4;             // 四個資產挑三個
        uint256[3] memory weights = [uint256(4_000), 3_500, 2_500];
        uint256[3] memory levs = [uint256(1), 2, 5];
        uint256 k;
        for (uint256 i; i < 4; ++i) {
            if (i == skip) continue;
            a[k] = StrategyRegistry.Allocation(assets[i], weights[(k + seed / 4) % 3], (seed >> (8 + k)) & 1 == 0, levs[(seed >> (16 + 2 * k)) % 3]);
            ++k;
        }
        vm.prank(trader);
        try registry.publishStrategy(a) {} catch {}
    }

    /// 對每個 follower 各試一次同步（執行者三分之一機率是本人），提高真正同步的比例。
    function resync(uint256 execSeed, uint256 value) external {
        for (uint256 i; i < followers.length; ++i) {
            _resyncOne(followers[i], uint256(keccak256(abi.encode(execSeed, i))), value);
        }
    }

    function _resyncOne(address follower, uint256 execSeed, uint256 value) internal {
        address exec = execSeed % 3 == 0 ? follower : _actor(execSeed / 3);
        value = bound(value, 0, 0.002 ether);
        vm.deal(exec, exec.balance + value);

        (StrategyRegistry.Allocation[] memory allocs, uint256 latest) = registry.getLatestStrategy(trader);
        (,,, uint96 tipWei) = ct.syncConfig(follower, 0);
        uint256 tip = exec == follower ? 0 : tipWei;
        uint256 cost = exchange.executionFee() * allocs.length + tip;

        uint256 execEthBefore = exec.balance;
        uint256 fee = exchange.executionFee();
        // 本人同步時一半走釘版本的 resyncAtVersion（釘最新版、簽名帶入費率上限；四分之一的機率
        // 帶入比現行費率低 1 wei 的上限，模擬 owner 搶先調費）
        bool pinned = exec == follower && (execSeed >> 128) % 2 == 0;
        uint256 signed = (execSeed >> 64) % 4 == 0 ? fee - 1 : fee;
        bool consented = pinned
            ? fee <= signed
            : fee <= ct.syncExecFeeCap(follower, 0) || (exec == follower && value >= cost);
        vm.prank(exec);
        if (_tryResync(follower, latest, value, pinned, signed)) {
            ++syncs;
            if (pinned) ++pinnedSyncs;
            if (!consented) paidAboveConsent = true;
            credited[follower] += value;
            valueSent[exec] += value;
            charged[follower] += cost;
            tipsEarned[exec] += tip;
            // 執行者實拿 = 小費 − 附帶的 ETH
            require(exec.balance + value == execEthBefore + tip, "executor received something other than the tip");
        }
    }

    /// @dev 呼叫前先 vm.prank(exec)：這裡的第一個外部呼叫就是同步本身，ETH 由 exec 附上。
    function _tryResync(address follower, uint256 latest, uint256 value, bool pinned, uint256 signed)
        internal
        returns (bool)
    {
        if (pinned) {
            try ct.resyncAtVersion{value: value}(0, latest, signed) { return true; } catch (bytes memory err) {
                if (bytes4(err) == CopyTracker.ExecutionFeeAboveCap.selector) ++consentRejections;
                return false;
            }
        }
        try ct.resyncFor{value: value}(follower, 0) { return true; } catch { return false; }
    }

    /// 簽名帶入的執行費上限三選一：比現行費率低 1 wei（模擬 owner 搶先調費 → 必須 revert）、
    /// 剛好等於現行費率、或寬鬆的兩倍（記下的仍只能是現行費率）。
    function setAutoSync(uint256 followerSeed, bool on, uint8 lev, uint32 interval, uint96 tip, uint256 feeSeed)
        external
    {
        address follower = followers[followerSeed % followers.length];
        lev = uint8(bound(lev, on ? 1 : 0, 5));
        // 偶爾低於 MIN_SYNC_INTERVAL（→ InvalidSyncConfig），多數落在合法範圍
        interval = uint32(bound(interval, 30 minutes, 3 hours));
        tip = uint96(bound(tip, 0, ct.MAX_TIP_WEI()));
        uint256 fee = exchange.executionFee();
        uint256 choice = feeSeed % 3;
        uint256 signed = choice == 0 ? fee - 1 : choice == 1 ? fee : fee * 2;
        vm.prank(follower);
        try ct.setAutoSync(0, on, lev, interval, tip, signed) {
            uint256 cap = ct.syncExecFeeCap(follower, 0);
            if (on && (cap > signed || cap != fee)) storedCapAboveSigned = true;
            if (!on && cap != 0) storedCapAboveSigned = true;
        } catch (bytes memory err) {
            if (bytes4(err) == CopyTracker.ExecutionFeeAboveCap.selector) {
                ++consentRejections;
                if (!on || signed >= fee) storedCapAboveSigned = true;   // 只該在開啟且上限過低時被擋
            }
        }
    }

    /// 交易所 owner 調整 executionFee（基準的一半到三倍）：第三方同步只能按跟隨者同意的費率扣。
    function setExecutionFee(uint256 seed) external {
        uint256 fee = bound(seed, 0.00005 ether, 0.0003 ether);
        vm.prank(owner);
        exchange.setExecutionFee(fee);
        ++feeChanges;
    }

    /// 價格在基準 ±10% 內波動：5 倍槓桿最多 −50%，不會觸發清算。
    function movePrice(uint256 assetSeed, uint256 bps) external {
        uint256 i = assetSeed % 4;
        bps = bound(bps, 9_000, 11_000);
        vm.prank(owner);
        oracle.updatePrice(assets[i], basePrices[i] * bps / 10_000);
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 2 hours);
        vm.warp(vm.getBlockTimestamp() + dt);
        // 交易所拒收超過 24 小時的價格；持續刷新，讓同步只被規則擋下，而不是被過期價格擋下。
        for (uint256 i; i < 4; ++i) {
            (uint256 p,) = oracle.getPrice(assets[i]);
            vm.prank(owner);
            oracle.updatePrice(assets[i], p);
        }
    }
}

/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = true
contract CopyTrackerAutoSyncInvariantTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;
    AutoSyncHandler   handler;

    address trader = makeAddr("trader");
    address[] followers;
    address[] strangers;

    uint256 constant EXEC_FEE = 0.0001 ether;
    uint256 constant TANK     = 0.02 ether;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        registry = new StrategyRegistry(address(0));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(0));
        exchange.setCopyTracker(address(ct));
        exchange.setExecutionFee(EXEC_FEE);
        exchange.setTradingFeeBps(10);
        exchange.setBorrowFeePerHour(0);

        oracle.addAsset(keccak256("BTC"), 100_000e8);
        oracle.addAsset(keccak256("ETH"), 4_000e8);
        oracle.addAsset(keccak256("SOL"), 1_000e8);
        oracle.addAsset(keccak256("AAPL"), 200e8);
        usdc.mint(address(exchange), 10_000_000e18);

        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(keccak256("BTC"), 5_000, true, 2);
        a[1] = StrategyRegistry.Allocation(keccak256("ETH"), 3_000, false, 1);
        a[2] = StrategyRegistry.Allocation(keccak256("SOL"), 2_000, true, 5);
        vm.startPrank(trader);
        registry.registerTrader("Trader");
        registry.publishStrategy(a);
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            followers.push(makeAddr(string.concat("follower", vm.toString(i))));
            strangers.push(makeAddr(string.concat("stranger", vm.toString(i))));
        }

        handler = new AutoSyncHandler(ct, exchange, registry, oracle, trader, address(this), followers, strangers);

        uint32[3] memory intervals = [uint32(1 hours), 90 minutes, 2 hours];
        uint96[3] memory tips = [uint96(0), 0.00001 ether, 0.0005 ether];
        for (uint256 i; i < 3; ++i) {
            address f = followers[i];
            usdc.mint(f, 10_000e18);
            vm.deal(f, 1 ether);
            vm.startPrank(f);
            usdc.approve(address(ct), type(uint256).max);
            ct.followTraderAtVersionWithAutoSync{value: EXEC_FEE * 3 + TANK}(
                trader, 3_000e18, 0, uint8(3 + i % 3), intervals[i], tips[i], EXEC_FEE
            );
            vm.stopPrank();
            handler.bookInitialTank(f, TANK, TANK);
        }

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = AutoSyncHandler.deposit.selector;
        sel[1] = AutoSyncHandler.withdraw.selector;
        sel[2] = AutoSyncHandler.withdrawForeign.selector;
        sel[3] = AutoSyncHandler.publish.selector;
        sel[4] = AutoSyncHandler.resync.selector;
        sel[5] = AutoSyncHandler.setAutoSync.selector;
        sel[6] = AutoSyncHandler.movePrice.selector;
        sel[7] = AutoSyncHandler.warp.selector;
        sel[8] = AutoSyncHandler.setExecutionFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _actors() internal view returns (address[] memory all) {
        all = new address[](followers.length + strangers.length);
        for (uint256 i; i < followers.length; ++i) all[i] = followers[i];
        for (uint256 i; i < strangers.length; ++i) all[followers.length + i] = strangers[i];
    }

    /// 每輪結束的活性檢查：不論處理器把狀態帶到哪裡，同步路徑都還走得通。只印次數擋不住
    /// 「同步全部 revert、帳本沒動、不變量照樣全過」的空轉，所以這裡直接斷言：
    ///   1. 價格回到基準（所有腿都健康）、交易者發一版新策略、時間前進到所有冷卻之後；
    ///   2. 每位跟隨者本人以 resyncAtVersion 釘最新版同步——必須成功（直接呼叫，revert 就讓測試失敗）；
    ///   3. 再發一版：開著自動同步、交易所費率在同意範圍內、油箱付得起的跟隨者，陌生人代為同步也必須成功。
    /// 處理器這一輪自己成功的同步次數仍印出來（-vv 可見）。
    function afterInvariant() public {
        console.log("syncs this run", handler.syncs(), "foreign attempts", handler.foreignWithdrawAttempts());
        console.log("pinned (resyncAtVersion) syncs", handler.pinnedSyncs());
        console.log("consent rejections", handler.consentRejections());

        _resetPricesAndWarp(0);
        _publishNext(1);
        uint256 selfSyncs;
        for (uint256 i; i < followers.length; ++i) {
            address f = followers[i];
            uint256 fee = exchange.executionFee();
            (, uint256 latest) = registry.getLatestStrategy(trader);
            uint256 cost = fee * 3;
            vm.deal(f, f.balance + cost);
            uint256 tankBefore = ct.syncGasBalance(f);
            vm.prank(f);
            ct.resyncAtVersion{value: cost}(0, latest, fee);
            assertEq(ct.getCopyRecords(f)[0].versionId, latest, "liveness: follower's own pinned sync");
            assertEq(ct.syncGasBalance(f), tankBefore, "attached ETH paid exactly the open fees");
            ++selfSyncs;
        }
        assertEq(selfSyncs, followers.length);

        // 第三方：冷卻最長 3 小時（處理器的 setAutoSync 上界），從剛才的同步起算
        _resetPricesAndWarp(3 hours + 1);
        _publishNext(2);
        address stranger = strangers[0];
        for (uint256 i; i < followers.length; ++i) {
            address f = followers[i];
            (bool on,,, uint96 tip) = ct.syncConfig(f, 0);
            uint256 fee = exchange.executionFee();
            if (!on || fee > ct.syncExecFeeCap(f, 0) || ct.syncGasBalance(f) < fee * 3 + tip) continue;
            assertLe(ct.syncReadyAt(f, 0), vm.getBlockTimestamp());
            (, uint256 latest) = registry.getLatestStrategy(trader);
            uint256 before = stranger.balance;
            vm.prank(stranger);
            ct.resyncFor(f, 0);
            assertEq(ct.getCopyRecords(f)[0].versionId, latest, "liveness: third-party sync");
            assertEq(stranger.balance - before, tip);
        }
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 價格回到基準並刷新時間戳，時間前進 `dt` 秒。腿的進場價都在基準 ±10% 內，回到基準時
    /// 5 倍槓桿最多虧約 56%，不會被清算，平倉一定釋出保證金。
    function _resetPricesAndWarp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        bytes32[4] memory ids = [keccak256("BTC"), keccak256("ETH"), keccak256("SOL"), keccak256("AAPL")];
        uint256[4] memory base = [uint256(100_000e8), 4_000e8, 1_000e8, 200e8];
        for (uint256 i; i < 4; ++i) oracle.updatePrice(ids[i], base[i]);
    }

    function _publishNext(uint256 salt) internal {
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(keccak256("ETH"), 4_000, salt % 2 == 0, 2);
        a[1] = StrategyRegistry.Allocation(keccak256("SOL"), 3_500, true, 1);
        a[2] = StrategyRegistry.Allocation(keccak256("AAPL"), 2_500, salt % 2 == 1, 5);
        vm.prank(trader);
        registry.publishStrategy(a);
    }

    /// 處理器自己的同步路徑走得到（固定序列）：發新版 → 時間前進到冷卻之後 → 同步。
    /// 處理器把每次同步都包在 try 裡，這支確保它不是永遠走到 catch。
    function test_handlerReachesSyncPath() public {
        handler.publish(7);
        handler.warp(2 hours);
        handler.resync(0, 0);
        assertGt(handler.syncs(), 0, "handler's resync path must be reachable");
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    /// 規格要求的不變量：tracker 手上的 ETH 永遠足以兌付所有油箱。
    function invariant_balanceCoversAllTanks() public view {
        assertGe(address(ct).balance, ct.totalSyncGas());
    }

    /// 更強：這套環境裡 ETH 沒有別的來源或去處（executionFee 剛好付足、沒有退款），
    /// 所以兩者恆等——任何一筆沒記帳的流入或流出都會被抓到。
    function invariant_balanceEqualsTotalSyncGas() public view {
        assertEq(address(ct).balance, ct.totalSyncGas());
    }

    function invariant_totalIsSumOfTanks() public view {
        address[] memory all = _actors();
        uint256 sum;
        for (uint256 i; i < all.length; ++i) sum += ct.syncGasBalance(all[i]);
        assertEq(sum, ct.totalSyncGas());
    }

    /// 每個油箱 = 存入 − 提領 − 同步成本，一 wei 不差。
    function invariant_tankGhostAccounting() public view {
        address[] memory all = _actors();
        for (uint256 i; i < all.length; ++i) {
            address a = all[i];
            assertEq(ct.syncGasBalance(a), handler.credited(a) - handler.withdrawn(a) - handler.charged(a));
        }
    }

    /// 任何同步（第三方、本人 resyncFor、resyncAtVersion）都不會從油箱付高於跟隨者簽名同意的執行費。
    function invariant_neverPaysAboveConsentedFee() public view {
        assertFalse(handler.paidAboveConsent());
    }

    /// 記下的同意值（syncExecFeeCap）從不高於跟隨者簽名帶入的上限；只有「開啟且上限低於現行費率」會被擋。
    function invariant_storedConsentNeverAboveSigned() public view {
        assertFalse(handler.storedCapAboveSigned());
    }

    /// 只有 follower 能提領自己的油箱：沒有人提領得比進入自己油箱的還多，
    /// 試圖提領別人的油箱從未成功。
    function invariant_onlyFollowerWithdrawsOwnTank() public view {
        address[] memory all = _actors();
        for (uint256 i; i < all.length; ++i) {
            assertLe(handler.withdrawn(all[i]), handler.credited(all[i]));
        }
        assertFalse(handler.foreignWithdrawSucceeded());
    }

    /// 每筆 active 跟單的腿都開著、屬於 follower、由 tracker 開立，版本不超前。
    function invariant_activeRecordsCoherent() public view {
        (, uint256 latest) = registry.getLatestStrategy(trader);
        for (uint256 i; i < followers.length; ++i) {
            CopyTracker.CopyRecord memory r = ct.getCopyRecords(followers[i])[0];
            assertTrue(r.active);
            assertLe(r.versionId, latest);
            assertEq(r.positionIds.length, 3);
            for (uint256 j; j < r.positionIds.length; ++j) {
                PerpetualExchange.Position memory p = exchange.getPosition(r.positionIds[j]);
                assertTrue(p.isOpen);
                assertEq(p.owner, followers[i]);
                assertEq(p.copiedFrom, trader);
                assertEq(exchange.positionAgent(r.positionIds[j]), address(ct));
            }
            CopyTracker.SyncState memory st = ct.getSyncState(followers[i], 0);
            assertLe(st.lastSyncedAt, vm.getBlockTimestamp());
        }
    }
}
