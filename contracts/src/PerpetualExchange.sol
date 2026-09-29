// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./CarbonTiers.sol";

interface IOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

interface IFeeRouterPerp {
    function receivePerformanceFee(address trader, uint256 fee) external;
}

interface IInsuranceVaultPerp {
    function totalAssets() external view returns (uint256);
    function bailout(uint256 amount, address trader) external;
    function depositFromProtocol(uint256 amount) external;
}

interface IKyc {
    function isVerified(address user) external view returns (bool);
}

/// @dev Matches ESGRegistryV2.medianCarbonIntensity's exact signature. Declared
///     locally (not imported as the concrete contract) so this file depends on
///     an interface shape, not on ESGRegistryV2's implementation — the same
///     pattern IOracle/IKyc already use here for their own dependencies.
interface IEsgRegistryForPricing {
    function medianCarbonTier(bytes32 assetId)
        external view
        returns (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated);
}

contract PerpetualExchange is Ownable, ReentrancyGuard, Pausable {
    /// @dev M-4: non-standard ERC20s (mainnet USDT and friends) return no bool
    ///      from transfer/approve, so a bare `usdc.transfer(...)` against an
    ///      interface declaring a bool either reverts on ABI decode or, worse,
    ///      silently succeeds on failure. SafeERC20 handles both conventions and
    ///      turns a `false` return into a revert.
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_LEVERAGE            = 5;
    uint256 public constant MIN_MARGIN              = 10e18;
    uint256 public constant PERFORMANCE_FEE_BPS     = 1000;  // 10% of profit on copied positions

    // Liquidator incentive: share of remaining collateral paid to the caller
    uint256 public constant LIQUIDATION_REWARD_BPS  = 500;   // 5% of remaining collateral

    // Owner-adjustable fees (kept as public vars so tests and admin can override)
    uint256 public TRADING_FEE_BPS         = 10;   // 0.1% swap fee (Uniswap concept)
    uint256 public BORROW_FEE_BPS_PER_HOUR = 1;    // 0.01% borrow rate per hour (Aave concept)

    // ── M-3: hard bounds on every owner-adjustable risk knob ──────────────────
    // The setters used to be unbounded, so a compromised (or careless) owner key
    // could set a 1000% trading fee and confiscate every open position's margin
    // on close. These ceilings make that impossible at the bytecode level rather
    // than by policy.
    uint256 public constant MAX_TRADING_FEE_BPS          = 100;    // 1.00% per side
    uint256 public constant MAX_BORROW_FEE_BPS_PER_HOUR  = 10;     // 0.10%/h
    uint256 public constant MAX_MAINTENANCE_MARGIN_BPS   = 9_999;  // must stay < 100%
    uint256 public constant MAX_PRICE_AGE_LIMIT          = 7 days;
    uint256 public constant MAX_EXECUTION_FEE            = 1 ether;
    /// @notice M4: ceiling on the mark-price premium (10% of index). The
    ///         premium moves every position's PnL and liquidation price, so
    ///         an unbounded setter let the owner mark the whole book to an
    ///         arbitrary price; above 10% it stops being a premium at all.
    uint256 public constant MAX_MARK_PREMIUM_CAP_BPS     = 1_000;

    // ── Funding (multi/short imbalance) ──────────────────────────────────────
    // Funding charges the crowded side and pays the other; it is NOT a financing
    // cost of leverage. Borrowing leverage is priced separately by the per-hour
    // BORROW_FEE above (Aave-style). The two are complementary, not double-billing:
    //   • funding   = OI-imbalance rebalancer between longs and shorts (peer-to-peer)
    //   • borrow fee = cost of the protocol-supplied notional on a leveraged position
    //
    // Funding settles every 8h (standard perp cadence; Hyperliquid-class). The cap
    // applies to the most extreme one-sided OI; typical (partial) imbalance is far
    // lower. Economic sanity check at the cap:
    //   max per interval = 0.75%  →  daily = 0.75% × (24h / 8h) = 2.25%/day.
    // (The previous 5-min interval put the same 0.75% cap at 0.75%×288 ≈ 216%/day,
    //  which was economically nonsensical — fixed by the 8h cadence here.)
    uint256 public constant FUNDING_INTERVAL        = 8 hours;
    uint256 public constant MAX_FUNDING_RATE_BPS    = 75;    // 0.75% per 8h at full imbalance

    /// @notice H-2: maximum number of missed intervals a single settlement may
    ///         catch up on. Without it, a market nobody cranked for months
    ///         accrued `intervals × rate` in one shot — the PoC reached 438% of
    ///         notional after 200 idle days, an amount the payer can never post
    ///         and which therefore becomes bad debt the moment it is charged.
    ///         The clock is still advanced past the whole gap, so the skipped
    ///         accrual is forgiven symmetrically for payers and receivers and
    ///         conservation is untouched. 21 × 8h = one week of catch-up, which
    ///         bounds a single settlement at 21 × 0.75% = 15.75% of notional.
    uint256 public constant MAX_FUNDING_CATCHUP_INTERVALS = 21;

    /// @notice H-3: ceiling on how much larger the thin side's per-unit funding
    ///         receipt may be than the crowded side's per-unit charge. Funding
    ///         scales the receiver rate by payerOI/receiverOI to conserve the
    ///         total; with a 10-USDC short facing 1,000,000 of longs that ratio
    ///         was 100,000×, and the exchange had to advance the receipt out of
    ///         its own reserves long before the payers ever closed. Beyond this
    ///         multiple the surplus simply stays with the payers' side of the
    ///         book (the exchange never advances it), which errs toward the pool.
    uint256 public constant MAX_FUNDING_RECEIVE_SCALE = 10;

    // Insurance vault: floor paid to trader when closeAmount < 0
    uint256 public constant BAILOUT_FLOOR_BPS       = 1000;  // 10% of margin

    uint256 public constant DEFAULT_MAINTENANCE_MARGIN_BPS = 500;  // 5% of notional

    /// @notice P1: bounds on the per-asset single-position profit cap
    ///         (`maxProfitBps`, in bps of the position's margin; 0 = off).
    ///         Floor 100% of margin: below that a 5x position would be capped
    ///         at a 20% move, which stops being a risk limit and starts being
    ///         a different product. Ceiling 2,500% of margin, the top of the
    ///         range live perp venues use (Avantis / Veranta: 500%-2,500%);
    ///         above it the cap no longer bounds anything a 5x book can reach
    ///         in practice.
    uint256 public constant MIN_PROFIT_CAP_BPS = 10_000;   // 100% of margin
    uint256 public constant MAX_PROFIT_CAP_BPS = 250_000;  // 2,500% of margin
    uint256 public constant MAX_ADL_SCAN            = 128;   // bound ADL gas

    uint256 public executionFee = 0.001 ether; // Fee paid in native ETH to cover platform/Keeper gas

    /// @notice Max acceptable oracle price age for state-changing operations.
    ///         Views stay lenient so the frontend can still render with stale data.
    uint256 public maxPriceAge = 24 hours;

    /// @notice Mark-price premium cap, in bps of the index (oracle) price. The
    ///         mark price = index ± a premium driven by OI imbalance, bounded by
    ///         this cap. PnL and liquidation are valued on the mark; entry stays
    ///         on the index. 0 = disabled (mark == index), which is the legacy
    ///         behaviour, so existing markets are untouched until the owner sets
    ///         a non-zero cap.
    uint256 public markPremiumCapBps = 0;

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    IOracle public immutable oracle;

    /// @notice Optional. address(0) means carbon pricing is not active on this
    ///         deployment AT ALL — every asset uses the legacy global
    ///         TRADING_FEE_BPS / BORROW_FEE_BPS_PER_HOUR / MAX_LEVERAGE exactly
    ///         as before this feature existed. This is an all-or-nothing
    ///         deployment switch, the same optional-wiring convention `kyc`
    ///         already uses below — it is NOT a per-asset or per-user carve-out.
    ///         Once wired, an asset with no attestation in the registry still
    ///         falls to the most conservative tier via CarbonTiers itself
    ///         (Tier.Unrated), so there is no unpriced gap once the switch is on.
    IEsgRegistryForPricing public immutable esgRegistry;

    // ── Data types ───────────────────────────────────────────────────────────

    struct Position {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;        // 18 decimals
        uint256 margin;            // 18 decimals (USDC)
        uint256 leverage;          // 1, 2, or 5
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
        address copiedFrom;        // address(0) for self-opened positions
        int256  entryFundingIndex; // locked per-side cumulative funding index at open
        // ── Appended, not inserted ──────────────────────────────────────────
        // Existing external readers (PepeIncentives.IPerpExchange.Position,
        // EsgRewardDistributor.IExchangeForReward.Position) redeclare this
        // struct with only the 13 original fields, to decode getPosition()'s
        // return data. Appending fields at the end keeps their positional ABI
        // decode correct — inserting anywhere earlier would silently shift
        // every field after it and corrupt what those two contracts read.
        // Empirically checked (not just reasoned about): a caller declaring
        // only the old 13-field struct against this contract's real ABI still
        // decodes every original field correctly once the tuple grows.
        //
        // Frozen at open time, never re-derived on close/liquidation — see
        // ADR-003: a later change to an asset's carbon rating must not
        // retroactively change what an already-open position costs.
        //
        // Both fee fields are kept as real, independent numbers rather than
        // recomputed from `carbonTier` on read — that recomputation (via the
        // inlined, free `CarbonTiers.paramsFor`) is only valid once carbon
        // pricing is actually active. In the legacy/no-registry deployment
        // mode (`esgRegistry == address(0)`), the fee is the operator's own
        // independently-configurable global rate at the moment this position
        // opened, which has no relationship to CarbonTiers' fixed tier table
        // at all — `carbonTier` alone cannot reconstruct it. `uint16` is a
        // deliberate width, not a default: both fields are bounded by
        // MAX_TRADING_FEE_BPS (100) / MAX_BORROW_FEE_BPS_PER_HOUR (10), which
        // can only change via a full redeploy (they're constants), so
        // `uint16` has headroom to spare for the life of this contract, and
        // packs both fields plus `carbonTier` into a single new storage slot
        // instead of three.
        uint16 tradingFeeBps;
        uint16 borrowFeeBpsPerHour;
        CarbonTiers.Tier carbonTier; // observability only — never branched on
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => Position)      public positions;
    /// @notice OPEN positions of a user. Closed ids are swap-and-popped out (C-3),
    ///         so this list is bounded by the margin an account actually has
    ///         locked. Historical (closed) positions are recoverable from the
    ///         PositionOpened / PositionClosed event stream.
    mapping(address => uint256[])     public userPositions;
    mapping(address => uint256)       public freeMargin;

    /// @dev C-3 / H-1: 1-based index of a position inside `userPositions[owner]`
    ///      and `assetPositionIds[asset]`. 0 means "not in the list". Kept in
    ///      sync by the swap-and-pop removers below.
    mapping(uint256 => uint256)       private _userPosIndex;
    mapping(uint256 => uint256)       private _assetPosIndex;

    /// @notice H-6: the agent that opened a position through `openPositionFor`
    ///         (address(0) for self-opened positions). `closePositionFor` only
    ///         honours a request from THIS agent, so an authorized agent can
    ///         never reach a position it did not create.
    mapping(uint256 => address)       public positionAgent;

    // Global Open Interest (OI) for Funding Rate calculations
    mapping(bytes32 => uint256)       public globalLongNotional;
    mapping(bytes32 => uint256)       public globalShortNotional;

    // Funding rate state — conservative (peer-to-peer) model.
    //
    // Funding is a strict transfer between longs and shorts: every interval the
    // crowded side PAYS and the other side RECEIVES the *same total* amount, so
    // funding never mints/burns value against the pool (Σ longs pay == Σ shorts
    // receive, modulo wei-level rounding that favours the pool). To keep both
    // legs settling lazily via the cumulative-index trick we track a SEPARATE
    // per-unit-notional index for each side; a position locks its own side's
    // index at open and pays/receives the delta on close. The receiver side's
    // per-unit rate is scaled by (payerOI / receiverOI) so the totals match.
    // If either side has zero OI there is no counterparty → no funding accrues.
    mapping(bytes32 => int256)        public cumulativeFundingIndexLong;   // 18-dec, signed
    mapping(bytes32 => int256)        public cumulativeFundingIndexShort;  // 18-dec, signed
    mapping(bytes32 => uint256)       public lastFundingUpdateAt;

    uint256                           public nextPositionId;
    address                           public copyTracker;
    // Multi-agent authorization. copyTracker remains the "primary" agent for
    // backward compatibility; setCopyTracker keeps this mapping in sync, and
    // setAgentAuthorized lets the owner authorize additional agents.
    mapping(address => bool)          public authorizedAgents;
    IFeeRouterPerp                    public feeRouter;
    IInsuranceVaultPerp               public insuranceVault;

    // RWA compliance gating. Assets flagged `rwaAsset` require the opener to be
    // KYC-verified when a `kyc` registry is configured. Both default off, so
    // pure-crypto markets and all pre-existing behaviour are unaffected.
    IKyc                              public kyc;
    mapping(bytes32 => bool)          public rwaAsset;

    // N1: share of the collected trading fee routed to the InsuranceVault (LP
    // yield). 0 = keep current behaviour (no routing). cumulativeVaultFees lets
    // the frontend estimate LP APR from the realized fee stream.
    uint256                           public vaultFeeShareBps;   // 0..10000
    uint256                           public cumulativeVaultFees;

    // N3: per-asset risk overrides. 0 means "use the global default", so every
    // asset behaves exactly as before until an override is set.
    mapping(bytes32 => uint256)       public maxLeverageOf;            // 0 → MAX_LEVERAGE
    mapping(bytes32 => uint256)       public maintenanceMarginBpsOf;   // 0 → DEFAULT_MAINTENANCE_MARGIN_BPS

    // N2: auto-deleveraging (ADL) solvency backstop. Off by default so existing
    // liquidation behaviour is untouched until explicitly enabled.
    bool                              public adlEnabled;
    mapping(bytes32 => uint256[])     public assetPositionIds;        // per-asset index for ADL scan

    // P3-2: portfolio (cross) margin. Off by default → per-position isolated
    // liquidation (legacy). When on, a leg is liquidatable only if it is
    // individually underwater AND the whole account is underwater, so offsetting
    // winners protect a losing leg from being wrongly liquidated.
    bool                              public portfolioMarginEnabled;

    /// @notice M-2: share (bps) of a liquidated position's REMAINING collateral
    ///         that is confiscated to the InsuranceVault as the liquidation
    ///         penalty. The liquidator reward comes out first; whatever is left
    ///         after reward + penalty is returned to the position owner instead
    ///         of being swept wholesale. Liquidation triggers at or below the
    ///         maintenance margin, so the residual is at most the maintenance
    ///         buffer — money the trader posted precisely to absorb this event.
    uint256 public liquidationPenaltyBps = 2_000; // 20% of remaining collateral

    // ── P1: emergency controls ───────────────────────────────────────────────
    //
    // Two independent brakes, modelled on SEAL's guardian pattern and on the
    // halt / reduce-only market states of Hyperliquid HIP-3 and Orderly:
    //
    //  1. A GLOBAL pause (OpenZeppelin `Pausable`). `pause()` may be called by
    //     the guardian or the owner; `unpause()` only by the owner. While paused
    //     every function that moves value or changes a position reverts —
    //     including deposits and withdrawals. See `pause()` for the rationale.
    //
    //  2. A PER-ASSET mode (`assetMode`):
    //       Active     — everything allowed (default for every asset).
    //       ReduceOnly — no new exposure: every open path (direct, agent,
    //                    copy) reverts; closes and liquidations still run.
    //                    This is the market-closed state for RWA/equity
    //                    feeds: keepers keep refreshing the timestamp at the
    //                    closing price, so exits settle at the close.
    //       Halted     — the market is frozen: opens, closes, liquidations and
    //                    funding settlement on this asset all revert.
    //
    // Who may change a mode (see `setAssetMode`):
    //   owner          — any transition.
    //   guardian       — tighten only (Active -> ReduceOnly -> Halted).
    //   marketOperator — Active <-> ReduceOnly only; never sets or lifts Halted.
    //
    // Neither brake relaxes the oracle freshness checks; they are additive.

    /// @notice Trading state of a single asset. The numeric order is the
    ///         strictness order — a guardian may only move an asset upward.
    enum AssetMode { Active, ReduceOnly, Halted }

    /// @notice Emergency responder. May `pause()` and may tighten any asset's
    ///         mode, but can never unpause, loosen a mode, move funds or change
    ///         a risk parameter. address(0) = no guardian configured.
    address public guardian;

    /// @notice Day-to-day market operator (e.g. session open/close for RWA
    ///         feeds). May only toggle an asset between Active and ReduceOnly.
    ///         address(0) = no operator configured.
    address public marketOperator;

    /// @notice Per-asset trading mode. Defaults to Active (enum value 0), so
    ///         every existing market behaves exactly as before this feature.
    mapping(bytes32 => AssetMode) public assetMode;

    // ── P1: open-interest and profit caps ────────────────────────────────────
    //
    // Together these bound the exchange's worst-case liability to the open
    // book, which is what a pool-backed venue has to size its reserves
    // against (GMX v2 reserve factor / max OI; Avantis & Veranta max profit):
    //   Σ_open profit cap = Σ margin × maxProfitBps ≤ (longOI + shortOI) × maxProfitBps
    //                     ≤ (maxLongOI + maxShortOI) × maxProfitBps
    // (margin ≤ notional because leverage ≥ 1). All default to 0 = off.

    /// @notice Per-asset ceiling on long / short open interest, in 18-decimal
    ///         USDC notional (margin × leverage at open — the same unit as
    ///         `globalLongNotional` / `globalShortNotional`). 0 = unlimited.
    mapping(bytes32 => uint256) public maxLongOI;
    mapping(bytes32 => uint256) public maxShortOI;

    /// @notice Per-asset maximum profit a single position may realize, in bps
    ///         of its margin (e.g. 50_000 = 5x margin). 0 = no cap.
    mapping(bytes32 => uint256) public maxProfitBps;

    /// @notice Absolute profit cap (18-dec USDC) frozen into each position at
    ///         open from `maxProfitBps`; 0 = uncapped. Frozen for the same
    ///         reason fees are (ADR-003): a later owner change must never
    ///         retroactively cut what an already-open position can realize.
    ///         An asset whose risk has changed is handled prospectively
    ///         (lower the cap, tighten OI, or set ReduceOnly), not by
    ///         clawing back open winners.
    mapping(uint256 => uint256) public profitCapOf;

    // ── Events ───────────────────────────────────────────────────────────────

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bytes32 indexed asset,
        bool    isLong,
        uint256 entryPrice,
        uint256 margin,
        uint256 leverage
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        int256  pnl,
        uint256 closeAmount
    );
    event MarginDeposited(address indexed user, uint256 amount);
    event MarginWithdrawn(address indexed user, uint256 amount);
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed owner,
        address indexed liquidator,
        int256  pnl
    );
    event PerformanceFeePaid(
        uint256 indexed positionId,
        address indexed copiedFrom,
        uint256 fee
    );
    event FundingSettled(
        bytes32 indexed asset,
        int256  rateBps,
        int256  longIndex,
        int256  shortIndex
    );
    event AgentAuthorizationSet(address indexed agent, bool authorized);
    event KycRegistrySet(address indexed kyc);
    event RwaAssetSet(bytes32 indexed asset, bool isRwa);
    event MarkPremiumCapBpsSet(uint256 bps);
    event VaultFeeShareSet(uint256 bps);
    event VaultFeeRouted(uint256 amount, uint256 cumulative);
    event MaxLeverageSet(bytes32 indexed asset, uint256 maxLeverage);
    event MaintenanceMarginSet(bytes32 indexed asset, uint256 bps);
    event AdlEnabledSet(bool enabled);
    event PortfolioMarginEnabledSet(bool enabled);
    event AutoDeleveraged(
        uint256 indexed liquidatedId,
        uint256 indexed counterId,
        uint256         haircut,
        uint256         payout
    );

    // M-3: every admin setter is now observable.
    event FeeRouterSet(address indexed feeRouter);
    event InsuranceVaultSet(address indexed vault);
    event CopyTrackerSet(address indexed copyTracker);
    event ExecutionFeeSet(uint256 fee);
    event TradingFeeBpsSet(uint256 bps);
    event BorrowFeeBpsPerHourSet(uint256 bps);
    event MaxPriceAgeSet(uint256 secs);
    event LiquidationPenaltyBpsSet(uint256 bps);

    /// @notice C-2 / Low: bad debt that neither the closing position's collateral
    ///         nor the InsuranceVault nor ADL could cover. Previously silent.
    event BadDebt(uint256 indexed positionId, bytes32 indexed asset, uint256 amount);
    /// @notice H-2: emitted when a settlement had to skip un-accrued intervals.
    event FundingCatchupClamped(bytes32 indexed asset, uint256 elapsed, uint256 accrued);

    // P1: emergency controls.
    event GuardianSet(address indexed guardian);
    event MarketOperatorSet(address indexed marketOperator);
    event AssetModeSet(bytes32 indexed asset, AssetMode mode, address indexed by);

    // P1: risk caps.
    event MaxOpenInterestSet(bytes32 indexed asset, uint256 maxLong, uint256 maxShort);
    event MaxProfitBpsSet(bytes32 indexed asset, uint256 bps);
    /// @notice A settlement (close, liquidation or ADL) paid `paidPnl` instead
    ///         of the position's mark-to-market `rawPnl` because of its cap.
    event ProfitCapped(uint256 indexed positionId, int256 rawPnl, int256 paidPnl);
    /// @notice H3: in portfolio mode, part of a position's shortfall was paid
    ///         out of its owner's free margin before any pool backstop.
    event ShortfallChargedToAccount(uint256 indexed positionId, address indexed owner, uint256 amount);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotCopyTracker();
    error CopyTrackerNotSet();
    error InsufficientFreeMargin();
    error MarginTooLow();
    error InvalidLeverage();
    error NotPositionOwner();
    error PositionAlreadyClosed();
    error PositionIsHealthy();
    error FundingIntervalNotElapsed();
    error StalePrice(bytes32 asset, uint256 updatedAt);
    error InvalidPrice(bytes32 asset);
    error NotKycVerified(address user);
    /// @notice H-6: caller is an authorized agent, but not the agent that opened
    ///         this particular position.
    error NotPositionAgent(uint256 positionId, address caller);
    error InvalidParam();
    /// @notice P1: caller is neither the guardian nor the owner.
    error NotGuardianOrOwner(address caller);
    /// @notice P1: `caller` may not move `asset` from `current` to `requested`
    ///         (see `setAssetMode` for the permission matrix).
    error AssetModeChangeNotAllowed(bytes32 asset, AssetMode current, AssetMode requested, address caller);
    /// @notice P1: opening new exposure requires the asset to be Active.
    error AssetNotActive(bytes32 asset, AssetMode mode);
    /// @notice P1: the asset is Halted — no open, close, liquidation or funding.
    error AssetHalted(bytes32 asset);
    /// @notice P1: opening would lift this side's open interest above its cap.
    error OpenInterestCapExceeded(bytes32 asset, bool isLong, uint256 resultingOI, uint256 cap);
    /// @notice H3: portfolio mode — the withdrawal would leave the account
    ///         below its maintenance requirement.
    error AccountUnhealthy(address owner, int256 equity, uint256 maintenance);
    /// @notice M1: only the CopyTracker may attribute a position to a leader
    ///         (`copiedFrom`), because that address is paid a performance fee.
    error CopiedFromNotAllowed(address caller);

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @param _esgRegistry Optional — address(0) disables carbon pricing for
    ///        this whole deployment (see the field's own NatSpec above). Unlike
    ///        `_usdc`/`_oracle` it is never validated against address(0),
    ///        because address(0) is its intended "not active" state, not an
    ///        error.
    constructor(address _usdc, address _oracle, address _esgRegistry) Ownable(msg.sender) {
        if (_usdc == address(0) || _oracle == address(0)) revert InvalidParam();
        // Low: MIN_MARGIN (10e18) and the `rawPrice * 1e10` index scaling both
        // hard-code an 18-decimal collateral token, while `usdc` is immutable —
        // wiring a 6-decimal USDC would silently mis-scale every position and
        // could never be corrected. Checked softly (try/catch) because minimal
        // test doubles legitimately omit IERC20Metadata.
        try IERC20Metadata(_usdc).decimals() returns (uint8 d) {
            if (d != 18) revert InvalidParam();
        } catch {}
        usdc        = IERC20(_usdc);
        oracle      = IOracle(_oracle);
        esgRegistry = IEsgRegistryForPricing(_esgRegistry);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Sets the primary copyTracker. Keeps `authorizedAgents` in sync:
    ///         the previous primary is de-authorized and the new one authorized,
    ///         preserving the legacy single-tracker swap semantics.
    function setCopyTracker(address _copyTracker) external onlyOwner {
        address old = copyTracker;
        if (old != address(0) && old != _copyTracker) {
            authorizedAgents[old] = false;
            emit AgentAuthorizationSet(old, false);
        }
        copyTracker = _copyTracker;
        if (_copyTracker != address(0)) {
            authorizedAgents[_copyTracker] = true;
            emit AgentAuthorizationSet(_copyTracker, true);
        }
        emit CopyTrackerSet(_copyTracker);
    }

    /// @notice Authorize or revoke an additional agent (beyond the primary
    ///         copyTracker) to call the `*For` proxy entrypoints.
    function setAgentAuthorized(address agent, bool authorized) external onlyOwner {
        authorizedAgents[agent] = authorized;
        emit AgentAuthorizationSet(agent, authorized);
    }

    /// @notice M-3: `address(0)` is accepted and means "disable performance-fee
    ///         routing" — the close path already branches on it — but the change
    ///         is now emitted so it can never happen unobserved.
    function setFeeRouter(address _feeRouter) external onlyOwner {
        feeRouter = IFeeRouterPerp(_feeRouter);
        emit FeeRouterSet(_feeRouter);
    }

    function setExecutionFee(uint256 _fee) external onlyOwner {
        require(_fee <= MAX_EXECUTION_FEE, "fee>1 ether");
        executionFee = _fee;
        emit ExecutionFeeSet(_fee);
    }

    /// @notice M-3: bounded at 1% per side. The old setter was unbounded, so
    ///         `setTradingFeeBps(100000)` would have swallowed every open
    ///         position's entire margin at close time.
    /// @dev Legacy/no-registry lever only. Once `esgRegistry` is wired
    ///      (carbon pricing active — see that field's NatSpec), every
    ///      position's fee is frozen at open from `CarbonTiers` instead, and
    ///      this setter's new value has NO EFFECT on any position's actual
    ///      cost, existing or future, on any asset. It still succeeds and
    ///      still emits `TradingFeeBpsSet` — code review flagged this as a
    ///      real risk of a runbook or dashboard assuming this call changed
    ///      something it did not, on a carbon-active deployment.
    ///
    ///      Even on a legacy (no-registry) deployment, calling this after a
    ///      position is already open does not change that position's fee —
    ///      every position's rate is frozen at its own open time now, in
    ///      both modes, not read live off this variable at close/liquidation
    ///      the way it was before carbon pricing existed. This is a
    ///      deliberate side effect (a predictable, non-retroactive cost is
    ///      the same principle ADR-003 argues for carbon ratings), not a
    ///      preserved byte-for-byte legacy behaviour — flagged here because
    ///      code review found no test exercising "change this mid-lifecycle,
    ///      then close" to catch the difference on its own.
    function setTradingFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_TRADING_FEE_BPS, "fee>1%");
        TRADING_FEE_BPS = _bps;
        emit TradingFeeBpsSet(_bps);
    }

    /// @notice M-3: bounded at 0.10%/hour (~876%/yr) — an absolute ceiling, not
    ///         a target. Previously unbounded and applied to elapsed hours, so
    ///         it was an even more direct confiscation lever than the trade fee.
    /// @dev Legacy/no-registry lever only — see `setTradingFeeBps`'s NatSpec:
    ///      the exact same caveat applies here once `esgRegistry` is wired.
    function setBorrowFeePerHour(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_BORROW_FEE_BPS_PER_HOUR, "borrow fee too high");
        BORROW_FEE_BPS_PER_HOUR = _bps;
        emit BorrowFeeBpsPerHourSet(_bps);
    }

    /// @notice M-3: `address(0)` disables bailout/ADL vault interaction, which is
    ///         a supported configuration; the change is emitted either way.
    function setInsuranceVault(address _vault) external onlyOwner {
        insuranceVault = IInsuranceVaultPerp(_vault);
        emit InsuranceVaultSet(_vault);
    }

    /// @notice M-2: share of a liquidated position's remaining collateral kept as
    ///         the protocol penalty. Bounded so reward + penalty can never exceed
    ///         the collateral itself.
    function setLiquidationPenaltyBps(uint256 _bps) external onlyOwner {
        require(_bps + LIQUIDATION_REWARD_BPS <= 10_000, "penalty+reward>100%");
        liquidationPenaltyBps = _bps;
        emit LiquidationPenaltyBpsSet(_bps);
    }

    /// @notice Set (or clear with address(0)) the KYC registry used to gate RWA
    ///         markets. While unset, RWA flags impose no restriction — preserving
    ///         backward compatibility for pure-crypto deployments.
    function setKycRegistry(address _kyc) external onlyOwner {
        kyc = IKyc(_kyc);
        emit KycRegistrySet(_kyc);
    }

    /// @notice Flag an asset as a real-world asset (or clear the flag). Config
    ///         only — RWA markets require KYC at open time once `kyc` is set.
    function setRwaAsset(bytes32 asset, bool isRwa) external onlyOwner {
        rwaAsset[asset] = isRwa;
        emit RwaAssetSet(asset, isRwa);
    }

    /// @notice N1: set the share (bps) of the trading fee routed to the LP vault.
    ///         0 keeps the current behaviour (no routing).
    function setVaultFeeShareBps(uint256 _bps) external onlyOwner {
        require(_bps <= 10_000, "bps>100%");
        vaultFeeShareBps = _bps;
        emit VaultFeeShareSet(_bps);
    }

    /// @notice N3: per-asset max leverage override (0 = use global MAX_LEVERAGE).
    /// @dev This bound is checked only against the global ceiling, not
    ///      against the asset's own carbon-tier ceiling. `_effectiveMaxLeverage`
    ///      still takes `min(this override, carbon cap)`, so setting a value
    ///      here above what the asset's current tier permits succeeds, emits
    ///      `MaxLeverageSet`, and reads back as the value passed — but has NO
    ///      EFFECT on the leverage any position on that asset can actually
    ///      use until the tier itself improves. `maxLeverageForAsset` returns
    ///      the real, carbon-aware effective value; this function's own
    ///      getter-equivalent (`maxLeverageOf`) does not.
    function setMaxLeverageFor(bytes32 asset, uint256 maxLev) external onlyOwner {
        require(maxLev <= MAX_LEVERAGE, "above global cap");
        maxLeverageOf[asset] = maxLev;
        emit MaxLeverageSet(asset, maxLev);
    }

    /// @notice N3: per-asset maintenance-margin override in bps (0 = use the
    ///         global DEFAULT_MAINTENANCE_MARGIN_BPS).
    ///         M-3: strictly below 100% — a maintenance requirement of exactly
    ///         the full notional makes every position instantly liquidatable.
    function setMaintenanceMarginFor(bytes32 asset, uint256 bps) external onlyOwner {
        require(bps <= MAX_MAINTENANCE_MARGIN_BPS, "bps>=100%");
        maintenanceMarginBpsOf[asset] = bps;
        emit MaintenanceMarginSet(asset, bps);
    }

    /// @notice N2: enable/disable the ADL solvency backstop. Off by default.
    function setAdlEnabled(bool enabled) external onlyOwner {
        adlEnabled = enabled;
        emit AdlEnabledSet(enabled);
    }

    /// @notice P3-2: enable/disable account-level (portfolio) margin. Off by
    ///         default → legacy per-position isolated liquidation.
    function setPortfolioMarginEnabled(bool enabled) external onlyOwner {
        portfolioMarginEnabled = enabled;
        emit PortfolioMarginEnabledSet(enabled);
    }

    /// @notice M-3: bounded on BOTH sides. The old setter only rejected 0, so an
    ///         owner could set `type(uint256).max` and disable staleness entirely
    ///         while the getter still looked configured.
    function setMaxPriceAge(uint256 _seconds) external onlyOwner {
        require(_seconds > 0, "zero age");
        require(_seconds <= MAX_PRICE_AGE_LIMIT, "age>7d");
        maxPriceAge = _seconds;
        emit MaxPriceAgeSet(_seconds);
    }

    /// @notice Set the mark-price premium cap (bps of index). 0 disables the
    ///         premium so mark == index (legacy pricing).
    /// @dev M4: bounded by MAX_MARK_PREMIUM_CAP_BPS, like every other risk knob
    ///      (M-3). An unbounded value let the owner push the mark far from the
    ///      index and liquidate or enrich one side of the book at will.
    function setMarkPremiumCapBps(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_MARK_PREMIUM_CAP_BPS, "premium cap>10%");
        markPremiumCapBps = _bps;
        emit MarkPremiumCapBpsSet(_bps);
    }

    // ── P1: emergency controls ───────────────────────────────────────────────

    /// @notice Set (or clear with address(0)) the guardian.
    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    /// @notice Set (or clear with address(0)) the market operator.
    function setMarketOperator(address _marketOperator) external onlyOwner {
        marketOperator = _marketOperator;
        emit MarketOperatorSet(_marketOperator);
    }

    /// @notice Stop every value-moving and position-changing function at once.
    /// @dev Callable by the guardian or the owner. The brake is deliberately
    ///      total — it also blocks `depositMargin`, `withdrawMargin`, closes and
    ///      liquidations — because it exists for the case where something is
    ///      wrong and nobody yet knows what. Under an unknown bug any function
    ///      that moves USDC may be the extraction route (a withdrawal that skips
    ///      a health check, a close that mis-prices PnL, a liquidation that
    ///      mis-pays), so letting "only the safe ones" keep running presumes a
    ///      diagnosis that has not happened yet. Stopping everything first and
    ///      re-opening deliberately is the conservative order.
    ///
    ///      The cost is accepted knowingly: while paused, traders cannot exit
    ///      and underwater positions cannot be liquidated. Funding keeps being
    ///      measured in wall-clock time and is caught up (bounded by
    ///      MAX_FUNDING_CATCHUP_INTERVALS) on the first settlement after
    ///      unpause; a per-asset Halt is the tool when funding must freeze.
    ///
    ///      Owner-only parameter setters and every view keep working, so the
    ///      owner can repair configuration while the market is stopped.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner(msg.sender);
        _pause();
    }

    /// @notice Resume trading. Owner only: the guardian can stop the system but
    ///         never restart it, so a compromised guardian key can at worst
    ///         cause downtime — never re-open a market the owner has frozen.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Change `asset`'s trading mode.
    /// @dev Permission matrix (`current` -> `mode`):
    ///        owner          — any transition, including lifting a Halt.
    ///        guardian       — strictly tighter only (mode > current).
    ///        marketOperator — only while neither side is Halted, i.e.
    ///                         Active <-> ReduceOnly (idempotent sets allowed).
    ///      An address holding several roles gets the union of their rights.
    ///      Allowed while paused, so the guardian can pre-position halts.
    ///
    ///      Funding while Halted: entering Halted first settles funding up to
    ///      now; leaving Halted restarts the funding clock at the current time.
    ///      The halted period therefore accrues no funding for either side —
    ///      nobody can act on the market, so nobody should be charged for
    ///      holding it. The forgiveness is symmetric (neither side's index
    ///      moves), so the long/short conservation identity is untouched,
    ///      exactly like the H-2 catch-up clamp.
    function setAssetMode(bytes32 asset, AssetMode mode) external {
        AssetMode current = assetMode[asset];
        if (!_canSetAssetMode(msg.sender, current, mode)) {
            revert AssetModeChangeNotAllowed(asset, current, mode, msg.sender);
        }

        if (mode == AssetMode.Halted && current != AssetMode.Halted) {
            _pokeFunding(asset);
        } else if (current == AssetMode.Halted && mode != AssetMode.Halted) {
            if (lastFundingUpdateAt[asset] != 0) lastFundingUpdateAt[asset] = block.timestamp;
        }

        assetMode[asset] = mode;
        emit AssetModeSet(asset, mode, msg.sender);
    }

    function _canSetAssetMode(address caller, AssetMode current, AssetMode next)
        internal
        view
        returns (bool)
    {
        if (caller == owner()) return true;
        if (caller == guardian && uint8(next) > uint8(current)) return true;
        if (
            caller == marketOperator
                && current != AssetMode.Halted
                && next != AssetMode.Halted
        ) return true;
        return false;
    }

    /// @dev New exposure (every open path) requires Active.
    function _requireActive(bytes32 asset) internal view {
        AssetMode m = assetMode[asset];
        if (m != AssetMode.Active) revert AssetNotActive(asset, m);
    }

    /// @dev Reducing exposure (close, liquidation and the ADL it triggers) and
    ///      funding settlement run in Active and ReduceOnly; Halted refuses.
    function _requireNotHalted(bytes32 asset) internal view {
        if (assetMode[asset] == AssetMode.Halted) revert AssetHalted(asset);
    }

    /// @notice P1: per-side open-interest ceilings for `asset` (18-dec USDC
    ///         notional; 0 = unlimited). Lowering a cap below the current OI
    ///         is allowed: nothing is force-closed, new opens on that side are
    ///         simply refused until OI falls back under the cap.
    function setMaxOpenInterest(bytes32 asset, uint256 maxLong, uint256 maxShort) external onlyOwner {
        maxLongOI[asset]  = maxLong;
        maxShortOI[asset] = maxShort;
        emit MaxOpenInterestSet(asset, maxLong, maxShort);
    }

    /// @notice P1: single-position profit cap for `asset`, in bps of margin.
    ///         0 disables; otherwise within [MIN_PROFIT_CAP_BPS,
    ///         MAX_PROFIT_CAP_BPS]. Applies to positions opened afterwards
    ///         only — see `profitCapOf`.
    function setMaxProfitBps(bytes32 asset, uint256 bps) external onlyOwner {
        require(
            bps == 0 || (bps >= MIN_PROFIT_CAP_BPS && bps <= MAX_PROFIT_CAP_BPS),
            "profit cap out of range"
        );
        maxProfitBps[asset] = bps;
        emit MaxProfitBpsSet(asset, bps);
    }

    function withdrawExecutionFees() external onlyOwner whenNotPaused nonReentrant {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    // ── Margin management ────────────────────────────────────────────────────

    function depositMargin(uint256 amount) external whenNotPaused nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        freeMargin[msg.sender] += amount;
        emit MarginDeposited(msg.sender, amount);
    }

    /// @dev CopyTracker pulls USDC from itself, credits freeMargin to `user`.
    function depositMarginFor(address user, uint256 amount) external whenNotPaused nonReentrant {
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        freeMargin[user] += amount;
        emit MarginDeposited(user, amount);
    }

    /// @dev H3: in portfolio mode free margin is collateral — `_accountState`
    ///      counts it as equity and it is what keeps an underwater leg from
    ///      being liquidated. Withdrawing it used to be unchecked, so an account
    ///      could let free margin shield a losing leg and then walk away with
    ///      it, leaving the loss to the pool. A withdrawal must now leave the
    ///      account at or above maintenance, valued on fresh prices. Isolated
    ///      mode is unchanged: there free margin backs nothing.
    function withdrawMargin(uint256 amount) external whenNotPaused nonReentrant {
        if (freeMargin[msg.sender] < amount) revert InsufficientFreeMargin();
        freeMargin[msg.sender] -= amount;
        if (portfolioMarginEnabled) _requireHealthyAccount(msg.sender);
        usdc.safeTransfer(msg.sender, amount);
        emit MarginWithdrawn(msg.sender, amount);
    }

    // ── Position lifecycle ───────────────────────────────────────────────────

    function openPosition(
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage
    ) external payable whenNotPaused nonReentrant returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        positionId = _openPosition(msg.sender, asset, isLong, margin, leverage, address(0), address(0));
        // Low: refund execution-fee overpayment instead of silently keeping it.
        _refundExcessFee();
    }

    function openPositionFor(
        address user,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) external payable whenNotPaused nonReentrant returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        if (copyTracker == address(0)) revert CopyTrackerNotSet();
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        // M1: `copiedFrom` is paid PERFORMANCE_FEE_BPS of the position's
        // profit on close. Any other authorized agent (AgentSessionManager
        // forwards it straight from the session agent) could name itself and
        // skim 10% of its principal's winnings. Only the CopyTracker, which
        // sets it from the followed trader's published strategy, may attribute.
        if (copiedFrom != address(0) && msg.sender != copyTracker) revert CopiedFromNotAllowed(msg.sender);
        positionId = _openPosition(user, asset, isLong, margin, leverage, copiedFrom, msg.sender);
        _refundExcessFee();
    }

    function closePosition(uint256 positionId) external whenNotPaused nonReentrant {
        _closePosition(msg.sender, positionId);
    }

    /// @notice Lets an agent close a position it opened on the owner's behalf.
    /// @dev H-6: `owner` used to be a free parameter, so ANY address in
    ///      `authorizedAgents` could force-close ANY user's position — including
    ///      positions the user opened themselves and positions belonging to a
    ///      different agent's customers. The exchange had no way to check the
    ///      claim, because nothing on-chain recorded who an agent represents.
    ///
    ///      The minimal verifiable fix is to bind the representation at the only
    ///      moment where it IS provable: `openPositionFor` is already gated on
    ///      the owner's own funds (`freeMargin[owner]`), so the agent that opened
    ///      a position is recorded in `positionAgent[id]` and is the only agent
    ///      that may later close it. That is exactly the two legitimate flows —
    ///      CopyTracker closing the positions it created in `followTrader`, and
    ///      AgentSessionManager closing the positions it created in a session —
    ///      with no new user-facing approval state to manage or revoke, and it
    ///      revokes automatically when the owner's agent authorization is pulled.
    function closePositionFor(address owner, uint256 positionId) external whenNotPaused nonReentrant {
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        if (positionAgent[positionId] != msg.sender) {
            revert NotPositionAgent(positionId, msg.sender);
        }
        _closePosition(owner, positionId);
    }

    /// @dev Returns any execution fee paid above the current `executionFee`.
    ///      Best-effort: a caller that cannot receive ETH (e.g. a contract with
    ///      no receive function) simply leaves the overpayment in the exchange's
    ///      execution-fee balance, exactly as before this fix — refusing the
    ///      trade over a refund would be worse than keeping the dust.
    function _refundExcessFee() internal {
        uint256 excess = msg.value - executionFee;
        if (excess == 0) return;
        (bool ok, ) = msg.sender.call{value: excess}("");
        ok; // intentionally ignored — see above
    }

    // ── Liquidation Engine ───────────────────────────────────────────────────

    /// @notice Anyone can call this to liquidate an underwater position and protect the protocol.
    /// @dev If (margin + PnL - fees) < Maintenance Margin (5% of notional), the position is liquidated.
    ///      The caller earns LIQUIDATION_REWARD_BPS of the remaining collateral as incentive.
    function liquidatePosition(uint256 positionId) external whenNotPaused nonReentrant {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) revert PositionAlreadyClosed();
        // P1: allowed in Active and ReduceOnly (a closed market must still be
        // able to liquidate at the closing price); refused when Halted. ADL
        // only ever runs inside this call or `_closePosition` and only touches
        // positions of the same asset, so this gate covers it too.
        _requireNotHalted(pos.asset);

        _pokeFunding(pos.asset);
        _requireFresh(pos.asset);

        int256 pnl = _settlementPnL(pos);
        
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * uint256(pos.tradingFeeBps) / 10000; // frozen at open — see Position.tradingFeeBps
        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * uint256(pos.borrowFeeBpsPerHour) * hoursElapsed / 10000; // frozen at open
        
        int256 totalFees      = int256(tradingFee + borrowFee);
        int256 fundingPayment = _calcFunding(pos);
        int256 closeAmount    = int256(pos.margin) + pnl - totalFees - fundingPayment;

        // Maintenance margin: per-asset override (N3) or global 5% default.
        uint256 maintenanceMargin = notional * _maintenanceMarginBps(pos.asset) / 10000;

        // Liquidation gate. Isolated (default): this position must be below its
        // own maintenance margin. Portfolio (P3-2): that AND the whole account
        // must be underwater, so offsetting winners protect a losing leg and a
        // winning leg cannot be griefed. Only the GATE differs — settlement below
        // is the same per-position, conservation-proven path in both modes.
        if (portfolioMarginEnabled) {
            (int256 eq, uint256 mm) = _accountState(pos.owner);
            // Test this leg on the SAME fee-excluded basis as account equity
            // (legEquity = margin + pnl − funding = closeAmount + fees), so the
            // invariant "account underwater ⟹ some leg is liquidatable" always
            // holds and accounts can never get stuck under maintenance.
            int256 legEquity = closeAmount + totalFees;
            if (!(legEquity <= int256(maintenanceMargin) && eq < int256(mm))) {
                revert PositionIsHealthy();
            }
        } else if (closeAmount > int256(maintenanceMargin)) {
            revert PositionIsHealthy();
        }

        // ── Effects ────────────────────────────────────────────────────────────
        pos.isOpen      = false;
        pos.closedAt    = block.timestamp;
        pos.realizedPnL = pnl;

        if (pos.isLong) {
            globalLongNotional[pos.asset]  -= notional;
        } else {
            globalShortNotional[pos.asset] -= notional;
        }
        // C-3 / H-1: drop the id from the owner's list now. The per-asset ADL
        // index is compacted AFTER _autoDeleverage so the scan still sees this
        // slot and keeps its insertion-order victim selection.
        _removeUserPosition(pos.owner, positionId);

        uint256 refund;
        uint256 reward;
        uint256 toVault;
        uint256 shortfall;
        if (closeAmount < 0) {
            // H3: portfolio mode charges the owner's free margin first.
            shortfall = _chargeAccountForShortfall(positionId, pos.owner, uint256(-closeAmount));
        }
        if (closeAmount > 0) {
            // M-2: the remaining collateral is no longer swept wholesale. The
            // liquidator is paid, the protocol keeps its penalty, and the rest —
            // at most the maintenance buffer the trader posted for exactly this
            // moment — is returned to the owner.
            uint256 remaining = uint256(closeAmount);
            reward  = remaining * LIQUIDATION_REWARD_BPS / 10_000;
            toVault = remaining * liquidationPenaltyBps / 10_000;
            refund  = remaining - reward - toVault;
            if (refund > 0) freeMargin[pos.owner] += refund;
        }

        // ── Interactions ──────────────────────────────────────────────────────
        if (closeAmount > 0) {
            if (reward > 0) {
                usdc.safeTransfer(msg.sender, reward);
            }
            if (toVault > 0 && address(insuranceVault) != address(0)) {
                usdc.forceApprove(address(insuranceVault), toVault);
                insuranceVault.depositFromProtocol(toVault);
            }
        } else if (shortfall > 0) {
            // N2: the position is underwater beyond its collateral (and, in
            // portfolio mode, beyond its owner's free margin), so the protocol
            // is short `shortfall`. Insurance fund first — draw what the vault
            // can into the exchange's reserves to fill the hole — then
            // auto-deleverage profitable counterparties for whatever the vault
            // could not cover, keeping the system solvent.
            _absorbShortfall(positionId, pos.asset, pos.isLong, shortfall);
        }

        // N2 / C-3: compact the per-asset ADL index last, so _autoDeleverage
        // scanned the book in its original order.
        _removeAssetPosition(pos.asset, positionId);

        // N1 / M-1: route the LP share of the trading fee that was ACTUALLY
        // collected. A liquidation with no residual collateral collects nothing,
        // and must therefore not push protocol reserves into the vault.
        _routeVaultFee(_collectedTradingFee(pos.margin, pnl, fundingPayment, tradingFee));

        emit PositionLiquidated(positionId, pos.owner, msg.sender, pnl);
        emit PositionClosed(positionId, pos.owner, pnl, refund);
    }

    /// @dev H3: portfolio (cross) margin means the whole account backs every
    ///      leg — that is exactly why `_accountState` counts free margin as
    ///      equity and why an underwater leg is not liquidated while free
    ///      margin covers it. The same free margin must therefore pay when the
    ///      leg is finally settled below zero; previously the loss went
    ///      straight to the InsuranceVault / ADL / bad debt while the owner
    ///      kept the free margin that had been shielding it. Isolated mode is
    ///      untouched: there a position can never lose more than its margin.
    ///      Unrealized profit on the owner's OTHER open legs is not touched
    ///      (it cannot be taken without closing them); whatever free margin
    ///      cannot cover still goes to the normal backstops.
    /// @return remaining the part of `shortfall` the account could not cover.
    function _chargeAccountForShortfall(uint256 positionId, address owner, uint256 shortfall)
        internal
        returns (uint256 remaining)
    {
        remaining = shortfall;
        if (!portfolioMarginEnabled) return remaining;
        uint256 fm = freeMargin[owner];
        uint256 charged = fm < remaining ? fm : remaining;
        if (charged == 0) return remaining;
        freeMargin[owner] = fm - charged;
        remaining -= charged;
        emit ShortfallChargedToAccount(positionId, owner, charged);
    }

    /// @dev H3: reverts unless `owner`'s account is at or above maintenance,
    ///      valued on fresh, non-zero prices for every asset it holds (a stale
    ///      or broken feed could otherwise overstate equity and release
    ///      collateral that is actually needed).
    function _requireHealthyAccount(address owner) internal view {
        uint256[] storage ids = userPositions[owner];
        uint256 n = ids.length;
        if (n == 0) return;
        for (uint256 i = 0; i < n; ++i) {
            _requireFresh(positions[ids[i]].asset);
        }
        (int256 eq, uint256 mm) = _accountState(owner);
        if (eq < SafeCast.toInt256(mm)) revert AccountUnhealthy(owner, eq, mm);
    }

    /// @dev C-2: the single bad-debt path shared by `liquidatePosition` and
    ///      `_closePosition`. InsuranceVault first, ADL for the remainder, and
    ///      whatever neither could cover is surfaced as an explicit BadDebt event
    ///      instead of quietly disappearing into the reserves.
    function _absorbShortfall(
        uint256 positionId,
        bytes32 asset,
        bool    loserIsLong,
        uint256 shortfall
    ) internal {
        uint256 covered;
        if (address(insuranceVault) != address(0)) {
            uint256 vaultAvail = insuranceVault.totalAssets();
            covered = shortfall < vaultAvail ? shortfall : vaultAvail;
            if (covered > 0) {
                // bailout pays `covered` USDC to the exchange, topping up the
                // reserves that back winner payouts (CEI: pos already closed).
                insuranceVault.bailout(covered, address(this));
            }
        }
        uint256 uncovered = shortfall - covered;
        if (uncovered > 0 && adlEnabled) {
            uncovered = _autoDeleverage(positionId, asset, loserIsLong, uncovered);
        }
        if (uncovered > 0) {
            emit BadDebt(positionId, asset, uncovered);
        }
    }

    /// @dev M-1: how much of the nominal trading fee the position could actually
    ///      pay out of its own equity. `_routeVaultFee` moves real USDC out of
    ///      the exchange, so routing a fee that was never collected is a direct
    ///      transfer from protocol reserves to LPs.
    function _collectedTradingFee(
        uint256 margin,
        int256  pnl,
        int256  fundingPayment,
        uint256 tradingFee
    ) internal pure returns (uint256) {
        int256 gross = int256(margin) + pnl - fundingPayment;
        if (gross <= 0) return 0;
        return uint256(gross) >= tradingFee ? tradingFee : uint256(gross);
    }

    /// @dev N2: reduce the protocol's winner liability by `uncovered` USDC by
    ///      force-closing profitable positions on the **opposite** side of the
    ///      liquidated (losing) position, haircutting their profit. Each winner's
    ///      `freeMargin` credit is lowered by its share of the haircut, so total
    ///      claims drop back in line with the reserves the bankrupt loser left
    ///      behind. Runs only on the portion the InsuranceVault could not cover.
    ///      Bounded by MAX_ADL_SCAN to cap gas. H-1: the per-asset index is now
    ///      compacted on every close, so the scan budget can no longer be burned
    ///      on stale entries — the PoC filled the first 128 slots with closed
    ///      positions and the backstop silently did nothing. Victims are taken in
    ///      index order; a victim removed mid-scan is swapped out from the tail,
    ///      so the cursor deliberately does not advance in that case. Involuntary,
    ///      so no trading/borrow fee is charged; funding is still settled fairly.
    /// @return remaining the part of `uncovered` no counterparty could absorb.
    function _autoDeleverage(
        uint256 liquidatedId,
        bytes32 asset,
        bool    loserIsLong,
        uint256 uncovered
    ) internal returns (uint256 remaining) {
        remaining = uncovered;
        uint256[] storage ids = assetPositionIds[asset];
        uint256 scanned;
        uint256 i;

        while (i < ids.length && remaining > 0 && scanned < MAX_ADL_SCAN) {
            ++scanned;
            uint256 cid = ids[i];
            Position storage cp = positions[cid];
            // The position being liquidated is still in the index (it is removed
            // after this scan) and is skipped here, as is any other closed entry.
            if (!cp.isOpen)               { ++i; continue; }
            if (cp.isLong == loserIsLong) { ++i; continue; } // want the winning side

            // P1: the haircut is taken from the CAPPED profit. The part above
            // the cap was never owed, so haircutting it would "cover" the
            // shortfall with money that does not exist and leave the real
            // hole open. Capped profit > 0 iff raw profit > 0.
            int256 cpnl = _settlementPnL(cp);
            if (cpnl <= 0)                { ++i; continue; } // only profitable counterparties

            uint256 profit  = uint256(cpnl);
            uint256 haircut = profit >= remaining ? remaining : profit;
            remaining -= haircut;

            // Force-close the counterparty at mark, minus the haircut.
            int256 payout = int256(cp.margin) + cpnl - int256(haircut) - _calcFunding(cp);
            if (payout < 0) payout = 0;

            cp.isOpen      = false;
            cp.closedAt    = block.timestamp;
            cp.realizedPnL = cpnl - int256(haircut);

            uint256 cnotional = cp.margin * cp.leverage;
            if (cp.isLong) {
                globalLongNotional[asset]  -= cnotional;
            } else {
                globalShortNotional[asset] -= cnotional;
            }

            freeMargin[cp.owner] += uint256(payout);

            emit AutoDeleveraged(liquidatedId, cid, haircut, uint256(payout));
            emit PositionClosed(cid, cp.owner, cp.realizedPnL, uint256(payout));

            _removeUserPosition(cp.owner, cid);
            // Swap-and-pop moves the tail element into slot `i`; re-examine it.
            _removeAssetPosition(asset, cid);
        }
    }

    // ── C-3 / H-1: bounded position indices (swap-and-pop) ───────────────────

    /// @dev Removes `positionId` from `userPositions[owner]` in O(1). The moved
    ///      tail element's cached index is rewritten, which is the only part of
    ///      swap-and-pop that can silently corrupt the structure.
    function _removeUserPosition(address owner, uint256 positionId) internal {
        uint256 idx1 = _userPosIndex[positionId];
        if (idx1 == 0) return;                 // not indexed (already removed)
        uint256[] storage ids = userPositions[owner];
        uint256 idx  = idx1 - 1;
        uint256 last = ids.length - 1;
        if (idx != last) {
            uint256 moved = ids[last];
            ids[idx] = moved;
            _userPosIndex[moved] = idx + 1;
        }
        ids.pop();
        delete _userPosIndex[positionId];
    }

    /// @dev Removes `positionId` from `assetPositionIds[asset]` in O(1).
    function _removeAssetPosition(bytes32 asset, uint256 positionId) internal {
        uint256 idx1 = _assetPosIndex[positionId];
        if (idx1 == 0) return;
        uint256[] storage ids = assetPositionIds[asset];
        uint256 idx  = idx1 - 1;
        uint256 last = ids.length - 1;
        if (idx != last) {
            uint256 moved = ids[last];
            ids[idx] = moved;
            _assetPosIndex[moved] = idx + 1;
        }
        ids.pop();
        delete _assetPosIndex[positionId];
    }

    /// @notice Number of open positions currently indexed for ADL on `asset`.
    function openPositionCountFor(bytes32 asset) external view returns (uint256) {
        return assetPositionIds[asset].length;
    }

    // ── Funding Rate ─────────────────────────────────────────────────────────

    /// @notice Settle funding for an asset. Anyone can call once per FUNDING_INTERVAL.
    /// @dev Kept permissionless as a public crank, but funding is also settled
    ///      automatically whenever a position is opened/closed/liquidated, so the
    ///      mechanism no longer depends on altruistic callers.
    function settleFunding(bytes32 asset) external whenNotPaused {
        _requireNotHalted(asset);
        uint256 last = lastFundingUpdateAt[asset];
        if (block.timestamp < last + FUNDING_INTERVAL)
            revert FundingIntervalNotElapsed();
        _pokeFunding(asset);
    }

    /// @dev Accrues funding for every full interval elapsed since the last update.
    ///      First touch of an asset only initializes the clock (no retroactive accrual).
    function _pokeFunding(bytes32 asset) internal {
        uint256 last = lastFundingUpdateAt[asset];
        if (last == 0) {
            // Never touched before: just start the clock. On a live chain
            // block.timestamp is huge, so accruing from 0 would be catastrophic.
            // OI is necessarily 0 here because every open pokes first.
            lastFundingUpdateAt[asset] = block.timestamp;
            return;
        }

        uint256 intervals = (block.timestamp - last) / FUNDING_INTERVAL;
        if (intervals == 0) return;
        lastFundingUpdateAt[asset] = last + intervals * FUNDING_INTERVAL;

        // H-2: bound the catch-up. The clock above is advanced past the whole
        // gap regardless, so the forgiven accrual is identical for payers and
        // receivers and the conservation identity is preserved.
        uint256 accrued = intervals;
        if (accrued > MAX_FUNDING_CATCHUP_INTERVALS) {
            accrued = MAX_FUNDING_CATCHUP_INTERVALS;
            emit FundingCatchupClamped(asset, intervals, accrued);
        }
        _accrueFunding(asset, accrued);
    }

    function _accrueFunding(bytes32 asset, uint256 intervals) internal {
        uint256 longOI  = globalLongNotional[asset];
        uint256 shortOI = globalShortNotional[asset];
        // Funding is peer-to-peer: with no counterparty on one side there is
        // nobody to pay/receive, so no funding accrues (keeps it conservative).
        if (longOI == 0 || shortOI == 0) return;

        int256 rateBps = _fundingRateBps(longOI, shortOI);
        if (rateBps == 0) {
            emit FundingSettled(
                asset, 0, cumulativeFundingIndexLong[asset], cumulativeFundingIndexShort[asset]
            );
            return;
        }

        // Per-unit-notional charge for the PAYER (crowded) side this settlement.
        // 1 bps × 1e14 = 1e-4 fraction of notional (18-dec). |rate| because the
        // sign only tells us *which* side pays; the magnitude is the payer charge.
        uint256 absRate     = uint256(rateBps < 0 ? -rateBps : rateBps);
        int256  payerCharge = int256(absRate * 1e14 * intervals);

        if (rateBps > 0) {
            // Longs crowded → longs pay, shorts receive the same total pro-rata.
            // receiver per-unit = payer per-unit × payerOI / receiverOI so that
            //   shortOI × receiverPerUnit == longOI × payerCharge  (conserved).
            cumulativeFundingIndexLong[asset]  += payerCharge;
            cumulativeFundingIndexShort[asset] -= _receiverCharge(payerCharge, longOI, shortOI);
        } else {
            // Shorts crowded → shorts pay, longs receive.
            cumulativeFundingIndexShort[asset] += payerCharge;
            cumulativeFundingIndexLong[asset]  -= _receiverCharge(payerCharge, shortOI, longOI);
        }

        emit FundingSettled(
            asset, rateBps, cumulativeFundingIndexLong[asset], cumulativeFundingIndexShort[asset]
        );
    }

    /// @dev H-3: the thin side's per-unit receipt, scaled by payerOI/receiverOI
    ///      to conserve the total but capped at MAX_FUNDING_RECEIVE_SCALE× the
    ///      payer's per-unit charge. Uncapped, a dust-sized position on the empty
    ///      side received hundreds of times its own margin in one settlement,
    ///      money the exchange had to advance from its reserves because the
    ///      crowded side had not closed yet. Above the cap the surplus stays with
    ///      the payers (they still owe it on close), which errs toward the pool.
    function _receiverCharge(int256 payerCharge, uint256 payerOI, uint256 receiverOI)
        internal pure returns (int256)
    {
        int256 scaled = payerCharge * int256(payerOI) / int256(receiverOI);
        int256 cap    = payerCharge * int256(MAX_FUNDING_RECEIVE_SCALE);
        return scaled > cap ? cap : scaled;
    }

    /// @dev Imbalance-driven payer rate in BPS for the given OI (positive = longs
    ///      pay, negative = shorts pay). This is the per-unit charge applied to the
    ///      crowded side; the thin side receives a pro-rata-scaled amount.
    function _fundingRateBps(uint256 longOI, uint256 shortOI) internal pure returns (int256) {
        int256 imbalance = (int256(longOI) - int256(shortOI)) * int256(1e18)
                         / int256(longOI + shortOI);
        return imbalance * int256(MAX_FUNDING_RATE_BPS) / int256(1e18);
    }

    /// @notice Current per-interval funding rate in BPS (positive = longs pay,
    ///         negative = shorts pay). Zero when either side has no open interest,
    ///         since funding is a strict long↔short transfer with no counterparty.
    function getFundingRate(bytes32 asset) external view returns (int256 rateBps) {
        uint256 longOI  = globalLongNotional[asset];
        uint256 shortOI = globalShortNotional[asset];
        if (longOI == 0 || shortOI == 0) return 0;
        return _fundingRateBps(longOI, shortOI);
    }

    /// @notice Accrued funding for an open position (positive = trader owes, negative = trader receives).
    function pendingFunding(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;
        return _calcFunding(pos);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice Open: PnL as it would settle right now (mark-to-market, clamped
    ///         to the position's profit cap if it has one). Closed: realized.
    function getUnrealizedPnL(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return pos.realizedPnL;
        (int256 pnl, ) = _cappedPnL(pos);
        return pnl;
    }

    /// @notice What the position would actually be worth if closed right now.
    /// @dev Low: this used to report margin + PnL only, ignoring accrued funding
    ///      and the fees the close path deducts, so the UI over-stated every
    ///      position — badly so for one that had been open for months. It now
    ///      mirrors `_closePosition`'s arithmetic exactly.
    function getPositionValue(uint256 positionId) external view returns (uint256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;

        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * uint256(pos.tradingFeeBps) / 10000; // frozen at open — see Position.tradingFeeBps
        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * uint256(pos.borrowFeeBpsPerHour) * hoursElapsed / 10000; // frozen at open

        (int256 pnl, ) = _cappedPnL(pos);
        int256 val = int256(pos.margin) + pnl
                   - int256(tradingFee + borrowFee) - _calcFunding(pos);
        return val > 0 ? uint256(val) : 0;
    }

    /// @notice The user's currently OPEN position ids.
    /// @dev C-3: closed ids are compacted out, so this list — and the
    ///      `_accountState` loop behind portfolio margin — is bounded by locked
    ///      margin rather than by lifetime trade count.
    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    /// @notice Effective max leverage for an asset: the tighter of the N3
    ///         owner override (or global `MAX_LEVERAGE` default) and the
    ///         asset's carbon-tier ceiling. This is the real, currently
    ///         tradable leverage — `maxLeverageOf[asset]` alone is not,
    ///         once carbon pricing is active (see `setMaxLeverageFor`).
    function maxLeverageForAsset(bytes32 asset) external view returns (uint256) {
        return _maxLeverage(asset);
    }

    /// @notice N3: effective maintenance-margin bps for an asset (override or global).
    function maintenanceMarginBpsForAsset(bytes32 asset) external view returns (uint256) {
        return _maintenanceMarginBps(asset);
    }

    /// @notice Effective trading fee (bps) for an asset — the same per-asset
    ///         carbon-tier rate `_openPosition` actually charges. When
    ///         `esgRegistry` is unset (legacy mode), this is the global
    ///         `TRADING_FEE_BPS` verbatim, applied uniformly to every asset —
    ///         see `_carbonParamsFor`'s own NatSpec for that fallback branch.
    /// @dev Exists so a caller opening several positions across different
    ///      assets in one call (CopyTracker.followTrader, #97) can size its
    ///      fee buffer per allocation instead of assuming one global rate
    ///      applies to every asset — which stopped being true once fees
    ///      became carbon-tier-derived (#96).
    function tradingFeeBpsForAsset(bytes32 asset) external view returns (uint256) {
        return _tradingFeeBps(asset);
    }

    /// @dev Delegation point for `tradingFeeBpsForAsset`, matching the
    ///      `maxLeverageForAsset` -> `_maxLeverage` and
    ///      `maintenanceMarginBpsForAsset` -> `_maintenanceMarginBps` pattern
    ///      those two getters already use.
    function _tradingFeeBps(bytes32 asset) internal view returns (uint256) {
        (, uint256 tradingFeeBps, , ) = _carbonParamsFor(asset);
        return tradingFeeBps;
    }

    /// @notice P3-2: account-level health across all of `owner`'s open positions.
    ///         equity      = freeMargin + Σ (margin + unrealized PnL − funding)
    ///         maintenance = Σ (notional × maintenance-bps)
    ///         healthy     = equity ≥ maintenance
    ///         Mirrors the per-position close math (PnL + funding); trading/borrow
    ///         fees are intentionally excluded from the gate — the maintenance
    ///         buffer covers them — so portfolio mode is never stricter than
    ///         isolated mode.
    function getAccountHealth(address owner)
        external
        view
        returns (int256 equity, uint256 maintenance, bool healthy)
    {
        (equity, maintenance) = _accountState(owner);
        healthy = equity >= int256(maintenance);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /// @dev Sum equity and maintenance requirement over an owner's open positions.
    ///      Note: iterates the owner's full position list (closed ones skipped).
    ///      Position count per account is naturally bounded by locked margin at
    ///      the current testnet scope; a hard cap can be added before mainnet if
    ///      churn ever makes this list large. Health uses strict `eq < mm` at the
    ///      gate, so an account exactly at maintenance is treated as healthy.
    function _accountState(address owner)
        internal
        view
        returns (int256 equity, uint256 maintenance)
    {
        uint256[] storage ids = userPositions[owner];
        equity = int256(freeMargin[owner]);
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            Position storage p = positions[ids[i]];
            if (!p.isOpen) continue;
            // P1: capped, so portfolio equity never counts profit the
            // exchange will not pay as collateral for another leg.
            (int256 pnl, ) = _cappedPnL(p);
            equity     += int256(p.margin) + pnl - _calcFunding(p);
            maintenance += (p.margin * p.leverage) * _maintenanceMarginBps(p.asset) / 10000;
        }
    }

    /// @notice Resolves an asset's carbon tier and the fee/leverage params
    ///         that follow from it, from a single call site every other
    ///         function in this contract goes through.
    /// @dev When `esgRegistry` is unset, this returns today's legacy global
    ///      defaults verbatim — an all-or-nothing deployment switch, not a
    ///      per-asset carve-out (see `esgRegistry`'s own NatSpec). The `tier`
    ///      returned in that branch is `Tier.Unrated`, not a real
    ///      classification — carbon pricing was never evaluated for this
    ///      position at all, which is what `Unrated` means. Nothing branches
    ///      on the stored tier in either mode; it is pure observability, so
    ///      an inaccurate label here would cost nothing functionally but
    ///      would still be a needless small dishonesty.
    ///
    ///      Once `esgRegistry` IS wired, the tier is the WITNESSED median
    ///      tier (`medianCarbonTier`, ADR-006), not one re-derived from a
    ///      carbon-intensity number through `tierOf` — that derivation is
    ///      only valid for revenue-basis assets. An asset with no fresh
    ///      attestation resolves to `Tier.Unrated` inside the registry's own
    ///      fail-closed read, and `CarbonTiers.paramsFor(Tier.Unrated)` is
    ///      the most conservative row — fail-closed, not a gap this function
    ///      has to special-case.
    /// @dev Called at most once per `_openPosition` (threaded through as a
    ///      local, not re-fetched by `_maxLeverage`'s own call inside the
    ///      leverage check — see `_openPosition`). `_maxLeverage` still calls
    ///      this on its own when used standalone (the public
    ///      `maxLeverageForAsset` getter, or any other caller outside
    ///      `_openPosition`), where there is no larger call already holding
    ///      the result to reuse.
    function _carbonParamsFor(bytes32 asset)
        internal
        view
        returns (CarbonTiers.Tier tier, uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, uint256 maxLev)
    {
        if (address(esgRegistry) == address(0)) {
            return (CarbonTiers.Tier.Unrated, TRADING_FEE_BPS, BORROW_FEE_BPS_PER_HOUR, MAX_LEVERAGE);
        }
        (tier, , ,) = esgRegistry.medianCarbonTier(asset);
        (tradingFeeBps, borrowFeeBpsPerHour, maxLev) = CarbonTiers.paramsFor(tier);
    }

    /// @notice Effective max leverage for an asset: the tighter of the owner's
    ///         own per-asset override (`maxLeverageOf`, N3, defaulting to the
    ///         global `MAX_LEVERAGE`) and the carbon-tier ceiling.
    /// @dev `setMaxLeverageFor` still lets the owner tighten an asset further
    ///      for any reason — that path is untouched. What it can no longer do
    ///      is LOOSEN a high-carbon asset back up past its tier's ceiling:
    ///      `min()` means the carbon cap is a floor of strictness the owner
    ///      cannot override upward. That is the concrete shape of "no per-user
    ///      or per-asset fee/leverage exemption path" this ticket requires —
    ///      see CarbonPricing.t.sol's fuzz/negative tests for the direct proof.
    ///
    ///      Split from `_effectiveMaxLeverage` below so `_openPosition` can
    ///      fetch `_carbonParamsFor` exactly once and feed its `maxLev` into
    ///      the shared formula, instead of this function re-fetching the same
    ///      registry data `_openPosition` already has in hand.
    function _maxLeverage(bytes32 asset) internal view returns (uint256) {
        (, , , uint256 carbonCap) = _carbonParamsFor(asset);
        return _effectiveMaxLeverage(asset, carbonCap);
    }

    /// @dev The `min(ownerCap, carbonCap)` formula on its own, taking an
    ///      already-fetched carbon cap rather than fetching it itself — the
    ///      single source of truth for "how do owner override and carbon
    ///      ceiling combine", shared by `_maxLeverage` (which fetches its own
    ///      carbon cap for standalone callers) and `_openPosition` (which
    ///      already has one in hand from its own single `_carbonParamsFor`
    ///      call, and would otherwise have to fetch it a second time).
    function _effectiveMaxLeverage(bytes32 asset, uint256 carbonCap) internal view returns (uint256) {
        uint256 o = maxLeverageOf[asset];
        uint256 ownerCap = o == 0 ? MAX_LEVERAGE : o;
        return ownerCap < carbonCap ? ownerCap : carbonCap;
    }

    function _maintenanceMarginBps(bytes32 asset) internal view returns (uint256) {
        uint256 o = maintenanceMarginBpsOf[asset];
        return o == 0 ? DEFAULT_MAINTENANCE_MARGIN_BPS : o;
    }

    /// @dev N1: route a slice of the trading fee to the InsuranceVault, lifting
    ///      the LP share price. No-op when disabled or no vault is wired.
    function _routeVaultFee(uint256 tradingFee) internal {
        uint256 share = vaultFeeShareBps;
        if (share == 0 || address(insuranceVault) == address(0)) return;
        uint256 cut = tradingFee * share / 10_000;
        if (cut == 0) return;
        cumulativeVaultFees += cut;
        usdc.forceApprove(address(insuranceVault), cut);
        insuranceVault.depositFromProtocol(cut);
        emit VaultFeeRouted(cut, cumulativeVaultFees);
    }

    /// @dev Oracle returns 8-decimal price; scales to 18 dec and reverts on stale data.
    ///      Used in every state-changing path (open / close / liquidate).
    function _freshPrice(bytes32 asset) internal view returns (uint256) {
        (uint256 rawPrice, uint256 updatedAt) = oracle.getPrice(asset);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(asset, updatedAt);
        // Low: a zero price passes the staleness check but makes `size` divide by
        // zero at entry and marks every position to zero — fail closed instead.
        if (rawPrice == 0) revert InvalidPrice(asset);
        return rawPrice * 1e10;
    }

    /// @dev Freshness gate for close / liquidation / withdrawal health.
    ///      M8: also refuses a zero price, like `_freshPrice` does for opens.
    ///      A fresh zero used to pass here, and `_calcPnL` then valued every
    ///      long at a total loss and every short at a windfall, so a single
    ///      bad print could liquidate the whole long book and pay out shorts.
    function _requireFresh(bytes32 asset) internal view {
        (uint256 rawPrice, uint256 updatedAt) = oracle.getPrice(asset);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(asset, updatedAt);
        if (rawPrice == 0) revert InvalidPrice(asset);
    }

    function _openPosition(
        address owner,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom,
        address agent
    ) internal returns (uint256 positionId) {
        // P1: every open path — openPosition, and openPositionFor from both
        // CopyTracker and AgentSessionManager — funnels through here, so this
        // is the single place new exposure is refused.
        _requireActive(asset);
        if (margin < MIN_MARGIN) revert MarginTooLow();

        // Read once, at open, and freeze into the position below — a later
        // change to this asset's carbon rating must never retroactively
        // change what an already-open position costs (ADR-003). This single
        // call feeds BOTH the leverage check just below and the frozen fee
        // fields further down — code review caught an earlier version of
        // this function calling `_carbonParamsFor` a second time (once
        // indirectly via `_maxLeverage`, once directly) purely to re-fetch
        // data already in hand, doubling this function's registry reads for
        // no behavioral difference.
        (CarbonTiers.Tier carbonTier, uint256 tradingFeeBps, uint256 borrowFeeBpsPerHour, uint256 carbonMaxLev) =
            _carbonParamsFor(asset);
        if (leverage == 0 || leverage > _effectiveMaxLeverage(asset, carbonMaxLev)) revert InvalidLeverage();

        // RWA compliance: gated only when both the asset is flagged and a KYC
        // registry is wired (otherwise this is a no-op for backward compat).
        if (rwaAsset[asset] && address(kyc) != address(0) && !kyc.isVerified(owner)) {
            revert NotKycVerified(owner);
        }

        // Settle any pending funding BEFORE locking the entry index,
        // so the new position is not charged for pre-open accrual.
        _pokeFunding(asset);

        uint256 notional   = margin * leverage;
        uint256 tradingFee = notional * tradingFeeBps / 10000;

        if (freeMargin[owner] < margin + tradingFee)   revert InsufficientFreeMargin();
        _checkOpenInterestCap(asset, isLong, notional);

        // C-1: entry is booked at the MARK price the book shows *before* this
        // position exists — not the raw index. Together with `_calcPnL` excluding
        // the position's own notional from its mark, this makes the premium a
        // strictly zero-sum transfer between traders. Previously entry used the
        // index while PnL used a mark that the position itself inflated, so
        // opening and immediately closing a one-sided position minted free money
        // (1% premium against 0.2% round-trip fees). OI is incremented below, so
        // `_markPrice` here is by construction "excluding self".
        uint256 entryPrice = _markPrice(asset, _freshPrice(asset));

        freeMargin[owner] -= (margin + tradingFee);

        if (isLong) {
            globalLongNotional[asset] += notional;
        } else {
            globalShortNotional[asset] += notional;
        }

        positionId = nextPositionId++;
        positions[positionId] = Position({
            id:               positionId,
            owner:            owner,
            asset:            asset,
            isLong:           isLong,
            entryPrice:       entryPrice,
            margin:           margin,
            leverage:         leverage,
            openedAt:         block.timestamp,
            closedAt:         0,
            realizedPnL:      0,
            isOpen:           true,
            copiedFrom:       copiedFrom,
            entryFundingIndex: isLong
                ? cumulativeFundingIndexLong[asset]
                : cumulativeFundingIndexShort[asset],
            // Safe narrowing: bounded by MAX_TRADING_FEE_BPS(100) /
            // MAX_BORROW_FEE_BPS_PER_HOUR(10), both far under uint16's range —
            // see Position.tradingFeeBps's own NatSpec for why uint16 here.
            tradingFeeBps:        uint16(tradingFeeBps),
            borrowFeeBpsPerHour:  uint16(borrowFeeBpsPerHour),
            carbonTier:           carbonTier
        });
        userPositions[owner].push(positionId);
        _userPosIndex[positionId] = userPositions[owner].length;   // 1-based
        assetPositionIds[asset].push(positionId); // N2: per-asset index for ADL
        _assetPosIndex[positionId] = assetPositionIds[asset].length;
        // H-6: remember which agent (if any) is allowed to close this position.
        if (agent != address(0)) positionAgent[positionId] = agent;
        // P1: freeze the profit cap (0 = uncapped). margin >= MIN_MARGIN and
        // bps >= MIN_PROFIT_CAP_BPS, so an enabled cap is never rounded to 0.
        uint256 capBps = maxProfitBps[asset];
        if (capBps != 0) profitCapOf[positionId] = margin * capBps / 10_000;

        emit PositionOpened(positionId, owner, asset, isLong, entryPrice, margin, leverage);

        // N1: route the LP share of this open's trading fee into the vault.
        _routeVaultFee(tradingFee);
    }

    function _closePosition(address caller, uint256 positionId) internal {
        Position storage pos = positions[positionId];
        if (caller != pos.owner) revert NotPositionOwner();
        if (!pos.isOpen)         revert PositionAlreadyClosed();
        // P1: closing is allowed in ReduceOnly, refused only when Halted.
        _requireNotHalted(pos.asset);

        // Settle funding up to now so the position pays/receives the full accrual.
        _pokeFunding(pos.asset);
        _requireFresh(pos.asset);

        int256 pnl = _settlementPnL(pos);

        // DeFi Mechanics: Trading Fee (Uniswap) + Borrow Fee (Aave)
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * uint256(pos.tradingFeeBps) / 10000; // frozen at open — see Position.tradingFeeBps

        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * uint256(pos.borrowFeeBpsPerHour) * hoursElapsed / 10000; // frozen at open

        int256 totalFees      = int256(tradingFee + borrowFee);
        int256 fundingPayment = _calcFunding(pos); // positive = trader pays, negative = trader receives
        int256 closeAmount    = int256(pos.margin) + pnl - totalFees - fundingPayment;

        // ── C-2: bad debt on a voluntary close ────────────────────────────────
        // The loss used to be clamped at 0 and the protocol then *paid the
        // bankrupt trader* BAILOUT_FLOOR_BPS of their margin out of the insurance
        // fund — so closing a hopeless position voluntarily was strictly better
        // than being liquidated, and the hole it left was never funded. Two
        // hedged accounts could therefore drain the pool on any large move.
        //
        // A close now walks the SAME path as a liquidation: the shortfall is
        // covered by the InsuranceVault, then by ADL, and any remainder is
        // emitted as BadDebt. The bailout floor keeps its original intent — a
        // small softener for a wiped-out trader — but is only paid when the vault
        // is demonstrably solvent afterwards, i.e. it fully covered the shortfall
        // and still has the floor to spare. A drained vault pays nothing.
        uint256 shortfall;
        uint256 bailoutFloor;
        if (closeAmount < 0) {
            // H3: portfolio mode charges the owner's free margin first; only
            // what it cannot cover reaches the pool backstops (and only then
            // is the owner "wiped out" for the bailout-floor rule below).
            shortfall = _chargeAccountForShortfall(positionId, pos.owner, uint256(-closeAmount));
            closeAmount = 0;
            if (shortfall > 0 && address(insuranceVault) != address(0)) {
                uint256 avail = insuranceVault.totalAssets();
                uint256 floor = pos.margin * BAILOUT_FLOOR_BPS / 10_000;
                if (avail >= shortfall + floor) bailoutFloor = floor;
            }
        }

        // Performance fee: 10 % of profit on copied positions when feeRouter is set
        uint256 perfFee = 0;
        if (pos.copiedFrom != address(0) && pnl > 0 && address(feeRouter) != address(0)) {
            perfFee = uint256(pnl) * PERFORMANCE_FEE_BPS / 10_000;
            // Never let the fee push closeAmount negative (uint cast would underflow)
            if (int256(perfFee) > closeAmount) {
                perfFee = closeAmount > 0 ? uint256(closeAmount) : 0;
            }
            closeAmount -= int256(perfFee);
        }

        // ── Effects (all state updated BEFORE any external call: CEI pattern) ──
        pos.isOpen      = false;
        pos.closedAt    = block.timestamp;
        pos.realizedPnL = pnl;

        if (pos.isLong) {
            globalLongNotional[pos.asset] -= notional;
        } else {
            globalShortNotional[pos.asset] -= notional;
        }
        // C-3 / H-1: compact both indices (asset index last, as in liquidation).
        _removeUserPosition(pos.owner, positionId);

        freeMargin[pos.owner] += uint256(closeAmount);

        // ── Interactions ──────────────────────────────────────────────────────
        if (shortfall > 0) {
            _absorbShortfall(positionId, pos.asset, pos.isLong, shortfall);
        }
        _removeAssetPosition(pos.asset, positionId);

        if (bailoutFloor > 0) {
            try insuranceVault.bailout(bailoutFloor, pos.owner) { } catch { }
        }

        if (perfFee > 0) {
            // Low: FeeRouter now pulls the fee itself, so it can only ever credit
            // USDC the caller actually handed over.
            usdc.forceApprove(address(feeRouter), perfFee);
            feeRouter.receivePerformanceFee(pos.copiedFrom, perfFee);
            emit PerformanceFeePaid(positionId, pos.copiedFrom, perfFee);
        }

        // N1 / M-1: only the trading fee this close could actually pay.
        _routeVaultFee(_collectedTradingFee(pos.margin, pnl, fundingPayment, tradingFee));

        emit PositionClosed(positionId, pos.owner, pnl, uint256(closeAmount));
    }

    /// @dev P1: refuse an open that would lift this side's OI above its cap.
    function _checkOpenInterestCap(bytes32 asset, bool isLong, uint256 notional) internal view {
        uint256 cap = isLong ? maxLongOI[asset] : maxShortOI[asset];
        if (cap == 0) return;
        uint256 resulting = (isLong ? globalLongNotional[asset] : globalShortNotional[asset]) + notional;
        if (resulting > cap) revert OpenInterestCapExceeded(asset, isLong, resulting, cap);
    }

    /// @dev P1: mark-to-market PnL clamped to the position's frozen profit
    ///      cap. Losses are never touched. Returns the raw value alongside.
    function _cappedPnL(Position storage pos) internal view returns (int256 pnl, int256 rawPnl) {
        rawPnl = _calcPnL(pos);
        pnl    = rawPnl;
        uint256 cap = profitCapOf[pos.id];
        if (cap == 0) return (pnl, rawPnl);
        int256 capSigned = SafeCast.toInt256(cap);
        if (rawPnl > capSigned) pnl = capSigned;
    }

    /// @dev P1: the PnL every settlement path (close, liquidation, ADL) books.
    function _settlementPnL(Position storage pos) internal returns (int256 pnl) {
        int256 rawPnl;
        (pnl, rawPnl) = _cappedPnL(pos);
        if (pnl != rawPnl) emit ProfitCapped(pos.id, rawPnl, pnl);
    }

    /// PnL math (all values in 18-decimal USDC):
    ///   notional    = margin × leverage
    ///   size        = notional × 1e18 / entryPrice   (qty of asset, 18-dec fixed-point)
    ///   priceChange = currentPrice - entryPrice
    ///   pnl         = priceChange × size / 1e18
    ///   if short:   pnl = -pnl
    function _calcPnL(Position storage pos) internal view returns (int256) {
        (uint256 rawPrice,) = oracle.getPrice(pos.asset);
        // M8: never value a position at a zero price — fail closed, in views
        // and in portfolio-health checks alike (see `_requireFresh`).
        if (rawPrice == 0) revert InvalidPrice(pos.asset);
        // Value PnL (and therefore liquidation) on the mark price, not the raw
        // index, so OI imbalance is reflected the way a real perp does.
        //
        // C-1: the position's OWN notional is excluded from the imbalance that
        // drives its mark. Otherwise a trader marks their own book: `_closePosition`
        // computes PnL before decrementing `globalLongNotional`, so a lone 5×
        // long was valued at a premium it created itself and could round-trip for
        // a risk-free 1% (PoC: +4,000 USDC on a 100,000 margin, zero price move).
        // With self excluded, mark can only move on OTHER traders' flow, so the
        // premium is a transfer between positions and never a mint.
        uint256 currentPrice = _markPriceExcluding(pos, rawPrice * 1e10);

        uint256 notional    = pos.margin * pos.leverage;
        uint256 size        = notional * 1e18 / pos.entryPrice;
        int256  priceChange = int256(currentPrice) - int256(pos.entryPrice);
        int256  pnl         = priceChange * int256(size) / 1e18;

        if (!pos.isLong) pnl = -pnl;
        return pnl;
    }

    /// @notice Mark price for an asset (18-dec): the oracle index adjusted by an
    ///         OI-imbalance premium, bounded by `markPremiumCapBps`. Longs-heavy
    ///         books trade at a premium to index, shorts-heavy at a discount.
    function getMarkPrice(bytes32 asset) external view returns (uint256) {
        (uint256 rawPrice,) = oracle.getPrice(asset);
        return _markPrice(asset, rawPrice * 1e10);
    }

    /// @dev Apply the OI-imbalance premium to an index price (both 18-dec).
    ///      premiumBps = imbalance × cap, with imbalance ∈ [-1e18, 1e18], so the
    ///      premium is bounded by ±markPremiumCapBps. Disabled (mark == index)
    ///      when the cap or total OI is zero.
    function _markPrice(bytes32 asset, uint256 indexPrice) internal view returns (uint256) {
        return _markFrom(
            indexPrice, globalLongNotional[asset], globalShortNotional[asset]
        );
    }

    /// @dev C-1: mark for a specific position, with that position's own notional
    ///      removed from the open interest driving the premium.
    function _markPriceExcluding(Position storage pos, uint256 indexPrice)
        internal view returns (uint256)
    {
        if (markPremiumCapBps == 0) return indexPrice;   // fast path: mark == index

        uint256 longOI  = globalLongNotional[pos.asset];
        uint256 shortOI = globalShortNotional[pos.asset];
        if (pos.isOpen) {
            uint256 own = pos.margin * pos.leverage;
            if (pos.isLong) {
                longOI  = own >= longOI  ? 0 : longOI  - own;
            } else {
                shortOI = own >= shortOI ? 0 : shortOI - own;
            }
        }
        return _markFrom(indexPrice, longOI, shortOI);
    }

    function _markFrom(uint256 indexPrice, uint256 longOI, uint256 shortOI)
        internal view returns (uint256)
    {
        uint256 cap = markPremiumCapBps;
        if (cap == 0) return indexPrice;
        if (longOI + shortOI == 0) return indexPrice;

        int256 imbalance = (int256(longOI) - int256(shortOI)) * int256(1e18)
                         / int256(longOI + shortOI);
        int256 premiumBps = imbalance * int256(cap) / int256(1e18); // signed, ≤ cap
        // mark = index + index × premiumBps / 10000
        int256 mark = int256(indexPrice) + int256(indexPrice) * premiumBps / 10000;
        return mark > 0 ? uint256(mark) : 0;
    }

    /// @dev Funding owed by this position since it was opened.
    ///      Positive = position pays (deducted on close), negative = position receives.
    function _calcFunding(Position storage pos) internal view returns (int256) {
        // Each side has its own cumulative index; the sign of the index delta
        // already encodes pay (+) vs receive (−), so no extra flip is needed.
        // A long's index rises when longs are crowded (it pays); a short's index
        // falls when longs are crowded (it receives) and vice-versa.
        int256 sideIndex = pos.isLong
            ? cumulativeFundingIndexLong[pos.asset]
            : cumulativeFundingIndexShort[pos.asset];
        int256 indexDiff = sideIndex - pos.entryFundingIndex;
        uint256 notional = pos.margin * pos.leverage;
        return int256(notional) * indexDiff / int256(1e18);
    }
}
