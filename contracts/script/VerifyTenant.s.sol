// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/StrategyRegistry.sol";
import "../src/AgentSessionManager.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/InsuranceSeeder.sol";
import "../src/KYCRegistry.sol";
import "../src/VCKycRegistry.sol";

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
    function isUnpricedExempt(bytes32 assetId) external view returns (bool);
}

interface ITenantEsgRegistry {
    function maxAttestationAge() external view returns (uint256);
}

interface ITenantSyntheticAsset {
    function assetId() external view returns (bytes32);
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
    function freezeOf(bytes32 assetId)
        external view returns (bool inForce, uint256 since, uint256 expiresAt, uint256 guardianWindowEnd);
    function pauseState()
        external view returns (bool inForce, uint256 since, uint256 expiresAt, uint256 guardianWindowEnd);
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

    uint256 internal constant SCHEMA_VERSION = 4;

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

    /// @dev The tenant's InsuranceVault is seeded with exactly one whole
    ///      settlement token before anything can flow into it. With zero
    ///      supply, every inflow accrues to the virtual shares for good
    ///      (INSURANCE_VAULT_SHARES.md §3.3); the seed closes that before the
    ///      fee router and exchange are wired. The shares go to the tenant's
    ///      treasury: the deployer keeps nothing.
    uint256 internal constant INSURANCE_SEED_WHOLE_TOKENS = 1;
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
    // is used, and its test reads these constants and compares them with its
    // own table — keep the two in step when changing one.
    //
    // The oracle bounds are never looser than the live platform's own oracle
    // (RedeployGuardedOracle.s.sol: step 1000 bps, window 3600 s, window cap
    // 2500 bps). What they buy is a speed limit, not a ceiling: with window d
    // seconds and window cap W, a keeper key moves a price by at most
    // (1+W)^(floor(T/d)+1) within T seconds (downwards likewise). At the
    // platform values that is 1.25x in 1h, 3.05x in 6h and ~169x in 24h. The
    // controls that end a misuse are the keeper key's protection, the reference
    // source, monitoring alerts and the guardian's pause (docs/TENANT_OPERATIONS.md).
    /// @dev Per-post step cap of the tenant's GuardedOracle. With a reference
    ///      source it is also the band around the reference inside which a
    ///      post counts as confirmed (and skips the window): +-10% at most.
    uint256 internal constant ORACLE_DEVIATION_BPS_MIN = 100;
    uint256 internal constant ORACLE_DEVIATION_BPS_MAX = 1_000;
    /// @dev Rate limit: within one window an asset may move at most
    ///      `oracleWindowDeviationBps` from the window's opening price. The
    ///      step cap alone bounds ONE post; without the window a series of
    ///      posts compounds without limit. Both must be set (0 is refused).
    uint256 internal constant ORACLE_WINDOW_SECONDS_MIN = 1 hours;
    uint256 internal constant ORACLE_WINDOW_SECONDS_MAX = 1 days;
    uint256 internal constant ORACLE_WINDOW_BPS_MIN     = 100;
    uint256 internal constant ORACLE_WINDOW_BPS_MAX     = 2_500;

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
    bytes32 internal constant ERC1967_BEACON_SLOT =
        0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    /// @dev Foundry's build output, relative to the project root (`out/<File>/<Contract>.json`).
    ///      `foundry.toml` grants read access to exactly this directory, for
    ///      `deployedBytecode.immutableReferences` / `linkReferences`.
    string internal constant ARTIFACTS_DIR = "out/";

    /// @dev ESGRegistryV2's constructor value. DeployTenant does not change it.
    uint256 internal constant ESG_MAX_ATTESTATION_AGE = 180 days;

    // Events the privilege-holder history is rebuilt from (`_privilegeHistory`).
    bytes32 internal constant ROLE_GRANTED_TOPIC = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 internal constant AGENT_SET_TOPIC    = keccak256("AgentAuthorizationSet(address,bool)");
    bytes32 internal constant VERIFIER_SET_TOPIC = keccak256("VerifierSet(address,bool)");
    bytes32 internal constant ISSUER_SET_TOPIC   = keccak256("IssuerSet(address,bytes32,bool,uint64)");
    /// @dev Pseudo-roles for the two privilege lists that are mappings, not
    ///      AccessControl roles: the exchange's authorised agents and the KYC
    ///      registry's verifiers.
    bytes32 internal constant EXCHANGE_AGENT = keccak256("tenant-verify: PerpetualExchange.authorizedAgents");
    bytes32 internal constant KYC_VERIFIER   = keccak256("tenant-verify: KYCRegistry.verifiers");
    /// @dev `params.kycRegistry: "vc"`: VCKycRegistry's trusted credential
    ///      issuers (`issuerTypeCount > 0`). Like a KYC verifier, an
    ///      appointment the admin makes after launch.
    bytes32 internal constant VC_ISSUER      = keccak256("tenant-verify: VCKycRegistry.trustedIssuer");
    /// @dev The credential type a VC-gated tenant's `isVerified` requires.
    bytes32 internal constant QUALIFIED_INVESTOR = keccak256("QUALIFIED_INVESTOR");
    bytes32 internal constant KYC_BASIC          = keccak256("KYC_BASIC");

    bytes32 internal constant ADMIN_ROLE    = 0x00;
    bytes32 internal constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 internal constant RISK_ROLE     = keccak256("RISK_ROLE");
    bytes32 internal constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 internal constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 internal constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

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
        /// @dev params.kycRegistry: "allowlist" (false) = KYCRegistry, verifiers
        ///      flip a flag; "vc" (true) = VCKycRegistry, an investor submits a
        ///      credential a trusted issuer signed (docs/SSI_RWA_ACCESS.md).
        bool     vcKyc;
        /// @dev assets.additionalRwa: registered assets the tenant gates as RWA
        ///      on top of the built-in eight (`_isRwa`). Only adds: a built-in
        ///      RWA asset can never be listed, so none can be switched off.
        string[] additionalRwa;
    }

    struct TenantDeployed {
        address   deployer;
        /// @dev A block at or before the first transaction of the deployment
        ///      (the chain head when the run started). The privilege-holder
        ///      history is read from here on.
        uint256   deployBlock;
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
        /// @dev Seeds the InsuranceVault and hands the shares to the treasury
        ///      in one transaction (`InsuranceSeeder`). Stateless, no owner,
        ///      no role anywhere; listed so the set checks cover it.
        address   insuranceSeeder;
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
        require(vm.parseJsonUint(json, ".schemaVersion") == SCHEMA_VERSION, "tenant config: schemaVersion must be 4");
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

        _requireKey(json, ".params.kycRegistry");
        bytes32 kyc = keccak256(bytes(vm.parseJsonString(json, ".params.kycRegistry")));
        if (kyc == keccak256("vc")) c.vcKyc = true;
        else if (kyc != keccak256("allowlist")) revert("tenant config: params.kycRegistry must be 'allowlist' or 'vc'");
        _requireKey(json, ".assets.additionalRwa");
        c.additionalRwa = _stringArray(json, ".assets.additionalRwa");
    }

    /// @dev A JSON array of JSON strings, nothing else. `parseJsonStringArray`
    ///      refuses a string, an object and `null`, but turns `1` / `true`
    ///      elements into "1" / "true"; so each element is read back raw and
    ///      must ABI-decode as a string (offset word 0x20 + length), not as a
    ///      32-byte number or bool.
    function _stringArray(string memory json, string memory key) internal view returns (string[] memory out) {
        string memory why = string.concat("tenant config: ", key, " must be a JSON array of strings");
        try vm.parseJsonStringArray(json, key) returns (string[] memory a) {
            out = a;
        } catch {
            revert(why);
        }
        for (uint256 i = 0; i < out.length; i++) {
            bytes memory raw = vm.parseJson(json, string.concat(key, "[", vm.toString(i), "]"));
            require(raw.length >= 64 && uint256(bytes32(raw)) == 0x20, why);
        }
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
                "params: oracleMaxDeviationBps must be in [100, 1000] (0 = no step cap is not allowed)");
            require(c.oracleWindowSeconds >= ORACLE_WINDOW_SECONDS_MIN && c.oracleWindowSeconds <= ORACLE_WINDOW_SECONDS_MAX,
                "params: oracleWindowSeconds must be in [3600, 86400]");
            require(c.oracleWindowDeviationBps >= ORACLE_WINDOW_BPS_MIN && c.oracleWindowDeviationBps <= ORACLE_WINDOW_BPS_MAX,
                "params: oracleWindowDeviationBps must be in [100, 2500] (0 = no rate limit is not allowed)");
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
            // The price source seeds the oracle and is written by the platform
            // keeper: as its own cross-check it confirms nothing.
            require(r != c.priceSource, "shared.referenceSource must differ from shared.priceSource (a second, independent feed)");
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
        for (uint256 i = 0; i < c.additionalRwa.length; i++) {
            string memory sym = c.additionalRwa[i];
            require(_inList(c.assets, sym), string.concat("assets.additionalRwa: ", sym, " is not in assets.registered"));
            require(!_isRwa(sym), string.concat("assets.additionalRwa: ", sym, " is already RWA (built in) - the list only adds"));
            for (uint256 j = i + 1; j < c.additionalRwa.length; j++) {
                require(keccak256(bytes(sym)) != keccak256(bytes(c.additionalRwa[j])), "assets.additionalRwa: duplicate symbol");
            }
        }
    }

    function _inList(string[] memory list, string memory sym) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) if (keccak256(bytes(list[i])) == keccak256(bytes(sym))) return true;
        return false;
    }

    /// @dev What the tenant's exchange gates: the built-in eight plus the
    ///      config's `assets.additionalRwa`. Never fewer than `_isRwa`.
    function _isRwaFor(TenantConfig memory c, string memory sym) internal pure returns (bool) {
        return _isRwa(sym) || _inList(c.additionalRwa, sym);
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
        vm.serializeAddress(k, "InsuranceSeeder", d.insuranceSeeder);
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
        vm.serializeUint(r, "deployBlock", d.deployBlock);
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
        require(vm.keyExistsJson(json, ".deployBlock"), "deployment record: deployBlock is missing (written by DeployTenant since PR #228)");
        d.deployBlock       = vm.parseJsonUint(json, ".deployBlock");
        d.oracle            = vm.parseJsonAddress(json, ".contracts.Oracle");
        d.esgRegistry       = vm.parseJsonAddress(json, ".contracts.ESGRegistryV2");
        d.kyc               = vm.parseJsonAddress(json, ".contracts.KYCRegistry");
        d.insuranceVault    = vm.parseJsonAddress(json, ".contracts.InsuranceVault");
        require(vm.keyExistsJson(json, ".contracts.InsuranceSeeder"),
            "deployment record: contracts.InsuranceSeeder is missing (written by DeployTenant since PR #256)");
        d.insuranceSeeder   = vm.parseJsonAddress(json, ".contracts.InsuranceSeeder");
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

    function _insuranceSeed(address usdc) internal view returns (uint256) {
        return INSURANCE_SEED_WHOLE_TOKENS * 10 ** IERC20Metadata(usdc).decimals();
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
        _verifyCode(c, d);
        _verifyExchange(c, d, owner);
        _verifyPeriphery(c, d, owner);
        _verifyOracle(c, d, owner);
        _verifyVault(c, d, owner);
        _verifyProxies(c, d);
        _verifyOwnership(c, d, owner);
        _verifyCreatedByDeployer(c, d);
        _verifyDeployerHasNothing(c, d, owner);
        _verifyPrivilegeHolders(c, d, owner);
    }

    /// @dev Every contract of the set, with a name for error messages. The
    ///      tokens follow the vault, in `assets.registered` order; the
    ///      InsuranceSeeder is the very last entry.
    function _tenantContracts(TenantConfig memory c, TenantDeployed memory d)
        internal pure returns (string[] memory names, address[] memory all)
    {
        uint256 n = 11 + (c.deployVault ? 2 + d.tokens.length : 0);
        names = new string[](n);
        all = new address[](n);
        // Last, so the vault entries keep their indices.
        (names[n - 1], all[n - 1]) = ("InsuranceSeeder", d.insuranceSeeder);
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
        // A guardian pause lapses on its own (an incident, reported). A pause
        // with no expiry is the owner's — or the deployer's, left by a run that
        // never reached its last step: the deployment is not open.
        if (ex.paused()) {
            uint256 until = ex.pauseExpiresAt();
            if (until == 0) revert("verify tenant failed: exchange paused with no expiry (an owner pause; only the owner lifts it)");
            console.log("WARN exchange paused by the guardian; lapses on its own at (unix):", until);
        } else {
            console.log("ok   exchange not paused");
        }
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
        bool rwa = _isRwaFor(c, sym);
        if (ex.rwaAsset(id) != rwa) revert(string.concat("verify tenant failed: rwaAsset flag ", sym));
        uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
        if (ex.maxLongOI(id) != cap || ex.maxShortOI(id) != cap) {
            revert(string.concat("verify tenant failed: OI cap != config for ", sym));
        }
        if (ex.maxProfitBps(id) != c.maxProfitBps) revert(string.concat("verify tenant failed: maxProfitBps for ", sym));
        if (ex.maxLeverageOf(id) != c.maxLeverage) revert(string.concat("verify tenant failed: maxLeverage for ", sym));
        // DeployTenant leaves the per-asset maintenance margin at the contract
        // default (0 = DEFAULT_MAINTENANCE_MARGIN_BPS); the config has no field for it.
        if (ex.maintenanceMarginBpsOf(id) != 0) {
            revert(string.concat("verify tenant failed: maintenanceMarginBpsOf for ", sym, " (expected 0 = the contract default)"));
        }
        // Reduce-only / halted is an incident decision (guardian or owner): reported.
        PerpetualExchange.AssetMode mode = ex.assetMode(id);
        if (mode == PerpetualExchange.AssetMode.ReduceOnly) console.log(string.concat("WARN ", sym, " asset mode is ReduceOnly"));
        else if (mode == PerpetualExchange.AssetMode.Halted) console.log(string.concat("WARN ", sym, " asset mode is Halted"));
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
        // §3.3: a wired vault at zero supply hands every inflow to the virtual
        // shares. Only that invariant is checked here, every day: nobody but a
        // share holder can break it. What the seed was worth and who held it
        // is checked once, by DeployTenant at deposit time — afterwards anyone
        // can deposit and send shares to the deployer, and a bailout lowers
        // the share price, so neither belongs in a daily required check.
        _check(iv.totalSupply() > 0, "insuranceVault is seeded (totalSupply > 0, INSURANCE_VAULT_SHARES.md 3.3)");
        uint256 treasuryShares = iv.balanceOf(c.treasury);
        if (treasuryShares == 0) {
            // The treasury's own decision (it moved or redeemed the seed);
            // supply is still > 0, so the §3.3 protection holds for now.
            console.log("NOTE insuranceVault: the treasury holds no shares any more - supply is still > 0, but if the remaining holders exit, inflows go to the virtual shares (INSURANCE_VAULT_SHARES.md 3.3)");
        } else {
            console.log("ok   insuranceVault.balanceOf(treasury) > 0:", treasuryShares);
        }
        FeeRouter fr = FeeRouter(d.feeRouter);
        _eq("feeRouter.usdc", address(fr.usdc()), c.usdc);
        _eq("feeRouter.platformTreasury", fr.platformTreasury(), c.treasury);
        _eq("feeRouter.insuranceVault", address(fr.insuranceVault()), d.insuranceVault);
        _eq("feeRouter.exchange", fr.exchange(), d.exchange);
        _eq("feeRouter.copyTracker", fr.copyTracker(), d.copyTracker);
        _eq("feeRouter.owner", fr.owner(), owner);

        console.log(c.vcKyc ? "--- VCKycRegistry / ESGRegistryV2 ---" : "--- KYCRegistry / ESGRegistryV2 ---");
        _eq("kyc.owner", Ownable(d.kyc).owner(), owner);
        if (c.vcKyc) _verifyVcKyc(d);
        _check(_has(d.esgRegistry, ADMIN_ROLE, owner), "ESGRegistryV2 admin is the tenant owner");
        _eqUint("esgRegistry.maxAttestationAge (contract default)",
            ITenantEsgRegistry(d.esgRegistry).maxAttestationAge(), ESG_MAX_ATTESTATION_AGE);
    }

    /// @dev The VC registry's own settings. The EIP-712 immutables are masked
    ///      by the code check; the domain separator proves them (an investor's
    ///      credential only verifies against this name, version, chain, address).
    function _verifyVcKyc(TenantDeployed memory d) internal view {
        VCKycRegistry v = VCKycRegistry(d.kyc);
        // Ownable2Step: a transfer the admin has started but not finished is
        // not the configured state.
        _eq("vcKyc.pendingOwner", v.pendingOwner(), address(0));
        _check(v.requiredType() == QUALIFIED_INVESTOR, "vcKyc.requiredType == QUALIFIED_INVESTOR");
        bytes32 want = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("PepeLabVCKycRegistry"), keccak256("1"), block.chainid, d.kyc));
        _check(v.domainSeparator() == want, "vcKyc.domainSeparator == EIP-712(PepeLabVCKycRegistry, 1, this chain, this address)");
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
        // Same split as the exchange: a guardian pause has an expiry and is an
        // incident (reported); a pause with none is the admin's (failed).
        {
            (bool pausedNow, , uint256 until, ) = o.pauseState();
            if (pausedNow) {
                if (until == 0) revert("verify tenant failed: oracle paused with no expiry (an admin pause; only the admin lifts it)");
                console.log("WARN oracle paused by the guardian; lapses on its own at (unix):", until);
            } else {
                console.log("ok   oracle not paused");
            }
        }

        // A missing asset is a wiring failure. A stale or frozen one is the
        // keeper's / guardian's / admin's state, reported and not failed —
        // same split as Verify130.
        uint256 attention;
        for (uint256 i = 0; i < c.assets.length; i++) {
            string memory sym = c.assets[i];
            (uint256 p, uint256 at, bool exists, bool frozen) = o.peek(_assetId(sym));
            if (!exists || p == 0) revert(string.concat("verify tenant failed: oracle has no price for ", sym));
            if (frozen) {
                attention++;
                (, , uint256 freezeEnds, ) = o.freezeOf(_assetId(sym));
                if (freezeEnds == 0) {
                    console.log(string.concat("WARN ", sym, " frozen by the admin: no expiry, only the admin lifts it"));
                } else {
                    console.log(string.concat("WARN ", sym, " frozen by the guardian; lapses on its own at (unix):"), freezeEnds);
                }
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
            if (ITenantSyntheticAsset(token).assetId() != id) {
                revert(string.concat("verify tenant failed: token assetId is not the id of ", c.assets[i]));
            }
            console.log(string.concat("     ", c.assets[i], " assetCap (0 = closed to minting):"), v.assetCap(id));
            // RISK_ROLE's decision on a closed market (bounded by the vault): reported.
            if (v.isUnpricedExempt(id)) console.log(string.concat("WARN ", c.assets[i], " has an unpriced exemption in force"));
        }
        console.log("ok   tokens registered, minted only by the vault, administered by the owner:", c.assets.length);
    }

    /// @dev Every contract of the set has the ERC-1967 slots of what it is.
    ///      The vault proxy runs the implementation this deployment recorded
    ///      and is UUPS (no proxy admin, no beacon). No other contract of the
    ///      set is a proxy, so all three slots are empty on each of them. An
    ///      upgrade after the handover — to anything — fails here until the
    ///      record is updated through review.
    function _verifyProxies(TenantConfig memory c, TenantDeployed memory d) internal view {
        console.log("--- ERC-1967 slots (every contract of the set) ---");
        (string[] memory names, address[] memory all) = _tenantContracts(c, d);
        for (uint256 i = 0; i < all.length; i++) {
            address impl = address(uint160(uint256(vm.load(all[i], ERC1967_IMPLEMENTATION_SLOT))));
            bool hasAdmin = vm.load(all[i], ERC1967_ADMIN_SLOT) != bytes32(0);
            bool hasBeacon = vm.load(all[i], ERC1967_BEACON_SLOT) != bytes32(0);
            if (c.deployVault && all[i] == d.assetVault) {
                if (impl != d.assetVaultImpl) {
                    console.log("MISMATCH implementation of", names[i]);
                    console.log("  got  :", impl);
                    console.log("  want :", d.assetVaultImpl);
                    revert(string.concat("verify tenant failed: ", names[i], " implementation slot != the recorded implementation"));
                }
                if (hasAdmin) {
                    revert(string.concat("verify tenant failed: ", names[i], " has an ERC-1967 proxy admin (expected UUPS, none)"));
                }
                if (hasBeacon) {
                    revert(string.concat("verify tenant failed: ", names[i], " has an ERC-1967 beacon (expected UUPS, none)"));
                }
                console.log(string.concat("ok   ", names[i], " implementation == recorded, no proxy admin, no beacon"));
            } else if (impl != address(0) || hasAdmin || hasBeacon) {
                revert(string.concat("verify tenant failed: ", names[i], " has a non-empty ERC-1967 slot (no contract of the set but the vault is a proxy)"));
            }
        }
        console.log("ok   ERC-1967 implementation / admin / beacon slots empty on every non-proxy contract");
    }

    // ── code: every contract runs this repository's build ───────────────────

    /// @dev One entry of `deployedBytecode.immutableReferences` / `linkReferences`.
    ///      Fields in JSON-key order (`length` < `start`), as `parseJson` decodes them.
    struct ByteRange {
        uint256 length;
        uint256 start;
    }

    /// @dev The Foundry artifact (`out/<file>/<name>.json`) of each entry of
    ///      `_tenantContracts`, in the same order.
    function _tenantArtifacts(TenantConfig memory c, TenantDeployed memory d)
        internal pure returns (string[] memory files, string[] memory names)
    {
        uint256 n = 11 + (c.deployVault ? 2 + d.tokens.length : 0);
        files = new string[](n);
        names = new string[](n);
        (files[n - 1], names[n - 1]) = ("InsuranceSeeder.sol", "InsuranceSeeder");
        if (c.guardedOracle) (files[0], names[0]) = ("GuardedOracle.sol", "GuardedOracle");
        else (files[0], names[0]) = ("MockOracle.sol", "MockOracle");
        (files[1], names[1]) = ("ESGRegistryV2.sol", "ESGRegistryV2");
        if (c.vcKyc) (files[2], names[2]) = ("VCKycRegistry.sol", "VCKycRegistry");
        else (files[2], names[2]) = ("KYCRegistry.sol", "KYCRegistry");
        (files[3], names[3]) = ("InsuranceVault.sol", "InsuranceVault");
        (files[4], names[4]) = ("FeeRouter.sol", "FeeRouter");
        (files[5], names[5]) = ("TraderStake.sol", "TraderStake");
        (files[6], names[6]) = ("PerpetualExchange.sol", "PerpetualExchange");
        (files[7], names[7]) = ("StrategyRegistry.sol", "StrategyRegistry");
        (files[8], names[8]) = ("CopyTracker.sol", "CopyTracker");
        (files[9], names[9]) = ("AgentSessionManager.sol", "AgentSessionManager");
        if (c.deployVault) {
            (files[10], names[10]) = ("ERC1967Proxy.sol", "ERC1967Proxy");
            (files[11], names[11]) = ("AssetVaultV2_5.sol", "AssetVaultV2_5");
            for (uint256 i = 0; i < d.tokens.length; i++) {
                (files[12 + i], names[12 + i]) = ("SyntheticAssetV2.sol", "SyntheticAssetV2");
            }
        }
    }

    /// @notice Every contract of the set — and the library the exchange links —
    ///         runs exactly the runtime code of this repository's build
    ///         (`forge build`, the same compiler settings). Getters can be
    ///         answered by any code; this is what proves there is nothing else
    ///         behind them (no extra function, no different logic).
    /// @dev Method, per contract: the on-chain runtime code must have the
    ///      artifact's length and be byte-identical to `deployedBytecode.object`
    ///      except for
    ///        - immutables (`immutableReferences`): values are set at
    ///          construction, so they are masked — but every position of one
    ///          immutable must hold the same word, and the getters elsewhere
    ///          read each value back (the vault implementation's UUPS
    ///          self-address and each token's asset id have no getter and are
    ///          pinned here instead);
    ///        - library addresses (`linkReferences`): all positions of one
    ///          library must hold one address, whose code is in turn checked
    ///          against the library's artifact;
    ///        - the trailing CBOR metadata (its length is read from the
    ///          artifact's last two bytes): it hashes the source text, so a
    ///          comment-only edit changes it. It is never executed: the code
    ///          before it is identical, so every jump target is the build's
    ///          own. A difference is printed as a NOTE.
    function _verifyCode(TenantConfig memory c, TenantDeployed memory d) internal view {
        console.log("--- runtime code == this repository's build ---");
        (string[] memory labels, address[] memory all) = _tenantContracts(c, d);
        (string[] memory files, string[] memory names) = _tenantArtifacts(c, d);
        for (uint256 i = 0; i < all.length; i++) {
            bool pin;
            bytes32 pinned;
            if (c.deployVault && all[i] == d.assetVaultImpl) {
                (pin, pinned) = (true, bytes32(uint256(uint160(all[i]))));   // UUPS `__self`
            } else if (c.deployVault && i >= 12 && i < 12 + d.tokens.length) {
                (pin, pinned) = (true, _assetId(c.assets[i - 12]));           // SyntheticAssetV2.assetId
            }
            _verifyRuntimeCode(labels[i], all[i], files[i], names[i], pin, pinned);
        }
    }

    function _verifyRuntimeCode(
        string memory label,
        address target,
        string memory file,
        string memory name,
        bool pin,
        bytes32 pinned
    ) internal view {
        string memory art = vm.readFile(string.concat(ARTIFACTS_DIR, file, "/", name, ".json"));
        bytes memory hexWant = bytes(vm.parseJsonString(art, ".deployedBytecode.object"));
        bytes memory got = target.code;
        string memory fail = string.concat("verify tenant failed: ", label, " runtime code differs from this repository's build of ", name);

        _maskLibraries(label, art, hexWant, got, fail);
        bytes memory want = vm.parseBytes(string(hexWant));
        if (got.length != want.length) revert(fail);
        _maskImmutables(art, want, got, pin, pinned, fail);

        uint256 n = want.length;
        require(n > 2, string.concat("verify tenant failed: ", name, " artifact has no runtime code"));
        uint256 meta = ((uint256(uint8(want[n - 2])) << 8) | uint256(uint8(want[n - 1]))) + 2;
        require(meta < n, string.concat("verify tenant failed: ", name, " artifact has no CBOR metadata trailer"));
        if (_hashPrefix(got, n - meta) != _hashPrefix(want, n - meta)) revert(fail);
        if (keccak256(got) != keccak256(want)) {
            console.log(string.concat("NOTE ", label, ": code identical; only the CBOR metadata (source hash) differs from this build"));
        }
        console.log(string.concat("ok   ", label, " == ", name));
    }

    function _maskLibraries(
        string memory label,
        string memory art,
        bytes memory hexWant,
        bytes memory got,
        string memory fail
    ) internal view {
        string memory base = ".deployedBytecode.linkReferences";
        if (!vm.keyExistsJson(art, base)) return;
        string[] memory sources = vm.parseJsonKeys(art, base);
        for (uint256 i = 0; i < sources.length; i++) {
            string memory sourceKey = string.concat(base, "['", sources[i], "']");
            string[] memory libs = vm.parseJsonKeys(art, sourceKey);
            for (uint256 j = 0; j < libs.length; j++) {
                ByteRange[] memory refs = abi.decode(vm.parseJson(art, string.concat(sourceKey, ".", libs[j])), (ByteRange[]));
                address lib;
                for (uint256 k = 0; k < refs.length; k++) {
                    uint256 st = refs[k].start;
                    if (refs[k].length != 20 || got.length < st + 20 || hexWant.length < 2 + 2 * (st + 20)) revert(fail);
                    address a;
                    assembly ("memory-safe") { a := shr(96, mload(add(add(got, 32), st))) }
                    if (k == 0) lib = a;
                    else if (a != lib) revert(string.concat(fail, " (one library, two addresses)"));
                    _zero(got, st, 20);
                    for (uint256 x = 0; x < 40; x++) hexWant[2 + 2 * st + x] = "0";
                }
                if (refs.length > 0) {
                    // A library's own code carries its address as an immutable
                    // (the call guard): pinned to where it lives.
                    _verifyRuntimeCode(string.concat(label, " library ", libs[j]), lib, _basename(sources[i]), libs[j],
                        true, bytes32(uint256(uint160(lib))));
                }
            }
        }
    }

    function _maskImmutables(
        string memory art,
        bytes memory want,
        bytes memory got,
        bool pin,
        bytes32 pinned,
        string memory fail
    ) internal view {
        string memory base = ".deployedBytecode.immutableReferences";
        if (!vm.keyExistsJson(art, base)) return;
        string[] memory ids = vm.parseJsonKeys(art, base);
        for (uint256 i = 0; i < ids.length; i++) {
            ByteRange[] memory refs = abi.decode(vm.parseJson(art, string.concat(base, ".", ids[i])), (ByteRange[]));
            bytes32 first;
            for (uint256 k = 0; k < refs.length; k++) {
                uint256 st = refs[k].start;
                if (refs[k].length != 32 || got.length < st + 32) revert(fail);
                bytes32 w;
                assembly ("memory-safe") { w := mload(add(add(got, 32), st)) }
                // One immutable has one value: every place the code reads it
                // must hold the same word.
                if (k == 0) first = w;
                else if (w != first) revert(string.concat(fail, " (one immutable, two values)"));
                if (pin && w != pinned) revert(string.concat(fail, " (immutable value)"));
                _zero(got, st, 32);
                _zero(want, st, 32);
            }
        }
    }

    function _zero(bytes memory b, uint256 start, uint256 len) internal pure {
        for (uint256 i = 0; i < len; i++) b[start + i] = 0;
    }

    function _hashPrefix(bytes memory b, uint256 len) internal pure returns (bytes32 h) {
        require(len <= b.length, "prefix longer than the code");
        assembly ("memory-safe") { h := keccak256(add(b, 32), len) }
    }

    /// @dev "src/PerpetualExchange.sol" -> "PerpetualExchange.sol" (the artifact directory).
    function _basename(string memory path) internal pure returns (string memory) {
        bytes memory p = bytes(path);
        uint256 start = 0;
        for (uint256 i = 0; i < p.length; i++) if (p[i] == "/") start = i + 1;
        bytes memory out = new bytes(p.length - start);
        for (uint256 i = 0; i < out.length; i++) out[i] = p[start + i];
        return string(out);
    }

    // ── privilege holders: exactly the expected set ─────────────────────────

    /// @dev One grant read from an event: `account` was given `role` on `target`.
    ///      `role` is EXCHANGE_AGENT / KYC_VERIFIER for the two mappings.
    struct PrivilegeGrant {
        address target;
        bytes32 role;
        address account;
    }

    /// @notice Every address ever granted a privilege on the set, from the
    ///         grant events since `deployBlock`. `scanned == false` when this
    ///         run cannot read event history — DeployTenant's own run (the set
    ///         exists only in its simulation). `VerifyTenant` overrides it to
    ///         read the chain.
    function _privilegeHistory(TenantConfig memory, TenantDeployed memory)
        internal view virtual returns (bool scanned, PrivilegeGrant[] memory grants)
    {
        return (false, grants);
    }

    /// @dev The contracts with a privilege list, and the event that adds to it.
    function _privilegeSources(TenantConfig memory c, TenantDeployed memory d)
        internal pure returns (address[] memory targets, bytes32[] memory topics)
    {
        uint256 n = 3 + (c.guardedOracle ? 1 : 0) + (c.deployVault ? 1 + d.tokens.length : 0);
        targets = new address[](n);
        topics = new bytes32[](n);
        (targets[0], topics[0]) = (d.exchange, AGENT_SET_TOPIC);
        (targets[1], topics[1]) = (d.kyc, c.vcKyc ? ISSUER_SET_TOPIC : VERIFIER_SET_TOPIC);
        (targets[2], topics[2]) = (d.esgRegistry, ROLE_GRANTED_TOPIC);
        uint256 k = 3;
        if (c.guardedOracle) {
            (targets[k], topics[k]) = (d.oracle, ROLE_GRANTED_TOPIC);
            k++;
        }
        if (c.deployVault) {
            (targets[k], topics[k]) = (d.assetVault, ROLE_GRANTED_TOPIC);
            k++;
            for (uint256 i = 0; i < d.tokens.length; i++) {
                (targets[k], topics[k]) = (d.tokens[i], ROLE_GRANTED_TOPIC);
                k++;
            }
        }
    }

    /// @dev A log emitted by one of `_privilegeSources` -> the grant it records.
    function _grantOf(address emitter, bytes32[] memory topics) internal pure returns (bool ok, PrivilegeGrant memory g) {
        if (topics.length == 4 && topics[0] == ROLE_GRANTED_TOPIC) {
            return (true, PrivilegeGrant(emitter, topics[1], address(uint160(uint256(topics[2])))));
        }
        if (topics.length == 2 && topics[0] == AGENT_SET_TOPIC) {
            return (true, PrivilegeGrant(emitter, EXCHANGE_AGENT, address(uint160(uint256(topics[1])))));
        }
        if (topics.length == 2 && topics[0] == VERIFIER_SET_TOPIC) {
            return (true, PrivilegeGrant(emitter, KYC_VERIFIER, address(uint160(uint256(topics[1])))));
        }
        // IssuerSet(issuer indexed, credentialType indexed, trusted, epoch): a
        // removal is an event too; `_checkHolder` reads the current state.
        if (topics.length == 3 && topics[0] == ISSUER_SET_TOPIC) {
            return (true, PrivilegeGrant(emitter, VC_ISSUER, address(uint160(uint256(topics[1])))));
        }
    }

    /// @dev The addresses checked one by one whether or not history is read:
    ///      the deployer, the owner, every tenant role, the shared feeds and
    ///      token, and every contract of the set.
    function _knownAddresses(TenantConfig memory c, TenantDeployed memory d, address owner)
        internal pure returns (address[] memory known)
    {
        (, address[] memory all) = _tenantContracts(c, d);
        known = new address[](11 + all.length);
        address[11] memory fixedOnes = [d.deployer, owner, c.admin, c.risk, c.guardian, c.keeper, c.marketOperator,
            c.treasury, c.usdc, c.priceSource, c.referenceSource];
        for (uint256 i = 0; i < 11; i++) known[i] = fixedOnes[i];
        for (uint256 i = 0; i < all.length; i++) known[11 + i] = all[i];
    }

    function _isIn(address[] memory all, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < all.length; i++) if (all[i] == a) return true;
        return false;
    }

    function _nameIn(string[] memory names, address[] memory all, address t) internal pure returns (string memory) {
        for (uint256 i = 0; i < all.length; i++) if (all[i] == t) return names[i];
        return "an unknown contract";
    }

    function _privilegeName(bytes32 role) internal pure returns (string memory) {
        if (role == ADMIN_ROLE) return "DEFAULT_ADMIN_ROLE holder";
        if (role == KEEPER_ROLE) return "KEEPER_ROLE holder";
        if (role == GUARDIAN_ROLE) return "GUARDIAN_ROLE holder";
        if (role == RISK_ROLE) return "RISK_ROLE holder";
        if (role == PAUSER_ROLE) return "PAUSER_ROLE holder";
        if (role == MINTER_ROLE) return "MINTER_ROLE holder";
        if (role == ATTESTOR_ROLE) return "ATTESTOR_ROLE holder";
        if (role == EXCHANGE_AGENT) return "authorised agent";
        if (role == KYC_VERIFIER) return "KYC verifier";
        if (role == VC_ISSUER) return "trusted credential issuer";
        return string.concat("holder of role ", vm.toString(role));
    }

    /// @dev 0 = must not hold it, 1 = must hold it, 2 = may hold it (an
    ///      appointment the tenant admin makes after launch — ESG attestors and
    ///      KYC verifiers / VC issuers; reported, but never the deployer or a
    ///      contract).
    ///      Anything not listed — another role, another holder — is 0.
    function _expectedHolder(
        TenantConfig memory c,
        TenantDeployed memory d,
        address[] memory all,
        address owner,
        address t,
        bytes32 role,
        address a
    ) internal pure returns (uint8) {
        if (t == d.exchange) return role == EXCHANGE_AGENT && (a == d.sessionManager || a == d.copyTracker) ? 1 : 0;
        bool appointable = a != d.deployer && !_isIn(all, a);
        if (t == d.kyc) return role == (c.vcKyc ? VC_ISSUER : KYC_VERIFIER) && appointable ? 2 : 0;
        if (role == EXCHANGE_AGENT || role == KYC_VERIFIER || role == VC_ISSUER) return 0;
        if (t == d.esgRegistry) {
            if (role == ADMIN_ROLE) return a == owner ? 1 : 0;
            if (role == ATTESTOR_ROLE) return appointable ? 2 : 0;
            return 0;
        }
        if (c.guardedOracle && t == d.oracle) {
            if (role == ADMIN_ROLE) return a == owner ? 1 : 0;
            if (role == KEEPER_ROLE) return a == c.keeper ? 1 : 0;
            if (role == GUARDIAN_ROLE) return a == c.guardian ? 1 : 0;
            return 0;
        }
        if (c.deployVault && t == d.assetVault) {
            if (role == ADMIN_ROLE) return a == owner ? 1 : 0;
            if (role == RISK_ROLE) return a == c.risk ? 1 : 0;
            if (role == PAUSER_ROLE) return a == c.guardian ? 1 : 0;
            return 0;
        }
        // a synthetic token
        if (role == ADMIN_ROLE) return a == owner ? 1 : 0;
        if (role == MINTER_ROLE) return a == d.assetVault ? 1 : 0;
        return 0;
    }

    function _holds(TenantConfig memory c, TenantDeployed memory d, address t, bytes32 role, address a) internal view returns (bool) {
        if (t == d.exchange) return role == EXCHANGE_AGENT && PerpetualExchange(t).authorizedAgents(a);
        if (t == d.kyc) {
            if (c.vcKyc) return role == VC_ISSUER && _isVcIssuer(t, a);
            return role == KYC_VERIFIER && KYCRegistry(t).verifiers(a);
        }
        if (role == EXCHANGE_AGENT || role == KYC_VERIFIER || role == VC_ISSUER) return false;
        return IAccessControl(t).hasRole(role, a);
    }

    /// @dev Trusted for either built-in type, or for any type the owner added
    ///      (`issuerTypeCount` counts every type the issuer is trusted for).
    function _isVcIssuer(address registry, address a) internal view returns (bool) {
        VCKycRegistry v = VCKycRegistry(registry);
        return v.trustedIssuer(a, QUALIFIED_INVESTOR) || v.trustedIssuer(a, KYC_BASIC) || v.issuerTypeCount(a) > 0;
    }

    /// @dev The set's contracts and their names, computed once per verification.
    struct SetView {
        string[] names;
        address[] all;
    }

    function _checkHolder(
        TenantConfig memory c,
        TenantDeployed memory d,
        SetView memory sv,
        address owner,
        address t,
        bytes32 role,
        address a
    ) internal view {
        if (a == address(0)) return;
        bool held = _holds(c, d, t, role, a);
        uint8 want = _expectedHolder(c, d, sv.all, owner, t, role, a);
        if (held && want == 0) {
            console.log("unexpected holder", a, "on", t);
            revert(string.concat("verify tenant failed: unexpected ", _privilegeName(role), " on ", _nameIn(sv.names, sv.all, t)));
        }
        if (!held && want == 1) {
            console.log("missing holder", a, "on", t);
            revert(string.concat("verify tenant failed: missing ", _privilegeName(role), " on ", _nameIn(sv.names, sv.all, t)));
        }
        if (held && want == 2) console.log(string.concat("NOTE ", _privilegeName(role), " on ", _nameIn(sv.names, sv.all, t), ":"), a);
    }

    /// @notice On every contract with a privilege list (AccessControl roles,
    ///         the exchange's authorised agents, the KYC verifiers / VC issuers) the holders
    ///         are exactly the expected ones. AccessControl cannot list its
    ///         members, so two passes:
    ///           1. every known address (`_knownAddresses`) x every role this
    ///              codebase uses: holds it iff expected — always run;
    ///           2. every address any grant event since `deployBlock` named:
    ///              still holding a privilege only if expected — run when this
    ///              run reads event history (`_privilegeHistory`); otherwise
    ///              a NOTE says the second pass did not run.
    function _verifyPrivilegeHolders(TenantConfig memory c, TenantDeployed memory d, address owner) internal view {
        console.log("--- privilege holders: exactly the expected set ---");
        (address[] memory targets, ) = _privilegeSources(c, d);
        address[] memory known = _knownAddresses(c, d, owner);
        SetView memory sv;
        (sv.names, sv.all) = _tenantContracts(c, d);
        bytes32[10] memory roles = [ADMIN_ROLE, KEEPER_ROLE, GUARDIAN_ROLE, RISK_ROLE, PAUSER_ROLE, MINTER_ROLE,
            ATTESTOR_ROLE, EXCHANGE_AGENT, KYC_VERIFIER, VC_ISSUER];
        for (uint256 t = 0; t < targets.length; t++) {
            for (uint256 r = 0; r < roles.length; r++) {
                for (uint256 a = 0; a < known.length; a++) _checkHolder(c, d, sv, owner, targets[t], roles[r], known[a]);
            }
        }
        console.log("ok   known addresses (roles, deployer, shared feeds, the set) hold exactly their privileges:", known.length);

        (bool scanned, PrivilegeGrant[] memory grants) = _privilegeHistory(c, d);
        if (!scanned) {
            console.log("NOTE privilege history not read in this run: an address outside the known ones is not covered");
            return;
        }
        uint256 checked;
        for (uint256 i = 0; i < grants.length; i++) {
            for (uint256 t = 0; t < targets.length; t++) {
                if (grants[i].target != targets[t]) continue;
                _checkHolder(c, d, sv, owner, grants[i].target, grants[i].role, grants[i].account);
                checked++;
                break;
            }
        }
        console.log("ok   every address a grant event named holds only what it should; grants read:", checked);
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
        if (c.vcKyc) {
            _check(!_isVcIssuer(d.kyc, dep), "deployer is not a trusted credential issuer");
            _check(VCKycRegistry(d.kyc).pendingOwner() != dep, "deployer is not the VC registry's pending owner");
        } else {
            _check(!KYCRegistry(d.kyc).verifiers(dep), "deployer is not a KYC verifier");
        }
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
///
///         Privilege history (`_verifyPrivilegeHolders`, second pass): read
///         with `eth_getLogs` from the record's `deployBlock` to the head, in
///         chunks of TENANT_LOG_CHUNK_BLOCKS (default 1000 — the public Base
///         RPC's limit), one call per contract per chunk. When the span is
///         longer than TENANT_PRIVILEGE_SCAN_MAX_BLOCKS (default 50000, about
///         28h of Base blocks) the pass is skipped with a NOTE, unless
///         TENANT_PRIVILEGE_SCAN_REQUIRED=true, which fails instead. An RPC
///         that refuses a call fails the run; nothing is skipped silently.
contract VerifyTenant is TenantBase {
    uint256 internal constant DEFAULT_PRIVILEGE_SCAN_MAX_BLOCKS = 50_000;
    uint256 internal constant DEFAULT_LOG_CHUNK_BLOCKS = 1_000;

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

    function _privilegeHistory(TenantConfig memory c, TenantDeployed memory d)
        internal view override returns (bool, PrivilegeGrant[] memory)
    {
        uint256 head = vm.getBlockNumber();
        require(d.deployBlock <= head, "deployment record: deployBlock is after this chain's head");
        uint256 span = head - d.deployBlock + 1;
        uint256 maxSpan = vm.envOr("TENANT_PRIVILEGE_SCAN_MAX_BLOCKS", DEFAULT_PRIVILEGE_SCAN_MAX_BLOCKS);
        if (span > maxSpan) {
            if (vm.envOr("TENANT_PRIVILEGE_SCAN_REQUIRED", false)) {
                revert("verify tenant failed: privilege history longer than TENANT_PRIVILEGE_SCAN_MAX_BLOCKS and TENANT_PRIVILEGE_SCAN_REQUIRED=true");
            }
            console.log("NOTE privilege history not read: blocks since deployBlock / TENANT_PRIVILEGE_SCAN_MAX_BLOCKS", span, maxSpan);
            return (false, new PrivilegeGrant[](0));
        }
        uint256 chunk = vm.envOr("TENANT_LOG_CHUNK_BLOCKS", DEFAULT_LOG_CHUNK_BLOCKS);
        require(chunk > 0, "TENANT_LOG_CHUNK_BLOCKS must be > 0");

        (address[] memory targets, bytes32[] memory topics) = _privilegeSources(c, d);
        PrivilegeGrant[] memory out = new PrivilegeGrant[](0);
        uint256 calls;
        for (uint256 from = d.deployBlock; from <= head; from += chunk) {
            uint256 to = from + chunk - 1;
            if (to > head) to = head;
            for (uint256 i = 0; i < targets.length; i++) {
                out = _appendGrants(out, _logsOf(from, to, targets[i], topics[i]), targets[i]);
                calls++;
            }
        }
        console.log("ok   privilege history read: blocks / eth_getLogs calls / grant events", span, calls, out.length);
        return (true, out);
    }

    function _logsOf(uint256 from, uint256 to, address target, bytes32 topic)
        internal view returns (VmSafe.EthGetLogs[] memory logs)
    {
        bytes32[] memory filter = new bytes32[](1);
        filter[0] = topic;
        try vm.eth_getLogs(from, to, target, filter) returns (VmSafe.EthGetLogs[] memory l) {
            return l;
        } catch {
            console.log("eth_getLogs failed for blocks", from, to);
            revert("verify tenant failed: eth_getLogs refused (RPC block-range or rate limit?) - lower TENANT_LOG_CHUNK_BLOCKS or use another RPC");
        }
    }

    function _appendGrants(PrivilegeGrant[] memory out, VmSafe.EthGetLogs[] memory logs, address target)
        internal pure returns (PrivilegeGrant[] memory)
    {
        if (logs.length == 0) return out;
        PrivilegeGrant[] memory next = new PrivilegeGrant[](out.length + logs.length);
        uint256 n = out.length;
        for (uint256 k = 0; k < n; k++) next[k] = out[k];
        for (uint256 j = 0; j < logs.length; j++) {
            if (logs[j].emitter != target || logs[j].removed) continue;
            (bool ok, PrivilegeGrant memory g) = _grantOf(logs[j].emitter, logs[j].topics);
            if (ok) next[n++] = g;
        }
        assembly ("memory-safe") { mstore(next, n) }
        return next;
    }
}
