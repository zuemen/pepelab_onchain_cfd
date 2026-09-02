// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/CarbonTiers.sol";
import "../src/ESGRegistryV2.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

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
        esg.attest(S_AAPL, 0.150e18, 60, 65, 70, SRC);
        esg.attest(S_ESGU, 4.34e18, 60, 65, 70, SRC);
        esg.attest(S_MSFT, 10.226e18, 60, 65, 70, SRC);
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
        esg.attest(S_AAPL, 50e18, 20, 20, 20, SRC); // now deep in High territory

        PerpetualExchange.Position memory afterRatingChange = exchange.getPosition(pid);
        assertEq(afterRatingChange.tradingFeeBps, 10, "existing position's fee must not move");
        assertEq(afterRatingChange.borrowFeeBpsPerHour, 1);
        assertTrue(afterRatingChange.carbonTier == CarbonTiers.Tier.Low, "existing position's stored tier must not move");
    }

    function test_ratingChangeAfterOpen_appliesOnlyToNewPositions() public {
        vm.prank(alice);
        uint256 oldPid = exchange.openPosition(S_AAPL, true, 1_000e18, 5);

        vm.prank(attestor);
        esg.attest(S_AAPL, 50e18, 20, 20, 20, SRC);

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
        esg.attest(S_AAPL, 50e18, 20, 20, 20, SRC);

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
