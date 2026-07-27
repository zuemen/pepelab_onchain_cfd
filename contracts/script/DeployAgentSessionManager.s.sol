// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentSessionManager.sol";
import "../src/PerpetualExchange.sol";

/// @notice Redeploys ONLY AgentSessionManager, pointed at the already-deployed
///         PerpetualExchange, to bring the per-session asset allow-list on
///         chain.
///
///         Deliberately not Deploy.s.sol: that redeploys the whole system and
///         would destroy every open position. This touches nothing except the
///         session manager.
///
///           EXCHANGE_ADDR=0x… forge script script/DeployAgentSessionManager.s.sol \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
///
///         The broadcaster must be the exchange owner, because the new manager
///         needs setAgentAuthorized to open positions on users' behalf.
///
///         Session ids restart at 0 on the new instance. The old manager stays
///         deployed and its sessions remain readable, but agents should be
///         pointed at the new address.
contract DeployAgentSessionManager is Script {
    function run() external {
        address exchangeAddr = vm.envAddress("EXCHANGE_ADDR");
        PerpetualExchange exchange = PerpetualExchange(exchangeAddr);

        address owner = exchange.owner();
        console.log("Exchange       :", exchangeAddr);
        console.log("Exchange owner :", owner);

        vm.startBroadcast();

        AgentSessionManager manager = new AgentSessionManager(exchangeAddr);
        console.log("NEW AgentSessionManager:", address(manager));

        // Without this the manager cannot call openPositionFor on behalf of a
        // session user, so the deployment would be inert.
        exchange.setAgentAuthorized(address(manager), true);
        console.log("Authorized on exchange : true");

        vm.stopBroadcast();

        console.log("---");
        console.log("1. Put this address in frontend/src/contracts/sessionManager.ts (84532)");
        console.log("2. Put it in agent/.env SESSION_MANAGER_ADDRESS");
        console.log("3. Create a fresh session; ids restart at 0 on this instance");
        console.log("4. Update agent/.env DEMO_SESSION_ID to the new id");
    }
}
