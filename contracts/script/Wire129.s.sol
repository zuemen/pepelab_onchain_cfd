// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/v2/AssetVaultV2_4.sol";
import "../src/CarbonTiers.sol";

/// @notice #129 phase E — wire the hardened vault (phase A) to the carbon
///         registry (phase B). Split out because the spec's phase order puts
///         the vault before the registry, so `setEsgRegistry` cannot run
///         inside phase A.
///
///         Idempotent: re-running with the same values is a no-op setter call.
///
///           VAULT_PROXY_129=0x… ESG_REGISTRY_V2=0x… \
///           forge script script/Wire129.s.sol:Wire129 \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv
///
///         Requires DEFAULT_ADMIN_ROLE on the vault proxy.
contract Wire129 is Script {
    function run() external {
        address vaultAddr = vm.envAddress("VAULT_PROXY_129");
        address registry  = vm.envAddress("ESG_REGISTRY_V2");

        require(vaultAddr.code.length > 0, "VAULT_PROXY_129 has no code");
        require(registry.code.length > 0, "ESG_REGISTRY_V2 has no code");

        AssetVaultV2_4 vault = AssetVaultV2_4(vaultAddr);

        console.log("=== before ===");
        console.log("vault version    :", vault.version());
        console.log("vault esgRegistry :", vault.esgRegistry());
        console.log("mint fee sMSFT   :", vault.mintFeeBpsForAsset(keccak256("sMSFT")));
        console.log("mint fee sNVDA   :", vault.mintFeeBpsForAsset(keccak256("sNVDA")));

        vm.startBroadcast();
        vault.setEsgRegistry(registry);
        vm.stopBroadcast();

        require(vault.esgRegistry() == registry, "setEsgRegistry did not take");

        uint256 feeMsft = vault.mintFeeBpsForAsset(keccak256("sMSFT"));
        uint256 feeNvda = vault.mintFeeBpsForAsset(keccak256("sNVDA"));
        (uint256 highFee, ,) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);
        (uint256 lowFee, ,)  = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);

        console.log("=== after ===");
        console.log("vault esgRegistry :", vault.esgRegistry());
        console.log("mint fee sMSFT   :", feeMsft, "(want High =", highFee);
        console.log("mint fee sNVDA   :", feeNvda, "(want Low =", lowFee);

        require(feeMsft == highFee, "sMSFT not priced at High - registry not seeded, or sMSFT not attested High");
        require(feeNvda == lowFee,  "sNVDA not priced at Low - registry not seeded, or sNVDA not attested Low");
        require(feeMsft > feeNvda,  "high-carbon buy must cost more than low-carbon buy");

        console.log("");
        console.log("Vault mint fee is now carbon-derived. Remaining: caps + fundVault, addresses.ts, keeper.");
    }
}
