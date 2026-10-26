// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./PerpetualExchange.sol";
import "./StrategyRegistry.sol";

interface IFeeRouterCopy {
    function distributeCopyFee(address trader, uint256 fee) external;
}

interface ITraderStakeForCT {
    function slash(address trader, uint256 amount, address recipient) external;
    function stakedAmount(address trader) external view returns (uint256);
}

contract CopyTracker is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;   // M-4

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant COPY_FEE_BPS      = 30;    // 0.3 % of totalMargin
    uint256 public constant SLASH_TRIGGER_BPS  = 3000;  // 30 % loss triggers slash
    uint256 public constant SLASH_RATIO_BPS    = 5000;  // slash 50 % of loss
    uint256 public constant MAX_SLASH_BPS      = 5000;  // cap: max 50 % of trader stake

    /// @notice 自動同步（ADR-024）：跟隨者願意付給第三方執行者的單次小費上限。
    ///         Base 上一筆同步（平 3 腿、開 3 腿）的 gas 費遠低於此值；上限只是
    ///         防止前端或跟隨者手誤填入一個會把油箱一次掏空的數字。
    uint256 public constant MAX_TIP_WEI        = 0.001 ether;
    /// @notice 跟隨者自設的槓桿上限不得超過交易所的全域上限（PerpetualExchange.MAX_LEVERAGE）。
    uint8   public constant MAX_SYNC_LEVERAGE  = 5;
    /// @notice 開啟自動同步時 `minSyncInterval` 的下限。StrategyRegistry 不限制發版頻率，
    ///         冷卻若可以是 0，交易者就能在同一個區塊裡反覆「發新版 → 自己呼叫 resyncFor」，
    ///         每一輪都讓跟隨者全平再開、付兩次交易費，小費也進了交易者口袋。下限讓第三方
    ///         同步每筆跟單每小時至多一次（與前端最短的選項一致）；更長的間隔由跟隨者自己設定。
    ///         本人手動同步不受此限。
    uint32  public constant MIN_SYNC_INTERVAL  = 1 hours;

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20             public immutable usdc;
    PerpetualExchange  public immutable exchange;
    StrategyRegistry   public immutable registry;
    IFeeRouterCopy     public immutable feeRouter;    // address(0) = fee disabled
    ITraderStakeForCT  public immutable traderStake;  // address(0) = slash disabled

    // ── Data types ───────────────────────────────────────────────────────────

    struct CopyRecord {
        address   trader;
        uint256   versionId;
        uint256   initialAmount;
        uint256[] positionIds;
        uint256   copiedAt;
        bool      active;
        /// @notice Low: margin actually put at risk in the copied positions,
        ///         i.e. `initialAmount` less the copy fee and the exchange's
        ///         trading-fee buffer. The slash trigger measures performance
        ///         against THIS, not against the gross deposit — otherwise
        ///         protocol fees were scored as the trader's losses and a
        ///         perfectly flat market registered a loss on every follow.
        uint256   deployedAmount;
    }

    /// @notice 自動同步設定（每個 follower 的每筆跟單各一份），只有 follower 本人能改。
    /// @dev    放在獨立 mapping，`CopyRecord` 與 `getCopyRecords` 的 ABI 不變。
    struct SyncConfig {
        /// 開啟後任何人都能呼叫 `resyncFor`，把部位調成交易者鏈上最新版。
        bool    autoSync;
        /// 跟隨者自己的槓桿上限（1..5；關閉時 0 = 不另設上限，只用於本人手動同步）。
        uint8   maxLeverage;
        /// 第三方執行的冷卻秒數：距上次同步（從未同步則為跟單當下）不足此值時，
        /// 第三方不能同步（本人不受限）。開啟時 ≥ MIN_SYNC_INTERVAL。見 `syncReadyAt`。
        uint32  minSyncInterval;
        /// 第三方執行成功時，從油箱付給執行者的小費（≤ MAX_TIP_WEI）。
        uint96  tipWei;
    }

    /// @notice 每筆跟單的同步紀錄與跨版本計分。
    struct SyncState {
        uint64  lastSyncedAt;     // 0 = 從未同步
        uint32  syncCount;
        /// 黏著旗標：任何一次同步時發現 follower 自己平過某條腿，就永久免除計分
        /// （與 `unfollowAndCloseAll` 的規則相同，不能因為換版而被洗掉）。
        bool    followerClosed;
        /// 第一次同步時記下的「第一輪」計分基準（跟隨者原始投入、實際承擔風險的保證金）。
        /// 之後的輪次不再累加：累加會讓基準隨每次換版膨脹、把虧損比例稀釋掉，
        /// 交易者就能靠頻繁發版讓 30% 的觸發門檻失效。
        uint256 scoredBasis;
        /// 所有已同步輪次的計分腿實現損益累計（逐腿下限 −margin，見 `_scoredLegPnl`）。
        int256  scoredRealized;
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(address => CopyRecord[]) public copyRecords;
    mapping(address => address[])    public followersByTrader;

    /// @notice Slashed trader stake held by this contract (see
    ///         `_slashToReserve`). Only `withdrawSlashReserve` releases it.
    uint256 public slashReserve;

    /// @notice follower => recordIdx => 自動同步設定。
    mapping(address => mapping(uint256 => SyncConfig)) public syncConfig;
    /// @dev follower => recordIdx => 同步紀錄；以 `getSyncState` 讀取。
    mapping(address => mapping(uint256 => SyncState))  internal _syncState;
    /// @notice follower 預存的 ETH「油箱」：支付同步時的 exchange.executionFee 與執行者小費。
    ///         只有 follower 本人能提領，任何時候都可以；owner 與執行者都不能提領。同步扣款
    ///         一律按「跟隨者簽名帶入」的每腿執行費上限（見 `syncExecFeeCap`、`resyncAtVersion`），
    ///         交易所 owner 搶先調高 executionFee 也扣不到超出同意的部分。
    mapping(address => uint256) public syncGasBalance;
    /// @notice Σ syncGasBalance。不變量：address(this).balance >= totalSyncGas。
    uint256 public totalSyncGas;
    /// @notice follower => recordIdx => 油箱按這筆跟單付「每條腿執行費」的同意上限。`executionFee`
    ///         是交易所 owner 可調的參數（上限 1 ETH／腿），執行費又由 owner 提領；沒有上限，owner
    ///         調高費率後一次同步就能把油箱扣光。
    ///         同意值來自跟隨者**簽名帶入**的 `maxExecFeePerLeg`（`setAutoSync`／
    ///         `followTraderAtVersionWithAutoSync`），不是「交易執行當下」從交易所讀到的費率：
    ///         交易所現行費率高於簽名值，該筆交易整筆 revert `ExecutionFeeAboveCap`，所以 owner
    ///         在同一個區塊搶先調高費率，只會讓跟隨者的交易失敗，不會被記成同意值。成功時記下
    ///         當下費率（= min(簽名值, 當下費率)）。
    ///         `resyncFor` 從油箱扣款時現行費率高於此值就 revert `ExecutionFeeAboveCap`；本人經
    ///         `resyncFor` 同步時，附帶的 `msg.value` 足以付清全部成本則不受此限（不動用油箱既有餘額）。
    ///         `resyncAtVersion` 則用呼叫當下簽名帶入的上限。關閉自動同步時為 0。
    /// @dev    獨立 mapping：`SyncConfig`、`syncConfig` getter 與 `AutoSyncSet` 事件的 ABI 不變。
    mapping(address => mapping(uint256 => uint256)) public syncExecFeeCap;
    /// @notice follower => recordIdx => 指定執行者（personal 模式）。非 0 時，除了 follower 本人，只有這個
    ///         地址能呼叫 `resyncFor`；0 = 開啟自動同步後任何人都能呼叫。只有 follower 本人能設定
    ///         （`setSyncExecutor`）；開關自動同步不會清掉它（關掉再開，限制仍在），跟單結束時清除。
    ///         它只收窄「誰能按」：自動同步仍要開啟，冷卻、小費、執行費上限照舊適用於指定的執行者。
    /// @dev    獨立 mapping：`SyncConfig`、`syncConfig` getter 與 `AutoSyncSet` 事件的 ABI 不變。
    mapping(address => mapping(uint256 => address)) public syncExecutor;

    // ── Events ───────────────────────────────────────────────────────────────

    event TraderFollowed(
        address indexed follower,
        address indexed trader,
        uint256         versionId,
        uint256         totalMargin
    );
    event TraderUnfollowed(
        address indexed follower,
        address indexed trader,
        uint256         recordIdx
    );
    event TraderSlashed(
        address indexed trader,
        address indexed follower,
        uint256         slashAmount
    );
    /// @notice H-5: a copied position could not be closed on unfollow (already
    ///         liquidated / deleveraged). Emitted instead of reverting.
    event PositionCloseSkipped(address indexed follower, uint256 indexed positionId);
    /// @notice The follower closed at least one leg of this record themselves,
    ///         so the record was released without scoring the trader.
    event SlashScoringWaived(address indexed follower, uint256 indexed recordIdx);
    /// @notice A slash was due but TraderStake refused it (e.g. the stake was
    ///         withdrawn meanwhile); the unfollow completed without it.
    event SlashFailed(address indexed trader, address indexed follower, uint256 amount);
    /// @notice The owner moved `amount` of the slash reserve to `to`.
    event SlashReserveWithdrawn(address indexed to, uint256 amount);
    /// @notice The follower released a record without closing its legs and
    ///         without scoring the trader (see `deactivateWithoutScoring`).
    event RecordDeactivatedWithoutScoring(address indexed follower, uint256 indexed recordIdx);
    /// @notice 跟隨者開啟／關閉／修改自動同步設定（跟單結束時若原本開著，會以 enabled=false 再發一次）。
    event AutoSyncSet(
        address indexed follower,
        uint256 indexed recordIdx,
        bool            enabled,
        uint8           maxLeverage,
        uint32          minSyncInterval,
        uint96          tipWei
    );
    /// @notice 跟隨者指定（或清除：`executor` = 0）這筆跟單唯一的第三方執行者。跟單結束時若原本有指定，
    ///         會以 executor = 0 再發一次。
    event SyncExecutorSet(address indexed follower, uint256 indexed recordIdx, address indexed executor);
    /// @notice ETH 存進 `follower` 的同步油箱（存入者可能是 follower 本人或任何代付者）。
    event SyncGasDeposited(address indexed follower, uint256 amount);
    /// @notice follower 從自己的同步油箱提領。
    event SyncGasWithdrawn(address indexed follower, uint256 amount);
    /// @notice 跟單部位已調成交易者的 `toVersion`。`redeployedMargin` 是新腿保證金合計
    ///         （= 新的 deployedAmount，已扣交易手續費緩衝）；`legs` 是新腿數。
    event Resynced(
        address indexed follower,
        uint256 indexed recordIdx,
        address indexed trader,
        uint256         fromVersion,
        uint256         toVersion,
        address         executor,
        uint256         redeployedMargin,
        uint256         legs
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error NoStrategyPublished();
    error InvalidRecordIndex();
    error RecordAlreadyInactive();
    error TradingFeeExceedsMargin(uint256 fee, uint256 margin);
    /// @notice A copied position could not be closed on unfollow and is still
    ///         open (exchange paused, asset halted, stale price, ...).
    error PositionStillOpen(uint256 positionId);
    error InvalidSlashWithdrawal();
    /// @notice M10: the trader's latest strategy is not the version the
    ///         follower signed up for (it was re-published in between).
    error StrategyVersionMismatch(uint256 expected, uint256 actual);
    /// @notice M2: the trader is no longer eligible (stake below minimum, or
    ///         an unstake request pending) — no NEW follows.
    error TraderNotEligible(address trader);
    /// @notice Ownership can be transferred (e.g. to the timelock) but never
    ///         renounced: the slash reserve would be stranded forever.
    error RenounceOwnershipDisabled();
    /// @notice 呼叫者不是 follower 本人，而 follower 沒有開啟自動同步。
    error AutoSyncDisabled();
    /// @notice follower 為這筆跟單指定了執行者 `executor`，呼叫者既不是他、也不是 follower 本人。
    error NotSyncExecutor(address executor);
    /// @notice 這筆跟單已是交易者鏈上最新版（或更新），沒有東西可同步。
    error AlreadySynced(uint256 recordVersion, uint256 latestVersion);
    /// @notice 第三方同步仍在冷卻中，`readyAt` 之後才能再同步。
    error SyncCooldown(uint256 readyAt);
    /// @notice 油箱餘額不足以支付這次同步（或提領金額超過餘額）。
    error InsufficientSyncGas(uint256 required, uint256 available);
    /// @notice `followTraderAtVersionWithAutoSync` 附帶的 ETH 不夠付這次開倉的執行費
    ///         （exchange.executionFee × 腿數）。與油箱無關：這時還沒有跟單紀錄、也還沒有
    ///         任何同步，所以不沿用 `InsufficientSyncGas`。
    error InsufficientExecutionFee(uint256 required, uint256 sent);
    /// @notice 油箱提領的收款地址不能是 0（ETH 會被燒掉）。
    error InvalidRecipient();
    /// @notice 自動同步設定超出範圍（開啟時槓桿 1..5、冷卻 ≥ MIN_SYNC_INTERVAL；小費 ≤ MAX_TIP_WEI）。
    error InvalidSyncConfig();
    /// @notice 交易所現行的 executionFee 高於跟隨者同意的每腿費率 `cap`：簽名帶入的上限
    ///         （`setAutoSync`、`followTraderAtVersionWithAutoSync`、`resyncAtVersion`），或已記下的
    ///         `syncExecFeeCap`（`resyncFor`）。整筆 revert，油箱不動。跟隨者看過新費率後重新
    ///         `setAutoSync`（帶入新上限）或以新上限手動同步。
    error ExecutionFeeAboveCap(uint256 fee, uint256 cap);
    /// @notice 平倉沒有釋出任何保證金（所有腿都已不在），沒有可重新部署的資金。
    error NothingToRedeploy();
    /// @notice 平倉過程動到了這筆跟單以外的部位（例如壞帳觸發 ADL 平掉 follower 的其他部位）；
    ///         此時保證金差額不再只代表這筆跟單，整筆退回，待清算處理後再同步。
    error SyncDisturbedOtherPositions();
    error EthTransferFailed();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _usdc,
        address _exchange,
        address _registry,
        address _feeRouter,    // pass address(0) to disable copy fee
        address _traderStake   // pass address(0) to disable slashing
    ) Ownable(msg.sender) {
        usdc        = IERC20(_usdc);
        exchange    = PerpetualExchange(_exchange);
        registry    = StrategyRegistry(_registry);
        feeRouter   = IFeeRouterCopy(_feeRouter);
        traderStake = ITraderStakeForCT(_traderStake);
    }

    // ── Core functions ───────────────────────────────────────────────────────

    /// @notice Copy `trader`'s LATEST published strategy with `totalMargin`.
    /// @dev M10 — front-running risk: the allocations are read at execution
    ///      time, not when the follower looked at them. The trader (or anyone
    ///      colluding with them) can publish a new version — different assets,
    ///      directions, 5x leverage — in the same block, ahead of the
    ///      follower's transaction, and this call will copy that one instead.
    ///      Kept for backward compatibility with existing integrations; new
    ///      callers should use `followTraderAtVersion`, which pins the version.
    function followTrader(address trader, uint256 totalMargin) external payable nonReentrant {
        _follow(trader, totalMargin, false, 0, 0, false);
    }

    /// @notice M10: `followTrader`, but reverts `StrategyVersionMismatch`
    ///         unless the trader's latest strategy is still `expectedVersion`
    ///         (the `versionId` the follower reviewed, from
    ///         `registry.getLatestStrategy`). A re-publish between review and
    ///         execution makes the follow fail instead of silently copying
    ///         allocations the follower never saw.
    function followTraderAtVersion(address trader, uint256 totalMargin, uint256 expectedVersion)
        external payable nonReentrant
    {
        _follow(trader, totalMargin, true, expectedVersion, 0, false);
    }

    /// @notice 一筆交易完成「釘版本跟單＋開啟自動同步＋預存油箱」（ADR-024）。
    ///         `msg.value` 先剛好支付開倉的 executionFee × 腿數，剩下全部存進
    ///         follower 的同步油箱（隨時可用 `withdrawSyncGas` 提領）。
    ///         `maxLeverage` 也套用在這次開倉：它是跟隨者自己的風險上限。
    /// @param maxExecFeePerLeg 跟隨者同意的每腿執行費上限（前端帶入畫面上顯示的 executionFee）。
    ///         交易所現行費率高於它就整筆 revert `ExecutionFeeAboveCap`：owner 在同一個區塊搶先
    ///         調高費率，不能把預存油箱的 ETH 當成開倉執行費收走，也不能被記成之後同步的同意值。
    /// @dev    只讓自己的 agent 執行（`setSyncExecutor`）要另送一筆：冷卻從跟單當下起算、而且
    ///         ≥ MIN_SYNC_INTERVAL，所以兩筆之間沒有任何第三方能同步這筆跟單。
    function followTraderAtVersionWithAutoSync(
        address trader,
        uint256 totalMargin,
        uint256 expectedVersion,
        uint8   maxLeverage,
        uint32  minSyncInterval,
        uint96  tipWei,
        uint256 maxExecFeePerLeg
    ) external payable nonReentrant {
        // 先檢查同意的費率（`_setSyncConfig` 會再檢查一次並記下），失敗時回報的是費率而不是
        // 「附帶的 ETH 不夠」。
        _consentedExecFee(maxExecFeePerLeg);
        (uint256 recordIdx, uint256 feeSpent) =
            _follow(trader, totalMargin, true, expectedVersion, maxLeverage, true);
        _setSyncConfig(msg.sender, recordIdx, true, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg);
        _creditSyncGas(msg.sender, msg.value - feeSpent);
    }

    /// @param levCap    跟隨者自設槓桿上限（0 = 不另設）。
    /// @param exactFee  true：每條腿剛好付 exchange.executionFee，剩餘 ETH 由呼叫端處理
    ///                  （存進油箱）；false：沿用舊行為，msg.value 平均分給每條腿、餘數退回。
    function _follow(
        address trader,
        uint256 totalMargin,
        bool    pinVersion,
        uint256 expectedVersion,
        uint256 levCap,
        bool    exactFee
    ) internal returns (uint256 recordIdx, uint256 feeSpent) {
        // 1. Fetch latest published strategy
        (StrategyRegistry.Allocation[] memory allocations, uint256 versionId) =
            registry.getLatestStrategy(trader);
        if (allocations.length == 0) revert NoStrategyPublished();
        if (pinVersion && versionId != expectedVersion) revert StrategyVersionMismatch(expectedVersion, versionId);
        // M2: eligibility is checked at publish AND at follow — a trader who
        // has since asked for their stake back (or been slashed below the
        // minimum) keeps existing followers but takes no new ones.
        if (!registry.isEligibleTrader(trader)) revert TraderNotEligible(trader);

        uint256 feePerPosition = exactFee ? exchange.executionFee() : msg.value / allocations.length;
        feeSpent = feePerPosition * allocations.length;
        if (feeSpent > msg.value) revert InsufficientExecutionFee(feeSpent, msg.value);

        // 2. Pull USDC from follower → CopyTracker
        usdc.safeTransferFrom(msg.sender, address(this), totalMargin);

        // 3. Deduct copy fee when feeRouter is configured
        uint256 netMargin = totalMargin;
        if (address(feeRouter) != address(0)) {
            uint256 fee = totalMargin * COPY_FEE_BPS / 10_000;
            netMargin   = totalMargin - fee;
            usdc.forceApprove(address(feeRouter), fee);
            feeRouter.distributeCopyFee(trader, fee);
        }

        // 4. Calculate total trading fee buffer (exchange deducts tradingFee per position).
        //    Leverage is clamped per leg first (strategy vs the asset's current
        //    exchange ceiling vs the follower's own cap) — a 5x allocation on a
        //    high-carbon asset capped at 1x used to revert the whole follow.
        uint256[] memory levs = _legLeverages(allocations, levCap);
        uint256 totalTradingFee = _totalTradingFee(allocations, levs, netMargin);
        if (totalTradingFee >= netMargin) revert TradingFeeExceedsMargin(totalTradingFee, netMargin);
        uint256 marginForPositions = netMargin - totalTradingFee;

        // 5. Approve exchange to pull full netMargin (margin budget + tradingFee budget)
        usdc.forceApprove(address(exchange), netMargin);

        // 6. Deposit on behalf of follower
        exchange.depositMarginFor(msg.sender, netMargin);

        // 7. Open one position per allocation; portion based on marginForPositions
        uint256[] memory ids =
            _openLegs(msg.sender, trader, allocations, levs, marginForPositions, feePerPosition);

        // 8. Persist copy record
        copyRecords[msg.sender].push();
        recordIdx = copyRecords[msg.sender].length - 1;
        CopyRecord storage rec = copyRecords[msg.sender][recordIdx];
        rec.trader        = trader;
        rec.versionId     = versionId;
        rec.initialAmount  = totalMargin;
        rec.deployedAmount = marginForPositions;
        rec.copiedAt       = block.timestamp;
        rec.active        = true;
        for (uint256 i; i < ids.length; ++i) {
            rec.positionIds.push(ids[i]);
        }

        followersByTrader[trader].push(msg.sender);

        // Low: `msg.value / allocations.length` leaves an ETH remainder that this
        // contract had no way to ever pay out (there is no withdrawal function
        // and no owner), so it was permanently stuck. Return it to the follower.
        // (exactFee: the caller books the remainder into the sync gas tank.)
        if (!exactFee) {
            uint256 dust = msg.value - feeSpent;
            if (dust > 0) {
                (bool ok, ) = msg.sender.call{value: dust}("");
                require(ok, "ETH refund failed");
            }
        }

        emit TraderFollowed(msg.sender, trader, versionId, totalMargin);
    }

    /// @notice Close every still-open leg of a copy record and, if the
    ///         trader's strategy lost at least SLASH_TRIGGER_BPS, slash them.
    /// @dev Scoring is taken from the exchange's own per-position records, not
    ///      from the follower's free-margin delta. The delta used to be the
    ///      score, and the follower controls it: closing every leg themselves
    ///      first made the delta 0, which scored as a 100% loss and paid the
    ///      follower half of it out of the trader's stake in a flat market.
    ///
    ///      Rules (all legs of the record are considered, never a subset):
    ///        • a leg closed by the follower themselves (CloseReason.Owner)
    ///          means the follower took discretionary control of the
    ///          strategy: the record is released and NOT scored at all. Any
    ///          partial scoring would let the follower choose which legs count
    ///          (self-close the winners, let the tracker close the losers);
    ///          waiving closes that particular lever, and it can only cost
    ///          the follower their own remedy;
    ///        • legs closed now by this tracker, and legs that were liquidated
    ///          or auto-deleveraged (outcomes of the strategy, not of the
    ///          follower's choices), are scored on their realized PnL
    ///          (`Position.realizedPnL`, capped, before fees and funding —
    ///          the trader is judged on the price call, not on protocol fees);
    ///        • each leg is floored at −margin and ADL legs use their pre-haircut
    ///          PnL (see `_scoredLegPnl`); basis = Σ margin of the scored legs.
    ///
    ///      Where a slash goes: into `slashReserve`, a protocol reserve held by
    ///      this contract and released only by the owner. NEVER to the
    ///      follower who triggered it, and NEVER into a pool that pays out
    ///      pro rata (such as the InsuranceVault): anyone — the follower
    ///      included — could deposit into such a pool just before unfollowing
    ///      and take back their share of the slash (all of it into an empty
    ///      vault). The score is still not manipulation-proof — a follower can
    ///      push the mark against their own copied legs with an opposite
    ///      position (the premium is capped, but at 5x it can move a leg by
    ///      ~10% of margin) and tip a 20% loss over the 30% trigger — but no
    ///      one can receive the slash by forcing it, so doing so only costs
    ///      fees. Copy trading ships disabled by default in the commercial
    ///      build.
    ///      A leg that is still open and cannot be closed now (exchange
    ///      paused, asset halted, stale price, tracker replaced) reverts
    ///      `PositionStillOpen`; `deactivateWithoutScoring` is the exit.
    ///
    ///      自動同步（ADR-024）之後的計分：基準是第一輪的計分基準
    ///      （`SyncState.scoredBasis`），損益是「各次同步已累計的實現損益＋目前這輪的腿」，
    ///      follower 自平旗標是黏著的。交易者不能靠發新版把舊版的虧損洗掉，
    ///      也不能靠換版膨脹基準來稀釋虧損比例。
    function unfollowAndCloseAll(uint256 recordIdx) external nonReentrant {
        CopyRecord storage rec = _activeRecord(msg.sender, recordIdx);

        (uint256 basis, int256 realized, bool followerClosed, ) = _closeAndScore(msg.sender, rec.positionIds);

        SyncState storage st = _syncState[msg.sender][recordIdx];
        if (st.syncCount != 0) {
            basis     = st.scoredBasis;
            realized += st.scoredRealized;
        }
        if (st.followerClosed) followerClosed = true;

        if (followerClosed) {
            emit SlashScoringWaived(msg.sender, recordIdx);
        } else if (address(traderStake) != address(0) && basis != 0 && realized < 0) {
            uint256 loss = SafeCast.toUint256(-realized);   // realized < 0 checked above
            if (loss > basis) loss = basis;      // a follower never loses more than the margin scored
            {
                uint256 lossBps = loss * 10_000 / basis;
                if (lossBps >= SLASH_TRIGGER_BPS) {
                    uint256 staked   = traderStake.stakedAmount(rec.trader);
                    // slash = 50% of loss, capped at MAX_SLASH_BPS of stake
                    uint256 slashAmt = loss * SLASH_RATIO_BPS / 10_000;
                    uint256 cap      = staked * MAX_SLASH_BPS / 10_000;
                    if (slashAmt > cap) slashAmt = cap;
                    if (slashAmt > 0) _slashToReserve(rec.trader, slashAmt);
                }
            }
        }

        rec.active = false;
        _clearAutoSync(msg.sender, recordIdx);

        emit TraderUnfollowed(msg.sender, rec.trader, recordIdx);
    }

    /// @dev Closes every still-open leg in `ids` for `follower` and scores the
    ///      record's legs (shared by `unfollowAndCloseAll` and `resyncFor`):
    ///        • legs closed now by this tracker, and legs that were liquidated
    ///          or auto-deleveraged, add their margin to `basis` and their
    ///          `_scoredLegPnl` to `realized`;
    ///        • a leg the follower closed themselves sets `followerClosed` and
    ///          is not scored (see `unfollowAndCloseAll`).
    ///      `closedNow` counts the legs this call actually closed.
    function _closeAndScore(address follower, uint256[] storage ids)
        internal
        returns (uint256 basis, int256 realized, bool followerClosed, uint256 closedNow)
    {
        // H-5: a position that was already liquidated (or auto-deleveraged)
        // reverts PositionAlreadyClosed. Unguarded, that single revert bricked
        // the whole record forever: `rec.active` stayed true, the follower could
        // never unfollow, and — worse — the slash that the loss should have
        // triggered could never fire. Exactly the scenario slashing exists for.
        // Failing to close an already-closed position is a no-op, not an error.
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (exchange.getPosition(id).isOpen) {
                // A still-open leg that cannot be closed now failed for a
                // transient or structural reason (paused, halted, stale price,
                // tracker replaced). Scoring it — or silently dropping it —
                // would misjudge the trader, so refuse.
                try exchange.closePositionFor(follower, id) {
                    ++closedNow; // closed by this tracker; scored below
                } catch {
                    revert PositionStillOpen(id);
                }
            } else {
                // H-5: already settled before this call.
                emit PositionCloseSkipped(follower, id);
                if (exchange.closeReasonOf(id) == PerpetualExchange.CloseReason.Owner) {
                    followerClosed = true;
                    continue;
                }
            }
            PerpetualExchange.Position memory p = exchange.getPosition(id);
            basis    += p.margin;
            realized += _scoredLegPnl(id, p);
        }
    }

    /// @dev One leg's contribution to the trader's score:
    ///        • ADL legs are scored BEFORE the haircut (a solvency levy on the
    ///          winner, not a result of the trader's call);
    ///        • each leg is floored at −margin before summing, so a leg that
    ///          went into bad debt counts as a total loss of that leg, not
    ///          more — one blown-up leg cannot overweight the others.
    function _scoredLegPnl(uint256 id, PerpetualExchange.Position memory p) internal view returns (int256 pnl) {
        pnl = p.realizedPnL;
        if (exchange.closeReasonOf(id) == PerpetualExchange.CloseReason.Deleveraged) {
            // try: an exchange deployed before `adlHaircutOf` existed has no
            // such getter; fall back to 0 (score net of the haircut) rather
            // than bricking unfollow.
            try exchange.adlHaircutOf(id) returns (uint256 haircut) {
                pnl += SafeCast.toInt256(haircut);
            } catch {}
        }
        int256 floor = -SafeCast.toInt256(p.margin);
        if (pnl < floor) pnl = floor;
    }

    /// @dev Moves `amount` of `trader`'s stake into this contract and books it
    ///      in `slashReserve`. A single try: the reserve is credited only if
    ///      TraderStake's call succeeded, and only with the USDC that actually
    ///      ARRIVED (balance after − before), never the nominal `amount` — a
    ///      stake contract that transfers less (fee-on-transfer token, a
    ///      partial or no-op implementation) must not leave `slashReserve`
    ///      promising USDC the tracker does not hold, which would make
    ///      `withdrawSlashReserve` revert or pay out other funds. The only
    ///      external calls on the success path are `usdc.balanceOf` reads.
    ///      A refused slash is reported (`SlashFailed`), never retried or
    ///      reverted. `TraderSlashed.follower` is the account whose unfollow
    ///      triggered the slash, not a recipient.
    function _slashToReserve(address trader, uint256 amount) internal {
        uint256 before = usdc.balanceOf(address(this));
        try traderStake.slash(trader, amount, address(this)) {
            uint256 afterBal = usdc.balanceOf(address(this));
            uint256 received = afterBal > before ? afterBal - before : 0;
            slashReserve += received;
            emit TraderSlashed(trader, msg.sender, received);
        } catch {
            emit SlashFailed(trader, msg.sender, amount);
        }
    }

    /// @notice Disabled. Ownership may move (e.g. to the governance
    ///         timelock), but an ownerless tracker would lock `slashReserve`
    ///         forever — `withdrawSlashReserve` is the only way it ever leaves.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @notice Release slashed stake held in `slashReserve` (e.g. to a
    ///         compensation programme or the treasury). Owner only; the
    ///         reserve is kept out of every pro-rata pool on purpose (see
    ///         `unfollowAndCloseAll`).
    function withdrawSlashReserve(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || amount > slashReserve) revert InvalidSlashWithdrawal();
        slashReserve -= amount;
        usdc.safeTransfer(to, amount);
        emit SlashReserveWithdrawn(to, amount);
    }

    /// @notice Release a copy record without closing its legs and without
    ///         scoring the trader. The exit for a record whose legs this
    ///         tracker cannot close (asset halted indefinitely, feed dead,
    ///         tracker replaced by the owner): the positions stay the
    ///         follower's own and remain closable via `exchange.closePosition`.
    ///         Always available to the follower because it can only forgo the
    ///         follower's own slash remedy, never harm the trader.
    function deactivateWithoutScoring(uint256 recordIdx) external nonReentrant {
        CopyRecord storage rec = _activeRecord(msg.sender, recordIdx);
        rec.active = false;
        _clearAutoSync(msg.sender, recordIdx);
        emit RecordDeactivatedWithoutScoring(msg.sender, recordIdx);
        emit TraderUnfollowed(msg.sender, rec.trader, recordIdx);
    }

    // ── Auto-sync（ADR-024）────────────────────────────────────────────────
    //
    // 權限模型（全部由合約強制，不靠執行者程式自律）：
    //   • 只有 follower 本人能開關自動同步、改設定、指定執行者、存提油箱；
    //   • 開啟後任何人都能呼叫 `resyncFor`（follower 指定了執行者時只有那個地址），但它只能
    //     把部位調成「交易者鏈上最新版」：資產、方向、權重來自 StrategyRegistry，槓桿是三者
    //     取小，保證金只用這次平倉釋出的金額。呼叫者唯一能選的是「何時」（且受冷卻限制），
    //     因此跟隨者不需要信任呼叫者——與無需許可的清算同一個道理；
    //   • 任一新腿開不起來（RWA 未 KYC、市場 ReduceOnly／Halted、OI 上限…）整筆 revert，
    //     部位維持舊版，不做部分同步；
    //   • 平台、owner、執行者都碰不到跟隨者的 USDC 與油箱；同步時油箱只付「不高於跟隨者
    //     簽名帶入的每腿費率上限的 executionFee」與跟隨者自己設定的小費——上限是跟隨者
    //     交易參數的一部分，不是執行當下才讀的交易所費率，owner 搶先調費只會讓交易失敗；
    //   • 第三方同步之間至少隔跟隨者設定的冷卻，冷卻本身不得低於 MIN_SYNC_INTERVAL。
    //
    // 剩下的信任面只有「時機」：第三方可以挑價格對跟隨者不利的時刻觸發（甚至先用自己的
    // 大部位推動 mark 溢價再同步）；交易者也決定何時發版、因而決定跟隨者的腿何時實現
    // （績效費以單一部位計、沒有高水位線）。損害受 mark 溢價上限（markPremiumCapBps）與
    // 冷卻約束——冷卻限制的是頻率，不是每一輪的金額——且攻擊者要自付手續費。不想把時機
    // 交給第三方的跟隨者有兩條路：用 `setSyncExecutor` 只讓自己的 agent（另一把熱錢包）執行
    // ——自動同步仍須開啟，其他人一律 revert `NotSyncExecutor`；或不開自動同步、收到通知後
    // 自己手動同步（`resyncAtVersion`）。交易者發版的時機仍由交易者決定，這兩條路都改不了。

    /// @notice 開啟／關閉／修改這筆跟單的自動同步。只有 follower 本人（msg.sender）。
    ///         開啟（或修改）時，跟隨者以 `maxExecFeePerLeg` 簽名同意油箱代付的每腿執行費上限；
    ///         交易所現行費率高於它就整筆 revert `ExecutionFeeAboveCap`（設定維持原狀），成功時
    ///         記下當下費率（≤ 簽名值）為 `syncExecFeeCap`。owner 之後調高費率，跟隨者看過新費率、
    ///         帶入新上限再呼叫一次，才表示同意。
    /// @param maxLeverage      開啟時 1..5；關閉時可為 0（= 本人手動同步時不另設上限）。
    /// @param minSyncInterval  第三方同步之間的最短秒數，從上次同步（從未同步則為跟單當下）
    ///                         起算；開啟時 ≥ MIN_SYNC_INTERVAL。本人手動同步不受限。
    /// @param tipWei           每次第三方同步付給執行者的小費，≤ MAX_TIP_WEI。
    /// @param maxExecFeePerLeg 開啟時：跟隨者同意的每腿執行費上限（前端帶入畫面上顯示的
    ///                         executionFee）。關閉時忽略——關閉永遠不會因為費率被擋下。
    function setAutoSync(
        uint256 recordIdx,
        bool    enabled,
        uint8   maxLeverage,
        uint32  minSyncInterval,
        uint96  tipWei,
        uint256 maxExecFeePerLeg
    ) external nonReentrant {
        _activeRecord(msg.sender, recordIdx);
        _setSyncConfig(msg.sender, recordIdx, enabled, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg);
    }

    /// @notice 存 ETH 進自己的同步油箱。
    function depositSyncGas() external payable nonReentrant {
        _creditSyncGas(msg.sender, msg.value);
    }

    /// @notice 指定這筆跟單唯一的第三方執行者（例如跟隨者自己的 agent 熱錢包）；`executor` = 0 解除限制
    ///         （回到「任何人」）。只有 follower 本人，紀錄必須仍在跟隨中。
    ///         指定之後，除了 follower 本人，只有 `executor` 能呼叫 `resyncFor`；自動同步仍要開啟，冷卻、
    ///         小費、執行費上限照舊。執行者金鑰外洩的最壞情況不變（只能觸發合約本來就允許的同步），
    ///         換一把新的再呼叫一次即可。
    function setSyncExecutor(uint256 recordIdx, address executor) external nonReentrant {
        _activeRecord(msg.sender, recordIdx);
        syncExecutor[msg.sender][recordIdx] = executor;
        emit SyncExecutorSet(msg.sender, recordIdx, executor);
    }

    /// @notice 從自己的同步油箱提領。任何時候都可以，沒有任何人能阻止或代領。
    function withdrawSyncGas(uint256 amount) external nonReentrant {
        _withdrawSyncGas(msg.sender, amount);
    }

    /// @notice 同 `withdrawSyncGas`，但把 ETH 付到 `to`。給不能收 ETH 的合約錢包跟隨者
    ///         （沒有 receive／payable fallback 的多簽、自訂 AA 錢包、EIP-7702 委派到沒有
    ///         receive 的實作）：它們一樣能存入油箱，沒有這個入口就永遠領不出來。
    ///         只扣 msg.sender 自己的餘額，所以不會讓任何人代領別人的油箱。
    function withdrawSyncGasTo(address to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        _withdrawSyncGas(to, amount);
    }

    /// @dev 扣 msg.sender 的油箱、付給 `to`（CEI：先記帳再轉帳）。
    function _withdrawSyncGas(address to, uint256 amount) internal {
        _debitSyncGas(msg.sender, amount);
        emit SyncGasWithdrawn(msg.sender, amount);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice 把 `follower` 第 `recordIdx` 筆跟單調成交易者鏈上最新版。**無需許可**：
    ///         follower 開啟自動同步後任何人都能呼叫（follower 用 `setSyncExecutor` 指定了執行者時，
    ///         只有那個地址）；follower 本人隨時都能呼叫（不收小費、不受冷卻限制）。
    ///         附帶的 `msg.value` 先存進 follower 的油箱。
    ///         執行費：從油箱扣時，交易所現行費率不得高於 `syncExecFeeCap`（跟隨者簽名同意過的
    ///         上限），否則 revert `ExecutionFeeAboveCap`；唯一例外是本人呼叫且附帶的 `msg.value`
    ///         足以付清全部成本——這時付款的是本人這筆交易看得到的 ETH，油箱既有餘額不會被動用。
    ///         本人從介面手動同步請改用 `resyncAtVersion`（釘住看過的版本與費率）。
    /// @dev    步驟：檢查 → 從油箱扣成本 → 平掉目前的腿並計分（跨輪累計）→
    ///         只用這次平倉釋出的保證金，按最新版權重、夾過的槓桿重新開倉 →
    ///         更新紀錄 → 最後付小費（CEI）。任何一步失敗整筆 revert。
    function resyncFor(address follower, uint256 recordIdx) external payable nonReentrant {
        _resync(follower, recordIdx, false, 0, 0);
    }

    /// @notice 本人手動同步，但釘住版本與費率（M10 在同步路徑上的對應）：交易者鏈上最新版必須
    ///         仍是 `expectedVersion`——跟隨者按下「立即同步」時畫面上的那一版——否則 revert
    ///         `StrategyVersionMismatch`；交易所現行的 executionFee 必須不高於 `maxExecFeePerLeg`
    ///         （畫面上顯示的費率），否則 revert `ExecutionFeeAboveCap`、油箱不動——交易所 owner
    ///         在同一個區塊搶先調高費率，不能藉這筆同步把油箱扣光。沒開自動同步的跟隨者只同意
    ///         他看過的版本與費率，不是「最新版、現行費率不管是什麼」。
    ///         只能同步自己的跟單（msg.sender 就是 follower），其餘與 `resyncFor` 的本人路徑相同：
    ///         不收小費、不受冷卻、附帶的 `msg.value` 先存進油箱。第三方路徑不需要釘版本：
    ///         開啟自動同步就是同意「交易者鏈上最新版」。
    function resyncAtVersion(uint256 recordIdx, uint256 expectedVersion, uint256 maxExecFeePerLeg)
        external payable nonReentrant
    {
        _resync(msg.sender, recordIdx, true, expectedVersion, maxExecFeePerLeg);
    }

    /// @param pinned  true：只給本人的 `resyncAtVersion`——最新版必須等於 `expectedVersion`，
    ///                執行費上限是這筆交易簽名帶入的 `maxExecFeePerLeg`。false（`resyncFor`）：
    ///                上限是已記下的 `syncExecFeeCap`。
    function _resync(
        address follower,
        uint256 recordIdx,
        bool    pinned,
        uint256 expectedVersion,
        uint256 maxExecFeePerLeg
    ) internal {
        CopyRecord storage rec = _activeRecord(follower, recordIdx);
        SyncConfig memory cfg = syncConfig[follower][recordIdx];
        SyncState storage st = _syncState[follower][recordIdx];
        bool byFollower = msg.sender == follower;
        if (!byFollower) {
            if (!cfg.autoSync) revert AutoSyncDisabled();
            address designated = syncExecutor[follower][recordIdx];
            if (designated != address(0) && designated != msg.sender) revert NotSyncExecutor(designated);
        }

        address trader = rec.trader;
        uint256 fromVersion = rec.versionId;
        (StrategyRegistry.Allocation[] memory allocations, uint256 latest) = registry.getLatestStrategy(trader);
        // 只能往「更新的版本」走：同一版本重放、陌生人亂按都無效。
        if (latest <= fromVersion) revert AlreadySynced(fromVersion, latest);
        if (pinned && latest != expectedVersion) revert StrategyVersionMismatch(expectedVersion, latest);
        // M2：與跟單相同，失去資格的交易者不能再把跟隨者的資金搬進新部位。
        if (!registry.isEligibleTrader(trader)) revert TraderNotEligible(trader);
        if (!byFollower) {
            // 冷卻：防交易者狂發版本，讓執行者反覆平倉／開倉洗掉跟隨者的手續費。
            uint256 readyAt = _syncReadyAt(rec, st, cfg);
            if (block.timestamp < readyAt) revert SyncCooldown(readyAt);
        }

        // 成本：每條新腿一份 executionFee，第三方執行再加跟隨者自訂的小費。
        uint256 execFee = exchange.executionFee();
        uint256 tip = byFollower ? 0 : cfg.tipWei;
        uint256 cost = execFee * allocations.length + tip;
        // executionFee 由交易所 owner 調整、執行費又由 owner 提領：油箱只按跟隨者簽名同意過的
        // 每腿費率付款。本人經 resyncFor 且附帶的 ETH 付得清全部成本時例外（油箱淨額不減）。
        uint256 feeCap = pinned ? maxExecFeePerLeg : syncExecFeeCap[follower][recordIdx];
        if (execFee > feeCap && (pinned || !byFollower || msg.value < cost)) {
            revert ExecutionFeeAboveCap(execFee, feeCap);
        }
        _creditSyncGas(follower, msg.value);
        _debitSyncGas(follower, cost);

        // 平倉並計分。保證金差額只算這次平倉釋出的部分，follower 其他的 freeMargin
        // 一分都不動；若平倉過程（壞帳 → ADL）連帶平掉了 follower 的其他部位，差額就
        // 混進了別的錢，整筆退回。
        uint256 freeBefore = exchange.freeMargin(follower);
        uint256 openBefore = exchange.getUserPositions(follower).length;
        (uint256 basis, int256 realized, bool followerClosed, uint256 closedNow) =
            _closeAndScore(follower, rec.positionIds);
        if (exchange.getUserPositions(follower).length + closedNow != openBefore) {
            revert SyncDisturbedOtherPositions();
        }
        uint256 released = exchange.freeMargin(follower) - freeBefore;
        if (released == 0) revert NothingToRedeploy();

        if (st.syncCount == 0) st.scoredBasis = basis;
        st.scoredRealized += realized;
        if (followerClosed) st.followerClosed = true;

        // 重新部署：槓桿 = min(策略, 交易所該資產上限, 跟隨者上限)；手續費緩衝用夾過的槓桿。
        uint256[] memory levs = _legLeverages(allocations, cfg.maxLeverage);
        uint256 totalTradingFee = _totalTradingFee(allocations, levs, released);
        if (totalTradingFee >= released) revert TradingFeeExceedsMargin(totalTradingFee, released);
        uint256 marginForPositions = released - totalTradingFee;
        uint256[] memory ids = _openLegs(follower, trader, allocations, levs, marginForPositions, execFee);

        delete rec.positionIds;
        for (uint256 i; i < ids.length; ++i) {
            rec.positionIds.push(ids[i]);
        }
        rec.versionId      = latest;
        rec.deployedAmount = marginForPositions;
        st.lastSyncedAt    = uint64(block.timestamp);
        st.syncCount      += 1;

        emit Resynced(follower, recordIdx, trader, fromVersion, latest, msg.sender, marginForPositions, ids.length);

        if (tip != 0) {
            (bool ok, ) = msg.sender.call{value: tip}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function getCopyRecords(address follower) external view returns (CopyRecord[] memory) {
        return copyRecords[follower];
    }

    function getFollowerCount(address trader) external view returns (uint256) {
        return followersByTrader[trader].length;
    }

    /// @notice 預覽 `followTrader`／`followTraderAtVersion` 的分配（不另設槓桿上限）。
    ///         `followTraderAtVersionWithAutoSync` 會套用跟隨者的上限，請用 `previewCopyAllocationWithCap`。
    function previewCopyAllocation(address trader, uint256 totalMargin)
        external view returns (
            uint256 copyFee,
            uint256 totalTradingFee,
            uint256 marginForPositions,
            uint256[] memory portions
        )
    {
        return _previewCopyAllocation(trader, totalMargin, 0);
    }

    /// @notice 同 `previewCopyAllocation`，但套用跟隨者自設的槓桿上限 `maxLeverage`（0 = 不另設）：
    ///         `followTraderAtVersionWithAutoSync` 開倉時就是用這個上限夾槓桿、算手續費緩衝，
    ///         預覽的緩衝、實際投入保證金與各腿份額因此與上鏈結果一致。
    function previewCopyAllocationWithCap(address trader, uint256 totalMargin, uint8 maxLeverage)
        external view returns (
            uint256 copyFee,
            uint256 totalTradingFee,
            uint256 marginForPositions,
            uint256[] memory portions
        )
    {
        return _previewCopyAllocation(trader, totalMargin, maxLeverage);
    }

    function _previewCopyAllocation(address trader, uint256 totalMargin, uint256 levCap)
        internal view returns (
            uint256 copyFee,
            uint256 totalTradingFee,
            uint256 marginForPositions,
            uint256[] memory portions
        )
    {
        (StrategyRegistry.Allocation[] memory allocs,) = registry.getLatestStrategy(trader);

        copyFee = address(feeRouter) != address(0) ? totalMargin * COPY_FEE_BPS / 10_000 : 0;
        uint256 netMargin    = totalMargin - copyFee;

        portions = new uint256[](allocs.length);
        totalTradingFee = _totalTradingFee(allocs, _legLeverages(allocs, levCap), netMargin);

        if (totalTradingFee >= netMargin) {
            marginForPositions = 0;
            return (copyFee, totalTradingFee, 0, portions);
        }

        marginForPositions = netMargin - totalTradingFee;
        for (uint256 i; i < allocs.length; ++i) {
            portions[i] = marginForPositions * allocs[i].weight / 10_000;
        }
    }

    /// @notice 這筆跟單的同步紀錄（上次同步時間、次數、跨輪計分）。
    function getSyncState(address follower, uint256 recordIdx) external view returns (SyncState memory) {
        return _syncState[follower][recordIdx];
    }

    /// @notice 給執行者 agent 與前端用：第三方現在呼叫 `resyncFor` 是否「預期」會成功、
    ///         交易者最新版本、以及會從油箱扣多少（executionFee × 腿數 ＋ 小費）。
    ///         盡量不 revert（索引超出範圍、交易者沒有策略都回傳 false）。
    /// @dev    檢查本合約與 registry 的條件（跟單 active、已開啟自動同步、有新版、
    ///         交易者有資格、冷卻已過、執行費不高於跟隨者同意的費率、油箱足夠），外加一項
    ///         估算：以目前的 `deployedAmount` 當作會釋出的保證金，新版任何一條腿的份額低於
    ///         交易所的 MIN_MARGIN 就回 false（例如交易者發布含 1 bps 權重的版本，或部位虧損
    ///         後縮水，`resyncFor` 必定 revert MarginTooLow）。實際釋出的金額要平倉後才知道，
    ///         所以這一項是近似值；交易所端的其他條件（RWA KYC、市場模式、OI 上限、暫停…）
    ///         要靠 eth_call 模擬 `resyncFor` 才知道。不看 `syncExecutor`（不知道呼叫者是誰）：
    ///         follower 指定了執行者時，只有那個地址的呼叫會成功，其他人 revert `NotSyncExecutor`。
    function pendingSync(address follower, uint256 recordIdx)
        external view returns (bool syncable, uint256 latestVersion, uint256 cost)
    {
        if (recordIdx >= copyRecords[follower].length) return (false, 0, 0);
        CopyRecord storage rec = copyRecords[follower][recordIdx];
        SyncConfig memory cfg = syncConfig[follower][recordIdx];

        StrategyRegistry.Allocation[] memory allocs;
        try registry.getLatestStrategy(rec.trader) returns (StrategyRegistry.Allocation[] memory a, uint256 v) {
            latestVersion = v;
            allocs = a;
        } catch {
            return (false, 0, 0);
        }
        uint256 execFee = exchange.executionFee();
        cost = execFee * allocs.length + cfg.tipWei;

        bool eligible;
        try registry.isEligibleTrader(rec.trader) returns (bool e) { eligible = e; } catch {}

        syncable = rec.active
            && cfg.autoSync
            && latestVersion > rec.versionId
            && eligible
            && block.timestamp >= _syncReadyAt(rec, _syncState[follower][recordIdx], cfg)
            && execFee <= syncExecFeeCap[follower][recordIdx]
            && syncGasBalance[follower] >= cost;

        if (syncable) {
            uint256 minMargin = exchange.MIN_MARGIN();
            for (uint256 i; i < allocs.length; ++i) {
                if (rec.deployedAmount * allocs[i].weight / 10_000 < minMargin) return (false, latestVersion, cost);
            }
        }
    }

    /// @notice 第三方最早可以同步這筆跟單的時間（本人手動同步不受此限）。
    function syncReadyAt(address follower, uint256 recordIdx) external view returns (uint256) {
        if (recordIdx >= copyRecords[follower].length) return 0;
        return _syncReadyAt(
            copyRecords[follower][recordIdx], _syncState[follower][recordIdx], syncConfig[follower][recordIdx]
        );
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /// @dev `follower` 的第 `recordIdx` 筆跟單，必須存在且 active。
    function _activeRecord(address follower, uint256 recordIdx) internal view returns (CopyRecord storage rec) {
        CopyRecord[] storage records = copyRecords[follower];
        if (recordIdx >= records.length) revert InvalidRecordIndex();
        rec = records[recordIdx];
        if (!rec.active) revert RecordAlreadyInactive();
    }

    /// @dev 冷卻起點是「上一次部位被設定的時間」：上次同步，從未同步過就是跟單當下。
    ///      跟單後交易者立刻發新版，也要等滿跟隨者自設的間隔才會被第三方同步。
    function _syncReadyAt(CopyRecord storage rec, SyncState storage st, SyncConfig memory cfg)
        internal
        view
        returns (uint256)
    {
        uint256 last = st.lastSyncedAt != 0 ? st.lastSyncedAt : rec.copiedAt;
        return last + cfg.minSyncInterval;
    }

    function _setSyncConfig(
        address follower,
        uint256 recordIdx,
        bool    enabled,
        uint8   maxLeverage,
        uint32  minSyncInterval,
        uint96  tipWei,
        uint256 maxExecFeePerLeg
    ) internal {
        if (
            maxLeverage > MAX_SYNC_LEVERAGE || tipWei > MAX_TIP_WEI
                || (enabled && (maxLeverage == 0 || minSyncInterval < MIN_SYNC_INTERVAL))
        ) {
            revert InvalidSyncConfig();
        }
        syncConfig[follower][recordIdx] = SyncConfig(enabled, maxLeverage, minSyncInterval, tipWei);
        // 跟隨者這次簽名同意的每腿執行費：現行費率高於簽名值整筆 revert；成功時記下現行費率
        // （= min(簽名值, 現行費率)）。關閉時歸零，且不檢查費率——關閉永遠要能成功。
        syncExecFeeCap[follower][recordIdx] = enabled ? _consentedExecFee(maxExecFeePerLeg) : 0;
        emit AutoSyncSet(follower, recordIdx, enabled, maxLeverage, minSyncInterval, tipWei);
    }

    /// @dev 交易所現行的 executionFee；高於跟隨者簽名帶入的每腿上限就 revert `ExecutionFeeAboveCap`。
    function _consentedExecFee(uint256 maxExecFeePerLeg) internal view returns (uint256 fee) {
        fee = exchange.executionFee();
        if (fee > maxExecFeePerLeg) revert ExecutionFeeAboveCap(fee, maxExecFeePerLeg);
    }

    /// @dev 跟單結束時關掉自動同步、清掉指定執行者，讓監聽 AutoSyncSet 的執行者不必再追這筆。
    function _clearAutoSync(address follower, uint256 recordIdx) internal {
        if (syncExecutor[follower][recordIdx] != address(0)) {
            delete syncExecutor[follower][recordIdx];
            emit SyncExecutorSet(follower, recordIdx, address(0));
        }
        if (!syncConfig[follower][recordIdx].autoSync) return;
        delete syncConfig[follower][recordIdx];
        delete syncExecFeeCap[follower][recordIdx];
        emit AutoSyncSet(follower, recordIdx, false, 0, 0, 0);
    }

    function _creditSyncGas(address follower, uint256 amount) internal {
        if (amount == 0) return;
        syncGasBalance[follower] += amount;
        totalSyncGas += amount;
        emit SyncGasDeposited(follower, amount);
    }

    function _debitSyncGas(address follower, uint256 amount) internal {
        uint256 bal = syncGasBalance[follower];
        if (bal < amount) revert InsufficientSyncGas(amount, bal);
        syncGasBalance[follower] = bal - amount;
        totalSyncGas -= amount;
    }

    /// @dev 每條腿實際使用的槓桿：min(策略槓桿, exchange.maxLeverageForAsset, cap)，
    ///      cap = 0 表示跟隨者沒有另設上限。交易所的上限會隨碳評等與 owner 設定變動
    ///      （例如高碳資產只能 1 倍），直接照抄策略的 5 倍會讓整筆開倉 revert。
    function _legLeverages(StrategyRegistry.Allocation[] memory allocations, uint256 cap)
        internal
        view
        returns (uint256[] memory levs)
    {
        levs = new uint256[](allocations.length);
        for (uint256 i; i < allocations.length; ++i) {
            uint256 lev = allocations[i].leverage;
            uint256 assetMax = exchange.maxLeverageForAsset(allocations[i].asset);
            if (lev > assetMax) lev = assetMax;
            if (cap != 0 && lev > cap) lev = cap;
            levs[i] = lev;
        }
    }

    /// @dev Opens one leg per allocation for `follower`, `copiedFrom = trader`
    ///      (keeps the trader's performance fee). Any leg that cannot open
    ///      reverts the whole call — no partial copies.
    function _openLegs(
        address follower,
        address trader,
        StrategyRegistry.Allocation[] memory allocations,
        uint256[] memory levs,
        uint256 marginForPositions,
        uint256 feePerPosition
    ) internal returns (uint256[] memory ids) {
        ids = new uint256[](allocations.length);
        for (uint256 i; i < allocations.length; ++i) {
            uint256 portion = marginForPositions * allocations[i].weight / 10_000;
            ids[i] = exchange.openPositionFor{value: feePerPosition}(
                follower,
                allocations[i].asset,
                allocations[i].isLong,
                portion,
                levs[i],
                trader
            );
        }
    }

    /// @notice Sums each allocation's own trading fee, looked up per-asset,
    ///         rather than assuming one global rate applies to every asset in
    ///         the strategy. Shared by `followTrader` and
    ///         `previewCopyAllocation` (#97) so the two can't independently
    ///         drift on how this is computed.
    /// @dev #96 made `PerpetualExchange`'s trading fee carbon-tier-derived and
    ///      therefore per-asset — a strategy mixing a high-carbon asset (up
    ///      to 100 bps) with a low-carbon one (as low as 10 bps) would be
    ///      under-reserved by a single global rate, and a later allocation in
    ///      `followTrader`'s open loop would fail `InsufficientFreeMargin`
    ///      even though the follower supplied enough total margin.
    ///      `levs` are the clamped per-leg leverages (`_legLeverages`), so the
    ///      buffer matches what the exchange will actually charge.
    function _totalTradingFee(
        StrategyRegistry.Allocation[] memory allocations,
        uint256[] memory levs,
        uint256 netMargin
    )
        internal
        view
        returns (uint256 totalTradingFee)
    {
        for (uint256 i; i < allocations.length; ++i) {
            uint256 weightedNotional = netMargin * allocations[i].weight * levs[i] / 10_000;
            uint256 tradingFeeBps = exchange.tradingFeeBpsForAsset(allocations[i].asset);
            totalTradingFee += weightedNotional * tradingFeeBps / 10_000;
        }
    }
}
