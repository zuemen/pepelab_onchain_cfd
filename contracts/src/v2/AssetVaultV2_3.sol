// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./SyntheticAssetV2.sol";
import "./IAssetVaultV2.sol";
// IAssetOracleV2 is declared in AssetVaultV2.sol — import rather than redeclare,
// so both can be compiled into the same test or script.
import { IAssetOracleV2 } from "./AssetVaultV2.sol";


/// @notice Upgradeable mint/redeem vault for tokenized synthetic assets.
///
///         Honest description of the risk model: the vault is the counterparty
///         to every long. It is NOT fully collateralized and this contract does
///         not make it so — that is a property of the mint-burn design. What it
///         does is make the exposure bounded, priced, and observable:
///           - fees accrue a buffer and pay the operator for carrying risk
///           - a per-asset cap bounds exposure to any single market
///           - a minimum reserve ratio stops new mints BEFORE the reserve is
///             gone, instead of discovering it when a redeemer is denied
///           - pause gives the operator a kill switch
///
///         Risk parameters are operator-configurable because the operator is a
///         licensed institution whose risk committee — not this code — decides
///         acceptable exposure. See docs/RISK_MODEL.md.
///
///         V2.3 adds OBSERVABILITY, not a new source of truth. Everything it
///         reports was already public and already recomputable by anyone; what
///         was missing was that
///           - the ratio had no event, so it could not be replayed as a series
///             even though every other state change in this system can be;
///           - a breach did nothing. The liability is marked to market, so a
///             price move alone can put the book under the line WITH NOBODY
///             TRANSACTING. mint() reverts once someone tries to mint, but the
///             holders already inside got no event and no protection; and
///           - ratioIsStale() had no reader, so an optimistic number and a
///             trustworthy one looked identical downstream.
///
///         Deliberately NOT added: any off-chain attestor. Both sides of the
///         ratio are on-chain and independently verifiable; inserting someone
///         who has to be trusted into a system that does not require trust
///         would be a downgrade.
contract AssetVaultV2_3 is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    IAssetVaultV2
{
    /// @dev SafeERC20 because real-world stablecoins are not uniformly
    ///      ERC-20 compliant. Mainnet USDT's transfer returns NOTHING, so a
    ///      `require(token.transfer(...))` against an interface declaring a
    ///      bool return reverts on ABI decode — the transfer never happens.
    ///      safeTransfer tolerates both the void and bool conventions.
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ROLE   = keccak256("RISK_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Hard ceiling on registered assets.
    /// @dev The reserve-ratio check prices every asset with a non-zero balance,
    ///      so mint() costs one oracle call per active asset. Unbounded
    ///      registration would let that grow until mint exceeds the block gas
    ///      limit — the operator would brick their own vault by onboarding
    ///      markets. Bounded here, and unregisterAsset frees slots.
    uint256 public constant MAX_REGISTERED_ASSETS = 32;

    // ── storage — APPEND ONLY, never reorder (UUPS) ──────────────────────────
    address private _usdc;
    address private _oracle;

    mapping(bytes32 => address) private _assetToken;

    /// @notice USDC set aside as collected fees; excluded from the payout reserve.
    uint256 public accruedFees;

    /// @notice Token units outstanding per asset, used for the exposure cap.
    mapping(bytes32 => uint256) private _outstanding;

    /// @notice Max token units mintable per asset. 0 = asset closed to new mints.
    mapping(bytes32 => uint256) public assetCap;

    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    uint256 public minReserveRatioBps;
    uint256 public maxPriceAge;

    /// @notice Asset ids ever registered, so ratio math can iterate them.
    bytes32[] private _assetIds;

    /// @notice True once an observation found the reserve ratio below
    ///         `minReserveRatioBps`. Blocks NEW MINTS ONLY — redemption is
    ///         never gated on it.
    /// @dev V2.3, consumed from the front of __gap (45 → 44 slots) per the note
    ///      below, so the layout above is untouched.
    bool public mintingHalted;

    /// @dev Reserved slots so a future version can add state without colliding
    ///      with anything a new parent contract introduces. OZ 5.x parents use
    ///      ERC-7201 namespaced storage and won't collide on their own, but this
    ///      contract's own layout is plain — consume from the front when adding
    ///      variables and shrink the gap by the same amount.
    uint256[44] private __gap;

    // ── V2.3 events ──────────────────────────────────────────────────────────
    // Declared here rather than in IAssetVaultV2 so V2.0–V2.2's ABIs do not
    // advertise events they can never emit.

    /// @notice A timestamped snapshot of the reserve position.
    /// @dev `ratioBps` is `type(uint256).max` when there is no liability, which
    ///      is what `reserveRatioBps()` returns — the event mirrors the view
    ///      rather than inventing a second convention. `unpriced > 0` means the
    ///      liability is UNDER-counted and the ratio is therefore optimistic;
    ///      a replay must treat those points as unknown, not as healthy.
    event ReserveObserved(
        uint256 reserve,
        uint256 liability,
        uint256 ratioBps,
        uint256 unpriced,
        uint256 timestamp
    );

    /// @notice Emitted on the crossing below `minReserveRatioBps`, not on every
    ///         observation while below it.
    event ReserveBreached(uint256 ratioBps, uint256 minRatioBps, uint256 unpriced);

    /// @notice Emitted when a fully-priced observation finds the ratio back at
    ///         or above the minimum and re-opens minting.
    event ReserveRestored(uint256 ratioBps, uint256 minRatioBps);

    /// @notice Emitted by `clearMintingHalt()` — an operator override, distinct
    ///         from `ReserveRestored`'s automatic, fully-priced recovery.
    event MintingHaltCleared(address indexed operator, uint256 ratioBps, uint256 unpriced);

    // ── errors ───────────────────────────────────────────────────────────────
    error StalePrice(bytes32 assetId, uint256 updatedAt);
    error NoPrice(bytes32 assetId);
    error AssetNotRegistered(bytes32 assetId);
    error ZeroAmount();
    error CapExceeded(bytes32 assetId, uint256 outstanding, uint256 cap);
    error ReserveRatioTooLow(uint256 ratioBps, uint256 minBps);
    error VaultDry(uint256 needed, uint256 available);
    error InvalidParam();
    error TooManyAssets(uint256 max);
    error AssetStillOutstanding(bytes32 assetId, uint256 outstanding);
    /// @dev Distinct from ReserveRatioTooLow: that one is "this mint would put
    ///      you under", this one is "the book is already under and an
    ///      observation latched it". Anyone can clear it by observing a healthy,
    ///      fully-priced ratio — see observeReserve().
    error MintingHalted();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address usdc_, address oracle_, address admin_) public initializer {
        if (usdc_ == address(0) || oracle_ == address(0) || admin_ == address(0)) revert InvalidParam();

        // UUPSUpgradeable is stateless in OZ 5.x and has no initializer.
        __AccessControl_init();
        __Pausable_init();

        _usdc   = usdc_;
        _oracle = oracle_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(RISK_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);

        // Conservative defaults. The operator's risk committee overrides these.
        mintFeeBps         = 30;      // 0.30%
        redeemFeeBps       = 30;      // 0.30%
        minReserveRatioBps = 11_000;  // require 110% reserve coverage to mint
        maxPriceAge        = 1 hours; // matches keeper cadence with headroom
    }

    function version() public pure virtual returns (string memory) {
        return "2.3.0";
    }

    function usdc() public view returns (address) { return _usdc; }
    function oracle() public view returns (address) { return _oracle; }
    function assetToken(bytes32 assetId) public view returns (address) { return _assetToken[assetId]; }
    function exposureOf(bytes32 assetId) public view returns (uint256) { return _outstanding[assetId]; }

    /// @dev M-5: re-pointing an asset id at a DIFFERENT token while units are
    ///      still outstanding strands every holder — `redeem` burns from the new
    ///      token, which they do not hold, while `_outstanding` keeps recording
    ///      the old liability. `unregisterAsset` already refuses in that state;
    ///      this closes the same hole on the way in. Same-token re-registration
    ///      stays allowed (idempotent re-wiring).
    function registerAsset(bytes32 assetId, address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidParam();
        address current = _assetToken[assetId];
        if (current != address(0) && current != token) {
            uint256 out = _outstanding[assetId];
            if (out != 0) revert AssetStillOutstanding(assetId, out);
        }
        if (_assetToken[assetId] == address(0)) {
            if (_assetIds.length >= MAX_REGISTERED_ASSETS) {
                revert TooManyAssets(MAX_REGISTERED_ASSETS);
            }
            _assetIds.push(assetId);
        }
        _assetToken[assetId] = token;
        emit AssetRegistered(assetId, token);
    }

    /// @notice Removes an asset, freeing a slot and taking it out of the
    ///         reserve-ratio loop.
    /// @dev Refuses while tokens are still outstanding — de-registering then
    ///      would strand holders with a token the vault no longer redeems. Wind
    ///      down with setAssetCap(id, 0) first, let holders redeem, then remove.
    function unregisterAsset(bytes32 assetId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_assetToken[assetId] == address(0)) revert AssetNotRegistered(assetId);
        uint256 out = _outstanding[assetId];
        if (out != 0) revert AssetStillOutstanding(assetId, out);

        uint256 len = _assetIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (_assetIds[i] == assetId) {
                _assetIds[i] = _assetIds[len - 1];
                _assetIds.pop();
                break;
            }
        }
        delete _assetToken[assetId];
        delete assetCap[assetId];

        emit AssetUnregistered(assetId);
    }

    /// @notice Registered asset ids, so the operator can see what counts toward
    ///         the MAX_REGISTERED_ASSETS ceiling and the ratio loop.
    function registeredAssets() external view returns (bytes32[] memory) {
        return _assetIds;
    }

    /// @notice Repoint the vault at a different price oracle.
    /// @dev This is the escape hatch PerpetualExchange does not have — its
    ///      oracle is `immutable`, so it can never move off MockOracle without
    ///      a redeploy that would destroy every open position. Here the oracle
    ///      is ordinary storage, so the operator can migrate to a hardened or
    ///      decentralized feed (see GuardedOracle) with one transaction.
    ///
    ///      Admin-gated because it is equivalent to control of the reserve: an
    ///      attacker who can set the oracle can set any price. Hold this role in
    ///      a multisig behind a timelock.
    function setOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOracle == address(0)) revert InvalidParam();
        address old = _oracle;
        _oracle = newOracle;
        emit OracleChanged(old, newOracle);
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @dev VULNERABILITY #3 FIX: V1 read updatedAt and discarded it, so a dead
    ///      keeper meant trading against a frozen quote. PerpetualExchange has
    ///      always reverted StalePrice past maxPriceAge; this now matches it.
    function _price(bytes32 assetId) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = IAssetOracleV2(_oracle).getPrice(assetId);
        if (price == 0) revert NoPrice(assetId);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(assetId, updatedAt);
    }

    function previewMint(bytes32 assetId, uint256 usdcAmount)
        public view returns (uint256 tokenOut, uint256 feePaid)
    {
        if (_assetToken[assetId] == address(0)) revert AssetNotRegistered(assetId);
        uint256 price = _price(assetId);
        feePaid  = usdcAmount * mintFeeBps / BPS_DENOM;
        tokenOut = (usdcAmount - feePaid) * 1e8 / price;
    }

    function previewRedeem(bytes32 assetId, uint256 tokenAmount)
        public view returns (uint256 usdcOut, uint256 feePaid)
    {
        if (_assetToken[assetId] == address(0)) revert AssetNotRegistered(assetId);
        uint256 price = _price(assetId);
        uint256 gross = tokenAmount * price / 1e8;
        feePaid = gross * redeemFeeBps / BPS_DENOM;
        usdcOut = gross - feePaid;
    }

    /// @notice Operator risk knobs. Separate RISK_ROLE from upgrade authority so
    ///         a risk committee can retune without holding upgrade power.
    function setRiskParams(
        uint256 mintFeeBps_,
        uint256 redeemFeeBps_,
        uint256 minReserveRatioBps_,
        uint256 maxPriceAge_
    ) external onlyRole(RISK_ROLE) {
        // Cap fees at 10% so a compromised risk key cannot confiscate deposits.
        if (mintFeeBps_ > 1_000 || redeemFeeBps_ > 1_000) revert InvalidParam();
        if (maxPriceAge_ == 0) revert InvalidParam();
        // V2.3: a floor below 100% (BPS_DENOM) would make `ratioBps < minBps`
        // (both in mint() and in observeReserve()'s breach latch) impossible to
        // ever satisfy — ratioBps is unsigned and never negative, so
        // minReserveRatioBps_ == 0 silently and permanently disables BOTH the
        // pre-existing mint-time check AND this version's whole breach/halt
        // mechanism, with no distinguishing event. 100% is the loosest value
        // that still means something (mint proceeds only when the reserve at
        // least equals the liability); the useful range for a risk committee
        // is above that, matching the 110% default below.
        if (minReserveRatioBps_ < BPS_DENOM) revert InvalidParam();

        mintFeeBps         = mintFeeBps_;
        redeemFeeBps       = redeemFeeBps_;
        minReserveRatioBps = minReserveRatioBps_;
        maxPriceAge        = maxPriceAge_;

        emit RiskParamsUpdated(mintFeeBps_, redeemFeeBps_, minReserveRatioBps_, maxPriceAge_);
    }

    /// @notice USDC available to pay redeemers. Excludes accrued fees, which
    ///         belong to the operator and are not payout collateral.
    function reserve() public view returns (uint256) {
        uint256 bal = IERC20(_usdc).balanceOf(address(this));
        return bal > accruedFees ? bal - accruedFees : 0;
    }

    /// @dev Skips assets with a stale or zero price rather than reverting, so
    ///      risk dashboards stay readable during an oracle outage. A skipped
    ///      asset understates the liability — callers must treat a stale oracle
    ///      as "ratio unknown", which is why mint independently calls _price and
    ///      reverts on staleness.
    function outstandingValue() public view returns (uint256 total) {
        (total, ) = outstandingValueDetailed();
    }

    /// @notice Liability, plus how many assets could not be priced.
    /// @dev V2.0 called getPrice directly and skipped stale assets with a
    ///      `continue`. That assumed an oracle which RETURNS stale data — true
    ///      of MockOracle, false of GuardedOracle, which fails closed and
    ///      REVERTS. Against a reverting oracle the whole loop died, so
    ///      reserveRatioBps() and therefore mint() reverted too: one stale asset
    ///      blocked minting every OTHER asset, and V2 stopped working entirely
    ///      until a keeper posted again.
    ///
    ///      The try/catch restores the documented behaviour — skip what cannot
    ///      be priced, keep going — for both kinds of oracle.
    ///
    ///      `unpriced` is returned because a skipped asset UNDERSTATES the
    ///      liability, which makes the ratio optimistic. Callers must treat
    ///      unpriced > 0 as "ratio unknown", not "ratio healthy". mint() still
    ///      prices the asset being minted through _price(), so no mint is ever
    ///      admitted on the strength of an optimistic ratio.
    function outstandingValueDetailed()
        public view returns (uint256 total, uint256 unpriced)
    {
        uint256 len = _assetIds.length;
        for (uint256 i = 0; i < len; i++) {
            bytes32 id = _assetIds[i];
            uint256 amount = _outstanding[id];
            if (amount == 0) continue;

            try IAssetOracleV2(_oracle).getPrice(id) returns (uint256 price, uint256 updatedAt) {
                if (price == 0 || block.timestamp > updatedAt + maxPriceAge) {
                    unpriced++;
                    continue;
                }
                total += amount * price / 1e8;
            } catch {
                // Oracle refused to quote — stale, frozen, or unknown asset.
                unpriced++;
            }
        }
    }

    /// @notice True when any outstanding asset could not be priced, so
    ///         reserveRatioBps() is optimistic and should not be trusted.
    function ratioIsStale() external view returns (bool) {
        (, uint256 unpriced) = outstandingValueDetailed();
        return unpriced > 0;
    }

    function reserveRatioBps() public view returns (uint256) {
        uint256 liability = outstandingValue();
        if (liability == 0) return type(uint256).max;
        return reserve() * BPS_DENOM / liability;
    }

    /// @notice The reserve position and whether it can be trusted, in one read.
    /// @dev Two calls (`reserveRatioBps()` then `ratioIsStale()`) can straddle a
    ///      block and disagree, and a UI that shows an optimistic number without
    ///      its caveat is worse than one that shows nothing. Returned together
    ///      so a caller cannot accidentally take one without the other.
    function reserveStatus()
        external
        view
        returns (
            uint256 reserve_,
            uint256 liability,
            uint256 ratioBps,
            uint256 unpriced,
            bool stale,
            bool halted
        )
    {
        (reserve_, liability, ratioBps, unpriced) = _snapshot();
        stale  = unpriced > 0;
        halted = mintingHalted;
    }

    /// @notice Records the current reserve position on-chain and latches a
    ///         breach. Permissionless.
    ///
    /// @dev PERMISSIONLESS because it asserts nothing. Every number it emits is
    ///      derived from this contract's own storage and the oracle it already
    ///      reads — a caller cannot influence any of them, only choose when the
    ///      snapshot is taken. Gating it behind a role would add a key to
    ///      protect a function that protects nothing, and would make the history
    ///      stop the moment that key went quiet. The keeper is expected to call
    ///      it on its existing cadence; anyone may call it in between.
    ///
    ///      DELIBERATELY NOT `whenNotPaused`: a paused vault is exactly when the
    ///      reserve number matters most.
    ///
    ///      The breach/restore rule is asymmetric on purpose, because `unpriced`
    ///      makes the ratio OPTIMISTIC and never pessimistic:
    ///        - below the line while stale → still a real breach. The true ratio
    ///          is lower than the one that already failed. Latch it.
    ///        - at or above the line while stale → proves nothing. Stay halted.
    ///      So staleness can only ever cost the operator new mints, never a
    ///      holder their protection. If a specific asset's feed is permanently
    ///      gone (not just temporarily stale) this rule can leave the vault
    ///      halted forever with no observation able to clear it — that case
    ///      has a separate, deliberately manual escape hatch: `clearMintingHalt()`.
    function observeReserve()
        external
        returns (
            uint256 reserve_,
            uint256 liability,
            uint256 ratioBps,
            uint256 unpriced,
            bool halted
        )
    {
        (reserve_, liability, ratioBps, unpriced) = _snapshot();
        emit ReserveObserved(reserve_, liability, ratioBps, unpriced, block.timestamp);

        uint256 minBps = minReserveRatioBps;
        if (ratioBps < minBps) {
            // Emitted on the crossing only. A keeper ticking every 15 minutes
            // through a week-long drawdown would otherwise bury the moment it
            // broke under hundreds of identical alerts.
            if (!mintingHalted) {
                mintingHalted = true;
                emit ReserveBreached(ratioBps, minBps, unpriced);
            }
        } else if (unpriced == 0 && mintingHalted) {
            mintingHalted = false;
            emit ReserveRestored(ratioBps, minBps);
        }

        halted = mintingHalted;
    }

    /// @notice Emergency override for `observeReserve()`'s restore condition:
    ///         clears `mintingHalted` even while some asset remains unpriced.
    /// @dev Exists because `unregisterAsset` refuses while an asset still has
    ///      nonzero outstanding, so a single abandoned or delisted price feed
    ///      with dust left outstanding could otherwise hold `mintingHalted`
    ///      forever for every OTHER healthy asset — `observeReserve()`'s
    ///      automatic restore requires `unpriced == 0` vault-wide precisely
    ///      because an optimistic ratio must never self-clear a real breach,
    ///      and that rule has no exception for "this particular staleness
    ///      doesn't matter". This function is that exception, made explicit:
    ///      the operator confirms it (e.g. the stale asset is capped to 0 and
    ///      its remaining exposure is de minimis) and clears deliberately.
    ///
    ///      Held by RISK_ROLE — the same role that already owns every other
    ///      risk knob on this contract (`setRiskParams`, `setAssetCap`), so
    ///      this adds no new trust surface, only an escape hatch for a state
    ///      the automatic path cannot reach on its own.
    ///
    ///      Emits `MintingHaltCleared`, not `ReserveRestored`: the latter's
    ///      documented meaning is "a fully-priced observation found the ratio
    ///      healthy" — reusing it here, when `unpriced` may still be nonzero,
    ///      would let a manual override masquerade as an automatic recovery in
    ///      the replayed history.
    function clearMintingHalt() external onlyRole(RISK_ROLE) {
        mintingHalted = false;
        (, , uint256 ratioBps, uint256 unpriced) = _snapshot();
        emit MintingHaltCleared(msg.sender, ratioBps, unpriced);
    }

    function _snapshot()
        internal
        view
        returns (uint256 reserve_, uint256 liability, uint256 ratioBps, uint256 unpriced)
    {
        reserve_ = reserve();
        (liability, unpriced) = outstandingValueDetailed();
        ratioBps = liability == 0
            ? type(uint256).max
            : reserve_ * BPS_DENOM / liability;
    }

    /// @notice Bounds exposure to one market. 0 closes the asset to new mints
    ///         while leaving redemptions open.
    function setAssetCap(bytes32 assetId, uint256 cap) external onlyRole(RISK_ROLE) {
        assetCap[assetId] = cap;
        emit AssetCapUpdated(assetId, cap);
    }

    /// @notice Pay USDC, receive tokens at the oracle price less the mint fee.
    /// @dev Gated by the per-asset cap, the latched breach, and the reserve
    ///      ratio.
    function mint(bytes32 assetId, uint256 usdcAmount)
        external whenNotPaused nonReentrant returns (uint256 tokenOut)
    {
        // V2.3: the latched halt, checked before anything else costs gas.
        //
        // This is NOT redundant with the ratio check below. That one is
        // evaluated AFTER the incoming USDC lands, so a large enough mint can
        // satisfy a line the book is currently under — it asks "would this mint
        // leave us healthy", not "are we healthy". Once a breach has been
        // observed, new issuance stops until an observation says the book
        // recovered, which anyone can perform.
        if (mintingHalted) revert MintingHalted();

        address token = _assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 feePaid;
        (tokenOut, feePaid) = previewMint(assetId, usdcAmount);   // reverts if stale
        if (tokenOut == 0) revert ZeroAmount();

        uint256 newOutstanding = _outstanding[assetId] + tokenOut;
        if (newOutstanding > assetCap[assetId]) {
            revert CapExceeded(assetId, newOutstanding, assetCap[assetId]);
        }

        _outstanding[assetId] = newOutstanding;
        accruedFees += feePaid;

        IERC20(_usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);

        // VULNERABILITY #2 FIX: refuse the mint if it would leave the book below
        // the operator's minimum coverage. Checked after the transfer so the
        // incoming USDC counts toward the ratio it must satisfy.
        uint256 ratio = reserveRatioBps();
        if (ratio < minReserveRatioBps) revert ReserveRatioTooLow(ratio, minReserveRatioBps);

        SyntheticAssetV2(token).mint(msg.sender, tokenOut);
        emit Minted(msg.sender, assetId, usdcAmount, tokenOut, feePaid);
    }

    /// @notice Burn tokens, receive their USDC value less the redeem fee.
    /// @dev Deliberately NOT gated by the reserve ratio — blocking exits during
    ///      stress is the bank run, not a defence against it. V2.3 keeps that
    ///      intact: `mintingHalted` is checked in mint() and nowhere else, so a
    ///      breach that stops new issuance never touches the exit.
    function redeem(bytes32 assetId, uint256 tokenAmount)
        external whenNotPaused nonReentrant returns (uint256 usdcOut)
    {
        address token = _assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 feePaid;
        (usdcOut, feePaid) = previewRedeem(assetId, tokenAmount);

        uint256 avail = reserve();
        if (avail < usdcOut) revert VaultDry(usdcOut, avail);

        // Only credit the portion of the fee the vault can actually back.
        //
        // Through V2.1 the full fee was credited whenever the reserve covered
        // the NET payout, so a redeem in the window `usdcOut <= reserve < gross`
        // booked operator revenue against money that was not there. Once
        // accruedFees passed the balance, reserve() clamped to 0 and every later
        // redeem reverted VaultDry on USDC the vault demonstrably held —
        // holders frozen out by an accounting artefact. Found by
        // invariant_reserveNeverCountsAccruedFees.
        //
        // The alternative fix — requiring `reserve >= gross` — would instead
        // refuse the exit outright. Charging the operator less is the right side
        // to err on: blocking exits under stress is the bank run, not a defence
        // against it, and the operator should not book revenue that is not
        // there.
        uint256 headroom  = avail - usdcOut;
        uint256 backedFee = feePaid <= headroom ? feePaid : headroom;

        _outstanding[assetId] -= tokenAmount;
        accruedFees += backedFee;

        SyntheticAssetV2(token).burn(msg.sender, tokenAmount);
        IERC20(_usdc).safeTransfer(msg.sender, usdcOut);

        emit Redeemed(msg.sender, assetId, tokenAmount, usdcOut, backedFee);
    }

    /// @notice Operator injects payout collateral.
    function fundVault(uint256 usdcAmount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();
        IERC20(_usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        emit VaultFunded(msg.sender, usdcAmount);
    }

    /// @notice Operator withdraws earned fees. Cannot touch payout collateral.
    function withdrawFees(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert InvalidParam();
        if (amount > accruedFees) revert InvalidParam();
        accruedFees -= amount;
        IERC20(_usdc).safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }
}
