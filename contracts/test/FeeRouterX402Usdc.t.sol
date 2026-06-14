// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";

/// @notice 6-decimal token mimicking Circle's official Base Sepolia USDC, so the
///         x402 revenue router can be tested in the *real settlement currency*.
contract USDC6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice A0: a dedicated FeeRouter + InsuranceVault bound to 6-dec USDC (the
///         token x402 actually settles in) routes 70/20/10 correctly — proving
///         the accounting is currency/decimals-agnostic and the deploy pattern
///         in DeployX402Router.s.sol is sound, isolated from the MockUSDC engine.
contract FeeRouterX402UsdcTest is Test {
    USDC6          usdc;   // 6-dec, like official Base Sepolia USDC
    FeeRouter      router;
    InsuranceVault vault;

    address treasury = makeAddr("treasury");
    address trader   = makeAddr("trader");
    address payer    = makeAddr("payer"); // x402 settlement EOA

    function setUp() public {
        usdc   = new USDC6();
        vault  = new InsuranceVault(address(usdc));
        router = new FeeRouter(address(usdc), treasury, address(vault));
        vault.setFeeRouter(address(router)); // gate depositFromProtocol to the router
    }

    function test_routeExternalRevenue_6dec_splits70_20_10() public {
        // Agent paid $1.00 in official USDC (6-dec → 1_000_000).
        uint256 fee = 1_000_000;
        usdc.mint(payer, fee);
        vm.prank(payer); usdc.approve(address(router), fee);

        vm.prank(payer);
        router.routeExternalRevenue(trader, fee);

        // 70 / 20 / 10 in 6-dec atomic units.
        assertEq(router.traderEarnings(trader), 700_000);
        assertEq(router.platformEarnings(),     200_000);
        assertEq(vault.totalAssets(),           100_000);
        // The router holds trader+platform shares (vault share already pulled out).
        assertEq(usdc.balanceOf(address(router)), 900_000);
        assertEq(usdc.balanceOf(address(vault)),  100_000);
    }

    function test_traderWithdraw_6dec() public {
        uint256 fee = 5_000_000; // $5
        usdc.mint(payer, fee);
        vm.prank(payer); usdc.approve(address(router), fee);
        vm.prank(payer); router.routeExternalRevenue(trader, fee);

        uint256 owed = router.traderEarnings(trader); // 3_500_000
        assertEq(owed, 3_500_000);
        vm.prank(trader);
        router.withdrawTraderEarnings();
        assertEq(usdc.balanceOf(trader), 3_500_000);
        assertEq(router.traderEarnings(trader), 0);
    }

    function test_platformWithdraw_6dec() public {
        uint256 fee = 1_000_000;
        usdc.mint(payer, fee);
        vm.prank(payer); usdc.approve(address(router), fee);
        vm.prank(payer); router.routeExternalRevenue(trader, fee);

        vm.prank(treasury);
        router.withdrawPlatformFees();
        assertEq(usdc.balanceOf(treasury), 200_000);
    }

    function test_isolatedFromEngine_differentUsdc() public view {
        // The x402 router's USDC is the 6-dec official token, independent of any
        // 18-dec MockUSDC perp-engine router.
        assertEq(usdc.decimals(), 6);
        assertEq(address(router.usdc()), address(usdc));
        assertEq(address(vault.usdc()), address(usdc));
    }

    // ── the misconfig must fail LOUDLY (review finding) ─────────────────────────

    function test_currencyMismatch_revertsLoudly() public {
        // A FeeRouter on USDC6 but whose vault is bound to a DIFFERENT token
        // (the classic .env footgun: settle official USDC through a router whose
        // vault expects another token). routeExternalRevenue must revert at the
        // vault's depositFromProtocol — never silently corrupt accounting.
        USDC6 otherToken = new USDC6(); // stands in for a mismatched token
        InsuranceVault mismatchedVault = new InsuranceVault(address(otherToken));
        FeeRouter badRouter = new FeeRouter(address(usdc), treasury, address(mismatchedVault));
        mismatchedVault.setFeeRouter(address(badRouter));

        uint256 fee = 1_000_000;
        usdc.mint(payer, fee);
        vm.prank(payer); usdc.approve(address(badRouter), fee);

        // _split pulls fee in `usdc`, then tries vault.depositFromProtocol which
        // transferFrom's `otherToken` from the router (balance 0) → revert.
        vm.prank(payer);
        vm.expectRevert();
        badRouter.routeExternalRevenue(trader, fee);
    }
}
