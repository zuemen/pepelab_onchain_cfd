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

    // Canonical conservative scenario reused below: longOI 400 / shortOI 100
    //   imbalance = (400-100)/500 = 0.6e18 → payer rate = 0.6 * 75 = 45 bps (exact)
    //   payer (long) per-unit index += 45e14
    //   receiver (short) per-unit index -= 45e14 * longOI/shortOI = 45e14 * 4 = 180e14
    //   Σ longs pay   = 45e14  * 400e18 / 1e18 = 1.8e18
    //   Σ shorts recv = 180e14 * 100e18 / 1e18 = 1.8e18   → conserved exactly

    // ── 1. Balanced OI → zero rate, indices unchanged ────────────────────────

    function testSettleFunding_balanced_zeroRate() public {
        _deposit(alice, 200e18);
        _deposit(bob,   200e18);
        _open(alice, BTC, true,  100e18, 1); // long  100e18 notional
        _open(bob,   BTC, false, 100e18, 1); // short 100e18 notional

        vm.warp(block.timestamp + INTERVAL);
        vm.expectEmit(true, false, false, true);
        emit PerpetualExchange.FundingSettled(BTC, 0, 0, 0);
        _settle(BTC);

        assertEq(exchange.cumulativeFundingIndexLong(BTC),  0);
        assertEq(exchange.cumulativeFundingIndexShort(BTC), 0);
        assertEq(exchange.getFundingRate(BTC), 0);
    }

    // ── 2. Long-heavy → longs pay (index rises), shorts receive (index falls) ─

    function testSettleFunding_longHeavy_longsPayShortsReceive() public {
        _deposit(alice, 500e18);
        _deposit(bob,   500e18);
        _open(alice, BTC, true,  400e18, 1); // long  400 notional
        _open(bob,   BTC, false, 100e18, 1); // short 100 notional

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        assertEq(exchange.getFundingRate(BTC), 45);
        assertEq(exchange.cumulativeFundingIndexLong(BTC),   int256(45)  * int256(1e14));
        assertEq(exchange.cumulativeFundingIndexShort(BTC), -int256(180) * int256(1e14));
    }

    // ── 3. Short-heavy → shorts pay (index rises), longs receive (index falls) ─

    function testSettleFunding_shortHeavy_shortsPayLongsReceive() public {
        _deposit(alice, 500e18);
        _deposit(bob,   500e18);
        _open(alice, BTC, false, 400e18, 1); // short 400 notional
        _open(bob,   BTC, true,  100e18, 1); // long  100 notional

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        assertEq(exchange.getFundingRate(BTC), -45);
        assertEq(exchange.cumulativeFundingIndexShort(BTC),  int256(45)  * int256(1e14));
        assertEq(exchange.cumulativeFundingIndexLong(BTC),  -int256(180) * int256(1e14));
    }

    // ── 4. Settle before interval elapses → revert ───────────────────────────

    function testSettleFunding_beforeInterval_revert() public {
        vm.expectRevert(PerpetualExchange.FundingIntervalNotElapsed.selector);
        _settle(BTC);
    }

    // ── 5. Indices accumulate across multiple periods ─────────────────────────

    function testFundingAccumulatesOverPeriods() public {
        _deposit(alice, 500e18);
        _deposit(bob,   500e18);
        _open(alice, BTC, true,  400e18, 1);
        _open(bob,   BTC, false, 100e18, 1);

        // Period 1
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC), int256(45) * int256(1e14));

        // Period 2
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);
        assertEq(exchange.cumulativeFundingIndexLong(BTC),  int256(90)  * int256(1e14));
        assertEq(exchange.cumulativeFundingIndexShort(BTC), -int256(360) * int256(1e14));
    }

    // ── 6. Long pays funding when long-heavy (canonical scenario) ─────────────
    //   alice long: margin=100, lev=4 → notional=400 ; bob short: notional=100
    //   rate=45 → alice funding = 400e18 * 45e14 / 1e18 = 1.8e18

    function testCloseLongPosition_paysFunding_whenLongHeavy() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   1_000e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 4); // long  notional 400
        _open(bob,   BTC, false, 100e18, 1);              // short notional 100

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        int256 expectedFunding = int256(400e18) * int256(45) * int256(1e14) / int256(1e18); // 1.8e18
        assertEq(exchange.pendingFunding(pid), expectedFunding);

        uint256 fmBefore = exchange.freeMargin(alice);
        _close(alice, pid);
        uint256 received = exchange.freeMargin(alice) - fmBefore;

        uint256 tradingFee = 400e18 * 10 / 10_000;  // 0.4e18
        uint256 borrowed   = 100e18 * (4 - 1);      // 300e18
        uint256 hoursEl    = INTERVAL / 3600;       // 8h
        uint256 borrowFee  = borrowed * exchange.BORROW_FEE_BPS_PER_HOUR() * hoursEl / 10_000;
        uint256 expected   = 100e18 - tradingFee - borrowFee - uint256(expectedFunding);
        assertEq(received, expected);
    }

    // ── 7. Short receives EXACTLY what the long pays (conservation) ────────────

    function testCloseShortPosition_receivesFunding_whenLongHeavy() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   1_000e18);
        uint256 alicePid = _open(alice, BTC, true,  100e18, 4); // long  400
        uint256 bobPid   = _open(bob,   BTC, false, 100e18, 1); // short 100

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        int256 aliceFunding = exchange.pendingFunding(alicePid); // +1.8e18 (pays)
        int256 bobFunding   = exchange.pendingFunding(bobPid);   // -1.8e18 (receives)
        assertEq(aliceFunding,  int256(18e17));
        assertEq(bobFunding,   -int256(18e17));
        assertTrue(bobFunding < 0, "short should receive (negative)");
        // conservation: long pays exactly what short receives
        assertEq(aliceFunding, -bobFunding);

        uint256 fmBefore = exchange.freeMargin(bob);
        _close(bob, bobPid);
        uint256 received = exchange.freeMargin(bob) - fmBefore;

        uint256 tradingFee  = 100e18 * 10 / 10_000; // 0.1e18
        // closeAmount = 100e18 - tradingFee - fundingPayment (negative → adds back)
        int256 expectedClose = int256(100e18) - int256(tradingFee) - bobFunding;
        assertEq(int256(received), expectedClose);
    }

    // ── 8. No OI → settle does nothing to either index ────────────────────────

    function testFundingZero_whenNoOI() public {
        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        assertEq(exchange.cumulativeFundingIndexLong(BTC),  0);
        assertEq(exchange.cumulativeFundingIndexShort(BTC), 0);
        assertEq(exchange.lastFundingUpdateAt(BTC), block.timestamp);
    }

    // ── 9. Economic sanity: per-interval rate bounded by the cap ──────────────
    //   A strongly imbalanced (but two-sided) market approaches the cap. The cap
    //   (75 bps / 8h) bounds daily funding to 2.25%/day — well under the 10% ceiling.
    function testFunding_dailyRate_isEconomicallySane() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   1_000e18);
        _open(alice, BTC, true,  900e18, 1); // long  900
        _open(bob,   BTC, false, 100e18, 1); // short 100 → imbalance 0.8 → rate 60

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        int256 ratePerInterval = exchange.getFundingRate(BTC);
        assertEq(ratePerInterval, 60);
        assertLe(ratePerInterval, int256(exchange.MAX_FUNDING_RATE_BPS()),
            "per-interval funding above cap");

        // Daily funding projected at the *cap* = cap * (1 day / interval).
        uint256 intervalsPerDay = 1 days / exchange.FUNDING_INTERVAL();
        uint256 dailyAtCap = exchange.MAX_FUNDING_RATE_BPS() * intervalsPerDay;
        assertEq(dailyAtCap, 225, "daily funding at cap should be 2.25%/day");
        assertLe(dailyAtCap, 1000, "daily funding cap must stay <= 10%/day");
    }

    // ── 10. Conservation: Σ longs pay == Σ shorts receive ─────────────────────

    function testFunding_conserved_longsPayEqualsShortsReceive() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   1_000e18);
        uint256 longPid  = _open(alice, BTC, true,  400e18, 1); // long  400
        uint256 shortPid = _open(bob,   BTC, false, 100e18, 1); // short 100

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        // aggregate owed by each side via the per-side index identity:
        //   longOI × ΔlongIndex == −(shortOI × ΔshortIndex)
        int256 longIdx  = exchange.cumulativeFundingIndexLong(BTC);
        int256 shortIdx = exchange.cumulativeFundingIndexShort(BTC);
        int256 longsPay      = int256(400e18) * longIdx  / int256(1e18); // > 0
        int256 shortsReceive = int256(100e18) * shortIdx / int256(1e18); // < 0
        assertGt(longsPay, 0);
        assertEq(longsPay, -shortsReceive); // strict conservation

        // one position per side → equals each position's funding
        assertEq(exchange.pendingFunding(longPid),  longsPay);
        assertEq(exchange.pendingFunding(shortPid), shortsReceive);
    }

    // ── 11. Degenerate one-sided market → no counterparty → no funding ────────

    function testFunding_oneSided_noFunding() public {
        _deposit(alice, 500e18);
        uint256 pid = _open(alice, BTC, true, 100e18, 1); // longs only, no shorts

        vm.warp(block.timestamp + INTERVAL);
        _settle(BTC);

        assertEq(exchange.getFundingRate(BTC), 0);
        assertEq(exchange.cumulativeFundingIndexLong(BTC),  0);
        assertEq(exchange.cumulativeFundingIndexShort(BTC), 0);
        assertEq(exchange.pendingFunding(pid), 0);
    }
}
