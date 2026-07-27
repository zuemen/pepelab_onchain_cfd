// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/MockSwapRouter.sol";

contract MockSwapRouterTest is Test {
    MockUSDC       usdc;
    MockSwapRouter router;

    address alice = makeAddr("alice");

    uint256 constant ROUTER_ETH = 10 ether;

    event SwapEthToUsdc(address indexed user, uint256 ethIn, uint256 usdcOut, uint256 timestamp);
    event SwapUsdcToEth(address indexed user, uint256 usdcIn, uint256 ethOut, uint256 timestamp);

    function setUp() public {
        usdc   = new MockUSDC();
        router = new MockSwapRouter(address(usdc));

        // swapUSDCForETH burns through MockUSDC.burnFrom, which only the
        // registered router may call. Without this the USDC→ETH path reverts
        // "Only router can burn" and none of it is reachable.
        usdc.setSwapRouter(address(router));

        // The router pays ETH out of its own balance; it holds none on deploy.
        router.fundRouter{value: ROUTER_ETH}();

        vm.deal(alice, 10 ether);
        usdc.mint(alice, 100_000e18);
    }

    // ── Setup / constants ─────────────────────────────────────────────────────

    function testConstructor_wiresUsdcAndRate() public view {
        assertEq(address(router.usdc()), address(usdc), "usdc");
        assertEq(router.RATE(), 3000, "rate");
        assertEq(router.ethReserve(), ROUTER_ETH, "eth reserve");
    }

    // ── ETH → USDC ────────────────────────────────────────────────────────────

    function testSwapETHForUSDC_mintsAtRate() public {
        vm.prank(alice);
        router.swapETHForUSDC{value: 1 ether}();
        assertEq(usdc.balanceOf(alice), 100_000e18 + 3_000e18, "minted at 1:3000");
    }

    /// @dev USDC is MINTED here rather than paid out of a reserve, so the
    ///      router's ETH balance only grows. Worth pinning: it means this leg
    ///      can never run dry, unlike the reverse one.
    function testSwapETHForUSDC_ethAccumulatesInRouter() public {
        vm.prank(alice);
        router.swapETHForUSDC{value: 2 ether}();
        assertEq(router.ethReserve(), ROUTER_ETH + 2 ether, "eth stays in router");
        assertEq(usdc.totalSupply(), 100_000e18 + 6_000e18, "supply grew by the mint");
    }

    function testSwapETHForUSDC_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(router));
        emit SwapEthToUsdc(alice, 1 ether, 3_000e18, block.timestamp);
        vm.prank(alice);
        router.swapETHForUSDC{value: 1 ether}();
    }

    function testSwapETHForUSDC_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(MockSwapRouter.MustSendEth.selector);
        router.swapETHForUSDC{value: 0}();
    }

    // ── USDC → ETH ────────────────────────────────────────────────────────────

    function testSwapUSDCForETH_burnsAndPaysEth() public {
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        usdc.approve(address(router), 3_000e18);
        router.swapUSDCForETH(3_000e18);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 100_000e18 - 3_000e18, "usdc burned");
        assertEq(alice.balance, ethBefore + 1 ether, "eth received");
        assertEq(router.ethReserve(), ROUTER_ETH - 1 ether, "router paid from reserve");
    }

    function testSwapUSDCForETH_emitsEvent() public {
        vm.startPrank(alice);
        usdc.approve(address(router), 3_000e18);
        vm.expectEmit(true, false, false, true, address(router));
        emit SwapUsdcToEth(alice, 3_000e18, 1 ether, block.timestamp);
        router.swapUSDCForETH(3_000e18);
        vm.stopPrank();
    }

    function testSwapUSDCForETH_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(MockSwapRouter.MustSendUsdc.selector);
        router.swapUSDCForETH(0);
    }

    function testSwapUSDCForETH_revertsWithoutBalance() public {
        address broke = makeAddr("broke");
        vm.prank(broke);
        vm.expectRevert(MockSwapRouter.InsufficientUsdcBalance.selector);
        router.swapUSDCForETH(3_000e18);
    }

    /// @dev Balance is checked before allowance, so a funded user who forgot to
    ///      approve gets the allowance error rather than the balance one.
    function testSwapUSDCForETH_revertsWithoutAllowance() public {
        vm.prank(alice);
        vm.expectRevert(MockSwapRouter.InsufficientUsdcAllowance.selector);
        router.swapUSDCForETH(3_000e18);
    }

    function testSwapUSDCForETH_revertsWhenRouterEthIsShort() public {
        // 100k USDC would need 33.3 ETH; the router holds 10.
        uint256 amount = 100_000e18;
        vm.startPrank(alice);
        usdc.approve(address(router), amount);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.InsufficientEthInRouter.selector,
                amount / 3000,
                ROUTER_ETH
            )
        );
        router.swapUSDCForETH(amount);
        vm.stopPrank();
    }

    /// @dev Draining the router exactly is allowed; the next swap is not.
    function testSwapUSDCForETH_canDrainReserveThenRevert() public {
        uint256 all = ROUTER_ETH * 3000;   // exactly the router's ETH

        vm.startPrank(alice);
        usdc.approve(address(router), all + 3_000e18);
        router.swapUSDCForETH(all);
        assertEq(router.ethReserve(), 0, "reserve emptied");

        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.InsufficientEthInRouter.selector, 1 ether, 0)
        );
        router.swapUSDCForETH(3_000e18);
        vm.stopPrank();
    }

    /// @dev ethOut is integer division by RATE, so anything under 3000 wei of
    ///      USDC rounds to zero ETH — and the USDC is burned anyway. Pinned
    ///      because it is a real way to lose funds to rounding, not because it
    ///      is desirable. Amounts this small only occur at wei granularity;
    ///      1 whole mUSDC is 1e18 and rounds fine.
    function testSwapUSDCForETH_dustRoundsToZeroEthButStillBurns() public {
        uint256 dust = 2_999;              // wei-level, below one RATE unit
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        usdc.approve(address(router), dust);
        router.swapUSDCForETH(dust);
        vm.stopPrank();

        assertEq(alice.balance, ethBefore, "no ETH returned");
        assertEq(usdc.balanceOf(alice), 100_000e18 - dust, "USDC burned regardless");
    }

    // ── Previews ──────────────────────────────────────────────────────────────

    function testPreviewSwapEth_matchesActualSwap() public {
        uint256 quoted = router.previewSwapEth(1.5 ether);

        vm.prank(alice);
        router.swapETHForUSDC{value: 1.5 ether}();

        assertEq(quoted, 4_500e18, "quote");
        assertEq(usdc.balanceOf(alice) - 100_000e18, quoted, "quote matches fill");
    }

    function testPreviewSwapUsdc_matchesActualSwap() public {
        uint256 quoted = router.previewSwapUsdc(6_000e18);
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        usdc.approve(address(router), 6_000e18);
        router.swapUSDCForETH(6_000e18);
        vm.stopPrank();

        assertEq(quoted, 2 ether, "quote");
        assertEq(alice.balance - ethBefore, quoted, "quote matches fill");
    }

    // ── Funding ───────────────────────────────────────────────────────────────

    function testFundRouter_increasesReserve() public {
        router.fundRouter{value: 5 ether}();
        assertEq(router.ethReserve(), ROUTER_ETH + 5 ether, "funded");
    }

    /// @dev The bare receive() means a plain transfer tops the router up too.
    function testReceive_acceptsPlainTransfer() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok, "plain transfer accepted");
        assertEq(router.ethReserve(), ROUTER_ETH + 1 ether, "reserve grew");
    }

    /// @dev Anyone can fund it — there is no owner on this contract at all.
    function testFundRouter_isPermissionless() public {
        vm.prank(alice);
        router.fundRouter{value: 1 ether}();
        assertEq(router.ethReserve(), ROUTER_ETH + 1 ether, "funded by non-deployer");
    }

    // ── Round trip ────────────────────────────────────────────────────────────

    /// @dev A full round trip returns the original ETH: the rate is fixed and
    ///      there is no fee or spread on either leg.
    function testRoundTrip_returnsOriginalEth() public {
        uint256 ethBefore = alice.balance;

        vm.startPrank(alice);
        router.swapETHForUSDC{value: 2 ether}();
        usdc.approve(address(router), 6_000e18);
        router.swapUSDCForETH(6_000e18);
        vm.stopPrank();

        assertEq(alice.balance, ethBefore, "round trip is lossless");
        assertEq(usdc.balanceOf(alice), 100_000e18, "usdc back to start");
    }
}
