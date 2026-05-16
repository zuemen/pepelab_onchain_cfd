// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

/// @dev Verifies that FeeRouter routes its 10 % slash share into the InsuranceVault.
contract FeeRouterVaultTest is Test {
    InsuranceVault vault;
    FeeRouter      feeRouter;
    MockUSDC       usdc;

    address platform = makeAddr("platform");
    address trader   = makeAddr("trader");
    address caller   = makeAddr("caller");  // authorized as copyTracker

    function setUp() public {
        usdc      = new MockUSDC();
        vault     = new InsuranceVault(address(usdc));
        feeRouter = new FeeRouter(address(usdc), platform, address(vault));

        // Authorize
        vault.setFeeRouter(address(feeRouter));
        feeRouter.setCopyTracker(caller);
        feeRouter.setExchange(caller);  // caller also simulates exchange for performance fee

        // Fund caller (acts as copyTracker) and feeRouter (acts as exchange pre-transfer buffer)
        usdc.mint(caller,              1_000_000e18);
        usdc.mint(address(feeRouter),  1_000_000e18);

        vm.prank(caller);
        usdc.approve(address(feeRouter), type(uint256).max);
    }

    function test_copyFee_10pct_goesToVault() public {
        uint256 fee = 1_000e18;

        vm.prank(caller);
        feeRouter.distributeCopyFee(trader, fee);

        // 10 % of fee goes to vault
        assertEq(vault.totalAssets(), fee * 1_000 / 10_000);
        // Trader earns 70 %
        assertEq(feeRouter.traderEarnings(trader), fee * 7_000 / 10_000);
        // Platform earns 20 %
        assertEq(feeRouter.platformEarnings(), fee * 2_000 / 10_000);
    }

    function test_performanceFee_10pct_goesToVault() public {
        uint256 fee = 500e18;

        vm.prank(caller);
        feeRouter.receivePerformanceFee(trader, fee);

        // 10 % of fee goes to vault
        assertEq(vault.totalAssets(), fee * 1_000 / 10_000);
        assertEq(feeRouter.traderEarnings(trader), fee * 7_000 / 10_000);
        assertEq(feeRouter.platformEarnings(), fee * 2_000 / 10_000);
    }
}
