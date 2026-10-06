// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";
import "../src/VCKycRegistry.sol";
import "../src/PerpetualExchange.sol";
import "./TenantFixture.sol";

/// @notice Tenant config schema v4: `params.kycRegistry: "vc"` deploys a
///         VCKycRegistry (docs/SSI_RWA_ACCESS.md) as the exchange's KYC gate,
///         and `assets.additionalRwa` gates registered assets beyond the
///         built-in eight. Both are decided at deployment time, so the daily
///         `VerifyTenant` reads them back like every other setting.
contract TenantVcKycTest is TenantFixture {
    MockUSDC   usdc;
    MockOracle source;
    TenantVerifyHarness verifier;

    address deployer = makeAddr("tenant-deployer");
    address stranger = makeAddr("not-a-tenant-key");
    uint256 issuerKey = 0xA11CE;
    address issuer;
    address investor = makeAddr("investor");

    bytes32 constant GOLD = keccak256("sGOLD");
    bytes32 constant AAPL = keccak256("sAAPL");
    bytes32 constant BTC  = keccak256("sBTC");
    bytes32 constant QI   = keccak256("QUALIFIED_INVESTOR");

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        source = new MockOracle();
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) source.addAsset(keccak256(bytes(syms[i])), (i + 1) * 100e8);
        verifier = new TenantVerifyHarness();
        issuer = vm.addr(issuerKey);
    }

    function _vcSpec() internal returns (Spec memory s) {
        s = _spec("rwa-poc", address(usdc), address(source));
        s.kycRegistry = "vc";
        s.additionalRwa = "\"sGOLD\"";
    }

    function _deploy(Spec memory s) internal returns (string memory record, TenantBase.TenantDeployed memory d) {
        DeployTenant script = _deployTenant(s, deployer);
        record = script.lastRecordJson();
        d = script.lastDeployed();
    }

    function _verifyFails(Spec memory s, string memory record, bytes memory reason) internal {
        vm.expectRevert(reason);
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function _attest(VCKycRegistry reg, address subject, bytes32 credentialHash)
        internal view returns (VCKycRegistry.Attestation memory a, bytes memory sig)
    {
        a = VCKycRegistry.Attestation({
            subject: subject,
            credentialType: QI,
            credentialHash: credentialHash,
            statusListIndex: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 30 days),
            nonce: reg.nonces(subject),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(issuerKey, reg.attestationDigest(a));
        sig = abi.encodePacked(r, sg, v);
    }

    // ── deployment ──────────────────────────────────────────────────────────

    function test_vc_deploysVcRegistryOwnedByAdmin_goldGated_verifyPasses() public {
        Spec memory s = _vcSpec();
        vm.recordLogs();
        (string memory record, TenantBase.TenantDeployed memory d) = _deploy(s);
        VCKycRegistry reg = VCKycRegistry(d.kyc);
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        assertEq(reg.owner(), s.admin, "born owned by the tenant admin");
        assertEq(reg.pendingOwner(), address(0), "no two-step transfer left open");
        assertEq(reg.requiredType(), QI);
        assertEq(reg.issuerTypeCount(deployer), 0, "the deployer is no issuer");
        assertEq(address(ex.kyc()), d.kyc, "the exchange gates on the VC registry");

        assertTrue(ex.rwaAsset(GOLD), "sGOLD gated by assets.additionalRwa");
        assertTrue(ex.rwaAsset(AAPL), "built-in RWA unchanged");
        assertFalse(ex.rwaAsset(BTC), "crypto stays open");
        assertEq(ex.maxLongOI(GOLD), s.oiCapRwaUsdc * 1e18, "sGOLD takes the RWA OI cap");

        // Full read-back, with the privilege history of the whole deployment.
        verifier.verify(_json(s), s.id, record, s.admin);
        assertTrue(verifier.isRwaFor(_json(s), s.id, "sGOLD"));
        assertFalse(verifier.isRwaFor(_json(s), s.id, "sETH"));
    }

    function test_vc_rwaMarketsClosedUntilAnIssuerIsTrusted_thenACredentialOpensThem() public {
        Spec memory s = _vcSpec();
        (, TenantBase.TenantDeployed memory d) = _deploy(s);
        VCKycRegistry reg = VCKycRegistry(d.kyc);
        PerpetualExchange ex = PerpetualExchange(d.exchange);
        vm.warp(block.timestamp + 30 minutes + 1);   // post-unpause grace

        usdc.mint(investor, 5_000e18);
        vm.deal(investor, 1 ether);
        vm.startPrank(investor);
        usdc.approve(d.exchange, type(uint256).max);
        ex.depositMargin(3_000e18);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        ex.openPosition{value: 1e14}(GOLD, true, 100e18, 1);
        vm.stopPrank();

        // A credential from an issuer the admin has not trusted is refused.
        (VCKycRegistry.Attestation memory a, bytes memory sig) = _attest(reg, investor, keccak256("vc-1"));
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UntrustedIssuer.selector, issuer, QI));
        reg.submitAttestation(a, sig);

        // Only the admin appoints issuers; the deployer has no say.
        vm.prank(deployer);
        vm.expectRevert();
        reg.setIssuer(issuer, QI, true);
        vm.prank(s.admin);
        reg.setIssuer(issuer, QI, true);

        reg.submitAttestation(a, sig);
        assertTrue(reg.isVerified(investor));
        vm.prank(investor);
        ex.openPosition{value: 1e14}(GOLD, true, 100e18, 1);
        vm.prank(investor);
        ex.openPosition{value: 1e14}(AAPL, true, 100e18, 1);
    }

    function test_allowlist_withAdditionalRwa_gatesGoldOnTheAllowlistRegistry() public {
        Spec memory s = _spec("bank-g", address(usdc), address(source));
        s.additionalRwa = "\"sGOLD\"";
        (string memory record, TenantBase.TenantDeployed memory d) = _deploy(s);
        assertTrue(PerpetualExchange(d.exchange).rwaAsset(GOLD));
        assertEq(Ownable(d.kyc).owner(), s.admin);
        KYCRegistry(d.kyc).verifiers(s.admin);   // it is the allowlist registry
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    // ── read-back catches drift ─────────────────────────────────────────────

    function test_vc_verify_issuerAppointmentIsANote_deployerOrContractIsAFailure() public {
        Spec memory s = _vcSpec();
        (string memory record, TenantBase.TenantDeployed memory d) = _deploy(s);
        VCKycRegistry reg = VCKycRegistry(d.kyc);
        vm.recordLogs();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        reg.setIssuer(stranger, QI, true);
        verifier.verify(_json(s), s.id, record, s.admin);

        vm.revertToState(snap);
        vm.prank(s.admin);
        reg.setIssuer(deployer, QI, true);
        _verifyFails(s, record, bytes("verify tenant failed: deployer is not a trusted credential issuer"));

        // A contract of the set, or an address only the event history names.
        vm.revertToState(snap);
        vm.prank(s.admin);
        reg.setIssuer(d.exchange, QI, true);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected trusted credential issuer on KYCRegistry"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        reg.setIssuer(d.insuranceSeeder, QI, true);
        _verifyFails(s, record, bytes("verify tenant failed: unexpected trusted credential issuer on KYCRegistry"));

        // Trusted, then removed: no longer a holder.
        vm.revertToState(snap);
        vm.startPrank(s.admin);
        reg.setIssuer(deployer, QI, true);
        reg.setIssuer(deployer, QI, false);
        vm.stopPrank();
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function test_vc_verify_catchesPendingOwnerAndChangedRequiredType() public {
        Spec memory s = _vcSpec();
        (string memory record, TenantBase.TenantDeployed memory d) = _deploy(s);
        VCKycRegistry reg = VCKycRegistry(d.kyc);
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        reg.transferOwnership(stranger);
        _verifyFails(s, record, bytes("verify tenant mismatch: vcKyc.pendingOwner"));

        vm.revertToState(snap);
        vm.prank(s.admin);
        reg.setRequiredType(keccak256("KYC_BASIC"));
        _verifyFails(s, record, bytes("verify tenant failed: vcKyc.requiredType == QUALIFIED_INVESTOR"));
    }

    function test_verify_refusesAConfigThatDisagreesWithTheChain() public {
        Spec memory s = _vcSpec();
        (string memory record, ) = _deploy(s);

        // Deployed with sGOLD gated; a config without it is not what is on chain.
        Spec memory noGold = _vcSpec();
        noGold.additionalRwa = "";
        _verifyFails(noGold, record, bytes("verify tenant failed: rwaAsset flag sGOLD"));

        // Deployed with a VC registry; an allowlist config expects other code.
        Spec memory allow = _vcSpec();
        allow.kycRegistry = "allowlist";
        _verifyFails(allow, record,
            bytes("verify tenant failed: KYCRegistry runtime code differs from this repository's build of KYCRegistry"));
    }

    function test_allowlistDeployment_failsAVcConfig() public {
        Spec memory s = _spec("bank-h", address(usdc), address(source));
        (string memory record, ) = _deploy(s);
        Spec memory vc = _spec("bank-h", address(usdc), address(source));
        vc.kycRegistry = "vc";
        _verifyFails(vc, record,
            bytes("verify tenant failed: KYCRegistry runtime code differs from this repository's build of VCKycRegistry"));
    }

    // ── config refusals ─────────────────────────────────────────────────────

    function _refused(Spec memory s, bytes memory reason) internal {
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        script.setAllowEoaAdmin(true);
        string memory json = _json(s);
        vm.expectRevert(reason);
        script.runWithConfig(json, s.id);
    }

    function test_refuses_additionalRwaThatRemovesOrInventsAnything() public {
        Spec memory s = _vcSpec();
        s.additionalRwa = "\"sAAPL\"";
        _refused(s, bytes("assets.additionalRwa: sAAPL is already RWA (built in) - the list only adds"));

        s = _vcSpec();
        s.assets = "\"sBTC\",\"sETH\"";
        s.additionalRwa = "\"sGOLD\"";
        _refused(s, bytes("assets.additionalRwa: sGOLD is not in assets.registered"));

        s = _vcSpec();
        s.additionalRwa = "\"sGOLD\",\"sGOLD\"";
        _refused(s, bytes("assets.additionalRwa: duplicate symbol"));
    }

    function test_refuses_badOrMissingKycKind() public {
        Spec memory s = _vcSpec();
        s.kycRegistry = "kyc";
        _refused(s, bytes("tenant config: params.kycRegistry must be 'allowlist' or 'vc'"));

        s = _vcSpec();
        string memory j = _json(s);
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        script.setAllowEoaAdmin(true);
        vm.expectRevert(bytes("tenant config: .params.kycRegistry is missing (no field has a default)"));
        script.runWithConfig(vm.replace(j, ",\"kycRegistry\":\"vc\"", ""), s.id);
        vm.expectRevert(bytes("tenant config: .assets.additionalRwa is missing (no field has a default)"));
        script.runWithConfig(vm.replace(j, ",\"additionalRwa\":[\"sGOLD\"]", ""), s.id);
    }
}
