// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";

/// @notice G2: RWA market listing + KYC gating at open time. Uses the real
///         KYCRegistry (isVerified) wired into PerpetualExchange via the standard
///         onlyOwner setter convention.
contract RwaKycGatingTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;
    KYCRegistry       kyc;

    address alice = makeAddr("alice"); // not KYC'd
    address bob   = makeAddr("bob");   // KYC'd

    bytes32 constant XAU = keccak256("XAU"); // RWA (gold)
    bytes32 constant BTC = keccak256("BTC"); // crypto (not RWA)

    uint256 constant XAU_PRICE = 2_650e8;
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        kyc      = new KYCRegistry();

        oracle.addAsset(XAU, XAU_PRICE);
        oracle.addAsset(BTC, BTC_PRICE);

        // Wire KYC registry + flag XAU as an RWA market (both onlyOwner setters).
        exchange.setKycRegistry(address(kyc));
        exchange.setRwaAsset(XAU, true);

        usdc.mint(alice, 100_000e18);
        usdc.mint(bob,   100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);

        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        vm.prank(alice); exchange.depositMargin(1_000e18);
        vm.prank(bob);   exchange.depositMargin(1_000e18);

        // bob completes (mock) KYC; alice does not.
        vm.prank(bob); kyc.submitKYC("Bob", "TW");
    }

    // ── config setters ─────────────────────────────────────────────────────────

    function test_setRwaAsset_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        exchange.setRwaAsset(BTC, true);
    }

    function test_setKycRegistry_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        exchange.setKycRegistry(address(0));
    }

    function test_flagsSet() public view {
        assertTrue(exchange.rwaAsset(XAU));
        assertFalse(exchange.rwaAsset(BTC));
        assertEq(address(exchange.kyc()), address(kyc));
    }

    // ── gating behaviour ────────────────────────────────────────────────────────

    function test_unverifiedCannotOpenRwa() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, alice));
        exchange.openPosition(XAU, true, 100e18, 2);
    }

    function test_verifiedCanOpenRwa() public {
        vm.prank(bob);
        uint256 pid = exchange.openPosition(XAU, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).owner, bob);
    }

    function test_nonRwaUnaffected_unverifiedCanOpenCrypto() public {
        // alice is NOT KYC'd but BTC is not an RWA → must succeed (regression).
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).owner, alice);
    }

    function test_noKycRegistry_rwaUngated() public {
        // Clearing the registry disables gating even for flagged RWA assets.
        exchange.setKycRegistry(address(0));
        vm.prank(alice);
        uint256 pid = exchange.openPosition(XAU, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).owner, alice);
    }
}
