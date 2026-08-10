// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../src/MockOracle.sol";

/// @dev Stand-in for a decentralized feed used as the reference source.
contract RefSource {
    mapping(bytes32 => uint256) public p;
    bool public broken;

    function set(bytes32 id, uint256 v) external { p[id] = v; }
    function setBroken(bool b) external { broken = b; }

    function getPrice(bytes32 id) external view returns (uint256, uint256) {
        require(!broken, "ref down");
        return (p[id], block.timestamp);
    }
}

/// @notice GuardedOracle exists to bound the single-key risk in MockOracle,
///         where one compromised owner can set any price and drain everything
///         downstream. These tests are written from the attacker's side: what
///         can a compromised keeper actually achieve?
contract GuardedOracleTest is Test {
    GuardedOracle oracle;
    RefSource     ref;

    address admin    = address(this);
    address keeper   = makeAddr("keeper");
    address keeper2  = makeAddr("keeper2");
    address guardian = makeAddr("guardian");
    address attacker = makeAddr("attacker");

    bytes32 constant ID = keccak256("sBTC");

    function setUp() public {
        oracle = new GuardedOracle(admin);
        ref    = new RefSource();

        oracle.grantRole(oracle.KEEPER_ROLE(), keeper);
        oracle.grantRole(oracle.KEEPER_ROLE(), keeper2);
        oracle.grantRole(oracle.GUARDIAN_ROLE(), guardian);

        oracle.addAsset(ID, 100_000e8);
    }

    // ── the attack MockOracle allows ─────────────────────────────────────────

    /// @dev On MockOracle this succeeds: one key sets any price it likes.
    ///      Kept as the baseline the guard is measured against.
    function test_baseline_mockOracleLetsOwnerSetAnyPrice() public {
        MockOracle mock = new MockOracle();
        mock.addAsset(ID, 100_000e8);
        mock.updatePrice(ID, 1);            // $0.00000001, no objection
        (uint256 p, ) = mock.getPrice(ID);
        assertEq(p, 1);
    }

    /// @dev The same move against GuardedOracle is refused even though the
    ///      caller IS an authorized keeper. This is the core property.
    function test_compromisedKeeperCannotCrashThePrice() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, ID, 1, 100_000e8)
        );
        oracle.updatePrice(ID, 1);

        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 100_000e8);             // untouched
    }

    function test_compromisedKeeperCannotSpikeThePrice() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.updatePrice(ID, 10_000_000e8);
    }

    /// @dev Bounded moves still work, so the guard does not break normal
    ///      operation — 5% with a 10% cap.
    function test_normalMoveIsAccepted() public {
        vm.prank(keeper);
        oracle.updatePrice(ID, 105_000e8);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 105_000e8);
    }

    /// @dev A patient attacker can still walk the price in legal steps. The
    ///      guard buys time and leaves a trail; it does not make keepers
    ///      trustless. Stated here so nobody mistakes it for more than it is.
    function test_attackerCanStillWalkPriceGradually() public {
        uint256 price = 100_000e8;
        for (uint256 i = 0; i < 5; i++) {
            price = price * 109 / 100;      // 9% per step, under the cap
            vm.prank(keeper);
            oracle.updatePrice(ID, price);
        }
        (uint256 p, ) = oracle.getPrice(ID);
        assertGt(p, 150_000e8);             // ~1.54x after five posts
    }

    function test_rejectionIsNotAClamp() public {
        // A clamped price would be a fabricated number the reader cannot detect.
        vm.prank(keeper);
        try oracle.updatePrice(ID, 1) {
            fail();
        } catch {
            (uint256 p, ) = oracle.getPrice(ID);
            assertEq(p, 100_000e8);         // old price kept, nothing invented
        }
    }

    // ── reference source ─────────────────────────────────────────────────────

    /// @dev With a decentralized feed wired in, a keeper post that disagrees
    ///      with it is refused even when inside the deviation cap.
    function test_postDisagreeingWithReferenceIsRejected() public {
        oracle.setReferenceSource(address(ref));
        // Reference has drifted well below the last posted price. The new post
        // is a legal 8% move from the previous price, so only the reference
        // check can catch it — which is the branch under test.
        ref.set(ID, 90_000e8);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardedOracle.ReferenceDisagrees.selector, ID, 108_000e8, 90_000e8
            )
        );
        oracle.updatePrice(ID, 108_000e8);
    }

    function test_postAgreeingWithReferenceIsAccepted() public {
        oracle.setReferenceSource(address(ref));
        ref.set(ID, 104_000e8);

        vm.prank(keeper);
        oracle.updatePrice(ID, 105_000e8);  // ~1% off reference
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 105_000e8);
    }

    /// @dev A reference outage must not freeze the platform.
    function test_referenceOutageDoesNotBlockUpdates() public {
        oracle.setReferenceSource(address(ref));
        ref.setBroken(true);

        vm.prank(keeper);
        oracle.updatePrice(ID, 105_000e8);  // falls through to the deviation cap
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 105_000e8);
    }

    // ── guardian ─────────────────────────────────────────────────────────────

    /// @dev Freezing makes reads revert, so downstream contracts fail closed
    ///      rather than trading on a price under investigation.
    function test_frozenAssetFailsClosedOnRead() public {
        vm.prank(guardian);
        oracle.setAssetFrozen(ID, true);

        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, ID));
        oracle.getPrice(ID);

        assertTrue(oracle.isStale(ID));     // adapters see it as unusable
    }

    function test_frozenAssetRejectsWrites() public {
        vm.prank(guardian);
        oracle.setAssetFrozen(ID, true);
        vm.prank(keeper);
        vm.expectRevert();
        oracle.updatePrice(ID, 101_000e8);
    }

    function test_pauseStopsAllKeepers() public {
        vm.prank(guardian);
        oracle.setPaused(true);

        vm.prank(keeper);
        vm.expectRevert(GuardedOracle.IsPaused.selector);
        oracle.updatePrice(ID, 101_000e8);

        vm.prank(keeper2);
        vm.expectRevert(GuardedOracle.IsPaused.selector);
        oracle.updatePrice(ID, 101_000e8);
    }

    /// @dev peek() stays readable while frozen so an operator can see WHY.
    function test_peekWorksWhileFrozen() public {
        vm.prank(guardian);
        oracle.setAssetFrozen(ID, true);
        (uint256 p, , bool exists, bool frozen) = oracle.peek(ID);
        assertEq(p, 100_000e8);
        assertTrue(exists);
        assertTrue(frozen);
    }

    // ── staleness ────────────────────────────────────────────────────────────

    function test_staleReadReverts() public {
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        oracle.getPrice(ID);
        assertTrue(oracle.isStale(ID));
    }

    // ── access control ───────────────────────────────────────────────────────

    function test_nonKeeperCannotPost() public {
        vm.prank(attacker);
        vm.expectRevert();
        oracle.updatePrice(ID, 101_000e8);
    }

    function test_keeperCannotChangeRiskParams() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.setRiskParams(5_000, 1 hours);
    }

    function test_keeperCannotFreeze() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.setAssetFrozen(ID, true);
    }

    /// @dev A 100% cap would let one post double or zero the price, defeating
    ///      the control entirely.
    function test_deviationCapCannotBeSetUselesslyHigh() public {
        vm.expectRevert(GuardedOracle.InvalidParam.selector);
        oracle.setRiskParams(5_001, 1 hours);
    }

    /// @dev The admin key is the real power here, which is why it belongs in a
    ///      multisig behind a timelock. Ownership can be handed over.
    function test_adminRoleCanBeTransferredToAMultisig() public {
        address multisig = makeAddr("multisig");
        oracle.grantRole(oracle.DEFAULT_ADMIN_ROLE(), multisig);
        oracle.renounceRole(oracle.DEFAULT_ADMIN_ROLE(), address(this));

        assertTrue(oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), multisig));
        assertFalse(oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), address(this)));

        vm.expectRevert();
        oracle.setRiskParams(500, 1 hours);   // old admin is powerless
    }

    /// 上下方向的容許幅度必須一致。舊實作以「較小值」為分母，於是 +10% 可過、
    /// -10% 被拒（實際只容許 -9.09%）——在崩盤時最容易擋住最該通過的更新。
    function test_deviationCapIsSymmetric() public {
        bytes32 id = keccak256("sSYM");
        oracle.addAsset(id, 100e8);

        // cap = 1000 bps = 10%
        vm.prank(keeper);
        oracle.updatePrice(id, 110e8);      // +10% 應通過
        (uint256 p,) = oracle.getPrice(id);
        assertEq(p, 110e8);

        vm.prank(keeper);
        oracle.updatePrice(id, 99e8);       // 110 → 99 是 -10%，必須同樣通過
        (p,) = oracle.getPrice(id);
        assertEq(p, 99e8);
    }

    function test_deviationCapStillRejectsBeyondCap() public {
        bytes32 id = keccak256("sSYM2");
        oracle.addAsset(id, 100e8);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, id, 111e8, 100e8)
        );
        oracle.updatePrice(id, 111e8);      // +11% 仍應被拒

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, id, 89e8, 100e8)
        );
        oracle.updatePrice(id, 89e8);       // -11% 仍應被拒
    }

    /// 一個 12% 的下跌現在需要兩步走完，而且每一步都必須被接受——這正是 keeper
    /// 的 stepTowards（agent/keeper/core.ts）所依賴的性質。
    function test_largeDropReachableInTwoSteps() public {
        bytes32 id = keccak256("sSYM3");
        oracle.addAsset(id, 100e8);

        vm.prank(keeper);
        oracle.updatePrice(id, 90.5e8);     // 第一步 −9.5%
        vm.prank(keeper);
        oracle.updatePrice(id, 88e8);       // 第二步走到目標
        (uint256 p,) = oracle.getPrice(id);
        assertEq(p, 88e8);
    }
}
