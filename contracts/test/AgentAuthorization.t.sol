// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Phase 2 multi-agent authorization on PerpetualExchange.
///         Extends the existing copyTracker / NotCopyTracker structure with a
///         `authorizedAgents` mapping; copyTracker stays the primary agent.
contract AgentAuthorizationTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;

    address owner   = address(this);
    address alice   = makeAddr("alice");
    address tracker = makeAddr("tracker"); // primary agent (legacy copyTracker)
    address agent2  = makeAddr("agent2");  // additional agent
    address stranger = makeAddr("stranger");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    event AgentAuthorizationSet(address indexed agent, bool authorized);

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));

        oracle.addAsset(BTC, BTC_PRICE);

        usdc.mint(alice,             100_000e18);
        usdc.mint(agent2,            100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);

        vm.prank(alice);  usdc.approve(address(exchange), type(uint256).max);
        vm.prank(agent2); usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
    }

    function _depositFor(address user, uint256 amount) internal {
        // alice deposits her own margin (self path) so openPositionFor has funds
        vm.prank(user);
        exchange.depositMargin(amount);
    }

    // ── setAgentAuthorized access control + event ────────────────────────────

    function test_setAgentAuthorized_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        exchange.setAgentAuthorized(agent2, true);
    }

    function test_setAgentAuthorized_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit AgentAuthorizationSet(agent2, true);
        exchange.setAgentAuthorized(agent2, true);
        assertTrue(exchange.authorizedAgents(agent2));
    }

    // ── setCopyTracker keeps the mapping in sync ─────────────────────────────

    function test_setCopyTracker_authorizesPrimary() public {
        exchange.setCopyTracker(tracker);
        assertTrue(exchange.authorizedAgents(tracker));
        assertEq(exchange.copyTracker(), tracker);
    }

    function test_setCopyTracker_deauthorizesPrevious() public {
        exchange.setCopyTracker(tracker);
        exchange.setCopyTracker(agent2);
        // old primary loses access, new primary gains it
        assertFalse(exchange.authorizedAgents(tracker));
        assertTrue(exchange.authorizedAgents(agent2));
    }

    // ── additional agent can use the *For entrypoints ────────────────────────

    function test_authorizedAgent_canOpenPositionFor() public {
        exchange.setCopyTracker(tracker);      // primary set (satisfies CopyTrackerNotSet guard)
        exchange.setAgentAuthorized(agent2, true);
        _depositFor(alice, 500e18);

        vm.prank(agent2);
        uint256 pid = exchange.openPositionFor(alice, BTC, true, 100e18, 1, address(0));

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        assertEq(exchange.freeMargin(alice), 400e18);
    }

    function test_authorizedAgent_canDepositMarginFor() public {
        exchange.setAgentAuthorized(agent2, true);
        vm.prank(agent2);
        exchange.depositMarginFor(alice, 1_000e18);
        assertEq(exchange.freeMargin(alice), 1_000e18);
    }

    function test_authorizedAgent_canClosePositionFor() public {
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(agent2, true);
        _depositFor(alice, 500e18);

        vm.prank(agent2);
        uint256 pid = exchange.openPositionFor(alice, BTC, true, 100e18, 1, address(0));

        vm.prank(agent2);
        exchange.closePositionFor(alice, pid);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertFalse(pos.isOpen);
    }

    // ── unauthorized / revoked agents are rejected ───────────────────────────

    function test_unauthorizedAgent_cannotOpenPositionFor() public {
        exchange.setCopyTracker(tracker);
        _depositFor(alice, 500e18);

        vm.prank(agent2); // never authorized
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        exchange.openPositionFor(alice, BTC, true, 100e18, 1, address(0));
    }

    function test_revokedAgent_cannotOpenPositionFor() public {
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(agent2, true);
        exchange.setAgentAuthorized(agent2, false); // revoke
        _depositFor(alice, 500e18);

        vm.prank(agent2);
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        exchange.openPositionFor(alice, BTC, true, 100e18, 1, address(0));
    }

    function test_deauthorizedPrimary_cannotOpenPositionFor() public {
        exchange.setCopyTracker(tracker);
        exchange.setCopyTracker(agent2); // tracker de-authorized
        _depositFor(alice, 500e18);

        vm.prank(tracker);
        vm.expectRevert(PerpetualExchange.NotCopyTracker.selector);
        exchange.openPositionFor(alice, BTC, true, 100e18, 1, address(0));
    }
}
