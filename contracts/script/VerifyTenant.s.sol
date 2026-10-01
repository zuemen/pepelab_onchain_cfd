// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/StrategyRegistry.sol";
import "../src/AgentSessionManager.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";

interface ITenantVault {
    function usdc() external view returns (address);
    function oracle() external view returns (address);
    function esgRegistry() external view returns (address);
    function assetToken(bytes32 assetId) external view returns (address);
    function version() external view returns (string memory);
}

/// @notice ADR-008 — everything `DeployTenant` and `VerifyTenant` share: how a
///         tenant's deployment config (`deploy/tenants/<id>.json`) is read and
///         validated, the fixed launch parameters, and the read-only assertions
///         run after a deployment.
///
///         NO ADDRESS IS HARD-CODED HERE. Every address comes from the tenant's
///         config (roles, settlement token, price source) or from the record of
///         the tenant's own deployment. That is the point of the file: the
///         cutover scripts (`Redeploy130Hardened`, `Verify130`) carry the live
///         platform's addresses as constants and so can only ever redeploy the
///         platform; a tenant gets a full set of its own.
abstract contract TenantBase is Script {
    /// @dev Relative to the Foundry project root (`contracts/`). `foundry.toml`
    ///      grants read access to exactly this directory.
    string internal constant TENANTS_DIR = "../deploy/tenants/";
    /// @dev Where a run writes its record. Under `cache/` (git-ignored) so a
    ///      simulated address set can never be committed by accident.
    string internal constant OUT_DIR = "cache/tenants/";

    // ── launch parameters (not addresses) ───────────────────────────────────
    // Same values the live platform runs (docs/DEPLOY_130_CUTOVER.md sec.3.2).
    // The tenant's admin can change any of them after the handover.
    uint256 internal constant MAX_PRICE_AGE = 21_600;   // 6h
    uint256 internal constant EXECUTION_FEE = 1e14;     // 0.0001 ETH
    bool    internal constant ADL_ENABLED   = true;

    /// @dev A tenant's oracle is seeded from the shared price source and the
    ///      seed is stamped "now". A stale seed would therefore look fresh, so
    ///      the source must have been updated within this window.
    uint256 internal constant SEED_MAX_AGE = 1 hours;
    /// @dev GuardedOracle's own staleness check is switched OFF (0). Staleness
    ///      is enforced where it matters — by the exchange (`maxPriceAge`, 6h)
    ///      and by the vault (its own `maxPriceAge`) — each against the
    ///      oracle's `updatedAt`. Leaving it on at the oracle is a trap: the
    ///      keeper reads the current price through `getPrice` before every
    ///      post (agent/keeper/round.ts) and refuses to write when that read
    ///      reverts, so one outage longer than the limit would lock the keeper
    ///      out of the very update that ends the staleness. The live platform
    ///      avoids the same trap with a 30-day value.
    uint256 internal constant ORACLE_MAX_PRICE_AGE     = 0;
    /// @dev The vault's stored quote-age limit. Its initializer says 1h, below
    ///      the real keeper cadence (~2h); 6h is the ceiling V2.5 enforces
    ///      anyway and what the live vault runs.
    uint256 internal constant VAULT_MAX_PRICE_AGE      = MAX_PRICE_AGE;
    uint256 internal constant ORACLE_MAX_DEVIATION_BPS = 1_000;   // 10% per post

    uint256 internal constant MIN_PROFIT_BPS = 10_000;
    uint256 internal constant MAX_PROFIT_BPS = 250_000;
    uint256 internal constant MAX_ASSETS     = 11;

    bytes32 internal constant ADMIN_ROLE    = 0x00;
    bytes32 internal constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 internal constant RISK_ROLE     = keccak256("RISK_ROLE");
    bytes32 internal constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 internal constant MINTER_ROLE   = keccak256("MINTER_ROLE");

    struct TenantConfig {
        string   tenantId;
        string   status;
        uint256  chainId;
        address  admin;
        address  risk;
        address  guardian;
        address  keeper;
        address  marketOperator;
        address  treasury;
        address  usdc;            // shared.settlementToken
        address  priceSource;     // shared.priceSource — seeds the tenant's own oracle
        bool     guardedOracle;   // params.oracleKind: "guarded" (true) | "mock" (false)
        uint256  oiCapNonRwa;     // 18-dec, whole USDC, per side
        uint256  oiCapRwa;        // 18-dec, whole USDC, per side
        uint256  maxProfitBps;
        bool     deployVault;
        string[] assets;          // assets.registered
    }

    struct TenantDeployed {
        address   deployer;
        address   oracle;
        address   esgRegistry;
        address   kyc;
        address   insuranceVault;
        address   feeRouter;
        address   traderStake;
        address   exchange;
        address   strategyRegistry;
        address   copyTracker;
        address   sessionManager;
        address   assetVault;       // 0 when params.deployVault is false
        address   assetVaultImpl;   // 0 when params.deployVault is false
        address[] tokens;           // parallel to TenantConfig.assets; empty without a vault
    }

    // ── config ──────────────────────────────────────────────────────────────

    /// @dev Tenant ids are file names. Lower-case letters, digits and single
    ///      hyphens only, so `TENANT` can never walk out of `deploy/tenants/`.
    function _requireSlug(string memory id) internal pure {
        bytes memory b = bytes(id);
        require(b.length > 0 && b.length <= 64, "TENANT: empty or longer than 64 chars");
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool alnum = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x61 && ch <= 0x7a);
            bool hyphen = ch == 0x2d && i != 0 && i != b.length - 1 && b[i - 1] != 0x2d;
            require(alnum || hyphen, "TENANT: only [a-z0-9] and single hyphens (it is a file name)");
        }
        require(keccak256(b) != keccak256("default"), "TENANT: 'default' is the live platform, not a tenant deployment");
    }

    function _configPath(string memory id) internal pure returns (string memory) {
        return string.concat(TENANTS_DIR, id, ".json");
    }

    function _readConfig(string memory id) internal view returns (TenantConfig memory) {
        _requireSlug(id);
        return _parseConfig(vm.readFile(_configPath(id)), id);
    }

    /// @dev Reverts (inside the cheatcode) on any missing field and on any
    ///      address still written as a `<PLACEHOLDER>` — a template cannot be
    ///      deployed.
    function _parseConfig(string memory json, string memory expectedId) internal pure returns (TenantConfig memory c) {
        require(vm.parseJsonUint(json, ".schemaVersion") == 2, "tenant config: schemaVersion must be 2");
        c.tenantId = vm.parseJsonString(json, ".tenantId");
        require(keccak256(bytes(c.tenantId)) == keccak256(bytes(expectedId)), "tenant config: tenantId != TENANT");
        c.status  = vm.parseJsonString(json, ".status");
        c.chainId = vm.parseJsonUint(json, ".network.chainId");

        c.admin          = vm.parseJsonAddress(json, ".roles.admin");
        c.risk           = vm.parseJsonAddress(json, ".roles.risk");
        c.guardian       = vm.parseJsonAddress(json, ".roles.guardian");
        c.keeper         = vm.parseJsonAddress(json, ".roles.keeper");
        c.marketOperator = vm.parseJsonAddress(json, ".roles.marketOperator");
        c.treasury       = vm.parseJsonAddress(json, ".roles.treasury");
        c.usdc           = vm.parseJsonAddress(json, ".shared.settlementToken");
        c.priceSource    = vm.parseJsonAddress(json, ".shared.priceSource");

        bytes32 kind = keccak256(bytes(vm.parseJsonString(json, ".params.oracleKind")));
        if (kind == keccak256("guarded")) c.guardedOracle = true;
        else if (kind == keccak256("mock")) c.guardedOracle = false;
        else revert("tenant config: params.oracleKind must be 'guarded' or 'mock'");

        // Whole USDC in the file, so the cap written on chain and the cap a
        // reader sees in the config are the same number.
        c.oiCapNonRwa  = vm.parseJsonUint(json, ".params.oiCapNonRwaUsdc") * 1e18;
        c.oiCapRwa     = vm.parseJsonUint(json, ".params.oiCapRwaUsdc") * 1e18;
        c.maxProfitBps = vm.parseJsonUint(json, ".params.maxProfitBps");
        c.deployVault  = vm.parseJsonBool(json, ".params.deployVault");
        c.assets       = vm.parseJsonStringArray(json, ".assets.registered");
    }

    /// @notice The checks that need no chain: role separation, caps, assets.
    ///         `deployer == address(0)` skips the deployer-specific ones (the
    ///         verifier does not know who will broadcast).
    function _validateConfig(TenantConfig memory c, address deployer) internal pure {
        require(c.admin != address(0) && c.risk != address(0) && c.guardian != address(0)
            && c.keeper != address(0) && c.marketOperator != address(0) && c.treasury != address(0),
            "roles: none may be the zero address");
        require(c.usdc != address(0) && c.priceSource != address(0), "shared: settlementToken / priceSource must be set");

        // admin / keeper / guardian / risk: pairwise distinct (6 pairs). The
        // same list scripts/check-tenant-deploy.mjs enforces before any key is used.
        address[4] memory sep = [c.admin, c.keeper, c.guardian, c.risk];
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = i + 1; j < 4; j++) {
                require(sep[i] != sep[j], "roles: admin / keeper / guardian / risk must be four different addresses");
            }
        }
        // A guardian that is also the key moving prices or switching markets is
        // one compromise away from both.
        require(c.guardian != c.marketOperator, "roles: guardian must differ from marketOperator");
        require(c.treasury != c.keeper, "roles: the keeper hot key must not be the treasury");
        require(c.treasury != c.guardian, "roles: the guardian hot key must not be the treasury");

        if (deployer != address(0)) {
            require(deployer != c.admin && deployer != c.keeper && deployer != c.guardian && deployer != c.risk
                && deployer != c.marketOperator && deployer != c.treasury,
                "roles: the deployer key must hold no tenant role (it ends the run with no privileges)");
        }

        // 0 = unlimited on the exchange; a tenant never launches unlimited.
        require(c.oiCapNonRwa > 0 && c.oiCapRwa > 0, "params: OI caps must be non-zero (0 = unlimited)");
        require(c.maxProfitBps >= MIN_PROFIT_BPS && c.maxProfitBps <= MAX_PROFIT_BPS,
            "params: maxProfitBps must be in [10000, 250000] (0 = off is not allowed)");
        // The hardened vault on an oracle with no deviation cap is not hardened.
        require(!c.deployVault || c.guardedOracle, "params: deployVault requires oracleKind 'guarded'");

        require(c.assets.length > 0 && c.assets.length <= MAX_ASSETS, "assets.registered: 1 to 11 assets");
        for (uint256 i = 0; i < c.assets.length; i++) {
            _tokenName(c.assets[i]);   // reverts on an unknown symbol
            for (uint256 j = i + 1; j < c.assets.length; j++) {
                require(keccak256(bytes(c.assets[i])) != keccak256(bytes(c.assets[j])), "assets.registered: duplicate symbol");
            }
        }
    }

    function _assetId(string memory sym) internal pure returns (bytes32) {
        return keccak256(bytes(sym));
    }

    /// @dev Whether an asset is a regulated real-world instrument is a property
    ///      of the asset, not a tenant setting — a tenant must not be able to
    ///      switch off the KYC gate by mislabelling sAAPL. Same eight as
    ///      `Cutover130Base._isRwa` (a test pins the two together).
    function _isRwa(string memory sym) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(sym));
        return h == keccak256("sAAPL") || h == keccak256("sTSLA") || h == keccak256("sNVDA")
            || h == keccak256("sMSFT") || h == keccak256("sGOOGL") || h == keccak256("sICLN")
            || h == keccak256("sESGU") || h == keccak256("sBOND");
    }

    /// @dev ERC-20 name of the tenant's synthetic token. Doubles as the list
    ///      of assets this codebase knows: anything else is refused.
    function _tokenName(string memory sym) internal pure returns (string memory) {
        bytes32 h = keccak256(bytes(sym));
        if (h == keccak256("sBTC"))   return "Synthetic Bitcoin";
        if (h == keccak256("sETH"))   return "Synthetic Ether";
        if (h == keccak256("sAAPL"))  return "Synthetic Apple";
        if (h == keccak256("sTSLA"))  return "Synthetic Tesla";
        if (h == keccak256("sGOLD"))  return "Synthetic Gold";
        if (h == keccak256("sBOND"))  return "Synthetic Green Bond ETF";
        if (h == keccak256("sNVDA"))  return "Synthetic Nvidia";
        if (h == keccak256("sMSFT"))  return "Synthetic Microsoft";
        if (h == keccak256("sGOOGL")) return "Synthetic Alphabet";
        if (h == keccak256("sICLN"))  return "Synthetic Clean Energy ETF";
        if (h == keccak256("sESGU"))  return "Synthetic ESG ETF";
        revert(string.concat("assets.registered: unknown asset ", sym));
    }

    // ── deployment record ───────────────────────────────────────────────────

    /// @dev `mode` is "broadcast", "dry-run" or "test". Only a "broadcast"
    ///      record may be copied to deploy/tenants/<id>.deployed.json
    ///      (scripts/check-tenant-deploy.mjs refuses the others).
    function _recordJson(TenantConfig memory c, TenantDeployed memory d, address owner, string memory mode)
        internal returns (string memory)
    {
        string memory k = string.concat("tenant-contracts-", c.tenantId);
        vm.serializeAddress(k, "Oracle", d.oracle);
        vm.serializeAddress(k, "ESGRegistryV2", d.esgRegistry);
        vm.serializeAddress(k, "KYCRegistry", d.kyc);
        vm.serializeAddress(k, "InsuranceVault", d.insuranceVault);
        vm.serializeAddress(k, "FeeRouter", d.feeRouter);
        vm.serializeAddress(k, "TraderStake", d.traderStake);
        vm.serializeAddress(k, "PerpetualExchange", d.exchange);
        vm.serializeAddress(k, "StrategyRegistry", d.strategyRegistry);
        vm.serializeAddress(k, "CopyTracker", d.copyTracker);
        vm.serializeAddress(k, "AssetVaultV2", d.assetVault);
        vm.serializeAddress(k, "AssetVaultV2Impl", d.assetVaultImpl);
        string memory contractsJson = vm.serializeAddress(k, "AgentSessionManager", d.sessionManager);

        string memory t = string.concat("tenant-tokens-", c.tenantId);
        string memory tokensJson = "{}";
        for (uint256 i = 0; i < d.tokens.length; i++) {
            tokensJson = vm.serializeAddress(t, c.assets[i], d.tokens[i]);
        }

        string memory r = string.concat("tenant-record-", c.tenantId);
        vm.serializeUint(r, "schemaVersion", 1);
        vm.serializeString(r, "tenantId", c.tenantId);
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeString(r, "mode", mode);
        vm.serializeString(r, "oracleKind", c.guardedOracle ? "guarded" : "mock");
        vm.serializeAddress(r, "deployer", d.deployer);
        vm.serializeAddress(r, "owner", owner);
        vm.serializeAddress(r, "settlementToken", c.usdc);
        vm.serializeAddress(r, "treasury", c.treasury);
        vm.serializeString(r, "contracts", contractsJson);
        return vm.serializeString(r, "tokens", tokensJson);
    }

    function _parseRecord(string memory json, TenantConfig memory c) internal view returns (TenantDeployed memory d, address owner) {
        require(vm.parseJsonUint(json, ".schemaVersion") == 1, "deployment record: schemaVersion must be 1");
        require(keccak256(bytes(vm.parseJsonString(json, ".tenantId"))) == keccak256(bytes(c.tenantId)),
            "deployment record: tenantId != TENANT");
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "deployment record: chainId != this chain");
        require(
            keccak256(bytes(vm.parseJsonString(json, ".oracleKind"))) == keccak256(bytes(c.guardedOracle ? "guarded" : "mock")),
            "deployment record: oracleKind differs from the tenant config"
        );
        require(vm.parseJsonAddress(json, ".settlementToken") == c.usdc, "deployment record: settlementToken differs from the tenant config");
        require(vm.parseJsonAddress(json, ".treasury") == c.treasury, "deployment record: treasury differs from the tenant config");

        owner               = vm.parseJsonAddress(json, ".owner");
        d.deployer          = vm.parseJsonAddress(json, ".deployer");
        d.oracle            = vm.parseJsonAddress(json, ".contracts.Oracle");
        d.esgRegistry       = vm.parseJsonAddress(json, ".contracts.ESGRegistryV2");
        d.kyc               = vm.parseJsonAddress(json, ".contracts.KYCRegistry");
        d.insuranceVault    = vm.parseJsonAddress(json, ".contracts.InsuranceVault");
        d.feeRouter         = vm.parseJsonAddress(json, ".contracts.FeeRouter");
        d.traderStake       = vm.parseJsonAddress(json, ".contracts.TraderStake");
        d.exchange          = vm.parseJsonAddress(json, ".contracts.PerpetualExchange");
        d.strategyRegistry  = vm.parseJsonAddress(json, ".contracts.StrategyRegistry");
        d.copyTracker       = vm.parseJsonAddress(json, ".contracts.CopyTracker");
        d.sessionManager    = vm.parseJsonAddress(json, ".contracts.AgentSessionManager");
        d.assetVault        = vm.parseJsonAddress(json, ".contracts.AssetVaultV2");
        d.assetVaultImpl    = vm.parseJsonAddress(json, ".contracts.AssetVaultV2Impl");
        if (c.deployVault) {
            d.tokens = new address[](c.assets.length);
            for (uint256 i = 0; i < c.assets.length; i++) {
                d.tokens[i] = vm.parseJsonAddress(json, string.concat(".tokens.", c.assets[i]));
            }
        }
    }

    // ── read-back verification ──────────────────────────────────────────────

    function _eq(string memory field, address got, address want) internal pure {
        if (got != want) {
            console.log("MISMATCH", field);
            console.log("  got  :", got);
            console.log("  want :", want);
            revert(string.concat("verify tenant mismatch: ", field));
        }
        console.log("ok  ", field);
    }

    function _check(bool cond, string memory what) internal pure {
        if (!cond) revert(string.concat("verify tenant failed: ", what));
        console.log("ok  ", what);
    }

    function _has(address target, bytes32 role, address who) internal view returns (bool) {
        return IAccessControl(target).hasRole(role, who);
    }

    /// @notice Every property of a finished tenant deployment, read back from
    ///         chain. Reverts on the first mismatch with the field name.
    /// @param owner The address expected to own / administer every contract:
    ///        `roles.admin` right after `DeployTenant`, or the tenant's
    ///        timelock once the admin has moved ownership behind one.
    function _verifyTenant(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        console.log("=== verify tenant:", c.tenantId, "===");
        _verifyDistinct(c, d);
        _verifyExchange(c, d, owner);
        _verifyPeriphery(c, d, owner);
        _verifyOracle(c, d, owner);
        _verifyVault(c, d, owner);
        _verifyDeployerHasNothing(c, d, owner);
    }

    /// @dev Isolation at its most basic: every contract of the set exists, is
    ///      its own address, and is none of the shared or role addresses.
    function _verifyDistinct(TenantConfig memory c, TenantDeployed memory d) internal view {
        uint256 n = 10 + (c.deployVault ? 2 + d.tokens.length : 0);
        address[] memory all = new address[](n);
        all[0] = d.oracle; all[1] = d.esgRegistry; all[2] = d.kyc; all[3] = d.insuranceVault; all[4] = d.feeRouter;
        all[5] = d.traderStake; all[6] = d.exchange; all[7] = d.strategyRegistry; all[8] = d.copyTracker;
        all[9] = d.sessionManager;
        if (c.deployVault) {
            require(d.tokens.length == c.assets.length, "verify tenant failed: one token per registered asset");
            all[10] = d.assetVault;
            all[11] = d.assetVaultImpl;
            for (uint256 i = 0; i < d.tokens.length; i++) all[12 + i] = d.tokens[i];
        } else {
            require(d.assetVault == address(0) && d.assetVaultImpl == address(0) && d.tokens.length == 0,
                "verify tenant failed: params.deployVault is false but the record carries a vault");
        }
        for (uint256 i = 0; i < n; i++) {
            require(all[i].code.length > 0, "verify tenant failed: a recorded contract has no code on this chain");
            require(all[i] != c.usdc && all[i] != c.priceSource,
                "verify tenant failed: a tenant contract is the shared settlement token / price source");
            for (uint256 j = i + 1; j < n; j++) {
                require(all[i] != all[j], "verify tenant failed: two contracts of the set share one address");
            }
        }
        console.log("ok   every contract has code and its own address:", n);
    }

    function _verifyExchange(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        PerpetualExchange ex = PerpetualExchange(d.exchange);
        console.log("--- PerpetualExchange ---");
        _eq("exchange.owner", ex.owner(), owner);
        _eq("exchange.guardian", ex.guardian(), c.guardian);
        _eq("exchange.marketOperator", ex.marketOperator(), c.marketOperator);
        _eq("exchange.usdc", address(ex.usdc()), c.usdc);
        _eq("exchange.oracle", address(ex.oracle()), d.oracle);
        _check(address(ex.oracle()) != c.priceSource, "exchange reads the tenant's own oracle, not the shared price source");
        _eq("exchange.esgRegistry", address(ex.esgRegistry()), d.esgRegistry);
        _eq("exchange.kyc", address(ex.kyc()), d.kyc);
        _eq("exchange.feeRouter", address(ex.feeRouter()), d.feeRouter);
        _eq("exchange.insuranceVault", address(ex.insuranceVault()), d.insuranceVault);
        _eq("exchange.copyTracker", ex.copyTracker(), d.copyTracker);
        _check(ex.maxPriceAge() == MAX_PRICE_AGE, "exchange.maxPriceAge == 21600");
        _check(ex.executionFee() == EXECUTION_FEE, "exchange.executionFee == 1e14");
        _check(ex.adlEnabled() == ADL_ENABLED, "exchange.adlEnabled == true");
        _check(!ex.paused(), "exchange not paused");
        // The getter CopyTracker's slash scoring depends on — absent on any
        // build older than the hardened one.
        ex.closeReasonOf(0);
        console.log("ok   exchange.closeReasonOf present (hardened build)");

        console.log("--- risk caps (per asset) ---");
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            bytes32 id = _assetId(sym);
            bool rwa = _isRwa(sym);
            if (ex.rwaAsset(id) != rwa) revert(string.concat("verify tenant failed: rwaAsset flag ", sym));
            uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
            if (ex.maxLongOI(id) != cap || ex.maxShortOI(id) != cap) {
                revert(string.concat("verify tenant failed: OI cap != config for ", sym));
            }
            if (ex.maxProfitBps(id) != c.maxProfitBps) revert(string.concat("verify tenant failed: maxProfitBps for ", sym));
            console.log(string.concat("ok   ", sym, rwa ? " (RWA)" : ""), "OI/side USDC", cap / 1e18);
        }

        console.log("--- agents ---");
        _check(ex.authorizedAgents(d.sessionManager), "AgentSessionManager authorised on the exchange");
        _check(ex.authorizedAgents(d.copyTracker), "CopyTracker authorised on the exchange");
        _eq("sessionManager.exchange", address(AgentSessionManager(d.sessionManager).exchange()), d.exchange);
    }

    function _verifyPeriphery(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        console.log("--- CopyTracker / StrategyRegistry / TraderStake ---");
        CopyTracker ct = CopyTracker(d.copyTracker);
        _eq("copyTracker.exchange", address(ct.exchange()), d.exchange);
        _eq("copyTracker.registry", address(ct.registry()), d.strategyRegistry);
        _eq("copyTracker.usdc", address(ct.usdc()), c.usdc);
        _eq("copyTracker.feeRouter", address(ct.feeRouter()), d.feeRouter);
        _eq("copyTracker.traderStake", address(ct.traderStake()), d.traderStake);
        _eq("copyTracker.owner", ct.owner(), owner);
        _eq("strategyRegistry.stakeContract", address(StrategyRegistry(d.strategyRegistry).stakeContract()), d.traderStake);
        _eq("traderStake.usdc", address(TraderStake(d.traderStake).usdc()), c.usdc);
        _eq("traderStake.copyTracker", TraderStake(d.traderStake).copyTracker(), d.copyTracker);
        _eq("traderStake.owner", TraderStake(d.traderStake).owner(), owner);

        console.log("--- InsuranceVault / FeeRouter (the tenant's own money path) ---");
        InsuranceVault iv = InsuranceVault(d.insuranceVault);
        _eq("insuranceVault.usdc", address(iv.usdc()), c.usdc);
        _eq("insuranceVault.exchange", iv.exchange(), d.exchange);
        _eq("insuranceVault.feeRouter", iv.feeRouter(), d.feeRouter);
        _eq("insuranceVault.owner", iv.owner(), owner);
        FeeRouter fr = FeeRouter(d.feeRouter);
        _eq("feeRouter.usdc", address(fr.usdc()), c.usdc);
        _eq("feeRouter.platformTreasury", fr.platformTreasury(), c.treasury);
        _eq("feeRouter.insuranceVault", address(fr.insuranceVault()), d.insuranceVault);
        _eq("feeRouter.exchange", fr.exchange(), d.exchange);
        _eq("feeRouter.copyTracker", fr.copyTracker(), d.copyTracker);
        _eq("feeRouter.owner", fr.owner(), owner);

        console.log("--- KYCRegistry / ESGRegistryV2 ---");
        _eq("kyc.owner", Ownable(d.kyc).owner(), owner);
        _check(_has(d.esgRegistry, ADMIN_ROLE, owner), "ESGRegistryV2 admin is the tenant owner");
    }

    function _verifyOracle(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        console.log("--- oracle ---");
        if (c.guardedOracle) {
            _check(_has(d.oracle, ADMIN_ROLE, owner), "GuardedOracle admin is the tenant owner");
            _check(_has(d.oracle, KEEPER_ROLE, c.keeper), "GuardedOracle KEEPER_ROLE is the tenant keeper");
            _check(_has(d.oracle, GUARDIAN_ROLE, c.guardian), "GuardedOracle GUARDIAN_ROLE is the tenant guardian");
            _check(!_has(d.oracle, KEEPER_ROLE, c.guardian) && !_has(d.oracle, GUARDIAN_ROLE, c.keeper),
                "keeper cannot freeze, guardian cannot post prices");
        } else {
            // MockOracle: the owner IS the price writer. Testnet only.
            _eq("mockOracle.owner (price writer)", Ownable(d.oracle).owner(), c.keeper);
        }
        // A missing price is a wiring failure. A stale or frozen one is the
        // keeper's state, reported and not failed — same split as Verify130.
        uint256 stale;
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            try IOracle(d.oracle).getPrice(_assetId(sym)) returns (uint256 p, uint256 at) {
                if (p == 0) revert(string.concat("verify tenant failed: oracle has no price for ", sym));
                if (block.timestamp > at + MAX_PRICE_AGE) {
                    stale++;
                    console.log(string.concat("WARN ", sym, " price older than 6h - dispatch the tenant keeper"));
                }
            } catch {
                stale++;
                console.log(string.concat("WARN ", sym, " oracle refused to quote (stale / frozen / not added?) - dispatch the tenant keeper"));
            }
        }
        if (stale == 0) console.log("ok   every registered asset priced and fresh on the tenant oracle");
        else console.log("WARN assets without a fresh quote:", stale);
    }

    function _verifyVault(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        if (!c.deployVault) {
            console.log("--- AssetVaultV2: not part of this tenant (params.deployVault = false) ---");
            return;
        }
        console.log("--- AssetVaultV2 + synthetic tokens ---");
        ITenantVault v = ITenantVault(d.assetVault);
        console.log("vault version:", v.version());
        _eq("vault.usdc", v.usdc(), c.usdc);
        _eq("vault.oracle", v.oracle(), d.oracle);
        _eq("vault.esgRegistry", v.esgRegistry(), d.esgRegistry);
        _check(_has(d.assetVault, ADMIN_ROLE, owner), "vault admin (upgrades) is the tenant owner");
        _check(_has(d.assetVault, RISK_ROLE, c.risk), "vault RISK_ROLE is the tenant risk key");
        _check(_has(d.assetVault, PAUSER_ROLE, c.guardian), "vault PAUSER_ROLE is the tenant guardian");
        for (uint256 i = 0; i < c.assets.length; i++) {
            address token = d.tokens[i];
            if (v.assetToken(_assetId(c.assets[i])) != token) {
                revert(string.concat("verify tenant failed: vault.assetToken for ", c.assets[i]));
            }
            if (!_has(token, MINTER_ROLE, d.assetVault)) {
                revert(string.concat("verify tenant failed: vault is not the minter of ", c.assets[i]));
            }
            if (!_has(token, ADMIN_ROLE, owner)) {
                revert(string.concat("verify tenant failed: token admin is not the tenant owner for ", c.assets[i]));
            }
        }
        console.log("ok   tokens registered, minted only by the vault, administered by the owner:", c.assets.length);
    }

    /// @dev The deployer is a CI hot key. A finished tenant leaves it nothing.
    function _verifyDeployerHasNothing(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        address dep = d.deployer;
        console.log("--- deployer key retains nothing ---");
        _check(dep != owner, "deployer is not the owner");
        _check(dep != address(0), "deployer recorded");
        if (c.guardedOracle) {
            _check(!_has(d.oracle, ADMIN_ROLE, dep) && !_has(d.oracle, GUARDIAN_ROLE, dep) && !_has(d.oracle, KEEPER_ROLE, dep),
                "deployer has no role on the oracle");
        }
        _check(!_has(d.esgRegistry, ADMIN_ROLE, dep), "deployer has no role on ESGRegistryV2");
        if (c.deployVault) {
            _check(!_has(d.assetVault, ADMIN_ROLE, dep) && !_has(d.assetVault, RISK_ROLE, dep) && !_has(d.assetVault, PAUSER_ROLE, dep),
                "deployer has no role on the vault");
            for (uint256 i = 0; i < d.tokens.length; i++) {
                if (_has(d.tokens[i], ADMIN_ROLE, dep) || _has(d.tokens[i], MINTER_ROLE, dep)) {
                    revert(string.concat("verify tenant failed: deployer still holds a role on token ", c.assets[i]));
                }
            }
            console.log("ok   deployer has no role on any token");
        }
    }
}

/// @notice ADR-008 — read-only verification of one tenant's deployment.
///
///           TENANT=<id> forge script script/VerifyTenant.s.sol:VerifyTenant \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
///
///         Reads `deploy/tenants/<id>.json` (the config) and the deployment
///         record — `deploy/tenants/<id>.deployed.json` by default, or
///         `TENANT_RECORD=<path>` (e.g. `cache/tenants/<id>.deployed.json`,
///         straight after the broadcast and before it is copied).
///
///         Optional: EXPECTED_OWNER — defaults to `roles.admin` from the
///         config. Set it to the tenant's timelock after the admin has moved
///         ownership behind one.
contract VerifyTenant is TenantBase {
    function run() external view {
        string memory id = vm.envString("TENANT");
        TenantConfig memory c = _readConfig(id);
        bytes32 st = keccak256(bytes(c.status));
        require(st == keccak256("ready") || st == keccak256("deployed"), "tenant config: status must be ready or deployed");
        require(c.chainId == block.chainid, "tenant config: network.chainId != this chain");
        _validateConfig(c, address(0));

        string memory path = vm.envOr("TENANT_RECORD", string.concat(TENANTS_DIR, id, ".deployed.json"));
        (TenantDeployed memory d, ) = _parseRecord(vm.readFile(path), c);
        // The config, not the record, says who should own the tenant.
        _verifyTenant(c, d, vm.envOr("EXPECTED_OWNER", c.admin));
        console.log("");
        console.log("=== tenant wiring verified. Frontend registry, keeper environment and signal-api still to do (docs/TENANT_OPERATIONS.md). ===");
    }
}
