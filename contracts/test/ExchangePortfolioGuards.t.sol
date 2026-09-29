// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";

/// @dev Oracle double that can report a fresh zero price and be left stale.
contract GuardsOracle {
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

/// @notice P1 portfolio-margin guards: no opens while unhealthy, withdrawals
///         only above Σ initial margin, non-Active legs' profit ignored, no
///         withdrawals while holding a Halted asset, conservative (non-
///         reverting) valuation of zero-price legs, and one freshness policy
///         for withdrawals, opens and liquidations.
contract ExchangePortfolioGuardsTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    GuardsOracle      oracle;

    address carol = makeAddr("carol");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new GuardsOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.set(BTC, 100_000e8);
        oracle.set(ETH, 4_000e8);
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
        exchange.setPortfolioMarginEnabled(true);

        usdc.mint(address(exchange), 1_000_000e18);
        usdc.mint(carol, 100_000e18);
        vm.prank(carol);
        usdc.approve(address(exchange), type(uint256).max);
    }

    function _deposit(uint256 a) internal {
        vm.prank(carol);
        exchange.depositMargin(a);
    }

    function _open(bytes32 asset, bool isLong, uint256 margin) internal returns (uint256) {
        vm.prank(carol);
        return exchange.openPosition(asset, isLong, margin, 5);
    }

    function _unhealthy(int256 eq, uint256 req) internal view returns (bytes memory) {
        return abi.encodeWithSelector(PerpetualExchange.AccountUnhealthy.selector, carol, eq, req);
    }

    // ── 1. no new exposure while the account is underwater ──────────────────

    function test_portfolio_openRefusedWhileAccountUnhealthy() public {
        _deposit(1_100e18);
        _open(BTC, true, 1_000e18);          // 100 free
        oracle.set(BTC, 70_000e8);           // leg -500 → equity -400 < 250
        vm.prank(carol);
        vm.expectRevert(_unhealthy(-400e18, 250e18));
        exchange.openPosition(ETH, true, 10e18, 1);
    }

    function test_portfolio_openAllowedWhileHealthy() public {
        _deposit(3_000e18);
        _open(BTC, true, 1_000e18);
        oracle.set(BTC, 95_000e8);
        _open(ETH, true, 1_000e18);
    }

    function test_isolated_openIgnoresAccountHealth() public {
        exchange.setPortfolioMarginEnabled(false);
        _deposit(1_100e18);
        _open(BTC, true, 1_000e18);
        oracle.set(BTC, 70_000e8);
        _open(ETH, true, 10e18);
    }

    // ── 2. withdrawals keep equity ≥ Σ initial margin ────────────────────────
    //
    // Review scenario: a deep loser (BTC) is shielded by a winner (ETH short).
    // Under the maintenance rule the owner could withdraw all 1,000 of free
    // margin (equity 1,250 ≥ 500); the initial-margin rule stops at 250, and a
    // non-Active winner does not count at all.

    function _shieldedBook() internal {
        _deposit(3_000e18);
        _open(BTC, true, 1_000e18);          // -35% → -1,750 (leg equity -750)
        _open(ETH, false, 1_000e18);         // -20% → +1,000 (leg equity 2,000)
        oracle.set(BTC, 65_000e8);
        oracle.set(ETH, 3_200e8);
        // equity = 1,000 free − 750 + 2,000 = 2,250; mm 500; initial 2,000
    }

    function test_portfolio_withdrawStopsAtInitialMargin() public {
        _shieldedBook();
        vm.prank(carol);
        vm.expectRevert(_unhealthy(2_000e18 - 1, 2_000e18));
        exchange.withdrawMargin(250e18 + 1);
        vm.prank(carol);
        exchange.withdrawMargin(250e18);
    }

    function test_portfolio_nonActiveLegProfitIsNotCollateral() public {
        _shieldedBook();
        exchange.setAssetMode(ETH, PerpetualExchange.AssetMode.ReduceOnly);
        // ETH profit ignored: equity = 1,000 − 750 + 1,000 = 1,250 < 2,000
        vm.prank(carol);
        vm.expectRevert(_unhealthy(1_250e18 - 1, 2_000e18));
        exchange.withdrawMargin(1);
        (int256 eq, , ) = exchange.getAccountHealth(carol);
        assertEq(eq, 1_250e18);
    }

    function test_portfolio_withdrawRefusedWhileHoldingHaltedAsset() public {
        _deposit(10_000e18);
        _open(BTC, true, 1_000e18);
        exchange.setAssetMode(BTC, PerpetualExchange.AssetMode.Halted);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.AssetHalted.selector, BTC));
        exchange.withdrawMargin(1e18);
    }

    // ── 3. zero-price legs: conservative, never a revert ────────────────────

    /// A broken feed on one asset must not block liquidating the account's
    /// other legs: the zero-price leg simply counts for nothing.
    function test_portfolio_zeroPriceLegDoesNotBlockLiquidationElsewhere() public {
        _deposit(2_000e18);
        uint256 btcId = _open(BTC, true, 1_000e18);
        uint256 ethId = _open(ETH, true, 1_000e18);  // 0 free
        oracle.set(BTC, 0);                           // broken feed, fresh timestamp
        oracle.set(ETH, 3_200e8);                     // ETH leg at 0 equity

        (int256 eq, uint256 mm, bool healthy) = exchange.getAccountHealth(carol);
        assertEq(eq, 0);                              // BTC counts 0, ETH 0
        assertEq(mm, 500e18);
        assertFalse(healthy);

        exchange.liquidatePosition(ethId);
        assertFalse(exchange.getPosition(ethId).isOpen);

        vm.prank(carol);                              // the zero-price leg itself cannot settle (M8)
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.InvalidPrice.selector, BTC));
        exchange.closePosition(btcId);
    }

    function test_portfolio_zeroPriceLegProfitNeverCounts() public {
        _deposit(2_000e18);
        _open(BTC, false, 1_000e18);                  // a short would "win" at 0
        oracle.set(BTC, 0);
        (int256 eq, , ) = exchange.getAccountHealth(carol);
        assertEq(eq, 1_000e18);                       // free margin only
    }

    // ── 4. one freshness policy: every leg, for withdraw and liquidation ────

    function test_portfolio_staleLegBlocksWithdrawAndLiquidationAlike() public {
        _deposit(3_000e18);
        uint256 btcId = _open(BTC, true, 1_000e18);
        _open(ETH, true, 1_000e18);                   // 1,000 free
        (, uint256 ethAt) = oracle.getPrice(ETH);
        vm.warp(vm.getBlockTimestamp() + exchange.maxPriceAge() + 1);
        oracle.set(BTC, 70_000e8);                    // BTC fresh and underwater; ETH stale

        bytes memory stale = abi.encodeWithSelector(PerpetualExchange.StalePrice.selector, ETH, ethAt);
        vm.prank(carol);
        vm.expectRevert(stale);
        exchange.withdrawMargin(1);
        vm.expectRevert(stale);
        exchange.liquidatePosition(btcId);
    }
}
