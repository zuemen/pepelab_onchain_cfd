// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";

contract HaltRefSource {
    mapping(bytes32 => uint256) public px;
    function set(bytes32 id, uint256 p) external { px[id] = p; }
    function getPrice(bytes32 id) external view returns (uint256, uint256) { return (px[id], block.timestamp); }
}

/// @notice GuardedOracle guardian halts are bounded: a guardian freeze or
///         pause lapses on its own and is followed by a cooldown; only the
///         admin can hold a halt with no expiry.
///
///         Written from the side of a stolen guardian key: how long can it
///         keep an asset unreadable, and can it weaken what the admin did?
contract GuardedOracleHaltExpiryTest is Test {
    GuardedOracle oracle;
    HaltRefSource ref;

    address admin     = address(this);
    address keeper    = makeAddr("keeper");
    address guardian  = makeAddr("guardian");
    address guardian2 = makeAddr("guardian2");
    address stranger  = makeAddr("stranger");

    bytes32 constant ID  = keccak256("sBTC");
    bytes32 constant ID2 = keccak256("sETH");

    uint256 constant T0 = 1_700_000_000;
    uint256 constant DURATION = 72 hours;
    uint256 constant COOLDOWN = 24 hours;

    event AssetFrozen(bytes32 indexed assetId, bool frozen);
    event AssetFreezeStarted(bytes32 indexed assetId, address indexed by, uint256 expiresAt);
    event AssetFreezeTakenOver(bytes32 indexed assetId, address indexed by);
    event AssetFreezeLifted(bytes32 indexed assetId, address indexed by);
    event PausedSet(bool paused);
    event PauseStarted(address indexed by, uint256 expiresAt);
    event PauseTakenOver(address indexed by);
    event PauseLifted(address indexed by);

    function setUp() public {
        vm.warp(T0);
        oracle = new GuardedOracle(admin);
        ref = new HaltRefSource();
        oracle.grantRole(oracle.KEEPER_ROLE(), keeper);
        oracle.grantRole(oracle.GUARDIAN_ROLE(), guardian);
        oracle.grantRole(oracle.GUARDIAN_ROLE(), guardian2);
        oracle.addAsset(ID, 100_000e8);
        oracle.addAsset(ID2, 3_000e8);
        // Staleness is a separate gate; switch it off so these tests observe
        // the halt alone. test_lapsedFreeze_* turns it back on.
        oracle.setRiskParams(1_000, 0);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _gFreeze(bytes32 id) internal { vm.prank(guardian); oracle.setAssetFrozen(id, true); }
    function _gLift(bytes32 id)   internal { vm.prank(guardian); oracle.setAssetFrozen(id, false); }
    function _gPause()            internal { vm.prank(guardian); oracle.setPaused(true); }
    function _gUnpause()          internal { vm.prank(guardian); oracle.setPaused(false); }

    function _frozen(bytes32 id) internal view returns (bool f) { (, , , f) = oracle.peek(id); }

    function _expectFrozenRead(bytes32 id) internal {
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, id));
        oracle.getPrice(id);
    }

    // ── constants ────────────────────────────────────────────────────────────

    function test_constantsMatchTheExchangeGuardianPause() public view {
        assertEq(oracle.GUARDIAN_HALT_DURATION(), 72 hours);
        assertEq(oracle.GUARDIAN_HALT_COOLDOWN(), 24 hours);
    }

    // ── guardian freeze: expiry ──────────────────────────────────────────────

    function test_guardianFreeze_lapsesWithoutATransaction() public {
        _gFreeze(ID);
        _expectFrozenRead(ID);
        assertTrue(oracle.isStale(ID));
        assertTrue(_frozen(ID));

        vm.warp(T0 + DURATION);
        // Nothing was sent: every read path recovers by itself.
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 100_000e8);
        assertFalse(oracle.isStale(ID));
        assertFalse(_frozen(ID));
        (bool inForce, uint256 since, uint256 expiresAt, uint256 windowEnd) = oracle.freezeOf(ID);
        assertFalse(inForce);
        assertEq(since, 0);
        assertEq(expiresAt, 0);
        assertEq(windowEnd, T0 + DURATION);
    }

    function test_guardianFreeze_lastSecondIsStillFrozen() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION - 1);
        _expectFrozenRead(ID);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, ID));
        oracle.updatePrice(ID, 101_000e8);
    }

    function test_guardianFreeze_keeperPostsAgainAfterLapse() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION);
        vm.prank(keeper);
        oracle.updatePrice(ID, 101_000e8);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 101_000e8);
    }

    /// @dev A lapse removes the halt, nothing more. The price is as old as the
    ///      freeze, so the staleness gate still refuses it until a keeper posts.
    function test_lapsedFreeze_priceStillSubjectToMaxPriceAge() public {
        oracle.setRiskParams(1_000, 1 hours);
        _gFreeze(ID);
        vm.warp(T0 + DURATION);

        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.StalePrice.selector, ID, T0));
        oracle.getPrice(ID);
        assertTrue(oracle.isStale(ID));
        assertFalse(_frozen(ID));

        vm.prank(keeper);
        oracle.updatePrice(ID, 100_500e8);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 100_500e8);
    }

    function test_freezeOnlyAffectsItsAsset() public {
        _gFreeze(ID);
        (uint256 p, ) = oracle.getPrice(ID2);
        assertEq(p, 3_000e8);
        vm.prank(keeper);
        oracle.updatePrice(ID2, 3_100e8);
    }

    // ── guardian freeze: no extension, cooldown ──────────────────────────────

    function test_guardianCannotExtendItsOwnFreeze() public {
        _gFreeze(ID);
        vm.warp(T0 + 71 hours);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setAssetFrozen(ID, true);

        vm.warp(T0 + DURATION);
        assertFalse(_frozen(ID));
    }

    function test_guardianCooldownAfterLapse() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setAssetFrozen(ID, true);

        vm.warp(T0 + DURATION + COOLDOWN - 1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setAssetFrozen(ID, true);
        assertFalse(_frozen(ID));

        vm.warp(T0 + DURATION + COOLDOWN);
        _gFreeze(ID);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, T0 + DURATION + COOLDOWN + DURATION);
    }

    /// @dev The cooldown is per asset: a second asset can still be frozen.
    function test_cooldownIsPerAsset() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION + 1 hours);
        _gFreeze(ID2);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID2);
        assertEq(expiresAt, T0 + DURATION + 1 hours + DURATION);
    }

    /// @dev Lifting and re-freezing is not a way to restart the clock.
    function test_liftAndRefreezeKeepsTheSameWindowEnd() public {
        _gFreeze(ID);
        vm.warp(T0 + 10 hours);
        _gLift(ID);
        assertFalse(_frozen(ID));

        vm.warp(T0 + 60 hours);
        _gFreeze(ID);
        (bool inForce, uint256 since, uint256 expiresAt, uint256 windowEnd) = oracle.freezeOf(ID);
        assertTrue(inForce);
        assertEq(since, T0 + 60 hours);
        assertEq(expiresAt, T0 + DURATION, "window end must not move");
        assertEq(windowEnd, T0 + DURATION);

        vm.warp(T0 + DURATION);
        assertFalse(_frozen(ID));
    }

    function test_guardianLiftDoesNotShortenTheCooldown() public {
        _gFreeze(ID);
        vm.warp(T0 + 1 hours);
        _gLift(ID);

        // Window has ended; the cooldown runs from the window's end, not from
        // the lift.
        vm.warp(T0 + DURATION + 1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setAssetFrozen(ID, true);
    }

    function test_twoGuardiansShareOneClock() public {
        _gFreeze(ID);
        vm.prank(guardian2);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setAssetFrozen(ID, true);

        vm.warp(T0 + DURATION);
        vm.prank(guardian2);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setAssetFrozen(ID, true);
    }

    // ── admin: no expiry, takeover, early lift ───────────────────────────────

    function test_adminFreezeNeverExpires() public {
        oracle.setAssetFrozen(ID, true);
        (bool inForce, uint256 since, uint256 expiresAt, uint256 windowEnd) = oracle.freezeOf(ID);
        assertTrue(inForce);
        assertEq(since, T0);
        assertEq(expiresAt, 0);
        assertEq(windowEnd, 0, "an admin freeze opens no guardian window");

        vm.warp(T0 + 3650 days);
        _expectFrozenRead(ID);
        assertTrue(_frozen(ID));
    }

    function test_guardianCannotLiftAnAdminFreeze() public {
        oracle.setAssetFrozen(ID, true);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.NotGuardianHalt.selector);
        oracle.setAssetFrozen(ID, false);
        assertTrue(_frozen(ID));
    }

    /// @dev The tightening must not loosen anything: a guardian "re-freeze" of
    ///      an admin freeze would otherwise swap no-expiry for 72h.
    function test_guardianCannotReplaceAnAdminFreezeWithAnExpiringOne() public {
        oracle.setAssetFrozen(ID, true);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setAssetFrozen(ID, true);

        vm.warp(T0 + DURATION + COOLDOWN + 1);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setAssetFrozen(ID, true);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, 0);
        assertTrue(_frozen(ID));
    }

    function test_adminTakesOverAGuardianFreeze() public {
        _gFreeze(ID);
        vm.warp(T0 + 48 hours);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssetFreezeTakenOver(ID, admin);
        oracle.setAssetFrozen(ID, true);

        (bool inForce, uint256 since, uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertTrue(inForce);
        assertEq(since, T0, "start of the freeze is kept");
        assertEq(expiresAt, 0);

        // Past the guardian's 72h: still frozen, and the guardian cannot undo it.
        vm.warp(T0 + 30 days);
        assertTrue(_frozen(ID));
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.NotGuardianHalt.selector);
        oracle.setAssetFrozen(ID, false);

        oracle.setAssetFrozen(ID, false);
        assertFalse(_frozen(ID));
    }

    function test_adminFreezeIsIdempotent() public {
        oracle.setAssetFrozen(ID, true);
        vm.warp(T0 + 5 hours);
        vm.recordLogs();
        oracle.setAssetFrozen(ID, true);
        assertEq(vm.getRecordedLogs().length, 0);
        (, uint256 since, , ) = oracle.freezeOf(ID);
        assertEq(since, T0);
    }

    function test_adminLiftsAGuardianFreezeEarly() public {
        _gFreeze(ID);
        vm.warp(T0 + 2 hours);
        oracle.setAssetFrozen(ID, false);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 100_000e8);
    }

    function test_adminIsNotSubjectToTheCooldown() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION + 1);
        oracle.setAssetFrozen(ID, true);
        assertTrue(_frozen(ID));
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, 0);
    }

    /// @dev After the handover the admin (timelock) holds no GUARDIAN_ROLE.
    function test_adminWithoutGuardianRoleCanStillFreezeAndLift() public {
        oracle.renounceRole(oracle.GUARDIAN_ROLE(), admin);
        oracle.setAssetFrozen(ID, true);
        assertTrue(_frozen(ID));
        oracle.setAssetFrozen(ID, false);
        assertFalse(_frozen(ID));
        oracle.setPaused(true);
        assertTrue(oracle.paused());
        oracle.setPaused(false);
        assertFalse(oracle.paused());
    }

    /// @dev A no-expiry halt outlives the key that placed it.
    function test_adminFreezeSurvivesTheAdminLosingItsRole() public {
        address multisig = makeAddr("multisig");
        oracle.setAssetFrozen(ID, true);
        oracle.grantRole(oracle.DEFAULT_ADMIN_ROLE(), multisig);
        oracle.renounceRole(oracle.DEFAULT_ADMIN_ROLE(), admin);
        // The old admin still has GUARDIAN_ROLE (constructor grant): it is a
        // guardian now and cannot lift the no-expiry freeze.
        vm.expectRevert(GuardedOracle.NotGuardianHalt.selector);
        oracle.setAssetFrozen(ID, false);
        vm.warp(T0 + 365 days);
        assertTrue(_frozen(ID));
        vm.prank(multisig);
        oracle.setAssetFrozen(ID, false);
        assertFalse(_frozen(ID));
    }

    // ── access control ───────────────────────────────────────────────────────

    function test_strangerAndKeeperCannotHaltOrLift() public {
        address[2] memory who = [stranger, keeper];
        bytes32 role = oracle.GUARDIAN_ROLE();
        for (uint256 i; i < 2; i++) {
            bytes memory err = abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, who[i], role
            );
            vm.startPrank(who[i]);
            vm.expectRevert(err);
            oracle.setAssetFrozen(ID, true);
            vm.expectRevert(err);
            oracle.setAssetFrozen(ID, false);
            vm.expectRevert(err);
            oracle.setPaused(true);
            vm.expectRevert(err);
            oracle.setPaused(false);
            vm.stopPrank();
        }
        _gFreeze(ID);
        _gPause();
        vm.prank(stranger);
        vm.expectRevert();
        oracle.setAssetFrozen(ID, false);
        vm.prank(stranger);
        vm.expectRevert();
        oracle.setPaused(false);
        assertTrue(_frozen(ID));
        assertTrue(oracle.paused());
    }

    function test_freezingAnUnknownAssetReverts() public {
        bytes32 unknown = keccak256("sNOPE");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetNotFound.selector, unknown));
        oracle.setAssetFrozen(unknown, true);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetNotFound.selector, unknown));
        oracle.setAssetFrozen(unknown, true);
    }

    // ── pause ────────────────────────────────────────────────────────────────

    function test_guardianPause_lapsesAndKeepersResume() public {
        _gPause();
        assertTrue(oracle.paused());
        vm.prank(keeper);
        vm.expectRevert(GuardedOracle.IsPaused.selector);
        oracle.updatePrice(ID, 101_000e8);

        vm.warp(T0 + DURATION - 1);
        assertTrue(oracle.paused());
        vm.warp(T0 + DURATION);
        assertFalse(oracle.paused());
        (bool inForce, , , uint256 windowEnd) = oracle.pauseState();
        assertFalse(inForce);
        assertEq(windowEnd, T0 + DURATION);

        vm.prank(keeper);
        oracle.updatePrice(ID, 101_000e8);
    }

    function test_guardianPauseCannotBeExtendedAndHasACooldown() public {
        _gPause();
        vm.prank(guardian2);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setPaused(true);

        vm.warp(T0 + DURATION + COOLDOWN - 1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setPaused(true);

        vm.warp(T0 + DURATION + COOLDOWN);
        _gPause();
        (, , uint256 expiresAt, ) = oracle.pauseState();
        assertEq(expiresAt, T0 + DURATION + COOLDOWN + DURATION);
    }

    function test_guardianUnpauseAndRepauseKeepsTheWindowEnd() public {
        _gPause();
        vm.warp(T0 + 3 hours);
        _gUnpause();
        assertFalse(oracle.paused());
        vm.warp(T0 + 70 hours);
        _gPause();
        (, , uint256 expiresAt, ) = oracle.pauseState();
        assertEq(expiresAt, T0 + DURATION);
    }

    function test_adminPauseNeverExpires_guardianCannotLiftOrReplaceIt() public {
        oracle.setPaused(true);
        vm.warp(T0 + 365 days);
        assertTrue(oracle.paused());

        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.NotGuardianHalt.selector);
        oracle.setPaused(false);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
        oracle.setPaused(true);

        oracle.setPaused(false);
        assertFalse(oracle.paused());
    }

    function test_adminTakesOverAGuardianPause() public {
        _gPause();
        vm.warp(T0 + 50 hours);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PauseTakenOver(admin);
        oracle.setPaused(true);
        (bool inForce, uint256 since, uint256 expiresAt, ) = oracle.pauseState();
        assertTrue(inForce);
        assertEq(since, T0);
        assertEq(expiresAt, 0);
        vm.warp(T0 + 90 days);
        assertTrue(oracle.paused());
    }

    // ── cross-scope: freeze and pause cannot be chained ──────────────────────

    /// @dev Opened while a guardian pause window runs, a freeze ends with it.
    function test_freezeDuringAGuardianPauseWindowEndsWithThePause() public {
        _gPause();
        vm.warp(T0 + 71 hours);
        _gFreeze(ID);
        (, , uint256 expiresAt, uint256 windowEnd) = oracle.freezeOf(ID);
        assertEq(expiresAt, T0 + DURATION);
        assertEq(windowEnd, T0 + DURATION);

        vm.warp(T0 + DURATION);
        assertFalse(_frozen(ID));
        assertFalse(oracle.paused());
    }

    /// @dev Same cap when the pause was lifted early: the pause WINDOW still runs.
    function test_freezeIsCappedByAPauseWindowEvenAfterTheGuardianUnpaused() public {
        _gPause();
        _gUnpause();
        vm.warp(T0 + 30 hours);
        _gFreeze(ID);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, T0 + DURATION);
    }

    function test_noNewFreezeWindowDuringThePauseCooldown() public {
        _gPause();
        vm.warp(T0 + DURATION);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
        oracle.setAssetFrozen(ID, true);

        (uint256 e, uint256 allowedAt) = oracle.guardianFreezeTerms(ID);
        assertEq(e, 0);
        assertEq(allowedAt, T0 + DURATION + COOLDOWN);

        vm.warp(T0 + DURATION + COOLDOWN);
        _gFreeze(ID);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, T0 + DURATION + COOLDOWN + DURATION);
    }

    /// @dev The chain a per-scope cooldown alone would allow: freeze, then
    ///      pause just before the freeze lapses, then freeze again just before
    ///      the pause lapses, and so on. After the pause the asset gets a full
    ///      day with no guardian halt of any kind.
    function test_alternatingFreezeAndPauseLeavesACleanDay() public {
        _gFreeze(ID);                              // freeze window [0h, 72h)
        vm.warp(T0 + 71 hours);
        _gPause();                                 // pause window  [71h, 143h)

        // Freeze cooldown ended at 96h, but a freeze opened now is capped at
        // the pause window's end.
        vm.warp(T0 + 142 hours);
        _gFreeze(ID);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, T0 + 143 hours);

        // [143h, 167h): nothing the guardian can do to this asset.
        for (uint256 h = 143; h < 167; h++) {
            vm.warp(T0 + h * 1 hours);
            assertFalse(_frozen(ID));
            assertFalse(oracle.paused());
            vm.prank(guardian);
            vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + 167 hours));
            oracle.setAssetFrozen(ID, true);
            vm.prank(guardian);
            vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + 167 hours));
            oracle.setPaused(true);
        }
        vm.warp(T0 + 167 hours);
        _gFreeze(ID);
    }

    /// @dev A guardian that tries everything every hour for 60 days.
    function test_greedyGuardianCannotHoldAnAssetShut() public {
        _assertCleanDaysRecur(0, Strategy.Greedy);
    }

    /// @dev A guardian that relays: whichever halt is about to lapse, it
    ///      reaches for the other one. This is the strategy the shared clock
    ///      exists to stop.
    function test_relayingGuardianCannotHoldAnAssetShut() public {
        _assertCleanDaysRecur(0, Strategy.Relay);
    }

    /// @dev Random guardian-only strategies (freeze, pause, lift, wait) over 60
    ///      days, hour by hour. For the watched asset:
    ///        - no unbroken guardian halt longer than 2 x 72h;
    ///        - a clean 24h (no freeze, no pause) at least every 168h;
    ///        - every halt in force ends no later than 72h from now.
    function testFuzz_guardianAlone_cleanDayAlwaysRecurs(uint256 seed) public {
        _assertCleanDaysRecur(seed, Strategy.Random);
    }

    enum Strategy { Random, Greedy, Relay }

    function _assertCleanDaysRecur(uint256 seed, Strategy strategy) internal {
        uint256 hoursTotal = 1440;
        uint256 denialRun;      // consecutive halted hours
        uint256 cleanRun;       // consecutive clean hours
        uint256 sinceCleanDay;  // hours since the last completed clean 24h
        bool sawCleanDay;

        for (uint256 h; h < hoursTotal; h++) {
            vm.warp(T0 + h * 1 hours);
            uint256 r = uint256(keccak256(abi.encode(seed, h))) % 10;
            if (strategy == Strategy.Greedy) r = 2;
            if (strategy == Strategy.Relay) {
                (bool f0, , uint256 fe, ) = oracle.freezeOf(ID);
                (bool p0, , uint256 pe, ) = oracle.pauseState();
                if (!f0 && !p0) r = 0;                                          // nothing in force: freeze
                else if (f0 && !p0 && fe <= block.timestamp + 1 hours) r = 1;   // freeze ending: pause
                else if (p0 && !f0 && pe <= block.timestamp + 1 hours) r = 0;   // pause ending: freeze
                else r = 9;
            }
            vm.startPrank(h % 2 == 0 ? guardian : guardian2);
            if (r == 0 || r == 2 || r == 6) {
                try oracle.setAssetFrozen(ID, true) {} catch {
                    // Relay: the freeze is refused, fall back to the pause.
                    if (strategy == Strategy.Relay) { try oracle.setPaused(true) {} catch {} }
                }
            }
            if (r == 1 || r == 2 || r == 7) { try oracle.setPaused(true) {} catch {} }
            if (r == 3) { try oracle.setAssetFrozen(ID, false) {} catch {} }
            if (r == 4) { try oracle.setPaused(false) {} catch {} }
            if (r == 5) { try oracle.setAssetFrozen(ID2, true) {} catch {} }
            vm.stopPrank();

            (bool fz, , uint256 fExp, ) = oracle.freezeOf(ID);
            (bool pz, , uint256 pExp, ) = oracle.pauseState();
            if (fz) { assertGt(fExp, block.timestamp); assertLe(fExp, block.timestamp + DURATION); }
            if (pz) { assertGt(pExp, block.timestamp); assertLe(pExp, block.timestamp + DURATION); }

            if (fz || pz) {
                denialRun++;
                cleanRun = 0;
                assertLe(denialRun, 144, "unbroken guardian halt longer than 2 x 72h");
            } else {
                denialRun = 0;
                cleanRun++;
            }
            if (cleanRun >= 24) { sinceCleanDay = 0; sawCleanDay = true; }
            else sinceCleanDay++;
            assertLe(sinceCleanDay, 168 + 24, "no clean 24h within the bound");
        }
        assertTrue(sawCleanDay);
    }

    // ── interaction with the rate limit and the reference check ─────────────

    /// @dev A freeze that lapses must not hand the keeper a fresh rate-limit
    ///      budget inside the same window.
    function test_lapseDoesNotResetTheRateLimitWindow() public {
        oracle.setWindowLimit(7 days, 2_000);          // 20% per 7 days
        vm.prank(keeper);
        oracle.updatePrice(ID, 110_000e8);             // +10%, opens the window at 100k
        vm.prank(keeper);
        oracle.updatePrice(ID, 120_000e8);             // +20% from the anchor: budget used

        _gFreeze(ID);
        vm.warp(T0 + DURATION);                        // lapsed, still inside the 7-day window

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedOracle.WindowDeviationTooLarge.selector, ID, 126_000e8, 100_000e8
        ));
        oracle.updatePrice(ID, 126_000e8);

        (uint256 anchor, uint256 start) = oracle.windowOf(ID);
        assertEq(anchor, 100_000e8);
        assertEq(start, T0);
    }

    function test_lapseDoesNotRelaxTheStepCap() public {
        _gFreeze(ID);
        vm.warp(T0 + DURATION);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, ID, 111_000e8, 100_000e8));
        oracle.updatePrice(ID, 111_000e8);
    }

    /// @dev A reference-confirmed post bypasses the step cap and the window,
    ///      but never a halt.
    function test_haltsBlockEvenAReferenceConfirmedPost() public {
        oracle.setReferenceSource(address(ref));
        ref.set(ID, 150_000e8);

        _gFreeze(ID);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, ID));
        oracle.updatePrice(ID, 150_000e8);

        _gLift(ID);
        _gPause();
        vm.prank(keeper);
        vm.expectRevert(GuardedOracle.IsPaused.selector);
        oracle.updatePrice(ID, 150_000e8);
    }

    function test_referenceCheckStillAppliesAfterALapse() public {
        oracle.setReferenceSource(address(ref));
        ref.set(ID, 150_000e8);
        _gFreeze(ID);
        vm.warp(T0 + DURATION);

        // Moving away from the reference is still refused…
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.ReferenceDisagrees.selector, ID, 95_000e8, 150_000e8));
        oracle.updatePrice(ID, 95_000e8);
        // …and a confirmed post lands in one call.
        vm.prank(keeper);
        oracle.updatePrice(ID, 150_000e8);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 150_000e8);
    }

    // ── events ───────────────────────────────────────────────────────────────

    function test_events_guardianFreezeAndLift() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit AssetFrozen(ID, true);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssetFreezeStarted(ID, guardian, T0 + DURATION);
        _gFreeze(ID);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit AssetFrozen(ID, false);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssetFreezeLifted(ID, guardian);
        _gLift(ID);
    }

    function test_events_adminFreezeHasNoExpiry() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit AssetFrozen(ID, true);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssetFreezeStarted(ID, admin, 0);
        oracle.setAssetFrozen(ID, true);
    }

    function test_events_pause() public {
        vm.expectEmit(false, false, false, true, address(oracle));
        emit PausedSet(true);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PauseStarted(guardian, T0 + DURATION);
        _gPause();

        vm.expectEmit(false, false, false, true, address(oracle));
        emit PausedSet(false);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PauseLifted(guardian);
        _gUnpause();
    }

    /// @dev Lifting something that is not in force says nothing.
    function test_liftingNothingEmitsNothing() public {
        vm.recordLogs();
        _gLift(ID);
        _gUnpause();
        oracle.setAssetFrozen(ID, false);
        oracle.setPaused(false);
        assertEq(vm.getRecordedLogs().length, 0);

        _gFreeze(ID);
        vm.warp(T0 + DURATION);     // lapsed: lifting it now is a no-op too
        vm.recordLogs();
        _gLift(ID);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function test_guardianTermsViewsMatchWhatACallGets() public {
        (uint256 e, uint256 a) = oracle.guardianFreezeTerms(ID);
        assertEq(e, T0 + DURATION);
        assertEq(a, 0);
        (e, a) = oracle.guardianPauseTerms();
        assertEq(e, T0 + DURATION);
        assertEq(a, 0);

        _gPause();
        vm.warp(T0 + 10 hours);
        (e, a) = oracle.guardianFreezeTerms(ID);
        assertEq(e, T0 + DURATION, "capped by the pause window");
        _gFreeze(ID);
        (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
        assertEq(expiresAt, e);

        vm.warp(T0 + DURATION + 1 hours);
        (e, a) = oracle.guardianPauseTerms();
        assertEq(e, 0);
        assertEq(a, T0 + DURATION + COOLDOWN);
    }

    // ── fuzz: time boundaries ────────────────────────────────────────────────

    function testFuzz_guardianFreezeInForceExactlyUntilExpiry(uint256 dt) public {
        dt = bound(dt, 0, 400 days);
        _gFreeze(ID);
        vm.warp(T0 + dt);
        bool expected = dt < DURATION;
        assertEq(_frozen(ID), expected);
        assertEq(oracle.isStale(ID), expected);
        if (expected) {
            _expectFrozenRead(ID);
        } else {
            (uint256 p, ) = oracle.getPrice(ID);
            assertEq(p, 100_000e8);
        }
    }

    function testFuzz_guardianPauseInForceExactlyUntilExpiry(uint256 dt) public {
        dt = bound(dt, 0, 400 days);
        _gPause();
        vm.warp(T0 + dt);
        assertEq(oracle.paused(), dt < DURATION);
        vm.prank(keeper);
        if (dt < DURATION) vm.expectRevert(GuardedOracle.IsPaused.selector);
        oracle.updatePrice(ID, 100_500e8);
    }

    function testFuzz_adminHaltsNeverLapse(uint256 dt) public {
        dt = bound(dt, 0, 3650 days);
        oracle.setAssetFrozen(ID, true);
        oracle.setPaused(true);
        vm.warp(T0 + dt);
        assertTrue(_frozen(ID));
        assertTrue(oracle.paused());
    }

    /// @dev One guardian freeze at T0, then a second attempt `dt` later.
    function testFuzz_guardianRefreezeGate(uint256 dt) public {
        dt = bound(dt, 0, 30 days);
        _gFreeze(ID);
        vm.warp(T0 + dt);
        vm.prank(guardian2);
        if (dt < DURATION) {
            vm.expectRevert(GuardedOracle.AlreadyHalted.selector);
            oracle.setAssetFrozen(ID, true);
        } else if (dt < DURATION + COOLDOWN) {
            vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
            oracle.setAssetFrozen(ID, true);
            assertFalse(_frozen(ID));
        } else {
            oracle.setAssetFrozen(ID, true);
            (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
            assertEq(expiresAt, T0 + dt + DURATION);
        }
    }

    function testFuzz_liftAndRefreezeNeverExtends(uint256 liftAt, uint256 refreezeAt) public {
        liftAt = bound(liftAt, 0, DURATION - 1);
        refreezeAt = bound(refreezeAt, liftAt, DURATION + COOLDOWN - 1);
        _gFreeze(ID);
        vm.warp(T0 + liftAt);
        _gLift(ID);
        vm.warp(T0 + refreezeAt);
        vm.prank(guardian);
        if (refreezeAt < DURATION) {
            oracle.setAssetFrozen(ID, true);
            (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
            assertEq(expiresAt, T0 + DURATION);
        } else {
            vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
            oracle.setAssetFrozen(ID, true);
        }
    }

    /// @dev Guardian pause at T0, guardian freeze `dt` later.
    function testFuzz_freezeAnswersToThePauseClock(uint256 dt) public {
        dt = bound(dt, 0, 30 days);
        _gPause();
        vm.warp(T0 + dt);
        vm.prank(guardian);
        if (dt < DURATION) {
            oracle.setAssetFrozen(ID, true);
            (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
            assertEq(expiresAt, T0 + DURATION);
        } else if (dt < DURATION + COOLDOWN) {
            vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, T0 + DURATION + COOLDOWN));
            oracle.setAssetFrozen(ID, true);
        } else {
            oracle.setAssetFrozen(ID, true);
            (, , uint256 expiresAt, ) = oracle.freezeOf(ID);
            assertEq(expiresAt, T0 + dt + DURATION);
        }
    }

    /// @dev Whoever the guardian is and whenever it acts, the admin's lift and
    ///      takeover work at any time.
    function testFuzz_adminAlwaysOverridesAGuardianFreeze(uint256 dt, bool takeOver) public {
        dt = bound(dt, 0, DURATION - 1);
        _gFreeze(ID);
        vm.warp(T0 + dt);
        oracle.setAssetFrozen(ID, takeOver);
        vm.warp(T0 + DURATION + 1);
        assertEq(_frozen(ID), takeOver);
    }
}

/// @notice The consumer's view: a V2 vault reading the oracle. A guardian
///         freeze stops redeems; once it lapses and the keeper posts, exits
///         work again with no guardian or admin transaction.
contract GuardedOracleHaltExpiryVaultTest is Test {
    MockUSDC         usdc;
    GuardedOracle    oracle;
    AssetVaultV2     vault;
    SyntheticAssetV2 btc;

    address admin    = address(this);
    address guardian = makeAddr("guardian");
    address alice    = makeAddr("alice");

    bytes32 constant BTC = keccak256("sBTC");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc   = new MockUSDC();
        oracle = new GuardedOracle(admin);
        oracle.grantRole(oracle.KEEPER_ROLE(), admin);
        oracle.grantRole(oracle.GUARDIAN_ROLE(), guardian);
        oracle.addAsset(BTC, 100_000e8);

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        btc = new SyntheticAssetV2("Synthetic Bitcoin", "sBTC", BTC, admin);
        btc.grantRole(btc.MINTER_ROLE(), address(vault));
        vault.registerAsset(BTC, address(btc));
        vault.setAssetCap(BTC, 1_000e18);
        vault.setRiskParams(30, 30, 11_000, 1 hours);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(admin, 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(500_000e18);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_redeemWorksAgainAfterAGuardianFreezeLapses() public {
        vm.prank(alice);
        uint256 out = vault.mint(BTC, 1_000e18);
        assertGt(out, 0);

        vm.prank(guardian);
        oracle.setAssetFrozen(BTC, true);
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(BTC, out);

        // 72h later, with no guardian or admin action. The keeper's ordinary
        // heartbeat is the only transaction.
        vm.warp(block.timestamp + 72 hours);
        oracle.updatePrice(BTC, 100_000e8);
        vm.prank(alice);
        vault.redeem(BTC, out);
        assertEq(btc.balanceOf(alice), 0);
    }
}
