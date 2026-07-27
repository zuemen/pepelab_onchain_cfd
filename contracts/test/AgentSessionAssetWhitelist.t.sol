// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/AgentSessionManager.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Per-session asset allow-list.
///
///         The existing caps (per-trade margin, total budget, max leverage)
///         bound how much an agent can lose. None of them bound WHAT it trades,
///         so a budgeted agent could put the entire allowance into an asset the
///         user never intended to hold. This closes that.
///
///         Opt-in by design: a session with no list may trade anything, so
///         sessions created through the original createSession() are unaffected.
contract AgentSessionAssetWhitelistTest is Test {
    PerpetualExchange   exchange;
    AgentSessionManager manager;
    MockUSDC            usdc;
    MockOracle          oracle;

    address alice   = makeAddr("alice");
    address agent   = makeAddr("agent");
    address tracker = makeAddr("tracker");

    bytes32 constant BTC  = keccak256("BTC");
    bytes32 constant ETH  = keccak256("ETH");
    bytes32 constant AAPL = keccak256("AAPL");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        manager  = new AgentSessionManager(address(exchange));

        oracle.addAsset(BTC,  100_000e8);
        oracle.addAsset(ETH,    3_000e8);
        oracle.addAsset(AAPL,     200e8);

        usdc.mint(alice, 100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(address(manager), true);

        vm.prank(alice); exchange.depositMargin(10_000e18);
    }

    function _restrictedSession(bytes32[] memory assets) internal returns (uint256) {
        vm.prank(alice);
        return manager.createSessionWithAssets(
            agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days, assets
        );
    }

    function _one(bytes32 a) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](1);
        arr[0] = a;
    }

    // ── backward compatibility ───────────────────────────────────────────────

    /// @dev The guarantee that makes redeploying safe: sessions created the old
    ///      way keep trading anything.
    function test_sessionWithoutListCanTradeAnyAsset() public {
        vm.prank(alice);
        uint256 sid = manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);

        assertEq(manager.allowedAssetCount(sid), 0);
        assertTrue(manager.isAssetAllowed(sid, BTC));
        assertTrue(manager.isAssetAllowed(sid, AAPL));

        vm.prank(agent);
        manager.openPositionForSession(sid, AAPL, true, 100e18, 2, address(0));
    }

    function test_emptyArrayIsUnrestricted() public {
        uint256 sid = _restrictedSession(new bytes32[](0));
        assertEq(manager.allowedAssetCount(sid), 0);
        assertTrue(manager.isAssetAllowed(sid, AAPL));
    }

    // ── enforcement ──────────────────────────────────────────────────────────

    function test_allowedAssetCanBeTraded() public {
        uint256 sid = _restrictedSession(_one(BTC));
        vm.prank(agent);
        uint256 pid = manager.openPositionForSession(sid, BTC, true, 100e18, 2, address(0));

        // Position ids start at 0, so assert the position itself, not the id.
        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.owner, alice);
        assertEq(pos.asset, BTC);
        assertTrue(pos.isOpen);
    }

    /// @dev The point of the feature.
    function test_disallowedAssetIsRejected() public {
        uint256 sid = _restrictedSession(_one(BTC));

        assertFalse(manager.isAssetAllowed(sid, AAPL));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentSessionManager.AssetNotAllowed.selector, sid, AAPL)
        );
        manager.openPositionForSession(sid, AAPL, true, 100e18, 2, address(0));
    }

    function test_multipleAssetsAllowed() public {
        bytes32[] memory two = new bytes32[](2);
        two[0] = BTC;
        two[1] = ETH;
        uint256 sid = _restrictedSession(two);

        assertEq(manager.allowedAssetCount(sid), 2);
        assertTrue(manager.isAssetAllowed(sid, BTC));
        assertTrue(manager.isAssetAllowed(sid, ETH));
        assertFalse(manager.isAssetAllowed(sid, AAPL));
    }

    function test_duplicatesDoNotInflateCount() public {
        bytes32[] memory dup = new bytes32[](3);
        dup[0] = BTC;
        dup[1] = BTC;
        dup[2] = ETH;
        uint256 sid = _restrictedSession(dup);
        assertEq(manager.allowedAssetCount(sid), 2);
    }

    // ── who may change it ────────────────────────────────────────────────────

    /// @dev An agent that could widen its own permissions would make the list
    ///      decorative. This is the test that gives the feature its teeth.
    function test_agentCannotWidenItsOwnPermissions() public {
        uint256 sid = _restrictedSession(_one(BTC));

        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.NotSessionOwner.selector);
        manager.setSessionAssets(sid, _one(AAPL));

        assertFalse(manager.isAssetAllowed(sid, AAPL));
    }

    function test_strangerCannotChangeList() public {
        uint256 sid = _restrictedSession(_one(BTC));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(AgentSessionManager.NotSessionOwner.selector);
        manager.setSessionAssets(sid, _one(AAPL));
    }

    function test_ownerCanReplaceList() public {
        uint256 sid = _restrictedSession(_one(BTC));

        vm.prank(alice);
        manager.setSessionAssets(sid, _one(ETH));

        // BTC must genuinely lose permission, not linger from the old list.
        assertFalse(manager.isAssetAllowed(sid, BTC));
        assertTrue(manager.isAssetAllowed(sid, ETH));
        assertEq(manager.allowedAssetCount(sid), 1);
    }

    function test_ownerCanClearListBackToUnrestricted() public {
        uint256 sid = _restrictedSession(_one(BTC));
        vm.prank(alice);
        manager.setSessionAssets(sid, new bytes32[](0));

        assertEq(manager.allowedAssetCount(sid), 0);
        assertTrue(manager.isAssetAllowed(sid, AAPL));
    }

    /// @dev Narrowing mid-session must stop the agent immediately.
    function test_narrowingTakesEffectOnNextTrade() public {
        uint256 sid = _restrictedSession(_one(BTC));

        vm.prank(agent);
        manager.openPositionForSession(sid, BTC, true, 100e18, 2, address(0));

        bytes32[] memory onlyEth = _one(ETH);
        vm.prank(alice);
        manager.setSessionAssets(sid, onlyEth);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentSessionManager.AssetNotAllowed.selector, sid, BTC)
        );
        manager.openPositionForSession(sid, BTC, true, 100e18, 2, address(0));
    }

    function test_allowedAssetsViewReturnsList() public {
        bytes32[] memory two = new bytes32[](2);
        two[0] = BTC;
        two[1] = ETH;
        uint256 sid = _restrictedSession(two);

        bytes32[] memory got = manager.allowedAssets(sid);
        assertEq(got.length, 2);
        assertEq(got[0], BTC);
        assertEq(got[1], ETH);
    }

    /// @dev The allow-list is an extra gate, not a replacement for the caps.
    function test_allowListDoesNotBypassMarginCap() public {
        uint256 sid = _restrictedSession(_one(BTC));
        vm.prank(agent);
        vm.expectRevert(AgentSessionManager.MarginExceedsPerTradeCap.selector);
        manager.openPositionForSession(sid, BTC, true, 2_000e18, 2, address(0));
    }
}
