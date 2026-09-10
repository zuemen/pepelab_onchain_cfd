// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2_4.sol";
import "../src/v2/SyntheticAssetV2.sol";

interface IExistingOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice #129 phase A — the hardened vault stack, on the chain that never got
///         one. Base Sepolia (84532) is the canonical chain, and today its
///         mint/redeem path is the V1 `AssetVault`: no fee, no reserve ratio,
///         no pause, no per-asset cap. #93's promises to investors (a visible
///         reserve ratio, an "unverified" state, on-chain ratio events, a
///         breach halting mints, exits never gated) are all V2-only, and none
///         of them read on Base Sepolia today.
///
///         This deploys ALONGSIDE the V1 stack, exactly as #102's
///         `DeployGuardedStack` did on Sepolia — nothing existing is touched.
///         The difference from that script: the proxy runs `AssetVaultV2_4`
///         (carbon-priced mint, ADR-006) from block one rather than V2.0 +
///         three in-place upgrades, and the vault is left ready for
///         `setEsgRegistry` — which happens in phase E, once the #128
///         `ESGRegistryV2` exists.
///
///           MOCKUSDC_ADDR=0x… MOCKORACLE_ADDR=0x… \
///           ADMIN_ADDRESS=0x… KEEPER_ADDRESS=0x… GUARDIAN_ADDRESS=0x… \
///           forge script script/DeployHardenedVault129.s.sol:DeployHardenedVault129 \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv
///
///         Prices are copied from the live MockOracle so GuardedOracle starts
///         in sync — a hardcoded guess would make the first keeper post look
///         like a huge move and trip the deviation cap.
///
/// @dev    ROLE SEPARATION (M10): GuardedOracle's deviation cap, freeze and
///         pause are only a real control while ADMIN / KEEPER / GUARDIAN are
///         three different keys. Anything unset falls back to the deployer and
///         is reported as such — fine for `anvil`, not fine on Base Sepolia.
///         `REVOKE_DEPLOYER_ADMIN=true` drops the deployer's admin once
///         `ADMIN_ADDRESS` is confirmed to hold it (default off — exercise the
///         new key first, then re-run `HandoverRoles`).
contract DeployHardenedVault129 is Script {
    uint256 constant ASSET_COUNT = 11;

    error UnpricedAssets(uint256 count);

    // Same 11 assets, order and wrapping as DeployGuardedStack.s.sol's `_defs()`,
    // so the two scripts stay diffable.
    function _defs()
        internal pure
        returns (string[ASSET_COUNT] memory syms, string[ASSET_COUNT] memory names)
    {
        syms = [
            "sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND",
            "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"
        ];
        names = [
            "Synthetic Bitcoin", "Synthetic Ether", "Synthetic Apple",
            "Synthetic Tesla", "Synthetic Gold", "Synthetic Green Bond ETF",
            "Synthetic Nvidia", "Synthetic Microsoft", "Synthetic Alphabet",
            "Synthetic Clean Energy ETF", "Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc      = vm.envAddress("MOCKUSDC_ADDR");
        address oldOracle = vm.envAddress("MOCKORACLE_ADDR");
        address deployer  = msg.sender;

        address admin    = vm.envOr("ADMIN_ADDRESS",    deployer);
        address keeper   = vm.envOr("KEEPER_ADDRESS",   deployer);
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        address risk     = vm.envOr("RISK_ADDRESS",     admin);
        bool revokeDeployerAdmin = vm.envOr("REVOKE_DEPLOYER_ADMIN", false);
        bool skipUnpriced        = vm.envOr("SKIP_UNPRICED_ASSETS", false);
        // Optional: wire the registry here if it already exists (it will not,
        // if you follow the spec's phase order — phase E does it instead).
        address esgRegistry = vm.envOr("ESG_REGISTRY_V2", address(0));

        console.log("=== role assignment ===");
        console.log("deployer :", deployer);
        console.log("admin    :", admin);
        console.log("keeper   :", keeper);
        console.log("guardian :", guardian);
        console.log("risk     :", risk);

        bool separated = admin != keeper && admin != guardian && keeper != guardian;
        if (!separated) {
            console.log("");
            console.log("################################################################");
            console.log("## ROLES ARE NOT SEPARATED - LOCAL TESTING ONLY               ##");
            console.log("## One key holds two or more of ADMIN / KEEPER / GUARDIAN.    ##");
            console.log("## GuardedOracle's deviation cap, freeze and pause are then   ##");
            console.log("## worth nothing. Set three DIFFERENT addresses before any    ##");
            console.log("## public deployment.                                         ##");
            console.log("################################################################");
        } else {
            console.log("roles separated: OK (three distinct keys)");
        }

        (string[ASSET_COUNT] memory syms, string[ASSET_COUNT] memory names) = _defs();

        require(oldOracle.code.length > 0, "MOCKORACLE_ADDR has no code on this chain");
        require(usdc.code.length > 0, "MOCKUSDC_ADDR has no code on this chain");

        uint256[ASSET_COUNT] memory seeded;
        uint256 unpriced;
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            try IExistingOracle(oldOracle).getPrice(keccak256(bytes(syms[i]))) returns (uint256 p, uint256) {
                seeded[i] = p;
            } catch {
                seeded[i] = 0;
            }
            if (seeded[i] == 0) {
                unpriced++;
                console.log("  UNPRICED on the old oracle:", syms[i]);
            }
        }

        if (unpriced > 0 && !skipUnpriced) {
            console.log("");
            console.log("!!! %s asset(s) have no readable price on %s.", unpriced, oldOracle);
            console.log("!!! Registering them while the oracle has never heard of them makes a");
            console.log("!!! market that cannot be priced, minted, or redeemed. Refusing.");
            console.log("!!! Seed the old oracle first, or re-run with SKIP_UNPRICED_ASSETS=true.");
            revert UnpricedAssets(unpriced);
        }

        vm.startBroadcast();

        // 1. Hardened oracle, deployer as admin so this script can still seed
        //    assets and grant roles; admin handed over at the end.
        GuardedOracle guarded = new GuardedOracle(deployer);
        console.log("GuardedOracle:", address(guarded));
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            if (seeded[i] > 0) guarded.addAsset(keccak256(bytes(syms[i])), seeded[i]);
        }
        guarded.grantRole(guarded.KEEPER_ROLE(), keeper);
        guarded.grantRole(guarded.GUARDIAN_ROLE(), guardian);
        if (guardian != deployer) guarded.revokeRole(guarded.GUARDIAN_ROLE(), deployer);

        // 2. V2.4 proxy, initialized on the OLD oracle then migrated so
        //    setOracle is exercised on-chain rather than merely existing.
        AssetVaultV2_4 impl = new AssetVaultV2_4();
        console.log("AssetVaultV2_4 impl:", address(impl));
        AssetVaultV2_4 vault = AssetVaultV2_4(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_4.initialize, (usdc, oldOracle, deployer))
        )));
        console.log("AssetVaultV2_4 proxy:", address(vault));
        vault.setOracle(address(guarded));

        if (esgRegistry != address(0)) {
            require(esgRegistry.code.length > 0, "ESG_REGISTRY_V2 has no code");
            vault.setEsgRegistry(esgRegistry);
            console.log("esgRegistry wired now:", esgRegistry);
        } else {
            console.log("esgRegistry NOT wired - phase E (Wire129) does it once ESGRegistryV2 exists.");
            console.log("Until then mintFeeBpsForAsset() fails closed to the most conservative tier (100 bps).");
        }

        // 3. Tokens, each granting the vault mint/burn rights.
        bytes32 minterRole = keccak256("MINTER_ROLE");
        uint256 registered;
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            if (seeded[i] == 0) {
                console.log("  skipped (unpriced):", syms[i]);
                continue;
            }
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAssetV2 t = new SyntheticAssetV2(names[i], syms[i], aid, deployer);
            t.grantRole(minterRole, address(vault));
            vault.registerAsset(aid, address(t));
            if (admin != deployer) {
                t.grantRole(0x00, admin);
                t.revokeRole(0x00, deployer);
            }
            registered++;
            console.log(syms[i], address(t));
        }

        // 4. Vault roles, then hand over admin last.
        vault.grantRole(vault.RISK_ROLE(), risk);
        vault.grantRole(vault.PAUSER_ROLE(), guardian);
        if (risk != deployer)     vault.revokeRole(vault.RISK_ROLE(), deployer);
        if (guardian != deployer) vault.revokeRole(vault.PAUSER_ROLE(), deployer);

        if (admin != deployer) {
            guarded.grantRole(0x00, admin);
            vault.grantRole(0x00, admin);
            if (revokeDeployerAdmin) {
                require(guarded.hasRole(0x00, admin), "admin grant did not take on oracle");
                require(vault.hasRole(0x00, admin),   "admin grant did not take on vault");
                guarded.revokeRole(0x00, deployer);
                vault.revokeRole(0x00, deployer);
                console.log("deployer DEFAULT_ADMIN_ROLE revoked on both contracts");
            }
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("version          :", vault.version());
        console.log("assets registered:", registered, "of", ASSET_COUNT);
        console.log("Caps are 0 - every asset closed until the risk owner sets limits.");
        console.log("Then approve + fundVault() to seed payout collateral.");
        console.log("");
        console.log("Set for the next phases:");
        console.log("  export GUARDED_ORACLE_129=", address(guarded));
        console.log("  export VAULT_PROXY_129=", address(vault));
        if (!separated) console.log("REMINDER: roles are NOT separated. Local testing only.");
        if (admin != deployer && !revokeDeployerAdmin) {
            console.log("Deployer still holds DEFAULT_ADMIN_ROLE. Exercise the new admin key,");
            console.log("then re-run with REVOKE_DEPLOYER_ADMIN=true (or use HandoverRoles).");
        }
    }
}
