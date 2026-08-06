// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AggregatorOracleAdapter.sol";

/// @dev Configurable oracle source: can serve a price, report itself stale,
///      revert, or return zero — the four states _probe has to survive.
contract SourceStub {
    mapping(bytes32 => uint256) public price;
    mapping(bytes32 => uint256) public updatedAt;
    mapping(bytes32 => bool)    public stale;

    bool public revertOnGetPrice;
    bool public revertOnIsStale;

    function set(bytes32 id, uint256 p, uint256 t) external {
        price[id] = p;
        updatedAt[id] = t;
    }

    function setStale(bytes32 id, bool s) external { stale[id] = s; }
    function setRevertOnGetPrice(bool v) external { revertOnGetPrice = v; }
    function setRevertOnIsStale(bool v)  external { revertOnIsStale  = v; }

    function getPrice(bytes32 id) external view returns (uint256, uint256) {
        require(!revertOnGetPrice, "source down");
        return (price[id], updatedAt[id]);
    }

    function isStale(bytes32 id) external view returns (bool) {
        require(!revertOnIsStale, "isStale down");
        return stale[id];
    }
}

/// @notice AggregatorOracleAdapter had no dedicated test file. It is the piece
///         that would front Chainlink and Pyth in production, so its degrade
///         and fail-closed behaviour is worth pinning.
contract AggregatorOracleAdapterTest is Test {
    AggregatorOracleAdapter agg;
    SourceStub a;
    SourceStub b;

    address alice = makeAddr("alice");
    bytes32 constant ID = keccak256("sBTC");

    function setUp() public {
        a = new SourceStub();
        b = new SourceStub();
        agg = new AggregatorOracleAdapter(address(a), address(b));
    }

    // ── both sources healthy ─────────────────────────────────────────────────

    /// @dev Agreement within tolerance: take the fresher quote.
    function test_bothLiveAndAgreeing_takesFresherQuote() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 100_050e8, 2_000);      // 5 bps apart, b is newer

        (uint256 p, uint256 t) = agg.getPrice(ID);
        assertEq(p, 100_050e8);
        assertEq(t, 2_000);
        assertFalse(agg.isStale(ID));
    }

    function test_takesSourceAWhenItIsFresher() public {
        a.set(ID, 100_000e8, 3_000);
        b.set(ID, 100_050e8, 2_000);

        (uint256 p, uint256 t) = agg.getPrice(ID);
        assertEq(p, 100_000e8);
        assertEq(t, 3_000);
    }

    /// @dev REWRITTEN for M-1. This used to assert that ANY spread over 1%
    ///      reverted. That fail-closed-everywhere posture also blocked
    ///      `closePosition` and `liquidatePosition`, which read the very same
    ///      `getPrice` — so during the volatility that makes two feeds disagree,
    ///      nobody could reduce risk and no liquidator could act. A 10% spread
    ///      is now *degraded*: the price is still served (so risk can be cut),
    ///      and the divergence is surfaced through isStale/isDegraded.
    function test_softDisagreementServesDegradedPriceInsteadOfBlocking() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 110_000e8, 2_000);      // 1000 bps apart, soft bound is 100

        (uint256 p, uint256 t) = agg.getPrice(ID);
        assertEq(p, 110_000e8, "fresher quote is still served");
        assertEq(t, 2_000);

        assertTrue(agg.isDegraded(ID), "and it is flagged as degraded");
        assertTrue(agg.isStale(ID),    "monitoring readers see it too");
    }

    /// @dev Past the hard bound the two numbers are not noise: one feed is
    ///      broken or compromised. There the fail-closed revert is kept.
    function test_hardDisagreementStillFailsClosed() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 130_000e8, 1_000);      // 3000 bps apart, halt bound is 2000

        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorOracleAdapter.PriceDeviationTooHigh.selector, ID, 100_000e8, 130_000e8
            )
        );
        agg.getPrice(ID);

        assertTrue(agg.isStale(ID));
        assertFalse(agg.isDegraded(ID), "halted is not merely degraded");
    }

    function test_deviationExactlyAtToleranceIsAccepted() public {
        a.set(ID, 10_000e8, 1_000);
        b.set(ID, 10_100e8, 1_000);       // exactly 100 bps of the lower price
        (uint256 p, ) = agg.getPrice(ID);
        assertGt(p, 0);
    }

    function test_wideningToleranceAdmitsPreviouslyRejectedSpread() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 110_000e8, 1_000);

        agg.setMaxDeviationBps(2_000);    // 20%
        (uint256 p, ) = agg.getPrice(ID);
        // Tie on timestamp resolves to A, because the check is `tA >= tB`.
        assertEq(p, 100_000e8);
    }

    // ── degrading to one source (PA-7) ───────────────────────────────────────

    /// @dev THE PA-7 REGRESSION. These tests used to assert that a single live
    ///      source silently serves the price. That is fail-open: it turns the
    ///      whole two-source design into decoration the moment one feed is
    ///      misconfigured — which is exactly what happened on the live
    ///      deployment, where the Chainlink leg was never wired and the
    ///      "aggregator" was a bare Pyth passthrough. Degrading is now an
    ///      explicit owner decision.
    function test_singleLiveSourceFailsClosedByDefault() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 100_000e8, 1_000);
        a.setRevertOnGetPrice(true);

        vm.expectRevert(
            abi.encodeWithSelector(AggregatorOracleAdapter.SingleSourceNotAllowed.selector, ID)
        );
        agg.getPrice(ID);
        assertTrue(agg.isStale(ID), "a one-legged aggregate is not trustworthy");
    }

    function test_fallsBackWhenSourceARevertsIfDegradeIsEnabled() public {
        agg.setAllowSingleSource(true);
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 100_000e8, 1_000);
        a.setRevertOnGetPrice(true);

        (uint256 p, ) = agg.getPrice(ID);
        assertEq(p, 100_000e8);           // served by b
        assertFalse(agg.isStale(ID));
    }

    function test_fallsBackWhenSourceAReportsItselfStale() public {
        agg.setAllowSingleSource(true);
        a.set(ID, 99_000e8, 1_000);
        a.setStale(ID, true);
        b.set(ID, 100_000e8, 1_000);

        (uint256 p, ) = agg.getPrice(ID);
        assertEq(p, 100_000e8);
    }

    /// @dev A source whose isStale itself reverts must be treated as dead, not
    ///      trusted by default.
    function test_sourceWithRevertingIsStaleIsTreatedAsDead() public {
        agg.setAllowSingleSource(true);
        a.set(ID, 99_000e8, 1_000);
        a.setRevertOnIsStale(true);
        b.set(ID, 100_000e8, 1_000);

        (uint256 p, ) = agg.getPrice(ID);
        assertEq(p, 100_000e8);
    }

    function test_zeroPriceCountsAsDead() public {
        agg.setAllowSingleSource(true);
        a.set(ID, 0, 1_000);              // zero is not a price
        b.set(ID, 100_000e8, 1_000);

        (uint256 p, ) = agg.getPrice(ID);
        assertEq(p, 100_000e8);
    }

    /// @dev A wide spread does NOT block the feed when only one source is live
    ///      — there is nothing to disagree with.
    function test_deviationIrrelevantWhenOnlyOneSourceLive() public {
        agg.setAllowSingleSource(true);
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 500_000e8, 1_000);
        b.setStale(ID, true);

        (uint256 p, ) = agg.getPrice(ID);
        assertEq(p, 100_000e8);
        assertFalse(agg.isStale(ID));
    }

    // ── no source ────────────────────────────────────────────────────────────

    function test_revertsWhenNeitherSourceIsLive() public {
        a.setRevertOnGetPrice(true);
        b.setRevertOnGetPrice(true);

        vm.expectRevert(
            abi.encodeWithSelector(AggregatorOracleAdapter.NoLiveSource.selector, ID)
        );
        agg.getPrice(ID);

        assertTrue(agg.isStale(ID));
    }

    function test_unknownAssetHasNoLiveSource() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorOracleAdapter.NoLiveSource.selector, keccak256("unknown")
            )
        );
        agg.getPrice(keccak256("unknown"));
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function test_onlyOwnerCanSetDeviation() public {
        vm.prank(alice);
        vm.expectRevert();
        agg.setMaxDeviationBps(500);
    }

    function test_defaultToleranceIsOnePercent() public view {
        assertEq(agg.maxDeviationBps(), 100);
    }
}
