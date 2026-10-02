// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";
import "../src/PerpetualExchange.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2_5.sol";
import "./TenantFixture.sol";

/// @notice ADR-008 review follow-up (PR #228): the tenant oracle's rate limit,
///         the per-tenant launch parameters, and what `VerifyTenant` must
///         catch when any of them — or the ownership, the proxy
///         implementation or the recorded deployer — no longer matches the
///         config. Same local setup as `DeployTenant.t.sol`: mocks only, no
///         fork, nothing written.
contract TenantHardeningTest is TenantFixture {
    MockUSDC   usdc;
    MockOracle source;
    TenantVerifyHarness verifier;

    address deployer = makeAddr("tenant-deployer");
    address trader   = makeAddr("trader");

    bytes32 constant BTC  = keccak256("sBTC");
    bytes32 constant AAPL = keccak256("sAAPL");

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        source = new MockOracle();
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) source.addAsset(keccak256(bytes(syms[i])), (i + 1) * 100e8);
        verifier = new TenantVerifyHarness();
    }

    function _valid() internal returns (Spec memory) {
        return _spec("bank-a", address(usdc), address(source));
    }

    function _deploy(Spec memory s) internal returns (DeployTenant script, TenantBase.TenantDeployed memory d) {
        script = _deployTenant(s, deployer);
        d = script.lastDeployed();
    }

    function _refusedJson(string memory json, string memory id, bytes memory reason) internal {
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        script.setAllowEoaAdmin(true);
        vm.expectRevert(reason);
        script.runWithConfig(json, id);
    }

    function _refused(Spec memory s, bytes memory reason) internal {
        _refusedJson(_json(s), s.id, reason);
    }

    function _verifyFails(Spec memory s, string memory record, bytes memory reason) internal {
        vm.expectRevert(reason);
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    // ── F1: the oracle's rate limit ─────────────────────────────────────────

    /// @dev The per-post step cap bounds one post; the window bounds a series.
    ///      Within one block, steps that each respect the step cap stop being
    ///      accepted once their sum leaves the window cap.
    function test_oracleRateLimit_boundsCumulativeMoveWithinOneWindow() public {
        Spec memory s = _valid();
        (, TenantBase.TenantDeployed memory d) = _deploy(s);
        GuardedOracle o = GuardedOracle(d.oracle);
        (uint256 p0, ) = o.getPrice(BTC);
        assertEq(p0, 100e8);

        vm.startPrank(s.keeper);
        o.updatePrice(BTC, 110e8);   // +10% from the window's opening price
        o.updatePrice(BTC, 121e8);   // +21%
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.WindowDeviationTooLarge.selector, BTC, 133.1e8, 100e8));
        o.updatePrice(BTC, 133.1e8); // +33.1% > 25%: refused although the step is 10%
        // A step within the window cap still lands.
        o.updatePrice(BTC, 125e8);
        vm.stopPrank();

        (uint256 p1, ) = o.getPrice(BTC);
        assertEq(p1, 125e8, "price stays within the window cap");
        assertLe(p1 * 10_000, p0 * (10_000 + s.oracleWindowDeviationBps), "cumulative move <= window cap");
    }

    /// @dev The limit slows the keeper down; it never locks it out. Once the
    ///      window and the one before it have passed, the next window opens at
    ///      the current price.
    function test_oracleRateLimit_keeperProgressesAfterTheWindow() public {
        Spec memory s = _valid();
        (, TenantBase.TenantDeployed memory d) = _deploy(s);
        GuardedOracle o = GuardedOracle(d.oracle);

        vm.startPrank(s.keeper);
        o.updatePrice(BTC, 110e8);
        o.updatePrice(BTC, 121e8);
        vm.expectPartialRevert(GuardedOracle.WindowDeviationTooLarge.selector);
        o.updatePrice(BTC, 133.1e8);

        // One window later the previous anchor still counts (no reset at the roll)...
        vm.warp(block.timestamp + s.oracleWindowSeconds + 1);
        vm.expectPartialRevert(GuardedOracle.WindowDeviationTooLarge.selector);
        o.updatePrice(BTC, 133.1e8);
        // ...two windows later it does not.
        vm.warp(block.timestamp + s.oracleWindowSeconds + 1);
        o.updatePrice(BTC, 133.1e8);
        vm.stopPrank();
        (uint256 p, ) = o.getPrice(BTC);
        assertEq(p, 133.1e8);
    }

    function test_referenceSource_isWired_andMustBeIndependent() public {
        MockOracle ref = new MockOracle();
        ref.addAsset(BTC, 100e8);

        Spec memory s = _valid();
        s.referenceSource = address(ref);
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        assertEq(GuardedOracle(d.oracle).referenceSource(), address(ref));
        verifier.verify(_json(s), s.id, script.lastRecordJson(), s.admin);

        // A reference the tenant's own keys control is no cross-check.
        bytes memory notIndependent =
            bytes("shared.referenceSource must be an independent feed, not a tenant role address or the settlement token");
        s = _valid();
        s.referenceSource = s.keeper;
        _refused(s, notIndependent);
        s = _valid();
        s.referenceSource = s.admin;
        _refused(s, notIndependent);
        s = _valid();
        s.referenceSource = address(usdc);
        _refused(s, notIndependent);
        s = _valid();
        s.referenceSource = makeAddr("no-code-feed");
        _refused(s, bytes("shared.referenceSource has no code on this chain"));
    }

    function test_mainnet_requiresReferenceSourceAndContractAdmin() public {
        vm.chainId(8453);
        Spec memory s = _valid();
        s.chainId = 8453;
        _refused(s, bytes("shared.referenceSource must be set on Base mainnet"));

        MockOracle ref = new MockOracle();
        s.referenceSource = address(ref);
        // ALLOW_EOA_ADMIN does not exist on mainnet (setAllowEoaAdmin(true) in _refused).
        _refused(s, bytes("roles.admin must be a contract on Base mainnet"));

        vm.etch(s.admin, hex"00");   // stand-in for a multisig
        (DeployTenant script, ) = _deploy(s);
        verifier.verify(_json(s), s.id, script.lastRecordJson(), s.admin);
    }

    // ── F7: every new field is required, bounded, and null where it does not apply

    function test_refuses_newParamsOutOfRange() public {
        Spec memory s;
        s = _valid(); s.oracleMaxDeviationBps = 0;
        _refused(s, bytes("params: oracleMaxDeviationBps must be in [100, 2000] (0 = no step cap is not allowed)"));
        s = _valid(); s.oracleMaxDeviationBps = 2_001;
        _refused(s, bytes("params: oracleMaxDeviationBps must be in [100, 2000] (0 = no step cap is not allowed)"));
        s = _valid(); s.oracleWindowSeconds = 0;
        _refused(s, bytes("params: oracleWindowSeconds must be in [900, 86400]"));
        s = _valid(); s.oracleWindowSeconds = 899;
        _refused(s, bytes("params: oracleWindowSeconds must be in [900, 86400]"));
        s = _valid(); s.oracleWindowSeconds = 86_401;
        _refused(s, bytes("params: oracleWindowSeconds must be in [900, 86400]"));
        s = _valid(); s.oracleWindowDeviationBps = 0;
        _refused(s, bytes("params: oracleWindowDeviationBps must be in [100, 3000] (0 = no rate limit is not allowed)"));
        s = _valid(); s.oracleWindowDeviationBps = 3_001;
        _refused(s, bytes("params: oracleWindowDeviationBps must be in [100, 3000] (0 = no rate limit is not allowed)"));
        s = _valid(); s.maxLeverage = 0;
        _refused(s, bytes("params: maxLeverage must be in [1, 5]"));
        s = _valid(); s.maxLeverage = 6;
        _refused(s, bytes("params: maxLeverage must be in [1, 5]"));
        s = _valid(); s.liquidationPenaltyBps = 5_001;
        _refused(s, bytes("params: liquidationPenaltyBps must be in [0, 5000]"));
        s = _valid(); s.markPremiumCapBps = 201;
        _refused(s, bytes("params: markPremiumCapBps must be in [0, 200]"));
        s = _valid(); s.vaultFeeShareBps = 10_001;
        _refused(s, bytes("params: vaultFeeShareBps must be in [0, 10000]"));
        s = _valid(); s.vaultRedeemFeeBps = 301;
        _refused(s, bytes("params: vaultRedeemFeeBps must be in [0, 300]"));
        s = _valid(); s.vaultMinReserveRatioBps = 9_999;
        _refused(s, bytes("params: vaultMinReserveRatioBps must be in [10000, 20000]"));
        s = _valid(); s.vaultMinReserveRatioBps = 20_001;
        _refused(s, bytes("params: vaultMinReserveRatioBps must be in [10000, 20000]"));
        s = _valid(); s.marketOperator = s.admin;
        _refused(s, bytes("roles: admin must differ from marketOperator"));
    }

    function test_refuses_missingNullAndMisplacedFields() public {
        Spec memory s = _valid();
        string memory j = _json(s);

        _refusedJson(vm.replace(j, "\"schemaVersion\":3", "\"schemaVersion\":2"), s.id,
            bytes("tenant config: schemaVersion must be 3"));
        // Missing: no field has a default.
        _refusedJson(vm.replace(j, ",\"oracleWindowDeviationBps\":2500", ""), s.id,
            bytes("tenant config: .params.oracleWindowDeviationBps is missing (no field has a default)"));
        _refusedJson(vm.replace(j, ",\"maxLeverage\":5", ""), s.id,
            bytes("tenant config: .params.maxLeverage is missing (no field has a default)"));
        _refusedJson(vm.replace(j, ",\"referenceSource\":\"none\"", ""), s.id,
            bytes("tenant config: .shared.referenceSource is missing (no field has a default)"));
        _refusedJson(vm.replace(j, "\"referenceSource\":\"none\"", "\"referenceSource\":\"0x0000000000000000000000000000000000000000\""),
            s.id, bytes("shared.referenceSource: write \"none\", not the zero address"));

        // A guarded oracle without its limits.
        _refusedJson(vm.replace(j, "\"oracleMaxDeviationBps\":1000", "\"oracleMaxDeviationBps\":null"), s.id,
            bytes("tenant config: params.oracleMaxDeviationBps / oracleWindowSeconds / oracleWindowDeviationBps must be numbers for oracleKind 'guarded'"));
        // A vault without its parameters.
        _refusedJson(vm.replace(j, "\"vaultRedeemFeeBps\":30", "\"vaultRedeemFeeBps\":null"), s.id,
            bytes("tenant config: params.vaultRedeemFeeBps / vaultMinReserveRatioBps must be numbers when params.deployVault is true"));

        // A mock oracle that claims limits it does not have.
        Spec memory m = _valid();
        m.deployVault = false;
        string memory mj = vm.replace(_json(m), "\"oracleKind\":\"guarded\"", "\"oracleKind\":\"mock\"");
        _refusedJson(mj, m.id,
            bytes("tenant config: params.oracleMaxDeviationBps / oracleWindowSeconds / oracleWindowDeviationBps must be null for oracleKind 'mock' (MockOracle has no limits)"));
        m.oracleKind = "mock";
        m.referenceSource = address(new MockOracle());
        _refused(m, bytes("tenant config: shared.referenceSource must be \"none\" for oracleKind 'mock'"));

        // No vault, yet vault parameters.
        Spec memory nv = _valid();
        nv.deployVault = false;
        _refusedJson(vm.replace(_json(nv), "\"vaultRedeemFeeBps\":null", "\"vaultRedeemFeeBps\":30"), nv.id,
            bytes("tenant config: params.vaultRedeemFeeBps / vaultMinReserveRatioBps must be null when params.deployVault is false"));
    }

    // ── F8: the exchange is closed while it is being configured ─────────────

    function test_exchangeStaysPausedUntilConfigured_thenOpensBeforeHandover() public {
        Spec memory s = _valid();
        vm.recordLogs();
        (, TenantBase.TenantDeployed memory d) = _deploy(s);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 pausedSig   = keccak256("Paused(address)");
        bytes32 unpausedSig = keccak256("Unpaused(address)");
        bytes32 kycSig      = keccak256("KycRegistrySet(address)");
        bytes32 capSig      = keccak256("MaxOpenInterestSet(bytes32,uint256,uint256)");
        bytes32 ownerSig    = keccak256("OwnershipTransferred(address,address)");
        uint256 pausedAt = type(uint256).max;
        uint256 unpausedAt = type(uint256).max;
        uint256 firstConfig = type(uint256).max;
        uint256 lastConfig;
        uint256 handover = type(uint256).max;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != d.exchange) continue;
            bytes32 t = logs[i].topics[0];
            if (t == pausedSig) pausedAt = i;
            else if (t == unpausedSig) unpausedAt = i;
            else if (t == kycSig || t == capSig) {
                if (firstConfig == type(uint256).max) firstConfig = i;
                lastConfig = i;
            } else if (t == ownerSig && address(uint160(uint256(logs[i].topics[2]))) == s.admin) handover = i;
        }
        assertLt(pausedAt, firstConfig, "paused before the KYC gate and the caps are set");
        assertGt(unpausedAt, lastConfig, "opened only after the configuration");
        assertLt(unpausedAt, handover, "opened by the deployer, before the handover");
        assertFalse(PerpetualExchange(d.exchange).paused());
        assertEq(PerpetualExchange(d.exchange).pausedAt(), 0, "no pause window left open");
    }

    // ── F5: VerifyTenant catches drift in every class of parameter ──────────

    function test_verify_catchesOracleDrift() public {
        Spec memory s = _valid();
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        GuardedOracle o = GuardedOracle(d.oracle);
        uint256 snap = vm.snapshotState();

        // The rate limit switched off (the state the review found).
        vm.prank(s.admin);
        o.setWindowLimit(0, 0);
        _verifyFails(s, record, bytes("verify tenant failed: oracle rate limit is on (window != 0)"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setWindowLimit(30 minutes, s.oracleWindowDeviationBps);
        _verifyFails(s, record, bytes("verify tenant mismatch: oracle.windowDuration"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setWindowLimit(s.oracleWindowSeconds, 5_000);
        _verifyFails(s, record, bytes("verify tenant mismatch: oracle.maxWindowDeviationBps"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setRiskParams(2_000, 0);
        _verifyFails(s, record, bytes("verify tenant mismatch: oracle.maxDeviationBps"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setRiskParams(0, 0);
        _verifyFails(s, record, bytes("verify tenant failed: oracle step cap is on (maxDeviationBps != 0)"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setRiskParams(s.oracleMaxDeviationBps, 1 hours);
        _verifyFails(s, record, bytes("verify tenant mismatch: oracle.maxPriceAge (0: readers enforce staleness)"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        o.setReferenceSource(address(source));
        _verifyFails(s, record, bytes("verify tenant mismatch: oracle.referenceSource"));

        vm.revertToState(snap);
        vm.prank(s.guardian);
        o.setPaused(true);
        _verifyFails(s, record, bytes("verify tenant failed: oracle not paused"));

        // A frozen asset is the guardian's call: reported, not failed.
        vm.revertToState(snap);
        vm.prank(s.guardian);
        o.setAssetFrozen(BTC, true);
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function test_verify_catchesExchangeDrift() public {
        Spec memory s = _valid();
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        PerpetualExchange ex = PerpetualExchange(d.exchange);
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin); ex.setMaxPriceAge(1 days);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.maxPriceAge"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setMaxOpenInterest(BTC, 2_000e18, 2_000e18);
        _verifyFails(s, record, bytes("verify tenant failed: OI cap != config for sBTC"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setMaxOpenInterest(AAPL, 0, 0);
        _verifyFails(s, record, bytes("verify tenant failed: OI cap != config for sAAPL"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setMaxProfitBps(BTC, 60_000);
        _verifyFails(s, record, bytes("verify tenant failed: maxProfitBps for sBTC"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setMaxLeverageFor(BTC, 3);
        _verifyFails(s, record, bytes("verify tenant failed: maxLeverage for sBTC"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setLiquidationPenaltyBps(1_000);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.liquidationPenaltyBps"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setMarkPremiumCapBps(50);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.markPremiumCapBps"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setVaultFeeShareBps(5_000);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.vaultFeeShareBps"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setTradingFeeBps(20);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.TRADING_FEE_BPS (legacy, contract default)"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setBorrowFeePerHour(5);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.BORROW_FEE_BPS_PER_HOUR (legacy, contract default)"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setExecutionFee(1e15);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.executionFee"));
        vm.revertToState(snap);
        vm.prank(s.admin); ex.setAgentAuthorized(d.sessionManager, false);
        _verifyFails(s, record, bytes("verify tenant failed: AgentSessionManager authorised on the exchange"));
    }

    function test_verify_catchesVaultDriftAndUpgrade() public {
        Spec memory s = _valid();
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        AssetVaultV2_5 v = AssetVaultV2_5(d.assetVault);
        uint256 snap = vm.snapshotState();

        vm.prank(s.risk); v.setRiskParams(50, s.vaultMinReserveRatioBps, 6 hours);
        _verifyFails(s, record, bytes("verify tenant mismatch: vault.redeemFeeBps"));
        vm.revertToState(snap);
        vm.prank(s.risk); v.setRiskParams(s.vaultRedeemFeeBps, 12_000, 6 hours);
        _verifyFails(s, record, bytes("verify tenant mismatch: vault.minReserveRatioBps"));
        vm.revertToState(snap);
        vm.prank(s.risk); v.setRiskParams(s.vaultRedeemFeeBps, s.vaultMinReserveRatioBps, 30 days);
        _verifyFails(s, record, bytes("verify tenant mismatch: vault.maxPriceAge"));

        // An asset opened for minting by the risk key is operations, not drift.
        vm.revertToState(snap);
        vm.prank(s.risk); v.setAssetCap(BTC, 1_000e18);
        verifier.verify(_json(s), s.id, record, s.admin);

        // An upgrade to any other implementation — even the same code.
        vm.revertToState(snap);
        AssetVaultV2_5 otherImpl = new AssetVaultV2_5();
        vm.prank(s.admin);
        v.upgradeToAndCall(address(otherImpl), "");
        _verifyFails(s, record, bytes("verify tenant failed: AssetVaultV2 implementation slot != the recorded implementation"));
    }

    function test_verify_catchesOwnershipDrift() public {
        Spec memory s = _valid();
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        Ownable(d.feeRouter).transferOwnership(makeAddr("elsewhere"));
        _verifyFails(s, record, bytes("verify tenant mismatch: feeRouter.owner"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(0x00, s.keeper);
        _verifyFails(s, record, bytes("verify tenant failed: a tenant role other than the owner holds DEFAULT_ADMIN_ROLE"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.tokens[0]).grantRole(0x00, s.treasury);
        _verifyFails(s, record, bytes("verify tenant failed: a tenant role other than the owner holds DEFAULT_ADMIN_ROLE"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.assetVault).revokeRole(keccak256("RISK_ROLE"), s.risk);
        _verifyFails(s, record, bytes("verify tenant failed: vault RISK_ROLE is the tenant risk key"));
    }

    function test_verify_catchesDeployerDrift() public {
        Spec memory s = _valid();
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        uint256 snap = vm.snapshotState();

        // The record names someone else as the deployer: every "the deployer
        // keeps nothing" check would then look at the wrong key.
        string memory forged = vm.replace(record, vm.toString(deployer), vm.toString(makeAddr("not-the-deployer")));
        assertEq(vm.parseJsonAddress(forged, ".deployer"), makeAddr("not-the-deployer"), "the swap took");
        _verifyFails(s, forged, bytes("verify tenant failed: Oracle was not created by the recorded deployer"));

        // ...or a tenant key, which created nothing either.
        string memory asRisk = vm.replace(record, vm.toString(deployer), vm.toString(s.risk));
        _verifyFails(s, asRisk, bytes("verify tenant failed: Oracle was not created by the recorded deployer"));

        // Leftover privileges of the real deployer.
        vm.prank(s.admin);
        KYCRegistry(d.kyc).setVerifier(deployer, true);
        _verifyFails(s, record, bytes("verify tenant failed: deployer is not a KYC verifier"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        PerpetualExchange(d.exchange).setAgentAuthorized(deployer, true);
        _verifyFails(s, record, bytes("verify tenant failed: deployer is not an authorised agent on the exchange"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        PerpetualExchange(d.exchange).setMarketOperator(deployer);
        _verifyFails(s, record, bytes("verify tenant mismatch: exchange.marketOperator"));
    }

    /// @dev The mock-oracle tenant has no oracle limits to verify; it is still
    ///      checked for the recorded deployer and the leftover privileges.
    function test_verify_mockTenant_deployerAndNoVaultProxies() public {
        Spec memory s = _spec("bank-m", address(usdc), address(source));
        s.oracleKind = "mock";
        s.deployVault = false;
        s.assets = "\"sBTC\",\"sETH\",\"sGOLD\"";
        (DeployTenant script, TenantBase.TenantDeployed memory d) = _deploy(s);
        string memory record = script.lastRecordJson();
        verifier.verify(_json(s), s.id, record, s.admin);

        string memory forged = vm.replace(record, vm.toString(deployer), vm.toString(makeAddr("not-the-deployer")));
        _verifyFails(s, forged, bytes("verify tenant failed: Oracle was not created by the recorded deployer"));

        vm.prank(s.keeper);
        Ownable(d.oracle).transferOwnership(deployer);
        _verifyFails(s, record, bytes("verify tenant mismatch: mockOracle.owner (price writer)"));
    }
}
