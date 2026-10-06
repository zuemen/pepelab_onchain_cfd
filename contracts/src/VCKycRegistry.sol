// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title  VCKycRegistry — 以可驗證憑證（VC）准入的 KYC 登錄
/// @notice 實作 PerpetualExchange 的 `IKyc.isVerified(address)`，經既有的
///         `setKycRegistry(address)` 換上即可，exchange 本身不用改。
///
///         流程（docs/SSI_RWA_ACCESS.md）：
///           1. 受信任的發證者（持牌機構的 KYC／法遵單位）在鏈下完成審查，簽發 W3C VC，
///              VC 的 proof 就是一份 EIP-712「資格證明」（Attestation）的簽章。
///           2. 投資人（或任何代送者）把 Attestation 與簽章送進 `submitAttestation`；
///              合約在鏈上驗簽，記錄 `subject → (type, issuer, issuedAt, expiresAt, credentialHash)`。
///           3. exchange 開 RWA 倉時呼叫 `isVerified(owner)`：未過期、未撤銷、發證者仍受信任、
///              類型符合 `requiredType` 才回 true。
///
///         隱私：鏈上**沒有任何個資**。只存地址、類型（bytes32 常數）、時間戳與憑證 id 的雜湊；
///         姓名、證件號碼、財力證明都留在發證者的 KYC 系統。
///
///         撤銷：發證者以 credentialHash 撤銷（`revoke`），或撤銷某時間點之前簽發的全部憑證
///         （`revokeAllBefore`，對應 ADR-016 狀態清單的 `revokedBefore`；不適用於金鑰外洩）。
///         金鑰外洩：owner `setIssuer(false)` 並換新金鑰；信任 epoch 讓加回同一地址也不會使舊憑證復活。
///         撤銷只影響**開新倉**——
///         exchange 的閘門只在開倉檢查，平倉、清算、提領都不看 KYC，所以撤銷不會把人鎖在部位裡。
///
///         防重放：EIP-712 domain 綁 chainId 與本合約位址；每個 subject 有單調 nonce
///         （必須等於 `nonces[subject]`，用過即遞增）；Attestation 帶送出期限 `deadline`；
///         同一個 credentialHash 只能登記一次。
contract VCKycRegistry is Ownable2Step, EIP712 {
    // ── 憑證類型 ───────────────────────────────────────────────────────────────

    /// @notice 基本 KYC（身分已核實）。
    bytes32 public constant KYC_BASIC = keccak256("KYC_BASIC");
    /// @notice 合格投資人（專業投資人）。隱含 KYC_BASIC：要求 KYC_BASIC 時，有效的 QI 憑證也算數。
    bytes32 public constant QUALIFIED_INVESTOR = keccak256("QUALIFIED_INVESTOR");

    /// @notice issuedAt 可容忍的時鐘誤差（秒），與 agent 端 VC 的 MAX_CLOCK_SKEW_SEC 相同。
    uint64 public constant MAX_CLOCK_SKEW = 300;

    /// @dev EIP-712 type string。欄位順序與 frontend/src/contracts/investorCredential.ts 的
    ///      ATTESTATION_TYPES 一致（兩邊有測試互相比對）。
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "QualifiedInvestorAttestation(address subject,bytes32 credentialType,bytes32 credentialHash,uint256 statusListIndex,uint64 issuedAt,uint64 expiresAt,uint256 nonce,uint256 deadline)"
    );

    struct Attestation {
        address subject;          // 投資人錢包
        bytes32 credentialType;   // KYC_BASIC / QUALIFIED_INVESTOR / owner 另外登記的類型
        bytes32 credentialHash;   // keccak256(VC 的 id，即 jti)；撤銷以它為鍵
        uint256 statusListIndex;  // 鏈下狀態清單裡的索引（稽核對照用；撤銷仍以 credentialHash 為準）
        uint64  issuedAt;         // VC validFrom
        uint64  expiresAt;        // VC validUntil
        uint256 nonce;            // 必須等於 nonces[subject]
        uint256 deadline;         // 這份簽章最晚可送出的時間
    }

    struct Record {
        address issuer;
        uint64  issuedAt;
        uint64  expiresAt;
        bytes32 credentialHash;
        /// @dev 登記當下 trustEpoch[issuer][type]。發證者被移除後再加回會換 epoch，舊紀錄不會復活。
        uint64  epoch;
    }

    // ── 狀態 ───────────────────────────────────────────────────────────────────

    /// @notice issuer → 類型 → 是否受信任簽發該類型。
    mapping(address => mapping(bytes32 => bool)) public trustedIssuer;
    /// @notice issuer 目前受信任的類型數（>0 才能撤銷自己的憑證）。
    mapping(address => uint256) public issuerTypeCount;
    /// @notice issuer → 類型 → 信任 epoch。每次由「不受信任」變成「受信任」就 +1（第一次加入是 1）。
    ///         紀錄只在 epoch 相同時有效：移除後再加回同一地址，**之前登記的憑證全部不會復活**，
    ///         投資人必須重新提交（發證者重新簽發）。
    mapping(address => mapping(bytes32 => uint64)) public trustEpoch;
    /// @notice 本登錄接受的憑證類型（KYC_BASIC、QUALIFIED_INVESTOR 於建構時登記）。
    mapping(bytes32 => bool) public credentialTypeSupported;
    /// @notice `isVerified` 要求的類型。
    bytes32 public requiredType;

    /// @notice subject → 類型 → 最新登記的憑證。
    mapping(address => mapping(bytes32 => Record)) internal _records;
    /// @notice subject 的下一個可用 nonce。
    mapping(address => uint256) public nonces;
    /// @notice credentialHash 是否已登記過（只能登記一次）。
    mapping(bytes32 => bool) public credentialUsed;
    /// @notice issuer → credentialHash → 是否已撤銷。以 issuer 分命名空間：發證者只能撤銷自己的憑證。
    mapping(address => mapping(bytes32 => bool)) public revoked;
    /// @notice issuer 的「全部撤銷」水位：issuedAt 早於它的憑證一律無效（只能往後推）。
    mapping(address => uint64) public revokedBefore;

    // ── 事件（全部可稽核）───────────────────────────────────────────────────────

    event IssuerSet(address indexed issuer, bytes32 indexed credentialType, bool trusted, uint64 epoch);
    event CredentialTypeSet(bytes32 indexed credentialType, bool supported);
    event RequiredTypeSet(bytes32 indexed credentialType);
    event AttestationSubmitted(
        address indexed subject,
        bytes32 indexed credentialType,
        address indexed issuer,
        bytes32 credentialHash,
        uint256 statusListIndex,
        uint64 issuedAt,
        uint64 expiresAt,
        address submitter
    );
    event CredentialRevoked(address indexed issuer, bytes32 indexed credentialHash, address revokedBy);
    event RevokedBefore(address indexed issuer, uint64 timestamp, address revokedBy);

    // ── 錯誤 ───────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error UnsupportedCredentialType(bytes32 credentialType);
    error UntrustedIssuer(address issuer, bytes32 credentialType);
    error InvalidSignature();
    error AttestationDeadlinePassed(uint256 deadline);
    error CredentialExpired(uint64 expiresAt);
    error IssuedInFuture(uint64 issuedAt);
    error InvalidValidity();
    error BadNonce(uint256 expected, uint256 got);
    error CredentialAlreadyUsed(bytes32 credentialHash);
    error CredentialIsRevoked(bytes32 credentialHash);
    error NotAuthorizedToRevoke(address caller);
    error RevokedBeforeCannotMoveBack(uint64 current, uint64 requested);
    error RevokedBeforeInFuture(uint64 requested);
    error WouldReplaceLongerCredential(uint64 currentExpiresAt, uint64 newExpiresAt);

    /// @param initialOwner   登錄的 owner（建議是 timelock／多簽）。
    /// @param _requiredType  `isVerified` 要求的類型；RWA 市場建議 QUALIFIED_INVESTOR。
    constructor(address initialOwner, bytes32 _requiredType)
        Ownable(initialOwner)
        EIP712("PepeLabVCKycRegistry", "1")
    {
        credentialTypeSupported[KYC_BASIC] = true;
        credentialTypeSupported[QUALIFIED_INVESTOR] = true;
        emit CredentialTypeSet(KYC_BASIC, true);
        emit CredentialTypeSet(QUALIFIED_INVESTOR, true);
        if (!credentialTypeSupported[_requiredType]) revert UnsupportedCredentialType(_requiredType);
        requiredType = _requiredType;
        emit RequiredTypeSet(_requiredType);
    }

    // ── owner 設定 ─────────────────────────────────────────────────────────────

    /// @notice 加入或移除某發證者對某類型的信任。移除後，該發證者簽過的該類型憑證在
    ///         `isVerified` 立即失效（不用逐筆撤銷）；之後再加回同一地址會開新的 epoch，
    ///         舊憑證**不會**復活。**發證者金鑰外洩的處置**：對它的每個類型 setIssuer(false)，
    ///         並以新金鑰（新地址）加入；`revokeAllBefore` 擋不住外洩金鑰新簽的憑證（見該函式）。
    function setIssuer(address issuer, bytes32 credentialType, bool trusted) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        if (trusted && !credentialTypeSupported[credentialType]) revert UnsupportedCredentialType(credentialType);
        if (trustedIssuer[issuer][credentialType] != trusted) {
            trustedIssuer[issuer][credentialType] = trusted;
            if (trusted) {
                issuerTypeCount[issuer] += 1;
                trustEpoch[issuer][credentialType] += 1;
            } else {
                issuerTypeCount[issuer] -= 1;
            }
        }
        emit IssuerSet(issuer, credentialType, trusted, trustEpoch[issuer][credentialType]);
    }

    /// @notice 登記或停用一種憑證類型。不能停用目前的 requiredType。
    function setCredentialType(bytes32 credentialType, bool supported) external onlyOwner {
        if (credentialType == bytes32(0)) revert UnsupportedCredentialType(credentialType);
        if (!supported && credentialType == requiredType) revert UnsupportedCredentialType(credentialType);
        credentialTypeSupported[credentialType] = supported;
        emit CredentialTypeSet(credentialType, supported);
    }

    /// @notice 設定 `isVerified` 要求的類型（例如 RWA 市場要求 QUALIFIED_INVESTOR）。
    function setRequiredType(bytes32 credentialType) external onlyOwner {
        if (!credentialTypeSupported[credentialType]) revert UnsupportedCredentialType(credentialType);
        requiredType = credentialType;
        emit RequiredTypeSet(credentialType);
    }

    // ── 登記 ───────────────────────────────────────────────────────────────────

    /// @notice 提交發證者簽署的資格證明。任何人都可以代送（relayer）；記錄落在 `a.subject`。
    /// @return issuer 還原出的發證者地址
    function submitAttestation(Attestation calldata a, bytes calldata signature) external returns (address issuer) {
        if (a.subject == address(0)) revert ZeroAddress();
        if (!credentialTypeSupported[a.credentialType]) revert UnsupportedCredentialType(a.credentialType);
        if (block.timestamp > a.deadline) revert AttestationDeadlinePassed(a.deadline);
        if (a.expiresAt <= a.issuedAt) revert InvalidValidity();
        if (a.expiresAt <= block.timestamp) revert CredentialExpired(a.expiresAt);
        if (a.issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert IssuedInFuture(a.issuedAt);
        uint256 expected = nonces[a.subject];
        if (a.nonce != expected) revert BadNonce(expected, a.nonce);
        if (credentialUsed[a.credentialHash]) revert CredentialAlreadyUsed(a.credentialHash);

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(attestationDigest(a), signature);
        if (err != ECDSA.RecoverError.NoError || recovered == address(0)) revert InvalidSignature();
        issuer = recovered;
        // 錯誤簽者與「不受信任的發證者」在鏈上無法區分（還原一定得到某個地址），一律以 UntrustedIssuer 拒絕。
        if (!trustedIssuer[issuer][a.credentialType]) revert UntrustedIssuer(issuer, a.credentialType);
        if (revoked[issuer][a.credentialHash] || a.issuedAt < revokedBefore[issuer]) {
            revert CredentialIsRevoked(a.credentialHash);
        }

        // 覆蓋規則：同一 subject 同一類型只保留一筆。目前那筆仍有效時，只有新憑證「到期較晚」，
        // 或「到期相同且簽發較新」才取代它——較短的、或別的發證者的較短憑證不能把有效資格蓋掉。
        // 目前那筆已失效（到期、撤銷、發證者被移除、類型停用）時一律可以取代。
        if (_valid(a.subject, a.credentialType)) {
            Record storage cur = _records[a.subject][a.credentialType];
            bool longer = a.expiresAt > cur.expiresAt;
            bool sameButNewer = a.expiresAt == cur.expiresAt && a.issuedAt > cur.issuedAt;
            if (!longer && !sameButNewer) revert WouldReplaceLongerCredential(cur.expiresAt, a.expiresAt);
        }

        nonces[a.subject] = expected + 1;
        credentialUsed[a.credentialHash] = true;
        _records[a.subject][a.credentialType] = Record({
            issuer: issuer,
            issuedAt: a.issuedAt,
            expiresAt: a.expiresAt,
            credentialHash: a.credentialHash,
            epoch: trustEpoch[issuer][a.credentialType]
        });
        emit AttestationSubmitted(
            a.subject, a.credentialType, issuer, a.credentialHash, a.statusListIndex, a.issuedAt, a.expiresAt, msg.sender
        );
    }

    // ── 撤銷 ───────────────────────────────────────────────────────────────────

    /// @notice 發證者撤銷自己簽發的憑證（以 credentialHash）。可在投資人提交之前就撤銷（預先撤銷），
    ///         之後該憑證無法再登記。鏈下狀態清單（ADR-016 格式）撤銷時，發證服務同步送這筆交易。
    function revoke(bytes32 credentialHash) external {
        if (!_isAnyIssuer(msg.sender)) revert NotAuthorizedToRevoke(msg.sender);
        revoked[msg.sender][credentialHash] = true;
        emit CredentialRevoked(msg.sender, credentialHash, msg.sender);
    }

    /// @notice owner（法遵緊急處置）代任一發證者撤銷某憑證。
    function revokeAsOwner(address issuer, bytes32 credentialHash) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        revoked[issuer][credentialHash] = true;
        emit CredentialRevoked(issuer, credentialHash, msg.sender);
    }

    /// @notice 發證者撤銷自己在 `timestamp` 之前簽發的全部憑證（對應狀態清單的 revokedBefore）。只能往後推，
    ///         上限 now + MAX_CLOCK_SKEW + 1。
    ///         用途：**金鑰沒有外洩**、但要讓一批已簽出的憑證失效時——例如審查規則改版、所有人須重新審查。
    ///         限制：`issuedAt` 由簽章者自己填，持有金鑰的人可以簽出 issuedAt 晚於水位的新憑證，所以
    ///         這個水位**擋不住外洩的金鑰**。金鑰外洩一律用 setIssuer(false) 移除，並以新金鑰（新地址）加入。
    function revokeAllBefore(uint64 timestamp) external {
        if (!_isAnyIssuer(msg.sender)) revert NotAuthorizedToRevoke(msg.sender);
        _setRevokedBefore(msg.sender, timestamp);
    }

    /// @notice owner 代某發證者設定「全部撤銷」水位（例如發證者停業、規則改版而發證者無法自行操作）。
    ///         金鑰外洩不要用這個，用 setIssuer(false)（理由見 revokeAllBefore）。
    function revokeAllBeforeAsOwner(address issuer, uint64 timestamp) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        _setRevokedBefore(issuer, timestamp);
    }

    function _setRevokedBefore(address issuer, uint64 timestamp) internal {
        uint64 cur = revokedBefore[issuer];
        if (timestamp < cur) revert RevokedBeforeCannotMoveBack(cur, timestamp);
        if (timestamp > block.timestamp + MAX_CLOCK_SKEW + 1) revert RevokedBeforeInFuture(timestamp);
        revokedBefore[issuer] = timestamp;
        emit RevokedBefore(issuer, timestamp, msg.sender);
    }

    /// @dev 發證者只要對**任一**類型受信任，就可以撤銷自己命名空間下的憑證。
    ///      被移除全部信任的發證者不能再撤銷——但它的憑證在 isVerified 已經失效，不需要撤銷。
    function _isAnyIssuer(address who) internal view returns (bool) {
        return issuerTypeCount[who] > 0;
    }

    // ── 查詢 ───────────────────────────────────────────────────────────────────

    /// @notice IKyc：exchange 開 RWA 倉時呼叫。
    function isVerified(address user) external view returns (bool) {
        return hasValidCredential(user, requiredType);
    }

    /// @notice user 是否持有某類型的有效憑證。要求 KYC_BASIC 時，有效的 QUALIFIED_INVESTOR 也算數。
    function hasValidCredential(address user, bytes32 credentialType) public view returns (bool) {
        if (_valid(user, credentialType)) return true;
        return credentialType == KYC_BASIC && _valid(user, QUALIFIED_INVESTOR);
    }

    /// @notice 讀出某 subject 某類型的紀錄與目前是否有效（前端顯示資格與到期用）。
    function credentialOf(address user, bytes32 credentialType)
        external
        view
        returns (Record memory record, bool valid)
    {
        record = _records[user][credentialType];
        valid = _valid(user, credentialType);
    }

    function _valid(address user, bytes32 credentialType) internal view returns (bool) {
        if (!credentialTypeSupported[credentialType]) return false;
        Record storage r = _records[user][credentialType];
        address issuer = r.issuer;
        if (issuer == address(0)) return false;
        if (block.timestamp >= r.expiresAt) return false;
        if (!trustedIssuer[issuer][credentialType]) return false;
        if (r.epoch != trustEpoch[issuer][credentialType]) return false;
        if (revoked[issuer][r.credentialHash]) return false;
        if (r.issuedAt < revokedBefore[issuer]) return false;
        return true;
    }

    /// @notice Attestation 的 EIP-712 digest（鏈下簽章與鏈上驗簽用同一個）。
    function attestationDigest(Attestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.subject,
                    a.credentialType,
                    a.credentialHash,
                    a.statusListIndex,
                    a.issuedAt,
                    a.expiresAt,
                    a.nonce,
                    a.deadline
                )
            )
        );
    }

    /// @notice EIP-712 domain separator（鏈下工具核對用）。
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
