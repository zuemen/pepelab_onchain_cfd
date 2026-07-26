// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @dev A trivial V3 used only to prove the upgrade path preserves storage.
contract AssetVaultV3Probe is AssetVaultV2 {
    function version() public pure override returns (string memory) {
        return "3.0.0-probe";
    }
}

contract AssetVaultV2UpgradeTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    // Cached: vm.prank applies to the next call only, so reading these inline
    // under a prank would consume it.
    bytes32 adminRole;

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        bytes memory init = abi.encodeCall(
            AssetVaultV2.initialize, (address(usdc), address(oracle), admin)
        );
        vault = AssetVaultV2(address(new ERC1967Proxy(address(impl), init)));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        bytes32 minterRole = aapl.MINTER_ROLE();
        adminRole = vault.DEFAULT_ADMIN_ROLE();

        vm.startPrank(admin);
        aapl.grantRole(minterRole, address(vault));
        vault.registerAsset(AID, address(aapl));
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);
    }

    function test_initializedState() public view {
        assertEq(vault.usdc(), address(usdc));
        assertEq(vault.oracle(), address(oracle));
        assertEq(vault.assetToken(AID), address(aapl));
        assertTrue(vault.hasRole(adminRole, admin));
        assertEq(vault.version(), "2.0.0");
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert();
        vault.initialize(address(usdc), address(oracle), admin);
    }

    function test_onlyAdminCanUpgrade() public {
        AssetVaultV3Probe next = new AssetVaultV3Probe();
        vm.prank(alice);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
    }

    /// @dev The point of the proxy: fixing a bug must not lose registrations or
    ///      reserves. If this ever fails, the upgrade path is unsafe.
    function test_upgradePreservesState() public {
        usdc.mint(address(vault), 5_000e18);   // simulate an existing reserve

        AssetVaultV3Probe next = new AssetVaultV3Probe();
        vm.prank(admin);
        vault.upgradeToAndCall(address(next), "");

        assertEq(vault.version(), "3.0.0-probe");
        assertEq(vault.assetToken(AID), address(aapl));      // registration kept
        assertEq(usdc.balanceOf(address(vault)), 5_000e18);  // reserve kept
        assertTrue(vault.hasRole(adminRole, admin));
    }

    function test_onlyAdminCanRegisterAsset() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.registerAsset(keccak256("sX"), address(0xdead));
    }

    /// @dev Roles are split so an institution can hold upgrade authority and
    ///      risk-parameter authority on different keys.
    function test_rolesAreSeparable() public {
        address riskOps = makeAddr("riskOps");
        bytes32 riskRole = vault.RISK_ROLE();

        vm.prank(admin);
        vault.grantRole(riskRole, riskOps);

        assertTrue(vault.hasRole(riskRole, riskOps));
        assertFalse(vault.hasRole(adminRole, riskOps));   // cannot upgrade
    }
}
