// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract FundingTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address owner   = address(this);
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");

    uint256 constant BTC_PRICE = 100_000e8;

    uint256 INTERVAL; // = exchange.FUNDING_INTERVAL()

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));

        oracle.addAsset(BTC, BTC_PRICE);
        oracle.addAsset(ETH, 3_000e8);

        usdc.mint(alice,            1_000_000e18);
        usdc.mint(bob,              1_000_000e18);
        // protocol reserve so profitable closes can be paid out
        usdc.mint(address(exchange), 10_000_000e18);

        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(exchange), type(uint256).max);

        // Disable execution fee so tests don't need to send ETH
        exchange.setExecutionFee(0);

        INTERVAL = exchange.FUNDING_INTERVAL();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        exchange.depositMargin(amount);
    }

    function _open(address user, bytes32 asset, bool isLong, uint256 margin, uint256 lev)
        internal returns (uint256)
    {
        vm.prank(user);
        return exchange.openPosition(asset, isLong, margin, lev);
    }

    function _close(address user, uint256 pid) internal {
        vm.prank(user);
        exchange.closePosition(pid);
    }

    function _settle(bytes32 asset) internal {
        exchange.settleFunding(asset);
    }

    // ── 1. Balanced OI → zero rate ───────────────────────────────────────────

    function testSettleFunding_balanced_zeroRate() public {
        _deposit(alice, 200e18);
        _deposit(bob,   200e18);
        _open(alice, BTC, true,  100e18, 1); // long  100e18 notional
        _open(bob,   BTC, false, 100e18, 1); // short 100e18 notional

        vm.warp(block.timestamp + INTERVAL);
        vm.expectEmit(true, false, false, true);
        emit PerpetualExchange.FundingSettled(BTC, 0, 0);
        _settle(BTC);

        assertEq(exchange.cumulativeFundingIndex(BTC), 0);
    }

    // ── 2. Long-heavy → positive rate (index rises) ──────────────────────────

    function testSettleFunding_longHeavy_positiveRate() public {
        _deposit(alice, 200e18);
        _open(alice, BTC, true, 100e18, 1); // only longs, imbalance = 1

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        // imbalance = 1e18, fundingRateBps = 75, index = 75 * 1e14
        int256 expectedIndex = int256(75) * int256(1e14);
        assertEq(exchange.cumulativeFundingIndex(BTC), expectedIndex);
        assertEq(exchange.getFundingRate(BTC), 75);
    }

    // ── 3. Short-heavy → negative rate (index falls) ─────────────────────────

    function testSettleFunding_shortHeavy_negativeRate() public {
        _deposit(alice, 200e18);
        _open(alice, BTC, false, 100e18, 1); // only shorts, imbalance = -1

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        // imbalance = -1e18, fundingRateBps = -75, index = -75 * 1e14
        int256 expectedIndex = -int256(75) * int256(1e14);
        assertEq(exchange.cumulativeFundingIndex(BTC), expectedIndex);
        assertEq(exchange.getFundingRate(BTC), -75);
    }

    // ── 4. Settle before interval elapses → revert ───────────────────────────

    function testSettleFunding_beforeInterval_revert() public {
        vm.expectRevert(PerpetualExchange.FundingIntervalNotElapsed.selector);
        _settle(BTC);
    }

    // ── 5. Index accumulates across multiple periods ──────────────────────────

    function testFundingAccumulatesOverPeriods() public {
        _deposit(alice, 200e18);
        _open(alice, BTC, true, 100e18, 1);

        // Period 1
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);
        assertEq(exchange.cumulativeFundingIndex(BTC), int256(75) * int256(1e14));

        // Period 2
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);
        assertEq(exchange.cumulativeFundingIndex(BTC), int256(150) * int256(1e14));
    }

    // ── 6. Long pays funding when long-heavy ─────────────────────────────────
    //   margin=100e18, lev=5 → notional=500e18
    //   Only longs → imbalance=1 → fundingRateBps=75
    //   cumulativeIndex = 75e14
    //   fundingPayment = 500e18 * 75e14 / 1e18 = 3.75e18
    //   tradingFee(close) = 500e18 * 10/10000 = 0.5e18
    //   closeAmount = 100e18 + 0 - 0.5e18 - 3.75e18 = 95.75e18

    function testCloseLongPosition_paysFunding_whenLongHeavy() public {
        _deposit(alice, 1_000e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 5);

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        int256 expectedFunding = int256(500e18) * int256(75) * int256(1e14) / int256(1e18);
        // = 500 * 75e14 / 1 = 37500e14 = 3.75e18
        assertEq(exchange.pendingFunding(pid), expectedFunding);

        uint256 fmBefore = exchange.freeMargin(alice);
        _close(alice, pid);
        uint256 received = exchange.freeMargin(alice) - fmBefore;

        // tradingFee = 500e18 * 10/10000 = 5e18/10 = 0.5e18 — wait let me recalc
        // 500e18 * 10 / 10000 = 5000e18/10000 = 0.5e18
        uint256 tradingFee = 500e18 * 10 / 10_000;
        uint256 expected   = 100e18 - tradingFee - uint256(expectedFunding);
        assertEq(received, expected);
    }

    // ── 7. Short receives funding when long-heavy ─────────────────────────────
    //   alice long  200e18 notional (margin=200, lev=1)
    //   bob   short 100e18 notional (margin=100, lev=1)
    //   imbalance = (200-100)*1e18/300 = 333333333333333333
    //   fundingRateBps = 333333333333333333 * 75 / 1e18 = 24 (int div)
    //   cumulativeIndex = 24e14
    //   bob pendingFunding = -(100e18 * 24e14 / 1e18) = -2.4e17  (receives)
    //   bob closeAmount = 100e18 - tradingFee - (-2.4e17) = 100e18 - 0.1e18 + 0.24e18

    function testCloseShortPosition_receivesFunding_whenLongHeavy() public {
        _deposit(alice, 500e18);
        _deposit(bob,   500e18);
        _open(alice, BTC, true,  200e18, 1); // long  200e18 notional
        uint256 bobPid = _open(bob, BTC, false, 100e18, 1); // short 100e18 notional

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        // Compute expected fundingRateBps (same int arithmetic as contract)
        int256 imbalance = (int256(200e18) - int256(100e18)) * int256(1e18)
                         / int256(200e18 + 100e18); // 333333333333333333
        int256 rateBps   = imbalance * int256(75) / int256(1e18); // 24

        int256 bobFunding = exchange.pendingFunding(bobPid);
        // bob is short → pendingFunding is negative (receives)
        int256 expectedBobFunding = -(int256(100e18) * rateBps * int256(1e14) / int256(1e18));
        assertEq(bobFunding, expectedBobFunding);
        assertTrue(bobFunding < 0, "short should receive (negative)");

        uint256 fmBefore = exchange.freeMargin(bob);
        _close(bob, bobPid);
        uint256 received = exchange.freeMargin(bob) - fmBefore;

        uint256 tradingFee  = 100e18 * 10 / 10_000; // 0.1e18
        // closeAmount = 100e18 - tradingFee - fundingPayment
        // fundingPayment is negative, so we add it
        int256 expectedClose = int256(100e18) - int256(tradingFee) - bobFunding;
        assertEq(int256(received), expectedClose);
    }

    // ── 8. No OI → settle does nothing to index ──────────────────────────────

    function testFundingZero_whenNoOI() public {
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        assertEq(exchange.cumulativeFundingIndex(BTC), 0);
        assertEq(exchange.lastFundingUpdateAt(BTC), block.timestamp);
    }
}
