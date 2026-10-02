// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/PerpetualExchange.sol";
import "../../src/MockOracle.sol";
import "../../src/InsuranceVault.sol";
import "../../src/settlement/WrappedUSDC18.sol";
import "../../src/settlement/SettlementDepositRouter.sol";
import "./MockFiatUSDC6.sol";

/// @notice ADR-011 — the UNCHANGED PerpetualExchange bytecode running on a
///         6-decimal USDC through WrappedUSDC18: deposit via the router (one
///         tx, permit), open, close at a price that produces a non-round
///         18-dec PnL, withdraw, unwrap; plus USDC pause / blacklist paths.
contract WrappedSettlementIntegrationTest is Test {
    MockFiatUSDC6           usdc;
    WrappedUSDC18           w;
    PerpetualExchange       exchange;
    MockOracle              oracle;
    InsuranceVault          vault;
    SettlementDepositRouter router;

    uint256 constant SCALE = 1e12;
    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    uint256 userPk = 0xA11CE;
    address user;
    address lp = makeAddr("lp");
    address liquidator = makeAddr("liquidator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        user = vm.addr(userPk);
        usdc = new MockFiatUSDC6();
        w = new WrappedUSDC18(address(usdc), "Wrapped USDC", "USDC");
        oracle = new MockOracle();
        // The decimals() gate in the exchange constructor sees 18 → accepted.
        exchange = new PerpetualExchange(address(w), address(oracle), address(0));
        vault = new InsuranceVault(address(w));
        router = new SettlementDepositRouter(address(w), address(exchange));

        oracle.addAsset(BTC, BTC_PRICE);
        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
        // tenant admin step: let the router credit margin (ADR-011 §3.4)
        exchange.setAgentAuthorized(address(router), true);

        // pool liquidity, in real USDC, wrapped and handed to the exchange
        usdc.mint(lp, 1_000_000e6);
        vm.startPrank(lp);
        usdc.approve(address(w), type(uint256).max);
        w.depositFor(address(exchange), 1_000_000e6);
        vm.stopPrank();

        usdc.mint(user, 10_000e6);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _permitSig(uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            owner, spender, value, usdc.nonces(owner), deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _routeDeposit(uint256 amt6) internal returns (uint256 margin) {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(userPk, user, address(router), amt6, deadline);
        vm.prank(user);
        margin = router.depositMarginWithPermit(user, amt6, deadline, v, r, s);
    }

    function _assertBacked() internal view {
        assertLe(w.totalSupply(), usdc.balanceOf(address(w)) * SCALE, "I1");
        assertEq(w.totalSupply() % SCALE, 0, "I2");
    }

    // ── happy path ───────────────────────────────────────────────────────

    function test_e2e_depositOpenCloseWithdrawUnwrap() public {
        uint256 usdcStart = usdc.balanceOf(user);

        // 1) one transaction: permit + pull + wrap + depositMarginFor
        uint256 margin = _routeDeposit(1_000e6);
        assertEq(margin, 1_000e18);
        assertEq(exchange.freeMargin(user), 1_000e18);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
        assertEq(w.balanceOf(address(router)), 0, "router holds no wrapper units");

        // 2) open 100 margin × 5 long, then move the price to a value whose
        //    PnL has digits below 1e-6 USDC
        vm.prank(user);
        uint256 id = exchange.openPosition(BTC, true, 100e18, 5);
        oracle.updatePrice(BTC, 103_333_33333333); // +3.33333333333%
        vm.prank(user);
        exchange.closePosition(id);

        uint256 free = exchange.freeMargin(user);
        assertGt(free, 1_000e18, "profitable close");
        assertTrue(free % SCALE != 0, "PnL carries sub-unit (18-dec) precision");

        // 3) withdraw the whole 18-dec balance, then unwrap what is payable
        vm.prank(user);
        exchange.withdrawMargin(free);
        assertEq(w.balanceOf(user), free);
        uint256 payable_ = w.maxUnwrappable(user);
        vm.prank(user);
        uint256 paid = w.withdrawTo(user, payable_);

        assertEq(paid, free / SCALE, "rounds down to whole micro-USDC");
        assertEq(usdc.balanceOf(user), usdcStart - 1_000e6 + paid);
        assertEq(w.balanceOf(user), free % SCALE, "only sub-unit dust left behind");
        assertLt(w.balanceOf(user), SCALE);
        _assertBacked();
    }

    function test_e2e_losingClose_andLiquidation() public {
        _routeDeposit(1_000e6);
        vm.startPrank(user);
        uint256 a = exchange.openPosition(BTC, true, 100e18, 5);
        uint256 b = exchange.openPosition(BTC, true, 200e18, 5);
        vm.stopPrank();

        oracle.updatePrice(BTC, 97_777_77777777);
        vm.prank(user);
        exchange.closePosition(a);

        oracle.updatePrice(BTC, 80_000e8); // -20% at 5x → b underwater
        vm.prank(liquidator);
        exchange.liquidatePosition(b);
        assertFalse(exchange.getPosition(b).isOpen);

        // liquidator was paid in wrapper units and can unwrap them
        uint256 reward = w.balanceOf(liquidator);
        if (reward >= SCALE) {
            uint256 m = w.maxUnwrappable(liquidator);
            vm.prank(liquidator);
            w.withdrawTo(liquidator, m);
        }
        uint256 free = exchange.freeMargin(user);
        vm.prank(user);
        exchange.withdrawMargin(free);
        uint256 mu = w.maxUnwrappable(user);
        vm.prank(user);
        w.withdrawTo(user, mu);
        _assertBacked();
    }

    // ── router ───────────────────────────────────────────────────────────

    function test_router_plainApprovePath() public {
        vm.startPrank(user);
        usdc.approve(address(router), 50e6);
        router.depositMargin(user, 50e6);
        vm.stopPrank();
        assertEq(exchange.freeMargin(user), 50e18);
    }

    function test_router_creditsAnotherAccount() public {
        address bob = makeAddr("bob");
        vm.startPrank(user);
        usdc.approve(address(router), 50e6);
        router.depositMargin(bob, 50e6);
        vm.stopPrank();
        assertEq(exchange.freeMargin(bob), 50e18);
        assertEq(exchange.freeMargin(user), 0);
    }

    function test_router_permitFrontRunDoesNotGrief() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(userPk, user, address(router), 100e6, deadline);
        // someone lifts the signature from the mempool and spends the nonce first
        vm.prank(attacker);
        usdc.permit(user, address(router), 100e6, deadline, v, r, s);
        // the user's own transaction still goes through
        vm.prank(user);
        router.depositMarginWithPermit(user, 100e6, deadline, v, r, s);
        assertEq(exchange.freeMargin(user), 100e18);
    }

    function test_router_cannotPullFromSomeoneElse() public {
        // user approved the router; an attacker cannot spend that allowance
        vm.prank(user);
        usdc.approve(address(router), 100e6);
        vm.prank(attacker);
        vm.expectRevert();
        router.depositMargin(attacker, 100e6);
    }

    function test_router_unauthorizedReverts() public {
        exchange.setAgentAuthorized(address(router), false);
        vm.startPrank(user);
        usdc.approve(address(router), 50e6);
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        router.depositMargin(user, 50e6);
        vm.stopPrank();
    }

    function test_router_zeroAndBadParams() public {
        vm.startPrank(user);
        vm.expectRevert(SettlementDepositRouter.ZeroAmount.selector);
        router.depositMargin(user, 0);
        vm.expectRevert(SettlementDepositRouter.InvalidParam.selector);
        router.depositMargin(address(0), 1e6);
        vm.stopPrank();
        vm.expectRevert(SettlementDepositRouter.InvalidParam.selector);
        new SettlementDepositRouter(address(0), address(exchange));
    }

    function test_router_manualPathEquivalent() public {
        // without the router: approve wrapper, wrap, approve exchange, deposit (4 tx)
        vm.startPrank(user);
        usdc.approve(address(w), 10e6);
        w.depositFor(user, 10e6);
        w.approve(address(exchange), 10e18);
        exchange.depositMargin(10e18);
        vm.stopPrank();
        assertEq(exchange.freeMargin(user), 10e18);
    }

    // ── USDC pause ───────────────────────────────────────────────────────

    function test_usdcPaused_tradingContinues_exitStopsAtUnwrap() public {
        _routeDeposit(1_000e6);
        vm.prank(user);
        uint256 id = exchange.openPosition(BTC, true, 100e18, 5);

        vm.prank(user);
        usdc.approve(address(router), 1e6);
        usdc.pause();

        // new money cannot come in
        vm.prank(user);
        vm.expectRevert("Pausable: paused");
        router.depositMargin(user, 1e6);

        // the book keeps working: close, liquidate, withdraw wrapper units
        oracle.updatePrice(BTC, 101_000e8);
        vm.prank(user);
        exchange.closePosition(id);
        uint256 free = exchange.freeMargin(user);
        vm.prank(user);
        exchange.withdrawMargin(free);
        assertEq(w.balanceOf(user), free);

        // only the last hop to USDC waits for Circle
        vm.prank(user);
        vm.expectRevert("Pausable: paused");
        w.withdrawTo(user, 1e18);

        usdc.unpause();
        uint256 mu = w.maxUnwrappable(user);
        vm.prank(user);
        w.withdrawTo(user, mu);
        _assertBacked();
    }

    // ── Circle blacklist ─────────────────────────────────────────────────

    function test_blacklistedTrader_cannotWithdraw_butIsStillLiquidatable() public {
        _routeDeposit(1_000e6);
        vm.prank(user);
        uint256 id = exchange.openPosition(BTC, true, 500e18, 5);

        usdc.blacklist(user);

        // same outcome as native USDC: the freeze holds inside the exchange
        uint256 free = exchange.freeMargin(user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, user));
        exchange.withdrawMargin(free);

        // ...but the blacklist never blocks risk management
        oracle.updatePrice(BTC, 80_000e8);
        vm.prank(liquidator);
        exchange.liquidatePosition(id);
        assertFalse(exchange.getPosition(id).isOpen);
        _assertBacked();
    }

    function test_blacklistedRouterDepositForBlacklistedAccountReverts() public {
        address bad = makeAddr("bad");
        usdc.blacklist(bad);
        vm.startPrank(user);
        usdc.approve(address(router), 10e6);
        // exchange credits are internal, so the wrapper cannot see `bad` here;
        // the credit lands but `bad` can never withdraw it (parity with USDC,
        // where a deposit-for to a blacklisted account also only freezes it).
        router.depositMargin(bad, 10e6);
        vm.stopPrank();
        assertEq(exchange.freeMargin(bad), 10e18);
        vm.prank(bad);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, bad));
        exchange.withdrawMargin(10e18);
    }

    function test_exchangeBlacklisted_wholeTenantFrozen() public {
        _routeDeposit(100e6);
        usdc.blacklist(address(exchange));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, address(exchange)));
        exchange.withdrawMargin(10e18);
    }
}
