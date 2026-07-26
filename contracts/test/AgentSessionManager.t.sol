// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/AgentSessionManager.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Phase 2 step 2: bounded session-key delegation layer.
contract AgentSessionManagerTest is Test {
    PerpetualExchange exchange;
    AgentSessionManager manager;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice    = makeAddr("alice");    // session user (funds + positions)
    address bob      = makeAddr("bob");       // unrelated user
    address agent    = makeAddr("agent");     // session-key holder
    address tracker  = makeAddr("tracker");   // primary copyTracker (satisfies guard)
    address stranger = makeAddr("stranger");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        manager  = new AgentSessionManager(address(exchange));

        oracle.addAsset(BTC, BTC_PRICE);

        usdc.mint(alice,             100_000e18);
        usdc.mint(bob,               100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);

        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        // Wiring: primary tracker set (guard) + manager authorized as extra agent.
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(address(manager), true);

        // alice deposits margin; session trades from her freeMargin.
        vm.prank(alice); exchange.depositMargin(10_000e18);
    }

    function _session() internal returns (uint256) {
        // per-trade 1_000, budget 3_000, maxLev 5, expiry +1 day
        vm.prank(alice);
        return manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);
    }

    // ── createSession validation ─────────────────────────────────────────────

    function test_createSession_revertsZeroAgent() public {
        vm.prank(alice);
        vm.expectRevert(AgentSessionManager.ZeroAgent.selector);
        manager.createSession(address(0), 1e18, 1e18, 5, block.timestamp + 1 days);
    }

    function test_createSession_revertsZeroBudget() public {
        vm.prank(alice);
        vm.expectRevert(AgentSessionManager.ZeroBudget.selector);
        manager.createSession(agent, 0, 1e18, 5, block.timestamp + 1 days);
    }

    function test_createSession_revertsPastExpiry() public {
        vm.prank(alice);
        vm.expectRevert(AgentSessionManager.InvalidExpiry.selector);
        manager.createSession(agent, 1e18, 1e18, 5, block.timestamp);
    }

    // ── happy path ────────────────────────────────────────────────────────────

    function test_agent_canOpenWithinLimits() public {
        uint256 sid = _session();
        vm.prank(agent);
        uint256 pid = manager.openPositionForSession(sid, BTC, true, 1_000e18, 2, address(0));

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        assertEq(pos.leverage, 2);
        (, , , , uint256 spent, , , ) = manager.sessions(sid);
        assertEq(spent, 1_000e18);
    }

    function test_agent_canCloseSessionPosition() public {
        uint256 sid = _session();
        vm.prank(agent);
        uint256 pid = manager.openPositionForSession(sid, BTC, true, 1_000e18, 2, address(0));

        vm.prank(agent);
        manager.closePositionForSession(sid, pid);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertFalse(pos.isOpen);
    }

    // ── limit enforcement ───────────────────────────────────────────────────

    function test_open_revertsOverPerTradeCap() public {
        uint256 sid = _session();
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.MarginExceedsPerTradeCap.selector);
        manager.openPositionForSession(sid, BTC, true, 1_001e18, 2, address(0));
    }

    function test_open_revertsOverBudget() public {
        uint256 sid = _session();
        // budget 3_000; three 1_000 opens OK, fourth exceeds
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            manager.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
        }
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.BudgetExceeded.selector);
        manager.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
    }

    function test_open_revertsOverLeverageCap() public {
        vm.prank(alice);
        uint256 sid = manager.createSession(agent, 1_000e18, 3_000e18, 2, block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.LeverageExceedsSessionCap.selector);
        manager.openPositionForSession(sid, BTC, true, 1_000e18, 5, address(0));
    }

    // ── access control / lifecycle ────────────────────────────────────────────

    function test_open_revertsForNonAgent() public {
        uint256 sid = _session();
        vm.prank(stranger);
        vm.expectRevert(AgentSessionManager.NotSessionAgent.selector);
        manager.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
    }

    function test_open_revertsAfterExpiry() public {
        uint256 sid = _session();
        vm.warp(block.timestamp + 2 days);
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.SessionExpired.selector);
        manager.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
    }

    function test_open_revertsAfterRevoke() public {
        uint256 sid = _session();
        vm.prank(alice);
        manager.revokeSession(sid);
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.SessionIsRevoked.selector);
        manager.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
    }

    function test_revoke_onlyUser() public {
        uint256 sid = _session();
        vm.prank(stranger);
        vm.expectRevert(AgentSessionManager.NotSessionOwner.selector);
        manager.revokeSession(sid);
    }

    function test_close_revertsForNonSessionUserPosition() public {
        uint256 sid = _session();
        // bob opens his own position directly
        vm.prank(bob); exchange.depositMargin(2_000e18);
        vm.prank(bob);
        uint256 bobPid = exchange.openPosition(BTC, true, 1_000e18, 1);

        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.NotSessionUserPosition.selector);
        manager.closePositionForSession(sid, bobPid);
    }

    // ── exchange-level guard still applies ──────────────────────────────────────

    function test_open_revertsWhenManagerNotAuthorizedOnExchange() public {
        // fresh manager that is NOT authorized on the exchange
        AgentSessionManager m2 = new AgentSessionManager(address(exchange));
        vm.prank(alice);
        uint256 sid = m2.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);

        vm.prank(agent);
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        m2.openPositionForSession(sid, BTC, true, 1_000e18, 1, address(0));
    }
}
