// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployTenant.s.sol";
import "../script/VerifyTenant.s.sol";

/// @notice Exposes `TenantBase`'s read-back checks so a test can verify a
///         tenant from the config + record strings alone — the same two inputs
///         `VerifyTenant.run()` reads from disk.
contract TenantVerifyHarness is TenantBase {
    function verify(string calldata configJson, string calldata id, string calldata recordJson, address owner) external view {
        TenantConfig memory c = _parseConfig(configJson, id);
        _validateConfig(c, address(0));
        (TenantDeployed memory d, ) = _parseRecord(recordJson, c);
        _validateForChain(c);
        _verifyTenant(c, d, owner);
    }

    /// @dev The privilege history a test recorded: every log since the test
    ///      last called `vm.recordLogs()` / since the previous `verify`
    ///      (`getRecordedLogs` drains). On chain, VerifyTenant reads it with
    ///      `eth_getLogs`; a unit test has no RPC to read from.
    function _privilegeHistory(TenantConfig memory c, TenantDeployed memory d)
        internal view override returns (bool, PrivilegeGrant[] memory grants)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address[] memory targets, ) = _privilegeSources(c, d);
        grants = new PrivilegeGrant[](logs.length);
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            bool ours;
            for (uint256 t = 0; t < targets.length && !ours; t++) ours = logs[i].emitter == targets[t];
            if (!ours) continue;
            (bool ok, PrivilegeGrant memory g) = _grantOf(logs[i].emitter, logs[i].topics);
            if (ok) grants[n++] = g;
        }
        assembly ("memory-safe") { mstore(grants, n) }
        return (true, grants);
    }

    function isRwa(string calldata sym) external pure returns (bool) { return _isRwa(sym); }
    function isRwaFor(string calldata configJson, string calldata id, string calldata sym) external view returns (bool) {
        return _isRwaFor(_parseConfig(configJson, id), sym);
    }
    function tokenName(string calldata sym) external pure returns (string memory) { return _tokenName(sym); }
    function requireSlug(string calldata id) external pure { _requireSlug(id); }
}

/// @notice Builds a `deploy/tenants/<id>.json`-shaped config in memory, so the
///         unit and fork tests deploy tenants without touching the filesystem.
abstract contract TenantFixture is Test {
    struct Spec {
        string  id;
        string  status;
        uint256 chainId;
        address admin;
        address risk;
        address guardian;
        address keeper;
        address marketOperator;
        address treasury;
        address usdc;
        address priceSource;
        address referenceSource;   // address(0) is written as "none"
        string  oracleKind;
        uint256 oracleMaxDeviationBps;      // written as null for a mock oracle
        uint256 oracleWindowSeconds;
        uint256 oracleWindowDeviationBps;
        uint256 oiCapNonRwaUsdc;
        uint256 oiCapRwaUsdc;
        uint256 maxProfitBps;
        uint256 maxLeverage;
        uint256 liquidationPenaltyBps;
        uint256 markPremiumCapBps;
        uint256 vaultFeeShareBps;
        bool    deployVault;
        uint256 vaultRedeemFeeBps;          // written as null without a vault
        uint256 vaultMinReserveRatioBps;
        string  assets;   // JSON array body, e.g. "\"sBTC\",\"sETH\""
        string  kycRegistry;     // "allowlist" | "vc"
        string  additionalRwa;   // JSON array body, "" = none
    }

    string internal constant ALL_ASSETS =
        "\"sBTC\",\"sETH\",\"sAAPL\",\"sTSLA\",\"sGOLD\",\"sBOND\",\"sNVDA\",\"sMSFT\",\"sGOOGL\",\"sICLN\",\"sESGU\"";

    function _allSyms() internal pure returns (string[11] memory s) {
        s = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
    }

    /// @dev A complete, valid spec whose role addresses are derived from the
    ///      tenant id — two ids give two disjoint sets of keys.
    function _spec(string memory id, address usdc, address priceSource) internal returns (Spec memory s) {
        s.id = id;
        s.status = "ready";
        s.chainId = block.chainid;
        s.admin          = makeAddr(string.concat(id, "-admin"));
        s.risk           = makeAddr(string.concat(id, "-risk"));
        s.guardian       = makeAddr(string.concat(id, "-guardian"));
        s.keeper         = makeAddr(string.concat(id, "-keeper"));
        s.marketOperator = s.keeper;   // the live platform's arrangement: the keeper switches markets
        s.treasury       = makeAddr(string.concat(id, "-treasury"));
        s.usdc = usdc;
        s.priceSource = priceSource;
        s.oracleKind = "guarded";
        // The live platform's oracle pair (RedeployGuardedOracle.s.sol).
        s.oracleMaxDeviationBps = 1_000;
        s.oracleWindowSeconds = 3_600;
        s.oracleWindowDeviationBps = 2_500;
        s.oiCapNonRwaUsdc = 1_000;
        s.oiCapRwaUsdc = 500;
        s.maxProfitBps = 50_000;
        s.maxLeverage = 5;
        s.liquidationPenaltyBps = 2_000;
        s.markPremiumCapBps = 0;
        s.vaultFeeShareBps = 0;
        s.deployVault = true;
        s.vaultRedeemFeeBps = 30;
        s.vaultMinReserveRatioBps = 11_000;
        s.assets = ALL_ASSETS;
        s.kycRegistry = "allowlist";
        s.additionalRwa = "";
    }

    /// @dev v4 config (v3 + params.kycRegistry, assets.additionalRwa). The oracle limits are written as `null` for a mock
    ///      oracle and the vault parameters as `null` without a vault, as the
    ///      schema requires; tests that need the other shapes edit the string
    ///      (`vm.replace`).
    function _json(Spec memory s) internal pure returns (string memory) {
        string memory head = string.concat(
            "{\"schemaVersion\":4,\"tenantId\":\"", s.id,
            "\",\"status\":\"", s.status,
            "\",\"frontendTenant\":\"", s.id,
            "\",\"network\":{\"chainId\":", vm.toString(s.chainId), "},"
        );
        string memory roles = string.concat(
            "\"roles\":{\"admin\":\"", vm.toString(s.admin),
            "\",\"risk\":\"", vm.toString(s.risk),
            "\",\"guardian\":\"", vm.toString(s.guardian),
            "\",\"keeper\":\"", vm.toString(s.keeper),
            "\",\"marketOperator\":\"", vm.toString(s.marketOperator),
            "\",\"treasury\":\"", vm.toString(s.treasury), "\"},"
        );
        string memory shared = string.concat(
            "\"shared\":{\"settlementToken\":\"", vm.toString(s.usdc),
            "\",\"priceSource\":\"", vm.toString(s.priceSource),
            "\",\"referenceSource\":\"", s.referenceSource == address(0) ? "none" : vm.toString(s.referenceSource), "\"},"
        );
        return string.concat(head, roles, shared, _paramsJson(s),
            "\"assets\":{\"registered\":[", s.assets, "],\"additionalRwa\":[", s.additionalRwa, "]}}");
    }

    function _paramsJson(Spec memory s) internal pure returns (string memory) {
        bool guarded = keccak256(bytes(s.oracleKind)) == keccak256("guarded");
        string memory oracle = string.concat(
            "\"params\":{\"oracleKind\":\"", s.oracleKind,
            "\",\"oracleMaxDeviationBps\":", guarded ? vm.toString(s.oracleMaxDeviationBps) : "null",
            ",\"oracleWindowSeconds\":", guarded ? vm.toString(s.oracleWindowSeconds) : "null",
            ",\"oracleWindowDeviationBps\":", guarded ? vm.toString(s.oracleWindowDeviationBps) : "null"
        );
        string memory exchange = string.concat(
            ",\"oiCapNonRwaUsdc\":", vm.toString(s.oiCapNonRwaUsdc),
            ",\"oiCapRwaUsdc\":", vm.toString(s.oiCapRwaUsdc),
            ",\"maxProfitBps\":", vm.toString(s.maxProfitBps),
            ",\"maxLeverage\":", vm.toString(s.maxLeverage),
            ",\"liquidationPenaltyBps\":", vm.toString(s.liquidationPenaltyBps),
            ",\"markPremiumCapBps\":", vm.toString(s.markPremiumCapBps),
            ",\"vaultFeeShareBps\":", vm.toString(s.vaultFeeShareBps)
        );
        string memory vault = string.concat(
            ",\"deployVault\":", s.deployVault ? "true" : "false",
            ",\"vaultRedeemFeeBps\":", s.deployVault ? vm.toString(s.vaultRedeemFeeBps) : "null",
            ",\"vaultMinReserveRatioBps\":", s.deployVault ? vm.toString(s.vaultMinReserveRatioBps) : "null",
            ",\"kycRegistry\":\"", s.kycRegistry, "\"},"
        );
        return string.concat(oracle, exchange, vault);
    }

    function _deployTenant(Spec memory s, address deployer) internal returns (DeployTenant script) {
        script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        script.setAllowEoaAdmin(true);   // test roles are plain addresses
        // DeployTenant seeds the tenant's InsuranceVault with one whole token
        // from the deployer. Fund it unless the case is about a bad token.
        if (s.usdc.code.length > 0) {
            try IERC20Metadata(s.usdc).decimals() returns (uint8 dec) {
                deal(s.usdc, deployer, IERC20(s.usdc).balanceOf(deployer) + 10 ** dec);
            } catch {}
        }
        script.runWithConfig(_json(s), s.id);
    }
}
