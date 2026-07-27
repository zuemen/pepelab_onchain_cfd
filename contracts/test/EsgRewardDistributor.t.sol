// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/EsgRewardDistributor.sol";
import "../src/PepeToken.sol";

/// @dev Minimal exchange stub — the distributor only ever calls getPosition.
contract ExchangeStub {
    mapping(uint256 => IExchangeForReward.Position) private _positions;

    function setPosition(
        uint256 id,
        address owner_,
        bytes32 asset,
        uint256 margin,
        uint256 leverage
    ) external {
        IExchangeForReward.Position memory p;
        p.id       = id;
        p.owner    = owner_;
        p.asset    = asset;
        p.margin   = margin;
        p.leverage = leverage;
        p.isOpen   = true;
        _positions[id] = p;
    }

    function getPosition(uint256 id) external view returns (IExchangeForReward.Position memory) {
        return _positions[id];
    }
}

/// @dev Minimal ESG registry stub.
contract EsgRegistryStub {
    mapping(bytes32 => uint8) public compositeScore;

    function setScore(bytes32 assetId, uint8 score) external {
        compositeScore[assetId] = score;
    }
}

/// @notice EsgRewardDistributor had zero test coverage despite handing out
///         tokens — the highest-risk gap flagged in the 2026-07-27 review.
contract EsgRewardDistributorTest is Test {
    EsgRewardDistributor dist;
    PepeToken            pepe;
    ExchangeStub         exchange;
    EsgRegistryStub      registry;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant GREEN = keccak256("sICLN");   // high ESG
    bytes32 constant DIRTY = keccak256("sBTC");    // low ESG

    function setUp() public {
        pepe     = new PepeToken();
        exchange = new ExchangeStub();
        registry = new EsgRegistryStub();
        dist     = new EsgRewardDistributor(address(pepe), address(exchange), address(registry));

        registry.setScore(GREEN, 85);
        registry.setScore(DIRTY, 30);

        // Seed the distributor so rewards can actually pay out.
        pepe.transfer(address(dist), 1_000_000e18);

        // alice: 1000 margin at 5x on a high-ESG asset -> notional 5000
        exchange.setPosition(1, alice, GREEN, 1_000e18, 5);
        // bob: same size but on a low-ESG asset
        exchange.setPosition(2, bob, DIRTY, 1_000e18, 5);
    }

    // ── happy path ───────────────────────────────────────────────────────────

    /// @dev 1% of a 5000 notional = 50 PEPE.
    function test_claimPaysOnePercentOfNotional() public {
        vm.prank(alice);
        dist.claimEsgReward(1);
        assertEq(pepe.balanceOf(alice), 50e18);
    }

    function test_previewMatchesClaim() public {
        uint256 preview = dist.previewReward(1);
        vm.prank(alice);
        dist.claimEsgReward(1);
        assertEq(preview, 50e18);
        assertEq(pepe.balanceOf(alice), preview);
    }

    function test_claimMarksPositionRewarded() public {
        vm.prank(alice);
        dist.claimEsgReward(1);
        assertTrue(dist.rewarded(1));
    }

    // ── guards ───────────────────────────────────────────────────────────────

    /// @dev The one that matters most: no double-dipping the reward pool.
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

    function test_lowEsgAssetCannotClaim() public {
        vm.prank(bob);
        vm.expectRevert(EsgRewardDistributor.AssetNotHighEsg.selector);
        dist.claimEsgReward(2);
    }

    function test_previewReturnsZeroForLowEsgAsset() public view {
        assertEq(dist.previewReward(2), 0);
    }

    function test_revertsWhenPoolIsDry() public {
        dist.withdraw(pepe.balanceOf(address(dist)));   // drain the pool
        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.InsufficientBalance.selector);
        dist.claimEsgReward(1);
    }

    /// @dev A whale position must not drain the pool in one claim.
    function test_rewardIsCappedPerClaim() public {
        dist.setMaxRewardPerClaim(10e18);
        exchange.setPosition(3, alice, GREEN, 1_000_000e18, 10);  // huge notional

        vm.prank(alice);
        dist.claimEsgReward(3);
        assertEq(pepe.balanceOf(alice), 10e18);
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function test_thresholdChangeGatesClaims() public {
        dist.setHighEsgThreshold(90);      // GREEN is 85, now below the bar
        vm.prank(alice);
        vm.expectRevert(EsgRewardDistributor.AssetNotHighEsg.selector);
        dist.claimEsgReward(1);
    }

    function test_rewardRateChangeAffectsPayout() public {
        dist.setRewardRateBps(200);        // 2%
        vm.prank(alice);
        dist.claimEsgReward(1);
        assertEq(pepe.balanceOf(alice), 100e18);
    }

    function test_onlyOwnerCanSetParams() public {
        vm.startPrank(alice);
        vm.expectRevert();
        dist.setHighEsgThreshold(50);
        vm.expectRevert();
        dist.setRewardRateBps(500);
        vm.expectRevert();
        dist.setMaxRewardPerClaim(1e18);
        vm.expectRevert();
        dist.withdraw(1e18);
        vm.stopPrank();
    }

    function test_ownerCanWithdrawUnusedPool() public {
        uint256 before = pepe.balanceOf(owner);
        dist.withdraw(1_000e18);
        assertEq(pepe.balanceOf(owner) - before, 1_000e18);
    }
}
