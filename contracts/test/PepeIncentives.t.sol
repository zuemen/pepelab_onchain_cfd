// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PepeIncentives.sol";

// ── Minimal ERC20 ─────────────────────────────────────────────────────────────

contract MockPepe {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt);
        balanceOf[from] -= amt;
        balanceOf[to]   += amt;
        return true;
    }
    function approve(address, uint256) external returns (bool) { return true; }
}

// ── Stub Exchange ─────────────────────────────────────────────────────────────

contract StubExchange {
    struct Position {
        uint256 id; address owner; bytes32 asset; bool isLong;
        uint256 entryPrice; uint256 margin; uint256 leverage;
        uint256 openedAt; uint256 closedAt; int256 realizedPnL;
        bool isOpen; address copiedFrom; int256 entryFundingIndex;
    }
    mapping(uint256 => Position) public positions;

    function set(uint256 id, address owner, uint256 margin, uint256 leverage, bytes32 asset, uint256 openedAt) external {
        positions[id] = Position(id, owner, asset, true, 0, margin, leverage, openedAt, 0, 0, true, address(0), 0);
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }
}

// ── Stub CopyTracker ──────────────────────────────────────────────────────────

contract StubCopyTracker {
    struct CopyRecord {
        address trader; uint256 versionId; uint256 initialAmount;
        uint256[] positionIds; uint256 copiedAt; bool active;
    }
    mapping(address => CopyRecord[]) public records;

    function add(address follower, address trader) external {
        uint256[] memory ids;
        records[follower].push(CopyRecord(trader, 0, 0, ids, block.timestamp, true));
    }

    function getCopyRecords(address follower) external view returns (CopyRecord[] memory) {
        return records[follower];
    }
}

// ── Stub ESG Registry ─────────────────────────────────────────────────────────

contract StubESG {
    mapping(bytes32 => uint8) public scores;
    function set(bytes32 asset, uint8 score) external { scores[asset] = score; }
    function compositeScore(bytes32 asset) external view returns (uint8) { return scores[asset]; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract PepeIncentivesTest is Test {
    MockPepe      pepe;
    StubExchange  exch;
    StubCopyTracker copy;
    StubESG       esg;
    PepeIncentives incentives;

    address alice = address(0xA);
    address bob   = address(0xB);
    bytes32 BTC   = keccak256("sBTC");

    function setUp() public {
        vm.warp(365 days); // avoid day-0 == default-storage collision

        pepe = new MockPepe();
        exch = new StubExchange();
        copy = new StubCopyTracker();
        esg  = new StubESG();

        incentives = new PepeIncentives(address(pepe), address(exch), address(copy), address(esg));

        // Fund reward pool: 1M PEPE
        pepe.mint(address(incentives), 1_000_000e18);
    }

    // ── A1. Trade Mining ──────────────────────────────────────────────────────

    function test_tradeMining_happy() public {
        exch.set(1, alice, 1000e18, 5, BTC, block.timestamp);
        vm.prank(alice);
        incentives.claimTradeMining(1);
        // reward = 5000e18 * 50 / 10000 = 25e18
        assertEq(pepe.balanceOf(alice), 25e18);
        assertEq(incentives.minedPosition(1), true);
    }

    function test_tradeMining_cap() public {
        // margin 2M × 10 leverage = 20M notional → 0.5% = 100k > 5000 cap
        exch.set(2, alice, 2_000_000e18, 10, BTC, block.timestamp);
        vm.prank(alice);
        incentives.claimTradeMining(2);
        assertEq(pepe.balanceOf(alice), 5_000e18);
    }

    function test_tradeMining_revert_notOwner() public {
        exch.set(3, alice, 100e18, 2, BTC, block.timestamp);
        vm.prank(bob);
        vm.expectRevert(PepeIncentives.NotPositionOwner.selector);
        incentives.claimTradeMining(3);
    }

    function test_tradeMining_revert_alreadyMined() public {
        exch.set(4, alice, 100e18, 2, BTC, block.timestamp);
        vm.prank(alice);
        incentives.claimTradeMining(4);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.AlreadyMined.selector);
        incentives.claimTradeMining(4);
    }

    // ── A2. Tier Reward ───────────────────────────────────────────────────────

    function test_tierReward_bronze_happy() public {
        // Need 10_000e18 cumulative notional
        exch.set(10, alice, 2_000e18, 5, BTC, block.timestamp); // 10_000e18 notional
        uint256[] memory ids = new uint256[](1);
        ids[0] = 10;
        vm.prank(alice);
        incentives.claimTierReward(0, ids);
        assertEq(pepe.balanceOf(alice), 500e18);
    }

    function test_tierReward_revert_alreadyClaimed() public {
        exch.set(11, alice, 2_000e18, 5, BTC, block.timestamp);
        uint256[] memory ids = new uint256[](1); ids[0] = 11;
        vm.prank(alice);
        incentives.claimTierReward(0, ids);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.TierAlreadyClaimed.selector);
        incentives.claimTierReward(0, ids);
    }

    function test_tierReward_revert_notMet() public {
        exch.set(12, alice, 100e18, 2, BTC, block.timestamp); // 200e18 notional, < 10_000e18
        uint256[] memory ids = new uint256[](1); ids[0] = 12;
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.TierThresholdNotMet.selector);
        incentives.claimTierReward(0, ids);
    }

    // ── A3. Copy Reward ───────────────────────────────────────────────────────

    function test_copyReward_happy() public {
        copy.add(alice, bob);
        vm.prank(alice);
        incentives.claimCopyReward(bob);
        assertEq(pepe.balanceOf(alice), 200e18);
        assertEq(pepe.balanceOf(bob),   200e18);
    }

    function test_copyReward_revert_notFollowing() public {
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.NotFollowing.selector);
        incentives.claimCopyReward(bob);
    }

    function test_copyReward_revert_alreadyClaimed() public {
        copy.add(alice, bob);
        vm.prank(alice);
        incentives.claimCopyReward(bob);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.CopyAlreadyClaimed.selector);
        incentives.claimCopyReward(bob);
    }

    // ── A4. Daily Check-in ────────────────────────────────────────────────────

    // Issues #101 / #169: a check-in credits non-transferable achievement
    // points kept in the contract. It no longer transfers PEPE.

    event CheckInPointsCredited(address indexed user, uint256 day, uint8 streak, uint256 points);
    event DailyParamsSet(uint256 base, uint256 streakBonus, uint8 streakCap);

    /// @dev The timestamp setUp warps to. A constant, so later warps cannot move
    ///      it (with via_ir a cached `block.timestamp` is re-read at each use).
    uint256 constant DAY0 = 365 days;

    function test_dailyCheckIn_happy() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 50e18);
        assertEq(pepe.balanceOf(alice), 0);
        assertEq(incentives.streak(alice), 1);
    }

    function test_dailyCheckIn_streak() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        // Advance 1 day
        vm.warp(DAY0 + 1 days);
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.streak(alice), 2);
        assertEq(incentives.achievementPoints(alice), 50e18 + 60e18); // 50 + (50+10)
        assertEq(pepe.balanceOf(alice), 0);
    }

    /// @dev The point of #169: not one PEPE leaves the contract on a check-in.
    function test_dailyCheckIn_movesNoPepe() public {
        uint256 pool = pepe.balanceOf(address(incentives));
        for (uint256 d; d < 10; d++) {
            vm.warp(DAY0 + d * 1 days);
            vm.prank(alice);
            incentives.dailyCheckIn();
            vm.prank(bob);
            incentives.dailyCheckIn();
        }
        assertEq(pepe.balanceOf(address(incentives)), pool);
        assertEq(pepe.balanceOf(alice), 0);
        assertEq(pepe.balanceOf(bob), 0);
    }

    /// @dev Points do not come out of the reward pool, so an empty pool does
    ///      not stop a check-in (it used to revert InsufficientPool).
    function test_dailyCheckIn_worksWithAnEmptyPool() public {
        incentives.withdraw(pepe.balanceOf(address(incentives)));
        assertEq(pepe.balanceOf(address(incentives)), 0);
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 50e18);
    }

    /// @dev The old build's `DailyCheckIn(address,uint256,uint8,uint256)` meant
    ///      PEPE transferred. The points build must not emit that topic, so an
    ///      indexer cannot count points as PEPE.
    function test_dailyCheckIn_doesNotEmitTheOldPepeEventTopic() public {
        bytes32 oldTopic = keccak256("DailyCheckIn(address,uint256,uint8,uint256)");
        vm.recordLogs();
        vm.prank(alice);
        incentives.dailyCheckIn();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertTrue(logs[0].topics[0] != oldTopic);
        assertEq(logs[0].topics[0], keccak256("CheckInPointsCredited(address,uint256,uint8,uint256)"));
    }

    function test_dailyCheckIn_emitsThePointsCredited() public {
        vm.expectEmit(true, false, false, true, address(incentives));
        emit CheckInPointsCredited(alice, DAY0 / 1 days, 1, 50e18);
        vm.prank(alice);
        incentives.dailyCheckIn();

        vm.warp(DAY0 + 1 days);
        vm.expectEmit(true, false, false, true, address(incentives));
        emit CheckInPointsCredited(alice, DAY0 / 1 days + 1, 2, 60e18);
        vm.prank(alice);
        incentives.dailyCheckIn();
    }

    /// @dev 50, +10 per consecutive day, capped at a 7-day streak (110).
    function test_dailyCheckIn_curveCapsAtSevenDays() public {
        uint256 expected;
        for (uint256 d; d < 10; d++) {
            vm.warp(DAY0 + d * 1 days);
            vm.prank(alice);
            incentives.dailyCheckIn();
            uint256 s = d + 1 > 7 ? 7 : d + 1;
            expected += 50e18 + 10e18 * (s - 1);
            assertEq(incentives.streak(alice), s);
            assertEq(incentives.achievementPoints(alice), expected);
        }
        // 50+60+70+80+90+100+110 + 3 x 110
        assertEq(expected, 890e18);
    }

    function test_points_arePerAccountAndSumToTheTotal() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(bob), 0);
        vm.prank(bob);
        incentives.dailyCheckIn();
        vm.warp(DAY0 + 1 days);
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 110e18);
        assertEq(incentives.achievementPoints(bob), 50e18);
        assertEq(incentives.totalAchievementPoints(), 160e18);
    }

    /// @dev Non-transferable by construction: the contract exposes nothing that
    ///      moves, approves, spends or burns points. Every ERC-20-shaped call
    ///      fails, and the balances are untouched afterwards.
    function test_points_cannotBeMovedBurnedOrApproved() public {
        vm.prank(alice);
        incentives.dailyCheckIn();

        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeWithSignature("transfer(address,uint256)", bob, 1e18);
        calls[1] = abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, 1e18);
        calls[2] = abi.encodeWithSignature("approve(address,uint256)", bob, 1e18);
        calls[3] = abi.encodeWithSignature("burn(uint256)", 1e18);
        calls[4] = abi.encodeWithSignature("burn(address,uint256)", alice, 1e18);
        calls[5] = abi.encodeWithSignature("mint(address,uint256)", bob, 1e18);
        calls[6] = abi.encodeWithSignature("transferPoints(address,uint256)", bob, 1e18);
        calls[7] = abi.encodeWithSignature("spendPoints(uint256)", 1e18);

        address[2] memory callers = [alice, address(this)];   // the holder, and the owner
        for (uint256 c; c < 2; c++) {
            for (uint256 i; i < calls.length; i++) {
                vm.prank(callers[c]);
                (bool ok, ) = address(incentives).call(calls[i]);
                assertFalse(ok);
            }
        }
        assertEq(incentives.achievementPoints(alice), 50e18);
        assertEq(incentives.achievementPoints(bob), 0);
        assertEq(incentives.totalAchievementPoints(), 50e18);
    }

    /// @dev The owner can drain the PEPE pool but has no handle on points.
    function test_points_surviveAnOwnerWithdrawAndAPause() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        incentives.withdraw(pepe.balanceOf(address(incentives)));
        incentives.pause();
        assertEq(incentives.achievementPoints(alice), 50e18);
        assertEq(incentives.totalAchievementPoints(), 50e18);
    }

    function test_dailyCheckIn_revert_whenPaused() public {
        incentives.pause();
        vm.prank(alice);
        vm.expectRevert();
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 0);

        incentives.unpause();
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 50e18);
    }

    function test_dailyCheckIn_sameDayTwiceCreditsOnce() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        vm.warp(DAY0 + 1 days - 1);                 // last second of the same UTC day
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.AlreadyCheckedIn.selector);
        incentives.dailyCheckIn();
        assertEq(incentives.achievementPoints(alice), 50e18);
    }

    function test_setDailyParams_ownerOnlyAndCapAtLeastOne() public {
        vm.prank(alice);
        vm.expectRevert();
        incentives.setDailyParams(1e18, 1e18, 3);

        vm.expectRevert(PepeIncentives.InvalidDailyParams.selector);
        incentives.setDailyParams(1e18, 1e18, 0);

        vm.expectEmit(false, false, false, true, address(incentives));
        emit DailyParamsSet(5e18, 1e18, 3);
        incentives.setDailyParams(5e18, 1e18, 3);
        for (uint256 d; d < 5; d++) {
            vm.warp(DAY0 + d * 1 days);
            vm.prank(alice);
            incentives.dailyCheckIn();
        }
        // 5 + 6 + 7 + 7 + 7
        assertEq(incentives.achievementPoints(alice), 32e18);
        assertEq(incentives.streak(alice), 3);
    }

    /// @dev Review B-F2: the owner sets the amounts, so they are bounded.
    function test_setDailyParams_bounded() public {
        uint256 maxBase = incentives.MAX_DAILY_BASE();
        uint256 maxBonus = incentives.MAX_DAILY_STREAK_BONUS();
        uint8 maxCap = incentives.MAX_DAILY_STREAK_CAP();
        assertEq(incentives.MAX_POINTS_PER_CHECK_IN(), maxBase + maxBonus * (uint256(maxCap) - 1));

        vm.expectRevert(PepeIncentives.InvalidDailyParams.selector);
        incentives.setDailyParams(maxBase + 1, 0, 1);
        vm.expectRevert(PepeIncentives.InvalidDailyParams.selector);
        incentives.setDailyParams(0, maxBonus + 1, 1);
        vm.expectRevert(PepeIncentives.InvalidDailyParams.selector);
        incentives.setDailyParams(0, 0, maxCap + 1);
        vm.expectRevert(PepeIncentives.InvalidDailyParams.selector);
        incentives.setDailyParams(type(uint256).max, 0, 1);

        incentives.setDailyParams(maxBase, maxBonus, maxCap);   // the edge itself is allowed
    }

    /// @dev At the bounds, a check-in credits at most MAX_POINTS_PER_CHECK_IN
    ///      and the streak arithmetic (done in uint256) stays put at the cap.
    function test_dailyCheckIn_atTheBounds() public {
        incentives.setDailyParams(incentives.MAX_DAILY_BASE(), incentives.MAX_DAILY_STREAK_BONUS(), incentives.MAX_DAILY_STREAK_CAP());
        uint256 last;
        for (uint256 d; d < 40; d++) {
            vm.warp(DAY0 + d * 1 days);
            uint256 before = incentives.achievementPoints(alice);
            vm.prank(alice);
            incentives.dailyCheckIn();
            last = incentives.achievementPoints(alice) - before;
            assertLe(last, incentives.MAX_POINTS_PER_CHECK_IN());
        }
        assertEq(incentives.streak(alice), incentives.MAX_DAILY_STREAK_CAP());
        assertEq(last, incentives.MAX_POINTS_PER_CHECK_IN());
    }

    /// @dev Whatever bounded parameters the owner picks, one check-in credits
    ///      at most MAX_POINTS_PER_CHECK_IN, which keeps
    ///      `totalAchievementPoints` (uint256) out of overflow reach.
    function testFuzz_setDailyParams_boundedPointsPerCheckIn(uint256 base, uint256 bonus, uint8 cap) public {
        base = bound(base, 0, incentives.MAX_DAILY_BASE());
        bonus = bound(bonus, 0, incentives.MAX_DAILY_STREAK_BONUS());
        cap = uint8(bound(cap, 1, incentives.MAX_DAILY_STREAK_CAP()));
        incentives.setDailyParams(base, bonus, cap);
        for (uint256 d; d < 35; d++) {
            vm.warp(DAY0 + d * 1 days);
            uint256 before = incentives.achievementPoints(alice);
            vm.prank(alice);
            incentives.dailyCheckIn();
            assertLe(incentives.achievementPoints(alice) - before, incentives.MAX_POINTS_PER_CHECK_IN());
        }
        assertLt(incentives.MAX_POINTS_PER_CHECK_IN(), type(uint256).max / 1e50);
    }

    /// @dev Random gaps between check-ins against a plain model of the curve.
    function testFuzz_dailyCheckIn_matchesTheCurve(uint256 seed) public {
        uint256 day = DAY0 / 1 days;
        uint256 lastDay;
        uint256 s;
        uint256 expected;
        for (uint256 i; i < 40; i++) {
            uint256 gap = uint256(keccak256(abi.encode(seed, i))) % 4;   // 0 = same day
            day += gap;
            vm.warp(day * 1 days + (uint256(keccak256(abi.encode(seed, i, "t"))) % 1 days));
            vm.prank(alice);
            if (i != 0 && gap == 0) {
                vm.expectRevert(PepeIncentives.AlreadyCheckedIn.selector);
                incentives.dailyCheckIn();
                continue;
            }
            incentives.dailyCheckIn();
            s = (i != 0 && day == lastDay + 1) ? (s + 1 > 7 ? 7 : s + 1) : 1;
            lastDay = day;
            expected += 50e18 + 10e18 * (s - 1);
            assertEq(incentives.streak(alice), s);
            assertEq(incentives.achievementPoints(alice), expected);
        }
        assertEq(incentives.totalAchievementPoints(), expected);
        assertEq(pepe.balanceOf(alice), 0);
    }

    /// @dev The other reward paths are untouched by #169: they still pay PEPE
    ///      and still need the pool.
    function test_otherRewardPathsStillPayPepeFromThePool() public {
        exch.set(900, alice, 1000e18, 5, BTC, block.timestamp);
        vm.prank(alice);
        incentives.claimTradeMining(900);
        assertEq(pepe.balanceOf(alice), 25e18);
        assertEq(incentives.achievementPoints(alice), 0);

        incentives.withdraw(pepe.balanceOf(address(incentives)));
        exch.set(901, alice, 1000e18, 5, BTC, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.InsufficientPool.selector);
        incentives.claimTradeMining(901);
    }

    function test_dailyCheckIn_revert_sameDayTwice() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.AlreadyCheckedIn.selector);
        incentives.dailyCheckIn();
    }

    function test_dailyCheckIn_streakReset() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        // Skip 2 days (streak should reset)
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.streak(alice), 1);
        assertEq(incentives.achievementPoints(alice), 100e18);   // 50 + 50, no bonus
    }

    // ── A5. ESG Hold Reward ───────────────────────────────────────────────────

    function test_esgHold_happy() public {
        esg.set(BTC, 80); // ESG score 80 >= 70
        uint256 openedAt = block.timestamp;
        exch.set(20, alice, 100e18, 5, BTC, openedAt);
        // Advance 31 days
        vm.warp(openedAt + 31 days);
        vm.prank(alice);
        incentives.claimEsgHoldReward(20);
        // 100e18 * 5 = 500e18 notional; 2% = 10e18
        assertEq(pepe.balanceOf(alice), 10e18);
    }

    function test_esgHold_revert_tooShort() public {
        esg.set(BTC, 80);
        exch.set(21, alice, 100e18, 5, BTC, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.HoldTooShort.selector);
        incentives.claimEsgHoldReward(21);
    }

    function test_esgHold_revert_lowScore() public {
        esg.set(BTC, 50); // < 70
        exch.set(22, alice, 100e18, 5, BTC, block.timestamp);
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.EsgScoreTooLow.selector);
        incentives.claimEsgHoldReward(22);
    }

    // ── Owner withdraw ────────────────────────────────────────────────────────

    function test_withdraw() public {
        uint256 before = pepe.balanceOf(address(this));
        incentives.withdraw(1000e18);
        assertEq(pepe.balanceOf(address(this)), before + 1000e18);
    }
}
