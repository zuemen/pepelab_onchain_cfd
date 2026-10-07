// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/AgentSessionManager.sol";
import "../src/SessionCredentialAnchor.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice SessionCredentialAnchor: only the session user may bind a v3 delegation
///         credential hash to an AgentSessionManager session (docs/SSI_AGENT_DELEGATION.md).
contract SessionCredentialAnchorTest is Test {
    PerpetualExchange       exchange;
    AgentSessionManager     manager;
    SessionCredentialAnchor anchorC;
    MockUSDC                usdc;
    MockOracle              oracle;

    address alice    = makeAddr("alice");   // session user
    address agent    = makeAddr("agent");   // session-key holder
    address stranger = makeAddr("stranger");

    bytes32 constant H1 = keccak256("credential-1");
    bytes32 constant H2 = keccak256("credential-2");

    event CredentialAnchored(
        uint256 indexed sessionId,
        address indexed user,
        bytes32 indexed credentialHash,
        bytes32 previousHash,
        uint256 version
    );
    event CredentialUnanchored(uint256 indexed sessionId, address indexed user, bytes32 indexed credentialHash);

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        manager  = new AgentSessionManager(address(exchange));
        anchorC  = new SessionCredentialAnchor(address(manager));
    }

    function _session() internal returns (uint256 id) {
        vm.prank(alice);
        id = manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);
    }

    // ── constructor ────────────────────────────────────────────────────────────

    function test_constructor_rejectsZeroManager() public {
        vm.expectRevert(SessionCredentialAnchor.ZeroSessionManager.selector);
        new SessionCredentialAnchor(address(0));
    }

    // ── access control ─────────────────────────────────────────────────────────

    function test_anchor_byUser_emitsAndIsAnchored() public {
        uint256 id = _session();
        vm.expectEmit(true, true, true, true, address(anchorC));
        emit CredentialAnchored(id, alice, H1, bytes32(0), 1);
        vm.prank(alice);
        anchorC.anchor(id, H1);

        assertTrue(anchorC.isAnchored(id, H1));
        assertFalse(anchorC.isAnchored(id, H2));
        assertEq(anchorC.currentCredential(id), H1);
        assertEq(anchorC.anchoredAt(id), block.timestamp);
        assertEq(anchorC.anchorCount(id), 1);
    }

    function test_anchor_revertsForAgent() public {
        uint256 id = _session();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotSessionUser.selector, id, agent));
        anchorC.anchor(id, H1);
    }

    function test_anchor_revertsForStranger() public {
        uint256 id = _session();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotSessionUser.selector, id, stranger));
        anchorC.anchor(id, H1);
        assertFalse(anchorC.isAnchored(id, H1));
    }

    function test_anchor_revertsForUnknownSession() public {
        // Nonexistent session: user == address(0); even address(0) as caller cannot anchor.
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotSessionUser.selector, 42, address(0)));
        anchorC.anchor(42, H1);
    }

    function test_anchor_revertsZeroHash() public {
        uint256 id = _session();
        vm.prank(alice);
        vm.expectRevert(SessionCredentialAnchor.ZeroCredentialHash.selector);
        anchorC.anchor(id, bytes32(0));
    }

    function test_unanchor_revertsForNonUser() public {
        uint256 id = _session();
        vm.prank(alice);
        anchorC.anchor(id, H1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotSessionUser.selector, id, agent));
        anchorC.unanchor(id, H1);
        assertTrue(anchorC.isAnchored(id, H1));
    }

    // ── supersession ───────────────────────────────────────────────────────────

    function test_reanchor_supersedesPrevious() public {
        uint256 id = _session();
        vm.prank(alice);
        anchorC.anchor(id, H1);

        vm.warp(block.timestamp + 60);
        vm.expectEmit(true, true, true, true, address(anchorC));
        emit CredentialAnchored(id, alice, H2, H1, 2);
        vm.prank(alice);
        anchorC.anchor(id, H2);

        assertFalse(anchorC.isAnchored(id, H1), "old credential superseded");
        assertTrue(anchorC.isAnchored(id, H2));
        assertEq(anchorC.anchorCount(id), 2);
        assertEq(anchorC.anchoredAt(id), block.timestamp);

        // Going back to H1 is an explicit new anchor (version 3), not a silent revival.
        vm.prank(alice);
        anchorC.anchor(id, H1);
        assertTrue(anchorC.isAnchored(id, H1));
        assertFalse(anchorC.isAnchored(id, H2));
        assertEq(anchorC.anchorCount(id), 3);
    }

    function test_anchor_sameHashTwice_reverts() public {
        uint256 id = _session();
        vm.startPrank(alice);
        anchorC.anchor(id, H1);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.AlreadyAnchored.selector, id, H1));
        anchorC.anchor(id, H1);
        vm.stopPrank();
    }

    function test_unanchor_clearsAndEmits() public {
        uint256 id = _session();
        vm.startPrank(alice);
        anchorC.anchor(id, H1);
        vm.expectEmit(true, true, true, true, address(anchorC));
        emit CredentialUnanchored(id, alice, H1);
        anchorC.unanchor(id, H1);
        vm.stopPrank();

        assertFalse(anchorC.isAnchored(id, H1));
        assertEq(anchorC.currentCredential(id), bytes32(0));
        assertEq(anchorC.anchoredAt(id), 0);
        assertEq(anchorC.anchorCount(id), 1, "count is monotonic");
    }

    function test_unanchor_wrongHash_reverts() public {
        uint256 id = _session();
        vm.startPrank(alice);
        anchorC.anchor(id, H2);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotCurrentCredential.selector, id, H1));
        anchorC.unanchor(id, H1);
        vm.stopPrank();
        assertTrue(anchorC.isAnchored(id, H2));
    }

    // ── session lifecycle ──────────────────────────────────────────────────────

    function test_revokedSession_isAnchoredFalse_butRecordKept() public {
        uint256 id = _session();
        vm.prank(alice);
        anchorC.anchor(id, H1);

        vm.prank(alice);
        manager.revokeSession(id);

        assertFalse(anchorC.isAnchored(id, H1), "revoked session => not anchored (live view)");
        assertEq(anchorC.currentCredential(id), H1, "record kept for audit");
        (bool recorded, bool live, address user, uint256 since) = anchorC.anchorStatus(id, H1);
        assertTrue(recorded);
        assertFalse(live);
        assertEq(user, alice);
        assertGt(since, 0);

        // Cannot anchor a new credential onto a revoked session…
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.SessionNotLive.selector, id));
        anchorC.anchor(id, H2);

        // …but can still clean up.
        vm.prank(alice);
        anchorC.unanchor(id, H1);
        assertEq(anchorC.currentCredential(id), bytes32(0));
    }

    function test_expiredSession_isAnchoredFalse() public {
        uint256 id = _session();
        vm.prank(alice);
        anchorC.anchor(id, H1);

        vm.warp(block.timestamp + 1 days); // == expiry: still live (manager uses `>`)
        assertTrue(anchorC.isAnchored(id, H1));
        vm.warp(block.timestamp + 1);
        assertFalse(anchorC.isAnchored(id, H1));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.SessionNotLive.selector, id));
        anchorC.anchor(id, H2);
    }

    function test_anchorStatus_unknownCredential() public {
        uint256 id = _session();
        (bool recorded, bool live, address user, uint256 since) = anchorC.anchorStatus(id, H1);
        assertFalse(recorded);
        assertTrue(live);
        assertEq(user, alice);
        assertEq(since, 0);
    }

    function test_sessionsAreIndependent() public {
        uint256 a = _session();
        uint256 b = _session();
        vm.startPrank(alice);
        anchorC.anchor(a, H1);
        anchorC.anchor(b, H1);
        manager.revokeSession(a);
        vm.stopPrank();
        assertFalse(anchorC.isAnchored(a, H1));
        assertTrue(anchorC.isAnchored(b, H1));
    }

    function testFuzz_onlyUserCanAnchor(address caller, bytes32 h) public {
        vm.assume(caller != alice && h != bytes32(0));
        uint256 id = _session();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(SessionCredentialAnchor.NotSessionUser.selector, id, caller));
        anchorC.anchor(id, h);
    }
}
