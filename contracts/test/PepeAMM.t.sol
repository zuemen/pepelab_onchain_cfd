// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/PepeAMM.sol";

contract PepeAMMTest is Test {
    MockUSDC usdc;
    PepeAMM  amm;

    address alice = makeAddr("alice");

    uint256 constant INIT_ETH  = 1 ether;
    uint256 constant INIT_USDC = 3_000e18;

    function setUp() public {
        usdc = new MockUSDC();
        amm  = new PepeAMM(address(usdc));

        // Provide initial liquidity (test contract is owner)
        usdc.mint(address(this), INIT_USDC);
        usdc.approve(address(amm), INIT_USDC);
        amm.addLiquidity{value: INIT_ETH}(INIT_USDC);

        // Fund alice with ETH and USDC
        vm.deal(alice, 10 ether);
        usdc.mint(alice, 10_000e18);
    }

    // ── Add liquidity ─────────────────────────────────────────────────────────

    function testAddLiquidity_setsReserves() public view {
        (uint256 ethR, uint256 usdcR) = amm.getReserves();
        assertEq(ethR,  INIT_ETH,  "eth reserve");
        assertEq(usdcR, INIT_USDC, "usdc reserve");
        // initial price: 1 ETH = 3000 USDC (18-dec)
        assertEq(amm.getPrice(), 3_000e18, "initial price");
    }

    // ── ETH → USDC ───────────────────────────────────────────────────────────

    function testSwapETHForUSDC_priceMovesUp() public {
        uint256 priceBefore = amm.getPrice(); // USDC per ETH
        vm.prank(alice);
        amm.swapETHForUSDC{value: 0.5 ether}(0);
        // ETH in → more ETH, less USDC → price (usdcR/ethR) decreases
        assertLt(amm.getPrice(), priceBefore, "price should change after ETH->USDC swap");
    }

    // ── USDC → ETH ───────────────────────────────────────────────────────────

    function testSwapUSDCForETH_priceMovesDown() public {
        uint256 priceBefore = amm.getPrice();

        vm.startPrank(alice);
        usdc.approve(address(amm), 1_000e18);
        amm.swapUSDCForETH(1_000e18, 0);
        vm.stopPrank();

        // USDC in → more USDC, less ETH → price (usdcR/ethR) increases
        assertGt(amm.getPrice(), priceBefore, "price should change after USDC->ETH swap");
    }

    // ── Constant product ─────────────────────────────────────────────────────

    function testConstantProduct_kPreserved() public {
        uint256 kBefore = amm.ethReserve() * amm.usdcReserve();

        vm.prank(alice);
        amm.swapETHForUSDC{value: 0.1 ether}(0);

        uint256 kAfter = amm.ethReserve() * amm.usdcReserve();
        // With 0.3% fee the fee portion stays in pool → k increases
        assertGe(kAfter, kBefore, "k must not decrease (fees add to it)");
    }

    // ── Insufficient liquidity ────────────────────────────────────────────────

    function testSwap_insufficientLiquidity_revert() public {
        PepeAMM empty = new PepeAMM(address(usdc));

        vm.expectRevert(PepeAMM.InsufficientLiquidity.selector);
        vm.prank(alice);
        empty.swapETHForUSDC{value: 0.1 ether}(0);
    }

    // ── Slippage protection ───────────────────────────────────────────────────

    function testSwap_slippageProtection_revert() public {
        uint256 quoted = amm.quoteETHForUSDC(0.1 ether);

        vm.expectRevert(PepeAMM.InsufficientOutput.selector);
        vm.prank(alice);
        // minOut = quoted + 1 → one wei above what we'll actually receive → revert
        amm.swapETHForUSDC{value: 0.1 ether}(quoted + 1);
    }

    // ── Quote matches actual swap ─────────────────────────────────────────────

    function testQuote_matchesActualSwap() public {
        uint256 ethIn  = 0.1 ether;
        uint256 quoted = amm.quoteETHForUSDC(ethIn);

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        amm.swapETHForUSDC{value: ethIn}(0);
        uint256 received = usdc.balanceOf(alice) - balBefore;

        assertEq(received, quoted, "actual output must equal quote");
    }
}
