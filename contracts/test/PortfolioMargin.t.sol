// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/InsuranceVault.sol";

/// @notice P3-2: account-level (portfolio / cross) margin. Off by default →
///         legacy per-position isolation. On → a leg is liquidatable only if it
///         is individually underwater AND the whole account is underwater.
contract PortfolioMarginTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;
    InsuranceVault    vault;

    address user = makeAddr("user");
    address liquidator = makeAddr("liquidator");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        vault    = new InsuranceVault(address(usdc));

        oracle.addAsset(BTC, BTC_PRICE);
        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        usdc.mint(user, 1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);
        vm.prank(user); usdc.approve(address(exchange), type(uint256).max);
    }

    function _deposit(uint256 a) internal { vm.prank(user); exchange.depositMargin(a); }
    function _long(uint256 m) internal returns (uint256) { vm.prank(user); return exchange.openPosition(BTC, true,  m, 5); }
    function _short(uint256 m) internal returns (uint256) { vm.prank(user); return exchange.openPosition(BTC, false, m, 5); }

    // ── flag OFF: legacy isolated behaviour (regression) ────────────────────────

    function test_off_isolatedUnderwaterLiquidatable() public {
        _deposit(3_000e18);
        uint256 lng = _long(1_000e18);
        _short(1_000e18); // offsetting winner exists, but isolation ignores it
        oracle.updatePrice(BTC, 70_000e8);

        // Isolated: the long is individually underwater → liquidatable despite
        // the offsetting short (this is exactly the wrong-liquidation portfolio
        // mode fixes).
        exchange.liquidatePosition(lng);
        assertFalse(exchange.getPosition(lng).isOpen);
    }

    function test_off_healthyReverts() public {
        _deposit(3_000e18);
        uint256 lng = _long(1_000e18);
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(lng);
    }

    // ── flag ON: offsetting winner protects the losing leg ──────────────────────

    function test_portfolio_winnerProtectsLoser() public {
        exchange.setPortfolioMarginEnabled(true);
        _deposit(3_000e18);
        uint256 lng = _long(1_000e18);
        _short(1_000e18);
        oracle.updatePrice(BTC, 70_000e8); // long −1500, short +1500 → net flat

        // Account healthy (PnL nets out) → the underwater long is protected.
        vm.prank(liquidator);
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(lng);
        assertTrue(exchange.getPosition(lng).isOpen);
    }

    function test_getAccountHealth_view() public {
        exchange.setPortfolioMarginEnabled(true);
        _deposit(3_000e18);
        _long(1_000e18);   // freeMargin 2000
        _short(1_000e18);  // freeMargin 1000
        oracle.updatePrice(BTC, 70_000e8);

        (int256 equity, uint256 maintenance, bool healthy) = exchange.getAccountHealth(user);
        // equity = 1000 + (1000-1500) + (1000+1500) = 3000; maintenance = 250+250.
        assertEq(equity, int256(3_000e18));
        assertEq(maintenance, 500e18);
        assertTrue(healthy);
    }

    // ── flag ON: account underwater → liquidation allowed ───────────────────────

    function test_portfolio_accountUnderwaterLiquidatable() public {
        exchange.setPortfolioMarginEnabled(true);
        _deposit(2_000e18);
        uint256 a = _long(1_000e18);
        _long(1_000e18); // both long, no offset → losses compound
        oracle.updatePrice(BTC, 70_000e8);

        // equity = 0 + (1000-1500)*2 = -1000 < maintenance 500 → liquidatable.
        (int256 eq,, bool healthy) = exchange.getAccountHealth(user);
        assertLt(eq, int256(0));
        assertFalse(healthy);

        exchange.liquidatePosition(a);
        assertFalse(exchange.getPosition(a).isOpen);
    }

    // ── fee asymmetry: account underwater stays actionable (no stuck account) ───

    function test_portfolio_underwaterWithFees_notStuck() public {
        // Non-zero trading fee: the Q4 review case. The per-leg gate must use the
        // same fee-excluded basis as account equity, so an underwater account is
        // always liquidatable (never frozen above its own per-leg maintenance).
        exchange.setTradingFeeBps(10);     // 0.1% — reintroduces the asymmetry
        exchange.setPortfolioMarginEnabled(true);
        _deposit(3_000e18); // room for two 1000@5x legs incl. trading fee
        uint256 a = _long(1_000e18);
        _long(1_000e18);
        oracle.updatePrice(BTC, 70_000e8);

        (, , bool healthy) = exchange.getAccountHealth(user);
        assertFalse(healthy);
        exchange.liquidatePosition(a); // must NOT revert despite fees
        assertFalse(exchange.getPosition(a).isOpen);
    }

    // ── boundary: closeAmount == maintenance is liquidatable in both modes ──────

    function test_boundary_closeAmountEqualsMaintenance_liquidatable() public {
        // notional 5000, maintenance 5% = 250. Need closeAmount == 250 →
        // pnl = 250 - margin(1000) = -750 → priceChange -15000 (price 85k).
        _deposit(1_000e18);
        uint256 a = _long(1_000e18);
        oracle.updatePrice(BTC, 85_000e8);
        // isolated mode (flag off): closeAmount == maint → liquidatable (<=).
        exchange.liquidatePosition(a);
        assertFalse(exchange.getPosition(a).isOpen);
    }

    // ── boundary: account exactly at maintenance (eq == mm) is NOT liquidatable ─

    function test_boundary_equityEqualsMaintenance_protected() public {
        // Single long; choose a price where eq (= margin + pnl) == maintenance,
        // and the leg is individually at-or-below maintenance, so only the strict
        // `eq < mm` gate decides. notional 5000, maint 250. freeMargin 0.
        // Want eq = margin(1000) + pnl == 250 → pnl = -750 (price 85k). eq==mm==250.
        exchange.setPortfolioMarginEnabled(true);
        _deposit(1_000e18);
        uint256 a = _long(1_000e18); // freeMargin 0 after open
        oracle.updatePrice(BTC, 85_000e8);

        (int256 eq, uint256 mm, bool healthy) = exchange.getAccountHealth(user);
        assertEq(eq, int256(mm));   // exactly at maintenance
        assertTrue(healthy);        // strict <, so equality = healthy
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(a);
    }

    // ── conservation: portfolio-mode liquidation moves no USDC out of thin air ──

    function test_portfolio_liquidation_conservesUsdc() public {
        exchange.setPortfolioMarginEnabled(true);
        _deposit(2_000e18);
        uint256 a = _long(1_000e18);
        _long(1_000e18);
        // −16% → pnl −800 each. leg A closeAmount = 200 (0 < 200 ≤ 250 maint),
        // account equity = 0 + 200 + 200 = 400 < 500 → underwater & liquidatable,
        // and closeAmount > 0 so reward + vault transfer paths run.
        oracle.updatePrice(BTC, 84_000e8);

        uint256 before_ = usdc.balanceOf(address(exchange))
            + usdc.balanceOf(address(vault))
            + usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        exchange.liquidatePosition(a);

        uint256 after_ = usdc.balanceOf(address(exchange))
            + usdc.balanceOf(address(vault))
            + usdc.balanceOf(liquidator);

        // No USDC created or destroyed across {exchange, vault, liquidator}.
        assertEq(after_, before_);
        // And the split actually happened: 5% reward to liquidator, rest to vault.
        assertEq(usdc.balanceOf(liquidator), 10e18); // 200 * 5%
        assertEq(vault.totalAssets(), 190e18);        // 200 − 10
        assertFalse(exchange.getPosition(a).isOpen);
    }
}
