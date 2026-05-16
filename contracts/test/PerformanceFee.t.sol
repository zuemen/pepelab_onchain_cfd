// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Tests that verify the 10 % performance fee on copied positions.
contract PerformanceFeeTest is Test {
    PerpetualExchange exchange;
    InsuranceVault    vault;
    FeeRouter         feeRouter;
    MockUSDC          usdc;
    MockOracle        oracle;

    address owner    = address(this);
    address platform = makeAddr("platform");
    address trader   = makeAddr("trader");
    address follower = makeAddr("follower");
    address tracker  = makeAddr("tracker");  // simulates CopyTracker

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc      = new MockUSDC();
        oracle    = new MockOracle();
        vault     = new InsuranceVault(address(usdc));
        feeRouter = new FeeRouter(address(usdc), platform, address(vault));
        exchange  = new PerpetualExchange(address(usdc), address(oracle));

        // Wire: exchange authorized to call feeRouter.receivePerformanceFee
        vault.setFeeRouter(address(feeRouter));
        feeRouter.setExchange(address(exchange));
        exchange.setCopyTracker(tracker);
        exchange.setFeeRouter(address(feeRouter));

        oracle.addAsset(BTC, BTC_PRICE);

        // Mint USDC to users and exchange reserve
        usdc.mint(follower,          100_000e18);
        usdc.mint(address(exchange), 10_000_000e18);  // large reserve for payouts

        vm.prank(follower);
        usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
    }

    // ── Helper: open a copied position ───────────────────────────────────────

    function _openCopied(uint256 margin) internal returns (uint256 posId) {
        vm.prank(follower);
        exchange.depositMargin(margin);

        vm.prank(tracker);
        posId = exchange.openPositionFor(follower, BTC, true, margin, 1, trader);
    }

    // ── Performance fee charged on profit ────────────────────────────────────

    function test_performanceFee_chargedOnProfit() public {
        // margin = 100e18, BTC +10 % → pnl = 10e18
        // perfFee = 10e18 * 1000 / 10000 = 1e18
        uint256 posId = _openCopied(100e18);

        oracle.updatePrice(BTC, 110_000e8);

        uint256 marginBefore = exchange.freeMargin(follower);
        vm.prank(follower);
        exchange.closePosition(posId);

        // follower receives margin + pnl - perfFee = 100 + 10 - 1 = 109e18
        assertEq(exchange.freeMargin(follower), marginBefore + 109e18);
    }

    function test_performanceFee_traderEarns70Pct() public {
        uint256 posId = _openCopied(100e18);
        oracle.updatePrice(BTC, 110_000e8);

        vm.prank(follower);
        exchange.closePosition(posId);

        // perfFee = 1e18; trader earns 70 % = 0.7e18
        assertEq(feeRouter.traderEarnings(trader), 0.7e18);
    }

    function test_performanceFee_platformEarns20Pct() public {
        uint256 posId = _openCopied(100e18);
        oracle.updatePrice(BTC, 110_000e8);

        vm.prank(follower);
        exchange.closePosition(posId);

        // 20 % of 1e18 = 0.2e18
        assertEq(feeRouter.platformEarnings(), 0.2e18);
    }

    function test_performanceFee_vaultEarns10Pct() public {
        uint256 posId = _openCopied(100e18);
        oracle.updatePrice(BTC, 110_000e8);

        uint256 vaultBefore = vault.totalAssets();
        vm.prank(follower);
        exchange.closePosition(posId);

        // 10 % of 1e18 = 0.1e18 goes to insurance vault
        assertEq(vault.totalAssets(), vaultBefore + 0.1e18);
    }

    // ── No fee when not profitable ────────────────────────────────────────────

    function test_performanceFee_notChargedOnLoss() public {
        uint256 posId = _openCopied(100e18);
        oracle.updatePrice(BTC, 90_000e8);  // -10 % → pnl = -10e18

        uint256 marginBefore = exchange.freeMargin(follower);
        vm.prank(follower);
        exchange.closePosition(posId);

        // follower gets margin - loss = 100 - 10 = 90e18, no fee
        assertEq(exchange.freeMargin(follower), marginBefore + 90e18);
        assertEq(feeRouter.traderEarnings(trader), 0);
    }

    function test_performanceFee_notChargedOnBreakEven() public {
        uint256 posId = _openCopied(100e18);
        // price unchanged → pnl = 0

        uint256 marginBefore = exchange.freeMargin(follower);
        vm.prank(follower);
        exchange.closePosition(posId);

        assertEq(exchange.freeMargin(follower), marginBefore + 100e18);
        assertEq(feeRouter.traderEarnings(trader), 0);
    }

    // ── No fee on self-opened positions ──────────────────────────────────────

    function test_performanceFee_notChargedForSelfOpenedPosition() public {
        vm.prank(follower);
        exchange.depositMargin(100e18);

        vm.prank(follower);
        uint256 posId = exchange.openPosition(BTC, true, 100e18, 1);

        oracle.updatePrice(BTC, 110_000e8);

        uint256 marginBefore = exchange.freeMargin(follower);
        vm.prank(follower);
        exchange.closePosition(posId);

        // Full 110e18 returned, no performance fee
        assertEq(exchange.freeMargin(follower), marginBefore + 110e18);
        assertEq(feeRouter.traderEarnings(trader), 0);
    }

    // ── No fee when feeRouter not set ─────────────────────────────────────────

    function test_performanceFee_skippedWhenFeeRouterNotSet() public {
        PerpetualExchange exchangeNoFee = new PerpetualExchange(address(usdc), address(oracle));
        exchangeNoFee.setCopyTracker(tracker);
        exchangeNoFee.setExecutionFee(0);
        exchangeNoFee.setTradingFeeBps(0);
        exchangeNoFee.setBorrowFeePerHour(0);
        // intentionally do NOT call setFeeRouter

        usdc.mint(address(exchangeNoFee), 1_000_000e18);

        vm.prank(follower);
        usdc.approve(address(exchangeNoFee), type(uint256).max);
        vm.prank(follower);
        exchangeNoFee.depositMargin(100e18);

        vm.prank(tracker);
        uint256 posId = exchangeNoFee.openPositionFor(follower, BTC, true, 100e18, 1, trader);

        oracle.updatePrice(BTC, 110_000e8);

        uint256 marginBefore = exchangeNoFee.freeMargin(follower);
        vm.prank(follower);
        exchangeNoFee.closePosition(posId);

        // Full 110e18 returned since feeRouter is not set
        assertEq(exchangeNoFee.freeMargin(follower), marginBefore + 110e18);
    }

    // ── copiedFrom field recorded ─────────────────────────────────────────────

    function test_copiedFrom_storedOnPosition() public {
        uint256 posId = _openCopied(100e18);
        PerpetualExchange.Position memory pos = exchange.getPosition(posId);
        assertEq(pos.copiedFrom, trader);
    }

    function test_copiedFrom_zeroForSelfOpened() public {
        vm.prank(follower);
        exchange.depositMargin(100e18);
        vm.prank(follower);
        uint256 posId = exchange.openPosition(BTC, true, 100e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(posId);
        assertEq(pos.copiedFrom, address(0));
    }
}
