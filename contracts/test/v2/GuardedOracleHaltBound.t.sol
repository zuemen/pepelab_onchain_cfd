// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/GuardedOracle.sol";

/// @notice Exact-interval bound check for GuardedOracle guardian halts.
///
///         Adapted from the PR #219 review probe. Time only advances to the
///         next expiry or to a chosen instant, and each segment is classified
///         as halted (freeze of ID in force, or pause in force) or clean, so
///         the bounds are measured to the second, not the hour:
///           maxRun   - longest unbroken halted stretch for ID
///           maxDirty - longest stretch between two clean spans of >= 24h
///                      (short clean gaps inside it count as part of it)
///         The time between two completed clean days is maxDirty + 24h.
///         Guardian-only strategies use two guardian keys, early lifts, a
///         second asset, and moves to exact boundaries and one second either
///         side of them.
contract GuardedOracleHaltBoundTest is Test {
    GuardedOracle o;
    address admin = address(this);
    address g1 = makeAddr("g1");
    address g2 = makeAddr("g2");
    bytes32 constant ID = keccak256("sBTC");
    bytes32 constant ID2 = keccak256("sETH");
    uint256 constant H = 1 hours;
    uint256 constant NONE = type(uint256).max;
    uint256 constant DURATION = 72 hours;
    uint256 constant COOLDOWN = 24 hours;

    uint256 nowT;
    uint256 runStart;
    uint256 gapStart;
    uint256 lastLongGapEnd;   // end of the last >= 24h clean span (or start)
    uint256 maxRun;
    uint256 maxDirty;
    uint256 rng;

    function setUp() public {
        nowT = 1_700_000_000;
        vm.warp(nowT);
        o = new GuardedOracle(admin);
        o.grantRole(o.GUARDIAN_ROLE(), g1);
        o.grantRole(o.GUARDIAN_ROLE(), g2);
        o.addAsset(ID, 100_000e8);
        o.addAsset(ID2, 3_000e8);
        o.setRiskParams(1_000, 0);
        // A long clean history before T0.
        runStart = NONE;
        gapStart = nowT - 48 hours;
        lastLongGapEnd = nowT;
    }

    // ── simulation ───────────────────────────────────────────────────────────

    function _r(uint256 n) internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return rng % n;
    }

    function _halted() internal view returns (bool) {
        (bool f,,,) = o.freezeOf(ID);
        return f || o.paused();
    }

    function _nextBoundary() internal view returns (uint256 b) {
        b = NONE;
        (bool f,, uint256 fe,) = o.freezeOf(ID);
        if (f && fe != 0 && fe > nowT && fe < b) b = fe;
        (bool p,, uint256 pe,) = o.pauseState();
        if (p && pe != 0 && pe > nowT && pe < b) b = pe;
    }

    function _segment(uint256 a, uint256 b, bool halted) internal {
        if (b <= a) return;
        if (halted) {
            if (runStart == NONE) runStart = a;
            if (b - runStart > maxRun) maxRun = b - runStart;
            if (gapStart != NONE) {
                if (a - gapStart >= 24 hours) lastLongGapEnd = a;
                gapStart = NONE;
            }
        } else {
            runStart = NONE;
            if (gapStart == NONE) gapStart = a;
            if (b - gapStart >= 24 hours) {
                // A clean day exists from gapStart: the halted stretch before
                // it is gapStart - lastLongGapEnd.
                uint256 dirty = gapStart > lastLongGapEnd ? gapStart - lastLongGapEnd : 0;
                if (dirty > maxDirty) maxDirty = dirty;
                lastLongGapEnd = b; // keeps sliding while the gap continues
            }
        }
    }

    function _advanceTo(uint256 target) internal {
        while (nowT < target) {
            uint256 b = _nextBoundary();
            uint256 step = b < target ? b : target;
            bool h = _halted();
            _segment(nowT, step, h);
            nowT = step;
            vm.warp(nowT);
        }
        _segment(nowT, nowT, _halted());
    }

    function _g() internal returns (address) { return _r(2) == 0 ? g1 : g2; }

    function _act(uint256 k, bool allowAdmin) internal {
        if (k == 0) { vm.prank(_g()); try o.setAssetFrozen(ID, true) {} catch {} }
        else if (k == 1) { vm.prank(_g()); try o.setAssetFrozen(ID, false) {} catch {} }
        else if (k == 2) { vm.prank(_g()); try o.setPaused(true) {} catch {} }
        else if (k == 3) { vm.prank(_g()); try o.setPaused(false) {} catch {} }
        else if (k == 4) { _advanceTo(nowT + 1 + _r(30 hours)); }
        else if (k == 5) {
            // Jump to an exact boundary, or one second either side of it.
            (,, uint256 fe, uint256 fw) = o.freezeOf(ID);
            (,, uint256 pe, uint256 pw) = o.pauseState();
            (, uint256 lastEnd) = o.lastGuardianPause();
            uint256[8] memory c = [fe, pe, fw, pw, fw + COOLDOWN, pw + COOLDOWN, lastEnd, lastEnd + COOLDOWN];
            uint256 t = c[_r(8)];
            uint256 d = _r(3);
            if (t != 0) t = d == 0 ? t - 1 : (d == 1 ? t : t + 1);
            if (t > nowT) _advanceTo(t);
        }
        else if (k == 6) { _advanceTo(nowT + 1 + _r(120)); }
        else if (k == 7) { vm.prank(_g()); try o.setAssetFrozen(ID2, true) {} catch {} }
        else if (k == 8) { vm.prank(_g()); try o.setAssetFrozen(ID2, false) {} catch {} }
        else if (k == 9 && allowAdmin) {
            uint256 a = _r(6);
            if (a == 0) o.setAssetFrozen(ID, true);
            else if (a == 1) o.setAssetFrozen(ID, false);
            else if (a == 2) o.setPaused(true);
            else if (a == 3) o.setPaused(false);
            else if (a == 4) { try o.takeOverAssetFreeze(ID) {} catch {} }
            else { try o.takeOverPause() {} catch {} }
        }
    }

    function _greedy() internal {
        vm.prank(_g()); try o.setAssetFrozen(ID, true) {} catch {}
        vm.prank(_g()); try o.setPaused(true) {} catch {}
    }

    function _finish() internal {
        _advanceTo(nowT + 400 hours);
        emit log_named_uint("maxRun(h*1000)", maxRun * 1000 / H);
        emit log_named_uint("maxDirty(h*1000)", maxDirty * 1000 / H);
        assertLe(maxRun, 2 * DURATION, "run > 144h");
        // 168h before PR #219's review fix. The fix lets a freeze opened
        // within a day of a SHORT pause run almost its full 72h, so a short
        // pause, a gap under a day, that freeze, a gap under a day and a full
        // pause can follow one another: < 192h. See KNOWN_LIMITATIONS #27.
        assertLt(maxDirty, 2 * DURATION + 2 * COOLDOWN, "halted stretch between clean days >= 192h");
    }

    // ── guardian alone ───────────────────────────────────────────────────────

    function testFuzz_guardianOnly_random(uint256 seed) public {
        rng = seed;
        for (uint256 i; i < 600; i++) {
            if (_r(3) == 0) _greedy();
            _act(_r(9), false);
        }
        _finish();
    }

    /// @dev Greedy with last-second timing: wait until 1s before each expiry,
    ///      then try every halt; lift now and then to probe the clocks.
    function testFuzz_guardianOnly_lastSecond(uint256 seed) public {
        rng = seed;
        for (uint256 i; i < 300; i++) {
            _greedy();
            uint256 b = _nextBoundary();
            if (b != NONE && b > nowT + 1 && _r(4) != 0) _advanceTo(b - 1 - _r(2));
            else _act(4 + _r(3), false);
            if (_r(5) == 0) { vm.prank(_g()); try o.setAssetFrozen(ID, false) {} catch {} }
            if (_r(7) == 0) { vm.prank(_g()); try o.setPaused(false) {} catch {} }
        }
        _finish();
    }

    /// @dev Pause/lift cycling: the guardian opens a pause, lifts it after a
    ///      random time (often at once), and freezes around it, to see whether
    ///      closing the pause window on an early lift can be used to restart
    ///      clocks and stretch the halted time.
    function testFuzz_guardianOnly_pauseCycling(uint256 seed) public {
        rng = seed;
        for (uint256 i; i < 300; i++) {
            vm.prank(_g()); try o.setPaused(true) {} catch {}
            if (_r(2) == 0) { vm.prank(_g()); try o.setAssetFrozen(ID, true) {} catch {} }
            uint256 hold = _r(4) == 0 ? 0 : _r(DURATION + 1);
            _advanceTo(nowT + hold);
            vm.prank(_g()); try o.setPaused(false) {} catch {}
            vm.prank(_g()); try o.setAssetFrozen(ID, true) {} catch {}
            _act(4 + _r(3), false);
            if (_r(3) == 0) _act(5, false);
        }
        _finish();
    }

    /// @dev Deterministic: freeze, then the pause one second before the
    ///      freeze lapses — the 144h case, followed by a clean day.
    function test_freezeThenPause_is144hThenAClearDay() public {
        uint256 t0 = nowT;
        vm.prank(g1); o.setAssetFrozen(ID, true);
        _advanceTo(t0 + DURATION - 1);
        vm.prank(g2); o.setPaused(true);
        _advanceTo(t0 + DURATION + DURATION - 2);
        vm.prank(g1); o.setAssetFrozen(ID, true);   // capped by the pause, pins it
        _advanceTo(t0 + 2 * DURATION - 1);
        vm.prank(g1); vm.expectRevert(); o.setAssetFrozen(ID, true);
        vm.prank(g1); vm.expectRevert(); o.setPaused(true);
        _advanceTo(t0 + 2 * DURATION - 1 + COOLDOWN);
        vm.prank(g1); o.setAssetFrozen(ID, true);
        _finish();
        assertEq(maxRun, 2 * DURATION - 1);
    }

    /// @dev The longest halted stretch between clean days the fix allows: a
    ///      short pause, a freeze opened just under a day after it (shortened
    ///      by the pause's length), then a full pause opened just under a day
    ///      after that freeze ended. Max run stays far below 144h; the stretch
    ///      is just under 192h; then a clean day.
    function test_worstStretch_shortPauseFreezeFullPause() public {
        uint256 t0 = nowT;
        vm.prank(g1); o.setPaused(true);
        _advanceTo(t0 + 1 hours);
        vm.prank(g1); o.setPaused(false);                       // ran 1h
        _advanceTo(t0 + 1 hours + COOLDOWN - 1);
        vm.prank(g2); o.setAssetFrozen(ID, true);
        (,, uint256 fe,) = o.freezeOf(ID);
        assertEq(fe, nowT + DURATION - 1 hours, "shortened by the 1h the pause ran");
        _advanceTo(fe + COOLDOWN - 1);
        vm.prank(g1); o.setPaused(true);                        // full 72h
        _advanceTo(nowT + DURATION);
        // The asset had a freeze close before that pause, which ran in full:
        // no freeze for a day; nor a pause.
        vm.prank(g2); vm.expectRevert(); o.setAssetFrozen(ID, true);
        vm.prank(g2); vm.expectRevert(); o.setPaused(true);
        _finish();
        // 1h + (24h - 1s) + 71h + (24h - 1s) + 72h
        assertEq(maxDirty, 2 * DURATION + 2 * COOLDOWN - 2, "192h - 2s");
        assertLe(maxRun, DURATION);
    }

    // ── admin interleaved ────────────────────────────────────────────────────

    /// @dev The guardian never turns an admin (no-expiry) halt into an
    ///      expiring one, nor lifts it.
    function testFuzz_adminHaltNeverWeakenedByGuardian(uint256 seed) public {
        rng = seed;
        for (uint256 i; i < 500; i++) {
            (bool fBefore,, uint256 feBefore,) = o.freezeOf(ID);
            (bool pBefore,, uint256 peBefore,) = o.pauseState();
            uint256 k = _r(10);
            bool adminAct = (k == 9);
            _act(k, true);
            if (!adminAct) {
                (bool fA,, uint256 feA,) = o.freezeOf(ID);
                (bool pA,, uint256 peA,) = o.pauseState();
                if (fBefore && feBefore == 0) { assertTrue(fA, "admin freeze lifted"); assertEq(feA, 0, "admin freeze got expiry"); }
                if (pBefore && peBefore == 0) { assertTrue(pA, "admin pause lifted"); assertEq(peA, 0, "admin pause got expiry"); }
            }
        }
    }

    // ── A-F1 regression: a false alarm no longer burns the brakes ────────────

    /// @dev Review finding A-F1: a pause opened and lifted at once (false
    ///      alarm, or one stolen guardian key) used to cap every freeze in the
    ///      next 72h to the end of that pause window and then lock every
    ///      asset out for 24h. Now the pause counts only for as long as it ran.
    function test_falseAlarmPause_doesNotWeakenLaterFreezes() public {
        uint256 t0 = nowT;
        vm.prank(g2); o.setPaused(true);
        vm.prank(g2); o.setPaused(false);
        (uint256 s, uint256 e) = o.lastGuardianPause();
        assertEq(s, t0);
        assertEq(e, t0);

        // Right after the false alarm: both assets get a full 72h.
        _advanceTo(t0 + 1 hours);
        vm.prank(g1); o.setAssetFrozen(ID2, true);
        (,, uint256 exp2,) = o.freezeOf(ID2);
        assertEq(exp2, t0 + 1 hours + DURATION);

        // The reviewer's case: a bad price shortly before the old window end.
        _advanceTo(t0 + DURATION - 10 minutes);
        vm.prank(g1); o.setAssetFrozen(ID, true);
        (,, uint256 exp,) = o.freezeOf(ID);
        assertEq(exp, t0 + DURATION - 10 minutes + DURATION, "full 72h, not 10 minutes");

        // And no fleet-wide lockout after the old window end.
        _advanceTo(t0 + DURATION + 1);
        (bool f,,,) = o.freezeOf(ID);
        assertTrue(f, "still frozen");
        // The pause itself was usable again 24h after it actually ended.
        (uint256 pe, uint256 allowedAt) = o.guardianPauseTerms();
        assertEq(allowedAt, 0);
        assertEq(pe, t0 + DURATION + 1 + DURATION);
    }

    /// @dev Fuzz the same: a pause that ran `ran` seconds, lifted, then a
    ///      freeze `gap` later on an asset with no recent freeze. The freeze
    ///      loses at most `ran`, and nothing once a day has passed.
    function testFuzz_freezeAfterAnEarlyLiftLosesAtMostThePauseLength(uint256 ran, uint256 gap) public {
        ran = bound(ran, 0, DURATION - 1);
        gap = bound(gap, 0, 10 days);
        uint256 t0 = nowT;
        vm.prank(g1); o.setPaused(true);
        _advanceTo(t0 + ran);
        vm.prank(g2); o.setPaused(false);
        _advanceTo(t0 + ran + gap);
        (uint256 e, uint256 allowedAt) = o.guardianFreezeTerms(ID);
        assertEq(allowedAt, 0, "never refused on a clean asset");
        if (gap < COOLDOWN) assertEq(e, nowT + DURATION - ran);
        else assertEq(e, nowT + DURATION);
        vm.prank(g1); o.setAssetFrozen(ID, true);
        (,, uint256 exp,) = o.freezeOf(ID);
        assertEq(exp, e);
    }
}
