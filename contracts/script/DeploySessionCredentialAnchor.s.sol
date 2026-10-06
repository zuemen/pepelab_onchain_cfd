// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SessionCredentialAnchor.sol";

/// @notice Deploys ONLY SessionCredentialAnchor, pointed at an already-deployed
///         AgentSessionManager. Touches nothing else: no ownership, no wiring —
///         the anchor is a read-only consumer of `sessions(id)`.
///
///           SESSION_MANAGER_ADDR=0x… forge script script/DeploySessionCredentialAnchor.s.sol \
///             --rpc-url http://127.0.0.1:8545 --private-key <anvil test key> --broadcast
///
///         Any account can deploy it (there is no admin). After deploying, set
///         SESSION_ANCHOR_ADDRESS for the agent / signal-api and VITE_SESSION_ANCHOR_ADDRESS
///         for the frontend. See docs/SSI_AGENT_DELEGATION.md.
contract DeploySessionCredentialAnchor is Script {
    function run() external returns (SessionCredentialAnchor anchorC) {
        address manager = vm.envAddress("SESSION_MANAGER_ADDR");
        require(manager.code.length > 0, "SESSION_MANAGER_ADDR has no code");

        vm.startBroadcast();
        anchorC = new SessionCredentialAnchor(manager);
        vm.stopBroadcast();

        console.log("AgentSessionManager    :", manager);
        console.log("SessionCredentialAnchor:", address(anchorC));
    }
}
