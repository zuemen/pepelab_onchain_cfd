// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PythOracleAdapter.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "./MockPyth.sol";

/// @notice Phase 3: Pyth-backed oracle adapter (drop-in IOracle) for synthetic assets.
contract PythOracleAdapterTest is Test {
    PythOracleAdapter adapter;
    MockPyth          pyth;
    address stranger = makeAddr("stranger");

    bytes32 constant AAPL = keccak256("AAPL");
    bytes32 constant AAPL_PYTH_ID = keccak256("AAPL/USD"); // stand-in price id

    function setUp() public {
        pyth    = new MockPyth();
        adapter = new PythOracleAdapter(address(pyth));
    }

    // ── setPriceId access control ──────────────────────────────────────────

    function test_setPriceId_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
    }

    function test_setPriceId_setsAndEmits() public {
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        assertEq(adapter.priceIds(AAPL), AAPL_PYTH_ID);
    }

    // ── exponent normalization ─────────────────────────────────────────────

    function test_getPrice_expo8() public {
        // $200 with expo -8 → 200 * 1e8 mantissa → normalized 200e8
        pyth.setPrice(AAPL_PYTH_ID, int64(uint64(200e8)), -8);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        (uint256 price, uint256 ts) = adapter.getPrice(AAPL);
        assertEq(price, 200e8);
        assertEq(ts, block.timestamp);
    }

    function test_getPrice_expo5_scalesUp() public {
        // $1.50 with expo -5 → mantissa 150000 → normalized 1.5e8
        pyth.setPrice(AAPL_PYTH_ID, int64(150000), -5);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        (uint256 price, ) = adapter.getPrice(AAPL);
        assertEq(price, 150_000_000); // 1.5 * 1e8
    }

    function test_getPrice_expo10_scalesDown() public {
        // mantissa 2000 * 1e10 with expo -10 = $2000 → normalized 2000e8
        pyth.setPrice(AAPL_PYTH_ID, int64(uint64(2000e10)), -10);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        (uint256 price, ) = adapter.getPrice(AAPL);
        assertEq(price, 2_000e8);
    }

    // ── revert paths ───────────────────────────────────────────────────────

    function test_getPrice_revertsPriceIdNotSet() public {
        vm.expectRevert(abi.encodeWithSelector(PythOracleAdapter.PriceIdNotSet.selector, AAPL));
        adapter.getPrice(AAPL);
    }

    function test_getPrice_revertsInvalidPrice() public {
        pyth.setPrice(AAPL_PYTH_ID, int64(0), -8);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        vm.expectRevert(PythOracleAdapter.InvalidPrice.selector);
        adapter.getPrice(AAPL);
    }

    // ── staleness ──────────────────────────────────────────────────────────

    function test_isStale_freshIsFalse() public {
        pyth.setPrice(AAPL_PYTH_ID, int64(uint64(200e8)), -8);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        assertFalse(adapter.isStale(AAPL));
    }

    function test_isStale_oldIsTrue() public {
        pyth.setPrice(AAPL_PYTH_ID, int64(uint64(200e8)), -8);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);
        vm.warp(block.timestamp + 2 days);
        assertTrue(adapter.isStale(AAPL));
    }

    // ── drop-in integration with PerpetualExchange (zero core change) ────────

    function test_dropIn_perpetualExchangeOpensPosition() public {
        MockUSDC usdc = new MockUSDC();
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(adapter));

        pyth.setPrice(AAPL_PYTH_ID, int64(uint64(200e8)), -8);
        adapter.setPriceId(AAPL, AAPL_PYTH_ID);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        address alice = makeAddr("alice");
        usdc.mint(alice, 10_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); exchange.depositMargin(1_000e18);

        vm.prank(alice);
        uint256 pid = exchange.openPosition(AAPL, true, 100e18, 2);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        // entryPrice 18-dec: 200e8 * 1e10 = 200e18
        assertEq(pos.entryPrice, 200e18);
    }
}
