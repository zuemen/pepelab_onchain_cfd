// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";

interface IOwnableLike {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @notice S1 / P0-1 — move every `Ownable` contract off the deployer key that
///         was committed to a public repository.
///
///         The companion runbook is `docs/RUNBOOK_KEY_ROTATION.md`; this script
///         is the mechanised version of its §4, and it deliberately covers more
///         contracts than the four the runbook lists, because the audit's list
///         was "the four whose owner was checked on chain", not "the four that
///         have an owner".
///
///         ## What it does
///
///         For each address supplied through env, in order:
///           1. read `owner()` and print it;
///           2. if the owner is already `NEW_OWNER`, SKIP — so the script is
///              re-runnable after a partial failure, which is the state you are
///              most likely to be in when a rotation goes wrong;
///           3. if the owner is neither `NEW_OWNER` nor the caller, SKIP with a
///              warning rather than reverting, because one contract owned by a
///              third party must not stop the other twelve from moving;
///           4. otherwise `transferOwnership(NEW_OWNER)`;
///           5. read `owner()` back and print it again.
///
///         Every step prints before and after, so the console transcript is
///         itself the verification artifact.
///
///         ## Ownable vs Ownable2Step
///
///         Checked against `contracts/src/` on 2026-08-06: **every one of these
///         contracts inherits OpenZeppelin `Ownable`, not `Ownable2Step`.**
///         `transferOwnership` is therefore final and immediate — there is no
///         `acceptOwnership()` to follow up with, and a typo in `NEW_OWNER` is
///         unrecoverable.
///
///         The script does not take that on faith. It probes `pendingOwner()` on
///         each target after the transfer; if the call succeeds, the contract IS
///         two-step, the transfer was only a nomination, and the script says so
///         loudly and records that the new owner still has to call
///         `acceptOwnership()`. That probe costs one static call and removes an
///         assumption that would otherwise silently be wrong the first time
///         somebody swaps a base class.
///
///         ## Keys
///
///         No private key appears in this file and none may be added. Sign with
///         `--account <keystore>` (preferred), `--ledger`, or `--interactive`.
///         `--private-key` on the command line puts the key in your shell
///         history; that is exactly how this incident started.
///
///         ## Usage
///
///           export NEW_OWNER=0x…
///           export EXCHANGE=0x… MOCKUSDC=0x… MOCKORACLE=0x… PEPETOKEN=0x…
///           export INSVAULT=0x… FEEROUTER=0x… KYCREGISTRY=0x…
///           # optional, same treatment:
///           export TRADERSTAKE=0x… COPYTRACKER=0x… MOCKUSDT=0x… PEPEAMM=0x…
///           export PEPESTAKING=0x… PEPEINCENTIVES=0x… PEPECLAIM=0x…
///           export ESGREGISTRY=0x… ASSETVAULT=0x…
///           export CHAINLINK_ADAPTER=0x… PYTH_ADAPTER=0x… AGGREGATOR_ORACLE=0x…
///
///           # 1. look first — reads only, sends nothing
///           DRY_RUN=true forge script script/RotateOwnership.s.sol:RotateOwnership \
///             --rpc-url https://sepolia.base.org -vvv
///
///           # 2. then do it
///           forge script script/RotateOwnership.s.sol:RotateOwnership \
///             --rpc-url https://sepolia.base.org --broadcast --account old-deployer -vvv
///
///         Unset variables are simply not visited, so the same script serves a
///         partial rotation and a full one.
///
/// @dev    Ownership transfer does NOT change contract addresses, so
///         `frontend/src/contracts/addresses.ts` needs no edit for this step.
///         What it does NOT cover, because they are AccessControl and not
///         Ownable: `v2/GuardedOracle` and `v2/AssetVaultV2*`. Use
///         `HandoverRoles.s.sol` for those. Nor does it move balances or revoke
///         agent authorizations — runbook §5 and §6.
contract RotateOwnership is Script {
    uint256 constant MAX_TARGETS = 22;

    struct Target {
        string  name;
        address addr;
    }

    error NewOwnerNotSet();
    error NewOwnerIsCaller();

    function run() external {
        address newOwner = vm.envAddress("NEW_OWNER");
        bool    dryRun   = vm.envOr("DRY_RUN", false);
        address caller   = msg.sender;

        if (newOwner == address(0)) revert NewOwnerNotSet();
        if (newOwner == caller) revert NewOwnerIsCaller();

        Target[] memory targets = _targets();

        console.log("=== ownership rotation ===");
        console.log("signer (old owner):", caller);
        console.log("NEW_OWNER         :", newOwner);
        console.log("dry run           :", dryRun);
        console.log("targets supplied  :", targets.length);
        console.log("");

        if (targets.length == 0) {
            console.log("No target addresses in env - nothing to do.");
            console.log("Set EXCHANGE / MOCKUSDC / PEPETOKEN / INSVAULT / ... and re-run.");
            return;
        }

        uint256 moved;
        uint256 skippedDone;
        uint256 skippedForeign;
        uint256 failed;

        if (!dryRun) vm.startBroadcast();

        for (uint256 i = 0; i < targets.length; i++) {
            string memory name = targets[i].name;
            address t = targets[i].addr;

            (bool readable, address before_) = _owner(t);
            if (!readable) {
                console.log("[SKIP] %s %s", name, t);
                console.log("       owner() is not readable - not Ownable, or not a contract.");
                failed++;
                continue;
            }

            console.log("[%s] %s", name, t);
            console.log("       owner before:", before_);

            if (before_ == newOwner) {
                console.log("       already owned by NEW_OWNER - skipping (idempotent).");
                skippedDone++;
                continue;
            }
            if (before_ != caller) {
                console.log("       owner is NOT the signer - skipping rather than reverting.");
                console.log("       (nothing this signer can do here; handle it separately)");
                skippedForeign++;
                continue;
            }

            if (dryRun) {
                console.log("       WOULD transferOwnership ->", newOwner);
                moved++;
                continue;
            }

            IOwnableLike(t).transferOwnership(newOwner);

            (, address after_) = _owner(t);
            console.log("       owner after :", after_);
            if (after_ == newOwner) {
                console.log("       OK");
                moved++;
            } else {
                // Two-step Ownable, or a transfer that did not take. Both need
                // a human; neither should abort the remaining targets.
                (bool twoStep, address pending) = _pendingOwner(t);
                if (twoStep) {
                    console.log("       TWO-STEP Ownable detected. pendingOwner:", pending);
                    console.log("       NOT DONE YET: the new owner must call acceptOwnership()");
                    console.log("       cast send %s 'acceptOwnership()' --account <new-owner>", t);
                } else {
                    console.log("       !! owner did not change and this is not Ownable2Step.");
                }
                failed++;
            }
        }

        if (!dryRun) vm.stopBroadcast();

        console.log("");
        console.log("=== summary ===");
        console.log(dryRun ? "transfers that WOULD run:" : "transferred:", moved);
        console.log("already on NEW_OWNER     :", skippedDone);
        console.log("owned by someone else    :", skippedForeign);
        console.log("needs attention          :", failed);

        if (dryRun) {
            console.log("");
            console.log("DRY RUN - nothing was sent. Re-run without DRY_RUN and with --broadcast.");
        } else {
            console.log("");
            console.log("Ownership only. Still to do by hand (RUNBOOK_KEY_ROTATION.md):");
            console.log("  sec.5 move ERC-20 balances and native ETH off the old key");
            console.log("  sec.6 setAgentAuthorized(oldSessionManager,false) + revokeSession");
            console.log("  sec.6 x402 platformTreasury / payTo");
            console.log("  sec.7 GitHub secrets, agent/.env.example PAY_TO");
            console.log("  HandoverRoles.s.sol for GuardedOracle / AssetVaultV2 (AccessControl)");
        }
    }

    // ── env plumbing ─────────────────────────────────────────────────────────

    /// @dev Every entry is optional. An unset (or zero) address is not visited,
    ///      so the same script covers "rotate the four the audit found" and
    ///      "rotate everything on this chain".
    function _targets() internal view returns (Target[] memory out) {
        Target[MAX_TARGETS] memory all = [
            Target("PerpetualExchange",       vm.envOr("EXCHANGE",          address(0))),
            Target("MockUSDC",                vm.envOr("MOCKUSDC",          address(0))),
            Target("MockUSDT",                vm.envOr("MOCKUSDT",          address(0))),
            Target("MockOracle",              vm.envOr("MOCKORACLE",        address(0))),
            Target("PepeToken",               vm.envOr("PEPETOKEN",         address(0))),
            Target("InsuranceVault",          vm.envOr("INSVAULT",          address(0))),
            Target("FeeRouter",               vm.envOr("FEEROUTER",         address(0))),
            // The x402 stack is a second FeeRouter + InsuranceVault pair, bound to
            // official USDC instead of MockUSDC. Different addresses, same types —
            // they need their own slots or the rotation silently misses the
            // contracts that route real x402 revenue.
            Target("X402 FeeRouter",          vm.envOr("X402_FEEROUTER",    address(0))),
            Target("X402 InsuranceVault",     vm.envOr("X402_INSVAULT",     address(0))),
            Target("KYCRegistry",             vm.envOr("KYCREGISTRY",       address(0))),
            Target("TraderStake",             vm.envOr("TRADERSTAKE",       address(0))),
            Target("CopyTracker",             vm.envOr("COPYTRACKER",       address(0))),
            Target("PepeAMM",                 vm.envOr("PEPEAMM",           address(0))),
            Target("PepeStaking",             vm.envOr("PEPESTAKING",       address(0))),
            Target("PepeIncentives",          vm.envOr("PEPEINCENTIVES",    address(0))),
            Target("PepeClaim",               vm.envOr("PEPECLAIM",         address(0))),
            Target("ESGRegistry",             vm.envOr("ESGREGISTRY",       address(0))),
            Target("EsgRewardDistributor",    vm.envOr("ESGDISTRIBUTOR",    address(0))),
            Target("AssetVault (v1)",         vm.envOr("ASSETVAULT",        address(0))),
            Target("ChainlinkOracleAdapter",  vm.envOr("CHAINLINK_ADAPTER", address(0))),
            Target("PythOracleAdapter",       vm.envOr("PYTH_ADAPTER",      address(0))),
            Target("AggregatorOracleAdapter", vm.envOr("AGGREGATOR_ORACLE", address(0)))
        ];

        uint256 n;
        for (uint256 i = 0; i < MAX_TARGETS; i++) {
            if (all[i].addr != address(0)) n++;
        }
        out = new Target[](n);
        uint256 j;
        for (uint256 i = 0; i < MAX_TARGETS; i++) {
            if (all[i].addr != address(0)) out[j++] = all[i];
        }
    }

    // ── probes ───────────────────────────────────────────────────────────────

    function _owner(address t) internal view returns (bool ok, address owner_) {
        (bool success, bytes memory data) =
            t.staticcall(abi.encodeWithSignature("owner()"));
        if (!success || data.length < 32) return (false, address(0));
        return (true, abi.decode(data, (address)));
    }

    /// @dev Present on `Ownable2Step`, absent on `Ownable`. Used to tell the
    ///      operator whether an `acceptOwnership()` still has to happen, instead
    ///      of assuming either shape.
    function _pendingOwner(address t) internal view returns (bool isTwoStep, address pending) {
        (bool success, bytes memory data) =
            t.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!success || data.length < 32) return (false, address(0));
        return (true, abi.decode(data, (address)));
    }
}
