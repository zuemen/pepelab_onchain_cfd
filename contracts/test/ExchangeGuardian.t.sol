// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/AgentSessionManager.sol";
import "../src/StrategyRegistry.sol";
import "../src/TraderStake.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice P1: guardian / market-operator roles, the global pause, and the
///         per-asset Active / ReduceOnly / Halted modes — the permission
///         matrix, every value-moving entry point under every mode and under
///         pause, and the events.
contract ExchangeGuardianTest is Test {
    PerpetualExchange   exchange;
    MockUSDC            usdc;
    MockOracle          oracle;
    TraderStake         stake;
    StrategyRegistry    registry;
    CopyTracker         copyTracker;
    AgentSessionManager sessions;

    address guardian   = makeAddr("guardian");
    address operator   = makeAddr("operator");
    address stranger   = makeAddr("stranger");
    address user       = makeAddr("user");
    address other      = makeAddr("other");
    address agent      = makeAddr("agent");
    address trader     = makeAddr("trader");
    address follower   = makeAddr("follower");
    address liquidator = makeAddr("liquidator");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    PerpetualExchange.AssetMode constant ACTIVE      = PerpetualExchange.AssetMode.Active;
    PerpetualExchange.AssetMode constant REDUCE_ONLY = PerpetualExchange.AssetMode.ReduceOnly;
    PerpetualExchange.AssetMode constant HALTED      = PerpetualExchange.AssetMode.Halted;

    event GuardianSet(address indexed guardian);
    event MarketOperatorSet(address indexed marketOperator);
    event AssetModeSet(bytes32 indexed asset, PerpetualExchange.AssetMode mode, address indexed by);
    event Paused(address account);
    event Unpaused(address account);

    uint256 sessionId;

    function setUp() public {
        usdc        = new MockUSDC();
        oracle      = new MockOracle();
        exchange    = new PerpetualExchange(address(usdc), address(oracle), address(0));
        stake       = new TraderStake(address(usdc));
        registry    = new StrategyRegistry(address(stake));
        copyTracker = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(stake));
        sessions    = new AgentSessionManager(address(exchange));

        stake.setCopyTracker(address(copyTracker));
        exchange.setCopyTracker(address(copyTracker));
        exchange.setAgentAuthorized(address(sessions), true);
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
        exchange.setGuardian(guardian);
        exchange.setMarketOperator(operator);

        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 200e8);

        usdc.mint(address(exchange), 1_000_000e18); // reserves for winner payouts
        address[3] memory traders = [user, other, follower];
        for (uint256 i; i < traders.length; ++i) {
            usdc.mint(traders[i], 100_000e18);
            vm.prank(traders[i]);
            usdc.approve(address(exchange), type(uint256).max);
        }
        vm.prank(follower);
        usdc.approve(address(copyTracker), type(uint256).max);

        vm.prank(user);
        exchange.depositMargin(50_000e18);
        vm.prank(other);
        exchange.depositMargin(50_000e18);

        // Copy-trading: `trader` publishes a 3-leg long strategy (BTC first).
        usdc.mint(trader, 1_000e18);
        vm.startPrank(trader);
        usdc.approve(address(stake), type(uint256).max);
        stake.stake(1_000e18);
        registry.registerTrader("trader");
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 1);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
        registry.publishStrategy(a);
        vm.stopPrank();

        // Agent session for `user`.
        vm.prank(user);
        sessionId = sessions.createSession(agent, 10_000e18, 40_000e18, 5, block.timestamp + 30 days);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _open(address who, bytes32 asset, bool isLong, uint256 margin) internal returns (uint256) {
        vm.prank(who);
        return exchange.openPosition(asset, isLong, margin, 5);
    }

    function _openViaAgent(bytes32 asset) internal returns (uint256) {
        vm.prank(agent);
        return sessions.openPositionForSession(sessionId, asset, true, 1_000e18, 5, address(0));
    }

    function _follow() internal {
        vm.prank(follower);
        copyTracker.followTrader(trader, 1_000e18);
    }

    function _warpBy(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function _setMode(bytes32 asset, PerpetualExchange.AssetMode mode) internal {
        exchange.setAssetMode(asset, mode); // as owner
    }

    function _modeChangeError(bytes32 asset, PerpetualExchange.AssetMode cur, PerpetualExchange.AssetMode req, address by)
        internal pure returns (bytes memory)
    {
        return abi.encodeWithSelector(PerpetualExchange.AssetModeChangeNotAllowed.selector, asset, cur, req, by);
    }

    function _notActive(bytes32 asset, PerpetualExchange.AssetMode mode) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PerpetualExchange.AssetNotActive.selector, asset, mode);
    }

    function _halted(bytes32 asset) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PerpetualExchange.AssetHalted.selector, asset);
    }

    /// Opens a 5x long of 1,000 margin for `user` and drops BTC 20% so it is
    /// at or below maintenance margin (fees are zero in this fixture).
    function _underwaterLong() internal returns (uint256 id) {
        id = _open(user, BTC, true, 1_000e18);
        oracle.updatePrice(BTC, 80_000e8);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Role configuration
    // ═════════════════════════════════════════════════════════════════════════

    function test_setGuardian_ownerOnly_emits() public {
        address g2 = makeAddr("g2");
        vm.expectEmit(true, false, false, false, address(exchange));
        emit GuardianSet(g2);
        exchange.setGuardian(g2);
        assertEq(exchange.guardian(), g2);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        exchange.setGuardian(stranger);

        vm.prank(guardian); // the old guardian cannot appoint itself back
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        exchange.setGuardian(guardian);
    }

    function test_setMarketOperator_ownerOnly_emits() public {
        address o2 = makeAddr("o2");
        vm.expectEmit(true, false, false, false, address(exchange));
        emit MarketOperatorSet(o2);
        exchange.setMarketOperator(o2);
        assertEq(exchange.marketOperator(), o2);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        exchange.setMarketOperator(operator);
    }

    function test_clearedGuardian_losesPauseRight() public {
        exchange.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotGuardianOrOwner.selector, guardian));
        exchange.pause();
    }

    function test_defaults_everyAssetActive_notPaused() public view {
        assertFalse(exchange.paused());
        assertEq(uint8(exchange.assetMode(BTC)), uint8(ACTIVE));
        assertEq(uint8(exchange.assetMode(keccak256("NEVER_SEEN"))), uint8(ACTIVE));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // pause / unpause permissions
    // ═════════════════════════════════════════════════════════════════════════

    function test_pause_byGuardian_emits() public {
        vm.expectEmit(false, false, false, true, address(exchange));
        emit Paused(guardian);
        vm.prank(guardian);
        exchange.pause();
        assertTrue(exchange.paused());
    }

    function test_pause_byOwner() public {
        exchange.pause();
        assertTrue(exchange.paused());
    }

    function test_pause_refusesOperatorAndStranger() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotGuardianOrOwner.selector, operator));
        exchange.pause();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotGuardianOrOwner.selector, stranger));
        exchange.pause();
    }

    function test_pause_whenAlreadyPaused_reverts() public {
        exchange.pause();
        vm.prank(guardian);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.pause();
    }

    function test_unpause_ownerOnly_guardianCannot() public {
        vm.prank(guardian);
        exchange.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        exchange.unpause();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        exchange.unpause();

        vm.expectEmit(false, false, false, true, address(exchange));
        emit Unpaused(address(this));
        exchange.unpause();
        assertFalse(exchange.paused());
    }

    function test_unpause_whenNotPaused_reverts() public {
        vm.expectRevert(PerpetualExchange.ExpectedPause.selector);
        exchange.unpause();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // setAssetMode permission matrix — exhaustive over all 3×3 transitions
    // ═════════════════════════════════════════════════════════════════════════

    function _modeAt(uint256 i) internal pure returns (PerpetualExchange.AssetMode) {
        if (i == 0) return ACTIVE;
        if (i == 1) return REDUCE_ONLY;
        return HALTED;
    }

    function test_assetMode_ownerMaySetAnyTransition() public {
        for (uint256 c; c < 3; ++c) {
            for (uint256 n; n < 3; ++n) {
                _setMode(BTC, _modeAt(c));
                vm.expectEmit(true, true, false, true, address(exchange));
                emit AssetModeSet(BTC, _modeAt(n), address(this));
                exchange.setAssetMode(BTC, _modeAt(n));
                assertEq(uint8(exchange.assetMode(BTC)), n);
            }
        }
    }

    function test_assetMode_guardianMayOnlyTighten() public {
        for (uint256 c; c < 3; ++c) {
            for (uint256 n; n < 3; ++n) {
                _setMode(BTC, _modeAt(c));
                vm.prank(guardian);
                if (n > c) {
                    vm.expectEmit(true, true, false, true, address(exchange));
                    emit AssetModeSet(BTC, _modeAt(n), guardian);
                    exchange.setAssetMode(BTC, _modeAt(n));
                    assertEq(uint8(exchange.assetMode(BTC)), n);
                } else {
                    vm.expectRevert(_modeChangeError(BTC, _modeAt(c), _modeAt(n), guardian));
                    exchange.setAssetMode(BTC, _modeAt(n));
                    assertEq(uint8(exchange.assetMode(BTC)), c);
                }
            }
        }
    }

    function test_assetMode_operatorOnlyTogglesActiveAndReduceOnly() public {
        for (uint256 c; c < 3; ++c) {
            for (uint256 n; n < 3; ++n) {
                _setMode(BTC, _modeAt(c));
                bool allowed = _modeAt(c) != HALTED && _modeAt(n) != HALTED;
                vm.prank(operator);
                if (allowed) {
                    vm.expectEmit(true, true, false, true, address(exchange));
                    emit AssetModeSet(BTC, _modeAt(n), operator);
                    exchange.setAssetMode(BTC, _modeAt(n));
                    assertEq(uint8(exchange.assetMode(BTC)), n);
                } else {
                    vm.expectRevert(_modeChangeError(BTC, _modeAt(c), _modeAt(n), operator));
                    exchange.setAssetMode(BTC, _modeAt(n));
                    assertEq(uint8(exchange.assetMode(BTC)), c);
                }
            }
        }
    }

    function test_assetMode_strangerMaySetNothing() public {
        for (uint256 c; c < 3; ++c) {
            for (uint256 n; n < 3; ++n) {
                _setMode(BTC, _modeAt(c));
                vm.prank(stranger);
                vm.expectRevert(_modeChangeError(BTC, _modeAt(c), _modeAt(n), stranger));
                exchange.setAssetMode(BTC, _modeAt(n));
            }
        }
    }

    function test_assetMode_addressWithBothRolesGetsUnionOfRights() public {
        exchange.setMarketOperator(guardian);
        // operator right: loosen ReduceOnly -> Active
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(guardian);
        exchange.setAssetMode(BTC, ACTIVE);
        // guardian right: tighten to Halted
        vm.prank(guardian);
        exchange.setAssetMode(BTC, HALTED);
        // neither role may lift a Halt
        vm.prank(guardian);
        vm.expectRevert(_modeChangeError(BTC, HALTED, REDUCE_ONLY, guardian));
        exchange.setAssetMode(BTC, REDUCE_ONLY);
    }

    function test_assetMode_isPerAsset() public {
        _setMode(BTC, HALTED);
        assertEq(uint8(exchange.assetMode(ETH)), uint8(ACTIVE));
        _open(user, ETH, true, 1_000e18); // unaffected market keeps trading
    }

    function test_assetMode_guardianCanTightenWhilePaused() public {
        exchange.pause();
        vm.prank(guardian);
        exchange.setAssetMode(BTC, HALTED);
        assertEq(uint8(exchange.assetMode(BTC)), uint8(HALTED));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Global pause — every value-moving entry point reverts
    // ═════════════════════════════════════════════════════════════════════════

    /// Deposits only move value in, so they stay open during a pause and let
    /// traders top up before trading and liquidation resume.
    function test_paused_depositMargin_allowed() public {
        exchange.pause();
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.depositMargin(1e18);
        assertEq(exchange.freeMargin(user), before + 1e18);
    }

    function test_paused_withdrawMargin_reverts() public {
        exchange.pause();
        vm.prank(user);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.withdrawMargin(1e18);
    }

    /// Like depositMargin, the agent deposit path only moves value in and
    /// stays open during a pause.
    function test_paused_depositMarginFor_allowed() public {
        exchange.pause();
        usdc.mint(address(sessions), 1_000e18);
        vm.startPrank(address(sessions));
        usdc.approve(address(exchange), 1_000e18);
        uint256 before = exchange.freeMargin(user);
        exchange.depositMarginFor(user, 1_000e18);
        vm.stopPrank();
        assertEq(exchange.freeMargin(user), before + 1_000e18);
    }

    /// A follow still reverts as a whole during a pause: its opens do.
    function test_paused_copyFollow_reverts() public {
        exchange.pause();
        vm.prank(follower);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        copyTracker.followTrader(trader, 1_000e18);
    }

    function test_paused_openPosition_reverts() public {
        exchange.pause();
        vm.prank(user);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.openPosition(BTC, true, 1_000e18, 5);
    }

    function test_paused_openPositionFor_agent_reverts() public {
        exchange.pause();
        vm.prank(agent);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        sessions.openPositionForSession(sessionId, BTC, true, 1_000e18, 5, address(0));
    }

    function test_paused_openPositionFor_direct_reverts() public {
        exchange.pause();
        vm.prank(address(sessions));
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.openPositionFor(user, BTC, true, 1_000e18, 5, address(0));
    }

    function test_paused_closePosition_reverts() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.pause();
        vm.prank(user);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.closePosition(id);
    }

    function test_paused_closePositionFor_agent_reverts() public {
        uint256 id = _openViaAgent(BTC);
        exchange.pause();
        vm.prank(agent);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        sessions.closePositionForSession(sessionId, id);
    }

    function test_paused_liquidatePosition_reverts() public {
        uint256 id = _underwaterLong();
        exchange.pause();
        vm.prank(liquidator);
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.liquidatePosition(id);
    }

    function test_paused_settleFunding_reverts() public {
        _open(user, BTC, true, 2_000e18);
        _open(other, BTC, false, 1_000e18);
        _warpBy(8 hours);
        exchange.pause();
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.settleFunding(BTC);
    }

    function test_paused_withdrawExecutionFees_reverts() public {
        vm.deal(address(exchange), 1 ether);
        exchange.pause();
        vm.expectRevert(PerpetualExchange.EnforcedPause.selector);
        exchange.withdrawExecutionFees();
    }

    /// Unfollow cannot close while paused; the copied position is still open,
    /// so the record stays active and the trader is NOT slashed for an outage.
    function test_paused_unfollow_revertsWithoutSlashing() public {
        _follow();
        uint256 stakeBefore = stake.stakedAmount(trader);
        uint256 id = copyTracker.getCopyRecords(follower)[0].positionIds[0];
        exchange.pause();

        vm.prank(follower);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, id));
        copyTracker.unfollowAndCloseAll(0);

        assertEq(stake.stakedAmount(trader), stakeBefore);
        assertTrue(copyTracker.getCopyRecords(follower)[0].active);
        assertTrue(exchange.getPosition(id).isOpen);

        exchange.unpause();
        vm.prank(follower);
        copyTracker.unfollowAndCloseAll(0);
        assertFalse(exchange.getPosition(id).isOpen);
        assertEq(stake.stakedAmount(trader), stakeBefore); // flat market -> no slash
    }

    function test_paused_ownerSettersAndViewsStillWork() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.pause();

        exchange.setTradingFeeBps(20);
        exchange.setMaxLeverageFor(BTC, 3);
        exchange.setMaintenanceMarginFor(BTC, 600);
        exchange.setMaxPriceAge(1 hours);
        exchange.setAdlEnabled(true);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        assertEq(exchange.TRADING_FEE_BPS(), 20);

        assertGt(exchange.getPositionValue(id), 0);
        assertEq(exchange.getUnrealizedPnL(id), 0);
        assertEq(exchange.getMarkPrice(BTC), 100_000e18);
        exchange.getFundingRate(BTC);
        exchange.pendingFunding(id);
        assertEq(exchange.freeMargin(user), 49_000e18);
    }

    function test_unpause_restoresEveryPath() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        exchange.pause();
        exchange.unpause();

        vm.prank(user);
        exchange.closePosition(id);       // closes work inside the grace period
        vm.prank(user);
        exchange.depositMargin(1_000e18); // so do deposits
        _warpBy(exchange.LIQUIDATION_GRACE_PERIOD());
        vm.prank(user);
        exchange.withdrawMargin(1_000e18);
        _open(user, BTC, false, 1_000e18);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ReduceOnly — no new exposure on any path; exits and liquidations run
    // ═════════════════════════════════════════════════════════════════════════

    function test_reduceOnly_openPosition_reverts() public {
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(user);
        vm.expectRevert(_notActive(BTC, REDUCE_ONLY));
        exchange.openPosition(BTC, true, 1_000e18, 5);
        // either direction — no side of the book may grow
        vm.prank(user);
        vm.expectRevert(_notActive(BTC, REDUCE_ONLY));
        exchange.openPosition(BTC, false, 1_000e18, 5);
    }

    function test_reduceOnly_addingToExistingExposure_reverts() public {
        _open(user, BTC, true, 1_000e18);
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(user);
        vm.expectRevert(_notActive(BTC, REDUCE_ONLY));
        exchange.openPosition(BTC, true, 1_000e18, 5);
    }

    function test_reduceOnly_agentOpen_reverts() public {
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(agent);
        vm.expectRevert(_notActive(BTC, REDUCE_ONLY));
        sessions.openPositionForSession(sessionId, BTC, true, 1_000e18, 5, address(0));
    }

    function test_reduceOnly_copyFollow_reverts() public {
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(follower);
        vm.expectRevert(_notActive(BTC, REDUCE_ONLY));
        copyTracker.followTrader(trader, 1_000e18);
    }

    function test_reduceOnly_closePosition_succeeds() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(user);
        exchange.closePosition(id);
        assertFalse(exchange.getPosition(id).isOpen);
    }

    function test_reduceOnly_agentClose_succeeds() public {
        uint256 id = _openViaAgent(BTC);
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(agent);
        sessions.closePositionForSession(sessionId, id);
        assertFalse(exchange.getPosition(id).isOpen);
    }

    function test_reduceOnly_unfollow_succeeds() public {
        _follow();
        uint256 id = copyTracker.getCopyRecords(follower)[0].positionIds[0];
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(follower);
        copyTracker.unfollowAndCloseAll(0);
        assertFalse(exchange.getPosition(id).isOpen);
        assertFalse(copyTracker.getCopyRecords(follower)[0].active);
    }

    function test_reduceOnly_liquidation_succeeds() public {
        uint256 id = _underwaterLong();
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(liquidator);
        exchange.liquidatePosition(id);
        assertFalse(exchange.getPosition(id).isOpen);
    }

    /// A bankrupt liquidation in a ReduceOnly market still reaches ADL, which
    /// only ever reduces (force-closes) the profitable opposite side.
    function test_reduceOnly_liquidationWithAdl_succeeds() public {
        exchange.setAdlEnabled(true);
        uint256 loser  = _open(user, BTC, true, 1_000e18);
        uint256 winner = _open(other, BTC, false, 1_000e18);
        oracle.updatePrice(BTC, 70_000e8); // long: -1,500 on 1,000 margin
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(liquidator);
        exchange.liquidatePosition(loser);
        assertFalse(exchange.getPosition(loser).isOpen);
        assertFalse(exchange.getPosition(winner).isOpen); // deleveraged
    }

    /// Market-closed flow: the keeper refreshes the timestamp at the closing
    /// price, so exits settle at the close.
    function test_reduceOnly_closeSettlesAtRefreshedClosingPrice() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        oracle.updatePrice(BTC, 110_000e8); // closing print
        _setMode(BTC, REDUCE_ONLY);
        _warpBy(20 hours);
        oracle.updatePrice(BTC, 110_000e8); // keeper heartbeat, price unchanged
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.closePosition(id);
        // 5x on +10% = +500 on 1,000 margin; no fees in this fixture
        assertEq(exchange.freeMargin(user) - before, 1_500e18);
    }

    function test_reduceOnly_priceFreshnessStillEnforced() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _setMode(BTC, REDUCE_ONLY);
        (, uint256 updatedAt) = oracle.getPrice(BTC);
        _warpBy(exchange.maxPriceAge() + 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.StalePrice.selector, BTC, updatedAt));
        exchange.closePosition(id);
    }

    function test_reduceOnly_settleFunding_succeeds() public {
        _open(user, BTC, true, 2_000e18);
        _open(other, BTC, false, 1_000e18);
        _setMode(BTC, REDUCE_ONLY);
        _warpBy(8 hours);
        exchange.settleFunding(BTC);
        assertGt(exchange.cumulativeFundingIndexLong(BTC), 0);
    }

    function test_reduceOnly_marginMovementUnaffected() public {
        _setMode(BTC, REDUCE_ONLY);
        vm.prank(user);
        exchange.withdrawMargin(1_000e18);
        vm.prank(user);
        exchange.depositMargin(1_000e18);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Halted — the asset is frozen
    // ═════════════════════════════════════════════════════════════════════════

    function test_halted_openPosition_reverts() public {
        _setMode(BTC, HALTED);
        vm.prank(user);
        vm.expectRevert(_notActive(BTC, HALTED));
        exchange.openPosition(BTC, true, 1_000e18, 5);
    }

    function test_halted_agentOpen_reverts() public {
        _setMode(BTC, HALTED);
        vm.prank(agent);
        vm.expectRevert(_notActive(BTC, HALTED));
        sessions.openPositionForSession(sessionId, BTC, true, 1_000e18, 5, address(0));
    }

    function test_halted_copyFollow_reverts() public {
        _setMode(BTC, HALTED);
        vm.prank(follower);
        vm.expectRevert(_notActive(BTC, HALTED));
        copyTracker.followTrader(trader, 1_000e18);
    }

    function test_halted_closePosition_reverts() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _setMode(BTC, HALTED);
        vm.prank(user);
        vm.expectRevert(_halted(BTC));
        exchange.closePosition(id);
    }

    function test_halted_agentClose_reverts() public {
        uint256 id = _openViaAgent(BTC);
        _setMode(BTC, HALTED);
        vm.prank(agent);
        vm.expectRevert(_halted(BTC));
        sessions.closePositionForSession(sessionId, id);
    }

    function test_halted_unfollow_revertsWithoutSlashing() public {
        _follow();
        uint256 id = copyTracker.getCopyRecords(follower)[0].positionIds[0];
        uint256 stakeBefore = stake.stakedAmount(trader);
        _setMode(BTC, HALTED);

        vm.prank(follower);
        vm.expectRevert(abi.encodeWithSelector(CopyTracker.PositionStillOpen.selector, id));
        copyTracker.unfollowAndCloseAll(0);
        assertEq(stake.stakedAmount(trader), stakeBefore);
        assertTrue(copyTracker.getCopyRecords(follower)[0].active);
    }

    function test_halted_liquidation_reverts() public {
        uint256 id = _underwaterLong();
        _setMode(BTC, HALTED);
        vm.prank(liquidator);
        vm.expectRevert(_halted(BTC));
        exchange.liquidatePosition(id);
    }

    function test_halted_settleFunding_reverts() public {
        _open(user, BTC, true, 2_000e18);
        _open(other, BTC, false, 1_000e18);
        _setMode(BTC, HALTED);
        _warpBy(8 hours);
        vm.expectRevert(_halted(BTC));
        exchange.settleFunding(BTC);
    }

    function test_halted_otherAssetsAndMarginUnaffected() public {
        uint256 btcId = _open(user, BTC, true, 1_000e18);
        uint256 ethId = _open(user, ETH, true, 1_000e18);
        _setMode(BTC, HALTED);

        vm.prank(user);
        exchange.closePosition(ethId);
        _open(user, ETH, false, 1_000e18);
        vm.prank(user);
        exchange.withdrawMargin(1_000e18);
        vm.prank(user);
        exchange.depositMargin(1_000e18);
        assertTrue(exchange.getPosition(btcId).isOpen);
    }

    function test_halted_liftedByOwner_restoresTrading() public {
        uint256 id = _open(user, BTC, true, 1_000e18);
        _setMode(BTC, HALTED);
        _setMode(BTC, ACTIVE);
        vm.prank(user);
        exchange.closePosition(id);
        _warpBy(exchange.LIQUIDATION_GRACE_PERIOD()); // opens wait out the grace period
        _open(user, BTC, true, 1_000e18);
    }

    /// The halted window accrues no funding for either side: entering Halted
    /// settles up to now, leaving it restarts the clock.
    function test_halted_windowAccruesNoFunding() public {
        _open(user, BTC, true, 2_000e18);   // longs crowded -> longs pay
        _open(other, BTC, false, 1_000e18);
        // Under via-IR the optimizer may re-read `block.timestamp` wherever a
        // local derived from it is used, so warps go through the cheatcode.
        _warpBy(8 hours);
        vm.prank(guardian);
        exchange.setAssetMode(BTC, HALTED); // settles the one elapsed interval
        int256 longAtHalt  = exchange.cumulativeFundingIndexLong(BTC);
        int256 shortAtHalt = exchange.cumulativeFundingIndexShort(BTC);
        assertGt(longAtHalt, 0);

        _warpBy(10 days);
        _setMode(BTC, ACTIVE);
        assertEq(exchange.lastFundingUpdateAt(BTC), vm.getBlockTimestamp());

        vm.expectRevert(PerpetualExchange.FundingIntervalNotElapsed.selector);
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), longAtHalt);
        assertEq(exchange.cumulativeFundingIndexShort(BTC), shortAtHalt);

        // Exactly one interval after the resume, exactly one interval accrues.
        _warpBy(8 hours);
        exchange.settleFunding(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), 2 * longAtHalt);
    }

    /// Moving between Active and ReduceOnly never touches funding.
    function test_reduceOnlyToggle_doesNotTouchFundingClock() public {
        _open(user, BTC, true, 2_000e18);
        _open(other, BTC, false, 1_000e18);
        uint256 clock = exchange.lastFundingUpdateAt(BTC);
        _warpBy(20 hours);
        vm.prank(operator);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        vm.prank(operator);
        exchange.setAssetMode(BTC, ACTIVE);
        assertEq(exchange.lastFundingUpdateAt(BTC), clock);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Guardian lock — the operator cannot undo an emergency restriction
    // ═════════════════════════════════════════════════════════════════════════

    event AssetGuardianLockSet(bytes32 indexed asset, bool locked);

    function test_guardianLock_operatorCannotLoosenGuardianReduceOnly() public {
        vm.expectEmit(true, false, false, true, address(exchange));
        emit AssetGuardianLockSet(BTC, true);
        vm.prank(guardian);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        assertTrue(exchange.guardianLocked(BTC));

        vm.prank(operator);
        vm.expectRevert(_modeChangeError(BTC, REDUCE_ONLY, ACTIVE, operator));
        exchange.setAssetMode(BTC, ACTIVE);
        assertEq(uint8(exchange.assetMode(BTC)), uint8(REDUCE_ONLY));

        vm.prank(operator); // idempotent / non-loosening sets are still fine
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        assertTrue(exchange.guardianLocked(BTC));
    }

    function test_guardianLock_ownerSetClearsLock() public {
        vm.prank(guardian);
        exchange.setAssetMode(BTC, REDUCE_ONLY);

        vm.expectEmit(true, false, false, true, address(exchange));
        emit AssetGuardianLockSet(BTC, false);
        exchange.setAssetMode(BTC, ACTIVE);
        assertFalse(exchange.guardianLocked(BTC));

        vm.prank(operator); // operator regains its normal toggle
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        vm.prank(operator);
        exchange.setAssetMode(BTC, ACTIVE);
    }

    function test_guardianLock_ownerSetWithSameModeAlsoClears() public {
        vm.prank(guardian);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        assertFalse(exchange.guardianLocked(BTC));
    }

    function test_guardianLock_operatorTighteningDoesNotLock() public {
        vm.prank(operator);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        assertFalse(exchange.guardianLocked(BTC));
        vm.prank(operator);
        exchange.setAssetMode(BTC, ACTIVE);
    }

    function test_guardianLock_isPerAsset() public {
        vm.prank(guardian);
        exchange.setAssetMode(BTC, REDUCE_ONLY);
        vm.prank(operator);
        exchange.setAssetMode(ETH, REDUCE_ONLY);
        vm.prank(operator);
        exchange.setAssetMode(ETH, ACTIVE);
        assertFalse(exchange.guardianLocked(ETH));
    }

    function test_guardianLock_dualRoleAddressCannotLoosenItsOwnLock() public {
        exchange.setMarketOperator(guardian);
        vm.prank(guardian);
        exchange.setAssetMode(BTC, REDUCE_ONLY); // guardian right -> locks
        vm.prank(guardian);
        vm.expectRevert(_modeChangeError(BTC, REDUCE_ONLY, ACTIVE, guardian));
        exchange.setAssetMode(BTC, ACTIVE);
    }
}
