// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/MockUSDC.sol";

/// @notice The handover from a single deployer key to separated role holders.
///
///         The failure this guards against is unrecoverable: AccessControl has
///         no way back from zero admins. Nothing can grant a role again, the
///         vault's risk parameters freeze forever, and the UUPS proxy can never
///         be upgraded. So the ordering is tested, not just documented.
contract RoleHandoverTest is Test {
    GuardedOracle oracle;
    AssetVaultV2  vault;
    MockUSDC      usdc;

    address deployer = address(this);
    address multisig = makeAddr("multisig");
    address keeper   = makeAddr("hotKeeper");
    address guardian = makeAddr("guardian");
    address riskOps  = makeAddr("riskOps");

    bytes32 constant ADMIN = 0x00;
    bytes32 KEEPER_R;
    bytes32 GUARDIAN_R;
    bytes32 RISK_R;
    bytes32 PAUSER_R;

    bytes32 constant AID = keccak256("sBTC");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new GuardedOracle(deployer);

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), deployer))
        )));

        KEEPER_R   = oracle.KEEPER_ROLE();
        GUARDIAN_R = oracle.GUARDIAN_ROLE();
        RISK_R     = vault.RISK_ROLE();
        PAUSER_R   = vault.PAUSER_ROLE();

        // GuardedOracle's constructor deliberately grants only ADMIN and
        // GUARDIAN — keeper is least-privilege by default and must be granted
        // explicitly. The deploy script does exactly this, so mirror it here to
        // reproduce the state the live contract is actually in.
        oracle.grantRole(KEEPER_R, deployer);

        oracle.addAsset(AID, 100_000e8);
    }

    /// @dev The state the deployment is in today: one key holds everything.
    function test_startingStateIsOneKeyHoldsEverything() public view {
        assertTrue(oracle.hasRole(ADMIN, deployer));
        assertTrue(oracle.hasRole(KEEPER_R, deployer));
        assertTrue(oracle.hasRole(GUARDIAN_R, deployer));
        assertTrue(vault.hasRole(ADMIN, deployer));
        assertTrue(vault.hasRole(RISK_R, deployer));
        assertTrue(vault.hasRole(PAUSER_R, deployer));
    }

    function _handover(bool revokeDeployer) internal {
        // 1. grant
        oracle.grantRole(ADMIN, multisig);
        oracle.grantRole(KEEPER_R, keeper);
        oracle.grantRole(GUARDIAN_R, guardian);
        vault.grantRole(ADMIN, multisig);
        vault.grantRole(RISK_R, riskOps);
        vault.grantRole(PAUSER_R, guardian);

        // 2. verify before touching anything
        require(oracle.hasRole(ADMIN, multisig), "oracle admin not granted");
        require(vault.hasRole(ADMIN, multisig), "vault admin not granted");

        // 3. revoke, admin last
        if (revokeDeployer) {
            oracle.revokeRole(KEEPER_R, deployer);
            oracle.revokeRole(GUARDIAN_R, deployer);
            vault.revokeRole(RISK_R, deployer);
            vault.revokeRole(PAUSER_R, deployer);
            oracle.revokeRole(ADMIN, deployer);
            vault.revokeRole(ADMIN, deployer);
        }
    }

    // ── the property that matters ────────────────────────────────────────────

    function test_handoverLeavesExactlyOneAdminAndItIsTheMultisig() public {
        _handover(true);

        assertTrue(oracle.hasRole(ADMIN, multisig));
        assertFalse(oracle.hasRole(ADMIN, deployer));
        assertTrue(vault.hasRole(ADMIN, multisig));
        assertFalse(vault.hasRole(ADMIN, deployer));
    }

    /// @dev After handover the deployer key is inert. If it leaks later, it
    ///      buys the attacker nothing.
    function test_deployerIsPowerlessAfterHandover() public {
        _handover(true);

        vm.startPrank(deployer);
        vm.expectRevert();
        oracle.setRiskParams(5_000, 1 hours);
        vm.expectRevert();
        oracle.updatePrice(AID, 101_000e8);
        vm.expectRevert();
        oracle.setAssetFrozen(AID, true);
        vm.expectRevert();
        vault.setAssetCap(AID, 1e18);
        vm.expectRevert();
        vault.setOracle(address(0xdead));
        vm.stopPrank();
    }

    /// @dev The separation is the point: a leaked KEEPER key must not be able to
    ///      widen the caps that constrain it.
    function test_keeperCannotRetuneTheCapsThatBindIt() public {
        _handover(true);

        vm.startPrank(keeper);
        oracle.updatePrice(AID, 105_000e8);          // its actual job works
        vm.expectRevert();
        oracle.setRiskParams(5_000, 1 hours);        // but it cannot loosen them
        vm.expectRevert();
        oracle.grantRole(KEEPER_R, address(0xbad));  // nor add accomplices
        vm.stopPrank();
    }

    function test_guardianCanHaltButNotPrice() public {
        _handover(true);

        vm.startPrank(guardian);
        oracle.setPaused(true);
        vault.pause();
        vm.expectRevert();
        oracle.updatePrice(AID, 101_000e8);
        vm.stopPrank();
    }

    function test_riskOpsCanTuneVaultButNotUpgradeIt() public {
        _handover(true);

        vm.startPrank(riskOps);
        vault.setAssetCap(AID, 500e18);
        vault.setRiskParams(50, 50, 12_000, 2 hours);
        vm.expectRevert();
        vault.setOracle(address(0xdead));            // admin-only
        vm.stopPrank();

        assertEq(vault.assetCap(AID), 500e18);
    }

    /// @dev The multisig retains full control, so nothing is stranded.
    function test_multisigRetainsFullControl() public {
        _handover(true);

        vm.startPrank(multisig);
        oracle.setRiskParams(500, 30 minutes);
        vault.setOracle(address(oracle));
        oracle.grantRole(KEEPER_R, makeAddr("secondKeeper"));
        vm.stopPrank();

        assertEq(oracle.maxDeviationBps(), 500);
    }

    // ── why the ordering is not negotiable ───────────────────────────────────

    /// @dev Revoking before granting bricks the contract permanently. Kept as a
    ///      test so the risk is demonstrable rather than a warning in a comment
    ///      — this is what the script's verify-then-revoke ordering prevents.
    function test_revokingBeforeGrantingBricksTheContractForever() public {
        GuardedOracle lonely = new GuardedOracle(deployer);
        lonely.renounceRole(ADMIN, deployer);        // the mistake

        assertFalse(lonely.hasRole(ADMIN, deployer));

        // Nobody can ever grant a role again — not the deployer, not anyone.
        vm.expectRevert();
        lonely.grantRole(KEEPER_R, keeper);

        vm.prank(multisig);
        vm.expectRevert();
        lonely.grantRole(ADMIN, multisig);

        // And its parameters are frozen for good.
        vm.expectRevert();
        lonely.setRiskParams(500, 1 hours);
    }

    /// @dev A vault bricked this way could never be upgraded either, which for
    ///      a UUPS proxy means bugs become permanent.
    function test_brickedVaultCanNeverBeUpgraded() public {
        AssetVaultV2 impl = new AssetVaultV2();
        AssetVaultV2 lonely = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), deployer))
        )));
        lonely.renounceRole(ADMIN, deployer);

        AssetVaultV2 next = new AssetVaultV2();
        vm.expectRevert();
        lonely.upgradeToAndCall(address(next), "");
    }

    /// @dev Granting is idempotent, so a re-run after a partial failure is safe.
    function test_handoverIsIdempotent() public {
        _handover(false);
        _handover(false);   // must not revert
        assertTrue(oracle.hasRole(ADMIN, multisig));
    }

    /// @dev Staged rollout: grant now, revoke later once the new keys are known
    ///      good. Both keys work in the interim.
    function test_stagedHandoverKeepsBothWorkingUntilRevoke() public {
        _handover(false);

        vm.prank(keeper);
        oracle.updatePrice(AID, 103_000e8);
        vm.prank(deployer);
        oracle.updatePrice(AID, 104_000e8);

        assertTrue(oracle.hasRole(ADMIN, deployer));
        assertTrue(oracle.hasRole(ADMIN, multisig));
    }
}
