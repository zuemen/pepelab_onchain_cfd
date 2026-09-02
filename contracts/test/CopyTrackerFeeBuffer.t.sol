// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/ESGRegistryV2.sol";
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
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
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
    // Strategy: 40 % ASSET1 long 2×, 30 % ASSET2 short 2×, 30 % ASSET3 long 2×
    // (#97: at least 3 allocations required; leverage kept uniform at 2× so
    // total notional — and so total fee — is unaffected by exactly how the
    // 100% is split across three legs, keeping this arithmetic easy to audit)
    // netMargin = 10 000e18 (no copy fee)
    // total notional = netMargin * 10000 * 2 / 10000 = 20 000e18, independent of split
    // totalTradingFee = 20 000e18 * 10 / 10000 = 20e18
    // marginForPositions = 9 980e18
    // portion[0] = 9 980e18 * 4000 / 10000 = 3 992e18
    // portion[1] = portion[2] = 9 980e18 * 3000 / 10000 = 2 994e18

    function testPreviewCopyAllocation_returnsCorrectPortions() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 4000, isLong: true,  leverage: 2});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 3000, isLong: false, leverage: 2});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET3, weight: 3000, isLong: true,  leverage: 2});
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
        assertEq(portions.length,    3,        "portions length mismatch");
        assertEq(portions[0],        3_992e18, "portion[0] mismatch");
        assertEq(portions[1],        2_994e18, "portion[1] mismatch");
        assertEq(portions[2],        2_994e18, "portion[2] mismatch");
    }

    // ── Test 4: copyFee is zero when feeRouter is address(0) ─────────────────

    function testPreviewCopyAllocation_zeroFeeWhenNoFeeRouter() public {
        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 4_000, isLong: true, leverage: 1});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 3_000, isLong: true, leverage: 1});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET3, weight: 3_000, isLong: true, leverage: 1});
        _publishStrategy(allocs);

        (uint256 copyFee,,,) = ct.previewCopyAllocation(alice, 10_000e18);
        assertEq(copyFee, 0, "copyFee must be 0 when feeRouter == address(0)");
    }

    // ── Test 5: the fee can no longer be raised to a margin-eating level ──────
    //
    // Originally this test set tradingFeeBps = 2001 to reach CopyTracker's
    // `TradingFeeExceedsMargin` guard (lev 5 × 2001 bps > 100% of margin).
    // M-3 caps `setTradingFeeBps` at MAX_TRADING_FEE_BPS = 100, so that state is
    // now unreachable by construction: with the maximum leverage of 5 the fee can
    // consume at most 5% of a follower's margin. The guard stays as
    // defence-in-depth; what is worth asserting is the bound that makes it
    // unreachable, since an unbounded fee setter was itself the vulnerability.

    function testSetTradingFeeBps_boundedSoFeesCannotExceedMargin() public {
        vm.expectRevert(bytes("fee>1%"));
        exchange.setTradingFeeBps(2001);

        // The ceiling itself is accepted, and even at the ceiling a 5× copy
        // allocation costs 5% of margin — far below the guard's trigger.
        // #97: split across 3 legs (StrategyRegistry's new minimum) at the
        // same 5× leverage throughout, so total notional — and so total fee
        // — is unaffected by exactly how the weight is divided.
        exchange.setTradingFeeBps(exchange.MAX_TRADING_FEE_BPS());

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: ASSET1, weight: 4_000, isLong: true, leverage: 5});
        allocs[1] = StrategyRegistry.Allocation({asset: ASSET2, weight: 3_000, isLong: true, leverage: 5});
        allocs[2] = StrategyRegistry.Allocation({asset: ASSET3, weight: 3_000, isLong: true, leverage: 5});
        _publishStrategy(allocs);

        uint256 totalMargin = 10_000e18;
        (, uint256 totalTradingFee, uint256 marginForPositions,) =
            ct.previewCopyAllocation(alice, totalMargin);
        assertEq(totalTradingFee, 500e18, "5x at 1% = 5% of margin");
        assertLt(totalTradingFee, totalMargin, "guard can no longer be reached");
        assertGt(marginForPositions, 0);

        vm.prank(bob);
        ct.followTrader(alice, totalMargin); // succeeds
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

    // ── Test 7: the actual bug #97 exists to fix ──────────────────────────────
    //
    // A strategy mixing a High-tier (carbon-expensive) asset with Low-tier
    // (carbon-cheap) ones, on a deployment where carbon pricing is ACTIVE
    // (unlike every other test in this file, which uses esgRegistry ==
    // address(0)). Before #97, CopyTracker sized its whole fee buffer off
    // `exchange.TRADING_FEE_BPS()` — a single global number that, on a
    // carbon-active deployment, isn't even consulted for real pricing
    // anymore (see PerpetualExchange's own NatSpec on that getter post-#96).
    // That buffer would have been sized far too small for the High-tier leg,
    // and the position for it would have failed InsufficientFreeMargin
    // partway through followTrader's loop — succeeding for the cheap legs,
    // failing on the expensive one, exactly the "works in the demo until it
    // doesn't" failure this ticket's own description names.

    function testFollowTrader_mixedCarbonTiers_bufferIsSufficient() public {
        // Everything BUT the strategy registry differs from this file's other
        // tests (a real esgRegistry needs wiring in), so only those pieces
        // get fresh instances. `registry` is the shared one from setUp, where
        // alice is already a registered trader — StrategyRegistry has no
        // dependency on which exchange/copy-tracker it's paired with.
        MockUSDC usdc2 = new MockUSDC();
        MockOracle oracle2 = new MockOracle();
        ESGRegistryV2 esg2 = new ESGRegistryV2(address(this));
        PerpetualExchange exchange2 = new PerpetualExchange(address(usdc2), address(oracle2), address(esg2));
        CopyTracker ct2 = new CopyTracker(address(usdc2), address(exchange2), address(registry), address(0), address(0));

        bytes32 HIGH = keccak256("sHIGH");
        bytes32 LOW  = keccak256("sLOW");
        bytes32 LOW2 = keccak256("sLOW2"); // distinct from LOW — StrategyRegistry now rejects a repeated asset
        address attestor = makeAddr("attestor97");
        bytes32 src = keccak256("https://example.com/97|2026-09-02");

        esg2.grantRole(esg2.ATTESTOR_ROLE(), attestor);
        vm.startPrank(attestor);
        esg2.attest(HIGH, 20e18, 10, 10, 10, src);  // > 8 tCO2e/$M -> High tier, 100 bps
        esg2.attest(LOW, 0.2e18, 10, 10, 10, src);  // < 1 tCO2e/$M -> Low tier, 10 bps
        esg2.attest(LOW2, 0.2e18, 10, 10, 10, src); // < 1 tCO2e/$M -> Low tier, 10 bps
        vm.stopPrank();

        assertEq(exchange2.tradingFeeBpsForAsset(HIGH), 100, "sanity: HIGH really is High tier");
        assertEq(exchange2.tradingFeeBpsForAsset(LOW), 10, "sanity: LOW really is Low tier");
        assertEq(exchange2.tradingFeeBpsForAsset(LOW2), 10, "sanity: LOW2 really is Low tier");

        oracle2.addAsset(HIGH, PRICE);
        oracle2.addAsset(LOW, PRICE);
        oracle2.addAsset(LOW2, PRICE);
        exchange2.setCopyTracker(address(ct2));
        exchange2.setExecutionFee(0);

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](3);
        allocs[0] = StrategyRegistry.Allocation({asset: HIGH, weight: 4_000, isLong: true, leverage: 1});
        allocs[1] = StrategyRegistry.Allocation({asset: LOW,  weight: 3_000, isLong: true, leverage: 1});
        allocs[2] = StrategyRegistry.Allocation({asset: LOW2, weight: 3_000, isLong: true, leverage: 1});
        vm.prank(alice);
        registry.publishStrategy(allocs);

        uint256 totalMargin = 10_000e18;

        // Correct, per-allocation buffer: 4000e18@100bps + 3000e18@10bps*2
        // = 40e18 + 3e18 + 3e18 = 46e18. This is the exact value the pre-#97
        // formula (the WHOLE notional at one legacy global rate — 10 bps,
        // which this carbon-active deployment doesn't even charge for real —
        // would have under-reserved to 10e18): the equality below is itself
        // the proof, and the end-to-end followTrader call further down is the
        // proof that under-reservation would actually have broken execution.
        (, uint256 totalTradingFee,,) = ct2.previewCopyAllocation(alice, totalMargin);
        assertEq(totalTradingFee, 46e18, "per-allocation buffer must price the High leg at its real rate");

        usdc2.mint(bob, 1_000_000e18);
        usdc2.mint(address(exchange2), 1_000_000e18);
        vm.prank(bob); usdc2.approve(address(ct2), type(uint256).max);

        // The actual proof: this must succeed all the way through, not just
        // the first (cheap) legs before failing on the expensive one.
        vm.prank(bob);
        ct2.followTrader(alice, totalMargin);

        CopyTracker.CopyRecord[] memory recs = ct2.getCopyRecords(bob);
        assertEq(recs[0].positionIds.length, 3, "all three legs, including the High-tier one, must have opened");
        for (uint256 i; i < 3; ++i) {
            assertTrue(exchange2.getPosition(recs[0].positionIds[i]).isOpen, "every leg must be open");
        }
    }
}
