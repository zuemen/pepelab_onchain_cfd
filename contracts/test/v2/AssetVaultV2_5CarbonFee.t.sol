// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../../src/v2/AssetVaultV2_5.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/CarbonRetirement.sol";
import "../../src/CarbonTiers.sol";
import "../../src/MockCarbonCredit.sol";
import "../../src/MockOracle.sol";
import "../../src/MockUSDC.sol";

contract StubCarbonRegistry {
    mapping(bytes32 => CarbonTiers.Tier) public tierOf;

    function setTier(bytes32 assetId, CarbonTiers.Tier tier) external {
        tierOf[assetId] = tier;
    }

    function medianCarbonTier(bytes32 assetId)
        external
        view
        returns (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated)
    {
        tier = tierOf[assetId];
        return (tier, 1, 0, tier != CarbonTiers.Tier.Unrated);
    }
}

/// @notice V2.5: the buy fee's fixed carbon share leaves for CarbonRetirement
///         inside mint(), so a higher carbon tier retires more.
contract AssetVaultV2_5CarbonFeeTest is Test {
    MockUSDC usdc;
    MockOracle oracle;
    AssetVaultV2_5 vault;
    StubCarbonRegistry registry;
    MockCarbonCredit credit;
    CarbonRetirement retirement;
    SyntheticAssetV2 lowAsset;
    SyntheticAssetV2 highAsset;

    address admin = address(this);
    address alice = makeAddr("alice");
    address seller = makeAddr("seller");

    bytes32 constant LOW = keccak256("sLOW");
    bytes32 constant HIGH = keccak256("sHIGH");
    uint256 constant BUY = 1_000e18;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(LOW, 100e8);
        oracle.addAsset(HIGH, 100e8);

        AssetVaultV2_5 impl = new AssetVaultV2_5();
        vault = AssetVaultV2_5(address(new ERC1967Proxy(
            address(impl), abi.encodeCall(AssetVaultV2_5.initialize, (address(usdc), address(oracle), admin))
        )));

        lowAsset = new SyntheticAssetV2("Low", "sLOW", LOW, admin);
        highAsset = new SyntheticAssetV2("High", "sHIGH", HIGH, admin);
        lowAsset.grantRole(lowAsset.MINTER_ROLE(), address(vault));
        highAsset.grantRole(highAsset.MINTER_ROLE(), address(vault));
        vault.registerAsset(LOW, address(lowAsset));
        vault.registerAsset(HIGH, address(highAsset));
        vault.setAssetCap(LOW, 1_000_000e18);
        vault.setAssetCap(HIGH, 1_000_000e18);

        registry = new StubCarbonRegistry();
        registry.setTier(LOW, CarbonTiers.Tier.Low);
        registry.setTier(HIGH, CarbonTiers.Tier.High);
        vault.setEsgRegistry(address(registry));

        credit = new MockCarbonCredit(admin);
        credit.issue(seller, 1_000_000e18);
        retirement = new CarbonRetirement(address(usdc), address(credit), seller, 10e18);
        vm.prank(seller);
        credit.approve(address(retirement), type(uint256).max);

        usdc.mint(admin, 10_000_000e18);
        usdc.mint(alice, 10_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _feeOf(bytes32 assetId, uint256 amount) internal view returns (uint256) {
        return amount * vault.mintFeeBpsForAsset(assetId) / vault.BPS_DENOM();
    }

    function test_mintSendsTheFixedShareOfTheFeeToRetirement() public {
        vault.setCarbonRetirement(address(retirement));
        uint256 fee = _feeOf(HIGH, BUY);
        uint256 share = fee * vault.CARBON_FEE_SHARE_BPS() / vault.BPS_DENOM();

        vm.prank(alice);
        vault.mint(HIGH, BUY);

        assertEq(usdc.balanceOf(address(retirement)), share, "retirement budget");
        assertEq(vault.accruedFees(), fee - share, "the rest stays as vault fees");
    }

    function test_higherCarbonTierRetiresMoreForTheSameBuy() public {
        vault.setCarbonRetirement(address(retirement));

        vm.prank(alice);
        vault.mint(LOW, BUY);
        uint256 lowShare = usdc.balanceOf(address(retirement));

        vm.prank(alice);
        vault.mint(HIGH, BUY);
        uint256 highShare = usdc.balanceOf(address(retirement)) - lowShare;

        assertEq(highShare, lowShare * 10, "1.00% vs 0.10%");
    }

    function test_retirementShareDoesNotChangeTheReserve() public {
        uint256 before = vault.reserve();
        vault.setCarbonRetirement(address(retirement));
        uint256 fee = _feeOf(HIGH, BUY);

        vm.prank(alice);
        vault.mint(HIGH, BUY);

        assertEq(vault.reserve(), before + BUY - fee, "same reserve as when the whole fee stays");
    }

    function test_withoutRetirementTheWholeFeeStaysInTheVault() public {
        uint256 fee = _feeOf(HIGH, BUY);

        vm.prank(alice);
        vault.mint(HIGH, BUY);

        assertEq(vault.accruedFees(), fee);
        assertEq(usdc.balanceOf(address(retirement)), 0);
    }

    function test_mintEmitsTheRoutedAmount() public {
        vault.setCarbonRetirement(address(retirement));
        uint256 share = _feeOf(HIGH, BUY) * vault.CARBON_FEE_SHARE_BPS() / vault.BPS_DENOM();

        vm.expectEmit(true, false, false, true, address(vault));
        emit AssetVaultV2_5.CarbonFeeRouted(HIGH, share);
        vm.prank(alice);
        vault.mint(HIGH, BUY);
    }

    function test_redeemFeeIsNotRouted() public {
        vault.setCarbonRetirement(address(retirement));
        vm.startPrank(alice);
        uint256 out = vault.mint(HIGH, BUY);
        uint256 budget = usdc.balanceOf(address(retirement));
        vault.redeem(HIGH, out);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(retirement)), budget, "redemption is never priced on carbon");
    }

    function test_routedShareCanBeRetiredByAnyone() public {
        vault.setCarbonRetirement(address(retirement));
        vm.prank(alice);
        vault.mint(HIGH, BUY);
        uint256 budget = retirement.budget();
        assertGt(budget, 0);

        vm.prank(makeAddr("anyone"));
        uint256 tonnes = retirement.retire(budget);

        assertGt(tonnes, 0);
        assertEq(retirement.budget(), 0);
    }

    function test_adminCannotWithdrawTheRoutedShare() public {
        vault.setCarbonRetirement(address(retirement));
        uint256 fee = _feeOf(HIGH, BUY);
        uint256 share = fee * vault.CARBON_FEE_SHARE_BPS() / vault.BPS_DENOM();
        vm.prank(alice);
        vault.mint(HIGH, BUY);

        vm.expectRevert(AssetVaultV2_5.InvalidParam.selector);
        vault.withdrawFees(admin, fee - share + 1);
    }

    function test_setCarbonRetirementIsAdminOnly() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, alice, adminRole
        ));
        vault.setCarbonRetirement(address(retirement));
    }

    function test_setCarbonRetirementWorksOnlyOnce() public {
        vault.setCarbonRetirement(address(retirement));
        CarbonRetirement other = new CarbonRetirement(address(usdc), address(credit), seller, 10e18);

        vm.expectRevert(AssetVaultV2_5.CarbonRetirementAlreadySet.selector);
        vault.setCarbonRetirement(address(other));
    }

    function test_setCarbonRetirementRejectsZeroAddress() public {
        vm.expectRevert(AssetVaultV2_5.InvalidParam.selector);
        vault.setCarbonRetirement(address(0));
    }

    function test_setCarbonRetirementRejectsAnotherSettlementToken() public {
        MockUSDC otherToken = new MockUSDC();
        CarbonRetirement other = new CarbonRetirement(address(otherToken), address(credit), seller, 10e18);

        vm.expectRevert(AssetVaultV2_5.InvalidParam.selector);
        vault.setCarbonRetirement(address(other));
    }
}
