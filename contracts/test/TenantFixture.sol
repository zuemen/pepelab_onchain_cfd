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
        _verifyTenant(c, d, owner);
    }

    function isRwa(string calldata sym) external pure returns (bool) { return _isRwa(sym); }
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
        string  oracleKind;
        uint256 oiCapNonRwaUsdc;
        uint256 oiCapRwaUsdc;
        uint256 maxProfitBps;
        bool    deployVault;
        string  assets;   // JSON array body, e.g. "\"sBTC\",\"sETH\""
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
        s.oiCapNonRwaUsdc = 1_000;
        s.oiCapRwaUsdc = 500;
        s.maxProfitBps = 50_000;
        s.deployVault = true;
        s.assets = ALL_ASSETS;
    }

    function _json(Spec memory s) internal pure returns (string memory) {
        string memory head = string.concat(
            "{\"schemaVersion\":2,\"tenantId\":\"", s.id,
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
            "\",\"priceSource\":\"", vm.toString(s.priceSource), "\"},"
        );
        string memory params = string.concat(
            "\"params\":{\"oracleKind\":\"", s.oracleKind,
            "\",\"oiCapNonRwaUsdc\":", vm.toString(s.oiCapNonRwaUsdc),
            ",\"oiCapRwaUsdc\":", vm.toString(s.oiCapRwaUsdc),
            ",\"maxProfitBps\":", vm.toString(s.maxProfitBps),
            ",\"deployVault\":", s.deployVault ? "true" : "false", "},"
        );
        return string.concat(head, roles, shared, params, "\"assets\":{\"registered\":[", s.assets, "]}}");
    }

    function _deployTenant(Spec memory s, address deployer) internal returns (DeployTenant script) {
        script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        script.setAllowEoaAdmin(true);   // test roles are plain addresses
        script.runWithConfig(_json(s), s.id);
    }
}
