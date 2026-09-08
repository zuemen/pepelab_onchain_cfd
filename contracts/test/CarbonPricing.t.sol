// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/PerpetualExchange.sol";
import "../src/CarbonTiers.sol";
import "../src/ESGRegistryV2.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/v2/AssetVaultV2_3.sol";
import "../src/v2/SyntheticAssetV2.sol";

/// @notice #96: PerpetualExchange's trading fee, borrow fee, and max leverage
///         derived per-asset from CarbonTiers, sourced from ESGRegistryV2's
///         median carbon intensity. See ADR-003 and docs/data/carbon-intensity.md.
contract CarbonPricingTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;
    ESGRegistryV2     esg;

    address alice    = makeAddr("alice");
    address attestor = makeAddr("attestor");

    // Real, sourced figures from docs/data/carbon-intensity.md — same numbers
    // CarbonTiers.t.sol pins its boundary tests against.
    bytes32 constant S_AAPL = keccak256("sAAPL"); // 0.150 tCO2e/$M rev -> Low
    bytes32 constant S_ESGU = keccak256("sESGU"); // 4.34  tCO2e/$M rev -> Mid
    bytes32 constant S_MSFT = keccak256("sMSFT"); // 10.226 tCO2e/$M rev -> High
    bytes32 constant S_UNRATED = keccak256("sUNRATED"); // never attested

    bytes32 constant SRC = keccak256("https://example.com/source|2026-09-02");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        esg      = new ESGRegistryV2(address(this));
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(esg));

        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);

        vm.startPrank(attestor);
        esg.attest(S_AAPL, 0.150e18, CarbonTiers.Tier.Low, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        esg.attest(S_ESGU, 4.34e18, CarbonTiers.Tier.Mid, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        esg.attest(S_MSFT, 10.226e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        // S_UNRATED deliberately never attested.
        vm.stopPrank();

        oracle.addAsset(S_AAPL, 200e8);
        oracle.addAsset(S_ESGU, 100e8);
        oracle.addAsset(S_MSFT, 400e8);
        oracle.addAsset(S_UNRATED, 100e8);

        exchange.setExecutionFee(0);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); exchange.depositMargin(500_000e18);
    }

    // ── per-asset fee/leverage correctly derived from carbon intensity ───────

    function test_lowTier_getsCheapestFeeAndFullLeverage() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_AAPL, true, 1_000e18, 5);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.tradingFeeBps, 10, "Low tier trading fee");
        assertEq(pos.borrowFeeBpsPerHour, 1, "Low tier borrow fee");
        assertTrue(pos.carbonTier == CarbonTiers.Tier.Low);
        assertEq(exchange.maxLeverageForAsset(S_AAPL), 5);
    }

    function test_midTier_getsMiddleFeeAndLeverage() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_ESGU, true, 1_000e18, 2);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.tradingFeeBps, 40, "Mid tier trading fee");
        assertEq(pos.borrowFeeBpsPerHour, 4, "Mid tier borrow fee");
        assertTrue(pos.carbonTier == CarbonTiers.Tier.Mid);
        assertEq(exchange.maxLeverageForAsset(S_ESGU), 2);
    }

    function test_midTier_leverageAboveTwo_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(S_ESGU, true, 1_000e18, 5);
    }

    function test_highTier_getsMostExpensiveFeeAndTightestLeverage() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_MSFT, true, 1_000e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.tradingFeeBps, 100, "High tier trading fee = exchange ceiling");
        assertEq(pos.borrowFeeBpsPerHour, 10, "High tier borrow fee = exchange ceiling");
        assertTrue(pos.carbonTier == CarbonTiers.Tier.High);
        assertEq(exchange.maxLeverageForAsset(S_MSFT), 1);
    }

    function test_highTier_leverageAboveOne_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(S_MSFT, true, 1_000e18, 2);
    }

    // ── unrated assets fall to the most conservative tier ────────────────────

    /// @dev "未評等資產一律落到最保守級(1x、最高費率)" — fail-closed, not a
    ///      refusal to trade and not a discount. S_UNRATED has an oracle price
    ///      but was never attested in ESGRegistryV2.
    function test_unratedAsset_getsHighTierParams_notLowDefaults() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_UNRATED, true, 1_000e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertTrue(pos.carbonTier == CarbonTiers.Tier.Unrated);
        assertEq(pos.tradingFeeBps, 100, "unrated must cost as much as High, never as little as Low");
        assertEq(pos.borrowFeeBpsPerHour, 10);
        assertEq(exchange.maxLeverageForAsset(S_UNRATED), 1);
    }

    function test_unratedAsset_leverageAboveOne_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(S_UNRATED, true, 1_000e18, 2);
    }

    // ── no per-user or per-asset fee/leverage exemption path exists ──────────

    /// @dev The ticket's own words: "不得提供任何 per-user 費率豁免路徑". This
    ///      is not a hypothetical — the exchange's pre-existing global fee
    ///      setters (setTradingFeeBps / setBorrowFeePerHour, owned by the
    ///      exchange operator) still exist for the legacy no-registry mode.
    ///      Once carbon pricing is active, this proves the owner calling them
    ///      has NO effect on what a position actually gets charged — there is
    ///      no lever, discretionary or accidental, that discounts a specific
    ///      asset or user below its carbon tier's price.
    function test_ownerCannotDiscountFeeViaLegacyGlobalSetters() public {
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_MSFT, true, 1_000e18, 1);

        PerpetualExchange.Position memory pos = exchange.getPosition(pid);
        assertEq(pos.tradingFeeBps, 100, "owner zeroing the LEGACY global fee must not leak into a High-tier asset's price");
        assertEq(pos.borrowFeeBpsPerHour, 10);
    }

    /// @dev Mirrors the fee test above for leverage: `setMaxLeverageFor` is a
    ///      real, pre-existing owner lever (N3) that this ticket does not
    ///      remove — it can still TIGHTEN an asset below its carbon ceiling.
    ///      What it must never be able to do is LOOSEN a high-carbon asset's
    ///      leverage back up past what its tier permits.
    function test_ownerCannotRaiseLeverageAboveCarbonCeiling() public {
        exchange.setMaxLeverageFor(S_MSFT, 5); // the owner's own override, maxed out

        assertEq(exchange.maxLeverageForAsset(S_MSFT), 1, "carbon ceiling must still win over the owner's own override");

        vm.prank(alice);
        vm.expectRevert(PerpetualExchange.InvalidLeverage.selector);
        exchange.openPosition(S_MSFT, true, 1_000e18, 5);
    }

    /// @dev Fuzz version of the same claim: for ANY owner-set override the
    ///      pre-existing setter's own bounds allow (1..MAX_LEVERAGE), the
    ///      effective leverage for a High-tier asset never exceeds 1.
    function testFuzz_ownerOverride_neverBeatsCarbonCeiling(uint256 ownerOverride) public {
        ownerOverride = bound(ownerOverride, 1, exchange.MAX_LEVERAGE());
        exchange.setMaxLeverageFor(S_MSFT, ownerOverride);
        assertEq(exchange.maxLeverageForAsset(S_MSFT), 1);
    }

    // ── carbon tier is frozen at open, immune to later rating changes ───────

    function test_ratingChangeAfterOpen_doesNotAlterExistingPosition() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_AAPL, true, 1_000e18, 5);

        PerpetualExchange.Position memory before = exchange.getPosition(pid);
        assertEq(before.tradingFeeBps, 10);
        assertTrue(before.carbonTier == CarbonTiers.Tier.Low);

        // sAAPL's rating deteriorates sharply after the position was opened.
        vm.prank(attestor);
        esg.attest(S_AAPL, 50e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 20, 20, 20, SRC); // now deep in High territory

        PerpetualExchange.Position memory afterRatingChange = exchange.getPosition(pid);
        assertEq(afterRatingChange.tradingFeeBps, 10, "existing position's fee must not move");
        assertEq(afterRatingChange.borrowFeeBpsPerHour, 1);
        assertTrue(afterRatingChange.carbonTier == CarbonTiers.Tier.Low, "existing position's stored tier must not move");
    }

    function test_ratingChangeAfterOpen_appliesOnlyToNewPositions() public {
        vm.prank(alice);
        uint256 oldPid = exchange.openPosition(S_AAPL, true, 1_000e18, 5);

        vm.prank(attestor);
        esg.attest(S_AAPL, 50e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 20, 20, 20, SRC);

        // A freshly opened position on the SAME asset picks up the NEW rating —
        // proving the freeze is real (old position untouched) and not just a
        // registry read that happens to be cached forever.
        vm.prank(alice);
        uint256 newPid = exchange.openPosition(S_AAPL, true, 1_000e18, 1);

        assertEq(exchange.getPosition(oldPid).tradingFeeBps, 10, "old position still Low");
        assertEq(exchange.getPosition(newPid).tradingFeeBps, 100, "new position now High");
    }

    function test_ratingChangeAfterOpen_doesNotAlterCloseOrLiquidationMath() public {
        vm.prank(alice);
        uint256 pid = exchange.openPosition(S_AAPL, true, 1_000e18, 5);
        uint256 valueBefore = exchange.getPositionValue(pid);

        vm.prank(attestor);
        esg.attest(S_AAPL, 50e18, CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 20, 20, 20, SRC);

        // getPositionValue mirrors the close path's arithmetic exactly (per its
        // own NatSpec) — if the frozen fee were somehow bypassed, this value
        // would drop as the (now much higher) borrow fee accrues against the
        // position, even with zero elapsed time and zero price movement.
        uint256 valueAfter = exchange.getPositionValue(pid);
        assertEq(valueAfter, valueBefore, "close-path valuation must not react to a post-open rating change");
    }

    // ── legacy fallback: no registry wired behaves exactly as before ────────

    function test_noEsgRegistryWired_usesLegacyGlobalDefaults() public {
        PerpetualExchange legacy = new PerpetualExchange(address(usdc), address(oracle), address(0));
        legacy.setExecutionFee(0);
        vm.prank(alice); usdc.approve(address(legacy), type(uint256).max);
        vm.prank(alice); legacy.depositMargin(100_000e18);
        usdc.mint(address(legacy), 1_000_000e18);

        vm.prank(alice);
        uint256 pid = legacy.openPosition(S_MSFT, true, 1_000e18, 5);

        PerpetualExchange.Position memory pos = legacy.getPosition(pid);
        assertEq(pos.tradingFeeBps, 10, "legacy default trading fee, unaffected by S_MSFT's real High rating");
        assertEq(pos.borrowFeeBpsPerHour, 1);
        assertEq(legacy.maxLeverageForAsset(S_MSFT), 5, "legacy global MAX_LEVERAGE, not carbon-derived");
    }
}

/// @notice #128 / ADR-006: the spot-buy (mint) fee on `AssetVault` is derived
///         per-asset from the asset's WITNESSED carbon tier — the same
///         `CarbonTiers` ladder `PerpetualExchange` prices against. The
///         behaviour under test ("carbon tier decides the cost") is identical
///         whichever contract is the caller, so it lives in this file rather
///         than a second one. ADR-005: redemption is NOT carbon-priced.
contract CarbonPricingVaultTest is Test {
    AssetVaultV2_3   vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    ESGRegistryV2    esg;

    SyntheticAssetV2 lowTok;
    SyntheticAssetV2 midTok;
    SyntheticAssetV2 highTok;
    SyntheticAssetV2 unratedTok;

    address admin    = address(this);
    address attestor = makeAddr("attestor");
    address alice    = makeAddr("alice");

    bytes32 constant LOW     = keccak256("sLOW");   // 0.5 tCO2e/$M -> Low
    bytes32 constant MID     = keccak256("sMID");   // 4.0 tCO2e/$M -> Mid
    bytes32 constant HIGH    = keccak256("sHIGH");  // 20  tCO2e/$M -> High
    bytes32 constant UNRATED = keccak256("sUNRATED"); // priced, never attested

    bytes32 constant SRC = keccak256("https://example.com/vault|2026-09-02");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        esg    = new ESGRegistryV2(admin);

        AssetVaultV2_3 impl = new AssetVaultV2_3();
        vault = AssetVaultV2_3(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_3.initialize, (address(usdc), address(oracle), admin))
        )));
        vault.setEsgRegistry(address(esg));

        lowTok     = _register(LOW,     "sLOW");
        midTok     = _register(MID,     "sMID");
        highTok    = _register(HIGH,    "sHIGH");
        unratedTok = _register(UNRATED, "sUNRATED");

        oracle.addAsset(LOW,     100e8);
        oracle.addAsset(MID,     100e8);
        oracle.addAsset(HIGH,    100e8);
        oracle.addAsset(UNRATED, 100e8);

        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.startPrank(attestor);
        esg.attest(LOW,  0.5e18, CarbonTiers.Tier.Low,  ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        esg.attest(MID,  4e18,   CarbonTiers.Tier.Mid,  ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        esg.attest(HIGH, 20e18,  CarbonTiers.Tier.High, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);
        // UNRATED deliberately never attested.
        vm.stopPrank();

        // Fund generously so the reserve-ratio floor never gets in the way of
        // what these tests are about.
        usdc.mint(admin, 100_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(50_000_000e18);

        usdc.mint(alice, 10_000_000e18);
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
    }

    function _register(bytes32 id, string memory sym) internal returns (SyntheticAssetV2 tok) {
        tok = new SyntheticAssetV2(sym, sym, id, admin);
        tok.grantRole(tok.MINTER_ROLE(), address(vault));
        vault.registerAsset(id, address(tok));
        vault.setAssetCap(id, type(uint128).max);
    }

    // ── mint fee is per-asset, derived from the witnessed tier ───────────────

    function test_vault_mintFeeBpsForAsset_matchesCarbonTiersLadder() public view {
        (uint256 lowFee,,)  = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);
        (uint256 midFee,,)  = CarbonTiers.paramsFor(CarbonTiers.Tier.Mid);
        (uint256 highFee,,) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);

        assertEq(vault.mintFeeBpsForAsset(LOW),  lowFee,  "Low");
        assertEq(vault.mintFeeBpsForAsset(MID),  midFee,  "Mid");
        assertEq(vault.mintFeeBpsForAsset(HIGH), highFee, "High");

        assertEq(lowFee, 10);
        assertEq(midFee, 40);
        assertEq(highFee, 100);

        // Direction (ADR-005): low-carbon is CHEAPER than the pre-#128 flat
        // 0.30% mint fee, high-carbon and unrated are DEARER. The claim is
        // "carbon decides which way the cost moves", not "everything costs more".
        uint256 preTicketFlatFee = 30;
        (uint256 unratedFee,,) = CarbonTiers.paramsFor(CarbonTiers.Tier.Unrated);
        assertLt(lowFee, preTicketFlatFee, "Low tier must undercut the old flat rate");
        assertGt(highFee, preTicketFlatFee, "High tier must exceed the old flat rate");
        assertGt(unratedFee, preTicketFlatFee, "Unrated must exceed the old flat rate, never fall to it");
    }

    /// @dev End-to-end, not just the preview: minting a High-tier asset costs
    ///      10x what minting a Low-tier one does, on the same USDC in.
    function test_vault_mint_chargesTheCarbonFee() public {
        uint256 spend = 100_000e18;

        vm.prank(alice); vault.mint(LOW, spend);
        assertEq(vault.accruedFees(), spend * 10 / 10_000, "Low: 0.10%");

        uint256 feesBefore = vault.accruedFees();
        vm.prank(alice); vault.mint(HIGH, spend);
        assertEq(vault.accruedFees() - feesBefore, spend * 100 / 10_000, "High: 1.00%");
    }

    // ── unrated / all-stale falls to the most conservative tier ──────────────

    function test_vault_unratedAsset_mintFeeIsMostConservative() public view {
        (uint256 conservative,,) = CarbonTiers.paramsFor(CarbonTiers.Tier.Unrated);
        assertEq(vault.mintFeeBpsForAsset(UNRATED), conservative);
        assertEq(conservative, 100, "unrated must cost as much as High, never as little as Low");
    }

    function test_vault_allAttestationsStale_mintFeeFallsToMostConservative() public {
        esg.setMaxAttestationAge(30 days);
        vm.warp(block.timestamp + 31 days);

        // LOW's only attestation is now stale -> registry reports Unrated ->
        // fee must climb to the ceiling, not stay at the cached Low rate.
        assertEq(vault.mintFeeBpsForAsset(LOW), 100, "stale rating fails closed, it does not linger cheap");
    }

    // ── registry unset: fail closed to the ceiling, not the old cheap default ─

    function test_vault_registryUnset_mintFeeFailsClosed_notLegacy30() public {
        AssetVaultV2_3 bare = AssetVaultV2_3(address(new ERC1967Proxy(
            address(new AssetVaultV2_3()),
            abi.encodeCall(AssetVaultV2_3.initialize, (address(usdc), address(oracle), admin))
        )));
        // esgRegistry deliberately left unset.
        assertEq(bare.esgRegistry(), address(0));
        assertEq(bare.mintFeeBpsForAsset(HIGH), 100, "no registry -> most conservative tier, NOT the old 30 bps");
    }

    // ── redemption is never carbon-priced (ADR-005) ─────────────────────────

    function test_vault_redeemFee_isFlat_regardlessOfTier() public view {
        // Same gross value on a Low-tier and a High-tier asset -> same redeem fee.
        (, uint256 lowRedeemFee)  = vault.previewRedeem(LOW,  10e18);
        (, uint256 highRedeemFee) = vault.previewRedeem(HIGH, 10e18);
        assertEq(lowRedeemFee, highRedeemFee, "a high-carbon exit is not taxed more than a low-carbon one");
        assertEq(lowRedeemFee, 10e18 * 100e8 / 1e8 * vault.redeemFeeBps() / 10_000);
    }

    // ── the tested ABSENCE: no path changes one asset's mint fee ────────────

    /// @dev The vault-side sibling of
    ///      `test_ownerCannotDiscountFeeViaLegacyGlobalSetters`. There is no
    ///      per-asset mint-fee lever, discretionary or accidental: the
    ///      pre-#128 setters that could have leaked into it are gone from the
    ///      ABI, and the one knob that remains (`setRiskParams`, redeem only)
    ///      provably does not touch a mint fee.
    function test_vault_noPathChangesASingleAssetsMintFee() public {
        uint256 highBefore = vault.mintFeeBpsForAsset(HIGH);

        // The old 4-arg setRiskParams — the one whose first argument WAS the
        // mint fee — must not exist any more.
        (bool old4arg,) = address(vault).call(
            abi.encodeWithSignature("setRiskParams(uint256,uint256,uint256,uint256)", 0, 0, 11_000, uint256(1 hours))
        );
        assertFalse(old4arg, "the settable mint-fee parameter is removed, not merely unused");

        // No per-asset mint-fee override under any plausible name.
        (bool perAsset,) = address(vault).call(abi.encodeWithSignature("setMintFeeFor(bytes32,uint256)", HIGH, uint256(0)));
        assertFalse(perAsset);
        (bool global,) = address(vault).call(abi.encodeWithSignature("setMintFeeBps(uint256)", uint256(0)));
        assertFalse(global);

        // The knob that DOES remain moves the redeem fee and nothing else.
        vault.setRiskParams(0, 11_000, 1 hours);
        assertEq(vault.redeemFeeBps(), 0);
        assertEq(vault.mintFeeBpsForAsset(HIGH), highBefore, "redeem knob must not leak into a mint fee");
        assertEq(vault.mintFeeBpsForAsset(HIGH), 100);
    }

    /// @dev `setEsgRegistry` is a vault-wide switch, not a per-asset lever:
    ///      pointing it at a fresh (empty) registry moves EVERY asset to
    ///      Unrated at once — it cannot single one out.
    function test_vault_setEsgRegistry_isAllOrNothing() public {
        ESGRegistryV2 empty = new ESGRegistryV2(admin);
        vault.setEsgRegistry(address(empty));

        assertEq(vault.mintFeeBpsForAsset(LOW),  100);
        assertEq(vault.mintFeeBpsForAsset(MID),  100);
        assertEq(vault.mintFeeBpsForAsset(HIGH), 100);
    }
}
