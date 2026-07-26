// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice G6: mark-price perpetual model. Mark = index ± OI-imbalance premium
///         (bounded by markPremiumCapBps); PnL/liquidation value on mark, entry
///         on index. Default cap 0 keeps mark == index (legacy), proven here.
contract MarkPriceTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;       // 8-dec oracle
    uint256 constant BTC_INDEX = 100_000e18;      // 18-dec internal

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        oracle.addAsset(BTC, BTC_PRICE);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(bob,   1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        vm.prank(alice); exchange.depositMargin(500_000e18);
        vm.prank(bob);   exchange.depositMargin(500_000e18);
    }

    // ── default disabled: mark == index ─────────────────────────────────────────

    function test_defaultCapZero_markEqualsIndex() public {
        assertEq(exchange.markPremiumCapBps(), 0);
        vm.prank(alice); exchange.openPosition(BTC, true, 1_000e18, 5); // longs-heavy
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX);
    }

    // ── config ──────────────────────────────────────────────────────────────────

    function test_setMarkPremiumCapBps_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        exchange.setMarkPremiumCapBps(50);
    }

    function test_noOpenInterest_markEqualsIndex() public {
        exchange.setMarkPremiumCapBps(50);
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX); // no OI yet
    }

    // ── premium direction ───────────────────────────────────────────────────────

    function test_longsHeavy_markAboveIndex() public {
        exchange.setMarkPremiumCapBps(50); // 0.5% cap
        // 100% long imbalance → premium at full cap (+0.5%).
        vm.prank(alice); exchange.openPosition(BTC, true, 1_000e18, 5);
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX + BTC_INDEX * 50 / 10000);
    }

    function test_shortsHeavy_markBelowIndex() public {
        exchange.setMarkPremiumCapBps(50);
        vm.prank(alice); exchange.openPosition(BTC, false, 1_000e18, 5);
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX - BTC_INDEX * 50 / 10000);
    }

    function test_balancedBook_markEqualsIndex() public {
        exchange.setMarkPremiumCapBps(50);
        vm.prank(alice); exchange.openPosition(BTC, true,  1_000e18, 5);
        vm.prank(bob);   exchange.openPosition(BTC, false, 1_000e18, 5);
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX); // perfectly balanced
    }

    // ── premium is capped ───────────────────────────────────────────────────────

    function test_premiumCapped_partialImbalance() public {
        exchange.setMarkPremiumCapBps(100); // 1% cap
        // long 3000 notional, short 1000 → imbalance = 2000/4000 = 0.5 → 0.5% premium
        vm.prank(alice); exchange.openPosition(BTC, true,  600e18, 5);  // 3000 notional long
        vm.prank(bob);   exchange.openPosition(BTC, false, 200e18, 5);  // 1000 notional short
        // premium = 0.5 * 1% = 0.5%
        assertEq(exchange.getMarkPrice(BTC), BTC_INDEX + BTC_INDEX * 50 / 10000);
    }

    // ── mark drives PnL: long pays the premium it created ───────────────────────

    function test_markAffectsPnL_vsIndex() public {
        // Open long with cap ON; mark > index, but entry is index → opening a
        // long into a longs-heavy book shows immediate positive PnL from the
        // premium (mark above entry index). Compare to cap OFF (zero PnL).
        exchange.setMarkPremiumCapBps(50);
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);
        int256 pnlWithMark = exchange.getUnrealizedPnL(pid);
        assertGt(pnlWithMark, 0); // mark (entry+0.5%) above index entry

        // Disable premium → PnL collapses to ~0 (price unchanged at index).
        exchange.setMarkPremiumCapBps(0);
        assertEq(exchange.getUnrealizedPnL(pid), 0);
    }
}
