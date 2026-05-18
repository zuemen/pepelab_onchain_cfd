// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Tests that verify the trading fee buffer prevents InsufficientFreeMargin
///      when CopyTracker opens multiple positions in a single followTrader call.
contract CopyTrackerFeeBufferTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       ct;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant ASSET1 = keccak256("BTC");
    bytes32 constant ASSET2 = keccak256("ETH");
    bytes32 constant ASSET3 = keccak256("AAPL");
    bytes32 constant ASSET4 = keccak256("TSLA");
    bytes32 constant ASSET5 = keccak256("SOL");
    bytes32 constant ASSET_UNREG = keccak256("DOGE"); // intentionally NOT added to oracle

    uint256 constant PRICE           = 1_000e8;  // $1000 for all assets (clean math)
    uint256 constant TRADING_FEE_BPS = 10;        // 0.1%

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        registry = new StrategyRegistry(address(0));
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(0));

        exchange.setCopyTracker(address(ct));
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(TRADING_FEE_BPS);
        exchange.setBorrowFeePerHour(0);

        oracle.addAsset(ASSET1, PRICE);
        oracle.addAsset(ASSET2, PRICE);
        oracle.addAsset(ASSET3, PRICE);
        oracle.addAsset(ASSET4, PRICE);
        oracle.addAsset(ASSET5, PRICE);
        // ASSET_UNREG intentionally omitted

        vm.prank(alice);
        registry.registerTrader("Alice");

        usdc.mint(bob, 1_000_000e18);
        vm.prank(bob);
        usdc.approve(address(ct), type(uint256).max);

        // Seed exchange with USDC so it can settle PnL on close
        usdc.mint(address(exchange), 10_000_000e18);
    }

    function _publishStrategy(StrategyRegistry.Allocation[] memory allocs) internal {
        vm.prank(alice);
        registry.publishStrategy(allocs);
    }

    // ── Test 1: 3-position strategy with non-zero trading fee succeeds ────────

    function testFollowTrader_succeedsWithTradingFee_3positions() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 4000, isLong: true,  leverage: 2});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 3000, isLong: false, leverage: 1});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET3, weight: 3000, isLong: true,  leverage: 1});
        _publishStrategy(allocs);

        uint256 totalMargin = 10_000e18;
        uint256 balBefore   = usdc.balanceOf(bob);

        vm.prank(bob);
        ct.followTrader(alice, totalMargin);

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        assertEq(recs[0].positionIds.length, 3, "wrong position count");

        for (uint256 i; i < 3; ++i) {
            assertTrue(exchange.getPosition(recs[0].positionIds[i]).isOpen, "position not open");
        }

        assertEq(usdc.balanceOf(bob), balBefore - totalMargin, "USDC not deducted");
    }

    // ── Test 2: 5-position strategy with non-zero trading fee succeeds ────────

    function testFollowTrader_succeedsWithTradingFee_5positions() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](5);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 2000, isLong: true,  leverage: 1});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 2000, isLong: false, leverage: 1});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET3, weight: 2000, isLong: true,  leverage: 1});
        allocs[3] = StrategyRegistry.Allocation({asset: ASSET4, weight: 2000, isLong: true,  leverage: 1});
        allocs[4] = StrategyRegistry.Allocation({asset: ASSET5, weight: 2000, isLong: false, leverage: 1});
        _publishStrategy(allocs);

        uint256 totalMargin = 10_000e18;

        vm.prank(bob);
        ct.followTrader(alice, totalMargin);

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        assertEq(recs[0].positionIds.length, 5, "wrong position count");

        for (uint256 i; i < 5; ++i) {
            assertTrue(exchange.getPosition(recs[0].positionIds[i]).isOpen, "position not open");
        }
    }

    // ── Test 3: previewCopyAllocation returns correct portions ────────────────
    //
    // Strategy: 50 % ASSET1 long 2×, 50 % ASSET2 short 2×
    // netMargin = 10 000e18 (no copy fee)
    // wNotional each = 10000e18 * 5000 * 2 / 10000 = 10 000e18
    // tradingFee each = 10 000e18 * 10 / 10000 = 10e18
    // totalTradingFee = 20e18
    // marginForPositions = 9 980e18
    // portions each = 9 980e18 * 5000 / 10000 = 4 990e18

    function testPreviewCopyAllocation_returnsCorrectPortions() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](2);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 5000, isLong: true,  leverage: 2});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 5000, isLong: false, leverage: 2});
        _publishStrategy(allocs);

        uint256 totalMargin = 10_000e18;

        (
            uint256 copyFee,
            uint256 totalTradingFee,
            uint256 marginForPositions,
            uint256[] memory portions
        ) = ct.previewCopyAllocation(alice, totalMargin);

        assertEq(copyFee,            0,        "copyFee should be 0 (no feeRouter)");
        assertEq(totalTradingFee,    20e18,    "totalTradingFee mismatch");
        assertEq(marginForPositions, 9_980e18, "marginForPositions mismatch");
        assertEq(portions.length,    2,        "portions length mismatch");
        assertEq(portions[0],        4_990e18, "portion[0] mismatch");
        assertEq(portions[1],        4_990e18, "portion[1] mismatch");
    }

    // ── Test 4: copyFee is zero when feeRouter is address(0) ─────────────────

    function testPreviewCopyAllocation_zeroFeeWhenNoFeeRouter() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 10_000, isLong: true, leverage: 1});
        _publishStrategy(allocs);

        (uint256 copyFee,,,) = ct.previewCopyAllocation(alice, 10_000e18);
        assertEq(copyFee, 0, "copyFee must be 0 when feeRouter == address(0)");
    }

    // ── Test 5: followTrader reverts when fees exceed margin ──────────────────
    //
    // 100 % weight, 5× leverage (StrategyRegistry MAX_LEVERAGE = 5), tradingFeeBps = 2001
    // weightedNotional = 10 000e18 * 10 000 * 5 / 10 000 = 50 000e18
    // totalTradingFee  = 50 000e18 * 2001 / 10 000 = 10 005e18 > 10 000e18 → revert

    function testFollowTrader_revertWhenFeesExceedMargin() public {
        exchange.setTradingFeeBps(2001);

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 10_000, isLong: true, leverage: 5});
        _publishStrategy(allocs);

        uint256 totalMargin    = 10_000e18;
        uint256 expectedFee    = 10_005e18;   // 50_000e18 * 2001 / 10_000
        uint256 expectedMargin = totalMargin; // netMargin (no copy fee)

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                CopyTracker.TradingFeeExceedsMargin.selector,
                expectedFee,
                expectedMargin
            )
        );
        ct.followTrader(alice, totalMargin);
    }

    // ── Test 6: atomic all-or-nothing — any position failure reverts all ──────
    //
    // 3rd allocation uses ASSET_UNREG which is not in oracle.
    // oracle.getPrice reverts → openPositionFor propagates revert → entire tx undone.

    function testFollowTrader_atomicAllOrNothing() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1,    weight: 4000, isLong: true, leverage: 1});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2,    weight: 3000, isLong: true, leverage: 1});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET_UNREG, weight: 3000, isLong: true, leverage: 1});
        _publishStrategy(allocs);

        uint256 balBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        vm.expectRevert(); // oracle.AssetNotFound propagates
        ct.followTrader(alice, 10_000e18);

        // All state changes rolled back
        assertEq(usdc.balanceOf(bob), balBefore, "USDC should be unchanged after revert");

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        assertEq(recs.length, 0, "no CopyRecord should have been persisted");
    }
}
