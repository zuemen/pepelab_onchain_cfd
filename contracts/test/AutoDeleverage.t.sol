// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/InsuranceVault.sol";

/// @notice N2: auto-deleveraging (ADL) solvency backstop. When a liquidation
///         leaves the protocol short and the InsuranceVault cannot cover it,
///         profitable counterparties are force-closed with a profit haircut so
///         total claims never exceed reserves. Off by default (regression-safe).
contract AutoDeleverageTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;
    InsuranceVault    vault;

    address bull = makeAddr("bull"); // losing long
    address bear = makeAddr("bear"); // winning short

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

        usdc.mint(bull, 1_000_000e18);
        usdc.mint(bear, 1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);
        vm.prank(bull); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bear); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bull); exchange.depositMargin(100_000e18);
        vm.prank(bear); exchange.depositMargin(100_000e18);
    }

    function _openBalanced() internal returns (uint256 longId, uint256 shortId) {
        vm.prank(bull); longId  = exchange.openPosition(BTC, true,  1_000e18, 5); // 5000 notional
        vm.prank(bear); shortId = exchange.openPosition(BTC, false, 1_000e18, 5); // 5000 notional
        // balanced OI → funding stays 0
    }

    // ── ADL fires when vault cannot cover the shortfall ─────────────────────────

    function test_adl_haircutsWinner_whenVaultEmpty() public {
        exchange.setAdlEnabled(true);
        (uint256 longId, uint256 shortId) = _openBalanced();

        // Price -30% → long underwater beyond margin, short in profit.
        oracle.updatePrice(BTC, 70_000e8);

        // long: pnl = -1500, margin 1000 → closeAmount = -500 → shortfall 500.
        // vault is empty → uncovered = 500. short profit = +1500 → haircut 500.
        vm.expectEmit(true, true, false, true, address(exchange));
        emit PerpetualExchange.AutoDeleveraged(longId, shortId, 500e18, 2_000e18);

        exchange.liquidatePosition(longId);

        // short force-closed with a 500 haircut: realizedPnL = 1500 - 500 = 1000.
        PerpetualExchange.Position memory sp = exchange.getPosition(shortId);
        assertFalse(sp.isOpen);
        assertEq(sp.realizedPnL, int256(1_000e18));
        // winner credited margin + (profit - haircut) = 1000 + 1000 = 2000.
        assertEq(exchange.freeMargin(bear), 99_000e18 + 2_000e18);
        // OI fully cleared on both sides.
        assertEq(exchange.globalShortNotional(BTC), 0);
        assertEq(exchange.globalLongNotional(BTC), 0);
    }

    // ── ADL skipped when the vault can absorb the shortfall ─────────────────────

    function test_adl_skipped_whenVaultCovers() public {
        exchange.setAdlEnabled(true);
        // Fund the vault generously so it covers any shortfall.
        usdc.mint(address(this), 10_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e18);

        (uint256 longId, uint256 shortId) = _openBalanced();
        oracle.updatePrice(BTC, 70_000e8);

        exchange.liquidatePosition(longId);

        // Vault covers the 500 shortfall → winner untouched, short still open.
        assertTrue(exchange.getPosition(shortId).isOpen);
        assertEq(exchange.globalShortNotional(BTC), 5_000e18);
    }

    // ── ADL disabled → legacy behaviour (winner untouched) ──────────────────────

    function test_adl_disabled_noDeleverage() public {
        // adlEnabled defaults false
        (uint256 longId, uint256 shortId) = _openBalanced();
        oracle.updatePrice(BTC, 70_000e8);

        exchange.liquidatePosition(longId);

        assertTrue(exchange.getPosition(shortId).isOpen);
        assertEq(exchange.globalShortNotional(BTC), 5_000e18);
    }

    // ── ADL with no profitable counterparty is a safe no-op ─────────────────────

    function test_adl_noWinner_safeNoop() public {
        exchange.setAdlEnabled(true);
        // Only the losing long exists.
        vm.prank(bull);
        uint256 longId = exchange.openPosition(BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 70_000e8);

        exchange.liquidatePosition(longId); // must not revert
        assertFalse(exchange.getPosition(longId).isOpen);
    }
}
