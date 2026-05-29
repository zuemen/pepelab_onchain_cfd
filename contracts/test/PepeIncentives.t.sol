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
        pepe = new MockPepe();
        exch = new StubExchange();
        copy = new StubCopyTracker();
        esg  = new StubESG();

        incentives = new PepeIncentives(address(pepe), address(exch), address(copy));
        incentives.setEsgRegistry(address(esg));

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

    function test_dailyCheckIn_happy() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(pepe.balanceOf(alice), 50e18);
        assertEq(incentives.streak(alice), 1);
    }

    function test_dailyCheckIn_streak() public {
        vm.prank(alice);
        incentives.dailyCheckIn();
        // Advance 1 day
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        incentives.dailyCheckIn();
        assertEq(incentives.streak(alice), 2);
        assertEq(pepe.balanceOf(alice), 50e18 + 60e18); // 50 + (50+10)
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
