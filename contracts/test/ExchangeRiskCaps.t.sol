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

/// @notice P1: per-asset long/short open-interest caps and the single-position
///         profit cap — bounds, every open path, and how the cap feeds close,
///         liquidation, ADL, portfolio equity and the views.
contract ExchangeRiskCapsTest is Test {
    PerpetualExchange   exchange;
    MockUSDC            usdc;
    MockOracle          oracle;
    TraderStake         stake;
    StrategyRegistry    registry;
    CopyTracker         copyTracker;
    AgentSessionManager sessions;

    address user     = makeAddr("user");
    address other    = makeAddr("other");
    address agent    = makeAddr("agent");
    address trader   = makeAddr("trader");
    address follower = makeAddr("follower");
    address stranger = makeAddr("stranger");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    event MaxOpenInterestSet(bytes32 indexed asset, uint256 maxLong, uint256 maxShort);
    event MaxProfitBpsSet(bytes32 indexed asset, uint256 bps);
    event ProfitCapped(uint256 indexed positionId, int256 rawPnl, int256 paidPnl);
    event BadDebt(uint256 indexed positionId, bytes32 indexed asset, uint256 amount);

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

        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 200e8);

        usdc.mint(address(exchange), 1_000_000e18);
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

        vm.prank(user);
        sessionId = sessions.createSession(agent, 10_000e18, 40_000e18, 5, block.timestamp + 30 days);
    }

    function _open(address who, bytes32 asset, bool isLong, uint256 margin, uint256 lev) internal returns (uint256) {
        vm.prank(who);
        return exchange.openPosition(asset, isLong, margin, lev);
    }

    function _oiError(bytes32 asset, bool isLong, uint256 resulting, uint256 cap) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PerpetualExchange.OpenInterestCapExceeded.selector, asset, isLong, resulting, cap);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Open-interest caps
    // ═════════════════════════════════════════════════════════════════════════

    function test_setMaxOpenInterest_ownerOnly_emits() public {
        vm.expectEmit(true, false, false, true, address(exchange));
        emit MaxOpenInterestSet(BTC, 10_000e18, 20_000e18);
        exchange.setMaxOpenInterest(BTC, 10_000e18, 20_000e18);
        assertEq(exchange.maxLongOI(BTC), 10_000e18);
        assertEq(exchange.maxShortOI(BTC), 20_000e18);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        exchange.setMaxOpenInterest(BTC, 0, 0);
    }

    function test_oiCap_defaultZeroIsUnlimited() public {
        assertEq(exchange.maxLongOI(BTC), 0);
        _open(user, BTC, true, 10_000e18, 5); // 50,000 notional, no cap
        assertEq(exchange.globalLongNotional(BTC), 50_000e18);
    }

    function test_oiCap_openUpToCapExactly_succeeds() public {
        exchange.setMaxOpenInterest(BTC, 10_000e18, 0);
        _open(user, BTC, true, 1_000e18, 5);
        _open(user, BTC, true, 1_000e18, 5);
        assertEq(exchange.globalLongNotional(BTC), 10_000e18);
    }

    function test_oiCap_openAboveCap_reverts() public {
        exchange.setMaxOpenInterest(BTC, 10_000e18, 0);
        _open(user, BTC, true, 1_000e18, 5);
        vm.prank(user);
        vm.expectRevert(_oiError(BTC, true, 10_005e18, 10_000e18));
        exchange.openPosition(BTC, true, 1_001e18, 5);
    }

    function test_oiCap_sidesAreIndependent() public {
        exchange.setMaxOpenInterest(BTC, 5_000e18, 1_000e18);
        _open(user, BTC, true, 1_000e18, 5); // long at cap
        _open(user, BTC, false, 1_000e18, 1); // short at cap
        vm.prank(user);
        vm.expectRevert(_oiError(BTC, true, 5_050e18, 5_000e18));
        exchange.openPosition(BTC, true, 10e18, 5);
        vm.prank(user);
        vm.expectRevert(_oiError(BTC, false, 1_010e18, 1_000e18));
        exchange.openPosition(BTC, false, 10e18, 1);
    }

    function test_oiCap_isPerAsset() public {
        exchange.setMaxOpenInterest(BTC, 1_000e18, 1_000e18);
        _open(user, ETH, true, 10_000e18, 5);
    }

    function test_oiCap_closingFreesCapacity() public {
        exchange.setMaxOpenInterest(BTC, 5_000e18, 0);
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        vm.prank(user);
        exchange.closePosition(id);
        _open(other, BTC, true, 1_000e18, 5);
    }

    function test_oiCap_loweredBelowCurrentOI_blocksOpensOnly() public {
        uint256 id = _open(user, BTC, true, 2_000e18, 5); // 10,000 OI
        exchange.setMaxOpenInterest(BTC, 5_000e18, 0);
        assertTrue(exchange.getPosition(id).isOpen); // nothing force-closed
        vm.prank(user);
        vm.expectRevert(_oiError(BTC, true, 10_050e18, 5_000e18));
        exchange.openPosition(BTC, true, 10e18, 5);
        vm.prank(user);
        exchange.closePosition(id); // exits always allowed
    }

    function test_oiCap_agentPath_reverts() public {
        exchange.setMaxOpenInterest(BTC, 1_000e18, 0);
        vm.prank(agent);
        vm.expectRevert(_oiError(BTC, true, 5_000e18, 1_000e18));
        sessions.openPositionForSession(sessionId, BTC, true, 1_000e18, 5, address(0));
    }

    function test_oiCap_copyPath_reverts() public {
        exchange.setMaxOpenInterest(ETH, 100e18, 0); // follow puts 300 on ETH at 1x
        vm.prank(follower);
        vm.expectRevert(_oiError(ETH, true, 300e18, 100e18));
        copyTracker.followTrader(trader, 1_000e18);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Profit cap — configuration
    // ═════════════════════════════════════════════════════════════════════════

    function test_setMaxProfitBps_ownerOnly_emits() public {
        vm.expectEmit(true, false, false, true, address(exchange));
        emit MaxProfitBpsSet(BTC, 50_000);
        exchange.setMaxProfitBps(BTC, 50_000);
        assertEq(exchange.maxProfitBps(BTC), 50_000);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        exchange.setMaxProfitBps(BTC, 50_000);
    }

    function test_setMaxProfitBps_bounds() public {
        uint256 lo = exchange.MIN_PROFIT_CAP_BPS();
        uint256 hi = exchange.MAX_PROFIT_CAP_BPS();
        exchange.setMaxProfitBps(BTC, lo);
        exchange.setMaxProfitBps(BTC, hi);
        exchange.setMaxProfitBps(BTC, 0); // off

        vm.expectRevert(bytes("profit cap out of range"));
        exchange.setMaxProfitBps(BTC, lo - 1);
        vm.expectRevert(bytes("profit cap out of range"));
        exchange.setMaxProfitBps(BTC, hi + 1);
        vm.expectRevert(bytes("profit cap out of range"));
        exchange.setMaxProfitBps(BTC, 1);
    }

    function testFuzz_setMaxProfitBps_acceptsExactlyTheDocumentedRange(uint256 bps) public {
        bool ok = bps == 0 || (bps >= exchange.MIN_PROFIT_CAP_BPS() && bps <= exchange.MAX_PROFIT_CAP_BPS());
        if (!ok) vm.expectRevert(bytes("profit cap out of range"));
        exchange.setMaxProfitBps(BTC, bps);
        if (ok) assertEq(exchange.maxProfitBps(BTC), bps);
    }

    function test_profitCap_frozenAtOpen() public {
        exchange.setMaxProfitBps(BTC, 10_000);
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        assertEq(exchange.profitCapOf(id), 1_000e18);

        exchange.setMaxProfitBps(BTC, 0); // later change is not retroactive
        assertEq(exchange.profitCapOf(id), 1_000e18);
        uint256 later = _open(user, BTC, true, 1_000e18, 5);
        assertEq(exchange.profitCapOf(later), 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Profit cap — settlement
    // ═════════════════════════════════════════════════════════════════════════

    function test_profitCap_closeClampsProfit_emits() public {
        exchange.setMaxProfitBps(BTC, 10_000); // 100% of margin
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 150_000e8); // raw +2,500

        uint256 before = exchange.freeMargin(user);
        vm.expectEmit(true, false, false, true, address(exchange));
        emit ProfitCapped(id, 2_500e18, 1_000e18);
        vm.prank(user);
        exchange.closePosition(id);

        assertEq(exchange.freeMargin(user) - before, 2_000e18); // margin + cap
        assertEq(exchange.getPosition(id).realizedPnL, 1_000e18);
    }

    function test_profitCap_profitBelowCap_untouched() public {
        exchange.setMaxProfitBps(BTC, 50_000);
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 110_000e8); // +500 < 5,000 cap
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.closePosition(id);
        assertEq(exchange.freeMargin(user) - before, 1_500e18);
    }

    function test_profitCap_lossesUntouched() public {
        exchange.setMaxProfitBps(BTC, 10_000);
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 90_000e8); // -500
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.closePosition(id);
        assertEq(exchange.freeMargin(user) - before, 500e18);
    }

    function test_profitCap_shortSideClamped() public {
        exchange.setMaxProfitBps(BTC, 10_000);
        uint256 id = _open(user, BTC, false, 1_000e18, 5);
        oracle.updatePrice(BTC, 50_000e8); // short raw +2,500
        uint256 before = exchange.freeMargin(user);
        vm.prank(user);
        exchange.closePosition(id);
        assertEq(exchange.freeMargin(user) - before, 2_000e18);
    }

    function test_profitCap_viewsReportCappedValue() public {
        exchange.setMaxProfitBps(BTC, 10_000);
        uint256 id = _open(user, BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 150_000e8);
        assertEq(exchange.getUnrealizedPnL(id), 1_000e18);
        assertEq(exchange.getPositionValue(id), 2_000e18);
    }

    /// Portfolio equity counts only the capped profit, so profit the exchange
    /// will never pay cannot shield another leg from liquidation.
    function test_profitCap_portfolioEquityCountsOnlyCappedProfit() public {
        exchange.setPortfolioMarginEnabled(true);
        exchange.setMaxProfitBps(ETH, 10_000);
        _open(user, ETH, true, 1_000e18, 5);                   // cap 1,000
        uint256 loser = _open(user, BTC, true, 5_000e18, 5);   // 25,000 notional
        uint256 rest = exchange.freeMargin(user);
        vm.prank(user);
        exchange.withdrawMargin(rest);

        oracle.updatePrice(ETH, 8_000e8);  // winner raw +5,000, capped +1,000
        oracle.updatePrice(BTC, 81_000e8); // loser -4,750
        (int256 eq, uint256 mm, bool healthy) = exchange.getAccountHealth(user);
        assertEq(eq, int256(2_000e18 + 250e18)); // raw profit would have said 6,250
        assertEq(mm, 250e18 + 1_250e18);
        assertTrue(healthy);

        // Loser -5,750: capped equity 1,250 < 1,500 maintenance. With the raw
        // +5,000 the account would still read 5,250 and shield the leg.
        oracle.updatePrice(BTC, 77_000e8);
        (eq, , healthy) = exchange.getAccountHealth(user);
        assertEq(eq, int256(1_250e18));
        assertFalse(healthy);
        exchange.liquidatePosition(loser);
        assertFalse(exchange.getPosition(loser).isOpen);
    }

    /// ADL haircuts the capped profit: the counterparty is paid margin + cap −
    /// haircut, and whatever the capped profit cannot absorb is BadDebt rather
    /// than being "covered" by profit that was never owed.
    function test_profitCap_adlHaircutsCappedProfitOnly() public {
        exchange.setAdlEnabled(true);
        exchange.setMaxProfitBps(BTC, 10_000);
        uint256 loser  = _open(user, BTC, true, 1_000e18, 5);  // cap 1,000
        uint256 winner = _open(other, BTC, false, 200e18, 5);  // cap 200
        oracle.updatePrice(BTC, 60_000e8); // long -2,000 (shortfall 1,000); short raw +400, capped +200

        uint256 before = exchange.freeMargin(other);
        vm.expectEmit(true, true, true, true, address(exchange));
        emit BadDebt(loser, BTC, 800e18);
        exchange.liquidatePosition(loser);

        assertFalse(exchange.getPosition(winner).isOpen);
        // haircut = all 200 of capped profit; payout = margin 200 + 200 - 200
        assertEq(exchange.freeMargin(other) - before, 200e18);
        assertEq(exchange.getPosition(winner).realizedPnL, 0);
    }

    function test_profitCap_copyPathPositionsAreCapped() public {
        exchange.setMaxProfitBps(BTC, 10_000);
        vm.prank(follower);
        copyTracker.followTrader(trader, 1_000e18);
        uint256 id = copyTracker.getCopyRecords(follower)[0].positionIds[0]; // BTC 500 @1x
        assertEq(exchange.profitCapOf(id), 500e18);
        oracle.updatePrice(BTC, 300_000e8); // raw +1,000 on 500 margin
        assertEq(exchange.getUnrealizedPnL(id), 500e18);
    }
}
