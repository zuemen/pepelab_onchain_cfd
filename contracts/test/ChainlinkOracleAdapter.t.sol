// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ChainlinkOracleAdapter.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "./MockAggregatorV3.sol";

/// @notice Phase 3: Chainlink-backed oracle adapter (drop-in IOracle).
contract ChainlinkOracleAdapterTest is Test {
    ChainlinkOracleAdapter adapter;
    address stranger = makeAddr("stranger");

    bytes32 constant BTC = keccak256("BTC");

    function setUp() public {
        adapter = new ChainlinkOracleAdapter();
    }

    // ── setFeed access control ─────────────────────────────────────────────

    function test_setFeed_onlyOwner() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        vm.prank(stranger);
        vm.expectRevert();
        adapter.setFeed(BTC, address(feed));
    }

    function test_setFeed_setsAndEmits() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        assertEq(adapter.feeds(BTC), address(feed));
    }

    // ── price normalization ────────────────────────────────────────────────

    function test_getPrice_8decimals_passThrough() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        (uint256 price, uint256 ts) = adapter.getPrice(BTC);
        assertEq(price, 100_000e8);
        assertEq(ts, block.timestamp);
    }

    function test_getPrice_normalizesFrom18() public {
        // 18-dec feed reporting $2,000 → 2000e18 should become 2000e8
        MockAggregatorV3 feed = new MockAggregatorV3(18, 2_000e18);
        adapter.setFeed(BTC, address(feed));
        (uint256 price, ) = adapter.getPrice(BTC);
        assertEq(price, 2_000e8);
    }

    function test_getPrice_normalizesFrom6() public {
        // 6-dec feed reporting $1.50 → 1_500_000 should become 1.5e8
        MockAggregatorV3 feed = new MockAggregatorV3(6, 1_500_000);
        adapter.setFeed(BTC, address(feed));
        (uint256 price, ) = adapter.getPrice(BTC);
        assertEq(price, 150_000_000); // 1.5 * 1e8
    }

    // ── revert paths ───────────────────────────────────────────────────────

    function test_getPrice_revertsFeedNotSet() public {
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracleAdapter.FeedNotSet.selector, BTC));
        adapter.getPrice(BTC);
    }

    function test_getPrice_revertsInvalidPrice() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 0);
        adapter.setFeed(BTC, address(feed));
        vm.expectRevert(ChainlinkOracleAdapter.InvalidPrice.selector);
        adapter.getPrice(BTC);
    }

    // ── staleness ──────────────────────────────────────────────────────────

    function test_isStale_freshIsFalse() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        assertFalse(adapter.isStale(BTC));
    }

    function test_isStale_oldIsTrue() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        vm.warp(block.timestamp + 2 days);
        assertTrue(adapter.isStale(BTC));
    }

    // ── drop-in integration with PerpetualExchange (zero core change) ────────

    function test_dropIn_perpetualExchangeOpensPosition() public {
        MockUSDC usdc = new MockUSDC();
        // deploy exchange against the Chainlink adapter instead of MockOracle
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(adapter), address(0));

        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        address alice = makeAddr("alice");
        usdc.mint(alice, 10_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); exchange.depositMargin(1_000e18);

        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100e18, 2);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        // entryPrice is 18-dec: 100_000e8 * 1e10 = 100_000e18
        assertEq(pos.entryPrice, 100_000e18);
    }

    // ── L2 sequencer uptime (opt-in) ───────────────────────────────────────

    /// @dev MockAggregatorV3 reports startedAt == updatedAt, so it doubles as an
    ///      uptime feed: answer 0 = up, 1 = down, updatedAt = status change time.
    function _withSequencer() internal returns (MockAggregatorV3 feed, MockAggregatorV3 seq) {
        vm.warp(10 days);
        feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        seq = new MockAggregatorV3(0, 0);       // up since now
        seq.setUpdatedAt(block.timestamp - 2 hours); // up for 2h > 1h grace
        adapter.setSequencerUptimeFeed(address(seq), 1 hours);
    }

    function test_sequencer_notConfigured_isNoop() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        assertEq(adapter.sequencerUptimeFeed(), address(0));
        (uint256 p, ) = adapter.getPrice(BTC);
        assertEq(p, 100_000e8);
    }

    function test_sequencer_upPastGrace_serves() public {
        _withSequencer();
        (uint256 p, ) = adapter.getPrice(BTC);
        assertEq(p, 100_000e8);
        assertFalse(adapter.isStale(BTC));
    }

    function test_sequencer_down_failsClosed() public {
        (, MockAggregatorV3 seq) = _withSequencer();
        seq.setAnswer(1); // down (setAnswer also stamps updatedAt = now)
        vm.expectRevert(ChainlinkOracleAdapter.SequencerDown.selector);
        adapter.getPrice(BTC);
        assertTrue(adapter.isStale(BTC));
    }

    function test_sequencer_justRecovered_gracePeriodFailsClosed() public {
        (MockAggregatorV3 feed, MockAggregatorV3 seq) = _withSequencer();
        seq.setAnswer(0);                // came back up just now
        feed.setAnswer(90_000e8);        // fresh price posted right after the restart
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.SequencerGracePeriod.selector, block.timestamp, 1 hours)
        );
        adapter.getPrice(BTC);
        assertTrue(adapter.isStale(BTC));

        vm.warp(block.timestamp + 1 hours + 1);
        feed.setAnswer(90_000e8);        // keep the feed itself fresh
        (uint256 p, ) = adapter.getPrice(BTC);
        assertEq(p, 90_000e8);
        assertFalse(adapter.isStale(BTC));
    }

    function test_sequencer_invalidStatusRound_failsClosed() public {
        (, MockAggregatorV3 seq) = _withSequencer();
        seq.setUpdatedAt(0); // startedAt == 0: no valid round
        vm.expectRevert(ChainlinkOracleAdapter.SequencerStatusInvalid.selector);
        adapter.getPrice(BTC);
        assertTrue(adapter.isStale(BTC));
    }

    function test_setSequencerUptimeFeed_boundsAndOwner() public {
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        adapter.setSequencerUptimeFeed(address(1), 1 minutes);
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        adapter.setSequencerUptimeFeed(address(1), 25 hours);
        vm.prank(stranger);
        vm.expectRevert();
        adapter.setSequencerUptimeFeed(address(1), 1 hours);
    }

    // ── per-feed max age (opt-in) ──────────────────────────────────────────

    function test_maxAge_overridesGlobalThreshold() public {
        vm.warp(10 days);
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        adapter.setFeed(BTC, address(feed));
        feed.setUpdatedAt(block.timestamp - 2 hours); // stale under the 1h default

        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.PriceIsStale.selector, BTC, block.timestamp - 2 hours, 1 hours)
        );
        adapter.getPrice(BTC);

        adapter.setMaxAge(BTC, 24 hours); // slow-heartbeat feed
        assertEq(adapter.effectiveMaxAge(BTC), 24 hours);
        (uint256 p, ) = adapter.getPrice(BTC);
        assertEq(p, 100_000e8);
        assertFalse(adapter.isStale(BTC));

        adapter.setMaxAge(BTC, 10 minutes); // tighter than the global default
        assertTrue(adapter.isStale(BTC));

        adapter.setMaxAge(BTC, 0); // clear → back to staleThreshold
        assertEq(adapter.effectiveMaxAge(BTC), 1 hours);
    }

    function test_setMaxAge_bounds() public {
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        adapter.setMaxAge(BTC, 1 minutes);
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        adapter.setMaxAge(BTC, 25 hours);
        vm.prank(stranger);
        vm.expectRevert();
        adapter.setMaxAge(BTC, 1 hours);
    }
}
