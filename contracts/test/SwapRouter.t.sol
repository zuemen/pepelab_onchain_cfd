// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/MockSwapRouter.sol";

contract SwapRouterTest is Test {
    MockUSDC       usdc;
    MockSwapRouter router;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdc   = new MockUSDC();
        router = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(router));
        vm.deal(alice, 10 ether);
    }

    // ── ETH → mUSDC ──────────────────────────────────────────────────────────

    function testSwapETHForUSDC_correctRate() public {
        vm.prank(alice);
        router.swapETHForUSDC{value: 1 ether}();
        assertEq(usdc.balanceOf(alice), 3000e18);
    }

    // ── mUSDC → ETH ──────────────────────────────────────────────────────────

    function testSwapUSDCForETH_correctRate() public {
        vm.deal(address(router), 1 ether);
        usdc.mint(alice, 3000e18);
        vm.prank(alice);
        usdc.approve(address(router), 3000e18);

        uint256 aliceEthBefore = alice.balance;
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);

        assertEq(alice.balance, aliceEthBefore + 1 ether);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function testSwapUSDCForETH_burnsUsdc() public {
        vm.deal(address(router), 1 ether);
        usdc.mint(alice, 3000e18);
        vm.prank(alice);
        usdc.approve(address(router), 3000e18);

        uint256 supplyBefore = usdc.totalSupply();
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);

        assertEq(usdc.totalSupply(), supplyBefore - 3000e18);
    }

    function testSwapUSDCForETH_insufficientEth_revert() public {
        // Router has 0 ETH; alice has enough mUSDC + approval
        usdc.mint(alice, 3000e18);
        vm.prank(alice);
        usdc.approve(address(router), 3000e18);

        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.InsufficientEthInRouter.selector, 1 ether, 0)
        );
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);
    }

    function testSwapUSDCForETH_insufficientAllowance_revert() public {
        vm.deal(address(router), 1 ether);
        usdc.mint(alice, 3000e18);
        // No approval

        vm.expectRevert(MockSwapRouter.InsufficientUsdcAllowance.selector);
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);
    }

    function testSwapUSDCForETH_insufficientBalance_revert() public {
        vm.deal(address(router), 1 ether);
        // alice has no mUSDC

        vm.expectRevert(MockSwapRouter.InsufficientUsdcBalance.selector);
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);
    }

    // ── fundRouter ───────────────────────────────────────────────────────────

    function testFundRouter_increasesReserve() public {
        uint256 before = router.ethReserve();
        router.fundRouter{value: 5 ether}();
        assertEq(router.ethReserve(), before + 5 ether);
    }

    // ── burnFrom access control ──────────────────────────────────────────────

    function testBurnFrom_byNonRouter_revert() public {
        usdc.mint(alice, 1000e18);
        vm.expectRevert(bytes("Only router can burn"));
        vm.prank(bob);
        usdc.burnFrom(alice, 1000e18);
    }

    // ── Events ───────────────────────────────────────────────────────────────

    function testEventsEmittedCorrectly() public {
        // SwapEthToUsdc
        vm.expectEmit(true, false, false, true);
        emit MockSwapRouter.SwapEthToUsdc(alice, 1 ether, 3000e18, block.timestamp);
        vm.prank(alice);
        router.swapETHForUSDC{value: 1 ether}();

        // SwapUsdcToEth
        vm.deal(address(router), 1 ether);
        vm.prank(alice);
        usdc.approve(address(router), 3000e18);

        vm.expectEmit(true, false, false, true);
        emit MockSwapRouter.SwapUsdcToEth(alice, 3000e18, 1 ether, block.timestamp);
        vm.prank(alice);
        router.swapUSDCForETH(3000e18);
    }
}
