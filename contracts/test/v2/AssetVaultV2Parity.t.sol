// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/AssetVault.sol";
import "../../src/SyntheticAsset.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @notice With fees off and a generous cap, V2 must reproduce V1's numbers.
///         Any divergence should be a deliberate risk control, not drift.
contract AssetVaultV2ParityTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;

    AssetVault       v1;
    SyntheticAsset   v1Token;
    AssetVaultV2     v2;
    SyntheticAssetV2 v2Token;

    address admin = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);

        // V1
        v1 = new AssetVault(address(usdc), address(oracle));
        v1Token = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(v1));
        v1.registerAsset(AID, address(v1Token));

        // V2, configured to behave like V1
        AssetVaultV2 impl = new AssetVaultV2();
        v2 = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        v2Token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        v2Token.grantRole(v2Token.MINTER_ROLE(), address(v2));
        v2.registerAsset(AID, address(v2Token));
        v2.setAssetCap(AID, type(uint256).max);
        v2.setRiskParams(0, 0, 0, 1 hours);   // no fees, no ratio floor

        usdc.mint(alice, 100_000e18);
        usdc.mint(bob,   100_000e18);
        usdc.mint(admin, 500_000e18);
        usdc.approve(address(v1), type(uint256).max);
        usdc.approve(address(v2), type(uint256).max);
        v1.fundVault(100_000e18);
        v2.fundVault(100_000e18);
    }

    function test_mintAmountsMatch() public {
        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        v2.mint(AID, 2_000e18);
        vm.stopPrank();

        assertEq(v1Token.balanceOf(alice), v2Token.balanceOf(bob));
        assertEq(v2Token.balanceOf(bob), 10e18);
    }

    function test_redeemProceedsMatchAfterPriceMove() public {
        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        v2.mint(AID, 2_000e18);
        vm.stopPrank();

        oracle.updatePrice(AID, 250e8);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore   = usdc.balanceOf(bob);

        vm.prank(alice);
        v1.redeem(AID, 10e18);
        vm.prank(bob);
        v2.redeem(AID, 10e18);

        assertEq(usdc.balanceOf(alice) - aliceBefore, usdc.balanceOf(bob) - bobBefore);
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_500e18);
    }

    /// @dev The one intended divergence: V1 accepts a year-old price, V2 refuses.
    function test_stalePriceIsTheIntendedDivergence() public {
        vm.warp(block.timestamp + 365 days);

        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);          // V1: succeeds (the vulnerability)
        vm.stopPrank();
        assertEq(v1Token.balanceOf(alice), 10e18);

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        vm.expectRevert();               // V2: StalePrice
        v2.mint(AID, 2_000e18);
        vm.stopPrank();
        assertEq(v2Token.balanceOf(bob), 0);
    }

    /// @dev The V1 drain scenario, replayed against V2 with the operator's
    ///      defaults on. V1 let the reserve go to zero; V2 stops the mint that
    ///      would get it there.
    function test_v2StopsTheDrainV1Allowed() public {
        // Reconfigure V2 to the shipped defaults rather than V1-parity mode.
        v2.setRiskParams(30, 30, 11_000, 1 hours);
        v2.setAssetCap(AID, 1_000e18);

        vm.startPrank(bob);
        usdc.approve(address(v2), type(uint256).max);
        v2.mint(AID, 90_000e18);
        vm.stopPrank();

        oracle.updatePrice(AID, 420e8);   // the move that drained V1

        vm.startPrank(bob);
        vm.expectRevert();                // ReserveRatioTooLow
        v2.mint(AID, 1_000e18);
        vm.stopPrank();

        // and bob can still exit
        vm.prank(bob);
        uint256 out = v2.redeem(AID, 10e18);
        assertGt(out, 0);
    }
}
