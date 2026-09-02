// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/EsgRewardDistributor.sol";
import "../src/SustainabilityBadge.sol";
import "../src/CarbonTiers.sol";
import "../src/MockUSDC.sol";

/// @dev Minimal exchange stub — the distributor only ever calls getPosition.
contract ExchangeStub {
    mapping(uint256 => IExchangeForReward.Position) private _positions;

    /// @dev Positions default to opened a year ago and still open, so tests
    ///      that are not about the M7 holding rules read naturally. Use
    ///      `setPositionAt` / `closePosition` for the ones that are.
    function setPosition(
        uint256 id,
        address owner_,
        bytes32 asset,
        uint256 margin,
        uint256 leverage
    ) external {
        _set(id, owner_, asset, margin, leverage, block.timestamp - 365 days, true);
    }

    function setPositionAt(
        uint256 id,
        address owner_,
        bytes32 asset,
        uint256 margin,
        uint256 leverage,
        uint256 openedAt
    ) external {
        _set(id, owner_, asset, margin, leverage, openedAt, true);
    }

    function closePosition(uint256 id) external {
        _positions[id].isOpen   = false;
        _positions[id].closedAt = block.timestamp;
    }

    function _set(
        uint256 id,
        address owner_,
        bytes32 asset,
        uint256 margin,
        uint256 leverage,
        uint256 openedAt,
        bool isOpen
    ) internal {
        IExchangeForReward.Position memory p;
        p.id       = id;
        p.owner    = owner_;
        p.asset    = asset;
        p.margin   = margin;
        p.leverage = leverage;
        p.openedAt = openedAt;
        p.isOpen   = isOpen;
        _positions[id] = p;
    }

    function getPosition(uint256 id) external view returns (IExchangeForReward.Position memory) {
        return _positions[id];
    }
}

/// @dev Minimal ESG registry stub — mirrors ESGRegistryV2.medianCarbonIntensity's
///      shape (median, count, dispersion, isRated) so the distributor's real
///      interface is exercised, without pulling in the full attestor registry.
contract EsgRegistryStub {
    struct Reading {
        uint256 median;
        bool    isRated;
    }
    mapping(bytes32 => Reading) public readings;

    function setRating(bytes32 assetId, uint256 median, bool isRated) external {
        readings[assetId] = Reading(median, isRated);
    }

    function medianCarbonIntensity(bytes32 assetId)
        external
        view
        returns (uint256 median, uint256 count, uint256 dispersion, bool isRated)
    {
        Reading memory r = readings[assetId];
        return (r.median, r.isRated ? 1 : 0, 0, r.isRated);
    }
}

/// @notice EsgRewardDistributor had zero test coverage despite handing out
///         tokens — the highest-risk gap flagged in the 2026-07-27 review.
///         #98: the payout is now a non-transferable SustainabilityBadge and
///         the gate is a CarbonTiers tier instead of an owner-set composite
///         score; the M7 hold-duration/isOpen behavior is unchanged and
///         re-verified below exactly as before.
contract EsgRewardDistributorTest is Test {
    EsgRewardDistributor dist;
    SustainabilityBadge  badge;
    ExchangeStub         exchange;
    EsgRegistryStub      registry;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant GREEN = keccak256("sICLN");   // Low carbon tier
    bytes32 constant MID   = keccak256("sBOND");   // Mid carbon tier
    bytes32 constant DIRTY = keccak256("sBTC");    // High carbon tier
    bytes32 constant UNRATED = keccak256("sNEW");  // never attested

    uint256 constant LOW_INTENSITY  = 0.5e18; // < 1e18 -> Low
    uint256 constant MID_INTENSITY  = 4e18;   // 1e18-8e18 -> Mid
    uint256 constant HIGH_INTENSITY = 20e18;  // > 8e18 -> High

    function setUp() public {
        // The stub back-dates positions by a year; move off block.timestamp==1
        // so that subtraction is well defined.
        vm.warp(400 days);

        exchange = new ExchangeStub();
        registry = new EsgRegistryStub();
        badge    = new SustainabilityBadge(owner);
        dist     = new EsgRewardDistributor(address(exchange), address(registry), address(badge));
        badge.grantRole(badge.MINTER_ROLE(), address(dist));

        registry.setRating(GREEN, LOW_INTENSITY, true);
        registry.setRating(MID, MID_INTENSITY, true);
        registry.setRating(DIRTY, HIGH_INTENSITY, true);
        // UNRATED left at its zero-value default: isRated == false.

        // alice: 1000 margin at 5x on a Low-tier asset
        exchange.setPosition(1, alice, GREEN, 1_000e18, 5);
        // bob: same size but on a High-tier asset
        exchange.setPosition(2, bob, DIRTY, 1_000e18, 5);
    }

    // ── happy path ───────────────────────────────────────────────────────────

    function test_claimMintsBadgeToClaimant() public {
        vm.prank(alice);
        uint256 tokenId = dist.claimEsgReward(1);
        assertEq(badge.ownerOf(tokenId), alice);
        assertEq(badge.balanceOf(alice), 1);
    }

    function test_claimedBadgeIsNonTransferable() public {
        vm.prank(alice);
        uint256 tokenId = dist.claimEsgReward(1);

        vm.prank(alice);
        vm.expectRevert(SustainabilityBadge.NonTransferable.selector);
        badge.transferFrom(alice, bob, tokenId);
    }

    function test_previewMatchesClaimability() public {
        assertTrue(dist.previewReward(1));
        vm.prank(alice);
        dist.claimEsgReward(1);
        // already claimed -> no longer claimable
        assertFalse(dist.previewReward(1));
    }

    function test_claimMarksPositionRewarded() public {
        vm.prank(alice);
        dist.claimEsgReward(1);
        assertTrue(dist.rewarded(1));
    }

    /// @dev The reason must describe what actually happened for THIS badge
    ///      (the tier reached, the days actually held) rather than a fixed
    ///      literal — the string is baked into an immutable on-chain field,
    ///      but the parameters it would otherwise hardcode (maxRewardTier,
    ///      minHoldSeconds) are owner-tunable, so a literal would go
    ///      permanently stale the moment either changed.
    function test_claimRecordsReasonReflectingActualTierAndHoldDuration() public {
        exchange.setPositionAt(20, alice, GREEN, 1_000e18, 5, block.timestamp - 45 days);
        vm.prank(alice);
        uint256 tokenId = dist.claimEsgReward(20);
        assertEq(badge.reasonFor(tokenId), "Held a Low-carbon-tier position for 45+ days");
    }

    /// @dev Same claim, but after the owner has widened eligibility to Mid —
    ///      the reason must say Mid, not a hardcoded "Low".
    function test_claimReasonReflectsWidenedTier() public {
        dist.setMaxRewardTier(CarbonTiers.Tier.Mid);
        exchange.setPositionAt(21, bob, MID, 1_000e18, 5, block.timestamp - 30 days);
        vm.prank(bob);
        uint256 tokenId = dist.claimEsgReward(21);
        assertEq(badge.reasonFor(tokenId), "Held a Mid-carbon-tier position for 30+ days");
    }

    // ── guards ───────────────────────────────────────────────────────────────

    /// @dev The one that matters most: no double-dipping the reward.
    function test_cannotClaimTwice() public {
        vm.startPrank(alice);
        dist.claimEsgReward(1);
        vm.expectRevert(EsgRewardDistributor.AlreadyClaimed.selector);
        dist.claimEsgReward(1);
        vm.stopPrank();
    }

    function test_onlyPositionOwnerCanClaim() public {
        vm.prank(bob);
        vm.expectRevert(EsgRewardDistributor.NotPositionOwner.selector);
        dist.claimEsgReward(1);            // alice's position
    }

    function test_highTierAssetCannotClaim() public {
        vm.prank(bob);
        vm.expectRevert(EsgRewardDistributor.AssetNotLowCarbon.selector);
        dist.claimEsgReward(2);
    }

    function test_previewReturnsFalseForHighTierAsset() public view {
        assertFalse(dist.previewReward(2));
    }

    /// @dev Fail-closed: an asset with no fresh attestation must never
    ///      qualify, regardless of maxRewardTier — see the contract's own
    ///      NatSpec on why Unrated can't be let in by a numeric accident.
    function test_unratedAssetCannotClaim() public {
        exchange.setPosition(3, alice, UNRATED, 1_000e18, 5);
        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.AssetNotLowCarbon.selector);
        dist.claimEsgReward(3);
    }

    function test_previewReturnsFalseForUnratedAsset() public {
        exchange.setPosition(3, alice, UNRATED, 1_000e18, 5);
        assertFalse(dist.previewReward(3));
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function test_maxRewardTierChangeGatesClaims() public {
        dist.setMaxRewardTier(CarbonTiers.Tier.Unrated);
        // Unrated is numerically below Low, so tightening the max tier to
        // Unrated must still exclude Low — not widen eligibility to it.
        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.AssetNotLowCarbon.selector);
        dist.claimEsgReward(1);
    }

    function test_maxRewardTierChangeCanWidenEligibility() public {
        dist.setMaxRewardTier(CarbonTiers.Tier.Mid);
        exchange.setPosition(4, bob, MID, 1_000e18, 5);
        vm.prank(bob);
        uint256 tokenId = dist.claimEsgReward(4);
        assertEq(badge.ownerOf(tokenId), bob);
    }

    function test_onlyOwnerCanSetParams() public {
        vm.startPrank(alice);
        vm.expectRevert();
        dist.setMaxRewardTier(CarbonTiers.Tier.High);
        vm.expectRevert();
        dist.setMinHoldSeconds(0);
        vm.stopPrank();
    }

    // ── rescueERC20 ──────────────────────────────────────────────────────────

    /// @dev The old `withdraw` drained a PEPE pool this contract used to be
    ///      pre-funded with; that pool doesn't exist anymore (the payout is
    ///      a badge mint, not a token transfer), but the contract can still
    ///      receive tokens by accident. Without any rescue path those would
    ///      be stuck forever.
    function test_rescueERC20_ownerCanRecoverStrayTokens() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(address(dist), 500e18);

        uint256 before = stray.balanceOf(owner);
        dist.rescueERC20(address(stray), 500e18);
        assertEq(stray.balanceOf(owner) - before, 500e18);
        assertEq(stray.balanceOf(address(dist)), 0);
    }

    function test_rescueERC20_onlyOwner() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(address(dist), 500e18);

        vm.prank(alice);
        vm.expectRevert();
        dist.rescueERC20(address(stray), 500e18);
    }

    // ── M7: hold requirements (unchanged behavior, re-verified) ─────────────

    /// @dev The position struct carried `isOpen` and it was never read: open
    ///      and close in the same block, then collect the reward for
    ///      exposure that lasted zero seconds.
    function test_M7_closedPositionCannotClaim() public {
        exchange.closePosition(1);
        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.PositionNotOpen.selector);
        dist.claimEsgReward(1);
    }

    /// @dev And there was no holding period at all, so even an open position
    ///      could claim in the same block it was opened.
    function test_M7_freshPositionMustWaitOutTheHoldingPeriod() public {
        exchange.setPositionAt(9, alice, GREEN, 1_000e18, 5, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.HoldTooShort.selector);
        dist.claimEsgReward(9);

        vm.warp(block.timestamp + dist.minHoldSeconds());
        vm.prank(alice);
        uint256 tokenId = dist.claimEsgReward(9);
        assertEq(badge.ownerOf(tokenId), alice);
    }

    function test_M7_previewIsFalseWhenNotClaimable() public {
        exchange.setPositionAt(10, alice, GREEN, 1_000e18, 5, block.timestamp);
        assertFalse(dist.previewReward(10), "too fresh");

        exchange.closePosition(1);
        assertFalse(dist.previewReward(1), "closed");
    }

    function test_M7_ownerCanTuneHoldingPeriod() public {
        exchange.setPositionAt(11, alice, GREEN, 1_000e18, 5, block.timestamp);
        dist.setMinHoldSeconds(0);
        vm.prank(alice);
        uint256 tokenId = dist.claimEsgReward(11);
        assertEq(badge.ownerOf(tokenId), alice);
    }
}
