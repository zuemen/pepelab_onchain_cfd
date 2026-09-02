// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ESGRegistryV2
/// @notice Multi-attestor ESG and carbon-intensity registry, replacing
///         `ESGRegistry`. The old contract's `setESG` is `Ownable` — one
///         owner key typing a 0-100 score in — which is a single opinion
///         wearing the shape of a fact. This contract stores every
///         attestor's submission separately and reports the **median**,
///         the **count**, and the **dispersion** (max - min) across
///         whichever attestations are still fresh, so a screen can show
///         "three sources say 82, 61, 79" instead of asserting one number
///         nobody can trace or challenge. See docs/data/carbon-intensity.md
///         and ADR-003.
///
///         Architecture is deliberately parallel to `GuardedOracle`: a
///         role-gated set of writers (ATTESTOR_ROLE instead of KEEPER_ROLE),
///         an admin-settable freshness window (`maxAttestationAge` instead
///         of `maxPriceAge`, same "0 disables the check" convention), and a
///         read path that fails closed rather than reverting — a caller
///         gets `isRated = false` for "nothing usable right now", not a
///         revert it has to wrap in try/catch to keep a dashboard rendering.
///
/// @dev    UNITS: `carbonIntensity` is stored and returned exactly as an
///         attestor submits it — this contract does not know or enforce
///         what unit or basis it is denominated in. That is intentional:
///         docs/data/carbon-intensity.md documents that revenue-basis
///         intensity (used for equities and ETFs) is not comparable to
///         absolute annualized emissions (used for commodities and crypto)
///         on any shared scale, and forcing one would produce misleading
///         results (a market-cap-normalized Bitcoin figure computes lower
///         than Apple's, which is the documented case study for why this
///         contract does not attempt cross-asset-class normalization).
///         `CarbonTiers.tierOf` is built for revenue-basis figures only —
///         see its own NatSpec before wiring a commodity or crypto asset's
///         median through it.
///
///         WHAT THIS DOES NOT SOLVE: an attestation is only as honest as
///         the attestor submitting it. If every ATTESTOR_ROLE holder is
///         controlled by the same operator, "three sources disagree" is
///         theatre, not independence — that is an operational fact about
///         who is actually granted the role, and no code here can fix it.
///         Say so wherever this registry's dispersion is displayed as
///         evidence of independent attestation.
contract ESGRegistryV2 is AccessControl {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    // ── Data types ───────────────────────────────────────────────────────────

    struct Attestation {
        address attestor;
        /// @dev Fixed-point, 1e18-scaled. Unit is whatever the attestor's
        ///      basis is for this asset class — see contract NatSpec.
        uint256 carbonIntensity;
        uint8 environmental; // 0-100
        uint8 social; // 0-100
        uint8 governance; // 0-100
        /// @dev keccak256 of the source URL and the retrieval date, computed
        ///      off-chain by the attestor before submitting. The contract
        ///      cannot verify this points anywhere real; it can only refuse
        ///      to accept an attestation that omits one entirely.
        bytes32 sourceHash;
        uint256 observedAt;
        bool exists;
    }

    // ── State ────────────────────────────────────────────────────────────────

    // assetId => attestor => that attestor's current attestation for the
    // asset. A second call from the same attestor overwrites in place —
    // this registry reports one live opinion per attestor, not a full
    // history of every submission.
    mapping(bytes32 => mapping(address => Attestation)) private _attestations;

    // assetId => every address that has ever attested this asset. Appended
    // to exactly once per (assetId, attestor) pair, on that attestor's
    // first-ever attestation for that asset — re-attesting does not
    // duplicate the entry.
    mapping(bytes32 => address[]) private _attestorsOf;

    bytes32[] private _attestedAssets;
    mapping(bytes32 => bool) private _assetSeen;

    /// @notice An attestation older than this is excluded from every median,
    ///         count, and dispersion computed below. 0 disables the check —
    ///         same convention as `GuardedOracle.maxPriceAge`.
    uint256 public maxAttestationAge = 180 days;

    // ── Events ───────────────────────────────────────────────────────────────

    event Attested(
        bytes32 indexed assetId,
        address indexed attestor,
        uint256 carbonIntensity,
        uint8 environmental,
        uint8 social,
        uint8 governance,
        bytes32 sourceHash,
        uint256 observedAt
    );
    event MaxAttestationAgeSet(uint256 oldValue, uint256 newValue);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ScoreOutOfRange();
    error MissingSourceHash();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address admin) {
        // ATTESTOR_ROLE is deliberately NOT auto-granted to admin here.
        // Unlike GuardedOracle's GUARDIAN_ROLE (a safety backstop that
        // should exist from block one), an attestor is a substantive trust
        // role — see the contract NatSpec's note on attestor independence —
        // and granting it silently at construction would blur who is
        // actually vouching for a number. The admin must grant it
        // explicitly, to a named address, on purpose.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ── Write ────────────────────────────────────────────────────────────────

    function attest(
        bytes32 assetId,
        uint256 carbonIntensity,
        uint8 environmental,
        uint8 social,
        uint8 governance,
        bytes32 sourceHash
    ) external onlyRole(ATTESTOR_ROLE) {
        if (environmental > 100 || social > 100 || governance > 100) revert ScoreOutOfRange();
        if (sourceHash == bytes32(0)) revert MissingSourceHash();

        bool firstTimeForThisAttestor = !_attestations[assetId][msg.sender].exists;

        _attestations[assetId][msg.sender] = Attestation({
            attestor: msg.sender,
            carbonIntensity: carbonIntensity,
            environmental: environmental,
            social: social,
            governance: governance,
            sourceHash: sourceHash,
            observedAt: block.timestamp,
            exists: true
        });

        if (firstTimeForThisAttestor) _attestorsOf[assetId].push(msg.sender);
        if (!_assetSeen[assetId]) {
            _assetSeen[assetId] = true;
            _attestedAssets.push(assetId);
        }

        emit Attested(assetId, msg.sender, carbonIntensity, environmental, social, governance, sourceHash, block.timestamp);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setMaxAttestationAge(uint256 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MaxAttestationAgeSet(maxAttestationAge, newValue);
        maxAttestationAge = newValue;
    }

    // ── Read: raw, per-attestor ──────────────────────────────────────────────

    function hasAttested(bytes32 assetId, address attestor) external view returns (bool) {
        return _attestations[assetId][attestor].exists;
    }

    function getAttestation(bytes32 assetId, address attestor) external view returns (Attestation memory) {
        return _attestations[assetId][attestor];
    }

    function getAttestors(bytes32 assetId) external view returns (address[] memory) {
        return _attestorsOf[assetId];
    }

    function getAllAttestedAssets() external view returns (bytes32[] memory) {
        return _attestedAssets;
    }

    /// @notice True when this specific attestor's attestation for this asset
    ///         has not expired. Lets a screen show which of several
    ///         attestations are stale individually, rather than only the
    ///         asset's aggregate `isRated`.
    function isAttestationFresh(bytes32 assetId, address attestor) public view returns (bool) {
        Attestation storage a = _attestations[assetId][attestor];
        if (!a.exists) return false;
        if (maxAttestationAge == 0) return true;
        return block.timestamp <= a.observedAt + maxAttestationAge;
    }

    // ── Read: aggregated ─────────────────────────────────────────────────────

    /// @notice Median carbon intensity across every currently-fresh
    ///         attestation for `assetId`, with how many attestations that
    ///         median was computed from and how far apart they are.
    /// @dev `isRated` is exactly `count > 0` and is returned as its own
    ///      value specifically so a caller can pass it straight into
    ///      `CarbonTiers.tierOf(median, isRated)` without recomputing it —
    ///      the two functions are meant to compose in one line.
    ///      Never reverts on "no data": a caller reading many assets in one
    ///      pass (a dashboard, a batch pricing sweep) fails closed on its
    ///      own terms via `isRated` rather than being forced into
    ///      try/catch around every read.
    function medianCarbonIntensity(bytes32 assetId)
        external
        view
        returns (uint256 median, uint256 count, uint256 dispersion, bool isRated)
    {
        uint256[] memory fresh = _freshCarbonIntensities(assetId);
        count = fresh.length;
        isRated = count > 0;
        if (!isRated) return (0, 0, 0, false);
        (median, dispersion) = _medianAndRange(fresh);
    }

    /// @notice Median E/S/G across every currently-fresh attestation.
    ///         Symmetric to `medianCarbonIntensity`; no dispersion is
    ///         reported here — nothing downstream currently consumes
    ///         E/S/G disagreement, and this contract does not build
    ///         unused surface area on the chance it might.
    function medianESG(bytes32 assetId)
        external
        view
        returns (uint8 environmental, uint8 social, uint8 governance, uint256 count, bool isRated)
    {
        address[] storage attestors = _attestorsOf[assetId];
        uint256 len = attestors.length;

        uint256[] memory envs = new uint256[](len);
        uint256[] memory socs = new uint256[](len);
        uint256[] memory govs = new uint256[](len);
        uint256 n = 0;

        for (uint256 i = 0; i < len; i++) {
            address who = attestors[i];
            if (!isAttestationFresh(assetId, who)) continue;
            Attestation storage a = _attestations[assetId][who];
            envs[n] = a.environmental;
            socs[n] = a.social;
            govs[n] = a.governance;
            n++;
        }

        count = n;
        isRated = n > 0;
        if (!isRated) return (0, 0, 0, 0, false);

        environmental = uint8(_medianOfFirstN(envs, n));
        social = uint8(_medianOfFirstN(socs, n));
        governance = uint8(_medianOfFirstN(govs, n));
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _freshCarbonIntensities(bytes32 assetId) internal view returns (uint256[] memory fresh) {
        address[] storage attestors = _attestorsOf[assetId];
        uint256 len = attestors.length;

        uint256[] memory tmp = new uint256[](len);
        uint256 n = 0;
        for (uint256 i = 0; i < len; i++) {
            address who = attestors[i];
            if (!isAttestationFresh(assetId, who)) continue;
            tmp[n] = _attestations[assetId][who].carbonIntensity;
            n++;
        }

        fresh = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            fresh[i] = tmp[i];
        }
    }

    /// @dev Sorts `values` in place (ascending) and returns (median, range).
    ///      Insertion sort: attestor counts are expected to be a handful at
    ///      most, so O(n^2) is fine and the code stays easy to read.
    function _medianAndRange(uint256[] memory values) internal pure returns (uint256 median, uint256 range) {
        _insertionSort(values);
        uint256 n = values.length;
        median = n % 2 == 1 ? values[n / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
        range = values[n - 1] - values[0];
    }

    /// @dev Same sort, used when the caller only wants the median of the
    ///      first `n` slots of a pre-sized array (medianESG's env/soc/gov
    ///      arrays are allocated at `len` but only `n` slots are filled).
    function _medianOfFirstN(uint256[] memory values, uint256 n) internal pure returns (uint256 median) {
        uint256[] memory trimmed = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            trimmed[i] = values[i];
        }
        _insertionSort(trimmed);
        median = n % 2 == 1 ? trimmed[n / 2] : (trimmed[n / 2 - 1] + trimmed[n / 2]) / 2;
    }

    function _insertionSort(uint256[] memory arr) internal pure {
        for (uint256 i = 1; i < arr.length; i++) {
            uint256 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
    }
}
