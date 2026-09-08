// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2_3.sol";
import "../../src/v2/AssetVaultV2_4.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/ESGRegistryV2.sol";
import "../../src/CarbonTiers.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @notice V2.4 (#128, ADR-005/006): the mint fee stops being a settable
///         scalar and becomes per-asset, derived from the witnessed carbon
///         tier. This is a UUPS upgrade of the live V2.3 proxy — the storage
///         layout must be byte-identical except the one appended field, and
///         every pre-existing value must survive. The carbon-pricing
///         behaviour itself is pinned in CarbonPricing.t.sol; this file is
///         about the migration.
contract AssetVaultV2_4UpgradeTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;

    AssetVaultV2_3 vault;   // proxy, running V2.3 until _upgrade()
    SyntheticAssetV2 aapl;

    address admin    = address(this);
    address alice    = makeAddr("alice");
    address attestor = makeAddr("attestor");

    bytes32 constant AAPL = keccak256("sAAPL");
    bytes32 constant SRC  = keccak256("https://example.com/v24|2026-09-08");

    function setUp() public {
        vm.warp(1_700_000_000);

        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AAPL, 200e8);

        AssetVaultV2_3 impl = new AssetVaultV2_3();
        vault = AssetVaultV2_3(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_3.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AAPL, admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        vault.registerAsset(AAPL, address(aapl));
        vault.setAssetCap(AAPL, 1_000e18);

        // A non-default risk config, so "preserved" means something.
        vault.setRiskParams(30, 25, 12_000, 2 hours); // mintFee 30, redeemFee 25

        usdc.mint(admin, 10_000_000e18);
        usdc.mint(alice, 10_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(5_000e18);
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
    }

    function _upgrade() internal returns (AssetVaultV2_4 v) {
        v = AssetVaultV2_4(address(vault));
        vault.upgradeToAndCall(address(new AssetVaultV2_4()), "");
    }

    // ── storage layout / state preservation ─────────────────────────────────

    function test_upgradePreservesEveryStateField() public {
        vm.prank(alice); vault.mint(AAPL, 10_000e18); // fee 30 bps under V2.3

        uint256 feesBefore    = vault.accruedFees();
        uint256 exposureBefore = vault.exposureOf(AAPL);
        uint256 capBefore     = vault.assetCap(AAPL);
        uint256 reserveBefore = vault.reserve();
        uint256 redeemFeeBefore = vault.redeemFeeBps();
        uint256 minRatioBefore = vault.minReserveRatioBps();
        uint256 maxAgeBefore  = vault.maxPriceAge();
        address oracleBefore  = vault.oracle();
        address usdcBefore    = vault.usdc();
        address tokenBefore   = vault.assetToken(AAPL);

        AssetVaultV2_4 v = _upgrade();

        assertEq(v.version(), "2.4.0");
        assertEq(v.accruedFees(),          feesBefore, "accruedFees");
        assertEq(v.exposureOf(AAPL),        exposureBefore, "exposure");
        assertEq(v.assetCap(AAPL),          capBefore, "cap");
        assertEq(v.reserve(),               reserveBefore, "reserve");
        assertEq(v.redeemFeeBps(),          redeemFeeBefore, "redeemFeeBps");
        assertEq(v.minReserveRatioBps(),    minRatioBefore, "minReserveRatioBps");
        assertEq(v.maxPriceAge(),           maxAgeBefore, "maxPriceAge");
        assertEq(v.oracle(),                oracleBefore, "oracle");
        assertEq(v.usdc(),                  usdcBefore, "usdc");
        assertEq(v.assetToken(AAPL),        tokenBefore, "assetToken");
        assertEq(v.registeredAssets().length, 1, "registeredAssets");
        assertFalse(v.mintingHalted(), "mintingHalted preserved (false)");
    }

    function test_upgrade_newRegistrySlotStartsEmpty() public {
        AssetVaultV2_4 v = _upgrade();
        assertEq(v.esgRegistry(), address(0), "the V2.4 registry slot must read 0 on a migrated proxy");
    }

    /// @dev The retained `mintFeeBps` slot is dead: no getter after the
    ///      upgrade, and the pre-upgrade mint's accrued fee is not
    ///      retroactively re-priced.
    function test_upgrade_preUpgradeMintFeeNotRepriced() public {
        vm.prank(alice); vault.mint(AAPL, 10_000e18); // 30 bps -> 30e18 fee under V2.3
        assertEq(vault.accruedFees(), 30e18);

        AssetVaultV2_4 v = _upgrade();
        assertEq(v.accruedFees(), 30e18, "a mint that already happened keeps the fee it paid");

        // The old public getter is gone (compile-time); the old 4-arg setter too.
        (bool old4arg,) = address(v).call(
            abi.encodeWithSignature("setRiskParams(uint256,uint256,uint256,uint256)", 0, 0, 11_000, uint256(1 hours))
        );
        assertFalse(old4arg, "the settable mint-fee parameter is removed");
        (bool getter,) = address(v).staticcall(abi.encodeWithSignature("mintFeeBps()"));
        assertFalse(getter, "the mintFeeBps public getter is removed");
    }

    // ── carbon pricing works on the migrated proxy ──────────────────────────

    function test_upgrade_thenWireRegistry_mintFeeBecomesCarbonDerived() public {
        AssetVaultV2_4 v = _upgrade();

        // Before wiring: fail-closed to the most conservative tier (100 bps),
        // not V2.3's old 30.
        assertEq(v.mintFeeBpsForAsset(AAPL), 100, "unset registry -> ceiling, not the old 30");

        ESGRegistryV2 esg = new ESGRegistryV2(admin);
        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.prank(attestor);
        esg.attest(AAPL, 0.150e18, CarbonTiers.Tier.Low, ESGRegistryV2.Basis.Revenue, 60, 65, 70, SRC);

        v.setEsgRegistry(address(esg));
        assertEq(v.mintFeeBpsForAsset(AAPL), 10, "Low-tier asset now priced at the Low mint fee");

        // And a real mint charges it.
        uint256 feesBefore = v.accruedFees();
        vm.prank(alice); v.mint(AAPL, 10_000e18);
        assertEq(v.accruedFees() - feesBefore, 10_000e18 * 10 / 10_000, "0.10%");
    }

    function test_upgrade_redeemStillWorksAndFeeIsFlat() public {
        vm.prank(alice); vault.mint(AAPL, 10_000e18);
        uint256 held = aapl.balanceOf(alice);

        AssetVaultV2_4 v = _upgrade();

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); v.redeem(AAPL, held);
        assertGt(usdc.balanceOf(alice), before, "holders can still exit after the upgrade");
        assertEq(aapl.balanceOf(alice), 0);
    }

    function test_onlyAdminCanUpgrade() public {
        AssetVaultV2_4 next = new AssetVaultV2_4();
        vm.prank(alice);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
    }
}
