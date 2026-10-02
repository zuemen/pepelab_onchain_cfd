// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";
import "../src/ESGRegistryV2.sol";
import "../src/PerpetualExchange.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2_5.sol";
import "./TenantFixture.sol";

/// @dev The vault implementation plus one function the repository's build does
///      not have. Same storage, same getters.
contract AssetVaultV2_5WithExtraFunction is AssetVaultV2_5 {
    function extraFunction() external pure returns (uint256) {
        return 1;
    }
}

/// @dev Creates a contract from the deployer's own nonces, the way a broadcast
///      does — so the "created by the recorded deployer" check is satisfied
///      and only the code comparison is left to tell the difference.
contract CreateFromDeployer is Script {
    function create(address deployer) external returns (address a) {
        vm.startBroadcast(deployer);
        a = address(new AssetVaultV2_5WithExtraFunction());
        vm.stopBroadcast();
    }
}

/// @notice ADR-008, PR #228 review 2 (C1, C2, C4): VerifyTenant compares every
///         contract's runtime code with this repository's build and every
///         privilege list with the expected holders; the oracle's speed limit
///         at the widest settings the config accepts.
contract TenantVerifyCodeAndPrivilegesTest is TenantFixture {
    MockUSDC   usdc;
    MockOracle source;
    TenantVerifyHarness verifier;

    address deployer = makeAddr("tenant-deployer");
    address stranger = makeAddr("not-a-tenant-key");

    bytes32 constant BTC = keccak256("sBTC");
    bytes32 constant ERC1967_IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 constant ERC1967_BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        source = new MockOracle();
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) source.addAsset(keccak256(bytes(syms[i])), 100e8);
        verifier = new TenantVerifyHarness();
    }

    function _deploy() internal returns (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) {
        s = _spec("bank-c", address(usdc), address(source));
        DeployTenant script = _deployTenant(s, deployer);
        record = script.lastRecordJson();
        d = script.lastDeployed();
    }

    function _verifyFails(Spec memory s, string memory record, bytes memory reason) internal {
        vm.expectRevert(reason);
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    /// @dev `code` with the byte at `i` changed.
    function _flip(bytes memory code, uint256 i) internal pure returns (bytes memory out) {
        out = bytes.concat(code);
        out[i] = bytes1(uint8(out[i]) ^ 0x01);
    }

    // ── C2: runtime code ─────────────────────────────────────────────────────

    function test_record_carriesDeployBlock() public {
        vm.roll(12_345);
        (, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        assertEq(d.deployBlock, 12_345);
        assertEq(vm.parseJsonUint(record, ".deployBlock"), 12_345);
    }

    /// @dev An implementation the recorded deployer created, which the proxy
    ///      points at and the record names, passes every getter and every
    ///      wiring check. Only the code comparison tells it apart.
    function test_verify_fails_whenImplementationCodeDiffersFromBuild() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        address other = new CreateFromDeployer().create(deployer);
        vm.prank(s.admin);
        AssetVaultV2_5(d.assetVault).upgradeToAndCall(other, "");
        string memory pointed = vm.replace(record, vm.toString(d.assetVaultImpl), vm.toString(other));
        _verifyFails(s, pointed,
            bytes("verify tenant failed: AssetVaultV2Impl runtime code differs from this repository's build of AssetVaultV2_5"));
    }

    function test_verify_fails_whenOneByteOfCodeDiffers() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        uint256 snap = vm.snapshotState();

        // Same length, one opcode different, outside every masked range.
        vm.etch(d.exchange, _flip(d.exchange.code, 10));
        _verifyFails(s, record, bytes("verify tenant failed: PerpetualExchange runtime code differs from this repository's build of PerpetualExchange"));

        vm.revertToState(snap);
        vm.etch(d.oracle, _flip(d.oracle.code, 10));
        _verifyFails(s, record, bytes("verify tenant failed: Oracle runtime code differs from this repository's build of GuardedOracle"));

        vm.revertToState(snap);
        vm.etch(d.tokens[1], _flip(d.tokens[1].code, 10));
        _verifyFails(s, record, bytes("verify tenant failed: token sETH runtime code differs from this repository's build of SyntheticAssetV2"));

        // Longer code (anything appended) fails on the length alone.
        vm.revertToState(snap);
        vm.etch(d.kyc, bytes.concat(d.kyc.code, hex"00"));
        _verifyFails(s, record, bytes("verify tenant failed: KYCRegistry runtime code differs from this repository's build of KYCRegistry"));
    }

    /// @dev The CBOR trailer hashes the source text and is never executed:
    ///      a difference there alone is reported, not failed.
    function test_verify_passes_whenOnlyTheMetadataTrailerDiffers() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        bytes memory code = d.kyc.code;
        vm.etch(d.kyc, _flip(code, code.length - 10));
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function test_verify_fails_whenTheLinkedLibraryOrAnImmutableDiffers() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        uint256 snap = vm.snapshotState();

        // The library the exchange calls: located through the exchange's own code.
        string memory art = vm.readFile("out/PerpetualExchange.sol/PerpetualExchange.json");
        uint256 at = vm.parseJsonUint(art, ".deployedBytecode.linkReferences['src/PerpetualExchange.sol'].ExchangeOpsLib[0].start");
        bytes memory ex = d.exchange.code;
        address lib;
        assembly ("memory-safe") { lib := shr(96, mload(add(add(ex, 32), at))) }
        assertGt(lib.code.length, 0, "library located");
        vm.etch(lib, _flip(lib.code, 45));
        _verifyFails(s, record, bytes("verify tenant failed: PerpetualExchange library ExchangeOpsLib runtime code differs from this repository's build of ExchangeOpsLib"));

        // One immutable read at two places must hold one value.
        vm.revertToState(snap);
        string[] memory ids = vm.parseJsonKeys(art, ".deployedBytecode.immutableReferences");
        uint256 second = vm.parseJsonUint(art, string.concat(".deployedBytecode.immutableReferences.", ids[0], "[1].start"));
        vm.etch(d.exchange, _flip(ex, second + 31));
        _verifyFails(s, record, bytes("verify tenant failed: PerpetualExchange runtime code differs from this repository's build of PerpetualExchange (one immutable, two values)"));

        // An immutable no getter reads is pinned: the token's asset id.
        vm.revertToState(snap);
        string memory tokArt = vm.readFile("out/SyntheticAssetV2.sol/SyntheticAssetV2.json");
        string[] memory tokIds = vm.parseJsonKeys(tokArt, ".deployedBytecode.immutableReferences");
        assertEq(tokIds.length, 1, "one immutable: assetId");
        uint256 idAt = vm.parseJsonUint(tokArt, string.concat(".deployedBytecode.immutableReferences.", tokIds[0], "[0].start"));
        vm.etch(d.tokens[0], _flip(d.tokens[0].code, idAt + 31));
        _verifyFails(s, record, bytes("verify tenant failed: token sBTC runtime code differs from this repository's build of SyntheticAssetV2 (immutable value)"));
    }

    function test_verify_checksTheErc1967SlotsOfEveryContract() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        uint256 snap = vm.snapshotState();

        vm.store(d.exchange, ERC1967_IMPLEMENTATION_SLOT, bytes32(uint256(uint160(stranger))));
        _verifyFails(s, record, bytes("verify tenant failed: PerpetualExchange has a non-empty ERC-1967 slot (no contract of the set but the vault is a proxy)"));

        vm.revertToState(snap);
        vm.store(d.tokens[2], ERC1967_BEACON_SLOT, bytes32(uint256(1)));
        _verifyFails(s, record, bytes("verify tenant failed: token sAAPL has a non-empty ERC-1967 slot (no contract of the set but the vault is a proxy)"));

        vm.revertToState(snap);
        vm.store(d.assetVault, ERC1967_BEACON_SLOT, bytes32(uint256(uint160(stranger))));
        _verifyFails(s, record, bytes("verify tenant failed: AssetVaultV2 has an ERC-1967 beacon (expected UUPS, none)"));
    }

    // ── C4: privilege holders ────────────────────────────────────────────────

    /// @dev Holders outside every known address: found through the grant
    ///      events since the deployment (on chain: eth_getLogs from the
    ///      record's deployBlock; here: the logs the test records).
    function test_verify_fails_onAnUnexpectedHolderNamedByAGrantEvent() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        vm.recordLogs();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(keccak256("KEEPER_ROLE"), stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected KEEPER_ROLE holder on Oracle"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(keccak256("GUARDIAN_ROLE"), stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected GUARDIAN_ROLE holder on Oracle"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(0x00, stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected DEFAULT_ADMIN_ROLE holder on Oracle"));
    }

    /// @dev Same as above for the token, the vault, the ESG registry and the
    ///      exchange (split so one test stays well under forge's per-test gas cap).
    function test_verify_fails_onAnUnexpectedHolderNamedByAGrantEvent_otherContracts() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        vm.recordLogs();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        IAccessControl(d.tokens[0]).grantRole(keccak256("MINTER_ROLE"), stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected MINTER_ROLE holder on token sBTC"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.assetVault).grantRole(keccak256("RISK_ROLE"), stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected RISK_ROLE holder on AssetVaultV2"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.assetVault).grantRole(keccak256("PAUSER_ROLE"), stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected PAUSER_ROLE holder on AssetVaultV2"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.esgRegistry).grantRole(0x00, stranger);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected DEFAULT_ADMIN_ROLE holder on ESGRegistryV2"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        PerpetualExchange(d.exchange).setAgentAuthorized(stranger, true);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected authorised agent on PerpetualExchange"));

        // A role this codebase does not use is never expected.
        vm.revertToState(snap);
        bytes32 otherRole = keccak256("SOME_OTHER_ROLE");
        vm.prank(s.admin);
        IAccessControl(d.tokens[1]).grantRole(otherRole, stranger);
        _verifyFails(s, record, bytes(string.concat("verify tenant failed: unexpected holder of role ", vm.toString(otherRole), " on token sETH")));
    }

    /// @dev Without any event history the known addresses are still checked
    ///      one by one: every tenant key, the deployer, the shared feeds and
    ///      the set's own contracts.
    function test_verify_fails_onAKnownAddressHoldingAnUnexpectedRole() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        IAccessControl(d.tokens[0]).grantRole(keccak256("MINTER_ROLE"), s.keeper);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected MINTER_ROLE holder on token sBTC"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.assetVault).grantRole(keccak256("RISK_ROLE"), s.guardian);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected RISK_ROLE holder on AssetVaultV2"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(keccak256("KEEPER_ROLE"), d.exchange);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected KEEPER_ROLE holder on Oracle"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.esgRegistry).grantRole(keccak256("ATTESTOR_ROLE"), deployer);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected ATTESTOR_ROLE holder on ESGRegistryV2"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        PerpetualExchange(d.exchange).setAgentAuthorized(s.risk, true);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected authorised agent on PerpetualExchange"));
    }

    /// @dev ESG attestors and KYC verifiers are appointed by the tenant admin
    ///      after launch: reported, never failed (unless the deployer or a
    ///      contract of the set). A revoked holder is no holder.
    function test_verify_passes_appointmentsAndRevokedGrants() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        vm.recordLogs();
        vm.startPrank(s.admin);
        IAccessControl(d.esgRegistry).grantRole(keccak256("ATTESTOR_ROLE"), stranger);
        KYCRegistry(d.kyc).setVerifier(stranger, true);
        IAccessControl(d.tokens[0]).grantRole(keccak256("MINTER_ROLE"), makeAddr("granted-then-revoked"));
        IAccessControl(d.tokens[0]).revokeRole(keccak256("MINTER_ROLE"), makeAddr("granted-then-revoked"));
        vm.stopPrank();
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    // ── C4: parameters with no config field stay at the contract default ────

    function test_verify_fails_whenTheEsgAttestationAgeChanged() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _deploy();
        vm.prank(s.admin);
        ESGRegistryV2(d.esgRegistry).setMaxAttestationAge(365 days);
        _verifyFails(s, record, bytes("verify tenant mismatch: esgRegistry.maxAttestationAge (contract default)"));
    }

    // ── C1: the oracle's speed limit at the widest accepted settings ────────

    function _tryPost(GuardedOracle o, address keeper, uint256 p) internal returns (bool ok) {
        vm.prank(keeper);
        try o.updatePrice(BTC, p) { ok = true; } catch { ok = false; }
    }

    /// @dev The highest price the oracle accepts right now, posted.
    function _postHighest(GuardedOracle o, address keeper, uint256 stepBps) internal {
        for (uint256 guard; guard < 20; guard++) {
            (uint256 cur, , , ) = o.peek(BTC);
            uint256 hi = cur * (10_000 + stepBps) / 10_000;
            uint256 snap = vm.snapshotState();
            if (_tryPost(o, keeper, hi)) continue;
            vm.revertToState(snap);
            uint256 lo = cur;
            while (hi - lo > 1) {
                uint256 mid = (lo + hi) / 2;
                uint256 s2 = vm.snapshotState();
                bool ok = _tryPost(o, keeper, mid);
                vm.revertToState(s2);
                if (ok) lo = mid; else hi = mid;
            }
            require(_tryPost(o, keeper, lo), "post at lo");
            return;
        }
    }

    /// @dev Upper bound the docs state: within T seconds, window d, window
    ///      cap W, a price moves by at most (1+W)^(floor(T/d)+1). Checked
    ///      against the fastest schedule known (a no-op post opens a window
    ///      every d+1 s; the full window cap is taken once the previous
    ///      window's anchor no longer applies), at the widest settings the
    ///      config accepts (= the live platform's).
    function test_oracleSpeedLimit_atTheWidestAcceptedSettings_staysWithinTheDocumentedBound() public {
        Spec memory s = _spec("bank-w", address(usdc), address(source));
        s.oracleMaxDeviationBps = 1_000;
        s.oracleWindowSeconds = 3_600;
        s.oracleWindowDeviationBps = 2_500;
        DeployTenant script = _deployTenant(s, deployer);
        GuardedOracle o = GuardedOracle(script.lastDeployed().oracle);
        uint256 dur = s.oracleWindowSeconds;
        uint256 horizon = 6 hours;
        uint256 t0 = block.timestamp;
        (uint256 p0, , , ) = o.peek(BTC);

        uint256[] memory times = new uint256[](64);
        uint256 n;
        for (uint256 k; t0 + k * (dur + 1) <= t0 + horizon; k++) {
            times[n++] = t0 + k * (dur + 1);
            uint256 g = t0 + k * (dur + 1) + 2 * dur;
            if (g <= t0 + horizon) times[n++] = g;
        }
        for (uint256 i = 1; i < n; i++) {
            uint256 v = times[i];
            uint256 j = i;
            while (j > 0 && times[j - 1] > v) { times[j] = times[j - 1]; j--; }
            times[j] = v;
        }
        for (uint256 i; i < n; i++) {
            if (i > 0 && times[i] == times[i - 1]) continue;
            vm.warp(times[i]);
            _postHighest(o, s.keeper, s.oracleMaxDeviationBps);
        }
        (uint256 p1, , , ) = o.peek(BTC);

        // (1.25)^(floor(6h/1h)+1) = 1.25^7 ~ 4.768; the schedule reaches 1.25^5 ~ 3.05.
        uint256 bound1e4 = 47_683;
        uint256 ratio1e4 = p1 * 10_000 / p0;
        assertLe(ratio1e4, bound1e4, "within (1+W)^(floor(T/d)+1)");
        assertGe(ratio1e4, 30_000, "the schedule does reach ~3.05x: the limit slows, it does not stop");
    }
}
