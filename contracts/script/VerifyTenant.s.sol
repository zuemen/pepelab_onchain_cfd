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
import "../src/KYCRegistry.sol";

interface ITenantVault {
    function usdc() external view returns (address);
    function oracle() external view returns (address);
    function esgRegistry() external view returns (address);
    function assetToken(bytes32 assetId) external view returns (address);
    function version() external view returns (string memory);
    function redeemFeeBps() external view returns (uint256);
    function minReserveRatioBps() external view returns (uint256);
    function maxPriceAge() external view returns (uint256);
    function effectiveMaxPriceAge() external view returns (uint256);
    function assetCap(bytes32 assetId) external view returns (uint256);
    function mintingHalted() external view returns (bool);
    function paused() external view returns (bool);
}

/// @dev The read side of `GuardedOracle` that verification needs. An
///      interface (not the contract import) keeps this file free of the
///      oracle's own `IPriceSource` declaration.
interface ITenantGuardedOracle {
    function maxDeviationBps() external view returns (uint256);
    function maxPriceAge() external view returns (uint256);
    function windowDuration() external view returns (uint256);
    function maxWindowDeviationBps() external view returns (uint256);
    function referenceSource() external view returns (address);
    function paused() external view returns (bool);
    function peek(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt, bool exists, bool frozen);
}

/// @notice ADR-008 — everything `DeployTenant` and `VerifyTenant` share: how a
///         tenant's deployment config (`deploy/tenants/<id>.json`) is read and
///         validated, the fixed launch parameters, and the read-only assertions
///         run after a deployment.
///
///         NO ADDRESS IS HARD-CODED HERE. Every address comes from the tenant's
///         config (roles, settlement token, price source, reference source) or
///         from the record of the tenant's own deployment. That is the point of
///         the file: the cutover scripts (`Redeploy130Hardened`, `Verify130`)
///         carry the live platform's addresses as constants and so can only ever
///         redeploy the platform; a tenant gets a full set of its own.
abstract contract TenantBase is Script {
    /// @dev Relative to the Foundry project root (`contracts/`). `foundry.toml`
    ///      grants read access to exactly this directory.
    string internal constant TENANTS_DIR = "../deploy/tenants/";
    /// @dev Where a run writes its record. Under `cache/` (git-ignored) so a
    ///      simulated address set can never be committed by accident.
    string internal constant OUT_DIR = "cache/tenants/";

    uint256 internal constant SCHEMA_VERSION = 3;

    // ── launch parameters that are not per-tenant (not addresses) ─────────────
    // Same values the live platform runs (docs/DEPLOY_130_CUTOVER.md sec.3.2).
    uint256 internal constant MAX_PRICE_AGE = 21_600;   // 6h
    uint256 internal constant EXECUTION_FEE = 1e14;     // 0.0001 ETH
    bool    internal constant ADL_ENABLED   = true;
    /// @dev The exchange's legacy flat fees. With an ESG registry wired (every
    ///      tenant has one) the effective trading / borrow fee is the asset's
    ///      carbon-tier row and these two values are NOT charged. A tenant
    ///      deployment leaves them at the contract defaults; verification
    ///      checks they are still there, because a changed value means someone
    ///      changed the exchange after the handover.
    uint256 internal constant LEGACY_TRADING_FEE_BPS         = 10;
    uint256 internal constant LEGACY_BORROW_FEE_BPS_PER_HOUR = 1;

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
    ///      avoids the same trap with a 30-day value. Consequence: the oracle's
    ///      `isStale()` is always false on a tenant oracle — monitoring must
    ///      judge freshness from the price timestamp, not from `isStale()`.
    uint256 internal constant ORACLE_MAX_PRICE_AGE = 0;
    /// @dev The vault's stored quote-age limit. Its initializer says 1h, below
    ///      the real keeper cadence (~2h); 6h is the ceiling V2.5 enforces
    ///      anyway and what the live vault runs.
    uint256 internal constant VAULT_MAX_PRICE_AGE = MAX_PRICE_AGE;

    // ── bounds on the per-tenant parameters (deploy/tenants/<id>.json, params) ─
    // scripts/check-tenant-deploy.mjs enforces the same ranges before any key
    // is used; a test pins nothing here because the JS side reads the numbers
    // from its own table — keep the two in step when changing one.
    /// @dev Per-post step cap of the tenant's GuardedOracle.
    uint256 internal constant ORACLE_DEVIATION_BPS_MIN = 100;
    uint256 internal constant ORACLE_DEVIATION_BPS_MAX = 2_000;
    /// @dev Rate limit: within one window an asset may move at most
    ///      `oracleWindowDeviationBps` from the window's opening price. The
    ///      step cap alone bounds ONE post; without the window a series of
    ///      posts compounds without limit. Both must be set (0 is refused).
    uint256 internal constant ORACLE_WINDOW_SECONDS_MIN = 15 minutes;
    uint256 internal constant ORACLE_WINDOW_SECONDS_MAX = 1 days;
    uint256 internal constant ORACLE_WINDOW_BPS_MIN     = 100;
    uint256 internal constant ORACLE_WINDOW_BPS_MAX     = 3_000;

    uint256 internal constant MAX_OI_CAP_USDC = 10_000_000;   // per side, whole USDC
    uint256 internal constant MIN_PROFIT_BPS  = 10_000;
    uint256 internal constant MAX_PROFIT_BPS  = 250_000;
    uint256 internal constant MAX_TENANT_LEVERAGE = 5;        // PerpetualExchange.MAX_LEVERAGE
    uint256 internal constant MAX_LIQUIDATION_PENALTY_BPS = 5_000;
    uint256 internal constant MAX_MARK_PREMIUM_CAP_BPS    = 200;   // PerpetualExchange.MAX_MARK_PREMIUM_CAP_BPS
    uint256 internal constant MAX_VAULT_FEE_SHARE_BPS     = 10_000;
    uint256 internal constant MAX_VAULT_REDEEM_FEE_BPS    = 300;
    uint256 internal constant VAULT_MIN_RESERVE_BPS_MIN   = 10_000;
    uint256 internal constant VAULT_MIN_RESERVE_BPS_MAX   = 20_000;
    uint256 internal constant MAX_ASSETS = 11;

    uint256 internal constant BASE_MAINNET = 8453;

    /// @dev The deployer's creation history is scanned nonce by nonce (see
    ///      `_verifyCreatedByDeployer`). A dedicated deployer key has a short
    ///      history; one above this bound is not a dedicated key.
    uint256 internal constant MAX_DEPLOYER_NONCE_SCAN = 100_000;

    /// @dev EIP-1967 slots.
    bytes32 internal constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ERC1967_ADMIN_SLOT =
        0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

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
        address  referenceSource; // shared.referenceSource — 0 when the file says "none"
        bool     guardedOracle;   // params.oracleKind: "guarded" (true) | "mock" (false)
        uint256  oracleMaxDeviationBps;     // guarded only (0 for mock)
        uint256  oracleWindowSeconds;       // guarded only
        uint256  oracleWindowDeviationBps;  // guarded only
        uint256  oiCapNonRwa;     // 18-dec, whole USDC, per side
        uint256  oiCapRwa;        // 18-dec, whole USDC, per side
        uint256  maxProfitBps;
        uint256  maxLeverage;     // written to every registered asset
        uint256  liquidationPenaltyBps;
        uint256  markPremiumCapBps;
        uint256  vaultFeeShareBps;
        bool     deployVault;
        uint256  vaultRedeemFeeBps;        // deployVault only
        uint256  vaultMinReserveRatioBps;  // deployVault only
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

    function _requireKey(string memory json, string memory key) internal view {
        require(vm.keyExistsJson(json, key), string.concat("tenant config: ", key, " is missing (no field has a default)"));
    }

    /// @dev True when the value at `key` is JSON `null`. A number (0 included)
    ///      parses as a uint; `null` does not, and `parseJson` returns one
    ///      zero word for it. Anything else (a string, an object) is neither.
    function _isNull(string memory json, string memory key) internal view returns (bool) {
        _requireKey(json, key);
        try vm.parseJsonUint(json, key) returns (uint256) {
            return false;
        } catch {}
        bytes memory raw = vm.parseJson(json, key);
        return raw.length == 32 && bytes32(raw) == bytes32(0);
    }

    function _uintRequired(string memory json, string memory key, string memory whyNotNull) internal view returns (uint256) {
        require(!_isNull(json, key), whyNotNull);
        return vm.parseJsonUint(json, key);
    }

    function _uint(string memory json, string memory key) internal view returns (uint256) {
        _requireKey(json, key);
        return vm.parseJsonUint(json, key);
    }

    /// @dev Reverts on any missing field and on any address still written as a
    ///      `<PLACEHOLDER>` — a template cannot be deployed. No field has a
    ///      default: a parameter that does not apply (the oracle limits of a
    ///      mock oracle, the vault parameters without a vault) must be written
    ///      as `null`, so a reader never sees a number that is not on chain.
    function _parseConfig(string memory json, string memory expectedId) internal view returns (TenantConfig memory c) {
        require(vm.parseJsonUint(json, ".schemaVersion") == SCHEMA_VERSION, "tenant config: schemaVersion must be 3");
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

        _requireKey(json, ".shared.referenceSource");
        string memory ref = vm.parseJsonString(json, ".shared.referenceSource");
        if (keccak256(bytes(ref)) != keccak256("none")) {
            c.referenceSource = vm.parseAddress(ref);
            require(c.referenceSource != address(0), "shared.referenceSource: write \"none\", not the zero address");
        }

        bytes32 kind = keccak256(bytes(vm.parseJsonString(json, ".params.oracleKind")));
        if (kind == keccak256("guarded")) c.guardedOracle = true;
        else if (kind == keccak256("mock")) c.guardedOracle = false;
        else revert("tenant config: params.oracleKind must be 'guarded' or 'mock'");

        if (c.guardedOracle) {
            string memory why = "tenant config: params.oracleMaxDeviationBps / oracleWindowSeconds / oracleWindowDeviationBps must be numbers for oracleKind 'guarded'";
            c.oracleMaxDeviationBps    = _uintRequired(json, ".params.oracleMaxDeviationBps", why);
            c.oracleWindowSeconds      = _uintRequired(json, ".params.oracleWindowSeconds", why);
            c.oracleWindowDeviationBps = _uintRequired(json, ".params.oracleWindowDeviationBps", why);
        } else {
            // MockOracle enforces no limit at all: a number here would describe
            // a control that does not exist on chain.
            string memory why = "tenant config: params.oracleMaxDeviationBps / oracleWindowSeconds / oracleWindowDeviationBps must be null for oracleKind 'mock' (MockOracle has no limits)";
            require(_isNull(json, ".params.oracleMaxDeviationBps") && _isNull(json, ".params.oracleWindowSeconds")
                && _isNull(json, ".params.oracleWindowDeviationBps"), why);
            require(c.referenceSource == address(0), "tenant config: shared.referenceSource must be \"none\" for oracleKind 'mock'");
        }

        // Whole USDC in the file, so the cap written on chain and the cap a
        // reader sees in the config are the same number. Bounded before the
        // 1e18 scaling so an absurd value fails with a message, not an overflow.
        uint256 capNonRwa = _uint(json, ".params.oiCapNonRwaUsdc");
        uint256 capRwa    = _uint(json, ".params.oiCapRwaUsdc");
        require(capNonRwa <= MAX_OI_CAP_USDC && capRwa <= MAX_OI_CAP_USDC,
            "params: OI caps must be in [1, 10000000] USDC per side (0 = unlimited is not allowed)");
        c.oiCapNonRwa  = capNonRwa * 1e18;
        c.oiCapRwa     = capRwa * 1e18;
        c.maxProfitBps = _uint(json, ".params.maxProfitBps");
        c.maxLeverage  = _uint(json, ".params.maxLeverage");
        c.liquidationPenaltyBps = _uint(json, ".params.liquidationPenaltyBps");
        c.markPremiumCapBps     = _uint(json, ".params.markPremiumCapBps");
        c.vaultFeeShareBps      = _uint(json, ".params.vaultFeeShareBps");

        _requireKey(json, ".params.deployVault");
        c.deployVault = vm.parseJsonBool(json, ".params.deployVault");
        if (c.deployVault) {
            string memory why = "tenant config: params.vaultRedeemFeeBps / vaultMinReserveRatioBps must be numbers when params.deployVault is true";
            c.vaultRedeemFeeBps       = _uintRequired(json, ".params.vaultRedeemFeeBps", why);
            c.vaultMinReserveRatioBps = _uintRequired(json, ".params.vaultMinReserveRatioBps", why);
        } else {
            require(_isNull(json, ".params.vaultRedeemFeeBps") && _isNull(json, ".params.vaultMinReserveRatioBps"),
                "tenant config: params.vaultRedeemFeeBps / vaultMinReserveRatioBps must be null when params.deployVault is false");
        }
        c.assets = vm.parseJsonStringArray(json, ".assets.registered");
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
        // The market operator is a hot key (on the live platform it is the
        // keeper); the owner of everything must not be one.
        require(c.admin != c.marketOperator, "roles: admin must differ from marketOperator");
        require(c.treasury != c.keeper, "roles: the keeper hot key must not be the treasury");
        require(c.treasury != c.guardian, "roles: the guardian hot key must not be the treasury");

        if (deployer != address(0)) {
            require(deployer != c.admin && deployer != c.keeper && deployer != c.guardian && deployer != c.risk
                && deployer != c.marketOperator && deployer != c.treasury,
                "roles: the deployer key must hold no tenant role (it ends the run with no privileges)");
        }

        // ── oracle ──
        if (c.guardedOracle) {
            require(c.oracleMaxDeviationBps >= ORACLE_DEVIATION_BPS_MIN && c.oracleMaxDeviationBps <= ORACLE_DEVIATION_BPS_MAX,
                "params: oracleMaxDeviationBps must be in [100, 2000] (0 = no step cap is not allowed)");
            require(c.oracleWindowSeconds >= ORACLE_WINDOW_SECONDS_MIN && c.oracleWindowSeconds <= ORACLE_WINDOW_SECONDS_MAX,
                "params: oracleWindowSeconds must be in [900, 86400]");
            require(c.oracleWindowDeviationBps >= ORACLE_WINDOW_BPS_MIN && c.oracleWindowDeviationBps <= ORACLE_WINDOW_BPS_MAX,
                "params: oracleWindowDeviationBps must be in [100, 3000] (0 = no rate limit is not allowed)");
        } else {
            require(c.referenceSource == address(0), "tenant config: shared.referenceSource must be \"none\" for oracleKind 'mock'");
        }
        if (c.referenceSource != address(0)) {
            // A post the reference confirms bypasses the step cap AND the
            // window. A reference any tenant key can write is no cross-check.
            address r = c.referenceSource;
            require(r != c.admin && r != c.risk && r != c.guardian && r != c.keeper && r != c.marketOperator
                && r != c.treasury && r != c.usdc && (deployer == address(0) || r != deployer),
                "shared.referenceSource must be an independent feed, not a tenant role address or the settlement token");
        }

        // ── exchange ──
        // 0 = unlimited on the exchange; a tenant never launches unlimited.
        require(c.oiCapNonRwa > 0 && c.oiCapRwa > 0 && c.oiCapNonRwa <= MAX_OI_CAP_USDC * 1e18 && c.oiCapRwa <= MAX_OI_CAP_USDC * 1e18,
            "params: OI caps must be in [1, 10000000] USDC per side (0 = unlimited is not allowed)");
        require(c.maxProfitBps >= MIN_PROFIT_BPS && c.maxProfitBps <= MAX_PROFIT_BPS,
            "params: maxProfitBps must be in [10000, 250000] (0 = off is not allowed)");
        // 0 on the exchange means "the global MAX_LEVERAGE": never written as 0.
        require(c.maxLeverage >= 1 && c.maxLeverage <= MAX_TENANT_LEVERAGE, "params: maxLeverage must be in [1, 5]");
        require(c.liquidationPenaltyBps <= MAX_LIQUIDATION_PENALTY_BPS, "params: liquidationPenaltyBps must be in [0, 5000]");
        require(c.markPremiumCapBps <= MAX_MARK_PREMIUM_CAP_BPS, "params: markPremiumCapBps must be in [0, 200]");
        require(c.vaultFeeShareBps <= MAX_VAULT_FEE_SHARE_BPS, "params: vaultFeeShareBps must be in [0, 10000]");

        // ── vault ──
        // The hardened vault on an oracle with no deviation cap is not hardened.
        require(!c.deployVault || c.guardedOracle, "params: deployVault requires oracleKind 'guarded'");
        if (c.deployVault) {
            require(c.vaultRedeemFeeBps <= MAX_VAULT_REDEEM_FEE_BPS, "params: vaultRedeemFeeBps must be in [0, 300]");
            require(c.vaultMinReserveRatioBps >= VAULT_MIN_RESERVE_BPS_MIN && c.vaultMinReserveRatioBps <= VAULT_MIN_RESERVE_BPS_MAX,
                "params: vaultMinReserveRatioBps must be in [10000, 20000]");
        }

        require(c.assets.length > 0 && c.assets.length <= MAX_ASSETS, "assets.registered: 1 to 11 assets");
        for (uint256 i = 0; i < c.assets.length; i++) {
            _tokenName(c.assets[i]);   // reverts on an unknown symbol
            for (uint256 j = i + 1; j < c.assets.length; j++) {
                require(keccak256(bytes(c.assets[i])) != keccak256(bytes(c.assets[j])), "assets.registered: duplicate symbol");
            }
        }
    }

    /// @notice The config checks that depend on the chain the run is on.
    function _validateForChain(TenantConfig memory c) internal view {
        if (block.chainid == BASE_MAINNET && c.guardedOracle) {
            require(c.referenceSource != address(0), "shared.referenceSource must be set on Base mainnet");
        }
        if (c.referenceSource != address(0)) {
            require(c.referenceSource.code.length > 0, "shared.referenceSource has no code on this chain");
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
        // Self-reported. `_verifyCreatedByDeployer` proves it from chain state.
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

    /// @dev Numeric read-back against the config: reverts with the field name.
    function _eqUint(string memory field, uint256 got, uint256 want) internal pure {
        if (got != want) {
            console.log("MISMATCH", field);
            console.log("  got  :", got);
            console.log("  want :", want);
            revert(string.concat("verify tenant mismatch: ", field));
        }
        console.log("ok  ", field, got);
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
        _verifyProxies(c, d);
        _verifyOwnership(c, d, owner);
        _verifyCreatedByDeployer(c, d);
        _verifyDeployerHasNothing(c, d, owner);
    }

    /// @dev Every contract of the set, with a name for error messages. The
    ///      tokens come last, in `assets.registered` order.
    function _tenantContracts(TenantConfig memory c, TenantDeployed memory d)
        internal pure returns (string[] memory names, address[] memory all)
    {
        uint256 n = 10 + (c.deployVault ? 2 + d.tokens.length : 0);
        names = new string[](n);
        all = new address[](n);
        (names[0], all[0]) = ("Oracle", d.oracle);
        (names[1], all[1]) = ("ESGRegistryV2", d.esgRegistry);
        (names[2], all[2]) = ("KYCRegistry", d.kyc);
        (names[3], all[3]) = ("InsuranceVault", d.insuranceVault);
        (names[4], all[4]) = ("FeeRouter", d.feeRouter);
        (names[5], all[5]) = ("TraderStake", d.traderStake);
        (names[6], all[6]) = ("PerpetualExchange", d.exchange);
        (names[7], all[7]) = ("StrategyRegistry", d.strategyRegistry);
        (names[8], all[8]) = ("CopyTracker", d.copyTracker);
        (names[9], all[9]) = ("AgentSessionManager", d.sessionManager);
        if (c.deployVault) {
            (names[10], all[10]) = ("AssetVaultV2", d.assetVault);
            (names[11], all[11]) = ("AssetVaultV2Impl", d.assetVaultImpl);
            for (uint256 i = 0; i < d.tokens.length; i++) {
                (names[12 + i], all[12 + i]) = (string.concat("token ", c.assets[i]), d.tokens[i]);
            }
        }
    }

    /// @dev Isolation at its most basic: every contract of the set exists, is
    ///      its own address, and is none of the shared or role addresses.
    function _verifyDistinct(TenantConfig memory c, TenantDeployed memory d) internal view {
        if (c.deployVault) {
            require(d.tokens.length == c.assets.length, "verify tenant failed: one token per registered asset");
        } else {
            require(d.assetVault == address(0) && d.assetVaultImpl == address(0) && d.tokens.length == 0,
                "verify tenant failed: params.deployVault is false but the record carries a vault");
        }
        (, address[] memory all) = _tenantContracts(c, d);
        uint256 n = all.length;
        for (uint256 i = 0; i < n; i++) {
            require(all[i].code.length > 0, "verify tenant failed: a recorded contract has no code on this chain");
            require(all[i] != c.usdc && all[i] != c.priceSource && all[i] != c.referenceSource,
                "verify tenant failed: a tenant contract is the shared settlement token / price source / reference source");
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
        _eqUint("exchange.maxPriceAge", ex.maxPriceAge(), MAX_PRICE_AGE);
        _eqUint("exchange.executionFee", ex.executionFee(), EXECUTION_FEE);
        _check(ex.adlEnabled() == ADL_ENABLED, "exchange.adlEnabled == true");
        _check(!ex.paused(), "exchange not paused");
        _eqUint("exchange.liquidationPenaltyBps", ex.liquidationPenaltyBps(), c.liquidationPenaltyBps);
        _eqUint("exchange.markPremiumCapBps", ex.markPremiumCapBps(), c.markPremiumCapBps);
        _eqUint("exchange.vaultFeeShareBps", ex.vaultFeeShareBps(), c.vaultFeeShareBps);
        // Not charged while the ESG registry is wired (see the constants).
        _eqUint("exchange.TRADING_FEE_BPS (legacy, contract default)", ex.TRADING_FEE_BPS(), LEGACY_TRADING_FEE_BPS);
        _eqUint("exchange.BORROW_FEE_BPS_PER_HOUR (legacy, contract default)", ex.BORROW_FEE_BPS_PER_HOUR(), LEGACY_BORROW_FEE_BPS_PER_HOUR);
        // The getter CopyTracker's slash scoring depends on — absent on any
        // build older than the hardened one.
        ex.closeReasonOf(0);
        console.log("ok   exchange.closeReasonOf present (hardened build)");

        console.log("--- risk caps (per asset) ---");
        for (uint256 i = 0; i < c.assets.length; i++) _verifyAssetRisk(ex, c, c.assets[i]);

        console.log("--- agents ---");
        _check(ex.authorizedAgents(d.sessionManager), "AgentSessionManager authorised on the exchange");
        _check(ex.authorizedAgents(d.copyTracker), "CopyTracker authorised on the exchange");
        _eq("sessionManager.exchange", address(AgentSessionManager(d.sessionManager).exchange()), d.exchange);
    }

    function _verifyAssetRisk(PerpetualExchange ex, TenantConfig memory c, string memory sym) internal view {
        bytes32 id = _assetId(sym);
        bool rwa = _isRwa(sym);
        if (ex.rwaAsset(id) != rwa) revert(string.concat("verify tenant failed: rwaAsset flag ", sym));
        uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
        if (ex.maxLongOI(id) != cap || ex.maxShortOI(id) != cap) {
            revert(string.concat("verify tenant failed: OI cap != config for ", sym));
        }
        if (ex.maxProfitBps(id) != c.maxProfitBps) revert(string.concat("verify tenant failed: maxProfitBps for ", sym));
        if (ex.maxLeverageOf(id) != c.maxLeverage) revert(string.concat("verify tenant failed: maxLeverage for ", sym));
        console.log(string.concat("ok   ", sym, rwa ? " (RWA)" : ""), "OI/side USDC", cap / 1e18);
        // Informational: what a trader actually gets today (carbon tier ∧ the override).
        console.log("       effective trading fee bps / max leverage:", ex.tradingFeeBpsForAsset(id), ex.maxLeverageForAsset(id));
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
        if (!c.guardedOracle) {
            // MockOracle: the owner IS the price writer. Testnet only.
            _eq("mockOracle.owner (price writer)", Ownable(d.oracle).owner(), c.keeper);
            console.log("NOTE oracleKind is 'mock': no step cap, no rate limit, no reference source - the keeper key writes any price (testnet only)");
            _verifyMockPrices(c, d);
            return;
        }
        ITenantGuardedOracle o = ITenantGuardedOracle(d.oracle);
        _check(_has(d.oracle, ADMIN_ROLE, owner), "GuardedOracle admin is the tenant owner");
        _check(_has(d.oracle, KEEPER_ROLE, c.keeper), "GuardedOracle KEEPER_ROLE is the tenant keeper");
        _check(_has(d.oracle, GUARDIAN_ROLE, c.guardian), "GuardedOracle GUARDIAN_ROLE is the tenant guardian");
        _check(!_has(d.oracle, KEEPER_ROLE, c.guardian) && !_has(d.oracle, GUARDIAN_ROLE, c.keeper),
            "keeper cannot freeze, guardian cannot post prices");

        // The guards on what one keeper key can do. Each must equal the config
        // and none may be off.
        _check(o.maxDeviationBps() != 0, "oracle step cap is on (maxDeviationBps != 0)");
        _eqUint("oracle.maxDeviationBps", o.maxDeviationBps(), c.oracleMaxDeviationBps);
        _check(o.maxWindowDeviationBps() != 0 && o.windowDuration() != 0, "oracle rate limit is on (window != 0)");
        _eqUint("oracle.windowDuration", o.windowDuration(), c.oracleWindowSeconds);
        _eqUint("oracle.maxWindowDeviationBps", o.maxWindowDeviationBps(), c.oracleWindowDeviationBps);
        _eqUint("oracle.maxPriceAge (0: readers enforce staleness)", o.maxPriceAge(), ORACLE_MAX_PRICE_AGE);
        _eq("oracle.referenceSource", o.referenceSource(), c.referenceSource);
        if (c.referenceSource == address(0)) {
            if (block.chainid == BASE_MAINNET) revert("verify tenant failed: shared.referenceSource must be set on Base mainnet");
            console.log(string.concat(
                "NOTE oracle has no reference source (", unicode"無參考來源",
                "): keeper posts are bounded by the step cap and the window limit only"
            ));
        }
        _check(!o.paused(), "oracle not paused");

        // A missing asset is a wiring failure. A stale or frozen one is the
        // keeper's / guardian's state, reported and not failed — same split as
        // Verify130.
        uint256 attention;
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            (uint256 p, uint256 at, bool exists, bool frozen) = o.peek(_assetId(sym));
            if (!exists || p == 0) revert(string.concat("verify tenant failed: oracle has no price for ", sym));
            if (frozen) {
                attention++;
                console.log(string.concat("WARN ", sym, " frozen by the guardian"));
            } else if (block.timestamp > at + MAX_PRICE_AGE) {
                attention++;
                console.log(string.concat("WARN ", sym, " price older than 6h - dispatch the tenant keeper"));
            }
        }
        if (attention == 0) console.log("ok   every registered asset priced and fresh on the tenant oracle");
        else console.log("WARN assets without a fresh, unfrozen quote:", attention);
    }

    function _verifyMockPrices(TenantConfig memory c, TenantDeployed memory d) internal view {
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
                console.log(string.concat("WARN ", sym, " oracle refused to quote (stale / not added?) - dispatch the tenant keeper"));
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
        _eqUint("vault.redeemFeeBps", v.redeemFeeBps(), c.vaultRedeemFeeBps);
        _eqUint("vault.minReserveRatioBps", v.minReserveRatioBps(), c.vaultMinReserveRatioBps);
        _eqUint("vault.maxPriceAge", v.maxPriceAge(), VAULT_MAX_PRICE_AGE);
        try v.effectiveMaxPriceAge() returns (uint256 eff) {
            _check(eff <= MAX_PRICE_AGE, "vault.effectiveMaxPriceAge <= 6h");
        } catch {
            console.log("NOTE vault has no effectiveMaxPriceAge() (pre-V2.5 implementation)");
        }
        // Operational state, set by the tenant's risk / guardian keys after
        // launch: reported, not failed.
        console.log("vault paused / mintingHalted:", v.paused(), v.mintingHalted());
        for (uint256 i = 0; i < c.assets.length; i++) {
            address token = d.tokens[i];
            bytes32 id = _assetId(c.assets[i]);
            if (v.assetToken(id) != token) {
                revert(string.concat("verify tenant failed: vault.assetToken for ", c.assets[i]));
            }
            if (!_has(token, MINTER_ROLE, d.assetVault)) {
                revert(string.concat("verify tenant failed: vault is not the minter of ", c.assets[i]));
            }
            if (!_has(token, ADMIN_ROLE, owner)) {
                revert(string.concat("verify tenant failed: token admin is not the tenant owner for ", c.assets[i]));
            }
            console.log(string.concat("     ", c.assets[i], " assetCap (0 = closed to minting):"), v.assetCap(id));
        }
        console.log("ok   tokens registered, minted only by the vault, administered by the owner:", c.assets.length);
    }

    /// @dev Every proxy of the set runs the implementation this deployment
    ///      recorded, and is UUPS (no proxy admin). An upgrade after the
    ///      handover — to anything — fails here until the record is updated
    ///      through review. Written as a list so a future proxy is one line.
    function _verifyProxies(TenantConfig memory c, TenantDeployed memory d) internal view {
        console.log("--- ERC-1967 proxies ---");
        uint256 n = c.deployVault ? 1 : 0;
        string[] memory names = new string[](n);
        address[] memory proxies = new address[](n);
        address[] memory impls = new address[](n);
        if (c.deployVault) (names[0], proxies[0], impls[0]) = ("AssetVaultV2", d.assetVault, d.assetVaultImpl);
        for (uint256 i = 0; i < n; i++) {
            address impl = address(uint160(uint256(vm.load(proxies[i], ERC1967_IMPLEMENTATION_SLOT))));
            if (impl != impls[i]) {
                console.log("MISMATCH implementation of", names[i]);
                console.log("  got  :", impl);
                console.log("  want :", impls[i]);
                revert(string.concat("verify tenant failed: ", names[i], " implementation slot != the recorded implementation"));
            }
            if (vm.load(proxies[i], ERC1967_ADMIN_SLOT) != bytes32(0)) {
                revert(string.concat("verify tenant failed: ", names[i], " has an ERC-1967 proxy admin (expected UUPS, none)"));
            }
            console.log(string.concat("ok   ", names[i], " implementation == recorded, no proxy admin"));
        }
        if (n == 0) console.log("ok   no proxies in this tenant");
    }

    /// @dev Who ends up holding what. The owner is not a hot key; no hot key
    ///      (or the treasury) holds DEFAULT_ADMIN anywhere; on mainnet the
    ///      owner is a contract (multisig / timelock).
    function _verifyOwnership(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        console.log("--- final ownership ---");
        _check(owner != c.keeper && owner != c.guardian && owner != c.risk && owner != c.marketOperator,
            "the owner is not a hot key (keeper / guardian / risk / marketOperator)");
        if (block.chainid == BASE_MAINNET) _check(owner.code.length > 0, "the owner is a contract on Base mainnet");

        address[5] memory others = [c.keeper, c.guardian, c.risk, c.marketOperator, c.treasury];
        uint256 n = 1 + (c.guardedOracle ? 1 : 0) + (c.deployVault ? 1 + d.tokens.length : 0);
        address[] memory ac = new address[](n);
        uint256 k;
        ac[k++] = d.esgRegistry;
        if (c.guardedOracle) ac[k++] = d.oracle;
        if (c.deployVault) {
            ac[k++] = d.assetVault;
            for (uint256 i = 0; i < d.tokens.length; i++) ac[k++] = d.tokens[i];
        }
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = 0; j < others.length; j++) {
                // The treasury may legitimately be the admin multisig itself.
                if (others[j] == owner) continue;
                if (_has(ac[i], ADMIN_ROLE, others[j])) {
                    console.log("unexpected DEFAULT_ADMIN_ROLE holder", others[j], "on", ac[i]);
                    revert("verify tenant failed: a tenant role other than the owner holds DEFAULT_ADMIN_ROLE");
                }
            }
        }
        console.log("ok   no keeper / guardian / risk / marketOperator / treasury key holds DEFAULT_ADMIN_ROLE:", n);
    }

    /// @dev The record's `deployer` is written by the run itself and copied by
    ///      a human; on its own it proves nothing, and every "the deployer
    ///      keeps nothing" check below is only as good as it. A CREATE address
    ///      is keccak(rlp(sender, nonce)): every contract of the set must
    ///      derive from the recorded deployer at some nonce it has already
    ///      used. A record naming any other address fails here.
    function _verifyCreatedByDeployer(TenantConfig memory c, TenantDeployed memory d) internal view {
        console.log("--- the recorded deployer created the set ---");
        (string[] memory names, address[] memory all) = _tenantContracts(c, d);
        uint256 nonce = vm.getNonce(d.deployer);
        require(nonce <= MAX_DEPLOYER_NONCE_SCAN,
            "verify tenant failed: the recorded deployer's nonce is above the scan limit (100000) - not a dedicated deployer key");
        bool[] memory found = new bool[](all.length);
        uint256 left = all.length;
        for (uint256 k = 0; k < nonce && left > 0; k++) {
            address a = vm.computeCreateAddress(d.deployer, k);
            for (uint256 j = 0; j < all.length; j++) {
                if (!found[j] && all[j] == a) {
                    found[j] = true;
                    left--;
                    break;
                }
            }
        }
        for (uint256 j = 0; j < all.length; j++) {
            if (!found[j]) {
                revert(string.concat("verify tenant failed: ", names[j], " was not created by the recorded deployer"));
            }
        }
        console.log("ok   every contract derives from the recorded deployer's CREATE nonces:", all.length);
    }

    /// @dev The deployer is a CI hot key. A finished tenant leaves it nothing.
    function _verifyDeployerHasNothing(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        address dep = d.deployer;
        console.log("--- deployer key retains nothing ---");
        _check(dep != owner, "deployer is not the owner");
        _check(dep != address(0), "deployer recorded");
        PerpetualExchange ex = PerpetualExchange(d.exchange);
        _check(ex.owner() != dep && ex.guardian() != dep && ex.marketOperator() != dep,
            "deployer is not the exchange owner / guardian / marketOperator");
        _check(!ex.authorizedAgents(dep), "deployer is not an authorised agent on the exchange");
        address[6] memory owned = [d.exchange, d.copyTracker, d.insuranceVault, d.feeRouter, d.traderStake, d.kyc];
        for (uint256 i = 0; i < owned.length; i++) {
            if (Ownable(owned[i]).owner() == dep) revert("verify tenant failed: deployer still owns an Ownable contract of the set");
        }
        _check(!KYCRegistry(d.kyc).verifiers(dep), "deployer is not a KYC verifier");
        if (c.guardedOracle) {
            _check(!_has(d.oracle, ADMIN_ROLE, dep) && !_has(d.oracle, GUARDIAN_ROLE, dep) && !_has(d.oracle, KEEPER_ROLE, dep),
                "deployer has no role on the oracle");
        } else {
            _check(Ownable(d.oracle).owner() != dep, "deployer does not own the mock oracle");
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
        _validateForChain(c);
        // The config, not the record, says who should own the tenant.
        _verifyTenant(c, d, vm.envOr("EXPECTED_OWNER", c.admin));
        console.log("");
        console.log("=== tenant wiring verified. Frontend registry, keeper environment and signal-api still to do (docs/TENANT_OPERATIONS.md). ===");
    }
}
