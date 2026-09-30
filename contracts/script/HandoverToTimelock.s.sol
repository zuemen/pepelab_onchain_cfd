// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

interface IOwnable130 {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @notice Moves protocol governance from the deployer EOA onto the
///         `TimelockController` from `DeployGovernance`.
///
///         Ownable (one-step OZ `Ownable`, effective immediately):
///           PerpetualExchange (#130), CopyTracker (#130), InsuranceVault,
///           FeeRouter, TraderStake, KYCRegistry  → owner = timelock
///         AccessControl (two-phase, below):
///           AssetVaultV2 proxy, GuardedOracle, ESGRegistryV2  → DEFAULT_ADMIN_ROLE = timelock
///         Optional (0x0 = skipped by default; runbook §1 says why):
///           EsgRewardDistributor, AssetVault V1 (Ownable), SustainabilityBadge (AccessControl)
///
///         NOT moved, on purpose (SEAL: a guardian can pause, never upgrade):
///           - exchange `guardian` / `marketOperator`, GuardedOracle
///             GUARDIAN_ROLE / KEEPER_ROLE, vault PAUSER_ROLE / RISK_ROLE —
///             hot wallets that must act in minutes, not after 48h;
///           - MockOracle (owner = keeper, it IS the price-posting key).
///
///         TWO PHASES — never collapse them:
///           HANDOVER_PHASE=1  transferOwnership(timelock) on every Ownable,
///                             grantRole(DEFAULT_ADMIN_ROLE, timelock) on the
///                             two AccessControl contracts, read every one back.
///           HANDOVER_PHASE=2  only after phase 1 is on chain and a real
///                             timelock proposal has been executed end-to-end
///                             (runbook §4): read back that the timelock holds
///                             admin, THEN the deployer renounces its admin.
///         Revoking before the grant is verified can leave an AccessControl
///         contract with no admin — unrecoverable, and the UUPS vault could
///         never be upgraded again.
///
///         Env:
///           TIMELOCK            (required) the DeployGovernance output
///           TIMELOCK_PROPOSER   (required) the Safe; cross-checked against the timelock
///           TIMELOCK_EXECUTOR   (required) the Safe; cross-checked against the timelock
///           EXCHANGE_NEW, COPYTRACKER_NEW (required) #130 outputs
///           INS_VAULT, FEE_ROUTER, TRADER_STAKE, KYC_REGISTRY, VAULT_PROXY,
///           GUARDED_ORACLE, ESG_REGISTRY_V2  defaults = Base Sepolia; 0x0…0 skips one
///           ESG_REWARD_DISTRIBUTOR, ASSET_VAULT_V1, SUSTAINABILITY_BADGE  default skipped
///           MIN_TIMELOCK_DELAY  default 24h — refuse a timelock with a shorter delay
/// @dev Shared by `HandoverToTimelock` and the read-only `VerifyHandover`,
///      so both walk exactly the same target list.
abstract contract HandoverTargets is Script {
    bytes32 internal constant ADMIN = 0x00;   // DEFAULT_ADMIN_ROLE

    address internal constant INS_VAULT      = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address internal constant FEE_ROUTER     = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address internal constant TRADER_STK     = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address internal constant KYC            = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address internal constant VAULT_PROXY    = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;
    address internal constant GUARDED_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;
    address internal constant ESG_REGISTRY_V2 = 0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf;

    struct Target { string name; address addr; }

    /// @dev Optional targets default to 0x0 (= skipped) — see
    ///      docs/GOVERNANCE_HANDOVER.md §1 for why each is held back by default.
    function _ownableTargets() internal view returns (Target[] memory t) {
        t = new Target[](8);
        t[0] = Target("PerpetualExchange", vm.envAddress("EXCHANGE_NEW"));
        t[1] = Target("CopyTracker",       vm.envAddress("COPYTRACKER_NEW"));
        t[2] = Target("InsuranceVault",    vm.envOr("INS_VAULT", INS_VAULT));
        t[3] = Target("FeeRouter",         vm.envOr("FEE_ROUTER", FEE_ROUTER));
        t[4] = Target("TraderStake",       vm.envOr("TRADER_STAKE", TRADER_STK));
        t[5] = Target("KYCRegistry",       vm.envOr("KYC_REGISTRY", KYC));
        t[6] = Target("EsgRewardDistributor (optional)", vm.envOr("ESG_REWARD_DISTRIBUTOR", address(0)));
        t[7] = Target("AssetVault V1 (optional)",        vm.envOr("ASSET_VAULT_V1", address(0)));
    }

    /// @dev Index 0 / 1 are read by `_reportHotRoles` — keep the order.
    function _accessControlTargets() internal view returns (Target[] memory t) {
        t = new Target[](4);
        t[0] = Target("AssetVaultV2 proxy", vm.envOr("VAULT_PROXY", VAULT_PROXY));
        t[1] = Target("GuardedOracle",      vm.envOr("GUARDED_ORACLE", GUARDED_ORACLE));
        t[2] = Target("ESGRegistryV2",      vm.envOr("ESG_REGISTRY_V2", ESG_REGISTRY_V2));
        t[3] = Target("SustainabilityBadge (optional)", vm.envOr("SUSTAINABILITY_BADGE", address(0)));
    }

    /// @dev One-step `transferOwnership` to a wrong address is unrecoverable,
    ///      so the target must provably be a TimelockController with a real
    ///      delay, our Safes as proposer AND executor, and no back door for
    ///      the deployer.
    function _checkTimelock(address timelock, address deployer) internal view {
        require(timelock.code.length > 0, "TIMELOCK has no code");
        TimelockController tl = TimelockController(payable(timelock));
        uint256 floor = vm.envOr("MIN_TIMELOCK_DELAY", uint256(24 hours));
        uint256 delay;
        try tl.getMinDelay() returns (uint256 d) { delay = d; } catch { revert("TIMELOCK is not a TimelockController"); }
        require(delay >= floor, "timelock minDelay below MIN_TIMELOCK_DELAY");
        address proposer = vm.envAddress("TIMELOCK_PROPOSER");
        address executor = vm.envAddress("TIMELOCK_EXECUTOR");
        require(tl.hasRole(tl.PROPOSER_ROLE(), proposer), "TIMELOCK_PROPOSER is not a proposer on TIMELOCK");
        require(tl.hasRole(tl.EXECUTOR_ROLE(), executor), "TIMELOCK_EXECUTOR is not an executor on TIMELOCK");
        require(!tl.hasRole(tl.PROPOSER_ROLE(), deployer), "deployer is a timelock proposer - no real delay");
        require(!tl.hasRole(ADMIN, deployer), "deployer administers the timelock - no real delay");
        console.log("timelock ok  :", timelock);
        console.log("  minDelay   :", delay);
        console.log("  proposer   :", proposer);
        console.log("  executor   :", executor);
    }
}

contract HandoverToTimelock is HandoverTargets {
    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    function run() external {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        uint256 phase = vm.envUint("HANDOVER_PHASE");
        require(phase == 1 || phase == 2, "HANDOVER_PHASE must be 1 or 2");

        address timelock = vm.envAddress("TIMELOCK");
        _checkTimelock(timelock, deployer);

        Target[] memory owned = _ownableTargets();
        Target[] memory acl   = _accessControlTargets();

        if (phase == 1) _phase1(deployer, timelock, owned, acl);
        else            _phase2(deployer, timelock, owned, acl);
    }

    // ── phase 1: grant ───────────────────────────────────────────────────

    function _phase1(address deployer, address timelock, Target[] memory owned, Target[] memory acl) internal {
        console.log("=== handover phase 1: transfer ownership + grant admin ===");
        bool[] memory doOwn = new bool[](owned.length);
        for (uint256 i = 0; i < owned.length; i++) {
            if (owned[i].addr == address(0)) { console.log("skip        ", owned[i].name); continue; }
            require(owned[i].addr.code.length > 0, string.concat(owned[i].name, " has no code"));
            address cur = IOwnable130(owned[i].addr).owner();
            if (cur == timelock) { console.log("already     ", owned[i].name); continue; }
            require(cur == deployer, string.concat(owned[i].name, ": broadcaster is not the owner"));
            doOwn[i] = true;
        }
        bool[] memory doAcl = new bool[](acl.length);
        for (uint256 i = 0; i < acl.length; i++) {
            if (acl[i].addr == address(0)) { console.log("skip        ", acl[i].name); continue; }
            IAccessControl a = IAccessControl(acl[i].addr);
            if (a.hasRole(ADMIN, timelock)) { console.log("already     ", acl[i].name); continue; }
            require(a.hasRole(ADMIN, deployer), string.concat(acl[i].name, ": broadcaster lacks DEFAULT_ADMIN_ROLE"));
            doAcl[i] = true;
        }

        vm.startBroadcast(deployer);
        for (uint256 i = 0; i < owned.length; i++) {
            if (doOwn[i]) IOwnable130(owned[i].addr).transferOwnership(timelock);
        }
        for (uint256 i = 0; i < acl.length; i++) {
            if (doAcl[i]) IAccessControl(acl[i].addr).grantRole(ADMIN, timelock);
        }
        vm.stopBroadcast();

        // Read back every one.
        for (uint256 i = 0; i < owned.length; i++) {
            if (owned[i].addr == address(0)) continue;
            require(IOwnable130(owned[i].addr).owner() == timelock, string.concat(owned[i].name, ": owner != timelock after transfer"));
            console.log("owner->TL   ", owned[i].name, owned[i].addr);
        }
        for (uint256 i = 0; i < acl.length; i++) {
            if (acl[i].addr == address(0)) continue;
            require(IAccessControl(acl[i].addr).hasRole(ADMIN, timelock), string.concat(acl[i].name, ": timelock lacks admin after grant"));
            console.log("admin+TL    ", acl[i].name, acl[i].addr);
        }
        console.log("");
        console.log("Phase 1 done. The deployer STILL holds DEFAULT_ADMIN on the vault / GuardedOracle.");
        console.log("Before phase 2: execute one real timelock proposal end-to-end (runbook sec.4).");
    }

    // ── phase 2: revoke the deployer's admin, after read-back ────────────

    function _phase2(address deployer, address timelock, Target[] memory owned, Target[] memory acl) internal {
        console.log("=== handover phase 2: deployer renounces DEFAULT_ADMIN_ROLE ===");
        for (uint256 i = 0; i < owned.length; i++) {
            if (owned[i].addr == address(0)) continue;
            require(IOwnable130(owned[i].addr).owner() == timelock, string.concat(owned[i].name, ": owner != timelock - run phase 1 first"));
        }
        bool[] memory doRevoke = new bool[](acl.length);
        for (uint256 i = 0; i < acl.length; i++) {
            if (acl[i].addr == address(0)) continue;
            IAccessControl a = IAccessControl(acl[i].addr);
            // THE guard: never drop our admin unless the timelock provably has it.
            require(a.hasRole(ADMIN, timelock), string.concat(acl[i].name, ": timelock lacks admin - refusing to revoke (would orphan the contract)"));
            doRevoke[i] = a.hasRole(ADMIN, deployer);
            if (!doRevoke[i]) console.log("already     ", acl[i].name);
        }

        vm.startBroadcast(deployer);
        for (uint256 i = 0; i < acl.length; i++) {
            if (doRevoke[i]) IAccessControl(acl[i].addr).renounceRole(ADMIN, deployer);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < acl.length; i++) {
            if (acl[i].addr == address(0)) continue;
            IAccessControl a = IAccessControl(acl[i].addr);
            require(!a.hasRole(ADMIN, deployer), string.concat(acl[i].name, ": deployer still admin"));
            require(a.hasRole(ADMIN, timelock), string.concat(acl[i].name, ": timelock lost admin"));
            console.log("admin=TL only", acl[i].name, acl[i].addr);
        }
        _reportHotRoles(deployer, acl);
        console.log("");
        console.log("Phase 2 done. Governance = timelock. Re-run Verify130 with EXPECTED_OWNER=<timelock>.");
    }

    /// @dev Hot roles intentionally left where they are — printed so the
    ///      operator sees who still holds them.
    function _reportHotRoles(address deployer, Target[] memory acl) internal view {
        bytes32 guardianRole = keccak256("GUARDIAN_ROLE");
        bytes32 pauserRole   = keccak256("PAUSER_ROLE");
        bytes32 riskRole     = keccak256("RISK_ROLE");
        if (acl[0].addr != address(0)) {
            console.log("vault PAUSER_ROLE held by deployer :", IAccessControl(acl[0].addr).hasRole(pauserRole, deployer));
            console.log("vault RISK_ROLE   held by deployer :", IAccessControl(acl[0].addr).hasRole(riskRole, deployer));
        }
        if (acl[1].addr != address(0)) {
            console.log("oracle GUARDIAN_ROLE held by deployer:", IAccessControl(acl[1].addr).hasRole(guardianRole, deployer));
        }
        console.log("(hot roles stay on hot wallets; move them with HandoverRoles.s.sol if needed)");
    }
}
