// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface IPriceSource {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice Price oracle that removes the single-key failure mode of MockOracle.
///
///         MockOracle.updatePrice is `onlyOwner`, so one compromised key can set
///         any price and drain every contract that prices off it. That is the
///         most severe unmitigated risk in the system. This contract keeps the
///         same `getPrice(bytes32) -> (price, updatedAt)` interface so it is a
///         drop-in for anything that reads MockOracle, and adds:
///
///           - N keepers instead of one owner, each able to post
///           - a per-update deviation cap, so a single bad post cannot move the
///             price arbitrarily even from an authorized key
///           - quarantine: a post beyond the cap is rejected, not clamped, and
///             the asset can be frozen for review
///           - an optional reference source (e.g. the Chainlink/Pyth aggregator)
///             that posts must agree with
///           - pause, and role separation so the admin key can live in a
///             multisig behind a timelock while keepers stay hot
///           - a RATE LIMIT: a cap on the cumulative move within a time window,
///             so a compromised keeper cannot walk the price arbitrarily far by
///             chaining many legal per-update steps (N x 10% in one block)
///           - BOUNDED guardian halts: a freeze or pause placed by the
///             guardian lapses on its own and is followed by a cooldown, so a
///             stolen guardian key cannot hold reads shut indefinitely. Only
///             the admin can place a halt with no expiry (see "guardian").
///
///         What it does NOT do: make prices trustless. Keepers are still trusted
///         parties. It converts "one key can do anything" into "one key can do
///         a little, and visibly". Full custody-grade pricing needs a
///         decentralized feed as the reference source — which is what
///         `referenceSource` is for.
contract GuardedOracle is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant BPS_DENOM = 10_000;

    /// @notice A halt placed by the guardian (asset freeze or pause) lapses
    ///         this long after its window opened. Same value as
    ///         PerpetualExchange.GUARDIAN_PAUSE_DURATION, and longer than the
    ///         48h governance timelock on purpose: the admin has time to take
    ///         a halt over (no expiry) before it lapses.
    uint256 public constant GUARDIAN_HALT_DURATION = 72 hours;

    /// @notice After a guardian window on a scope ends, the guardian may not
    ///         open another on that scope for this long. Same value as
    ///         PerpetualExchange.GUARDIAN_PAUSE_COOLDOWN. The admin is never
    ///         subject to it.
    uint256 public constant GUARDIAN_HALT_COOLDOWN = 24 hours;

    struct Asset {
        uint256 price;      // 8 decimals, matching MockOracle
        uint256 updatedAt;
        bool    exists;
    }

    mapping(bytes32 => Asset) private _assets;

    /// @dev One halt scope: a single asset's freeze, or the oracle-wide pause.
    ///      Packs into one slot.
    ///
    ///      `on` is only the stored flag. The halt is IN FORCE when `on` is set
    ///      and it has not lapsed (`_inForce`); every read and write path goes
    ///      through that, so a lapsed guardian halt stops applying by itself,
    ///      with no transaction.
    ///
    ///      Once a guardian halt is no longer in force (lapsed, or lifted
    ///      early) `since` and `expiresAt` are kept as the record of when it
    ///      ACTUALLY ran: lifting early writes the lift time into `expiresAt`.
    ///      The cross-scope rule reads the guardian's own pause record
    ///      (`_guardianPauseStart` / `_guardianPauseEnd`), which admin pause
    ///      actions never reset (see "guardian").
    struct Halt {
        bool   on;
        bool   pinned;             // pause only: a guardian freeze was placed while this guardian pause was in force
        uint64 since;              // start of the latest halt
        uint64 expiresAt;          // in force: 0 = no expiry (admin); guardian halt over: when it actually ended
        uint64 guardianWindowEnd;  // end of the latest guardian window on this scope
    }
    mapping(bytes32 => Halt) private _freezes;
    Halt private _pause;

    /// @dev The latest guardian pause as it ACTUALLY ran, kept apart from
    ///      `_pause` so that nothing the admin does to the pause erases it.
    ///      Set when a guardian pause starts (end = its expiry); the end moves
    ///      to the lift time if it is lifted early, or to the takeover time if
    ///      the admin takes it over (from there on the pause is the admin's).
    ///      An admin pause starting or being lifted does not touch it. The
    ///      cross-scope rule reads this (see "guardian").
    uint64 private _guardianPauseStart;
    uint64 private _guardianPauseEnd;

    /// @notice Max move per update, in bps of the previous price. 0 = unlimited
    ///         (only sane before the first price is seeded).
    uint256 public maxDeviationBps = 1_000;   // 10%

    /// @notice Reject prices older than this when reading. 0 disables the check.
    uint256 public maxPriceAge = 1 hours;

    /// @notice Optional cross-check. When set, a keeper's post must agree with
    ///         this source within maxDeviationBps.
    address public referenceSource;

    /// @notice Rate limit: within one window of `windowDuration` seconds an
    ///         asset may move at most `maxWindowDeviationBps` from the price it
    ///         had when the window opened. 0 = off.
    ///
    ///         Windows are tumbling, but a post is checked against BOTH the
    ///         current window's anchor and the previous window's anchor while
    ///         that one is less than two windows old. What that actually
    ///         guarantees (no more):
    ///           - a one-way move within any span of about ONE window is at
    ///             most `maxWindowDeviationBps` — the plain-tumbling exploit
    ///             (full move at the end of window N, full move again right
    ///             after the roll) is refused;
    ///           - two posts more than one window apart CAN each use the full
    ///             cap (e.g. a full move near the end of window N, then another
    ///             `windowDuration + 1` seconds later, when window N is more
    ///             than two windows old at the roll). Worst case is therefore
    ///             about 2x the cap per (window + 1 s), not 1x per window.
    ///           - a round trip (−x then +x) is not limited by the window.
    ///         A true sliding window would need price history; not worth it
    ///         here because the step cap and guardian freeze bound the rest.
    uint256 public windowDuration;
    uint256 public maxWindowDeviationBps;

    struct Window {
        uint256 anchorPrice;
        uint256 start;
        uint256 prevAnchor;   // 0 = no recent previous window
        uint256 prevStart;
    }
    mapping(bytes32 => Window) private _windows;

    event AssetAdded(bytes32 indexed assetId, uint256 price);
    event PriceUpdated(bytes32 indexed assetId, uint256 oldPrice, uint256 newPrice, address keeper);
    event PriceRejected(bytes32 indexed assetId, uint256 attempted, uint256 current, string reason);
    /// @notice Emitted whenever a freeze starts (true) or is lifted (false) by
    ///         a call. A guardian freeze that LAPSES emits nothing (there is no
    ///         transaction), so watchers read `expiresAt` from AssetFreezeStarted.
    event AssetFrozen(bytes32 indexed assetId, bool frozen);
    /// @param expiresAt When the freeze lapses on its own; 0 = no expiry (admin).
    event AssetFreezeStarted(bytes32 indexed assetId, address indexed by, uint256 expiresAt);
    /// @notice The admin took a running guardian freeze over: it no longer expires.
    event AssetFreezeTakenOver(bytes32 indexed assetId, address indexed by);
    event AssetFreezeLifted(bytes32 indexed assetId, address indexed by);
    event RiskParamsUpdated(uint256 maxDeviationBps, uint256 maxPriceAge);
    event ReferenceSourceSet(address source);
    /// @notice Emitted whenever a pause starts (true) or is lifted (false) by a
    ///         call. A guardian pause that lapses emits nothing (see AssetFrozen).
    event PausedSet(bool paused);
    /// @param expiresAt When the pause lapses on its own; 0 = no expiry (admin).
    event PauseStarted(address indexed by, uint256 expiresAt);
    /// @notice The admin took a running guardian pause over: it no longer expires.
    event PauseTakenOver(address indexed by);
    event PauseLifted(address indexed by);
    event WindowLimitUpdated(uint256 windowDuration, uint256 maxWindowDeviationBps);

    error AssetNotFound(bytes32 assetId);
    error AssetAlreadyExists(bytes32 assetId);
    error InvalidPrice();
    error DeviationTooLarge(bytes32 assetId, uint256 attempted, uint256 current);
    error ReferenceDisagrees(bytes32 assetId, uint256 attempted, uint256 refPrice);
    error AssetIsFrozen(bytes32 assetId);
    error StalePrice(bytes32 assetId, uint256 updatedAt);
    error IsPaused();
    error InvalidParam();
    error WindowDeviationTooLarge(bytes32 assetId, uint256 attempted, uint256 windowAnchor);
    /// @notice The scope is already halted. The guardian can neither extend its
    ///         own halt nor replace the admin's with one that expires.
    error AlreadyHalted();
    /// @notice The guardian may not open a new window on this scope before `allowedAt`.
    error GuardianCooldown(uint256 allowedAt);
    /// @notice Only the admin can lift a halt that has no expiry.
    error NotGuardianHalt();
    /// @notice `takeOverAssetFreeze` / `takeOverPause` found no guardian halt
    ///         in force (it was lifted or has lapsed, or the admin already
    ///         holds it). A queued takeover therefore never turns into a new
    ///         halt of its own.
    error NothingToTakeOver();

    constructor(address admin) {
        if (admin == address(0)) revert InvalidParam();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // ── reads (MockOracle-compatible) ────────────────────────────────────────

    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt) {
        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (_inForce(_freezes[assetId])) revert AssetIsFrozen(assetId);
        if (maxPriceAge != 0 && block.timestamp > a.updatedAt + maxPriceAge) {
            revert StalePrice(assetId, a.updatedAt);
        }
        return (a.price, a.updatedAt);
    }

    /// @notice Mirrors MockOracle.isStale so adapters can probe this the same way.
    function isStale(bytes32 assetId) external view returns (bool) {
        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (_inForce(_freezes[assetId])) return true;
        if (maxPriceAge == 0) return false;
        return block.timestamp > a.updatedAt + maxPriceAge;
    }

    /// @notice Raw read that never reverts on staleness or freeze — for
    ///         dashboards that need to show why something is wrong. `frozen`
    ///         is whether a freeze is in force NOW (false once a guardian
    ///         freeze has lapsed).
    function peek(bytes32 assetId)
        external view
        returns (uint256 price, uint256 updatedAt, bool exists, bool frozen)
    {
        Asset storage a = _assets[assetId];
        return (a.price, a.updatedAt, a.exists, _inForce(_freezes[assetId]));
    }

    /// @notice True while a pause is in force (false once a guardian pause has
    ///         lapsed). A pause stops keeper posts; reads keep answering until
    ///         the last price goes stale.
    function paused() public view returns (bool) {
        return _inForce(_pause);
    }

    /// @notice The freeze state of `assetId`.
    /// @return inForce            a freeze applies right now
    /// @return since              when it started (0 when none is in force)
    /// @return expiresAt          when it lapses on its own; 0 = no expiry, or none in force
    /// @return guardianWindowEnd  end of the latest guardian window on this asset
    function freezeOf(bytes32 assetId)
        external view
        returns (bool inForce, uint256 since, uint256 expiresAt, uint256 guardianWindowEnd)
    {
        return _describe(_freezes[assetId]);
    }

    /// @notice The pause state. Same fields as `freezeOf`.
    function pauseState()
        external view
        returns (bool inForce, uint256 since, uint256 expiresAt, uint256 guardianWindowEnd)
    {
        return _describe(_pause);
    }

    /// @notice What a guardian freeze of `assetId` would get right now, assuming
    ///         no freeze is in force. Exactly the rule `setAssetFrozen` applies.
    /// @return expiresAt  when that freeze would lapse (0 when blocked)
    /// @return allowedAt  0 = allowed now; otherwise the cooldown ends then
    function guardianFreezeTerms(bytes32 assetId) external view returns (uint256 expiresAt, uint256 allowedAt) {
        return _guardianTerms(_freezes[assetId], true);
    }

    /// @notice Same as `guardianFreezeTerms`, for the pause.
    function guardianPauseTerms() external view returns (uint256 expiresAt, uint256 allowedAt) {
        return _guardianTerms(_pause, false);
    }

    /// @notice When the latest guardian pause ACTUALLY ran, once it is no
    ///         longer in force: `end` is the lift time if it was lifted early,
    ///         the takeover time if the admin took it over, else its expiry.
    ///         (0, 0) while a guardian pause is in force, or before the first
    ///         one. An admin pause in between, or an admin lift, leaves it as
    ///         it was. This is what the cross-scope rule reads (see "guardian").
    function lastGuardianPause() external view returns (uint256 start, uint256 end) {
        if (_guardianPauseInForce()) return (0, 0);
        return (_guardianPauseStart, _guardianPauseEnd);
    }

    // ── keeper writes ────────────────────────────────────────────────────────

    function addAsset(bytes32 assetId, uint256 initialPrice) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_assets[assetId].exists) revert AssetAlreadyExists(assetId);
        if (initialPrice == 0) revert InvalidPrice();
        _assets[assetId] = Asset({
            price: initialPrice, updatedAt: block.timestamp, exists: true
        });
        emit AssetAdded(assetId, initialPrice);
    }

    /// @notice Post a price. Any KEEPER_ROLE holder may call; the guards below
    ///         bound what a single compromised keeper can achieve.
    function updatePrice(bytes32 assetId, uint256 newPrice) external onlyRole(KEEPER_ROLE) {
        if (_inForce(_pause)) revert IsPaused();

        Asset storage a = _assets[assetId];
        if (!a.exists) revert AssetNotFound(assetId);
        if (_inForce(_freezes[assetId])) revert AssetIsFrozen(assetId);
        if (newPrice == 0) revert InvalidPrice();

        uint256 old = a.price;

        // ── M-2: the two gates used to contradict each other ──────────────────
        //
        // The step cap says "no post may move the price more than
        // maxDeviationBps from the LAST POST". The reference check said "every
        // post must land within maxDeviationBps of the REFERENCE". When the
        // market gaps — say −30% — those two demands have no common solution:
        //   * posting the true price is rejected by the step cap (30% > 10%);
        //   * posting a legal −10% step is rejected by the reference check,
        //     because a −10% price is still 22% away from a −30% reference.
        // The oracle freezes at the pre-gap price precisely when it matters
        // most, and the only exit was an admin setting maxDeviationBps to 0 —
        // i.e. removing the control entirely (docs/ROLE_SEPARATION.md,
        // 2026-07-27).
        //
        // The two gates are now made consistent, and the reference is treated
        // as what it is: the trust anchor.
        //   * If the reference AGREES with the post, the post is confirmed by a
        //     decentralized feed, so the step cap — whose whole purpose is to
        //     bound an unverified move — does not apply. A real 30% gap lands
        //     in one call.
        //   * If the reference DISAGREES, the post must be a converging step:
        //     strictly closer to the reference than the current price is, and
        //     still inside the step cap. That is the same "walk towards the
        //     target" shape the keeper's stepTowards already implements, so a
        //     keeper can always make progress even with the reference wired in.
        //   * If the reference is unavailable, behaviour is unchanged: the step
        //     cap alone applies (an outage must not freeze the platform).
        bool refConfirms;
        if (referenceSource != address(0)) {
            (bool ok, uint256 refPrice) = _reference(assetId);
            if (ok) {
                if (!_deviationExceeded(refPrice, newPrice, maxDeviationBps)) {
                    refConfirms = true;
                } else if (!_convergesTowards(old, newPrice, refPrice)) {
                    emit PriceRejected(assetId, newPrice, refPrice, "reference");
                    revert ReferenceDisagrees(assetId, newPrice, refPrice);
                }
            }
        }

        // Reject rather than clamp: a clamped price is a fabricated price, and
        // the caller would have no way to know the number is not the market.
        if (!refConfirms && maxDeviationBps != 0 && _deviationExceeded(old, newPrice, maxDeviationBps)) {
            emit PriceRejected(assetId, newPrice, old, "deviation");
            revert DeviationTooLarge(assetId, newPrice, old);
        }

        // Rate limit. A reference-confirmed post is a verified market move —
        // the same reasoning that lets it bypass the step cap — so it passes
        // and re-anchors the window at the confirmed price (otherwise a real
        // gap would leave every later small step "too far" from a stale anchor).
        if (maxWindowDeviationBps != 0) {
            Window storage w = _windows[assetId];
            if (refConfirms) {
                w.anchorPrice = newPrice;
                w.start = block.timestamp;
                w.prevAnchor = 0;
                w.prevStart = 0;
            } else {
                uint256 d = windowDuration;
                if (w.start == 0 || block.timestamp >= w.start + d) {
                    // Roll: the closing window becomes "previous" only if it
                    // is still less than two windows old.
                    if (w.start != 0 && block.timestamp < w.start + 2 * d) {
                        w.prevAnchor = w.anchorPrice;
                        w.prevStart  = w.start;
                    } else {
                        w.prevAnchor = 0;
                        w.prevStart  = 0;
                    }
                    w.anchorPrice = old;
                    w.start = block.timestamp;
                }
                if (_deviationExceeded(w.anchorPrice, newPrice, maxWindowDeviationBps)) {
                    emit PriceRejected(assetId, newPrice, w.anchorPrice, "window");
                    revert WindowDeviationTooLarge(assetId, newPrice, w.anchorPrice);
                }
                if (w.prevAnchor != 0 && block.timestamp < w.prevStart + 2 * d
                    && _deviationExceeded(w.prevAnchor, newPrice, maxWindowDeviationBps)) {
                    emit PriceRejected(assetId, newPrice, w.prevAnchor, "window-prev");
                    revert WindowDeviationTooLarge(assetId, newPrice, w.prevAnchor);
                }
            }
        }

        a.price = newPrice;
        a.updatedAt = block.timestamp;
        emit PriceUpdated(assetId, old, newPrice, msg.sender);
    }

    /// @notice The current rate-limit window of `assetId` (anchor price and
    ///         start; start 0 = no window opened yet).
    function windowOf(bytes32 assetId) external view returns (uint256 anchorPrice, uint256 start) {
        Window storage w = _windows[assetId];
        return (w.anchorPrice, w.start);
    }

    function previousWindowOf(bytes32 assetId) external view returns (uint256 anchorPrice, uint256 start) {
        Window storage w = _windows[assetId];
        return (w.prevAnchor, w.prevStart);
    }

    // ── guardian ─────────────────────────────────────────────────────────────

    //
    // Two halts: a per-asset FREEZE (reads and posts of that asset revert) and
    // an oracle-wide PAUSE (every post reverts; reads answer until the price
    // goes stale). Both fail closed for every consumer (closes, liquidations
    // and vault redeems included), so who may hold one, and for how long,
    // matters as much as who may start it.
    //
    //   ADMIN (DEFAULT_ADMIN_ROLE; the timelock after the handover)
    //     - a halt it places never expires; only the admin lifts it;
    //     - `takeOverAssetFreeze` / `takeOverPause` turn a RUNNING guardian
    //       halt into one with no expiry, and revert when there is none, so a
    //       takeover queued in the timelock cannot become a fresh halt after
    //       the guardian lifted a false alarm;
    //     - `setAssetFrozen(id, true)` / `setPaused(true)` mean "make sure an
    //       admin halt with no expiry is in force": they start one, or convert
    //       a running guardian halt, and are a no-op on the admin's own halt;
    //     - may lift any halt.
    //
    //   GUARDIAN (GUARDIAN_ROLE without the admin role; a hot key)
    //     - a halt it places lapses at most GUARDIAN_HALT_DURATION after it
    //       starts and cannot be extended: halting a scope that is already
    //       halted reverts (so it also cannot swap the admin's no-expiry halt
    //       for one that expires); it cannot lift a halt with no expiry;
    //     - FREEZE: may lift its freeze early (a false alarm must not cost
    //       72h) and re-freeze inside the same window; the window's end is
    //       fixed when it opens. After the window ends, no new freeze window
    //       on that asset for GUARDIAN_HALT_COOLDOWN;
    //     - PAUSE: lifting it early CLOSES its window at the lift, so the 24h
    //       cooldown runs from when the pause actually ended. Exception: when
    //       a guardian freeze was placed while the pause was in force
    //       ("pinned"), that freeze runs to the pause's original end, and so
    //       does the pause window (no re-pause inside it; cooldown from there).
    //   The clocks belong to the scope, not to the caller: several guardian
    //   keys share them.
    //
    // The pause covers every asset, so the per-asset clocks alone would let a
    // guardian alternate "freeze X" and "pause" and keep X unreadable for
    // good. A guardian freeze opening a new window therefore also answers to
    // the pause, as it ACTUALLY ran (not to a window it no longer holds):
    //   - while a guardian pause is in force, the freeze ends no later than
    //     the pause does (and pins it, above);
    //   - within GUARDIAN_HALT_COOLDOWN after a guardian pause that ran for
    //     `d` ended, the freeze is refused if this asset had a guardian freeze
    //     window ending less than GUARDIAN_HALT_COOLDOWN before that pause
    //     started, or if d >= GUARDIAN_HALT_DURATION; otherwise it is
    //     shortened by `d`. A pause lifted at once (a false alarm) therefore
    //     costs other freezes nothing;
    //   - otherwise, and under an admin pause, the full window.
    // Net effect for any one asset, against a guardian acting alone: no
    // unbroken guardian halt lasts longer than 2 x GUARDIAN_HALT_DURATION
    // (144h: a freeze, then a pause opened before it ends), and the halted
    // stretch between two clean GUARDIAN_HALT_COOLDOWN spans is under 192h,
    // so a clean day starts at most 216h after the previous one did. The
    // guardian pause record lives outside the pause itself, so an admin pause,
    // an admin lift, or an admin takeover does not erase it: a guardian pause
    // the admin ended (or took over) still counts for as long as the guardian
    // held it. See docs/KNOWN_LIMITATIONS.md #27.
    //
    // A lapse only removes the halt. The stored price is as old as the halt,
    // so `maxPriceAge` (here and in each consumer) still decides whether it is
    // usable until a keeper posts again.

    /// @notice Freeze or unfreeze one asset. Reads revert while frozen, so
    ///         downstream contracts fail closed instead of trading on a
    ///         suspect price. See the rules above for expiry and cooldown.
    function setAssetFrozen(bytes32 assetId, bool frozen) external {
        if (!_assets[assetId].exists) revert AssetNotFound(assetId);
        Halt storage h = _freezes[assetId];
        if (frozen) {
            (HaltOutcome outcome, uint256 expiresAt) = _halt(h, true);
            if (outcome == HaltOutcome.Started) {
                emit AssetFrozen(assetId, true);
                emit AssetFreezeStarted(assetId, msg.sender, expiresAt);
            } else if (outcome == HaltOutcome.TakenOver) {
                emit AssetFreezeTakenOver(assetId, msg.sender);
            }
        } else if (_lift(h, false)) {
            emit AssetFrozen(assetId, false);
            emit AssetFreezeLifted(assetId, msg.sender);
        }
    }

    /// @notice Pause or unpause every keeper post. See the rules above.
    function setPaused(bool p) external {
        if (p) {
            (HaltOutcome outcome, uint256 expiresAt) = _halt(_pause, false);
            if (outcome == HaltOutcome.Started) {
                emit PausedSet(true);
                emit PauseStarted(msg.sender, expiresAt);
            } else if (outcome == HaltOutcome.TakenOver) {
                _guardianPauseEnd = uint64(block.timestamp);
                emit PauseTakenOver(msg.sender);
            }
        } else if (_lift(_pause, true)) {
            emit PausedSet(false);
            emit PauseLifted(msg.sender);
        }
    }

    /// @notice Admin only: the running guardian freeze of `assetId` no longer
    ///         expires. Reverts `NothingToTakeOver` when no guardian freeze is
    ///         in force, so a takeover queued in the timelock does nothing if
    ///         the guardian has lifted it (or it lapsed) in the meantime.
    function takeOverAssetFreeze(bytes32 assetId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _takeOver(_freezes[assetId]);
        emit AssetFreezeTakenOver(assetId, msg.sender);
    }

    /// @notice Admin only: same as `takeOverAssetFreeze`, for the pause.
    function takeOverPause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _takeOver(_pause);
        _guardianPauseEnd = uint64(block.timestamp);
        emit PauseTakenOver(msg.sender);
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function setRiskParams(uint256 maxDeviationBps_, uint256 maxPriceAge_)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        // A 100% cap would let one post double or zero the price, defeating the
        // control. Keep it meaningfully below that.
        if (maxDeviationBps_ > 5_000) revert InvalidParam();
        maxDeviationBps = maxDeviationBps_;
        maxPriceAge = maxPriceAge_;
        emit RiskParamsUpdated(maxDeviationBps_, maxPriceAge_);
    }

    /// @notice Set the rate limit. `bps == 0` turns it off. Otherwise the
    ///         window must be 5 minutes to 7 days and the cap at most 50% (the
    ///         same ceiling as the per-update cap).
    function setWindowLimit(uint256 duration, uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps != 0 && (bps > 5_000 || duration < 5 minutes || duration > 7 days)) revert InvalidParam();
        windowDuration = bps == 0 ? 0 : duration;
        maxWindowDeviationBps = bps;
        emit WindowLimitUpdated(windowDuration, bps);
    }

    /// @notice Point at a decentralized feed (e.g. AggregatorOracleAdapter) that
    ///         keeper posts must agree with. address(0) disables the check.
    function setReferenceSource(address source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        referenceSource = source;
        emit ReferenceSourceSet(source);
    }

    // ── internal ─────────────────────────────────────────────────────────────

    enum HaltOutcome { Unchanged, Started, TakenOver }

    function _inForce(Halt storage h) internal view returns (bool) {
        // Hour-scale windows: validator timestamp drift (seconds) is immaterial.
        // forge-lint: disable-next-line(block-timestamp)
        return h.on && (h.expiresAt == 0 || block.timestamp < h.expiresAt);
    }

    function _guardianPauseInForce() internal view returns (bool) {
        return _pause.expiresAt != 0 && _inForce(_pause);
    }

    function _describe(Halt storage h)
        internal view
        returns (bool inForce, uint256 since, uint256 expiresAt, uint256 guardianWindowEnd)
    {
        inForce = _inForce(h);
        if (inForce) {
            since = h.since;
            expiresAt = h.expiresAt;
        }
        guardianWindowEnd = h.guardianWindowEnd;
    }

    /// @dev The terms of a guardian halt on `h` at this instant.
    ///      `allowedAt != 0` means refused until then.
    function _guardianTerms(Halt storage h, bool isAsset)
        internal view
        returns (uint256 expiresAt, uint256 allowedAt)
    {
        uint256 end = h.guardianWindowEnd;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < end) {
            // A freeze lifted early may re-freeze inside its window: same
            // end, never a later one. A pause window still open here is one
            // pinned by a freeze (see _lift): no re-pause inside it.
            if (isAsset) return (end, 0);
            return (0, end + GUARDIAN_HALT_COOLDOWN);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (end != 0 && block.timestamp < end + GUARDIAN_HALT_COOLDOWN) {
            return (0, end + GUARDIAN_HALT_COOLDOWN);
        }

        expiresAt = block.timestamp + GUARDIAN_HALT_DURATION;
        if (!isAsset) return (expiresAt, 0);

        // Cross-scope: the guardian's pause as it actually ran. An admin
        // pause (no expiry) is the admin's call and does not limit the
        // guardian here — but it does not wipe the guardian's own record
        // either.
        if (_guardianPauseInForce()) {
            // A guardian pause is running: end with it.
            uint256 runningEnd = _pause.expiresAt;
            if (runningEnd < expiresAt) expiresAt = runningEnd;
            return (expiresAt, 0);
        }
        uint256 pEnd = _guardianPauseEnd;
        if (pEnd == 0) return (expiresAt, 0);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pEnd + GUARDIAN_HALT_COOLDOWN) {
            // A guardian pause ended less than a cooldown ago.
            uint256 pStart = _guardianPauseStart;
            uint256 ran = pEnd - pStart;
            // The asset was frozen by the guardian shortly before (or during)
            // that pause, or the pause ran its full length: the asset gets
            // its clean day first.
            if ((end != 0 && end + GUARDIAN_HALT_COOLDOWN > pStart) || ran >= GUARDIAN_HALT_DURATION) {
                return (0, pEnd + GUARDIAN_HALT_COOLDOWN);
            }
            // Otherwise shortened by how long the pause ran, so the pause and
            // this freeze together stay inside the bounds. A pause lifted at
            // once costs nothing.
            expiresAt -= ran;
        }
    }

    function _halt(Halt storage h, bool isAsset) internal returns (HaltOutcome outcome, uint256 expiresAt) {
        bool inForce = _inForce(h);

        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (inForce && h.expiresAt == 0) return (HaltOutcome.Unchanged, 0);
            outcome = inForce ? HaltOutcome.TakenOver : HaltOutcome.Started;
            if (!inForce) h.since = uint64(block.timestamp);
            h.on = true;
            h.expiresAt = 0;
            return (outcome, 0);
        }

        _checkRole(GUARDIAN_ROLE);
        if (inForce) revert AlreadyHalted();
        uint256 allowedAt;
        (expiresAt, allowedAt) = _guardianTerms(h, isAsset);
        if (allowedAt != 0) revert GuardianCooldown(allowedAt);
        if (isAsset) {
            // A freeze placed under a running guardian pause pins that
            // pause's window to its original end (see _lift).
            if (_pause.expiresAt != 0 && _inForce(_pause)) _pause.pinned = true;
        } else {
            h.pinned = false;
            _guardianPauseStart = uint64(block.timestamp);
            _guardianPauseEnd = uint64(expiresAt);
        }
        h.on = true;
        h.since = uint64(block.timestamp);
        h.expiresAt = uint64(expiresAt);
        h.guardianWindowEnd = uint64(expiresAt);
        return (HaltOutcome.Started, expiresAt);
    }

    /// @return lifted True when a halt that was in force has been removed.
    function _lift(Halt storage h, bool isPause) internal returns (bool lifted) {
        lifted = _inForce(h);
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            _checkRole(GUARDIAN_ROLE);
            if (lifted && h.expiresAt == 0) revert NotGuardianHalt();
        }
        if (lifted) {
            if (h.expiresAt != 0) {
                // A guardian halt ended early: [since, now] is its record.
                h.expiresAt = uint64(block.timestamp);
                // A freeze window stays open (re-freeze allowed until its
                // end). A pause window closes here, so its cooldown runs from
                // when it actually ended -- unless a freeze placed under it
                // still runs to the original end.
                if (isPause && !h.pinned) h.guardianWindowEnd = uint64(block.timestamp);
                if (isPause) _guardianPauseEnd = uint64(block.timestamp);
            } else {
                // An admin halt leaves no guardian record.
                h.since = 0;
            }
        }
        // A lapsed guardian halt keeps its record; only the flag is cleared.
        h.on = false;
    }

    function _takeOver(Halt storage h) internal {
        if (!_inForce(h) || h.expiresAt == 0) revert NothingToTakeOver();
        h.expiresAt = 0;
    }

    function _reference(bytes32 assetId) internal view returns (bool ok, uint256 price) {
        try IPriceSource(referenceSource).getPrice(assetId) returns (uint256 p, uint256) {
            if (p == 0) return (false, 0);
            return (true, p);
        } catch {
            // Reference unavailable is not a reason to block price updates —
            // that would let an outage freeze the platform.
            return (false, 0);
        }
    }

    /// @dev 以「舊價」為分母，讓上下方向的容許幅度一致。
    ///
    ///      先前以兩者中較小的值為分母，於是 +10% 可過而 −10% 被拒（實際只容許
    ///      −9.09%）。方向是反的：崩盤時最需要價格跟上、最需要清算啟動，而那正是
    ///      舊公式最容易擋下更新的時候。它也造成 keeper 的追價死鎖——一旦落後超過
    ///      上限，每一次全額更新都被拒絕，最後只能由 admin 把上限設成 0 手動修正
    ///      （見 docs/ROLE_SEPARATION.md 的 2026-07-27 紀錄）。
    function _deviationExceeded(uint256 oldPrice, uint256 newPrice, uint256 bps)
        internal pure returns (bool)
    {
        if (oldPrice == 0) return false;
        uint256 diff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice;
        return diff * BPS_DENOM > bps * oldPrice;
    }

    /// @dev True when `newPrice` is strictly closer to `refPrice` than `old` is.
    ///      This is the stepping rule that keeps the reference check and the
    ///      deviation cap solvable at the same time (see updatePrice).
    function _convergesTowards(uint256 old, uint256 newPrice, uint256 refPrice)
        internal pure returns (bool)
    {
        uint256 dOld = old > refPrice ? old - refPrice : refPrice - old;
        uint256 dNew = newPrice > refPrice ? newPrice - refPrice : refPrice - newPrice;
        return dNew < dOld;
    }
}
