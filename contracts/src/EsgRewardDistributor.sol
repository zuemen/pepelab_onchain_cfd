// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./CarbonTiers.sol";

interface IExchangeForReward {
    struct Position {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;
        uint256 margin;
        uint256 leverage;
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
        address copiedFrom;
        int256  entryFundingIndex;
    }
    function getPosition(uint256 positionId) external view returns (Position memory);
}

/// @dev Same shape as ESGRegistryV2.medianCarbonIntensity — a narrow
///      interface here (rather than importing ESGRegistryV2 itself) so this
///      contract only depends on the one read it actually needs.
interface IESGRegistryForReward {
    function medianCarbonIntensity(bytes32 assetId)
        external
        view
        returns (uint256 median, uint256 count, uint256 dispersion, bool isRated);
}

/// @dev Narrowed to the one call this contract makes, matching the same
///      "depend on the read/write actually used, not the concrete contract"
///      pattern as IExchangeForReward/IESGRegistryForReward above.
interface IBadgeForReward {
    function mint(address to, string calldata reason) external returns (uint256 tokenId);
}

/// @title EsgRewardDistributor
/// @notice Mints a non-transferable SustainabilityBadge for positions held
///         on a Low-carbon-tier asset for at least `minHoldSeconds`.
/// @dev    #98 (spec #93): the payout used to be PEPE — an economically
///         valuable, freely tradeable token — priced off a single owner-set
///         `compositeScore`. That combination is exactly what decision
///         #05/#10 rules out: a transferable payout has a price, and a
///         price is a reason to farm the claim rather than to actually hold
///         the asset. This version changes two things at once: the payout
///         is now a `SustainabilityBadge` (see that contract's NatSpec for
///         why it can never be sold), and the gate is now the same
///         non-discretionary `CarbonTiers` ladder `PerpetualExchange` and
///         `CopyTracker` already price off (#96, #97), replacing the old
///         owner-set `compositeScore >= 70` opinion. `minHoldSeconds` and
///         the `isOpen` check are unchanged from the M7 audit fix — that
///         logic is the actual anti-speculation mechanism (it is what stops
///         open-close-claim-repeat in a single block) and is orthogonal to
///         what the reward pays out or which asset property gates it.
contract EsgRewardDistributor is Ownable {
    using SafeERC20 for IERC20;

    IExchangeForReward    public immutable exchange;
    IESGRegistryForReward public immutable esgRegistry;
    IBadgeForReward       public immutable badge;

    /// @notice The highest (most carbon-intensive) tier that still
    ///         qualifies for a reward. Defaults to `Low` — the platform's
    ///         cleanest bucket — matching the old threshold's intent of
    ///         "only the best-behaved assets qualify". `Unrated` never
    ///         qualifies regardless of this setting — see
    ///         `CarbonTiers.qualifiesAtOrBelow`.
    CarbonTiers.Tier public maxRewardTier = CarbonTiers.Tier.Low;

    /// @notice Minimum time a position must have been open before its ESG
    ///         reward can be claimed.
    /// @dev M7: this contract had no holding requirement at all — open, close
    ///         in the same block, claim a reward, repeat. Paired
    ///         with the `isOpen` check below, the reward now actually pays for
    ///         sustained exposure to the qualifying asset rather than for a
    ///         round-trip. Unchanged by #98.
    uint256 public minHoldSeconds = 30 days;

    mapping(uint256 => bool) public rewarded; // positionId => claimed

    event EsgRewardClaimed(address indexed trader, uint256 indexed positionId, uint256 indexed badgeTokenId);
    event MinHoldSecondsSet(uint256 oldValue, uint256 newValue);
    event MaxRewardTierSet(CarbonTiers.Tier oldValue, CarbonTiers.Tier newValue);

    error NotPositionOwner();
    error AlreadyClaimed();
    error AssetNotLowCarbon();
    error PositionNotOpen();
    error HoldTooShort();

    constructor(address _exchange, address _esgRegistry, address _badge) Ownable(msg.sender) {
        exchange    = IExchangeForReward(_exchange);
        esgRegistry = IESGRegistryForReward(_esgRegistry);
        badge       = IBadgeForReward(_badge);
    }

    // ── User ────────────────────────────────────────────────────────────────────

    /// @dev M7: `isOpen` and `openedAt` were both ignored. The struct has
    ///      carried them since day one; reading them turns "opened a
    ///      qualifying position once" into "is still holding it, and has
    ///      been for `minHoldSeconds`". Unchanged by #98.
    ///
    ///      The registry is read exactly once here (not once for the
    ///      eligibility check and again for the badge's reason text) — both
    ///      derive from the same `median`/`isRated` pair via CarbonTiers'
    ///      pure functions, so there is only one external call to
    ///      `esgRegistry` per claim.
    function claimEsgReward(uint256 positionId) external returns (uint256 badgeTokenId) {
        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (rewarded[positionId])    revert AlreadyClaimed();
        if (!pos.isOpen)             revert PositionNotOpen();

        uint256 heldFor = block.timestamp - pos.openedAt;
        if (heldFor < minHoldSeconds) revert HoldTooShort();

        (uint256 median, , , bool isRated) = esgRegistry.medianCarbonIntensity(pos.asset);
        if (!CarbonTiers.qualifiesAtOrBelow(median, isRated, maxRewardTier)) revert AssetNotLowCarbon();

        rewarded[positionId] = true;

        // The reason is composed from what was actually observed at claim
        // time (the tier reached, the days actually held) rather than a
        // fixed literal — `maxRewardTier`/`minHoldSeconds` are both
        // owner-tunable, and SustainabilityBadge.reasonFor has no setter,
        // so a hardcoded "Low-carbon-tier, 30+ days" string would go
        // permanently, unfixably stale the moment either parameter changed.
        CarbonTiers.Tier tier = CarbonTiers.tierOf(median, isRated);
        string memory reason = string.concat(
            "Held a ", _tierName(tier), "-carbon-tier position for ", Strings.toString(heldFor / 1 days), "+ days"
        );
        badgeTokenId = badge.mint(msg.sender, reason);

        emit EsgRewardClaimed(msg.sender, positionId, badgeTokenId);
    }

    /// @notice Whether a position is currently claimable — high carbon tier
    ///         (or unrated), already closed, or not yet held long enough
    ///         all read as `false`, so this cannot promise a claim
    ///         `claimEsgReward` would refuse.
    /// @dev The already-claimed check runs first and reads only a mapping —
    ///      a position that has already been rewarded (the common
    ///      steady-state case for a UI polling every open position) never
    ///      pays for the cross-contract `getPosition` call below it.
    function previewReward(uint256 positionId) external view returns (bool claimable) {
        if (rewarded[positionId]) return false;

        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
        if (!pos.isOpen) return false;
        if (block.timestamp - pos.openedAt < minHoldSeconds) return false;
        return _qualifies(pos.asset);
    }

    // ── Internal ─────────────────────────────────────────────────────────────────

    function _qualifies(bytes32 asset) internal view returns (bool) {
        (uint256 median, , , bool isRated) = esgRegistry.medianCarbonIntensity(asset);
        return CarbonTiers.qualifiesAtOrBelow(median, isRated, maxRewardTier);
    }

    function _tierName(CarbonTiers.Tier tier) internal pure returns (string memory) {
        if (tier == CarbonTiers.Tier.Low) return "Low";
        if (tier == CarbonTiers.Tier.Mid) return "Mid";
        if (tier == CarbonTiers.Tier.High) return "High";
        return "Unrated";
    }

    // ── Admin ────────────────────────────────────────────────────────────────────

    function setMaxRewardTier(CarbonTiers.Tier tier) external onlyOwner {
        emit MaxRewardTierSet(maxRewardTier, tier);
        maxRewardTier = tier;
    }

    function setMinHoldSeconds(uint256 secs) external onlyOwner {
        emit MinHoldSecondsSet(minHoldSeconds, secs);
        minHoldSeconds = secs;
    }

    /// @notice Recover ERC20 tokens sent to this contract by mistake.
    /// @dev The old `withdraw` drained a PEPE pool this contract was
    ///      deliberately seeded with. There is no such pool anymore — the
    ///      payout is a badge mint, not a transfer — but the contract can
    ///      still receive tokens by accident (an old integration still
    ///      pointed at this address, a stray transfer). Without any rescue
    ///      path at all, those would be stuck permanently with no owner
    ///      action able to recover them.
    function rescueERC20(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
