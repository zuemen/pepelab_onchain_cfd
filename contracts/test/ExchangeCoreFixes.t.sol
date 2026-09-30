// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/PerpetualExchangeLens.sol";
import "../src/CopyTracker.sol";
import "../src/AgentSessionManager.sol";
import "../src/StrategyRegistry.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Oracle double that, unlike MockOracle, can report a fresh zero price.
contract SettableOracle {
    mapping(bytes32 => uint256) internal _price;
    mapping(bytes32 => uint256) internal _at;

    function set(bytes32 asset, uint256 price) external {
        _price[asset] = price;
        _at[asset]    = block.timestamp;
    }

    function getPrice(bytes32 asset) external view returns (uint256, uint256) {
        return (_price[asset], _at[asset]);
    }
}

/// @notice P1 core fixes: isolated-margin settlement semantics, copiedFrom
///         attribution (M1), the mark-premium cap bound (M4) and zero-price
///         settlement (M8). (The H3 portfolio-margin cases went with the mode.)
contract ExchangeCoreFixesTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address carol = makeAddr("carol");
    address liquidator = makeAddr("liquidator");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    bytes32 constant SOL = keccak256("SOL");

    event BadDebt(uint256 indexed positionId, bytes32 indexed asset, uint256 amount);

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);
        oracle.addAsset(SOL, 200e8);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        usdc.mint(address(exchange), 1_000_000e18);
        usdc.mint(carol, 100_000e18);
        vm.prank(carol);
        usdc.approve(address(exchange), type(uint256).max);
    }

    function _deposit(uint256 a) internal {
        vm.prank(carol);
        exchange.depositMargin(a);
    }

    function _long(uint256 margin) internal returns (uint256) {
        vm.prank(carol);
        return exchange.openPosition(BTC, true, margin, 5);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Isolated margin: free margin backs nothing, a shortfall never touches it
    // (portfolio margin was removed; these pin the isolated semantics)
    // ═════════════════════════════════════════════════════════════════════════

    function test_isolated_withdrawUnchanged() public {
        _deposit(10_000e18);
        _long(1_000e18);
        oracle.updatePrice(BTC, 70_000e8);
        vm.prank(carol);
        exchange.withdrawMargin(9_000e18); // free margin backs nothing here
        assertEq(exchange.freeMargin(carol), 0);
    }

    function test_isolated_closeShortfallDoesNotTouchFreeMargin() public {
        _deposit(10_000e18);
        uint256 id = _long(1_000e18);
        oracle.updatePrice(BTC, 70_000e8);

        vm.expectEmit(true, true, false, true, address(exchange));
        emit BadDebt(id, BTC, 500e18);
        vm.prank(carol);
        exchange.closePosition(id);
        assertEq(exchange.freeMargin(carol), 9_000e18);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // M1 — only the CopyTracker may attribute a position (copiedFrom)
    // ═════════════════════════════════════════════════════════════════════════

    function _copyFixture()
        internal
        returns (CopyTracker ct, AgentSessionManager sm, FeeRouter fr, TraderStake ts)
    {
        ts = new TraderStake(address(usdc));
        StrategyRegistry reg = new StrategyRegistry(address(ts));
        ct = new CopyTracker(address(usdc), address(exchange), address(reg), address(0), address(ts));
        ts.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        InsuranceVault iv = new InsuranceVault(address(usdc));
        fr = new FeeRouter(address(usdc), address(this), address(iv));
        iv.setFeeRouter(address(fr));
        fr.setExchange(address(exchange));
        exchange.setFeeRouter(address(fr));
        sm = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sm), true);

        address trader = makeAddr("trader");
        usdc.mint(trader, 1_000e18);
        vm.startPrank(trader);
        usdc.approve(address(ts), type(uint256).max);
        ts.stake(1_000e18);
        reg.registerTrader("trader");
        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation(BTC, 5_000, true, 1);
        a[1] = StrategyRegistry.Allocation(ETH, 3_000, true, 1);
        a[2] = StrategyRegistry.Allocation(SOL, 2_000, true, 1);
        reg.publishStrategy(a);
        vm.stopPrank();
    }

    function test_sessionAgent_cannotAttributePositionToItself() public {
        (, AgentSessionManager sm, FeeRouter fr, ) = _copyFixture();
        address agent = makeAddr("agent");
        _deposit(10_000e18);
        vm.prank(carol);
        uint256 sid = sm.createSession(agent, 1_000e18, 1_000e18, 5, block.timestamp + 1 days);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.CopiedFromNotAllowed.selector, address(sm)));
        sm.openPositionForSession(sid, BTC, true, 1_000e18, 5, agent);

        // Unattributed session trading is unaffected, and pays no one a fee.
        vm.prank(agent);
        uint256 pid = sm.openPositionForSession(sid, BTC, true, 1_000e18, 5, address(0));
        oracle.updatePrice(BTC, 110_000e8);
        vm.prank(agent);
        sm.closePositionForSession(sid, pid);
        assertEq(fr.traderEarnings(agent), 0);
    }

    function test_authorizedAgent_cannotSetCopiedFrom() public {
        _copyFixture();
        address bot = makeAddr("bot");
        exchange.setAgentAuthorized(bot, true);
        _deposit(10_000e18);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.CopiedFromNotAllowed.selector, bot));
        exchange.openPositionFor(carol, BTC, true, 1_000e18, 5, bot);
    }

    function test_copyTracker_attributesToFollowedTrader() public {
        (CopyTracker ct, , , ) = _copyFixture();
        vm.prank(carol);
        usdc.approve(address(ct), type(uint256).max);
        vm.prank(carol);
        ct.followTrader(makeAddr("trader"), 1_000e18);
        uint256 id = ct.getCopyRecords(carol)[0].positionIds[0];
        assertEq(exchange.getPosition(id).copiedFrom, makeAddr("trader"));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // M4 — mark-premium cap is bounded
    // ═════════════════════════════════════════════════════════════════════════

    function test_setMarkPremiumCapBps_bounded() public {
        uint256 max = exchange.MAX_MARK_PREMIUM_CAP_BPS();
        assertEq(max, 200);
        exchange.setMarkPremiumCapBps(max);
        assertEq(exchange.markPremiumCapBps(), max);
        vm.expectRevert(PerpetualExchange.ParamOutOfRange.selector);
        exchange.setMarkPremiumCapBps(max + 1);
        vm.expectRevert(PerpetualExchange.ParamOutOfRange.selector);
        exchange.setMarkPremiumCapBps(1_000); // the previous ceiling is now refused
        assertEq(exchange.markPremiumCapBps(), max);
    }

    function testFuzz_setMarkPremiumCapBps_neverAboveCeiling(uint256 bps) public {
        if (bps > exchange.MAX_MARK_PREMIUM_CAP_BPS()) {
            vm.expectRevert(PerpetualExchange.ParamOutOfRange.selector);
            exchange.setMarkPremiumCapBps(bps);
        } else {
            exchange.setMarkPremiumCapBps(bps);
            assertEq(exchange.markPremiumCapBps(), bps);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // M8 — a fresh zero price never settles a position
    // ═════════════════════════════════════════════════════════════════════════

    function _zeroPriceFixture() internal returns (PerpetualExchange ex, SettableOracle so, uint256 longId, uint256 shortId) {
        so = new SettableOracle();
        ex = new PerpetualExchange(address(usdc), address(so), address(0));
        ex.setExecutionFee(0);
        so.set(BTC, 100_000e8);
        usdc.mint(address(ex), 100_000e18);
        vm.startPrank(carol);
        usdc.approve(address(ex), type(uint256).max);
        ex.depositMargin(10_000e18);
        longId  = ex.openPosition(BTC, true, 1_000e18, 5);
        shortId = ex.openPosition(BTC, false, 1_000e18, 5);
        vm.stopPrank();
        so.set(BTC, 0); // fresh timestamp, zero price
    }

    function test_close_zeroPrice_reverts() public {
        (PerpetualExchange ex, SettableOracle so, uint256 longId, uint256 shortId) = _zeroPriceFixture();
        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.InvalidPrice.selector, BTC));
        ex.closePosition(shortId); // would otherwise book a 5x windfall
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.InvalidPrice.selector, BTC));
        ex.closePosition(longId);
        vm.stopPrank();

        so.set(BTC, 100_000e8); // feed recovers -> exits work again
        vm.prank(carol);
        ex.closePosition(shortId);
    }

    function test_liquidate_zeroPrice_reverts() public {
        (PerpetualExchange ex, , uint256 longId, ) = _zeroPriceFixture();
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.InvalidPrice.selector, BTC));
        ex.liquidatePosition(longId); // a zero print must not wipe out longs
    }

    /// Views never revert on a zero price; they report the conservative value
    /// and `hasValidPrice` flags it.
    function test_views_zeroPrice_reportConservativeValues() public {
        (PerpetualExchange ex, , uint256 longId, uint256 shortId) = _zeroPriceFixture();
        assertFalse(PerpetualExchangeLens.hasValidPrice(ex, BTC));
        assertEq(ex.getUnrealizedPnL(longId), -int256(1_000e18));
        assertEq(ex.getUnrealizedPnL(shortId), -int256(1_000e18)); // no windfall either
        assertEq(ex.getPositionValue(longId), 0);
        assertEq(ex.getPositionValue(shortId), 0);
        assertEq(ex.getMarkPrice(BTC), 0);
    }
}
