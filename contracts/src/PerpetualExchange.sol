// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

contract PerpetualExchange is Ownable, ReentrancyGuard {
    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_LEVERAGE            = 5;
    uint256 public constant MIN_MARGIN              = 10e18;
    uint256 public constant PERFORMANCE_FEE_BPS     = 1000;  // 10% of profit on copied positions

    // Liquidator incentive: share of remaining collateral paid to the caller
    uint256 public constant LIQUIDATION_REWARD_BPS  = 500;   // 5% of remaining collateral

    // Owner-adjustable fees (kept as public vars so tests and admin can override)
    uint256 public TRADING_FEE_BPS         = 10;   // 0.1% swap fee (Uniswap concept)
    uint256 public BORROW_FEE_BPS_PER_HOUR = 1;    // 0.01% borrow rate per hour (Aave concept)

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

    // Insurance vault: floor paid to trader when closeAmount < 0
    uint256 public constant BAILOUT_FLOOR_BPS       = 1000;  // 10% of margin

    uint256 public constant DEFAULT_MAINTENANCE_MARGIN_BPS = 500;  // 5% of notional
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
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => Position)      public positions;
    mapping(address => uint256[])     public userPositions;
    mapping(address => uint256)       public freeMargin;

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
    error NotKycVerified(address user);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        usdc   = IERC20(_usdc);
        oracle = IOracle(_oracle);
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
    }

    /// @notice Authorize or revoke an additional agent (beyond the primary
    ///         copyTracker) to call the `*For` proxy entrypoints.
    function setAgentAuthorized(address agent, bool authorized) external onlyOwner {
        authorizedAgents[agent] = authorized;
        emit AgentAuthorizationSet(agent, authorized);
    }

    function setFeeRouter(address _feeRouter) external onlyOwner {
        feeRouter = IFeeRouterPerp(_feeRouter);
    }

    function setExecutionFee(uint256 _fee) external onlyOwner {
        executionFee = _fee;
    }

    function setTradingFeeBps(uint256 _bps) external onlyOwner {
        TRADING_FEE_BPS = _bps;
    }

    function setBorrowFeePerHour(uint256 _bps) external onlyOwner {
        BORROW_FEE_BPS_PER_HOUR = _bps;
    }

    function setInsuranceVault(address _vault) external onlyOwner {
        insuranceVault = IInsuranceVaultPerp(_vault);
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
    function setMaxLeverageFor(bytes32 asset, uint256 maxLev) external onlyOwner {
        require(maxLev <= MAX_LEVERAGE, "above global cap");
        maxLeverageOf[asset] = maxLev;
        emit MaxLeverageSet(asset, maxLev);
    }

    /// @notice N3: per-asset maintenance-margin override in bps (0 = use the
    ///         global DEFAULT_MAINTENANCE_MARGIN_BPS).
    function setMaintenanceMarginFor(bytes32 asset, uint256 bps) external onlyOwner {
        require(bps <= 10_000, "bps>100%");
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

    function setMaxPriceAge(uint256 _seconds) external onlyOwner {
        require(_seconds > 0, "zero age");
        maxPriceAge = _seconds;
    }

    /// @notice Set the mark-price premium cap (bps of index). 0 disables the
    ///         premium so mark == index (legacy pricing).
    function setMarkPremiumCapBps(uint256 _bps) external onlyOwner {
        markPremiumCapBps = _bps;
        emit MarkPremiumCapBpsSet(_bps);
    }

    function withdrawExecutionFees() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    // ── Margin management ────────────────────────────────────────────────────

    function depositMargin(uint256 amount) external nonReentrant {
        usdc.transferFrom(msg.sender, address(this), amount);
        freeMargin[msg.sender] += amount;
        emit MarginDeposited(msg.sender, amount);
    }

    /// @dev CopyTracker pulls USDC from itself, credits freeMargin to `user`.
    function depositMarginFor(address user, uint256 amount) external nonReentrant {
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        usdc.transferFrom(msg.sender, address(this), amount);
        freeMargin[user] += amount;
        emit MarginDeposited(user, amount);
    }

    function withdrawMargin(uint256 amount) external nonReentrant {
        if (freeMargin[msg.sender] < amount) revert InsufficientFreeMargin();
        freeMargin[msg.sender] -= amount;
        usdc.transfer(msg.sender, amount);
        emit MarginWithdrawn(msg.sender, amount);
    }

    // ── Position lifecycle ───────────────────────────────────────────────────

    function openPosition(
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage
    ) external payable nonReentrant returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        return _openPosition(msg.sender, asset, isLong, margin, leverage, address(0));
    }

    function openPositionFor(
        address user,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) external payable nonReentrant returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        if (copyTracker == address(0)) revert CopyTrackerNotSet();
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        return _openPosition(user, asset, isLong, margin, leverage, copiedFrom);
    }

    function closePosition(uint256 positionId) external nonReentrant {
        _closePosition(msg.sender, positionId);
    }

    /// @dev Lets copyTracker close a position on behalf of its owner (e.g. unfollow flow).
    function closePositionFor(address owner, uint256 positionId) external nonReentrant {
        if (!authorizedAgents[msg.sender]) revert NotCopyTracker();
        _closePosition(owner, positionId);
    }

    // ── Liquidation Engine ───────────────────────────────────────────────────

    /// @notice Anyone can call this to liquidate an underwater position and protect the protocol.
    /// @dev If (margin + PnL - fees) < Maintenance Margin (5% of notional), the position is liquidated.
    ///      The caller earns LIQUIDATION_REWARD_BPS of the remaining collateral as incentive.
    function liquidatePosition(uint256 positionId) external nonReentrant {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) revert PositionAlreadyClosed();

        _pokeFunding(pos.asset);
        _requireFresh(pos.asset);

        int256 pnl = _calcPnL(pos);
        
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * TRADING_FEE_BPS / 10000;
        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * BORROW_FEE_BPS_PER_HOUR * hoursElapsed / 10000;
        
        int256 totalFees   = int256(tradingFee + borrowFee);
        int256 closeAmount = int256(pos.margin) + pnl - totalFees - _calcFunding(pos);
        
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

        // ── Interactions ──────────────────────────────────────────────────────
        // Split remaining collateral: reward → liquidator, remainder → InsuranceVault
        if (closeAmount > 0) {
            uint256 remaining = uint256(closeAmount);
            uint256 reward    = remaining * LIQUIDATION_REWARD_BPS / 10_000;
            uint256 toVault   = remaining - reward;

            if (reward > 0) {
                usdc.transfer(msg.sender, reward);
            }
            if (toVault > 0 && address(insuranceVault) != address(0)) {
                usdc.approve(address(insuranceVault), toVault);
                insuranceVault.depositFromProtocol(toVault);
            }
        } else if (adlEnabled && closeAmount < 0) {
            // N2: the position is underwater beyond its collateral, so the
            // protocol is short uint(-closeAmount). Insurance fund first — draw
            // what the vault can into the exchange's reserves to fill the hole —
            // then auto-deleverage profitable counterparties for whatever the
            // vault could not cover, keeping the system solvent.
            uint256 shortfall = uint256(-closeAmount);
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
            if (shortfall > covered) {
                _autoDeleverage(positionId, pos.asset, pos.isLong, shortfall - covered);
            }
        }

        // N1: route the LP share of the liquidation trading fee into the vault.
        _routeVaultFee(tradingFee);

        emit PositionLiquidated(positionId, pos.owner, msg.sender, pnl);
        emit PositionClosed(positionId, pos.owner, pnl, 0);
    }

    /// @dev N2: reduce the protocol's winner liability by `uncovered` USDC by
    ///      force-closing profitable positions on the **opposite** side of the
    ///      liquidated (losing) position, haircutting their profit. Each winner's
    ///      `freeMargin` credit is lowered by its share of the haircut, so total
    ///      claims drop back in line with the reserves the bankrupt loser left
    ///      behind. Runs only on the portion the InsuranceVault could not cover.
    ///      Bounded by MAX_ADL_SCAN to cap gas (note: the per-asset index is not
    ///      compacted, so very long-lived markets may exhaust the scan budget on
    ///      stale entries — acceptable for the current testnet scope). Victims are
    ///      taken in index (insertion) order. Involuntary, so no trading/borrow
    ///      fee is charged; funding is still settled fairly.
    function _autoDeleverage(
        uint256 liquidatedId,
        bytes32 asset,
        bool    loserIsLong,
        uint256 uncovered
    ) internal {
        uint256 remaining = uncovered;
        uint256[] storage ids = assetPositionIds[asset];
        uint256 n = ids.length;
        uint256 scanned;

        for (uint256 i = 0; i < n && remaining > 0 && scanned < MAX_ADL_SCAN; ++i) {
            ++scanned;
            uint256 cid = ids[i];
            Position storage cp = positions[cid];
            if (!cp.isOpen)               continue;
            if (cp.isLong == loserIsLong) continue; // want the winning (opposite) side

            int256 cpnl = _calcPnL(cp);
            if (cpnl <= 0)                continue; // only profitable counterparties

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
        }
    }

    // ── Funding Rate ─────────────────────────────────────────────────────────

    /// @notice Settle funding for an asset. Anyone can call once per FUNDING_INTERVAL.
    /// @dev Kept permissionless as a public crank, but funding is also settled
    ///      automatically whenever a position is opened/closed/liquidated, so the
    ///      mechanism no longer depends on altruistic callers.
    function settleFunding(bytes32 asset) external {
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
        _accrueFunding(asset, intervals);
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
            cumulativeFundingIndexShort[asset] -= payerCharge * int256(longOI) / int256(shortOI);
        } else {
            // Shorts crowded → shorts pay, longs receive.
            cumulativeFundingIndexShort[asset] += payerCharge;
            cumulativeFundingIndexLong[asset]  -= payerCharge * int256(shortOI) / int256(longOI);
        }

        emit FundingSettled(
            asset, rateBps, cumulativeFundingIndexLong[asset], cumulativeFundingIndexShort[asset]
        );
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

    function getUnrealizedPnL(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return pos.realizedPnL;
        return _calcPnL(pos);
    }

    function getPositionValue(uint256 positionId) external view returns (uint256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;
        int256 val = int256(pos.margin) + _calcPnL(pos);
        return val > 0 ? uint256(val) : 0;
    }

    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    /// @notice N3: effective max leverage for an asset (override or global).
    function maxLeverageForAsset(bytes32 asset) external view returns (uint256) {
        return _maxLeverage(asset);
    }

    /// @notice N3: effective maintenance-margin bps for an asset (override or global).
    function maintenanceMarginBpsForAsset(bytes32 asset) external view returns (uint256) {
        return _maintenanceMarginBps(asset);
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
            equity     += int256(p.margin) + _calcPnL(p) - _calcFunding(p);
            maintenance += (p.margin * p.leverage) * _maintenanceMarginBps(p.asset) / 10000;
        }
    }

    function _maxLeverage(bytes32 asset) internal view returns (uint256) {
        uint256 o = maxLeverageOf[asset];
        return o == 0 ? MAX_LEVERAGE : o;
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
        usdc.approve(address(insuranceVault), cut);
        insuranceVault.depositFromProtocol(cut);
        emit VaultFeeRouted(cut, cumulativeVaultFees);
    }

    /// @dev Oracle returns 8-decimal price; scales to 18 dec and reverts on stale data.
    ///      Used in every state-changing path (open / close / liquidate).
    function _freshPrice(bytes32 asset) internal view returns (uint256) {
        (uint256 rawPrice, uint256 updatedAt) = oracle.getPrice(asset);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(asset, updatedAt);
        return rawPrice * 1e10;
    }

    function _requireFresh(bytes32 asset) internal view {
        (, uint256 updatedAt) = oracle.getPrice(asset);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(asset, updatedAt);
    }

    function _openPosition(
        address owner,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) internal returns (uint256 positionId) {
        if (margin < MIN_MARGIN)                       revert MarginTooLow();
        if (leverage == 0 || leverage > _maxLeverage(asset)) revert InvalidLeverage();

        // RWA compliance: gated only when both the asset is flagged and a KYC
        // registry is wired (otherwise this is a no-op for backward compat).
        if (rwaAsset[asset] && address(kyc) != address(0) && !kyc.isVerified(owner)) {
            revert NotKycVerified(owner);
        }

        // Settle any pending funding BEFORE locking the entry index,
        // so the new position is not charged for pre-open accrual.
        _pokeFunding(asset);

        uint256 notional   = margin * leverage;
        uint256 tradingFee = notional * TRADING_FEE_BPS / 10000;

        if (freeMargin[owner] < margin + tradingFee)   revert InsufficientFreeMargin();

        // oracle returns 8-decimal price; scale to 18 dec for internal accounting
        uint256 entryPrice = _freshPrice(asset);

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
                : cumulativeFundingIndexShort[asset]
        });
        userPositions[owner].push(positionId);
        assetPositionIds[asset].push(positionId); // N2: per-asset index for ADL

        emit PositionOpened(positionId, owner, asset, isLong, entryPrice, margin, leverage);

        // N1: route the LP share of this open's trading fee into the vault.
        _routeVaultFee(tradingFee);
    }

    function _closePosition(address caller, uint256 positionId) internal {
        Position storage pos = positions[positionId];
        if (caller != pos.owner) revert NotPositionOwner();
        if (!pos.isOpen)         revert PositionAlreadyClosed();

        // Settle funding up to now so the position pays/receives the full accrual.
        _pokeFunding(pos.asset);
        _requireFresh(pos.asset);

        int256 pnl = _calcPnL(pos);

        // DeFi Mechanics: Trading Fee (Uniswap) + Borrow Fee (Aave)
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * TRADING_FEE_BPS / 10000;

        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * BORROW_FEE_BPS_PER_HOUR * hoursElapsed / 10000;

        int256 totalFees      = int256(tradingFee + borrowFee);
        int256 fundingPayment = _calcFunding(pos); // positive = trader pays, negative = trader receives
        int256 closeAmount    = int256(pos.margin) + pnl - totalFees - fundingPayment;

        bool needsBailout = false;
        uint256 bailoutFloor;
        if (closeAmount < 0) {
            if (address(insuranceVault) != address(0)) {
                needsBailout = true;
                bailoutFloor = pos.margin * BAILOUT_FLOOR_BPS / 10_000;
            }
            closeAmount = 0;
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

        freeMargin[pos.owner] += uint256(closeAmount);

        // ── Interactions ──────────────────────────────────────────────────────
        if (needsBailout) {
            try insuranceVault.bailout(bailoutFloor, pos.owner) { } catch { }
        }

        if (perfFee > 0) {
            usdc.transfer(address(feeRouter), perfFee);
            feeRouter.receivePerformanceFee(pos.copiedFrom, perfFee);
            emit PerformanceFeePaid(positionId, pos.copiedFrom, perfFee);
        }

        // N1: route the LP share of this close's trading fee into the vault.
        _routeVaultFee(tradingFee);

        emit PositionClosed(positionId, pos.owner, pnl, uint256(closeAmount));
    }

    /// PnL math (all values in 18-decimal USDC):
    ///   notional    = margin × leverage
    ///   size        = notional × 1e18 / entryPrice   (qty of asset, 18-dec fixed-point)
    ///   priceChange = currentPrice - entryPrice
    ///   pnl         = priceChange × size / 1e18
    ///   if short:   pnl = -pnl
    function _calcPnL(Position storage pos) internal view returns (int256) {
        (uint256 rawPrice,) = oracle.getPrice(pos.asset);
        // Value PnL (and therefore liquidation) on the mark price, not the raw
        // index, so OI imbalance is reflected the way a real perp does.
        uint256 currentPrice = _markPrice(pos.asset, rawPrice * 1e10);

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
        uint256 cap = markPremiumCapBps;
        if (cap == 0) return indexPrice;

        uint256 longOI  = globalLongNotional[asset];
        uint256 shortOI = globalShortNotional[asset];
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
