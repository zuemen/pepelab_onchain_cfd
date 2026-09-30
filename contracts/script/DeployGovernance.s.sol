// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Deploys the OZ `TimelockController` that becomes the owner / admin
///         of every protocol contract (see `HandoverToTimelock` and
///         docs/GOVERNANCE_HANDOVER.md).
///
///         - minDelay: `TIMELOCK_MIN_DELAY` seconds, default 48h.
///         - proposer (also canceller, OZ grants both): `TIMELOCK_PROPOSER`,
///           a Safe. REQUIRED — reverts when unset.
///         - executor: `TIMELOCK_EXECUTOR`, a Safe. REQUIRED — reverts when
///           unset (address(0) "anyone may execute" is deliberately not
///           offered here; pass the same Safe as the proposer if in doubt).
///         - admin: address(0). The timelock administers itself, so its own
///           roles can only change through a delayed, public proposal — no
///           key can quietly add a proposer.
///
///         Both Safes must already exist (have code) unless
///         `ALLOW_EOA_ROLES=true` (anvil / throwaway testing only).
///
///           TIMELOCK_PROPOSER=0x<safe> TIMELOCK_EXECUTOR=0x<safe> \
///           forge script script/DeployGovernance.s.sol:DeployGovernance \
///             --fork-url https://sepolia.base.org --sender 0x27C2…A585 -vv      # simulate
///           … --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow   # user only
contract DeployGovernance is Script {
    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;
    uint256 internal constant MIN_DELAY_FLOOR   = 1 hours;   // below this the delay is theatre

    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    TimelockController public deployed;

    function run() external returns (TimelockController tl) {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;

        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);
        address proposer = vm.envOr("TIMELOCK_PROPOSER", address(0));
        address executor = vm.envOr("TIMELOCK_EXECUTOR", address(0));
        bool allowEoa    = vm.envOr("ALLOW_EOA_ROLES", false);

        require(proposer != address(0), "TIMELOCK_PROPOSER (Safe) env is required");
        require(executor != address(0), "TIMELOCK_EXECUTOR (Safe) env is required");
        require(minDelay >= MIN_DELAY_FLOOR, "TIMELOCK_MIN_DELAY below 1h floor");
        if (!allowEoa) {
            require(proposer.code.length > 0, "TIMELOCK_PROPOSER has no code - expected a Safe (ALLOW_EOA_ROLES=true for tests only)");
            require(executor.code.length > 0, "TIMELOCK_EXECUTOR has no code - expected a Safe (ALLOW_EOA_ROLES=true for tests only)");
        }
        require(proposer != deployer && executor != deployer, "proposer/executor must not be the deployer EOA");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        vm.startBroadcast(deployer);
        tl = new TimelockController(minDelay, proposers, executors, address(0));
        vm.stopBroadcast();
        deployed = tl;

        // Read back — the timelock must administer itself and nothing else may.
        bytes32 adminRole = tl.DEFAULT_ADMIN_ROLE();
        require(tl.getMinDelay() == minDelay, "minDelay mismatch");
        require(tl.hasRole(tl.PROPOSER_ROLE(), proposer), "proposer role missing");
        require(tl.hasRole(tl.CANCELLER_ROLE(), proposer), "canceller role missing");
        require(tl.hasRole(tl.EXECUTOR_ROLE(), executor), "executor role missing");
        require(tl.hasRole(adminRole, address(tl)), "timelock does not self-administer");
        require(!tl.hasRole(adminRole, deployer), "deployer holds timelock admin");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "open executor role");

        console.log("=== TimelockController ===");
        console.log("TIMELOCK   =", address(tl));
        console.log("minDelay   :", minDelay);
        console.log("proposer   :", proposer);
        console.log("executor   :", executor);
        console.log("admin      : address(0) (self-administered)");
        console.log("Next: HandoverToTimelock HANDOVER_PHASE=1, then 2 (docs/GOVERNANCE_HANDOVER.md).");
    }
}
