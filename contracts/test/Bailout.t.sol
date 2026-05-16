// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Tests for vault bailout on close + liquidation remainder routing.
contract BailoutTest is Test {
    PerpetualExchange exchange;
    InsuranceVault    vault;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice = makeAddr("alice");

    bytes32 constant BTC       = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        vault    = new InsuranceVault(address(usdc));
        exchange = new PerpetualExchange(address(usdc), address(oracle));

        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));

        oracle.addAsset(BTC, BTC_PRICE);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);  // reserve

        vm.prank(alice);
        usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _seedVault(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
    }

    /// @dev Open 5× long so a 25% BTC drop makes pnl = -125e18 → closeAmount = -25e18 < 0.
    function _openLong5x(uint256 margin) internal returns (uint256) {
        vm.prank(alice);
        exchange.depositMargin(margin);
        vm.prank(alice);
        return exchange.openPosition(BTC, true, margin, 5);
    }

    // ── Bailout floor on underwater close ─────────────────────────────────────

    function test_closePosition_bailoutFloor_whenUnderwaterWithVault() public {
        uint256 margin = 100e18;
        _seedVault(10_000e18);  // vault funded

        // 5× long: notional = 500e18, size = 5e15 BTC units
        uint256 posId = _openLong5x(margin);

        // BTC -25 % → pnl = -25_000e18 * 5e15 / 1e18 = -125e18
        // closeAmount = 100e18 - 125e18 = -25e18 < 0 → bailout triggered
        oracle.updatePrice(BTC, 75_000e8);

        uint256 floor = margin * exchange.BAILOUT_FLOOR_BPS() / 10_000; // 10e18

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        exchange.closePosition(posId);

        // Alice's wallet received the floor directly from vault
        assertEq(usdc.balanceOf(alice), aliceBalBefore + floor);
        // Vault shrinks by floor amount
        assertEq(vault.totalAssets(), 10_000e18 - floor);
    }

    function test_closePosition_noRevert_whenVaultEmpty() public {
        uint256 margin = 100e18;
        // vault stays empty

        uint256 posId = _openLong5x(margin);
        oracle.updatePrice(BTC, 75_000e8);  // same underwater scenario

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        // Must NOT revert even with empty vault (try/catch in exchange)
        vm.prank(alice);
        exchange.closePosition(posId);

        // No bailout (vault empty → caught), position closes at 0
        assertEq(usdc.balanceOf(alice), aliceBalBefore);
        assertEq(exchange.freeMargin(alice), 0);
    }

    // ── Liquidation remainder → vault ─────────────────────────────────────────

    function test_liquidation_remainderGoesToVault() public {
        // 1× long: notional = 1_000e18, maintenanceMargin = 50e18 (5% of notional)
        // At 95% BTC drop: pnl = -950e18, closeAmount = 1000 - 950 = 50e18 ≤ maintenanceMargin
        uint256 margin = 1_000e18;
        vm.prank(alice);
        exchange.depositMargin(margin);
        vm.prank(alice);
        uint256 posId = exchange.openPosition(BTC, true, margin, 1);

        oracle.updatePrice(BTC, 5_000e8);  // 95 % drop

        uint256 vaultBefore = vault.totalAssets();
        exchange.liquidatePosition(posId);

        // Vault received the remaining collateral
        assertGt(vault.totalAssets(), vaultBefore);
    }
}
