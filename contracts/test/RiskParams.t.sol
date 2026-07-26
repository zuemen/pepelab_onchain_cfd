// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice N3: per-asset risk overrides (max leverage + maintenance margin).
///         0 = use the global default, so unset assets behave exactly as before.
contract RiskParamsTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice = makeAddr("alice");

    bytes32 constant XAU = keccak256("XAU"); // RWA, tighter risk
    bytes32 constant BTC = keccak256("BTC"); // crypto, global defaults

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));

        oracle.addAsset(XAU, 2_000e8);
        oracle.addAsset(BTC, 100_000e8);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); exchange.depositMargin(500_000e18);
    }

    // ── max leverage override ───────────────────────────────────────────────────

    function test_setMaxLeverageFor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        exchange.setMaxLeverageFor(XAU, 2);
    }

    function test_cannotExceedGlobalCap() public {
        vm.expectRevert(bytes("above global cap"));
        exchange.setMaxLeverageFor(XAU, 6); // > MAX_LEVERAGE(5)
    }

    function test_rwaLowerLeverageCap_enforced() public {
        exchange.setMaxLeverageFor(XAU, 2);
        assertEq(exchange.maxLeverageForAsset(XAU), 2);

        // lev 3 on XAU now reverts; lev 2 ok.
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(XAU, true, 1_000e18, 3);

        vm.prank(alice);
        uint256 pid = exchange.openPosition(XAU, true, 1_000e18, 2);
        assertEq(exchange.getPosition(pid).leverage, 2);
    }

    function test_unsetAsset_usesGlobalLeverage() public {
        // BTC has no override → still up to MAX_LEVERAGE(5).
        assertEq(exchange.maxLeverageForAsset(BTC), 5);
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);
        assertEq(exchange.getPosition(pid).leverage, 5);
    }

    // ── maintenance margin override ─────────────────────────────────────────────

    function test_maintenanceOverride_liquidatesEarlier() public {
        // Open BTC long, lev 5: notional 5000, maintenance default 5% = 250.
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);

        // Drop 4%: pnl = -200 → closeAmount = 800. Healthy at 5% (250), but a
        // 20% maintenance (1000) makes it liquidatable.
        oracle.updatePrice(BTC, 96_000e8);

        // Default maintenance: healthy → liquidation reverts.
        vm.expectRevert(PerpetualExchange.PositionIsHealthy.selector);
        exchange.liquidatePosition(pid);

        // Tighten maintenance for BTC to 20% → now liquidatable.
        exchange.setMaintenanceMarginFor(BTC, 2_000);
        assertEq(exchange.maintenanceMarginBpsForAsset(BTC), 2_000);
        exchange.liquidatePosition(pid); // succeeds
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    function test_unsetAsset_usesGlobalMaintenance() public view {
        assertEq(exchange.maintenanceMarginBpsForAsset(XAU), 500); // global default
    }
}
