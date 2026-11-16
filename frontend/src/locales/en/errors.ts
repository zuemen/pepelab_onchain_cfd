import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/errors.ts`。
 */

export const errors: Catalog['errors'] = {
  unknown: 'Unknown error',

  contract: {
    // Selectors (0x + 4-byte hex)
    '0xbb90b0d9': 'Click Approve to let the SwapRouter spend your USDC.',
    '0xe450d38c':
      'Your wallet is short on USDC — grab free USDC from the faucet on the Funding & Swap page first 🚰',
    '0xbb723368': 'This asset is a regulated RWA — complete KYC verification before investing.',
    '0x4f402872':
      'This market is closed or paused (on-chain mode sell-only or halted): no new buys. In sell-only mode you can still sell what you hold; in halted mode selling waits until it is lifted.',
    // Keyword matches (case-insensitive)
    ERC20InsufficientBalance:
      'Your wallet is short on USDC — grab free USDC from the faucet on the Funding & Swap page first 🚰',
    'no strategies': "This strategy sharer hasn't published a strategy for copy investing yet!",
    FaucetCooldown: 'The faucet only pays out once every 24h — wait for the cooldown to end.',
    NoStrategyPublished: "This strategy sharer hasn't published a strategy",
    TradingFeeExceedsMargin:
      'The copy investing amount is too small — the buy/sell fee would exceed the amount invested. Increase the amount.',
    InsufficientFreeMargin: 'Not enough available to invest (buying also deducts a fee). Deposit more USDC or lower the amount.',
    MarginTooLow: 'The amount invested is below the minimum (10 USDC).',
    InvalidLeverage: 'The multiplier must be 1x, 2x, or 5x.',
    NotPositionOwner: 'Only the owner of this investment can do this.',
    PositionAlreadyClosed: 'This investment has already been sold.',
    NotCopyTracker: 'Only the copy investing on-chain program (CopyTracker) can do this.',
    CopyTrackerNotSet: 'The copy investing on-chain program (CopyTracker) is not set yet — contact an admin.',
    'Insufficient execution fee': 'Not enough ETH attached for the execution fee (the on-chain executionFee sets the amount) — top up your Base Sepolia ETH.',
    AlreadyRegistered: "You're already a strategy sharer — no need to register again.",
    NotRegistered: 'Register as a strategy sharer first.',
    EmptyAllocations: 'A strategy needs at least one allocation — it cannot be empty.',
    InvalidWeightSum: 'Weights must add up to 100%.',
    ZeroWeight: 'Weight cannot be 0.',
    TooFewAssets: 'A strategy must allocate to at least 3 different assets.',
    DuplicateAsset: 'Each asset can appear only once in a strategy.',
    WeightExceedsMax: 'No single asset can exceed 50% of the strategy.',
    CooldownNotElapsed: "The waiting period for withdrawing your performance deposit hasn't ended yet.",
    NoPendingUnstake: 'No pending deposit withdrawal request.',
    BelowMinStake: 'Your total performance deposit would be below the minimum (100 USDC). Raise the amount.',
    NotSyncExecutor: 'This copy investment names a different sync executor. Only they or you can sync it.',
    VaultDry: 'The vault does not hold enough USDC for this redemption. Lower the amount or try again later.',
    ZeroAmount: 'The amount cannot be 0.',
    IsPaused: 'This feature is paused right now. Try again later.',
    ZeroAgent: 'The AI agent address cannot be empty.',
    ZeroBudget: 'The total budget must be above 0.',
    ZeroLeverage: 'The multiplier cap must be above 0.',
    InvalidExpiry: 'The expiry is invalid. Hours must be above 0.',
    InsufficientStake: 'Insufficient performance deposit.',
    AlreadyMined: "This investment's investing reward was already claimed — don't claim it twice.",
    AlreadyCheckedIn: "You've already checked in today — come back tomorrow!",
    TierAlreadyClaimed: "This tier's promotion reward was already claimed!",
    CopyAlreadyClaimed: "The reward for this copy investing relationship was already claimed!",
    NotFollowing: "You're not currently following this strategy sharer!",
    InvalidTier: 'Invalid tier parameter!',
    InsufficientPool:
      "The rewards program's PEPE pool is running low — contact an admin to top it up!",
    TierThresholdNotMet:
      "Your cumulative amount invested (Notional Volume) hasn't reached this tier's requirement!",
    StalePrice:
      "The on-chain price is stale — the automatic updater (keeper) hasn't updated it yet. Wait a few minutes and try again, or ask an admin to update it manually.",
    NotKycVerified: 'This asset is a regulated RWA — complete KYC verification before investing.',
    AssetNotActive: 'This market is closed or paused (on-chain mode sell-only or halted): no new buys. In sell-only mode you can still sell what you hold; in halted mode selling waits until it is lifted.',
    AssetHalted: 'This market is halted. Buying and selling both wait until it is lifted.',
    OpenInterestCapExceeded: 'The total amount invested in this market has hit its cap. Lower the amount or try again later.',
    PositionIsHealthy:
      "This investment's amount invested is still sufficient — it doesn't meet the condition for automatic settlement.",
    FundingIntervalNotElapsed:
      "The holding-cost settlement interval (8 hours) hasn't elapsed yet — no need to settle manually.",
    NotPositionAgent:
      'This investment was bought under a different AI agent allowance (agent session) — only the AI agent that bought it can sell it on your behalf.',

    // ── AssetVaultV2 (#99: reserve-ratio observation and auto-halt on breach) ──
    MintingHalted:
      "Minting is paused — an on-chain observation found the reserve ratio below the floor. New buys need a later observation to show it's recovered. Redemption is unaffected — you can still sell.",
    CapExceeded: 'This asset is close to its issuance cap and this buy would exceed it. Try a smaller amount, or try again later.',
    EnforcedPause: 'The vault is paused, so buying is unavailable right now.',
    ReserveRatioTooLow:
      "This buy would leave the vault's reserve ratio below the floor, so it was rejected. Try a smaller amount, or wait and try again.",

    // ── PepeAMM (constant-product pool: swaps slip, and are bounded by an oracle guard rail) ──
    StaleOraclePrice:
      "The swap pool's reference price source is stale (past maxOracleAge) — swaps are paused so no one can profit from a stale price. Wait for the automatic updater (keeper) to update it and try again.",
    PriceOutOfBand:
      'This swap would push the pool price too far from the price source (past maxOracleDeviationBps). Reduce the swap amount, or wait for someone else to rebalance the pool first.',
    InsufficientLiquidity:
      "The pool doesn't have enough liquidity for this amount — reduce the swap size.",
    InsufficientInput: 'Swap amount is too small (it nets to 0 after fees) — increase the amount.',
    InsufficientOutput:
      'The actual fill is below your minimum acceptable amount (slippage protection triggered). The price moved after you submitted — get a fresh quote and try again.',
    InsufficientShares: 'Not enough LP shares to remove that much liquidity.',
    EthNotAccepted:
      'Sending ETH directly to the pool is not supported — use the Swap function (swapETHForUSDC) or addLiquidity.',
    InvalidOraclePrice: 'The price source reported an invalid price (0 or negative) — swaps are paused.',
    'reserve in pool': 'This exceeds the pool inventory — the pool cannot pay out that much. Reduce the swap amount.',
    'invalid oracle price': 'The price source reported an invalid price (0 or negative) — swaps are paused.',

    // ── Mock tokens ──────────────────────────────────────────────────────────
    FaucetCallerMustBeEOA:
      'The faucet only pays out to regular wallets (EOAs). You called it from a smart wallet (Safe / ERC-4337 smart account) — switch to a regular EOA wallet, or ask an admin to send the tokens to you directly.',
    NotMinter:
      'Only the on-chain program owner or a registered swapRouter can call mint. Regular users should use faucet() to claim tokens instead.',

    // ── KYCRegistry (review-gated) ──────────────────────────────────────────
    NoSubmission: "This address hasn't submitted a KYC application yet — nothing to review.",
    NotVerifier: 'Only a verifier or the on-chain program owner can perform KYC review.',

    // ── ESG / incentives ─────────────────────────────────────────────────────
    EsgHoldAlreadyClaimed: "This investment's ESG long-hold reward was already claimed!",
    AlreadyClaimed: 'This reward was already claimed!',
    PositionNotOpen:
      'The investment must still be held to claim this reward — one that has been sold is not eligible.',
    HoldTooShort:
      "You haven't held it for the minimum holding period yet (30 days by default) — hang on to it a bit longer.",
    AssetNotHighEsg:
      "This asset's composite ESG score is below the high-score threshold — it doesn't qualify for the ESG reward.",
    EsgScoreTooLow:
      "This asset's ESG score is below the threshold — it doesn't qualify for the reward.",
    SelfCopyNotAllowed: "You can't follow yourself with copy investing.",
    StrategyVersionMismatch:
      'The strategy sharer published a new strategy version before yours went through; so you never end up on a version you have not reviewed, it was not executed. Reload the page, review the new version and submit again.',
    TraderNotEligible:
      "This strategy sharer's performance deposit is below the minimum or being withdrawn, so they cannot take on new funds for now (existing investments are unaffected).",
    PositionStillOpen:
      'One of the assets cannot be sold right now (stale price, market closed or halted…); the whole thing was reverted and your investment is unchanged — try again later.',
    RecordAlreadyInactive: 'This record has already ended — reload the page.',
    AlreadySynced: "Already on the strategy sharer's latest version — nothing to sync.",
    InsufficientSyncGas:
      "The auto-sync gas tank doesn't hold enough ETH for this sync's execution fees (and tip) — deposit into the tank first.",
    InsufficientExecutionFee:
      'The ETH attached does not cover the execution fees for these buys (the platform may have just changed its fee), so nothing was executed — reload the page and submit again.',
    InvalidRecipient: 'Invalid recipient address (for example 0x0) — check the address and try again.',
    SyncCooldown:
      'Still within the cooldown set in your auto-sync settings — others must wait for it to end before syncing for you; syncing yourself is not limited.',
    AutoSyncDisabled: 'Auto-sync is off for this record, so only its owner can sync it.',
    InvalidSyncConfig: 'Auto-sync settings out of range: the multiplier cap must be 1–5×, the cooldown at least 1 hour, and the tip cannot exceed the on-chain program cap.',
    ExecutionFeeAboveCap:
      'The platform execution fee is above the rate you agreed to (the one shown when you submitted, or the one you accepted when you switched auto-sync on), so the whole thing was reverted and your gas tank was not touched. Reload the page to see the new fee and try again, or save your auto-sync settings again to accept it.',
    NothingToRedeploy:
      'Selling the old holdings left no amount to invest (they may all have been settled automatically), so there is nothing to reinvest.',
    SyncDisturbedOtherPositions:
      'Selling these holdings also touched your other investments (for example via an automatic reduction); to keep your other funds untouched, the sync was reverted — try again later.',
    EthTransferFailed: 'Sending ETH back to your wallet failed; the gas tank balance is unchanged. Make sure the receiving address can accept ETH.',
    PositionIdsNotSorted:
      'Investment IDs must be strictly increasing (still failing after auto-sorting means there are duplicate IDs) — refresh the page and try again.',
    RewardExceedsBudget:
      "This payout exceeds the performance deposit program's reward budget (rewardBudget) — contact an admin to adjust it.",

    // ── Oracle adapter (reverts rather than returning a stale value when stale/incomplete/low-confidence) ──
    PriceIsStale:
      'The price source is stale (past staleThreshold, 1 hour by default) — rejected outright for safety rather than filling at a stale price.',
    IncompleteRound:
      "This round from the price source (Chainlink) hasn't completed yet — try again shortly.",
    InvalidTimestamp: 'The price source reported an invalid time — rejecting this price.',
    FeedNotSet: "This asset doesn't have a price source (Chainlink / Pyth) set yet.",
    NoLiveSource:
      'Neither price source can provide a valid price — buying and selling are paused.',
    SingleSourceNotAllowed:
      'Only one price source is available, and allowSingleSource is off — buying and selling are paused.',
    PriceDeviationTooHigh:
      'The two price sources have diverged too far — buying and selling are paused to avoid using a bad price.',
    InvalidParam: 'Parameter is outside the bounds the on-chain program allows — check your input.',
    InvalidPrice: 'The on-chain price is invalid (0) — cannot settle.',
    'user rejected': 'You rejected the transaction',
    'User rejected': 'You rejected the transaction',
    ACTION_REJECTED: 'You rejected the transaction',
    'insufficient funds': 'Not enough ETH for the network fee. Get a little from a public Base Sepolia faucet first.',
    OutOfFunds:
      'Not enough ETH for the execution fee (buying needs ETH). Get a little ETH from a public Base Sepolia faucet first.',
    'nonce too low': 'Nonce too low — try again.',
  },

  /** 認得出是 revert、但只有「execution reverted」這種沒資訊量的訊息時的說法。 */
  reverted: {
    copy: "Claiming the copy investing reward failed (Reverted). Check that: 1. You've started following this strategy sharer; 2. You haven't already claimed the reward for this relationship; 3. The rewards program has enough PEPE funded in its pool.",
    tier: "Claiming the tier promotion reward failed (Reverted). Check that: 1. Your cumulative amount invested has reached this tier's threshold; 2. You haven't already claimed this tier's reward; 3. The rewards program has enough PEPE funded in its pool.",
    mining:
      "Claiming the investing reward failed (Reverted). Check that: 1. You are the owner of this investment; 2. This investment hasn't already claimed its reward; 3. The rewards program has enough PEPE funded in its pool.",
    checkin:
      "Daily check-in failed (Reverted). Check that: 1. You haven't already checked in today; 2. The rewards program's PEPE pool is funded.",
    checkinUnknown: "Daily check-in failed (Reverted). Check that you haven't already checked in today.",
    checkinPoints:
      "Daily check-in failed (Reverted). Check that you haven't already checked in today. On this version a check-in records achievement points and needs no PEPE pool.",
    generic:
      'Execution failed (Reverted). Common causes: not enough ETH for the execution fee, not enough amount invested, or a stale on-chain price. Check your balance and parameters and try again.',
    adopt:
      'Buy failed (Reverted). Common causes: not enough ETH for the network fee, not enough USDC, or a stale on-chain price. Check your balance and try again.',
  },

  /** The node is rate limiting or unreachable: nothing was rejected, and this does not mean there is no data. */
  nodeUnavailable: 'The blockchain node is not responding right now (possibly rate limited), so this data has not loaded. It does not mean there is no data or that a transaction failed. Please try again shortly.',

  /** The contract refused the read: no transaction failed, but retrying will not change it. */
  readReverted: 'This on-chain data cannot be read: the on-chain program refused the request, and retrying will not change that. It does not mean a transaction failed.',

  unrecognised:
    'The transaction failed and the error could not be identified. Check your network and balance and try again — if it keeps happening, open the browser console for the raw error to report.',
};
