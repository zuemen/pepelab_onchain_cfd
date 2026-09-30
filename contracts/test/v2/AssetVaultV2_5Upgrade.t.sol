// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2_4.sol";
import "../../src/v2/AssetVaultV2_5.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";
import "../../script/UpgradeVaultToV2_5.s.sol";

/// @notice V2.5: UUPS upgrade of a live V2.4 proxy + the bounded M-7
///         last-good price fallback.
contract AssetVaultV2_5UpgradeTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;
    AssetVaultV2_4 vault;   // proxy, V2.4 until _upgrade()
    SyntheticAssetV2 aapl;
    SyntheticAssetV2 btc;

    address admin = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AAPL = keccak256("sAAPL");
    bytes32 constant BTC  = keccak256("sBTC");
    uint256 constant GAP_FRONT_SLOT = 12;   // V2.4's __gap[0] == V2.5's _lastGood

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AAPL, 200e8);
        oracle.addAsset(BTC, 100_000e8);

        AssetVaultV2_4 impl = new AssetVaultV2_4();
        vault = AssetVaultV2_4(address(new ERC1967Proxy(
            address(impl), abi.encodeCall(AssetVaultV2_4.initialize, (address(usdc), address(oracle), admin))
        )));
        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AAPL, admin);
        btc  = new SyntheticAssetV2("Synthetic BTC", "sBTC", BTC, admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        btc.grantRole(btc.MINTER_ROLE(), address(vault));
        vault.registerAsset(AAPL, address(aapl));
        vault.registerAsset(BTC, address(btc));
        vault.setAssetCap(AAPL, 1_000_000e18);
        vault.setAssetCap(BTC, 1_000_000e18);
        vault.setRiskParams(25, 12_000, 1 hours);

        usdc.mint(admin, 10_000_000e18);
        usdc.mint(alice, 10_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);

        vm.prank(alice); vault.mint(AAPL, 20_000e18);   // outstanding before the upgrade
    }

    function _upgrade() internal returns (AssetVaultV2_5 v) {
        vault.upgradeToAndCall(address(new AssetVaultV2_5()), "");
        v = AssetVaultV2_5(address(vault));
    }

    // ── migration ─────────────────────────────────────────────────────────

    function test_upgradePreservesStateAndStartsWithoutMarks() public {
        assertEq(vm.load(address(vault), bytes32(GAP_FRONT_SLOT)), bytes32(0), "gap front is empty on V2.4");
        uint256 fees = vault.accruedFees();
        uint256 exposure = vault.exposureOf(AAPL);
        uint256 reserveBefore = vault.reserve();
        (uint256 liab, uint256 unpriced) = vault.outstandingValueDetailed();

        AssetVaultV2_5 v = _upgrade();
        assertEq(v.version(), "2.5.0");
        assertEq(v.accruedFees(), fees);
        assertEq(v.exposureOf(AAPL), exposure);
        assertEq(v.reserve(), reserveBefore);
        assertEq(v.redeemFeeBps(), 25);
        assertEq(v.minReserveRatioBps(), 12_000);
        assertEq(v.maxPriceAge(), 1 hours);
        assertEq(v.registeredAssets().length, 2);
        assertTrue(v.hasRole(v.DEFAULT_ADMIN_ROLE(), admin));
        (uint256 liab2, uint256 unpriced2, uint256 fb) = v.valuationDetail();
        assertEq(liab2, liab);
        assertEq(unpriced2, unpriced);
        assertEq(fb, 0);
        (uint256 p, uint256 at, bool usable) = v.lastGoodPrice(AAPL);
        assertEq(p, 0); assertEq(at, 0); assertFalse(usable);
    }

    function test_upgradeScriptChecksAndPreservesState() public {
        vm.setEnv("VAULT_PROXY", vm.toString(address(vault)));
        UpgradeVaultToV2_5 s = new UpgradeVaultToV2_5();
        s.setBroadcasterOverride(admin);
        s.run();
        assertEq(AssetVaultV2_5(address(vault)).version(), "2.5.0");
        assertEq(AssetVaultV2_5(address(vault)).maxPriceAge(), 21_600, "lowered in the same run");
        assertEq(AssetVaultV2_5(address(vault)).redeemFeeBps(), 25, "other risk params untouched");
        assertEq(AssetVaultV2_5(address(vault)).minReserveRatioBps(), 12_000);
    }

    function test_lastGoodLivesInTheOldGapFrontSlot() public {
        AssetVaultV2_5 v = _upgrade();
        vm.prank(alice); v.mint(AAPL, 1_000e18);
        bytes32 raw = vm.load(address(v), keccak256(abi.encode(AAPL, uint256(GAP_FRONT_SLOT))));
        assertEq(uint256(uint192(uint256(raw))), 200e8, "price in the low 192 bits of mapping(slot 12)[AAPL]");
        assertEq(uint256(raw) >> 192, block.timestamp, "oracle timestamp in the high 64 bits");
        // Slot 13 is the `_unpricedExempt` mapping root (always 0), and the
        // shrunk gap starts at 14 — both untouched.
        assertEq(vm.load(address(v), bytes32(uint256(13))), bytes32(0));
        assertEq(vm.load(address(v), bytes32(uint256(14))), bytes32(0));
    }

    // ── bounded fallback ────────────────────────────────────────────────────

    function test_observeReserveSeedsLastGoodForPreUpgradeExposure() public {
        AssetVaultV2_5 v = _upgrade();
        v.observeReserve();
        (uint256 p, uint256 at, bool usable) = v.lastGoodPrice(AAPL);
        assertEq(p, 200e8);
        assertEq(at, block.timestamp);
        assertTrue(usable);
    }

    function test_staleFeedMarkedToLastGoodWithinSixHours() public {
        AssetVaultV2_5 v = _upgrade();
        vm.prank(alice); v.mint(BTC, 10_000e18);   // records BTC; AAPL seeded next
        v.observeReserve();
        uint256 fresh = v.outstandingValue();

        vm.warp(block.timestamp + 2 hours);        // both feeds now past maxPriceAge (1h)
        oracle.updatePrice(BTC, 100_000e8);        // refresh BTC only

        (uint256 total, uint256 unpriced, uint256 fb) = v.valuationDetail();
        assertEq(total, fresh, "AAPL stays in the liability at its last-good mark");
        assertEq(unpriced, 0);
        assertEq(fb, 1);
        assertTrue(v.ratioIsStale(), "an estimated ratio is still flagged");
    }

    function test_lastGoodOlderThanSixHoursCountsAsUnpriced() public {
        AssetVaultV2_5 v = _upgrade();
        v.observeReserve();                        // AAPL mark at t0
        vm.warp(block.timestamp + 6 hours + 1);
        oracle.updatePrice(BTC, 100_000e8);

        (uint256 total, uint256 unpriced, uint256 fb) = v.valuationDetail();
        assertEq(unpriced, 1, "beyond LAST_GOOD_MAX_AGE the mark is not used");
        assertEq(fb, 0);
        assertEq(total, 0, "AAPL left out, V2.4 behaviour");

        // Exactly at the boundary it is still usable.
        vm.warp(block.timestamp - 1);
        (, uint256 unpricedAt, uint256 fbAt) = v.valuationDetail();
        assertEq(unpricedAt, 0);
        assertEq(fbAt, 1);
    }

    /// @dev The M-7 point: with AAPL's feed down, the mint gate must still
    ///      see AAPL's liability. Reserve 119,800 + 514,800 vs liability
    ///      19,800 + 514,800 = 118.7% < 120% required → refused. V2.4 dropped
    ///      AAPL and let the same mint through at 634,600 / 514,800 = 123%.
    function test_mintGateIsNotOptimisticWhileAFeedIsDown() public {
        AssetVaultV2_5 v = _upgrade();
        v.observeReserve();
        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(BTC, 100_000e8);

        vm.prank(alice);
        vm.expectRevert();                         // ReserveRatioTooLow
        v.mint(BTC, 520_000e18);
    }

    function test_fallbackMarkCanLatchButNeverClearABreach() public {
        AssetVaultV2_5 v = _upgrade();
        v.setRiskParams(25, 1_000_000, 1 hours);   // 10,000% required → breach
        (, , , , bool halted) = v.observeReserve();
        assertTrue(halted);

        v.setRiskParams(25, 12_000, 1 hours);      // healthy again on paper
        vm.warp(block.timestamp + 2 hours);        // AAPL feed stale, mark still usable
        (, , , , halted) = v.observeReserve();
        assertTrue(halted, "an estimated valuation must not clear the halt");

        oracle.updatePrice(AAPL, 200e8);           // live again
        (, , , , halted) = v.observeReserve();
        assertFalse(halted, "a fully live valuation restores minting");
    }

    function test_markNeverMovesBackwards() public {
        AssetVaultV2_5 v = _upgrade();
        v.observeReserve();
        (, uint256 at1, ) = v.lastGoodPrice(AAPL);
        vm.warp(block.timestamp + 30 minutes);     // same quote, still fresh
        v.observeReserve();
        (, uint256 at2, ) = v.lastGoodPrice(AAPL);
        assertEq(at2, at1, "age is the price's age, not the observation's");
    }

    // ── review follow-ups: 6h cap on live quotes, mint refuses unpriced ─────

    function test_mintRefusedWhileAnyLiabilityIsUnpriced() public {
        AssetVaultV2_5 v = _upgrade();
        vm.prank(alice); v.mint(BTC, 10_000e18);
        v.observeReserve();                        // AAPL + BTC marked
        vm.warp(block.timestamp + 6 hours + 1);    // AAPL mark expires, feed dead
        oracle.updatePrice(BTC, 100_000e8);        // BTC feed alive

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2_5.LiabilityUnpriced.selector, 1));
        v.mint(BTC, 1_000e18);

        // Redeem is never gated on it.
        uint256 bal = btc.balanceOf(alice);
        vm.prank(alice); v.redeem(BTC, bal / 2);
        assertEq(btc.balanceOf(alice), bal - bal / 2);

        // Feed back -> mint reopens.
        oracle.updatePrice(AAPL, 200e8);
        vm.prank(alice); v.mint(BTC, 1_000e18);
    }

    function test_fallbackMarkedAssetDoesNotBlockMint() public {
        AssetVaultV2_5 v = _upgrade();
        v.observeReserve();
        vm.warp(block.timestamp + 2 hours);        // AAPL stale but its mark is usable
        oracle.updatePrice(BTC, 100_000e8);
        vm.prank(alice); v.mint(BTC, 1_000e18);    // admitted on the estimate
    }

    function test_looseMaxPriceAgeIsCappedAtSixHours() public {
        AssetVaultV2_5 v = _upgrade();
        v.setRiskParams(25, 12_000, 30 days);      // what the live proxy ran with
        assertEq(v.effectiveMaxPriceAge(), 6 hours);
        vm.warp(block.timestamp + 6 hours + 1);    // no keeper post since setUp
        vm.prank(alice);
        vm.expectRevert();                         // StalePrice: 30 days is not honoured
        v.mint(AAPL, 1_000e18);
        (, uint256 unpriced, ) = v.valuationDetail();
        assertEq(unpriced, 1, "a >6h quote never counts as live");
    }

    // ── review M1: closed dead-feed asset can be exempted from the mint gate ─

    function _deadAaplMarkedAndClosed(AssetVaultV2_5 v) internal {
        v.observeReserve();                        // AAPL last-good = 200e8
        vm.warp(block.timestamp + 6 hours + 1);    // AAPL feed dead, mark expired
        oracle.updatePrice(BTC, 100_000e8);
        v.setAssetCap(AAPL, 0);                    // market closed
    }

    /// The reviewer's probe: AAPL left with 1 wei, feed dead, cap 0,
    /// clearMintingHalt — minting BTC was still blocked. Now RISK_ROLE can
    /// exempt the closed asset.
    function test_M1_probe_deadClosedDustAssetCanBeExempted() public {
        AssetVaultV2_5 v = _upgrade();
        uint256 bal = aapl.balanceOf(alice);
        vm.prank(alice); v.redeem(AAPL, bal - 1); // 1 wei left, last-good recorded
        _deadAaplMarkedAndClosed(v);
        v.clearMintingHalt();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2_5.LiabilityUnpriced.selector, 1));
        v.mint(BTC, 1_000e18);

        vm.expectEmit(true, true, false, true, address(v));
        emit AssetVaultV2_5.UnpricedExemptionSet(AAPL, true, admin);
        v.setUnpricedExemption(AAPL, true);
        assertTrue(v.isUnpricedExempt(AAPL));
        vm.prank(alice); v.mint(BTC, 1_000e18);    // unblocked
        (, uint256 unpriced, uint256 fb) = v.valuationDetail();
        assertEq(unpriced, 0);
        assertEq(fb, 1, "still an estimate: flagged, cannot auto-clear a breach");
        assertTrue(v.ratioIsStale());
    }

    function test_M1_reopeningTheAssetDisablesTheExemption() public {
        AssetVaultV2_5 v = _upgrade();
        _deadAaplMarkedAndClosed(v);
        v.setUnpricedExemption(AAPL, true);
        vm.prank(alice); v.mint(BTC, 1_000e18);

        v.setAssetCap(AAPL, 1_000_000e18);         // re-open
        assertFalse(v.isUnpricedExempt(AAPL), "cap > 0 switches it off");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2_5.LiabilityUnpriced.selector, 1));
        v.mint(BTC, 1_000e18);
    }

    function test_M1_exemptionRequiresClosedAsset() public {
        AssetVaultV2_5 v = _upgrade();
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2_5.ExemptionRequiresClosedAsset.selector, AAPL, 1_000_000e18));
        v.setUnpricedExemption(AAPL, true);
    }

    /// 99 AAPL minted before the upgrade and never marked: no price to keep
    /// it in the book by, and far above dust -> cannot be exempted.
    function test_M1_largeOutstandingWithoutAnyPriceCannotBeExempted() public {
        AssetVaultV2_5 v = _upgrade();
        v.setAssetCap(AAPL, 0);
        uint256 out = v.exposureOf(AAPL);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2_5.ExemptionNeedsPrice.selector, AAPL, out));
        v.setUnpricedExemption(AAPL, true);
    }

    /// An exempted asset is still a liability at its last-good price, so a
    /// mint that would over-issue against it is refused by the reserve ratio
    /// (same numbers as test_mintGateIsNotOptimisticWhileAFeedIsDown).
    function test_M1_exemptedLiabilityStillBindsTheReserveRatio() public {
        AssetVaultV2_5 v = _upgrade();
        _deadAaplMarkedAndClosed(v);
        v.setUnpricedExemption(AAPL, true);
        (uint256 total, , ) = v.valuationDetail();
        assertEq(total, v.exposureOf(AAPL) * 200e8 / 1e8, "AAPL kept at its (old) last-good mark");

        vm.prank(alice);
        vm.expectRevert();                         // ReserveRatioTooLow
        v.mint(BTC, 520_000e18);
    }

    function test_M1_onlyRiskRoleAndRedeemUnaffected() public {
        AssetVaultV2_5 v = _upgrade();
        vm.prank(alice); v.mint(BTC, 10_000e18);
        _deadAaplMarkedAndClosed(v);

        vm.prank(alice);
        vm.expectRevert();                         // AccessControlUnauthorizedAccount
        v.setUnpricedExemption(AAPL, true);

        uint256 b = btc.balanceOf(alice);
        vm.prank(alice); v.redeem(BTC, b);         // redeem never gated
        assertEq(btc.balanceOf(alice), 0);
    }
}
