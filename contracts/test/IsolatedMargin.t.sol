// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/InsuranceVault.sol";

/// @notice Isolated margin — the only margin mode since portfolio (cross)
///         margin was removed. Each position is liquidated on its own
///         maintenance requirement; free margin and other positions neither
///         shield it nor pay for it.
contract IsolatedMarginTest is Test {
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
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
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

    function test_isolated_underwaterLiquidatableDespiteOffsettingWinner() public {
        _deposit(3_000e18);
        uint256 lng = _long(1_000e18);
        _short(1_000e18); // offsetting winner exists, but isolation ignores it
        oracle.updatePrice(BTC, 70_000e8);
        exchange.liquidatePosition(lng);
        assertFalse(exchange.getPosition(lng).isOpen);
    }

    function test_isolated_underwaterLiquidatableDespiteFreeMargin() public {
        _deposit(100_000e18);             // large free-margin cushion
        uint256 lng = _long(1_000e18);
        oracle.updatePrice(BTC, 80_000e8); // leg at its own maintenance
        exchange.liquidatePosition(lng);
        assertFalse(exchange.getPosition(lng).isOpen);
        assertEq(exchange.freeMargin(user), 99_000e18); // cushion untouched
    }

    function test_isolated_healthyReverts() public {
        _deposit(3_000e18);
        uint256 lng = _long(1_000e18);
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(lng);
    }

    function test_boundary_closeAmountEqualsMaintenance_liquidatable() public {
        // notional 5000, maintenance 5% = 250. Need closeAmount == 250 →
        // pnl = 250 - margin(1000) = -750 → priceChange -15000 (price 85k).
        _deposit(1_000e18);
        uint256 a = _long(1_000e18);
        oracle.updatePrice(BTC, 85_000e8);
        exchange.liquidatePosition(a);   // closeAmount == maintenance → liquidatable (<=)
        assertFalse(exchange.getPosition(a).isOpen);
    }

    function test_boundary_closeAmountAboveMaintenance_protected() public {
        _deposit(1_000e18);
        uint256 a = _long(1_000e18);
        oracle.updatePrice(BTC, 85_001e8);
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(a);
    }

    /// A position liquidated below zero pays no liquidator reward and never
    /// touches the owner's free margin: the shortfall goes to the vault / ADL /
    /// bad debt, exactly as for a voluntary close.
    function test_isolated_belowZero_noRewardAndFreeMarginUntouched() public {
        _deposit(1_600e18);
        uint256 id = _long(1_000e18);     // 600 free
        oracle.updatePrice(BTC, 70_000e8); // −1,500 on 1,000 margin
        address liq = makeAddr("liq");
        vm.prank(liq);
        exchange.liquidatePosition(id);
        assertEq(usdc.balanceOf(liq), 0);
        assertEq(exchange.freeMargin(user), 600e18);
    }

    /// Withdrawals are never gated on account health: free margin backs no
    /// position.
    function test_isolated_withdrawAllFreeMarginWhileUnderwater() public {
        _deposit(3_000e18);
        _long(1_000e18);
        oracle.updatePrice(BTC, 70_000e8);
        vm.prank(user);
        exchange.withdrawMargin(2_000e18);
        assertEq(exchange.freeMargin(user), 0);
    }
}
