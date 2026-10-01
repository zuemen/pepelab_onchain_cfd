// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/StrategyRegistry.sol";
import "../src/AgentSessionManager.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/KYCRegistry.sol";
import "../src/MockOracle.sol";
import "../src/ESGRegistryV2.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2_5.sol";
import "../src/v2/SyntheticAssetV2.sol";
import "./VerifyTenant.s.sol";

/// @notice ADR-008 — deploy one white-label tenant's own full set of contracts
///         from `deploy/tenants/<id>.json`.
///
///         What a tenant gets, all new, none shared with the live platform or
///         with another tenant:
///           oracle (GuardedOracle, or MockOracle on a testnet), ESGRegistryV2,
///           KYCRegistry, InsuranceVault, FeeRouter (treasury = the tenant's),
///           TraderStake, PerpetualExchange, StrategyRegistry, CopyTracker,
///           AgentSessionManager, and — when `params.deployVault` — an
///           AssetVaultV2 proxy with one synthetic token per registered asset.
///         What it reuses: the settlement token and, to seed its own oracle
///         once, the shared price source. Nothing else.
///
///         UNLIKE the cutover scripts, this run touches no existing contract:
///         there is no irreversible step and nothing to resume. An interrupted
///         broadcast leaves an unfinished, unfunded set owned by the deployer;
///         use `forge script --resume` for the same broadcast, or start again.
///
///         THE DEPLOYER KEEPS NOTHING. The last step hands every contract to
///         `roles.admin` (grant → read back → renounce for AccessControl,
///         `transferOwnership` for Ownable) and the run then verifies that the
///         deployer holds no role anywhere. A one-step ownership transfer is
///         irreversible, and the moment it is cheapest to get wrong is now,
///         while the set holds no funds: `VerifyTenant` fails, you redeploy.
///
///         Dry run (no key, nothing sent) — docs/TENANT_DEPLOYMENT.md sec.3:
///           TENANT=<id> forge script script/DeployTenant.s.sol:DeployTenant \
///             --fork-url "$BASE_SEPOLIA_RPC_URL" --sender 0x<deployer address> -vv
///         Broadcast — the key holder only, never CI, never an assistant.
///
///         Env:
///           TENANT            required — the id; reads deploy/tenants/<id>.json
///           PREFLIGHT_ONLY    true = stop after the read-only checks
///           ALLOW_EOA_ADMIN   true = accept a `roles.admin` with no code
///                             (rehearsals; a real admin is a multisig)
contract DeployTenant is TenantBase {
    // ── test hooks (a script is never deployed on chain) ────────────────────
    address public broadcasterOverride;
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }
    /// @dev `ALLOW_EOA_ADMIN` without process-wide env (parallel tests).
    bool public allowEoaAdminOverride;
    function setAllowEoaAdmin(bool v) external { allowEoaAdminOverride = v; }

    string public lastRecordJson;
    TenantDeployed internal _last;
    function lastDeployed() external view returns (TenantDeployed memory) { return _last; }

    function run() external {
        string memory id = vm.envString("TENANT");
        _requireSlug(id);
        _deploy(vm.readFile(_configPath(id)), id, vm.envOr("PREFLIGHT_ONLY", false));
    }

    /// @notice Same as `run()`, with the config handed in as a string. Tests
    ///         use it to deploy against mocks without writing a file.
    function runWithConfig(string calldata json, string calldata id) external {
        _requireSlug(id);
        _deploy(json, id, false);
    }

    function _deploy(string memory json, string memory id, bool preflightOnly) internal {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        TenantConfig memory c = _parseConfig(json, id);
        uint256[] memory seeds = _preflight(c, deployer);
        if (preflightOnly) {
            console.log("PREFLIGHT_ONLY=true - stopping before any transaction.");
            return;
        }

        TenantDeployed memory d = _execute(c, deployer, seeds);
        _last = d;

        _verifyTenant(c, d, c.admin);

        string memory mode = _mode();
        lastRecordJson = _recordJson(c, d, c.admin, mode);
        _printAndWrite(c, lastRecordJson, mode);
    }

    // ── preflight (read-only) ─────────────────────────────────────────────

    function _preflight(TenantConfig memory c, address deployer) internal view returns (uint256[] memory seeds) {
        console.log("=== tenant preflight:", c.tenantId, "===");
        console.log("broadcaster      :", deployer);
        require(keccak256(bytes(c.status)) == keccak256("ready"),
            "tenant config: status must be 'ready' (template = placeholders left, deployed = already done)");
        require(c.chainId == block.chainid, "tenant config: network.chainId != the chain this run is connected to");
        _validateConfig(c, deployer);

        // MockOracle has no deviation cap: one key writes any price. Never on mainnet.
        require(c.guardedOracle || block.chainid != 8453, "params.oracleKind 'mock' is not allowed on Base mainnet");

        // A real admin is a multisig. An EOA here is one key owning the whole
        // tenant, and after the handover there is no second chance.
        require(c.admin.code.length > 0 || allowEoaAdminOverride || vm.envOr("ALLOW_EOA_ADMIN", false),
            "roles.admin has no code - it must be a multisig (ALLOW_EOA_ADMIN=true only for rehearsals)");
        console.log("ok   roles separated, deployer holds none of them");

        // The exchange hard-codes an 18-decimal collateral token and `usdc` is
        // immutable: a 6-decimal token would mis-scale every position forever.
        require(c.usdc.code.length > 0, "shared.settlementToken has no code on this chain");
        try IERC20Metadata(c.usdc).decimals() returns (uint8 dec) {
            require(dec == 18, "shared.settlementToken must have 18 decimals (PerpetualExchange requirement)");
        } catch {
            revert("shared.settlementToken does not report decimals()");
        }
        console.log("ok   settlement token:", c.usdc);

        // Seed prices: read once from the shared source so the tenant's oracle
        // starts in sync. Every registered asset must be quoted, and recently.
        require(c.priceSource.code.length > 0, "shared.priceSource has no code on this chain");
        seeds = new uint256[](c.assets.length);
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            try IOracle(c.priceSource).getPrice(_assetId(sym)) returns (uint256 p, uint256 at) {
                require(p > 0, string.concat("price source: zero price for ", sym));
                require(block.timestamp <= at + SEED_MAX_AGE,
                    string.concat("price source: ", sym, " is older than 1h - refresh the source first (a stale seed would look fresh on the new oracle)"));
                seeds[i] = p;
            } catch {
                revert(string.concat("price source refused to quote ", sym));
            }
        }
        console.log("ok   price source quotes every registered asset, all fresh:", c.assets.length);

        console.log("admin            :", c.admin);
        console.log("risk             :", c.risk);
        console.log("guardian         :", c.guardian);
        console.log("keeper           :", c.keeper);
        console.log("marketOperator   :", c.marketOperator);
        console.log("treasury         :", c.treasury);
        console.log("oracle kind      :", c.guardedOracle ? "guarded" : "mock");
        console.log("OI cap / side, crypto+gold (USDC):", c.oiCapNonRwa / 1e18);
        console.log("OI cap / side, RWA (USDC)        :", c.oiCapRwa / 1e18);
        console.log("maxProfitBps                     :", c.maxProfitBps);
        console.log("AssetVaultV2                     :", c.deployVault ? "yes" : "no");
    }

    // ── the broadcast ─────────────────────────────────────────────────────

    function _execute(TenantConfig memory c, address deployer, uint256[] memory seeds)
        internal returns (TenantDeployed memory d)
    {
        d.deployer = deployer;
        vm.startBroadcast(deployer);

        // 1. The tenant's own oracle, seeded from the shared source.
        d.oracle = c.guardedOracle ? _deployGuardedOracle(c, deployer, seeds) : _deployMockOracle(c, seeds);

        // 2. Registries. ESGRegistryV2 needs nothing from the deployer, so the
        //    tenant admin is its admin from the constructor. It starts empty:
        //    every asset is Tier.Unrated — the most conservative fee/leverage
        //    row — until the admin appoints attestors.
        d.esgRegistry = address(new ESGRegistryV2(c.admin));
        d.kyc = address(new KYCRegistry());

        // 3. The tenant's money path. The treasury is immutable on the router.
        d.insuranceVault = address(new InsuranceVault(c.usdc));
        d.feeRouter = address(new FeeRouter(c.usdc, c.treasury, d.insuranceVault));
        d.traderStake = address(new TraderStake(c.usdc));

        // 4. Exchange + launch parameters.
        d.exchange = _deployExchange(c, d);

        // 5. Copy trading + agent sessions, bound to this exchange only.
        d.strategyRegistry = address(new StrategyRegistry(d.traderStake));
        d.copyTracker = address(new CopyTracker(c.usdc, d.exchange, d.strategyRegistry, d.feeRouter, d.traderStake));
        d.sessionManager = address(new AgentSessionManager(d.exchange));
        PerpetualExchange(d.exchange).setCopyTracker(d.copyTracker);
        PerpetualExchange(d.exchange).setAgentAuthorized(d.sessionManager, true);

        // 6. Wire the periphery to this exchange.
        InsuranceVault(d.insuranceVault).setFeeRouter(d.feeRouter);
        InsuranceVault(d.insuranceVault).setExchange(d.exchange);
        FeeRouter(d.feeRouter).setExchange(d.exchange);
        FeeRouter(d.feeRouter).setCopyTracker(d.copyTracker);
        TraderStake(d.traderStake).setCopyTracker(d.copyTracker);

        // 7. Optional tokenised-asset vault.
        if (c.deployVault) _deployVault(c, d, deployer);

        // 8. Hand everything to the tenant admin. Ownable is one step.
        _handOverOwnables(d, c.admin);

        vm.stopBroadcast();
    }

    function _deployExchange(TenantConfig memory c, TenantDeployed memory d) internal returns (address) {
        PerpetualExchange ex = new PerpetualExchange(c.usdc, d.oracle, d.esgRegistry);
        ex.setMaxPriceAge(MAX_PRICE_AGE);
        ex.setExecutionFee(EXECUTION_FEE);
        ex.setAdlEnabled(ADL_ENABLED);
        // RWA markets are KYC-gated only while a registry is wired: without
        // this line the flags below would gate nothing.
        ex.setKycRegistry(d.kyc);
        ex.setFeeRouter(d.feeRouter);
        ex.setInsuranceVault(d.insuranceVault);
        // Caps are never left at 0 (= unlimited).
        for (uint256 i = 0; i < c.assets.length; i++) {
            bytes32 id = _assetId(c.assets[i]);
            bool rwa = _isRwa(c.assets[i]);
            if (rwa) ex.setRwaAsset(id, true);
            uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
            ex.setMaxOpenInterest(id, cap, cap);
            ex.setMaxProfitBps(id, c.maxProfitBps);
        }
        ex.setGuardian(c.guardian);
        ex.setMarketOperator(c.marketOperator);
        return address(ex);
    }

    function _handOverOwnables(TenantDeployed memory d, address admin) internal {
        Ownable(d.exchange).transferOwnership(admin);
        Ownable(d.copyTracker).transferOwnership(admin);
        Ownable(d.insuranceVault).transferOwnership(admin);
        Ownable(d.feeRouter).transferOwnership(admin);
        Ownable(d.traderStake).transferOwnership(admin);
        Ownable(d.kyc).transferOwnership(admin);
    }

    function _deployGuardedOracle(TenantConfig memory c, address deployer, uint256[] memory seeds) internal returns (address) {
        // Deployer is admin only long enough to seed assets and grant roles.
        GuardedOracle o = new GuardedOracle(deployer);
        o.setRiskParams(ORACLE_MAX_DEVIATION_BPS, ORACLE_MAX_PRICE_AGE);
        for (uint256 i = 0; i < c.assets.length; i++) o.addAsset(_assetId(c.assets[i]), seeds[i]);
        o.grantRole(KEEPER_ROLE, c.keeper);
        o.grantRole(GUARDIAN_ROLE, c.guardian);
        // The constructor made the deployer a guardian; it must not stay one.
        o.renounceRole(GUARDIAN_ROLE, deployer);
        // Grant → read back → only then drop the deployer. Renouncing first, or
        // without reading back, can leave a contract nobody can ever administer.
        o.grantRole(ADMIN_ROLE, c.admin);
        require(o.hasRole(ADMIN_ROLE, c.admin), "oracle: admin grant did not take");
        o.renounceRole(ADMIN_ROLE, deployer);
        return address(o);
    }

    function _deployMockOracle(TenantConfig memory c, uint256[] memory seeds) internal returns (address) {
        MockOracle o = new MockOracle();
        for (uint256 i = 0; i < c.assets.length; i++) o.addAsset(_assetId(c.assets[i]), seeds[i]);
        // MockOracle's owner is the price writer: that is the keeper's job.
        o.transferOwnership(c.keeper);
        return address(o);
    }

    function _deployVault(TenantConfig memory c, TenantDeployed memory d, address deployer) internal {
        AssetVaultV2_5 impl = new AssetVaultV2_5();
        AssetVaultV2_5 vault = AssetVaultV2_5(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_5.initialize, (c.usdc, d.oracle, deployer))
        )));
        d.assetVaultImpl = address(impl);
        d.assetVault = address(vault);
        vault.setEsgRegistry(d.esgRegistry);

        d.tokens = new address[](c.assets.length);
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            bytes32 id = _assetId(sym);
            SyntheticAssetV2 t = new SyntheticAssetV2(_tokenName(sym), sym, id, deployer);
            t.grantRole(MINTER_ROLE, address(vault));
            vault.registerAsset(id, address(t));
            t.grantRole(ADMIN_ROLE, c.admin);
            require(t.hasRole(ADMIN_ROLE, c.admin), "token: admin grant did not take");
            t.renounceRole(ADMIN_ROLE, deployer);
            d.tokens[i] = address(t);
        }

        // Only the quote-age limit is touched (see VAULT_MAX_PRICE_AGE); the
        // redeem fee and the minimum reserve ratio keep the contract defaults.
        vault.setRiskParams(vault.redeemFeeBps(), vault.minReserveRatioBps(), VAULT_MAX_PRICE_AGE);
        // Asset caps stay at the contract default of 0: every asset is closed
        // to minting until the tenant's risk key sets a limit.
        vault.grantRole(RISK_ROLE, c.risk);
        vault.grantRole(PAUSER_ROLE, c.guardian);
        vault.renounceRole(RISK_ROLE, deployer);
        vault.renounceRole(PAUSER_ROLE, deployer);
        vault.grantRole(ADMIN_ROLE, c.admin);
        require(vault.hasRole(ADMIN_ROLE, c.admin), "vault: admin grant did not take");
        vault.renounceRole(ADMIN_ROLE, deployer);
    }

    // ── output ────────────────────────────────────────────────────────────

    function _mode() internal view returns (string memory) {
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            return "broadcast";
        }
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) return "dry-run";
        return "test";
    }

    /// @dev Always prints the record. Writes it under `cache/tenants/` when
    ///      running as a script: `<id>.deployed.json` for a broadcast,
    ///      `<id>.dry-run.json` for a simulation — two names so a simulated
    ///      address set cannot be mistaken for the real one. Nothing is ever
    ///      written into `deploy/tenants/`: copying it there is a human step,
    ///      after `VerifyTenant` passed against the real chain.
    function _printAndWrite(TenantConfig memory c, string memory record, string memory mode) internal {
        console.log("");
        console.log("=== tenant deployment record (mode: %s) ===", mode);
        console.log(record);
        bytes32 m = keccak256(bytes(mode));
        if (m == keccak256("test")) return;
        string memory path = string.concat(OUT_DIR, c.tenantId, m == keccak256("broadcast") ? ".deployed.json" : ".dry-run.json");
        vm.createDir(OUT_DIR, true);
        vm.writeJson(record, path);
        console.log("written to contracts/%s", path);
        if (m == keccak256("broadcast")) {
            console.log("Next: VerifyTenant against the real chain (TENANT_RECORD=%s), then docs/TENANT_DEPLOYMENT.md sec.4.", path);
        } else {
            console.log("DRY RUN - these addresses are simulated. Nothing was sent.");
        }
    }
}
