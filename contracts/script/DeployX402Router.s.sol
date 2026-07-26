// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";

/// @notice Phase 5 (A0): a dedicated x402 revenue-router pair bound to the
///         **official Base Sepolia USDC** (Circle, 6-dec, EIP-3009), isolated
///         from the perpetual engine which keeps using MockUSDC (18-dec) for
///         margin. This makes x402 paid-signal revenue settle 70/20/10 in the
///         *same currency the agent paid in* (FeeRouter.usdc is immutable, so a
///         fresh pair is the only way to switch settlement currency).
///
///         Reuses the existing FeeRouter + InsuranceVault verbatim — no new
///         contract logic, just a deployment with a different USDC.
///
///         Env:
///           X402_USDC  override the settlement token (default = official
///                      Base Sepolia USDC 0x036CbD…CF7e)
///           TREASURY   platform-share recipient (default = deployer)
///
///         Run:
///           forge script script/DeployX402Router.s.sol:DeployX402Router \
///             --rpc-url base_sepolia --broadcast --verify
contract DeployX402Router is Script {
    // Circle's official USDC on Base Sepolia (6 decimals, transferWithAuthorization).
    address constant DEFAULT_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        address usdc     = vm.envOr("X402_USDC", DEFAULT_USDC);
        address treasury = vm.envOr("TREASURY", msg.sender);

        vm.startBroadcast();

        // Vault + router both bound to the official USDC.
        InsuranceVault vault = new InsuranceVault(usdc);
        FeeRouter router = new FeeRouter(usdc, treasury, address(vault));
        // routeExternalRevenue's 10% vault share routes via depositFromProtocol,
        // which is gated to the vault's feeRouter — wire it.
        vault.setFeeRouter(address(router));

        vm.stopBroadcast();

        console.log("=== x402 revenue router (official USDC) ===");
        console.log("settlement USDC :", usdc);
        console.log("platformTreasury:", treasury);
        console.log("X402_FeeRouter   :", address(router));
        console.log("X402_InsVault    :", address(vault));
        console.log("-> set agent .env: X402_FEE_ROUTER + X402_SETTLEMENT_TOKEN");
    }
}
