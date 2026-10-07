// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AggregatorOracleAdapter.sol";
import "../src/v2/GuardedOracle.sol";

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
    ///      is now *degraded*: a price is still served (so risk can be cut),
    ///      and the divergence is surfaced through isStale/isDegraded.
    ///      2026-10-07: the served price is the midpoint with the OLDER
    ///      timestamp, not the fresher quote (see the next test for why).
    function test_softDisagreementServesDegradedPriceInsteadOfBlocking() public {
        a.set(ID, 100_000e8, 1_000);
        b.set(ID, 110_000e8, 2_000);      // 1000 bps apart, soft bound is 100

        (uint256 p, uint256 t) = agg.getPrice(ID);
        assertEq(p, 105_000e8, "midpoint is served, not either feed");
        assertEq(t, 1_000, "with the older of the two timestamps");

        assertTrue(agg.isDegraded(ID), "and it is flagged as degraded");
        assertTrue(agg.isStale(ID),    "monitoring readers see it too");
    }

    /// @dev The reason for the midpoint: with "fresher wins", a faulty feed
    ///      only had to post last to set the price anywhere inside the halt
    ///      band. Now posting later moves nothing, and the served value stays
    ///      within half the spread of the honest feed.
    function test_degradedPriceIsNotWonByPostingLast() public {
        a.set(ID, 100_000e8, 1_000);           // honest
        b.set(ID, 119_000e8, 2_000);           // faulty, 19% high, newer
        (uint256 p1, ) = agg.getPrice(ID);
        b.set(ID, 119_000e8, 9_000);           // re-posts with an even newer time
        (uint256 p2, uint256 t2) = agg.getPrice(ID);
        assertEq(p1, 109_500e8);
        assertEq(p2, p1, "a newer timestamp does not move the degraded price");
        assertEq(t2, 1_000);
        assertLe(p2 - 100_000e8, (119_000e8 - 100_000e8) / 2, "within half the spread of the honest feed");
    }

    /// @dev End to end: the aggregator as GuardedOracle's reference while its
    ///      feeds disagree. It reports isStale, so its agreement cannot lift
    ///      GuardedOracle's step cap — a keeper post that matches the degraded
    ///      number but jumps 19% is refused. Once the feeds agree again, the
    ///      same reference confirms a real gap in one post.
    function test_degradedAggregatorCannotConfirmGuardedOraclePost() public {
        GuardedOracle g = new GuardedOracle(address(this));
        g.grantRole(g.KEEPER_ROLE(), address(this));
        g.addAsset(ID, 100_000e8);
        g.setReferenceSource(address(agg));

        vm.warp(10_000);
        a.set(ID, 100_000e8, block.timestamp);
        b.set(ID, 119_000e8, block.timestamp); // 19% apart: degraded, midpoint 109_500
        assertTrue(agg.isDegraded(ID));
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, ID, 119_000e8, 100_000e8)
        );
        g.updatePrice(ID, 119_000e8);          // within 10% of the 109_500 midpoint, 19% from last

        // Feeds agree on a real 15% gap → healthy reference → confirmed in one post.
        b.set(ID, 115_000e8, block.timestamp);
        a.set(ID, 115_000e8, block.timestamp);
        assertFalse(agg.isStale(ID));
        g.updatePrice(ID, 115_000e8);
        (uint256 gp, ) = g.getPrice(ID);
        assertEq(gp, 115_000e8);
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
