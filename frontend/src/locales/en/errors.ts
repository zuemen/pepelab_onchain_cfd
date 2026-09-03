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
      'Your wallet is short on USDC — grab free test USDC from the faucet on the Funding & Swap page first 🚰',
    // Keyword matches (case-insensitive)
    ERC20InsufficientBalance:
      'Your wallet is short on USDC — grab free test USDC from the faucet on the Funding & Swap page first 🚰',
    'no strategies': "This trader hasn't published a copy-trading strategy yet!",
    FaucetCooldown: 'The faucet only pays out once every 24h — wait for the cooldown to end.',
    NoStrategyPublished: "This trader hasn't published a strategy",
    TradingFeeExceedsMargin:
      'Copy amount is too small — the trading fee would exceed the margin. Increase the amount.',
    InsufficientFreeMargin: 'Insufficient free margin — deposit more USDC first.',
    MarginTooLow: 'Margin is below the minimum threshold (10 USDC).',
    InvalidLeverage: 'Leverage must be 1x, 2x, or 5x.',
    NotPositionOwner: 'Only the position owner can do this.',
    PositionAlreadyClosed: 'This position is already closed.',
    NotCopyTracker: 'Only CopyTracker can call this function.',
    CopyTrackerNotSet: 'CopyTracker is not set yet — contact an admin.',
    'Insufficient execution fee': 'Needs 0.001 ETH as the execution fee — top up your ETH.',
    AlreadyRegistered: "You're already a trader — no need to register again.",
    NotRegistered: 'Register as a trader first.',
    EmptyAllocations: 'A strategy needs at least one allocation — it cannot be empty.',
    InvalidWeightSum: 'Weights must add up to 100%.',
    ZeroWeight: 'Weight cannot be 0.',
    CooldownNotElapsed: "The unstake cooldown hasn't ended yet.",
    NoUnstakeRequest: 'No pending unstake request.',
    InsufficientStake: 'Insufficient stake.',
    AlreadyMined: "This position's trade-mining reward was already claimed — don't claim it twice.",
    AlreadyCheckedIn: "You've already checked in today — come back tomorrow!",
    TierAlreadyClaimed: "This tier's promotion reward was already claimed!",
    CopyAlreadyClaimed: "This copy relationship's reward was already claimed!",
    NotFollowing: "You're not currently copying this trader!",
    InvalidTier: 'Invalid tier parameter!',
    InsufficientPool:
      "The rewards contract's PEPE pool is running low — contact an admin to top it up!",
    TierThresholdNotMet:
      "Your cumulative trading volume (Notional Volume) hasn't reached this tier's requirement!",
    StalePrice:
      "The on-chain price is stale — the keeper hasn't updated it yet. Wait a few minutes and try again, or ask an admin to trigger the keeper manually.",
    NotKycVerified: 'This asset is an RWA market — complete KYC verification before trading.',
    PositionIsHealthy:
      "This position's margin is still healthy — it doesn't meet the liquidation condition.",
    FundingIntervalNotElapsed:
      "The funding settlement interval (8 hours) hasn't elapsed yet — no need to settle manually.",
    NotPositionAgent:
      'This position was opened by a different agent session — only the agent that opened it can close it on your behalf.',

    // ── AssetVaultV2 (#99: reserve-ratio observation and auto-halt on breach) ──
    MintingHalted:
      "Minting is paused — an on-chain observation found the reserve ratio below the floor. New buys need a later observation to show it's recovered. Redemption is unaffected — you can still sell.",
    ReserveRatioTooLow:
      "This buy would leave the vault's reserve ratio below the floor, so it was rejected. Try a smaller amount, or wait and try again.",

    // ── PepeAMM (constant-product pool: swaps slip, and are bounded by an oracle guard rail) ──
    StaleOraclePrice:
      "The swap pool's reference oracle price is stale (past maxOracleAge) — swaps are paused to prevent arbitrage on a stale price. Wait for the keeper to update it and try again.",
    PriceOutOfBand:
      'This swap would push the pool price too far from the oracle price (past maxOracleDeviationBps). Reduce the swap amount, or wait for someone else to rebalance the pool first.',
    InsufficientLiquidity:
      "The pool doesn't have enough liquidity for this amount — reduce the swap size.",
    InsufficientInput: 'Swap amount is too small (it nets to 0 after fees) — increase the amount.',
    InsufficientOutput:
      'The actual fill is below your minimum acceptable amount (slippage protection triggered). The price moved after you submitted — get a fresh quote and try again.',
    InsufficientShares: 'Not enough LP shares to remove that much liquidity.',
    EthNotAccepted:
      'Sending ETH directly to the pool is not supported — use the Swap function (swapETHForUSDC) or addLiquidity.',
    InvalidOraclePrice: 'The oracle reported an invalid price (0 or negative) — swaps are paused.',

    // ── Mock tokens ──────────────────────────────────────────────────────────
    FaucetCallerMustBeEOA:
      'The faucet only pays out to regular wallets (EOAs). You called it from a contract wallet (Safe / ERC-4337 smart account) — switch to a regular EOA wallet, or ask an admin to send the tokens to you directly.',
    NotMinter:
      'Only the contract owner or a registered swapRouter can call mint. Regular users should use faucet() to claim test tokens instead.',

    // ── KYCRegistry (review-gated) ──────────────────────────────────────────
    NoSubmission: "This address hasn't submitted a KYC application yet — nothing to review.",
    NotVerifier: 'Only a verifier or the contract owner can perform KYC review.',

    // ── ESG / incentives ─────────────────────────────────────────────────────
    EsgHoldAlreadyClaimed: "This position's ESG long-hold reward was already claimed!",
    AlreadyClaimed: 'This reward was already claimed!',
    PositionNotOpen:
      'The position must still be open to claim this reward — a closed position is not eligible.',
    HoldTooShort:
      "You haven't held it for the minimum holding period yet (30 days by default) — hang on to it a bit longer.",
    AssetNotHighEsg:
      "This asset's composite ESG score is below the high-score threshold — it doesn't qualify for the ESG reward.",
    EsgScoreTooLow:
      "This asset's ESG score is below the threshold — it doesn't qualify for the reward.",
    SelfCopyNotAllowed: "You can't copy your own trades.",
    PositionIdsNotSorted:
      'The position ID array must be strictly increasing (still failing after auto-sorting means there are duplicate IDs) — refresh the page and try again.',
    RewardExceedsBudget:
      "This payout exceeds the staking contract's reward budget (rewardBudget) — contact an admin to adjust it.",

    // ── Oracle adapter (reverts rather than returning a stale value when stale/incomplete/low-confidence) ──
    PriceIsStale:
      'The oracle price is stale (past staleThreshold, 1 hour by default) — rejected outright for safety rather than filling at a stale price.',
    IncompleteRound:
      "This Chainlink price round hasn't completed yet (incomplete round) — try again shortly.",
    InvalidTimestamp: 'The oracle reported an invalid timestamp — rejecting this price.',
    FeedNotSet: "This asset doesn't have a Chainlink / Pyth feed set yet.",
    NoLiveSource:
      'Neither source in the aggregated oracle can provide a valid price — trading is paused (fail-closed).',
    SingleSourceNotAllowed:
      'Only one source is available in the aggregated oracle, and allowSingleSource is off — trading is paused (fail-closed).',
    PriceDeviationTooHigh:
      'The two oracle sources have diverged too far — trading is paused to avoid using a bad price.',
    InvalidParam: 'Parameter is outside the bounds the contract allows — check your input.',
    InvalidPrice: 'The on-chain price is invalid (0) — cannot settle.',
    'user rejected': 'You rejected the transaction',
    'User rejected': 'You rejected the transaction',
    ACTION_REJECTED: 'You rejected the transaction',
    'insufficient funds': 'Not enough ETH to cover the gas fee',
    OutOfFunds:
      'ETH balance is too low to cover the execution fee (opening a position requires ETH) — claim test ETH first 🚰',
    'execution reverted': 'Transaction execution failed',
    'nonce too low': 'Nonce too low — try again.',
  },

  /** 認得出是 revert、但只有「execution reverted」這種沒資訊量的訊息時的說法。 */
  reverted: {
    copy: "Claiming the copy-trading reward failed (Reverted). Check that: 1. You've started copying this trader; 2. You haven't already claimed the reward for this relationship; 3. The rewards contract has enough PEPE funded in its pool.",
    tier: "Claiming the tier promotion reward failed (Reverted). Check that: 1. Your cumulative trading volume has reached this tier's threshold; 2. You haven't already claimed this tier's reward; 3. The rewards contract has enough PEPE funded in its pool.",
    mining:
      "Claiming the trade-mining reward failed (Reverted). Check that: 1. You are the owner of this position; 2. This position hasn't already claimed its mining reward; 3. The rewards contract has enough PEPE funded in its pool.",
    checkin:
      "Daily check-in failed (Reverted). Check that: 1. You haven't already checked in today; 2. The rewards contract's PEPE pool is funded.",
    generic:
      'Transaction execution failed (Reverted). Common causes: not enough ETH for the execution fee, insufficient margin, or a stale on-chain price. Check your balance and parameters and try again.',
  },

  unrecognised:
    'The transaction failed and the error could not be identified. Check your network and balance and try again — if it keeps happening, open the browser console for the raw error to report.',
};
