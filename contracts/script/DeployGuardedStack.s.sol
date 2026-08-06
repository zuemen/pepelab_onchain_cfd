// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2.sol";
import "../src/v2/SyntheticAssetV2.sol";

interface IExistingOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice Deploys the hardened stack and wires it together in one broadcast:
///
///           GuardedOracle  (multi-keeper, deviation-capped, freezable)
///           AssetVaultV2   (UUPS proxy) -> pointed at GuardedOracle
///           11x SyntheticAssetV2        -> vault holds MINTER_ROLE
///
///         Nothing existing is touched. V1's AssetVault, the 11 V1 tokens, and
///         MockOracle all keep running — this deploys alongside so the two can
///         be compared.
///
///           MOCKUSDC_ADDR=0x… MOCKORACLE_ADDR=0x… forge script … --broadcast
///
///         Seeding: prices are copied from the existing MockOracle so the new
///         oracle starts in sync with the live one. Starting from a hardcoded
///         guess would make the first keeper post look like a huge move and trip
///         the deviation cap.
///
/// @dev    ## M10 — the three roles used to be one key
///
///         GuardedOracle exists to bound what a compromised price-poster can do:
///         KEEPER posts prices under a deviation cap, GUARDIAN can freeze an
///         asset or pause the oracle, ADMIN sets the caps and the reference
///         source. That is a real control only while the three are different
///         keys. This script granted all three to the deployer, so a single
///         compromised key could raise the cap, post any price, and unfreeze
///         whatever the guardian froze — every mitigation the contract advertises
///         reduced to "trust the deployer's laptop".
///
///         Addresses now come from env:
///
///           ADMIN_ADDRESS     cap/config authority + proxy upgrade authority.
///                             Should be a multisig, ideally behind a timelock.
///           KEEPER_ADDRESS    hot key that posts prices. Expected to be online
///                             and therefore expected to be the one that leaks.
///           GUARDIAN_ADDRESS  freeze/pause key. Kept off the keeper's machine,
///                             or freezing achieves nothing when that machine is
///                             the one that is compromised.
///           RISK_ADDRESS      (optional) vault risk params; defaults to ADMIN.
///
///         Anything unset falls back to the deployer and is reported as such in
///         a block of warnings. That configuration is fine for `anvil` and is
///         not fine anywhere else, so the log says so in those words.
///
///           REVOKE_DEPLOYER_ADMIN=true  drop the deployer's DEFAULT_ADMIN_ROLE
///                                       once ADMIN_ADDRESS is confirmed to hold
///                                       it. Off by default: exercise the new key
///                                       first, then re-run `HandoverRoles`.
///
///         ## The second inconsistency, at the old line 73
///
///         An asset whose price could not be read from the old oracle was
///         skipped by `guarded.addAsset` — and then registered on the vault
///         anyway. The result was an asset the vault believes it can price and
///         the oracle has never heard of: `mint` reverts, `outstandingValue`
///         skips it, and the misconfiguration is visible only by cross-reading
///         two contracts. Both halves now agree. The default is to fail loudly
///         listing the unreadable assets; `SKIP_UNPRICED_ASSETS=true` skips the
///         asset *entirely* (no token, no addAsset, no registerAsset) and prints
///         which ones were dropped.
contract DeployGuardedStack is Script {
    uint256 constant ASSET_COUNT = 11;

    error UnpricedAssets(uint256 count);

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
            "Synthetic Tesla", "Synthetic Gold", "Synthetic Bond",
            "Synthetic Nvidia", "Synthetic Microsoft", "Synthetic Alphabet",
            "Synthetic Clean Energy ETF", "Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc      = vm.envAddress("MOCKUSDC_ADDR");
        address oldOracle = vm.envAddress("MOCKORACLE_ADDR");
        address deployer  = msg.sender;

        // ── M10: role holders, read separately ───────────────────────────────
        address admin    = vm.envOr("ADMIN_ADDRESS",    deployer);
        address keeper   = vm.envOr("KEEPER_ADDRESS",   deployer);
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        address risk     = vm.envOr("RISK_ADDRESS",     admin);
        bool revokeDeployerAdmin = vm.envOr("REVOKE_DEPLOYER_ADMIN", false);
        bool skipUnpriced        = vm.envOr("SKIP_UNPRICED_ASSETS", false);

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
            console.log("## worth nothing: whoever takes that key can raise the cap,   ##");
            console.log("## post any price, and undo any freeze in the same tx.        ##");
            console.log("## Set ADMIN_ADDRESS, KEEPER_ADDRESS and GUARDIAN_ADDRESS to  ##");
            console.log("## three DIFFERENT addresses before any public deployment.    ##");
            console.log("################################################################");
        } else {
            console.log("roles separated: OK (three distinct keys)");
        }

        (string[ASSET_COUNT] memory syms, string[ASSET_COUNT] memory names) = _defs();

        // Read live prices BEFORE broadcasting — these are view calls.
        uint256[ASSET_COUNT] memory seeded;
        uint256 unpriced;
        // An address with no code is not "an oracle that failed to answer", it
        // is the wrong address — and foundry raises that as an uncatchable
        // script error, so check it here and say which env var is wrong.
        require(oldOracle.code.length > 0, "MOCKORACLE_ADDR has no code on this chain");
        require(usdc.code.length > 0, "MOCKUSDC_ADDR has no code on this chain");

        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            try IExistingOracle(oldOracle).getPrice(aid) returns (uint256 p, uint256) {
                seeded[i] = p;
            } catch {
                seeded[i] = 0;
            }
            if (seeded[i] == 0) {
                unpriced++;
                console.log("  UNPRICED on the old oracle:", syms[i]);
            }
        }

        // Consistency, both halves or neither.
        if (unpriced > 0) {
            console.log("");
            console.log("!!! %s asset(s) have no readable price on %s.", unpriced, oldOracle);
            if (!skipUnpriced) {
                console.log("!!! Registering them on the vault while the oracle has never heard");
                console.log("!!! of them produces a market that looks configured and cannot be");
                console.log("!!! priced, minted, or redeemed. Refusing.");
                console.log("!!! Seed the old oracle first, or re-run with");
                console.log("!!! SKIP_UNPRICED_ASSETS=true to drop those assets entirely.");
                revert UnpricedAssets(unpriced);
            }
            console.log("!!! SKIP_UNPRICED_ASSETS=true -> those assets get NO token, NO oracle");
            console.log("!!! entry and NO vault registration. Add them later once priced.");
        }

        vm.startBroadcast();

        // 1. Hardened oracle. Constructed with the DEPLOYER as admin so this
        //    script can still seed assets and grant roles; admin is handed over
        //    at the end, after everything below has succeeded.
        GuardedOracle guarded = new GuardedOracle(deployer);
        console.log("GuardedOracle:", address(guarded));
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            if (seeded[i] > 0) guarded.addAsset(keccak256(bytes(syms[i])), seeded[i]);
        }

        guarded.grantRole(guarded.KEEPER_ROLE(), keeper);
        guarded.grantRole(guarded.GUARDIAN_ROLE(), guardian);
        // The constructor also gave the deployer GUARDIAN_ROLE. Drop it whenever
        // someone else is meant to hold it, otherwise "separated" is a fiction.
        if (guardian != deployer) {
            guarded.revokeRole(guarded.GUARDIAN_ROLE(), deployer);
        }

        // 2. Upgradeable vault, initialized on the OLD oracle then migrated, so
        //    setOracle is exercised on-chain rather than merely existing.
        AssetVaultV2 impl = new AssetVaultV2();
        console.log("AssetVaultV2 impl:", address(impl));

        AssetVaultV2 vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (usdc, oldOracle, deployer))
        )));
        console.log("AssetVaultV2 proxy:", address(vault));

        vault.setOracle(address(guarded));

        // 3. Tokens, each granting the vault mint/burn rights. Only for assets
        //    the oracle actually carries — see the guard above.
        bytes32 minterRole = keccak256("MINTER_ROLE");
        uint256 registered;
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            if (seeded[i] == 0) {
                console.log("  skipped (unpriced):", syms[i]);
                continue;
            }
            bytes32 aid = keccak256(bytes(syms[i]));
            // Constructed under the DEPLOYER's admin, because the very next call
            // needs DEFAULT_ADMIN_ROLE to grant the vault its minter rights.
            // Handing the token straight to ADMIN_ADDRESS made that call revert
            // AccessControlUnauthorizedAccount, i.e. role separation and this
            // loop could not both be true. Admin is handed over immediately
            // after, so the deployer holds it for one call.
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
            guarded.grantRole(0x00, admin);   // DEFAULT_ADMIN_ROLE
            vault.grantRole(0x00, admin);

            if (revokeDeployerAdmin) {
                // Read back before dropping: AccessControl has no recovery from
                // an adminless contract, and an unupgradeable proxy is forever.
                require(guarded.hasRole(0x00, admin), "admin grant did not take on oracle");
                require(vault.hasRole(0x00, admin),   "admin grant did not take on vault");
                guarded.revokeRole(0x00, deployer);
                vault.revokeRole(0x00, deployer);
                console.log("deployer DEFAULT_ADMIN_ROLE revoked on both contracts");
            }
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("assets registered:", registered, "of", ASSET_COUNT);
        console.log("Caps are 0 - every asset closed until the risk owner sets limits.");
        console.log("Then approve + fundVault() to seed payout collateral.");
        if (!separated) {
            console.log("REMINDER: roles are NOT separated. Local testing only.");
        }
        if (admin != deployer && !revokeDeployerAdmin) {
            console.log("Deployer still holds DEFAULT_ADMIN_ROLE. Exercise the new admin key,");
            console.log("then re-run with REVOKE_DEPLOYER_ADMIN=true (or use HandoverRoles).");
        }
    }
}
