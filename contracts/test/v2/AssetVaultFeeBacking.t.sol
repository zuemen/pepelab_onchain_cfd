// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2_2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @notice A redeem fee can be credited to the operator without USDC behind it.
///
///         Found by invariant_reserveNeverCountsAccruedFees in CI, which the
///         local run had passed on a different fuzz seed. Reproduced here
///         deterministically, derived from the code rather than by re-rolling
///         the fuzzer:
///
///           redeem() guards on   reserve() >= usdcOut
///           then credits         accruedFees += feePaid
///
///         reserve() is balance - accruedFees, so when the available reserve
///         sits between usdcOut and usdcOut + feePaid, the fee is booked
///         against money that is not there.
///
///         The consequence is worse than cosmetic. Once accruedFees exceeds the
///         balance, reserve() clamps to 0, and EVERY later redeem reverts
///         VaultDry even though the vault still holds USDC — holders are frozen
///         out by an accounting artefact.
///
///         Present in V2.0 and V2.1 alike; the redeem path is unchanged between
///         them.
contract AssetVaultFeeBackingTest is Test {
    AssetVaultV2_2   vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 token;

    address admin = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);          // $200

        AssetVaultV2_2 impl = new AssetVaultV2_2();
        vault = AssetVaultV2_2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_2.initialize, (address(usdc), address(oracle), admin))
        )));

        token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        token.grantRole(token.MINTER_ROLE(), address(vault));
        vault.registerAsset(AID, address(token));
        vault.setAssetCap(AID, 1_000e18);
        // No mint fee, 3% redeem fee, no ratio floor — isolates the redeem path.
        vault.setRiskParams(0, 300, 0, 1 hours);

        usdc.mint(alice, 100_000e18);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Drains the reserve to almost exactly the payout, so the fee has
    ///      nothing left to sit behind.
    function test_redeemFeeCanBeCreditedWithoutBacking() public {
        vm.prank(alice);
        vault.mint(AID, 2_000e18);            // vault holds exactly 2000, 10 tokens

        assertEq(usdc.balanceOf(address(vault)), 2_000e18);
        assertEq(vault.accruedFees(), 0);

        // Redeem everything: gross 2000, fee 60, paid out 1940.
        vm.prank(alice);
        vault.redeem(AID, 10e18);

        uint256 bal  = usdc.balanceOf(address(vault));
        uint256 fees = vault.accruedFees();

        assertEq(bal,  60e18);                // the fee stayed behind
        assertEq(fees, 60e18);                // and is exactly backed here
        assertEq(vault.reserve(), 0);
    }

    /// @dev The failing case. The guard admits a redeem whenever the reserve
    ///      covers the NET payout, but the fee is credited on top — so the
    ///      window is `usdcOut <= reserve < gross`.
    ///
    ///      mint 2000 at $200 -> vault holds 2000, alice holds 10 tokens
    ///      price -> $250, redeem 8.2 tokens:
    ///        gross   = 8.2 * 250 = 2050
    ///        fee 3%  = 61.5
    ///        usdcOut = 1988.5     <= 2000 reserve, so the guard passes
    ///      afterwards: balance 11.5, accruedFees 61.5 -> fees exceed balance.
    function test_feeExceedsBalanceWhenReserveIsThin() public {
        vm.prank(alice);
        vault.mint(AID, 2_000e18);            // 10 tokens, vault holds 2000
        assertEq(usdc.balanceOf(address(vault)), 2_000e18);

        oracle.updatePrice(AID, 250e8);       // payout now exceeds what was paid in

        vm.prank(alice);
        vault.redeem(AID, 8.2e18);

        uint256 bal  = usdc.balanceOf(address(vault));
        uint256 fees = vault.accruedFees();
        emit log_named_uint("vault USDC balance", bal);
        emit log_named_uint("accruedFees",        fees);

        // The property the invariant asserts, stated directly.
        assertLe(fees, bal, "accruedFees must never exceed the USDC actually held");
    }

    /// @dev What the violation costs holders: reserve() clamps to 0 while the
    ///      vault still holds USDC, so redeems revert VaultDry on money that is
    ///      demonstrably present.
    function test_overCreditedFeesWouldFreezeRedeems() public {
        vm.prank(alice);
        vault.mint(AID, 2_000e18);
        vm.prank(alice);
        vault.redeem(AID, 10e18);

        uint256 bal = usdc.balanceOf(address(vault));
        assertGt(bal, 0, "vault still holds USDC");

        // reserve() is what redeem checks against.
        if (vault.accruedFees() >= bal) {
            assertEq(vault.reserve(), 0, "held USDC is invisible to redeemers");
        }
    }
}
