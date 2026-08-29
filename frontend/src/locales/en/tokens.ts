import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/tokens.ts`。
 */
export const tokens: Catalog['tokens'] = {
  chart: {
    title: 'Market',
    source: 'Quotes: Coinbase spot ({symbol}) · chart by TradingView',
    btc: 'Bitcoin',
    eth: 'Ether',
    unavailable: 'The chart loads from TradingView. A blank panel here means that external resource did not load; it does not affect buying or selling below.',
  },
  title: 'Tokenized Assets',

  version: {
    v1: 'V1 (original)',
    v2: 'V2 (hardened)',
    v2Unavailable: 'V2 is not deployed on this network',
    v2Chip: 'SafeERC20 · Reentrancy-guarded · Pausable',
  },

  /** V1 / V2 差異對照。 */
  diff: {
    title: 'V1 / V2 Differences',
    columnItem: 'Feature',
    columnV1: 'V1',
    columnV2: 'V2',

    transfer: 'ERC-20 transfer',
    transferV1: 'Bare transfer',
    transferV2: 'SafeERC20',

    reentrancy: 'Reentrancy protection',
    reentrancyV1: 'None',
    reentrancyV2: 'ReentrancyGuard',

    pausable: 'Pause mechanism',
    pausableV1: 'None',
    pausableV2: 'Pausable',

    access: 'Access model',
    accessV1: 'Ownable (single owner)',
    accessV2: 'AccessControl (role separation)',

    upgradeable: 'Upgradeability',
    upgradeableV1: 'Not upgradeable',
    upgradeableV2: 'UUPS proxy',

    oracle: 'Oracle',
    oracleV1: 'MockOracle (single key)',
    oracleV2: 'GuardedOracle (multiple keepers + deviation cap)',

    cap: 'Issuance cap',
    capV1: 'None',
    capV2: 'Per-asset cap',

    reserve: 'Reserve-ratio protection',
    reserveV1: 'None',
    reserveV2: 'Rejects mint below the floor',

    fee: 'Fee',
    feeV1: 'None',
    feeV2: 'Mint fee',
  },

  notDeployed: {
    v2: 'The V2 hardened vault is not deployed on this network.',
    vault: 'Tokenized assets are not enabled on this network (AssetVault not deployed).',
  },

  /** V2 健康度面板。 */
  health: {
    title: '🛡️ V2 Hardened Features (live on-chain values)',
    reserveRatio: 'Reserve ratio',
    reserveRatioInfinite: '∞ (nothing issued yet)',
    reserveRatioNote:
      "The vault's USDC reserve divided by the total value of issued tokens. Mint is rejected below the floor.",
    status: 'Status',
    paused: 'Paused',
    running: 'Running',
    pausableNote: 'Pausable: PAUSER_ROLE can halt buying and selling in an emergency.',
    accruedFees: 'Accrued fees',
    guardedOracle: 'GuardedOracle',
    guardedOracleNote:
      'A multi-keeper oracle — any single update that deviates past the cap is rejected.',
    v1Notice:
      "V1 is the original implementation — it has no SafeERC20, reserve-ratio protection, or pause mechanism. A deployed contract's bytecode can't be changed, so V1 stays on-chain as a reference point for how the architecture evolved; V2 is recommended.",
  },

  card: {
    oraclePrice: 'Oracle Price',
    myBalance: 'My Balance',
    issuedOverCap: 'Issued / Cap',
    capClosed: '0 (closed)',
    buy: 'Buy',
    sell: 'Sell',
    addToWallet: '➕ Add to MetaMask',
  },

  /** 買賣對話框。 */
  dialog: {
    buyTitle: 'Buy {symbol}',
    sellTitle: 'Sell {symbol}',
    buyAmountLabel: 'USDC amount to pay',
    sellAmountLabel: '{symbol} amount to sell',
    needAmount: 'Enter an amount to get a quote',
    buyQuote: "You'll receive ≈ {amount} {symbol}",
    sellQuote: "You'll receive ≈ {amount} USDC",
    fee: 'Fee: {amount} USDC',
    cancel: 'Cancel',
    confirm: 'Confirm',
    working: 'Processing…',
  },

  tx: {
    badAmount: 'Invalid amount format',
    amountTooSmall: 'Enter an amount greater than 0',
    badQuantity: 'Invalid quantity format',
    quantityTooSmall: 'Enter a quantity greater than 0',
    bought: 'Bought {symbol} ✓ — the tokens are in your wallet',
    sold: 'Sold {symbol} ✓ — USDC is back in your wallet',
    noWallet: "Couldn't find a wallet extension",
  },

  /** #36：四段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    diffNoteBefore: 'Both implementations coexist on-chain — V1 is kept as a reference. See ',
    diffNoteMid: ' and',
    diffNoteAfter: '.',

    introBefore: 'This page showcases ',
    introBold1: 'tokenized assets (ERC-20)',
    introMid1:
      '. Unlike the synthetic positions on the trading page, assets bought here arrive as ERC-20 tokens ',
    introBold2: 'right in your wallet',
    introMid2: ', where you can add it to MetaMask or send it to someone else. Trading settles in ',
    introAfter: ', with pricing pulled from the on-chain oracle (no slippage).',

    staleOracleBold: 'GuardedOracle price is stale',
    staleOracleMid1:
      " — buying and selling are temporarily disabled. This is expected fail-closed behavior: the oracle refuses to serve a stale price, and the vault's reserve-ratio calculation calls it directly, so ",
    staleOracleMid2: ' and ',
    staleOracleAfter: ' both revert. It recovers once KEEPER_ROLE feeds a fresh price.',

    vaultDryBefore:
      'Note: sells are paid from the vault\'s USDC reserve. If the reserve runs low, you\'ll see "vault dry" — an admin needs to call ',
    vaultDryAfter: ' to top it up.',
  },
};
