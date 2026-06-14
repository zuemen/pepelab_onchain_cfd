// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AggregatorOracleAdapter.sol";
import "../src/ChainlinkOracleAdapter.sol";
import "../src/PythOracleAdapter.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "./MockAggregatorV3.sol";
import "./MockPyth.sol";

/// @notice G1: multi-source aggregating oracle (RWA robustness). Source A is a
///         Chainlink-backed adapter, source B a Pyth-backed adapter — both are
///         real PepeLab adapters, so this also proves drop-in compatibility.
contract AggregatorOracleTest is Test {
    AggregatorOracleAdapter agg;
    ChainlinkOracleAdapter chainlink;
    PythOracleAdapter pythAdapter;
    MockAggregatorV3 clFeed;
    MockPyth pyth;

    address stranger = makeAddr("stranger");

    bytes32 constant XAU = keccak256("XAU");
    bytes32 constant PYTH_ID = keccak256("pyth-xau");

    function setUp() public {
        chainlink = new ChainlinkOracleAdapter();
        pyth = new MockPyth();
        pythAdapter = new PythOracleAdapter(address(pyth));

        // $2,650 gold. Chainlink feed (8-dec) + Pyth feed (expo -8).
        clFeed = new MockAggregatorV3(8, 2_650e8);
        chainlink.setFeed(XAU, address(clFeed));
        pyth.setPrice(PYTH_ID, int64(uint64(2_650e8)), -8);
        pythAdapter.setPriceId(XAU, PYTH_ID);

        agg = new AggregatorOracleAdapter(address(chainlink), address(pythAdapter));
    }

    // ── config ───────────────────────────────────────────────────────────────

    function test_setMaxDeviationBps_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        agg.setMaxDeviationBps(50);
    }

    function test_setMaxDeviationBps_updates() public {
        agg.setMaxDeviationBps(250);
        assertEq(agg.maxDeviationBps(), 250);
    }

    function test_defaultDeviationIs1pct() public view {
        assertEq(agg.maxDeviationBps(), 100);
    }

    // ── happy path: both agree → newer wins ────────────────────────────────────

    function test_getPrice_bothAgree_returnsFresh() public view {
        (uint256 price, uint256 ts) = agg.getPrice(XAU);
        assertEq(price, 2_650e8);
        assertEq(ts, block.timestamp);
        assertFalse(agg.isStale(XAU));
    }

    function test_getPrice_withinDeviation_ok() public {
        // Pyth 0.5% higher than Chainlink — under the 1% bound.
        pyth.setPrice(PYTH_ID, int64(uint64(2_663e8)), -8);
        (uint256 price, ) = agg.getPrice(XAU);
        // Both fresh & equal timestamp → newer-or-equal tie goes to source A.
        assertEq(price, 2_650e8);
        assertFalse(agg.isStale(XAU));
    }

    // ── single-source degradation ──────────────────────────────────────────────

    function test_getPrice_degradesWhenChainlinkStale() public {
        // Age the Chainlink feed past its 24h window → only Pyth is live.
        vm.warp(block.timestamp + 2 days);
        pyth.setPublishTime(PYTH_ID, block.timestamp); // refresh Pyth
        (uint256 price, uint256 ts) = agg.getPrice(XAU);
        assertEq(price, 2_650e8);
        assertEq(ts, block.timestamp);
        assertFalse(agg.isStale(XAU));
    }

    function test_getPrice_degradesWhenSourceUnconfigured() public {
        // Asset only configured on Pyth (Chainlink testnets lack equities).
        bytes32 AAPL = keccak256("AAPL");
        bytes32 aaplId = keccak256("pyth-aapl");
        pyth.setPrice(aaplId, int64(uint64(200e8)), -8);
        pythAdapter.setPriceId(AAPL, aaplId);

        (uint256 price, ) = agg.getPrice(AAPL);
        assertEq(price, 200e8);
        assertFalse(agg.isStale(AAPL));
    }

    function test_getPrice_revertsWhenNoSourceLive() public {
        bytes32 UNKNOWN = keccak256("UNKNOWN");
        vm.expectRevert(abi.encodeWithSelector(AggregatorOracleAdapter.NoLiveSource.selector, UNKNOWN));
        agg.getPrice(UNKNOWN);
    }

    // ── deviation guard: disagreement fails closed ─────────────────────────────

    function test_getPrice_deviationExceeded_reverts() public {
        // Pyth 5% above Chainlink — well over the 1% bound.
        pyth.setPrice(PYTH_ID, int64(uint64(2_782e8)), -8);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorOracleAdapter.PriceDeviationTooHigh.selector, XAU, uint256(2_650e8), uint256(2_782e8)
            )
        );
        agg.getPrice(XAU);
        // isStale still reports the divergence without reverting (monitoring).
        assertTrue(agg.isStale(XAU));
    }

    // ── drop-in: exchange rejects a divergent (manipulated) feed ────────────────

    function test_dropIn_exchangeRejectsDivergentFeed() public {
        MockUSDC usdc = new MockUSDC();
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(agg));
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        address alice = makeAddr("alice");
        usdc.mint(alice, 10_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); exchange.depositMargin(1_000e18);

        // Healthy: both feeds agree → open succeeds.
        vm.prank(alice);
        uint256 pid = exchange.openPosition(XAU, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).entryPrice, 2_650e18);

        // One feed manipulated 5% away → aggregator fails closed → open reverts.
        pyth.setPrice(PYTH_ID, int64(uint64(2_782e8)), -8);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorOracleAdapter.PriceDeviationTooHigh.selector, XAU, uint256(2_650e8), uint256(2_782e8)
            )
        );
        exchange.openPosition(XAU, true, 100e18, 2);
    }
}
