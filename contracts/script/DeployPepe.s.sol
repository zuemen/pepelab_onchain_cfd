// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeToken.sol";

/// @notice Deploy the platform token PepeToken to Base Sepolia so PEPE has
///         liquidity on this network (it previously only existed on the old
///         Ethereum Sepolia → 0x0 on Base). PepeToken ships a TESTNET-ONLY
///         public `faucet()` (10k PEPE / 24h), so no AMM pool is needed — users
///         self-serve PEPE, mirroring MockUSDC.
///
///         claim/staking are intentionally out of scope here (faucet-first); add
///         a follow-up script if those liquidity scenarios are wanted.
///
///         Dry-run (no broadcast):
///           forge script script/DeployPepe.s.sol:DeployPepe --rpc-url base_sepolia
///         Broadcast (run by the operator):
///           forge script script/DeployPepe.s.sol:DeployPepe \
///             --rpc-url base_sepolia --broadcast --verify
///         then copy the printed PepeToken address into
///         frontend/src/contracts/addresses.ts BASE_SEPOLIA.PepeToken.
contract DeployPepe is Script {
    function run() external {
        vm.startBroadcast();

        PepeToken pepe = new PepeToken();

        vm.stopBroadcast();

        console.log("=== PepeToken (Base Sepolia) ===");
        console.log("PepeToken        :", address(pepe));
        console.log("deployer/owner   :", msg.sender);
        console.log("initial supply   :", pepe.INITIAL_SUPPLY());
        console.log("faucet amount    :", pepe.FAUCET_AMOUNT());
        console.log("-> put this into frontend/src/contracts/addresses.ts BASE_SEPOLIA.PepeToken");
    }
}
