// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/VCKycRegistry.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/AgentSessionManager.sol";

/// @dev 共用：發證者金鑰、簽 Attestation。
abstract contract VCKycFixture is Test {
    VCKycRegistry registry;

    uint256 issuerPk;
    address issuer;
    uint256 otherIssuerPk;
    address otherIssuer;
    uint256 malloryPk;
    address mallory;

    address investor = makeAddr("investor");
    address relayer = makeAddr("relayer");

    bytes32 constant QI = keccak256("QUALIFIED_INVESTOR");
    bytes32 constant BASIC = keccak256("KYC_BASIC");

    uint64 constant T0 = 1_790_000_000; // 2026-09 左右，固定時間讓斷言穩定
    uint64 constant YEAR = 365 days;

    function _setUpRegistry() internal {
        vm.warp(T0);
        (issuer, issuerPk) = makeAddrAndKey("issuer");
        (otherIssuer, otherIssuerPk) = makeAddrAndKey("otherIssuer");
        (mallory, malloryPk) = makeAddrAndKey("mallory");
        registry = new VCKycRegistry(address(this), QI);
        registry.setIssuer(issuer, QI, true);
        registry.setIssuer(issuer, BASIC, true);
        registry.setIssuer(otherIssuer, BASIC, true);
    }

    function _att(address subject, bytes32 ctype, bytes32 jtiHash)
        internal
        view
        returns (VCKycRegistry.Attestation memory a)
    {
        a = VCKycRegistry.Attestation({
            subject: subject,
            credentialType: ctype,
            credentialHash: jtiHash,
            statusListIndex: 7,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + YEAR,
            nonce: registry.nonces(subject),
            deadline: block.timestamp + 30 days
        });
    }

    function _sign(uint256 pk, VCKycRegistry.Attestation memory a) internal view returns (bytes memory) {
        bytes32 digest = this.digestOf(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev attestationDigest 吃 calldata，從 memory 呼叫要經過外部呼叫。
    function digestOf(VCKycRegistry.Attestation calldata a) external view returns (bytes32) {
        return registry.attestationDigest(a);
    }

    function _submit(uint256 pk, VCKycRegistry.Attestation memory a) internal returns (address) {
        bytes memory sig = _sign(pk, a);
        vm.prank(relayer);
        return registry.submitAttestation(a, sig);
    }
}

contract VCKycRegistryTest is VCKycFixture {
    function setUp() public {
        _setUpRegistry();
    }

    // ── 驗簽與登記 ─────────────────────────────────────────────────────────────

    function test_validAttestation_recordsAndVerifies() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        vm.expectEmit(true, true, true, true, address(registry));
        emit VCKycRegistry.AttestationSubmitted(
            investor, QI, issuer, a.credentialHash, 7, a.issuedAt, a.expiresAt, relayer
        );
        address got = _submit(issuerPk, a);
        assertEq(got, issuer);
        assertTrue(registry.isVerified(investor));
        assertEq(registry.nonces(investor), 1);
        assertTrue(registry.credentialUsed(a.credentialHash));
        (VCKycRegistry.Record memory r, bool valid) = registry.credentialOf(investor, QI);
        assertTrue(valid);
        assertEq(r.issuer, issuer);
        assertEq(r.expiresAt, a.expiresAt);
        assertEq(r.credentialHash, a.credentialHash);
        assertEq(r.epoch, 1);
    }

    function test_noCredential_notVerified() public view {
        assertFalse(registry.isVerified(investor));
    }

    function test_wrongSigner_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(malloryPk, a);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UntrustedIssuer.selector, mallory, QI));
        registry.submitAttestation(a, sig);
    }

    function test_tamperedField_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a);
        a.expiresAt += 10 * YEAR; // 投資人自己延長效期 → 還原出別的地址
        vm.expectRevert();
        registry.submitAttestation(a, sig);
        assertFalse(registry.isVerified(investor));
    }

    function test_malformedSignature_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        vm.expectRevert(VCKycRegistry.InvalidSignature.selector);
        registry.submitAttestation(a, hex"1234");
    }

    function test_issuerNotTrustedForType_rejected() public {
        // otherIssuer 只被信任簽 KYC_BASIC，不能簽合格投資人
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(otherIssuerPk, a);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UntrustedIssuer.selector, otherIssuer, QI));
        registry.submitAttestation(a, sig);
    }

    // ── 時效 ───────────────────────────────────────────────────────────────────

    function test_expiredAtSubmission_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        a.issuedAt = T0 - 2 * YEAR;
        a.expiresAt = T0 - 1;
        bytes memory sig = _sign(issuerPk, a);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.CredentialExpired.selector, a.expiresAt));
        registry.submitAttestation(a, sig);
    }

    function test_expiresAfterSubmission_isVerifiedTurnsFalse() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        assertTrue(registry.isVerified(investor));
        vm.warp(a.expiresAt - 1);
        assertTrue(registry.isVerified(investor));
        vm.warp(a.expiresAt);
        assertFalse(registry.isVerified(investor));
    }

    function test_deadlinePassed_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a);
        vm.warp(a.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.AttestationDeadlinePassed.selector, a.deadline));
        registry.submitAttestation(a, sig);
    }

    function test_issuedInFuture_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        a.issuedAt = T0 + 301;
        bytes memory sig = _sign(issuerPk, a);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.IssuedInFuture.selector, a.issuedAt));
        registry.submitAttestation(a, sig);
    }

    function test_invalidValidity_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        a.expiresAt = a.issuedAt;
        bytes memory sig = _sign(issuerPk, a);
        vm.expectRevert(VCKycRegistry.InvalidValidity.selector);
        registry.submitAttestation(a, sig);
    }

    // ── 撤銷 ───────────────────────────────────────────────────────────────────

    function test_revoke_byIssuer() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        vm.expectEmit(true, true, false, true, address(registry));
        emit VCKycRegistry.CredentialRevoked(issuer, a.credentialHash, issuer);
        vm.prank(issuer);
        registry.revoke(a.credentialHash);
        assertFalse(registry.isVerified(investor));
        assertTrue(registry.revoked(issuer, a.credentialHash));
    }

    function test_revoke_onlyOwnNamespace() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        // 另一個發證者撤銷同一個 hash，只寫進它自己的命名空間，不影響 issuer 的憑證
        vm.prank(otherIssuer);
        registry.revoke(a.credentialHash);
        assertTrue(registry.isVerified(investor));
        // 不受信任的地址不能撤銷
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.NotAuthorizedToRevoke.selector, mallory));
        registry.revoke(a.credentialHash);
    }

    function test_preRevoked_cannotBeSubmitted() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a);
        vm.prank(issuer);
        registry.revoke(a.credentialHash); // 鏈下清單先撤銷、同步上鏈，投資人還沒提交
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.CredentialIsRevoked.selector, a.credentialHash));
        registry.submitAttestation(a, sig);
    }

    function test_revokeAsOwner() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        registry.revokeAsOwner(issuer, a.credentialHash);
        assertFalse(registry.isVerified(investor));
        vm.prank(mallory);
        vm.expectRevert();
        registry.revokeAsOwner(issuer, a.credentialHash);
    }

    function test_revokeAllBefore() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        vm.warp(T0 + 100);
        vm.prank(issuer);
        registry.revokeAllBefore(T0 + 100);
        assertFalse(registry.isVerified(investor));
        // 只能往後推
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.RevokedBeforeCannotMoveBack.selector, T0 + 100, T0));
        registry.revokeAllBefore(T0);
        // 不能設到遙遠的未來（避免把之後的新憑證也預先作廢）
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.RevokedBeforeInFuture.selector, uint64(T0 + 100 + 1 days)));
        registry.revokeAllBefore(T0 + 100 + 1 days);
        // 水位之後重新簽發的憑證有效
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-2"));
        _submit(issuerPk, b);
        assertTrue(registry.isVerified(investor));
    }

    function test_issuerRemoved_invalidatesExisting() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        assertTrue(registry.isVerified(investor));
        vm.expectEmit(true, true, false, true, address(registry));
        emit VCKycRegistry.IssuerSet(issuer, QI, false, 1);
        registry.setIssuer(issuer, QI, false);
        assertFalse(registry.isVerified(investor));
        // 新的也送不進來
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-2"));
        bytes memory sig = _sign(issuerPk, b);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UntrustedIssuer.selector, issuer, QI));
        registry.submitAttestation(b, sig);
    }

    /// @dev 審查 #1：移除後再加回同一地址，舊憑證不得復活（例如金鑰外洩期間被簽出的憑證）；新簽的有效。
    function test_issuerReAdded_oldCredentialStaysDead_newOneWorks() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        assertEq(registry.trustEpoch(issuer, QI), 1);
        registry.setIssuer(issuer, QI, false);
        vm.expectEmit(true, true, false, true, address(registry));
        emit VCKycRegistry.IssuerSet(issuer, QI, true, 2);
        registry.setIssuer(issuer, QI, true);
        assertEq(registry.trustEpoch(issuer, QI), 2);
        assertFalse(registry.isVerified(investor), "old credential revived after re-trust");
        (VCKycRegistry.Record memory r, bool valid) = registry.credentialOf(investor, QI);
        assertEq(r.epoch, 1);
        assertFalse(valid);
        // 重新簽發（舊紀錄已失效，到期較短也能取代）
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-2"));
        b.expiresAt = a.expiresAt - 1 days;
        _submit(issuerPk, b);
        assertTrue(registry.isVerified(investor));
        (r,) = registry.credentialOf(investor, QI);
        assertEq(r.epoch, 2);
        // 另一類型的 epoch 互不影響
        assertEq(registry.trustEpoch(issuer, BASIC), 1);
    }

    // ── 覆蓋規則（審查 #3）──────────────────────────────────────────────────────

    function test_overwrite_shorterCredential_rejectedWhileCurrentValid() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-long"));
        _submit(issuerPk, a);
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-short"));
        b.expiresAt = a.expiresAt - 30 days;
        bytes memory sig = _sign(issuerPk, b);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.WouldReplaceLongerCredential.selector, a.expiresAt, b.expiresAt));
        registry.submitAttestation(b, sig);
        (VCKycRegistry.Record memory r,) = registry.credentialOf(investor, QI);
        assertEq(r.credentialHash, a.credentialHash);
        assertEq(registry.nonces(investor), 1, "rejected attempt must not consume the nonce");
    }

    function test_overwrite_otherIssuerShorter_rejected_longer_accepted() public {
        registry.setIssuer(otherIssuer, QI, true);
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-a"));
        _submit(issuerPk, a);
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-b"));
        b.expiresAt = a.expiresAt - 1;
        bytes memory sig = _sign(otherIssuerPk, b);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.WouldReplaceLongerCredential.selector, a.expiresAt, b.expiresAt));
        registry.submitAttestation(b, sig);
        // 到期較晚 → 取代
        b.expiresAt = a.expiresAt + 1;
        _submit(otherIssuerPk, b);
        (VCKycRegistry.Record memory r,) = registry.credentialOf(investor, QI);
        assertEq(r.issuer, otherIssuer);
        assertTrue(registry.isVerified(investor));
    }

    function test_overwrite_sameExpiry_newerIssuedAt_accepted_olderRejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        vm.warp(T0 + 10);
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-2"));
        b.expiresAt = a.expiresAt;
        b.issuedAt = a.issuedAt; // 同到期、同簽發 → 不是「較新」
        bytes memory sig = _sign(issuerPk, b);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.WouldReplaceLongerCredential.selector, a.expiresAt, b.expiresAt));
        registry.submitAttestation(b, sig);
        b.issuedAt = a.issuedAt + 10;
        _submit(issuerPk, b);
        (VCKycRegistry.Record memory r,) = registry.credentialOf(investor, QI);
        assertEq(r.credentialHash, b.credentialHash);
    }

    function test_overwrite_afterRevocation_shorterAccepted() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        vm.prank(issuer);
        registry.revoke(a.credentialHash);
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-2"));
        b.expiresAt = uint64(block.timestamp + 1 days);
        _submit(issuerPk, b);
        assertTrue(registry.isVerified(investor));
    }

    function test_removedIssuer_cannotRevoke() public {
        registry.setIssuer(otherIssuer, BASIC, false);
        assertEq(registry.issuerTypeCount(otherIssuer), 0);
        vm.prank(otherIssuer);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.NotAuthorizedToRevoke.selector, otherIssuer));
        registry.revoke(bytes32(uint256(1)));
    }

    // ── 類型 ───────────────────────────────────────────────────────────────────

    function test_insufficientType_basicDoesNotSatisfyQI() public {
        VCKycRegistry.Attestation memory a = _att(investor, BASIC, keccak256("urn:uuid:basic-1"));
        _submit(otherIssuerPk, a);
        assertTrue(registry.hasValidCredential(investor, BASIC));
        assertFalse(registry.isVerified(investor)); // requiredType = QI
        registry.setRequiredType(BASIC);
        assertTrue(registry.isVerified(investor));
    }

    function test_qiImpliesBasic() public {
        _submit(issuerPk, _att(investor, QI, keccak256("urn:uuid:qi-1")));
        registry.setRequiredType(BASIC);
        assertTrue(registry.isVerified(investor));
    }

    function test_unsupportedType_rejected() public {
        bytes32 other = keccak256("ACCREDITED_US");
        VCKycRegistry.Attestation memory a = _att(investor, other, keccak256("urn:uuid:x"));
        bytes memory sig = _sign(issuerPk, a);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UnsupportedCredentialType.selector, other));
        registry.submitAttestation(a, sig);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UnsupportedCredentialType.selector, other));
        registry.setRequiredType(other);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UnsupportedCredentialType.selector, other));
        registry.setIssuer(issuer, other, true);
        // owner 登記新類型後可用
        registry.setCredentialType(other, true);
        registry.setIssuer(issuer, other, true);
        _submit(issuerPk, _att(investor, other, keccak256("urn:uuid:x")));
        assertTrue(registry.hasValidCredential(investor, other));
        // 停用類型 → 既有憑證失效；不能停用 requiredType
        registry.setCredentialType(other, false);
        assertFalse(registry.hasValidCredential(investor, other));
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UnsupportedCredentialType.selector, QI));
        registry.setCredentialType(QI, false);
    }

    function test_constructor_rejectsUnsupportedRequiredType() public {
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.UnsupportedCredentialType.selector, bytes32(0)));
        new VCKycRegistry(address(this), bytes32(0));
    }

    // ── 重放 ───────────────────────────────────────────────────────────────────

    function test_replay_sameAttestation_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a);
        registry.submitAttestation(a, sig);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.BadNonce.selector, 1, 0));
        registry.submitAttestation(a, sig);
    }

    function test_replay_oldAttestationAfterNewer_rejected() public {
        // 同時簽了兩張（nonce 0 與 1），先送新的再拿舊的回來蓋——nonce 已過，拒絕
        VCKycRegistry.Attestation memory a0 = _att(investor, QI, keccak256("urn:uuid:qi-old"));
        VCKycRegistry.Attestation memory a1 = _att(investor, QI, keccak256("urn:uuid:qi-new"));
        a1.nonce = 1;
        a1.expiresAt += 1 days; // 較新的憑證到期較晚（覆蓋規則）
        bytes memory sig0 = _sign(issuerPk, a0);
        bytes memory sig1 = _sign(issuerPk, a1);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.BadNonce.selector, 0, 1));
        registry.submitAttestation(a1, sig1);
        registry.submitAttestation(a0, sig0);
        registry.submitAttestation(a1, sig1);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.BadNonce.selector, 2, 0));
        registry.submitAttestation(a0, sig0);
    }

    function test_replay_sameCredentialHash_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        VCKycRegistry.Attestation memory b = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, b);
        vm.expectRevert(abi.encodeWithSelector(VCKycRegistry.CredentialAlreadyUsed.selector, b.credentialHash));
        registry.submitAttestation(b, sig);
    }

    function test_replay_otherSubject_rejected() public {
        // 把給 investor 的簽章改成自己的地址 → 還原出別的簽者
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a);
        a.subject = mallory;
        vm.expectRevert();
        registry.submitAttestation(a, sig);
        assertFalse(registry.isVerified(mallory));
    }

    // ── domain ─────────────────────────────────────────────────────────────────

    function test_domain_otherRegistry_rejected() public {
        VCKycRegistry other = new VCKycRegistry(address(this), QI);
        other.setIssuer(issuer, QI, true);
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a); // 簽給 registry
        vm.expectRevert();
        other.submitAttestation(a, sig);
        assertFalse(other.isVerified(investor));
    }

    function test_domain_otherChain_rejected() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        bytes memory sig = _sign(issuerPk, a); // chainId 31337 的簽章
        vm.chainId(84532);
        vm.expectRevert();
        registry.submitAttestation(a, sig);
        assertFalse(registry.isVerified(investor));
    }

    function test_domainSeparator_matchesEip712Domain() public view {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = registry.eip712Domain();
        assertEq(name, "PepeLabVCKycRegistry");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(registry));
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
        assertEq(registry.domainSeparator(), expected);
    }

    /// @dev 與鏈下（ethers）算出的 digest 對照的固定向量：見 agent/issuer/issuer.test.ts 的同名段落。
    function test_typehash_isStable() public view {
        assertEq(
            registry.ATTESTATION_TYPEHASH(),
            keccak256(
                "QualifiedInvestorAttestation(address subject,bytes32 credentialType,bytes32 credentialHash,uint256 statusListIndex,uint64 issuedAt,uint64 expiresAt,uint256 nonce,uint256 deadline)"
            )
        );
        assertEq(registry.QUALIFIED_INVESTOR(), QI);
        assertEq(registry.KYC_BASIC(), BASIC);
    }

    // ── owner 權限 ─────────────────────────────────────────────────────────────

    function test_ownerOnlySetters() public {
        vm.startPrank(mallory);
        vm.expectRevert();
        registry.setIssuer(mallory, QI, true);
        vm.expectRevert();
        registry.setRequiredType(BASIC);
        vm.expectRevert();
        registry.setCredentialType(keccak256("X"), true);
        vm.expectRevert();
        registry.revokeAllBeforeAsOwner(issuer, T0);
        vm.stopPrank();
    }

    function test_ownable2Step() public {
        registry.transferOwnership(mallory);
        assertEq(registry.owner(), address(this));
        vm.prank(mallory);
        registry.acceptOwnership();
        assertEq(registry.owner(), mallory);
    }

    function test_setIssuer_zeroAddress_rejected() public {
        vm.expectRevert(VCKycRegistry.ZeroAddress.selector);
        registry.setIssuer(address(0), QI, true);
    }

    function test_setIssuer_idempotentCount() public {
        registry.setIssuer(issuer, QI, true); // 已是 true，不重複加
        assertEq(registry.issuerTypeCount(issuer), 2);
        registry.setIssuer(issuer, QI, false);
        registry.setIssuer(issuer, QI, false);
        assertEq(registry.issuerTypeCount(issuer), 1);
    }
}

/// @notice 與 PerpetualExchange 的整合：exchange 一行都不改，只用既有的 setKycRegistry／setRwaAsset。
contract VCKycRegistryExchangeTest is VCKycFixture {
    PerpetualExchange exchange;
    MockUSDC usdc;
    MockOracle oracle;

    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant SBTC = keccak256("sBTC");

    function setUp() public {
        _setUpRegistry();
        usdc = new MockUSDC();
        oracle = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.addAsset(SAAPL, 200e8);
        oracle.addAsset(SBTC, 50_000e8);

        exchange.setKycRegistry(address(registry));
        exchange.setRwaAsset(SAAPL, true);
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        usdc.mint(investor, 100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.startPrank(investor);
        usdc.approve(address(exchange), type(uint256).max);
        exchange.depositMargin(1_000e18);
        vm.stopPrank();
    }

    function test_withoutQI_openRwaRejected_cryptoUnaffected() public {
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);
        // 非 RWA 資產不受影響
        vm.prank(investor);
        uint256 pid = exchange.openPosition(SBTC, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).owner, investor);
    }

    function test_basicOnly_openRwaRejected() public {
        _submit(otherIssuerPk, _att(investor, BASIC, keccak256("urn:uuid:basic-1")));
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);
    }

    function test_fullLifecycle_submitOpenRevokeClose() public {
        // 1. 未持證 → 拒
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);

        // 2. relayer 代送 QI attestation → 可開
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        _submit(issuerPk, a);
        vm.prank(investor);
        uint256 pid = exchange.openPosition(SAAPL, true, 100e18, 2);
        assertEq(exchange.getPosition(pid).owner, investor);
        assertTrue(exchange.getPosition(pid).isOpen);

        // 3. 發證者撤銷 → 新開倉被拒
        vm.prank(issuer);
        registry.revoke(a.credentialHash);
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);

        // 4. 既有倉位仍可平倉（閘門只在開倉）
        vm.prank(investor);
        exchange.closePosition(pid);
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    function test_expiry_blocksNewOpen_closeStillWorks() public {
        VCKycRegistry.Attestation memory a = _att(investor, QI, keccak256("urn:uuid:qi-1"));
        a.expiresAt = uint64(block.timestamp + 1 hours);
        _submit(issuerPk, a);
        vm.prank(investor);
        uint256 pid = exchange.openPosition(SAAPL, true, 100e18, 2);
        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(SAAPL, 200e8); // 讓價格新鮮
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);
        vm.prank(investor);
        exchange.closePosition(pid);
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    function test_issuerRemoved_blocksNewOpen() public {
        _submit(issuerPk, _att(investor, QI, keccak256("urn:uuid:qi-1")));
        registry.setIssuer(issuer, QI, false);
        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        exchange.openPosition(SAAPL, true, 100e18, 2);
    }

    /// @dev 審查 #4：agent 經 AgentSessionManager 代開倉（openPositionFor），閘門檢查的是 session 的使用者。
    function test_agentSession_openPositionFor_gatedOnSessionUser() public {
        AgentSessionManager manager = new AgentSessionManager(address(exchange));
        exchange.setCopyTracker(makeAddr("tracker")); // openPositionFor 需要已設定 copyTracker
        exchange.setAgentAuthorized(address(manager), true);
        address agent = makeAddr("agent");
        vm.prank(investor);
        uint256 sid = manager.createSession(agent, 500e18, 1_000e18, 5, block.timestamp + 1 days);

        // 使用者未持證 → agent 代開 RWA 被拒（錯誤指名的是使用者，不是 agent 或 manager）
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        manager.openPositionForSession(sid, SAAPL, true, 100e18, 2, address(0));

        // agent 本身有 QI 也沒用：閘門看 session 使用者
        _submit(issuerPk, _att(agent, QI, keccak256("urn:uuid:agent-qi")));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, investor));
        manager.openPositionForSession(sid, SAAPL, true, 100e18, 2, address(0));

        // 使用者持證後 → 通過，部位屬於使用者
        _submit(issuerPk, _att(investor, QI, keccak256("urn:uuid:qi-1")));
        vm.prank(agent);
        uint256 pid = manager.openPositionForSession(sid, SAAPL, true, 100e18, 2, address(0));
        assertEq(exchange.getPosition(pid).owner, investor);
    }
}
