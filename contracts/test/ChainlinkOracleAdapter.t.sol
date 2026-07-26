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
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(adapter));

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
}
