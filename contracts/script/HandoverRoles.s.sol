// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Moves GuardedOracle and AssetVaultV2 off a single deployer key onto
///         separated role holders, without ever leaving a contract unowned.
///
///         Both contracts were deployed with admin, operational, and guardian
///         roles all held by the deployer. That means the deviation caps bound
///         a compromised KEEPER key but not a compromised ADMIN key — admin can
///         retune the caps, swap the reference source, or grant itself keeper.
///         This separates them.
///
///         THE ORDER MATTERS AND IS NOT NEGOTIABLE:
///           1. grant every new holder
///           2. read the roles back and assert they took effect
///           3. only then revoke the deployer
///
///         Doing it the other way round — revoking first, or revoking without
///         verifying — can leave a contract with no admin. AccessControl has no
///         recovery from that: nothing can ever grant a role again, the vault's
///         risk params freeze permanently, and an upgradeable proxy can never be
///         upgraded. The verification step below is what makes that impossible.
///
///         Run in two passes so a mistake is cheap:
///           HANDOVER_DRY_RUN=true  forge script ... (no broadcast, prints plan)
///           HANDOVER_DRY_RUN=false forge script ... --broadcast
///
///         Env:
///           GUARDED_ORACLE, ASSET_VAULT   deployed addresses
///           NEW_ADMIN                     multisig (ideally behind a timelock)
///           NEW_KEEPER                    hot key that posts prices
///           NEW_GUARDIAN                  key that can freeze/pause
///           NEW_RISK                      key that sets vault risk params
///           REVOKE_DEPLOYER               "true" to drop the deployer's roles
contract HandoverRoles is Script {
    bytes32 constant ADMIN_ROLE    = 0x00;                       // DEFAULT_ADMIN_ROLE
    bytes32 constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 constant RISK_ROLE     = keccak256("RISK_ROLE");
    bytes32 constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");

    error RoleNotGranted(address target, bytes32 role, address account);
    error WouldLeaveNoAdmin(address target);
    error MissingParam(string name);

    function run() external {
        address oracle = vm.envAddress("GUARDED_ORACLE");
        address vault  = vm.envAddress("ASSET_VAULT");

        address newAdmin    = vm.envAddress("NEW_ADMIN");
        address newKeeper   = vm.envAddress("NEW_KEEPER");
        address newGuardian = vm.envAddress("NEW_GUARDIAN");
        address newRisk     = vm.envAddress("NEW_RISK");

        bool dryRun  = vm.envOr("HANDOVER_DRY_RUN", true);
        bool revoke  = vm.envOr("REVOKE_DEPLOYER", false);
        address self = msg.sender;

        if (newAdmin == address(0)) revert MissingParam("NEW_ADMIN");
        if (newAdmin == self) revert MissingParam("NEW_ADMIN must differ from deployer");

        console.log("=== plan ===");
        console.log("deployer   :", self);
        console.log("new admin  :", newAdmin);
        console.log("new keeper :", newKeeper);
        console.log("new guard  :", newGuardian);
        console.log("new risk   :", newRisk);
        console.log("revoke deployer:", revoke);
        console.log("dry run    :", dryRun);

        if (dryRun) {
            console.log("");
            console.log("Dry run only - nothing sent. Re-run with HANDOVER_DRY_RUN=false --broadcast.");
            return;
        }

        vm.startBroadcast();

        // ── 1. grant ─────────────────────────────────────────────────────────
        _grant(oracle, ADMIN_ROLE,    newAdmin);
        _grant(oracle, KEEPER_ROLE,   newKeeper);
        _grant(oracle, GUARDIAN_ROLE, newGuardian);

        _grant(vault,  ADMIN_ROLE,  newAdmin);
        _grant(vault,  RISK_ROLE,   newRisk);
        _grant(vault,  PAUSER_ROLE, newGuardian);

        // ── 2. verify BEFORE revoking anything ───────────────────────────────
        _require(oracle, ADMIN_ROLE,    newAdmin);
        _require(oracle, KEEPER_ROLE,   newKeeper);
        _require(oracle, GUARDIAN_ROLE, newGuardian);
        _require(vault,  ADMIN_ROLE,    newAdmin);
        _require(vault,  RISK_ROLE,     newRisk);
        _require(vault,  PAUSER_ROLE,   newGuardian);
        console.log("all grants verified on chain");

        // ── 3. revoke the deployer, admin last ───────────────────────────────
        if (revoke) {
            _revoke(oracle, KEEPER_ROLE,   self);
            _revoke(oracle, GUARDIAN_ROLE, self);
            _revoke(vault,  RISK_ROLE,     self);
            _revoke(vault,  PAUSER_ROLE,   self);

            // Admin is dropped only once the replacement is confirmed, and the
            // check is re-read here rather than trusted from above.
            if (!IAccessControl(oracle).hasRole(ADMIN_ROLE, newAdmin)) revert WouldLeaveNoAdmin(oracle);
            _revoke(oracle, ADMIN_ROLE, self);

            if (!IAccessControl(vault).hasRole(ADMIN_ROLE, newAdmin)) revert WouldLeaveNoAdmin(vault);
            _revoke(vault, ADMIN_ROLE, self);

            console.log("deployer roles revoked");
        } else {
            console.log("REVOKE_DEPLOYER=false - deployer keeps its roles.");
            console.log("Exercise the new keys first, then re-run with REVOKE_DEPLOYER=true.");
        }

        vm.stopBroadcast();
    }

    function _grant(address target, bytes32 role, address account) internal {
        if (account == address(0)) return;                 // role left unassigned on purpose
        if (IAccessControl(target).hasRole(role, account)) return;   // idempotent
        IAccessControl(target).grantRole(role, account);
    }

    function _revoke(address target, bytes32 role, address account) internal {
        if (!IAccessControl(target).hasRole(role, account)) return;
        IAccessControl(target).revokeRole(role, account);
    }

    function _require(address target, bytes32 role, address account) internal view {
        if (account == address(0)) return;
        if (!IAccessControl(target).hasRole(role, account)) {
            revert RoleNotGranted(target, role, account);
        }
    }
}
