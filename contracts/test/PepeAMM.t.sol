// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/PepeAMM.sol";

contract PepeAMMTest is Test {
    MockUSDC  usdc;
    MockOracle oracle;
    PepeAMM   amm;

    address alice = makeAddr("alice");

    uint256 constant INIT_ETH  = 1 ether;
    uint256 constant INIT_USDC = 3_000e18;
    bytes32 constant ETH_ASSET_ID = 0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        // Register ETH in oracle with initial price of 3000 USD (8-dec)
        oracle.addAsset(ETH_ASSET_ID, 3_000 * 1e8);

        amm = new PepeAMM(address(usdc), address(oracle));

        // Provide initial reserves (test contract is owner)
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
        // Pool spot price = reserve ratio = 3000 mUSDC per ETH (18-dec), which
        // happens to equal the oracle here because the pool was seeded at par.
        assertEq(amm.getPrice(), 3_000e18, "pool spot price");
    }

    // ── ETH → USDC ───────────────────────────────────────────────────────────

    /// @dev REPLACES `testSwapETHForUSDC_priceRemainsUnchanged`.
    ///
    ///      The old assertion (`assertEq(amm.getPrice(), priceBefore)`) pinned
    ///      PA-1 as if it were the specification: it asserted that buying out of
    ///      the pool does NOT move the price, i.e. zero slippage. That is the
    ///      vulnerability — with no slippage an arbitrageur can round-trip the
    ///      pool against a one-tick-stale oracle for free and repeat until the
    ///      reserves are gone. A constant-product pool MUST move its price when
    ///      inventory moves, so the correct assertion is the opposite one.
    function testSwapETHForUSDC_movesPriceDown() public {
        uint256 priceBefore = amm.getPrice();

        vm.prank(alice);
        amm.swapETHForUSDC{value: 0.05 ether}(0);

        uint256 priceAfter = amm.getPrice();
        assertLt(priceAfter, priceBefore, "buying USDC out must cheapen ETH in the pool");
        // k is preserved up to the fee, which accrues to the pool.
        (uint256 ethR, uint256 usdcR) = amm.getReserves();
        assertGe(ethR * usdcR, INIT_ETH * INIT_USDC, "k never decreases");
    }

    // ── USDC → ETH ───────────────────────────────────────────────────────────

    /// @dev REPLACES `testSwapUSDCForETH_priceRemainsUnchanged` — same reason.
    function testSwapUSDCForETH_movesPriceUp() public {
        uint256 priceBefore = amm.getPrice();

        vm.startPrank(alice);
        usdc.approve(address(amm), 150e18);
        amm.swapUSDCForETH(150e18, 0);
        vm.stopPrank();

        uint256 priceAfter = amm.getPrice();
        assertGt(priceAfter, priceBefore, "buying ETH out must richen ETH in the pool");
        (uint256 ethR, uint256 usdcR) = amm.getReserves();
        assertGe(ethR * usdcR, INIT_ETH * INIT_USDC, "k never decreases");
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
