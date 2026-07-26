// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

contract AssetVaultV2FeesTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    bytes32 constant AID = keccak256("sAAPL");

    uint256 priceSetAt;   // the oracle's updatedAt for AID

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        bytes32 minterRole = aapl.MINTER_ROLE();

        vm.startPrank(admin);
        aapl.grantRole(minterRole, address(vault));
        vault.registerAsset(AID, address(aapl));
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);   // $200
        (, priceSetAt) = oracle.getPrice(AID);
    }

    /// @dev 0.30% of 2000 = 6 USDC fee; 1994 / 200 = 9.97 sAAPL.
    function test_previewMintDeductsFee() public view {
        (uint256 tokenOut, uint256 fee) = vault.previewMint(AID, 2_000e18);
        assertEq(fee, 6e18);
        assertEq(tokenOut, 1_994e18 * 1e8 / 200e8);
        assertEq(tokenOut, 9.97e18);
    }

    /// @dev 10 sAAPL * $200 = 2000 gross; 0.30% = 6 fee; 1994 net out.
    function test_previewRedeemDeductsFee() public view {
        (uint256 usdcOut, uint256 fee) = vault.previewRedeem(AID, 10e18);
        assertEq(fee, 6e18);
        assertEq(usdcOut, 1_994e18);
    }

    function test_zeroFeeMatchesV1Math() public {
        vm.prank(admin);
        vault.setRiskParams(0, 0, 11_000, 1 hours);

        (uint256 tokenOut, uint256 fee) = vault.previewMint(AID, 2_000e18);
        assertEq(fee, 0);
        assertEq(tokenOut, 10e18);      // identical to V1
    }

    /// @dev VULNERABILITY #3 FIX. V1 accepted a price of any age.
    function test_previewRevertsOnStalePrice() public {
        vm.warp(block.timestamp + 2 hours);   // maxPriceAge is 1 hour
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.StalePrice.selector, AID, priceSetAt));
        vault.previewMint(AID, 1_000e18);
    }

    function test_previewSucceedsJustInsideMaxAge() public {
        vm.warp(block.timestamp + 59 minutes);
        (uint256 tokenOut, ) = vault.previewMint(AID, 2_000e18);
        assertGt(tokenOut, 0);
    }

    function test_previewRevertsWhenAssetNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.AssetNotRegistered.selector, keccak256("sX")));
        vault.previewMint(keccak256("sX"), 1_000e18);
    }

    /// @dev A compromised RISK_ROLE key must not be able to confiscate deposits
    ///      by setting a 100% fee.
    function test_feeIsCappedAtTenPercent() public {
        vm.prank(admin);
        vm.expectRevert(AssetVaultV2.InvalidParam.selector);
        vault.setRiskParams(1_001, 0, 11_000, 1 hours);

        vm.prank(admin);
        vault.setRiskParams(1_000, 1_000, 11_000, 1 hours);   // 10% is allowed
        assertEq(vault.mintFeeBps(), 1_000);
    }

    function test_maxPriceAgeCannotBeZero() public {
        vm.prank(admin);
        vm.expectRevert(AssetVaultV2.InvalidParam.selector);
        vault.setRiskParams(30, 30, 11_000, 0);
    }

    function test_onlyRiskRoleCanSetParams() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        vault.setRiskParams(0, 0, 0, 1 hours);
    }
}
