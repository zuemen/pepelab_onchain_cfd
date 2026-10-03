// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

/// @dev 6-decimal asset, to check that share decimals follow the asset.
contract SixDecimalToken is ERC20 {
    constructor() ERC20("Six", "SIX") {}
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @notice P1-05: InsuranceVault share pricing with virtual shares / virtual
///         asset (decimals offset 6). Derivation of the bounds asserted here:
///         docs/INSURANCE_VAULT_SHARES.md.
contract InsuranceVaultSharesTest is Test {
    InsuranceVault vault;
    MockUSDC       usdc;

    uint256 constant V = 1e6;           // 10 ** DECIMALS_OFFSET
    uint256 constant MAX_AMT = 1e36;    // 1e18 whole USDC — far beyond any real vault

    address alice  = makeAddr("alice");
    address bob    = makeAddr("bob");
    address carol  = makeAddr("carol");
    address early  = makeAddr("earlyHolder");
    address later  = makeAddr("laterDepositor");
    address feeRtr = makeAddr("feeRouter");
    address exch   = makeAddr("exchange");
    address trader = makeAddr("trader");

    function setUp() public {
        usdc  = new MockUSDC();
        vault = new InsuranceVault(address(usdc));
        vault.setFeeRouter(feeRtr);
        vault.setExchange(exch);

        address[6] memory who = [alice, bob, carol, early, later, feeRtr];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
        usdc.approve(address(vault), type(uint256).max); // owner, for recapitalize
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _fund(address who, uint256 amount) internal {
        if (amount > 0) usdc.mint(who, amount);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _fund(who, amount);
        vm.prank(who);
        shares = vault.deposit(amount);
    }

    function _inflow(uint256 amount) internal {
        if (amount == 0) return;
        _fund(feeRtr, amount);
        vm.prank(feeRtr);
        vault.depositFromProtocol(amount);
    }

    function _withdrawAll(address who) internal returns (uint256 out) {
        uint256 s = vault.balanceOf(who);
        if (s == 0) return 0;
        vm.prank(who);
        out = vault.withdraw(s);
    }

    function _bailout(uint256 amount) internal {
        vm.prank(exch);
        vault.bailout(amount, trader);
    }

    /// @dev ceil((totalAssets + 1) / (totalSupply + V)): the redemption value
    ///      of ONE share unit, rounded up.
    function _unitPriceCeil() internal view returns (uint256) {
        uint256 num = vault.totalAssets() + 1;
        uint256 den = vault.totalSupply() + V;
        return (num + den - 1) / den;
    }

    function _assertSolvent() internal view {
        assertLe(vault.previewWithdraw(vault.totalSupply()), vault.totalAssets(), "shares worth more than assets");
        assertGe(usdc.balanceOf(address(vault)), vault.totalAssets(), "tracked assets not backed");
    }

    // ── decimals / display ──────────────────────────────────────────────────

    function test_decimals_followAssetPlusOffset() public {
        assertEq(vault.DECIMALS_OFFSET(), 6);
        assertEq(vault.decimals(), 24);                         // 18-dec MockUSDC

        InsuranceVault six = new InsuranceVault(address(new SixDecimalToken()));
        assertEq(six.decimals(), 12);
        assertEq(six.getSharePrice(), 1e6, "empty vault price is 1.0 in asset units");

        // A token address with no decimals() falls back to 18.
        InsuranceVault none = new InsuranceVault(makeAddr("noCode"));
        assertEq(none.decimals(), 24);
    }

    function test_emptyVault_oneWholeUsdcMintsOneWholeShare() public {
        assertEq(vault.getSharePrice(), 1e18);
        uint256 s = _deposit(alice, 1_000e18);
        assertEq(s, 1_000e18 * V);
        assertEq(s / 10 ** vault.decimals(), 1_000, "1000 USDC -> 1000 whole pIV");
        assertEq(vault.getSharePrice(), 1e18);
        assertEq(vault.previewWithdraw(s), 1_000e18);
    }

    // ── early-holder price inflation: bounded and unprofitable ───────────────

    /// @dev An early holder with a tiny position, a protocol inflow of any
    ///      size, then a later deposit of any size. The early holder's net
    ///      result (what they get back minus everything they put in, inflow
    ///      included) must be <= 1 wei, and <= 0 when they exit first; the
    ///      later depositor's loss is below one share unit's price, and the
    ///      early holder loses at least (V - 1) times that.
    function testFuzz_earlyHolderInflowThenDeposit_unprofitable(
        uint256 earlyAmt,
        uint256 inflow,
        uint256 laterAmt,
        bool earlyExitsFirst
    ) public {
        earlyAmt = bound(earlyAmt, 1, 1e24);
        inflow   = bound(inflow, 0, MAX_AMT);
        laterAmt = bound(laterAmt, 1, MAX_AMT);

        _deposit(early, earlyAmt);
        _inflow(inflow);
        uint256 cost = earlyAmt + inflow;

        uint256 preview = vault.previewDeposit(laterAmt);
        if (preview == 0) {
            _fund(later, laterAmt);
            vm.prank(later);
            vm.expectRevert(InsuranceVault.ZeroShares.selector);
            vault.deposit(laterAmt);
            uint256 back = _withdrawAll(early);
            assertLe(back, cost, "no later deposit: early holder cannot gain");
            _assertSolvent();
            return;
        }

        _deposit(later, laterAmt);
        uint256 unitPrice = _unitPriceCeil();

        uint256 earlyOut;
        uint256 laterOut;
        if (earlyExitsFirst) {
            earlyOut = _withdrawAll(early);
            laterOut = _withdrawAll(later);
        } else {
            laterOut = _withdrawAll(later);
            earlyOut = _withdrawAll(early);
        }
        _assertSolvent();

        // Early holder: net <= 1 wei (<= 0 when exiting first).
        assertLe(earlyOut, cost + 1, "early holder net > 1 wei");
        if (earlyExitsFirst) assertLe(earlyOut, cost, "early holder exiting first gained");

        // Later depositor: loss below one share unit's price (+1 wei rounding).
        uint256 laterLoss = laterOut >= laterAmt ? 0 : laterAmt - laterOut;
        assertLe(laterLoss, unitPrice + 1, "later depositor lost more than one share unit");

        // Whatever the later depositor lost cost the early holder >= (V-1)x.
        uint256 earlyLoss = earlyOut >= cost ? 0 : cost - earlyOut;
        if (laterLoss > 0) {
            assertGe(earlyLoss + V, laterLoss * (V - 1), "loss ratio below V-1");
        }
    }

    /// @dev Concrete instance at realistic sizes: a 1,000 USDC inflow on a
    ///      1-wei early position, then a 500 USDC deposit (the case that used
    ///      to round to zero shares). The deposit now receives fair shares,
    ///      and the virtual shares keep half of the inflow (the early position
    ///      is 10^6 share units, the same as the virtual ones).
    function test_inflowOnTinySupply_laterDepositGetsFairShares() public {
        _deposit(early, 1);
        _inflow(1_000e18);
        uint256 s = _deposit(later, 500e18);
        assertGt(s, 0);

        uint256 laterOut = _withdrawAll(later);
        uint256 earlyOut = _withdrawAll(early);
        assertLe(500e18 - laterOut, 1e15, "later depositor loses < 0.001 USDC");
        assertGe(1_000e18 + 1 - earlyOut, 499e18, "early holder loses ~half of the inflow");
        _assertSolvent();
    }

    /// @dev The <= 1 wei bound is per later depositor. With many later
    ///      round trips a large holder collects one rounding remainder per
    ///      operation (here ~1 wei each at a normal price), which is the
    ///      general bound: < one share unit's price + 1 wei per operation.
    function test_manyLaterRoundTrips_holderCollectsAtMostOneRemainderEach() public {
        uint256 cost = 1_000e18 + 333e18 + 7;
        uint256 s = _deposit(early, 1_000e18);
        _inflow(333e18 + 7);
        uint256 ops;
        for (uint256 i = 0; i < 200; i++) {
            uint256 amt = 1e18 + i * 7_919 + 3;
            uint256 unitPrice = _unitPriceCeil();
            uint256 got = _deposit(later, amt);
            vm.prank(later);
            uint256 out = vault.withdraw(got);
            assertLe(amt - out, unitPrice + 1, "later loss above one share unit + 1 wei");
            ops += 2;
        }
        vm.prank(early);
        uint256 earlyOut = vault.withdraw(s);
        assertLe(earlyOut, cost + ops * (_unitPriceCeil() + 1), "holder gain above one remainder per op");
        _assertSolvent();
    }

    /// @dev Raising the price first and then collecting remainders from many
    ///      later round trips still loses money: each remainder is < c + 1 wei
    ///      while raising the price to c cost ~V * c.
    function test_manyLaterRoundTrips_afterPriceRaise_holderStillLoses() public {
        uint256 s = _deposit(early, 1);
        _inflow(1_000e18);
        uint256 cost = 1 + 1_000e18;
        for (uint256 i = 0; i < 50; i++) {
            uint256 c = (vault.totalAssets() + 1) / (vault.totalSupply() + V);
            uint256 amt = 10 * c + c - 1;                  // just below a share-unit multiple
            uint256 got = _deposit(later, amt);
            vm.prank(later);
            vault.withdraw(got);
        }
        vm.prank(early);
        uint256 earlyOut = vault.withdraw(s);
        assertLt(earlyOut, cost, "raising the price must still lose");
        _assertSolvent();
    }

    /// @dev Random interleavings of an early holder's deposits/withdrawals,
    ///      protocol inflows (counted as the early holder's cost), other
    ///      holders' deposits/withdrawals and bailouts: the early holder never
    ///      nets more than one wei per other-holder operation, plus 1.
    function testFuzz_interleaved_holderNetBoundedByOtherOps(uint256 seed) public {
        uint256 paid; uint256 got; uint256 otherOps;
        for (uint256 i = 0; i < 24; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 6;
            uint256 amt = (r >> 8) % 1e21 + 1;
            bool insolvent = vault.totalSupply() != 0 && vault.totalAssets() == 0;
            if (insolvent && (op == 0 || op == 3)) continue;
            if (op == 0) {
                if (vault.previewDeposit(amt) == 0) continue;
                _deposit(early, amt); paid += amt;
            } else if (op == 1) {
                uint256 b = vault.balanceOf(early);
                if (b == 0) continue;
                vm.prank(early);
                got += vault.withdraw((r >> 80) % b + 1);
            } else if (op == 2) {
                uint256 d = (r >> 8) % 1e20;
                _inflow(d); paid += d;
            } else if (op == 3) {
                if (vault.previewDeposit(amt) == 0) continue;
                _deposit(later, amt); otherOps++;
            } else if (op == 4) {
                uint256 b = vault.balanceOf(later);
                if (b == 0) continue;
                vm.prank(later);
                vault.withdraw((r >> 80) % b + 1); otherOps++;
            } else {
                uint256 ta = vault.totalAssets();
                if (ta == 0) continue;
                _bailout((r >> 8) % ta);
            }
        }
        got += _withdrawAll(early);
        assertLe(got, paid + otherOps + 1, "early holder net above otherOps + 1 wei");
        _assertSolvent();
    }

    /// @dev Tokens sent straight to the vault are not counted: the price and
    ///      every later deposit are exactly as if the transfer never happened.
    function testFuzz_directTransferDoesNotMovePrice(uint256 earlyAmt, uint256 gift, uint256 laterAmt) public {
        earlyAmt = bound(earlyAmt, 1, 1e24);
        gift     = bound(gift, 1, MAX_AMT);
        laterAmt = bound(laterAmt, 1, MAX_AMT);

        _deposit(early, earlyAmt);
        uint256 assetsBefore = vault.totalAssets();
        uint256 priceBefore  = vault.getSharePrice();
        uint256 previewBefore = vault.previewDeposit(laterAmt);

        _fund(early, gift);
        vm.prank(early);
        usdc.transfer(address(vault), gift);

        assertEq(vault.totalAssets(), assetsBefore);
        assertEq(vault.getSharePrice(), priceBefore);
        assertEq(vault.previewDeposit(laterAmt), previewBefore);
        assertEq(_deposit(later, laterAmt), previewBefore);
        assertLe(_withdrawAll(early), earlyAmt);
        _assertSolvent();
    }

    // ── round trips, rounding direction ─────────────────────────────────────

    /// @dev In any reachable state (prior holders, inflows, bailouts), a
    ///      deposit followed by a withdrawal of the minted shares never returns
    ///      more than was deposited, and never lowers anyone else's value.
    function testFuzz_roundTripNeverProfits(
        uint256 seedAmt,
        uint256 inflow,
        uint256 lossBps,
        uint256 amt
    ) public {
        seedAmt = bound(seedAmt, 1, MAX_AMT);
        inflow  = bound(inflow, 0, MAX_AMT);
        lossBps = bound(lossBps, 0, 9_999);
        amt     = bound(amt, 1, MAX_AMT);

        _deposit(alice, seedAmt);
        _inflow(inflow);
        uint256 loss = vault.totalAssets() * lossBps / 10_000;
        if (loss > 0) _bailout(loss);

        uint256 aliceValueBefore = vault.previewWithdraw(vault.balanceOf(alice));
        if (vault.previewDeposit(amt) == 0) return; // ZeroShares, covered elsewhere
        uint256 s = _deposit(bob, amt);
        assertGe(vault.previewWithdraw(vault.balanceOf(alice)), aliceValueBefore, "deposit diluted alice");

        vm.prank(bob);
        uint256 out = vault.withdraw(s);
        assertLe(out, amt, "round trip profited");
        assertGe(vault.previewWithdraw(vault.balanceOf(alice)), aliceValueBefore, "withdraw diluted alice");
        _assertSolvent();
    }

    // ── normal flows ────────────────────────────────────────────────────────

    function test_multipleDepositors_proportionalWithdrawals() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   3_000e18);
        _inflow(400e18);                         // +10%
        _deposit(carol, 2_200e18);               // at 1.1

        uint256 a = _withdrawAll(alice);
        uint256 b = _withdrawAll(bob);
        uint256 c = _withdrawAll(carol);
        assertApproxEqAbs(a, 1_100e18, 2);
        assertApproxEqAbs(b, 3_300e18, 2);
        assertApproxEqAbs(c, 2_200e18, 2);
        assertLe(c, 2_200e18);
        assertEq(vault.totalSupply(), 0);
        assertLe(vault.totalAssets(), 3, "only rounding dust stays behind");
        _assertSolvent();
    }

    function test_bailoutLowersPrice_fairForHoldersAndNewcomers() public {
        _deposit(alice, 1_000e18);
        _deposit(bob,   1_000e18);
        _bailout(600e18);                        // -30%
        assertEq(vault.getSharePrice(), 0.7e18);

        uint256 cs = _deposit(carol, 700e18);    // buys at 0.7
        assertApproxEqRel(cs, 1_000e18 * V, 1e9);

        uint256 a = _withdrawAll(alice);
        uint256 c = _withdrawAll(carol);
        uint256 b = _withdrawAll(bob);
        assertApproxEqAbs(a, 700e18, 2);
        assertApproxEqAbs(b, 700e18, 2);
        assertLe(c, 700e18);
        assertApproxEqAbs(c, 700e18, 2);
        _assertSolvent();
    }

    function test_fullExitThenRestart() public {
        _deposit(alice, 1_000e18);
        _inflow(1_000e18);
        _withdrawAll(alice);
        assertEq(vault.totalSupply(), 0);
        uint256 residual = vault.totalAssets();
        assertLe(residual, 3, "full exit leaves only rounding dust");
        assertEq(vault.getSharePrice(), 1e18, "empty supply shows 1.0 again");

        uint256 s = _deposit(bob, 500e18);
        assertGt(s, 0);
        uint256 out = _withdrawAll(bob);
        assertLe(out, 500e18 + residual, "newcomer gets at most the dust left behind");
        assertGe(out + 2, 500e18);
        _assertSolvent();
    }

    function test_drainedToZero_depositsRefusedUntilRecapitalized() public {
        _deposit(alice, 1_000e18);
        _bailout(1_000e18);
        assertEq(vault.totalAssets(), 0);

        _fund(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(InsuranceVault.VaultInsolvent.selector);
        vault.deposit(1e18);

        _fund(address(this), 100e18);
        vault.recapitalize(100e18);
        uint256 s = _deposit(bob, 100e18);
        assertGt(s, 0);
        uint256 b = _withdrawAll(bob);
        assertLe(b, 100e18);
        assertApproxEqAbs(b, 100e18, 2);
        _assertSolvent();
    }

    // ── zero-supply inflows and seeding (docs §3.3, §5) ─────────────────────

    /// @dev Assets that arrive while totalSupply == 0 belong to the virtual
    ///      shares for good: a later depositor redeems only what they paid,
    ///      and on a vault with no exchange (no bailouts) nothing can ever
    ///      take those assets out.
    function test_inflowAtZeroSupply_staysWithVirtualShares_noExchange() public {
        InsuranceVault x = new InsuranceVault(address(usdc));
        x.setFeeRouter(feeRtr);                          // exchange left at 0
        _fund(feeRtr, 1_000e18);
        vm.prank(feeRtr);
        usdc.approve(address(x), type(uint256).max);
        vm.prank(feeRtr);
        x.depositFromProtocol(1_000e18);

        _fund(alice, 1_000_000e18);
        vm.startPrank(alice);
        usdc.approve(address(x), type(uint256).max);
        uint256 s = x.deposit(1_000_000e18);
        uint256 out = x.withdraw(s);
        vm.stopPrank();
        assertLe(out, 1_000_000e18, "depositor cannot take the zero-supply inflow");
        assertGe(x.totalAssets(), 1_000e18, "the inflow stays in the vault");
        assertEq(x.totalSupply(), 0);
    }

    /// @dev The same inflow after a seed deposit goes to the seed holder, and
    ///      the seed is withdrawable: seeding before wiring any inflow is what
    ///      the migration plan requires.
    function test_seedBeforeInflow_seedHolderEarnsInflowAndCanExit() public {
        uint256 s = _deposit(alice, 100e18);                // protocol seed
        _inflow(1_000e18);
        assertApproxEqAbs(vault.previewWithdraw(s), 1_100e18, 1e9, "seed holder owns the inflow");
        uint256 out = _withdrawAll(alice);
        assertApproxEqAbs(out, 1_100e18, 1e9);
        _assertSolvent();
    }

    /// @dev Bailouts that twice leave 1 wei behind crush the share price so far
    ///      that a large deposit's share count overflows (Math.mulDiv reverts).
    ///      Small deposits still work and `recapitalize` restores normal sizes.
    function test_priceCrushedTwice_largeDepositOverflows_recapitalizeRecovers() public {
        _deposit(alice, 1_000_000e18);
        _bailout(vault.totalAssets() - 1);
        _deposit(bob, 1_000_000e18);
        _bailout(vault.totalAssets() - 1);

        _fund(bob, 1_000_000e18);
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1_000_000e18);

        assertGt(_deposit(carol, 1e18), 0, "small deposits still work");
        _fund(address(this), 1_000e18);
        vault.recapitalize(1_000e18);
        assertGt(_deposit(bob, 1_000_000e18), 0, "recapitalize restores large deposits");
        _assertSolvent();
    }

    // ── edge values ─────────────────────────────────────────────────────────

    function test_edge_zeroDepositReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("zero"));
        vault.deposit(0);
    }

    function test_edge_oneWei() public {
        uint256 s = _deposit(alice, 1);
        assertEq(s, V);
        assertEq(vault.previewWithdraw(s), 1);

        // Withdrawing a single share unit is worth 0 wei: it pays nothing and
        // burns the unit, which only costs the caller.
        vm.prank(alice);
        assertEq(vault.withdraw(1), 0);
        assertEq(vault.balanceOf(alice), V - 1);
        assertEq(vault.totalAssets(), 1);
        _assertSolvent();
    }

    function test_edge_largeAmounts() public {
        uint256 s1 = _deposit(alice, MAX_AMT);
        assertEq(s1, MAX_AMT * V);
        uint256 s2 = _deposit(bob, MAX_AMT);
        assertApproxEqAbs(s2, s1, 1);
        _inflow(MAX_AMT);
        uint256 a = _withdrawAll(alice);
        assertApproxEqAbs(a, MAX_AMT + MAX_AMT / 2, 2);
        _assertSolvent();
    }

    function test_edge_amountWhoseSharesOverflowReverts() public {
        vm.expectRevert();
        vault.previewDeposit(type(uint256).max);
    }
}
