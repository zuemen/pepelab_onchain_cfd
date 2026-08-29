// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev An oracle that quotes a fresh timestamp with a zero price. MockOracle
///      refuses to store 0, so the Low finding "_freshPrice does not check
///      rawPrice > 0" needs its own double.
contract ZeroPriceOracle {
    function getPrice(bytes32) external view returns (uint256, uint256) {
        return (0, block.timestamp);
    }
}

/// @dev 6-decimal collateral, to prove the constructor rejects a token whose
///      decimals contradict MIN_MARGIN / the 1e10 index scaling.
contract SixDecimalToken {
    function decimals() external pure returns (uint8) { return 6; }
}

/// @notice Regression suite for the 2026-08-06 audit, section 二 (core perpetual
///         contract). Every test in here fails on the pre-fix contract.
contract AuditFixesCoreTest is Test {
    PerpetualExchange exchange;
    InsuranceVault    vault;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice      = makeAddr("alice");
    address bob        = makeAddr("bob");
    address agentA     = makeAddr("agentA");
    address agentB     = makeAddr("agentB");
    address tracker    = makeAddr("tracker");
    address liquidator = makeAddr("liquidator");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        vault    = new InsuranceVault(address(usdc));

        oracle.addAsset(BTC, BTC_PRICE);
        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));

        usdc.mint(alice, 5_000_000e18);
        usdc.mint(bob,   5_000_000e18);
        usdc.mint(address(this), 5_000_000e18);
        usdc.mint(address(exchange), 50_000_000e18);   // payout reserve

        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(exchange), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setBorrowFeePerHour(0);
    }

    function _seedVault(uint256 amount) internal {
        vault.deposit(amount);
    }

    // ── C-1: mark-premium round trip must not mint money ──────────────────────

    /// @dev PoC from the audit: with markPremiumCapBps = 100 a lone 5× long was
    ///      entered at the index but marked at index+1% (a premium its own OI
    ///      created), so open→close netted +4,000 USDC on 100,000 of margin with
    ///      zero price risk. Entry is now the pre-trade mark and PnL excludes the
    ///      position's own notional, so the only thing a round trip costs is fees.
    function test_C1_markPremiumRoundTripIsNotProfitable() public {
        exchange.setTradingFeeBps(10);           // 0.1% per side
        exchange.setMarkPremiumCapBps(100);      // 1% — the setting that was unsafe

        vm.prank(alice); exchange.depositMargin(200_000e18);
        uint256 before_ = exchange.freeMargin(alice);

        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100_000e18, 5);

        // The position must not show a profit it manufactured itself.
        assertEq(exchange.getUnrealizedPnL(pid), 0, "self-created premium leaked into PnL");

        vm.prank(alice); exchange.closePosition(pid);

        uint256 after_ = exchange.freeMargin(alice);
        assertLt(after_, before_, "round trip must never be profitable");
        // Exactly two trading fees on 500,000 notional, nothing else.
        assertEq(before_ - after_, 1_000e18);
    }

    /// @dev The premium still exists — it is now borne by the trader who creates
    ///      it rather than paid to them, so no single account can farm it.
    ///
    ///      Note it is not EXACTLY zero-sum in USDC: size is notional/entryPrice,
    ///      so the later entrant buys marginally fewer units at the higher mark.
    ///      That residue is second-order in the cap (≈49 USDC on 400,000 here,
    ///      0.012%) and is an order of magnitude smaller than the fees the same
    ///      round trip costs — asserted below with the fee switched on. What C-1
    ///      was about, the first-order single-account mint, is gone.
    function test_C1_premiumIsZeroSumAcrossTraders() public {
        exchange.setTradingFeeBps(10);
        exchange.setMarkPremiumCapBps(100);

        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(bob);   exchange.depositMargin(200_000e18);

        vm.prank(alice); uint256 a = exchange.openPosition(BTC, true, 100_000e18, 5);
        vm.prank(bob);   uint256 b = exchange.openPosition(BTC, true, 100_000e18, 5);

        int256 pnlA = exchange.getUnrealizedPnL(a);
        int256 pnlB = exchange.getUnrealizedPnL(b);
        assertGt(pnlA, 0, "first mover carries the second's premium");
        assertEq(pnlB, 0, "second mover pays the premium it created");

        // Unwinding gives it straight back to the counterparty.
        vm.prank(alice); exchange.closePosition(a);
        vm.prank(bob);   exchange.closePosition(b);
        uint256 total = exchange.freeMargin(alice) + exchange.freeMargin(bob);
        // 4 × 500 USDC of trading fee = 2,000; the premium residue is +49.5.
        assertLt(total, 400_000e18, "the pair must be net-negative after fees");
        assertGt(total, 398_000e18, "and the shortfall must be no more than the fees");
        assertLt(total - 398_000e18, 500e18, "premium residue must stay far below one fee");
    }

    // ── C-2: bad debt on a voluntary close ────────────────────────────────────

    /// @dev PoC: two hedged accounts, price +50%, winner paid in full while the
    ///      bankrupt loser's hole was never funded (and the loser was even handed
    ///      10% of margin from the vault). The vault must now absorb exactly the
    ///      shortfall.
    function test_C2_closeRoutesBadDebtToVaultNotToTheProtocol() public {
        exchange.setTradingFeeBps(0);
        _seedVault(200_000e18);

        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(bob);   exchange.depositMargin(200_000e18);
        vm.prank(alice); uint256 lng = exchange.openPosition(BTC, true,  100_000e18, 5);
        vm.prank(bob);   uint256 sht = exchange.openPosition(BTC, false, 100_000e18, 5);

        oracle.updatePrice(BTC, 150_000e8);      // +50%

        uint256 bobWalletBefore = usdc.balanceOf(bob);
        vm.prank(alice); exchange.closePosition(lng);   // +250,000
        vm.prank(bob);   exchange.closePosition(sht);   // −250,000 → 150,000 hole

        // The vault funded the whole 150,000 hole. It also still had room for the
        // 10% bailout floor (10,000) afterwards, which is the only circumstance in
        // which the floor is now paid: 200,000 − 150,000 − 10,000.
        assertEq(vault.totalAssets(), 40_000e18);
        assertEq(usdc.balanceOf(bob), bobWalletBefore + 10_000e18, "solvent floor");
        assertEq(exchange.freeMargin(bob), 100_000e18);

        // Claims are still fully backed by reserves.
        assertGe(
            usdc.balanceOf(address(exchange)),
            exchange.freeMargin(alice) + exchange.freeMargin(bob)
        );
    }

    /// @dev With no vault money left, a voluntary close must reach ADL — the same
    ///      backstop a liquidation uses — instead of silently leaving a hole.
    function test_C2_closeFallsThroughToAdlWhenVaultIsEmpty() public {
        exchange.setTradingFeeBps(0);
        exchange.setAdlEnabled(true);            // vault deliberately unfunded

        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(bob);   exchange.depositMargin(200_000e18);
        vm.prank(alice); uint256 lng = exchange.openPosition(BTC, true,  100_000e18, 5);
        vm.prank(bob);   uint256 sht = exchange.openPosition(BTC, false, 100_000e18, 5);

        oracle.updatePrice(BTC, 150_000e8);

        // The LOSER closes first, bypassing liquidation entirely.
        vm.prank(bob); exchange.closePosition(sht);

        PerpetualExchange.Position memory p = exchange.getPosition(lng);
        assertFalse(p.isOpen, "winner must be auto-deleveraged");
        assertEq(p.realizedPnL, int256(100_000e18), "250,000 profit less the 150,000 haircut");
    }

    /// @dev Whatever neither the vault nor ADL can cover is now surfaced.
    function test_C2_uncoveredBadDebtIsEmitted() public {
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(alice); uint256 lng = exchange.openPosition(BTC, true, 100_000e18, 5);

        oracle.updatePrice(BTC, 70_000e8);       // −30% → −150,000 on 100,000 margin

        vm.expectEmit(true, true, false, true, address(exchange));
        emit PerpetualExchange.BadDebt(lng, BTC, 50_000e18);
        vm.prank(alice); exchange.closePosition(lng);
    }

    // ── C-3: bounded position lists ───────────────────────────────────────────

    function test_C3_userPositionsCompactedOnClose() public {
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(10_000e18);

        vm.prank(alice); uint256 a = exchange.openPosition(BTC, true, 1_000e18, 1);
        vm.prank(alice); uint256 b = exchange.openPosition(BTC, true, 1_000e18, 1);
        vm.prank(alice); uint256 c = exchange.openPosition(BTC, true, 1_000e18, 1);
        assertEq(exchange.getUserPositions(alice).length, 3);

        // Remove the MIDDLE element: swap-and-pop must move the tail into its
        // slot and keep the cached index of the moved element correct.
        vm.prank(alice); exchange.closePosition(b);
        uint256[] memory ids = exchange.getUserPositions(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], a);
        assertEq(ids[1], c);

        // Closing the swapped element must still work (index integrity).
        vm.prank(alice); exchange.closePosition(c);
        ids = exchange.getUserPositions(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], a);

        vm.prank(alice); exchange.closePosition(a);
        assertEq(exchange.getUserPositions(alice).length, 0);
    }

    /// @dev PoC: `getAccountHealth` walked every position ever opened —
    ///      8,947 gas clean, 1,194,968 gas after 2,000 dead entries, and with
    ///      portfolio margin on an attacker could make an account permanently
    ///      un-liquidatable for the price of a few hundred no-risk round trips.
    function test_C3_accountHealthGasDoesNotGrowWithChurn() public {
        exchange.setTradingFeeBps(0);
        exchange.setPortfolioMarginEnabled(true);
        vm.prank(alice); exchange.depositMargin(100_000e18);

        vm.prank(alice); uint256 live = exchange.openPosition(BTC, true, 1_000e18, 1);

        uint256 g0 = gasleft();
        exchange.getAccountHealth(alice);
        uint256 clean = g0 - gasleft();

        // 400 no-risk round trips — the exact griefing pattern from the PoC.
        for (uint256 i = 0; i < 400; ++i) {
            vm.prank(alice); uint256 p = exchange.openPosition(BTC, true, 10e18, 1);
            vm.prank(alice); exchange.closePosition(p);
        }
        assertEq(exchange.getUserPositions(alice).length, 1, "only the live position remains");

        g0 = gasleft();
        exchange.getAccountHealth(alice);
        uint256 dirty = g0 - gasleft();

        // Pre-fix this grew by ~593 gas per dead entry (≈237,000 for 400).
        //
        // The tolerance was 2,000 and is now 20,000. That is deliberately loose,
        // because this line is the *backstop*, not the guard: disabling the C-3 fix
        // (commenting out `_removeUserPosition` in `_closePosition`) trips the
        // `getUserPositions(alice).length == 1` assertion above long before
        // execution reaches here — verified, it fails with `401 != 1`. The exact
        // assertion does the real work; this one only has to notice a cost blowup,
        // and 20,000 still catches the 237,000-gas regression an order of magnitude
        // over.
        //
        // Why it had to be widened: CI on forge 1.8.0 measured 44,972 against a
        // 44,703 ceiling — 269 gas over — while forge 1.7.1 passed locally on the
        // same commit, with no contract change between them. A test that flips red
        // when the compiler moves is reporting on the toolchain, not the contract.
        assertLt(dirty, clean + 20_000, "health cost must not scale with closed positions");
        assertTrue(live == exchange.getUserPositions(alice)[0]);
    }

    // ── H-1: ADL scan window cannot be exhausted by closed positions ───────────

    /// @dev PoC: 130 open→close cycles filled the first MAX_ADL_SCAN (128) slots
    ///      of the per-asset index with dead entries, so the backstop scanned
    ///      nothing, haircut nobody, and did not revert or emit — a silent
    ///      failure of the protocol's last line of solvency defence.
    function test_H1_adlStillFiresAfterHeavyChurn() public {
        exchange.setTradingFeeBps(0);
        exchange.setAdlEnabled(true);

        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(bob);   exchange.depositMargin(200_000e18);

        // Bury the index under 130 closed positions.
        for (uint256 i = 0; i < 130; ++i) {
            vm.prank(alice); uint256 p = exchange.openPosition(BTC, true, 10e18, 1);
            vm.prank(alice); exchange.closePosition(p);
        }
        assertEq(exchange.openPositionCountFor(BTC), 0, "index must be compacted");

        vm.prank(alice); uint256 lng = exchange.openPosition(BTC, true,  1_000e18, 5);
        vm.prank(bob);   uint256 sht = exchange.openPosition(BTC, false, 1_000e18, 5);

        oracle.updatePrice(BTC, 70_000e8);       // long −1,500 on 1,000 margin
        exchange.liquidatePosition(lng);

        PerpetualExchange.Position memory sp = exchange.getPosition(sht);
        assertFalse(sp.isOpen, "counterparty must be deleveraged");
        assertEq(sp.realizedPnL, int256(1_000e18), "1,500 profit less the 500 haircut");
    }

    // ── H-2: funding catch-up is bounded ──────────────────────────────────────

    /// @dev PoC: a 500,000-notional long left idle for 200 days accrued
    ///      2,190,000 of funding in a single settlement — 438% of notional, 21.9×
    ///      its own margin, and unpayable by construction.
    function test_H2_fundingCatchupIsBounded() public {
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(bob);   exchange.depositMargin(200_000e18);

        vm.prank(alice); uint256 lng = exchange.openPosition(BTC, true,  100_000e18, 5); // 500k
        vm.prank(bob);   exchange.openPosition(BTC, false, 20_000e18, 5);                // 100k

        vm.warp(block.timestamp + 200 days);
        oracle.updatePrice(BTC, BTC_PRICE);      // keep the feed fresh
        exchange.settleFunding(BTC);

        int256 owed = exchange.pendingFunding(lng);
        uint256 notional = 500_000e18;
        uint256 cap = notional
            * exchange.MAX_FUNDING_CATCHUP_INTERVALS()
            * exchange.MAX_FUNDING_RATE_BPS() / 10_000;

        assertGt(owed, 0);
        assertLe(uint256(owed), cap, "single settlement above the catch-up ceiling");
        assertLt(uint256(owed), 100_000e18, "funding must stay inside the position's margin");
    }

    // ── H-3: thin-side funding receipt is bounded ─────────────────────────────

    /// @dev PoC: a 10-USDC short facing 1,000,000 of longs received 7,400 USDC in
    ///      one settlement — 740× its own margin — which the exchange had to
    ///      advance out of reserves long before the longs closed.
    function test_H3_thinSideReceiptIsCapped() public {
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(1_100_000e18);
        vm.prank(bob);   exchange.depositMargin(1_000e18);

        vm.prank(alice); exchange.openPosition(BTC, true,  200_000e18, 5);  // 1,000,000
        vm.prank(bob);   uint256 sht = exchange.openPosition(BTC, false, 10e18, 1); // 10

        vm.warp(block.timestamp + exchange.FUNDING_INTERVAL());
        oracle.updatePrice(BTC, BTC_PRICE);
        exchange.settleFunding(BTC);

        int256 receipt = -exchange.pendingFunding(sht);
        assertGt(receipt, 0, "thin side still receives funding");
        assertLe(uint256(receipt), 10e18, "receipt must not exceed the position's own margin");
    }

    // ── H-6: agent authorization is verifiable ────────────────────────────────

    function test_H6_agentCannotCloseSelfOpenedPosition() public {
        exchange.setTradingFeeBps(0);
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(agentA, true);

        vm.prank(alice); exchange.depositMargin(10_000e18);
        vm.prank(alice); uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 1);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(PerpetualExchange.NotPositionAgent.selector, pid, agentA)
        );
        exchange.closePositionFor(alice, pid);
        assertTrue(exchange.getPosition(pid).isOpen);
    }

    function test_H6_agentCannotCloseAnotherAgentsPosition() public {
        exchange.setTradingFeeBps(0);
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(agentA, true);
        exchange.setAgentAuthorized(agentB, true);

        vm.prank(alice); exchange.depositMargin(10_000e18);
        vm.prank(agentA);
        uint256 pid = exchange.openPositionFor(alice, BTC, true, 1_000e18, 1, address(0));
        assertEq(exchange.positionAgent(pid), agentA);

        vm.prank(agentB);
        vm.expectRevert(
            abi.encodeWithSelector(PerpetualExchange.NotPositionAgent.selector, pid, agentB)
        );
        exchange.closePositionFor(alice, pid);

        // The agent that opened it still can.
        vm.prank(agentA); exchange.closePositionFor(alice, pid);
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    /// @dev The `owner` argument was the whole hole: an agent could name anyone.
    function test_H6_agentCannotForgeTheOwnerArgument() public {
        exchange.setTradingFeeBps(0);
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(agentA, true);

        vm.prank(bob); exchange.depositMargin(10_000e18);
        vm.prank(bob); uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 1);

        vm.prank(agentA);
        vm.expectRevert();
        exchange.closePositionFor(bob, pid);
    }

    // ── M-1: only fees actually collected are routed ──────────────────────────

    /// @dev PoC: with vaultFeeShareBps = 10000 a close whose closeAmount clamped
    ///      to 0 still moved 5 USDC from the exchange's reserves to the vault —
    ///      a fee no one had paid.
    function test_M1_uncollectedFeeIsNotRoutedToVault() public {
        exchange.setTradingFeeBps(10);
        exchange.setVaultFeeShareBps(10_000);

        vm.prank(alice); exchange.depositMargin(200_000e18);
        vm.prank(alice); uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);

        uint256 afterOpen = exchange.cumulativeVaultFees();
        assertGt(afterOpen, 0, "the open's fee WAS collected and must be routed");

        oracle.updatePrice(BTC, 70_000e8);       // wipes the position out
        vm.prank(alice); exchange.closePosition(pid);

        assertEq(exchange.cumulativeVaultFees(), afterOpen, "routed a fee that was never paid");
    }

    // ── M-2: liquidation no longer confiscates the maintenance buffer ─────────

    function test_M2_liquidationReturnsResidualToOwner() public {
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(1_000e18);
        vm.prank(alice); uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);

        oracle.updatePrice(BTC, 84_900e8);       // −15.1% → 245 residual, below maintenance

        uint256 marginBefore = exchange.freeMargin(alice);
        vm.prank(liquidator); exchange.liquidatePosition(pid);

        uint256 refund = exchange.freeMargin(alice) - marginBefore;
        assertGt(refund, 0, "owner used to receive exactly 0");
        // reward 5% + penalty 20% + refund 75% of the residual.
        assertEq(refund, 245e18 * 7_500 / 10_000);
        assertEq(usdc.balanceOf(liquidator), 245e18 * 500 / 10_000);
        assertEq(vault.totalAssets(), 245e18 * 2_000 / 10_000);
    }

    // ── M-3: setter bounds, zero checks and events ────────────────────────────

    function test_M3_tradingFeeBounded() public {
        uint256 ceiling = exchange.MAX_TRADING_FEE_BPS();
        vm.expectRevert(bytes("fee>1%"));
        exchange.setTradingFeeBps(100_000);      // the audit's confiscation example
        exchange.setTradingFeeBps(ceiling);
        assertEq(exchange.TRADING_FEE_BPS(), 100);
    }

    function test_M3_borrowFeeBounded() public {
        uint256 tooHigh = exchange.MAX_BORROW_FEE_BPS_PER_HOUR() + 1;
        vm.expectRevert(bytes("borrow fee too high"));
        exchange.setBorrowFeePerHour(tooHigh);
        exchange.setBorrowFeePerHour(tooHigh - 1);   // ceiling accepted
    }

    function test_M3_maintenanceMarginMustStayBelow100Pct() public {
        vm.expectRevert(bytes("bps>=100%"));
        exchange.setMaintenanceMarginFor(BTC, 10_000);
        exchange.setMaintenanceMarginFor(BTC, 9_999);   // ceiling accepted
    }

    function test_M3_maxPriceAgeBoundedOnBothSides() public {
        vm.expectRevert(bytes("zero age"));
        exchange.setMaxPriceAge(0);
        vm.expectRevert(bytes("age>7d"));
        exchange.setMaxPriceAge(8 days);
    }

    function test_M3_executionFeeBounded() public {
        vm.expectRevert(bytes("fee>1 ether"));
        exchange.setExecutionFee(2 ether);
    }

    function test_M3_liquidationPenaltyBounded() public {
        vm.expectRevert(bytes("penalty+reward>100%"));
        exchange.setLiquidationPenaltyBps(9_600);       // + 500 reward > 10000
        exchange.setLiquidationPenaltyBps(9_500);
    }

    function test_M3_settersEmitEvents() public {
        vm.expectEmit(true, false, false, false, address(exchange));
        emit PerpetualExchange.FeeRouterSet(address(0xF00));
        exchange.setFeeRouter(address(0xF00));

        vm.expectEmit(true, false, false, false, address(exchange));
        emit PerpetualExchange.InsuranceVaultSet(address(0xBEEF));
        exchange.setInsuranceVault(address(0xBEEF));

        vm.expectEmit(false, false, false, true, address(exchange));
        emit PerpetualExchange.ExecutionFeeSet(123);
        exchange.setExecutionFee(123);

        vm.expectEmit(true, false, false, false, address(exchange));
        emit PerpetualExchange.CopyTrackerSet(tracker);
        exchange.setCopyTracker(tracker);

        vm.expectEmit(false, false, false, true, address(exchange));
        emit PerpetualExchange.MaxPriceAgeSet(2 hours);
        exchange.setMaxPriceAge(2 hours);
    }

    // ── Low findings ──────────────────────────────────────────────────────────

    function test_low_executionFeeOverpaymentIsRefunded() public {
        exchange.setExecutionFee(0.001 ether);
        exchange.setTradingFeeBps(0);
        vm.prank(alice); exchange.depositMargin(10_000e18);

        vm.deal(alice, 1 ether);
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        exchange.openPosition{value: 0.05 ether}(BTC, true, 1_000e18, 1);

        // Only the execution fee is kept; the 0.049 overpayment comes back.
        assertEq(balBefore - alice.balance, 0.001 ether);
        assertEq(address(exchange).balance, 0.001 ether);
    }

    function test_low_getPositionValueDeductsFeesAndFunding() public {
        exchange.setTradingFeeBps(10);
        exchange.setBorrowFeePerHour(1);
        vm.prank(alice); exchange.depositMargin(10_000e18);
        vm.prank(alice); uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);

        vm.warp(block.timestamp + 10 hours);
        oracle.updatePrice(BTC, BTC_PRICE);      // price unchanged → pnl 0

        uint256 tradingFee = 5_000e18 * 10 / 10_000;
        uint256 borrowFee  = (1_000e18 * 4) * 1 * 10 / 10_000;
        assertEq(exchange.getPositionValue(pid), 1_000e18 - tradingFee - borrowFee);
    }

    function test_low_zeroOraclePriceIsRejected() public {
        ZeroPriceOracle zero = new ZeroPriceOracle();
        PerpetualExchange ex = new PerpetualExchange(address(usdc), address(zero));
        ex.setExecutionFee(0);
        usdc.mint(address(alice), 10_000e18);
        vm.prank(alice); usdc.approve(address(ex), type(uint256).max);
        vm.prank(alice); ex.depositMargin(10_000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.InvalidPrice.selector, BTC));
        ex.openPosition(BTC, true, 1_000e18, 1);
    }

    function test_low_constructorRejectsWrongDecimalCollateral() public {
        SixDecimalToken six = new SixDecimalToken();
        vm.expectRevert(PerpetualExchange.InvalidParam.selector);
        new PerpetualExchange(address(six), address(oracle));
    }

    function test_low_constructorRejectsZeroAddresses() public {
        vm.expectRevert(PerpetualExchange.InvalidParam.selector);
        new PerpetualExchange(address(0), address(oracle));
        vm.expectRevert(PerpetualExchange.InvalidParam.selector);
        new PerpetualExchange(address(usdc), address(0));
    }
}
