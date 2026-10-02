// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/settlement/WrappedUSDC18.sol";
import "../../src/MockUSDC.sol";
import "./MockFiatUSDC6.sol";

/// @notice ADR-011 — unit + fuzz tests for the 1:1 6→18 decimal wrapper.
contract WrappedUSDC18Test is Test {
    MockFiatUSDC6 usdc;
    WrappedUSDC18 w;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant SCALE = 1e12;

    function setUp() public {
        usdc = new MockFiatUSDC6();
        w = new WrappedUSDC18(address(usdc), "Wrapped USDC", "USDC");
        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(w), type(uint256).max);
    }

    function _wrap(address who, uint256 amt6) internal returns (uint256) {
        vm.prank(who);
        return w.depositFor(who, amt6);
    }

    // ── constructor ──────────────────────────────────────────────────────

    function test_constructor_rejectsNon6Decimals() public {
        MockUSDC m18 = new MockUSDC();
        vm.expectRevert(WrappedUSDC18.InvalidUnderlying.selector);
        new WrappedUSDC18(address(m18), "x", "x");
    }

    function test_constructor_rejectsZeroAndEoa() public {
        vm.expectRevert(WrappedUSDC18.InvalidUnderlying.selector);
        new WrappedUSDC18(address(0), "x", "x");
        vm.expectRevert(WrappedUSDC18.InvalidUnderlying.selector);
        new WrappedUSDC18(alice, "x", "x");
    }

    function test_metadata() public view {
        assertEq(w.decimals(), 18);
        assertEq(address(w.underlying()), address(usdc));
        assertEq(w.SCALE(), SCALE);
    }

    // ── wrap / unwrap ────────────────────────────────────────────────────

    function test_wrap_mints18Decimals() public {
        uint256 minted = _wrap(alice, 123_456789); // 123.456789 USDC
        assertEq(minted, 123_456789 * SCALE);
        assertEq(w.balanceOf(alice), 123.456789e18);
        assertEq(usdc.balanceOf(address(w)), 123_456789);
    }

    function test_wrap_forAnotherAccount() public {
        vm.prank(alice);
        w.depositFor(bob, 5e6);
        assertEq(w.balanceOf(bob), 5e18);
        assertEq(w.balanceOf(alice), 0);
    }

    function test_wrap_zeroAndBadRecipientRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(WrappedUSDC18.ZeroAmount.selector);
        w.depositFor(alice, 0);
        vm.expectRevert(WrappedUSDC18.InvalidRecipient.selector);
        w.depositFor(address(0), 1e6);
        vm.expectRevert(WrappedUSDC18.InvalidRecipient.selector);
        w.depositFor(address(w), 1e6);
        vm.stopPrank();
    }

    function test_wrap_mintsOnBalanceDelta_feeOnTransfer() public {
        usdc.setFeeBps(100); // 1% — native USDC has none; proves I1 survives one
        uint256 minted = _wrap(alice, 100e6);
        assertEq(minted, 99e6 * SCALE);
        assertLe(w.totalSupply(), usdc.balanceOf(address(w)) * SCALE);
    }

    function test_unwrap_exact() public {
        _wrap(alice, 10e6);
        vm.prank(alice);
        uint256 paid = w.withdrawTo(alice, 10e18);
        assertEq(paid, 10e6);
        assertEq(w.balanceOf(alice), 0);
        assertEq(w.totalSupply(), 0);
        assertEq(usdc.balanceOf(address(w)), 0);
    }

    function test_unwrap_roundsDown_dustStaysWithHolder() public {
        _wrap(alice, 10e6);
        uint256 amt = 3e18 + 999_999_999_999; // 3 USDC + just under one unit
        vm.prank(alice);
        uint256 paid = w.withdrawTo(bob, amt);
        assertEq(paid, 3e6);
        assertEq(usdc.balanceOf(bob), 3e6);
        // only the paid part was burned; the sub-unit remainder was NOT taken
        assertEq(w.balanceOf(alice), 7e18);
        assertEq(w.totalSupply() % SCALE, 0);
    }

    function test_unwrap_belowOneUnitReverts() public {
        _wrap(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.BelowOneUnit.selector, SCALE - 1));
        w.withdrawTo(alice, SCALE - 1);
    }

    function test_unwrap_badRecipientReverts() public {
        _wrap(alice, 1e6);
        vm.startPrank(alice);
        vm.expectRevert(WrappedUSDC18.InvalidRecipient.selector);
        w.withdrawTo(address(0), 1e18);
        vm.expectRevert(WrappedUSDC18.InvalidRecipient.selector);
        w.withdrawTo(address(w), 1e18);
        vm.stopPrank();
    }

    function test_unwrap_moreThanBalanceReverts() public {
        _wrap(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert();
        w.withdrawTo(alice, 2e18);
    }

    function test_maxUnwrappable_excludesDust() public {
        _wrap(alice, 2e6);
        vm.prank(alice);
        w.transfer(bob, 1e18 + 5); // bob now has 5 wei of dust above one USDC
        assertEq(w.maxUnwrappable(bob), 1e18);
        uint256 m = w.maxUnwrappable(bob);
        vm.prank(bob);
        w.withdrawTo(bob, m);
        assertEq(w.balanceOf(bob), 5);
    }

    // ── Circle blacklist parity ──────────────────────────────────────────

    function test_blacklist_holderCannotTransferOrUnwrap() public {
        _wrap(alice, 10e6);
        usdc.blacklist(alice);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, alice));
        w.transfer(bob, 1e18);
        // the laundering path: unwrap to a clean address
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, alice));
        w.withdrawTo(bob, 1e18);
        vm.stopPrank();
    }

    function test_blacklist_cannotReceiveOrTransferFrom() public {
        _wrap(alice, 10e6);
        usdc.blacklist(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, bob));
        w.transfer(bob, 1e18);
        // an approved third party moving a blacklisted holder's units also fails
        usdc.unBlacklist(bob);
        vm.prank(alice);
        w.transfer(bob, 1e18);
        vm.prank(bob);
        w.approve(carol, 1e18);
        usdc.blacklist(bob);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, bob));
        w.transferFrom(bob, carol, 1e18);
    }

    function test_blacklist_cannotWrapForBlacklistedAccount() public {
        usdc.blacklist(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedUSDC18.UnderlyingBlacklisted.selector, bob));
        w.depositFor(bob, 1e6);
    }

    function test_blacklist_blacklistedPayerCannotWrap() public {
        usdc.blacklist(alice);
        vm.prank(alice);
        vm.expectRevert("Blacklistable: account is blacklisted");
        w.depositFor(bob, 1e6);
    }

    function test_blacklist_unwrapToBlacklistedRecipientReverts() public {
        _wrap(alice, 10e6);
        usdc.blacklist(bob);
        vm.prank(alice);
        vm.expectRevert("Blacklistable: account is blacklisted");
        w.withdrawTo(bob, 1e18);
    }

    function test_blacklist_wrapperItselfBlacklisted_unitsMoveButUsdcFrozen() public {
        _wrap(alice, 10e6);
        usdc.blacklist(address(w));
        // internal settlement keeps working
        vm.prank(alice);
        w.transfer(bob, 1e18);
        // but no USDC can leave or enter: every tenant fund behind this wrapper is frozen
        vm.prank(bob);
        vm.expectRevert("Blacklistable: account is blacklisted");
        w.withdrawTo(bob, 1e18);
        vm.prank(alice);
        vm.expectRevert("Blacklistable: account is blacklisted");
        w.depositFor(alice, 1e6);
        assertEq(usdc.balanceOf(address(w)), 10e6);
    }

    function test_blacklist_probeFailsOpen_noFunction() public {
        PlainUSDC6 p = new PlainUSDC6();
        WrappedUSDC18 pw = new WrappedUSDC18(address(p), "x", "x");
        p.mint(alice, 10e6);
        vm.startPrank(alice);
        p.approve(address(pw), 10e6);
        pw.depositFor(alice, 10e6);
        pw.transfer(bob, 1e18);
        vm.stopPrank();
        vm.prank(bob);
        assertEq(pw.withdrawTo(bob, 1e18), 1e6);
    }

    function test_blacklist_probeFailsOpen_reverting() public {
        RevertingProbeUSDC6 p = new RevertingProbeUSDC6();
        WrappedUSDC18 pw = new WrappedUSDC18(address(p), "x", "x");
        p.mint(alice, 10e6);
        vm.startPrank(alice);
        p.approve(address(pw), 10e6);
        pw.depositFor(alice, 10e6);
        pw.transfer(bob, 1e18);
        vm.stopPrank();
        assertEq(pw.balanceOf(bob), 1e18);
    }

    // ── USDC pause ───────────────────────────────────────────────────────

    function test_pause_wrapAndUnwrapStop_transfersContinue() public {
        _wrap(alice, 10e6);
        usdc.pause();
        vm.startPrank(alice);
        vm.expectRevert("Pausable: paused");
        w.depositFor(alice, 1e6);
        vm.expectRevert("Pausable: paused");
        w.withdrawTo(alice, 1e18);
        // wrapper units are NOT paused: liquidations / settlement keep moving
        w.transfer(bob, 2e18);
        vm.stopPrank();
        assertEq(w.balanceOf(bob), 2e18);

        usdc.unpause();
        vm.prank(bob);
        assertEq(w.withdrawTo(bob, 2e18), 2e6);
        assertLe(w.totalSupply(), usdc.balanceOf(address(w)) * SCALE);
    }

    // ── fuzz ─────────────────────────────────────────────────────────────

    /// wrap x, unwrap y: pays floor(y / 1e12), burns exactly that, dust < 1e12 stays.
    function testFuzz_wrapUnwrap_dustBound(uint256 x, uint256 y) public {
        x = bound(x, 1, 1_000_000e6);
        _wrap(alice, x);
        y = bound(y, SCALE, x * SCALE);
        uint256 balBefore = w.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = w.withdrawTo(alice, y);
        assertEq(paid, y / SCALE);
        assertEq(balBefore - w.balanceOf(alice), paid * SCALE, "burned == paid * SCALE");
        // what the holder asked for but did not get is < one unit and is still theirs
        assertLt(y - paid * SCALE, SCALE);
        assertEq(w.totalSupply(), usdc.balanceOf(address(w)) * SCALE);
    }

    /// Full round trip returns exactly what went in — no loss to the user.
    function testFuzz_roundTrip_lossless(uint256 x) public {
        x = bound(x, 1, 1_000_000e6);
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 minted = _wrap(alice, x);
        vm.prank(alice);
        uint256 paid = w.withdrawTo(alice, minted);
        assertEq(paid, x);
        assertEq(usdc.balanceOf(alice), usdcBefore);
        assertEq(w.totalSupply(), 0);
    }

    /// Arbitrary 18-dec movements (as the exchange makes when it pays PnL):
    /// after everybody unwraps everything payable, the total paid never
    /// exceeds what was deposited, and the residual dust per holder is < 1e12.
    function testFuzz_arbitrarySplits_paidNeverExceedsDeposits(uint256 x, uint256 a, uint256 b) public {
        x = bound(x, 1, 1_000_000e6);
        uint256 minted = _wrap(alice, x);
        a = bound(a, 0, minted);
        b = bound(b, 0, minted - a);
        vm.startPrank(alice);
        w.transfer(bob, a);
        w.transfer(carol, b);
        vm.stopPrank();

        uint256 paidTotal;
        address[3] memory hs = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            uint256 m = w.maxUnwrappable(hs[i]);
            if (m == 0) continue;
            vm.prank(hs[i]);
            paidTotal += w.withdrawTo(hs[i], m);
            assertLt(w.balanceOf(hs[i]), SCALE, "dust per holder < one unit");
        }
        assertLe(paidTotal, x);
        // the dust left over is exactly backed by what stayed in the wrapper
        assertEq(w.totalSupply(), usdc.balanceOf(address(w)) * SCALE);
        // at most (holders - 1) units are stranded as dust across holders
        assertLe(x - paidTotal, 2);
    }
}
