import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/tokens.ts`。
 */
export const tokens: Catalog['tokens'] = {
  chart: {
    title: 'Market',
    source: 'Quotes: Coinbase ({symbol}) · chart by TradingView',
    btc: 'Bitcoin',
    eth: 'Ether',
    unavailable: 'The chart loads from TradingView. A blank panel here means that external resource did not load; it does not affect buying or selling below.',
  },
  title: 'Tokenized Assets',
  subtitle: 'ERC-20 Tokenized Assets',

  /** Which protections this vault has — a single-column list, shown only when the hardened vault is actually deployed (see the component). */
  protections: {
    title: 'What this vault protects against',
    items: [
      { label: 'ERC-20 transfer', detail: 'SafeERC20' },
      { label: 'Reentrancy protection', detail: 'ReentrancyGuard' },
      { label: 'Pause mechanism', detail: 'Pausable' },
      { label: 'Access model', detail: 'AccessControl (role separation)' },
      { label: 'Upgradeability', detail: 'UUPS proxy' },
      { label: 'Oracle', detail: 'GuardedOracle (multiple keepers + deviation cap)' },
      { label: 'Issuance cap', detail: 'Per-asset cap' },
      { label: 'Reserve-ratio protection', detail: 'Rejects mint below the floor' },
      { label: 'Fee', detail: 'Mint fee' },
    ],
  },

  notDeployed: 'Tokenized assets are not enabled on this network (AssetVault not deployed).',

  /** Hardened-features health panel. */
  health: {
    title: '🛡️ Vault protections & health (live on-chain values)',
    reserveRatio: 'Reserve ratio',
    reserveRatioInfinite: '∞ (nothing issued yet)',
    reserveRatioUnknown: 'Cannot confirm',
    reserveRatioNote:
      "The vault's USDC reserve divided by the total value of issued tokens. Mint is rejected below the floor.",
    reserveRatioNoteStale:
      "At least one asset's price is stale, so this number may understate the liability and read more optimistic than reality — treat it as unknown, not healthy, until a fresh price arrives.",
    status: 'Status',
    paused: 'Paused',
    running: 'Running',
    mintingHalted: 'Minting halted',
    pausableNote: 'Pausable: PAUSER_ROLE can halt buying and selling in an emergency.',
    accruedFees: 'Accrued fees',
    guardedOracle: 'GuardedOracle',
    guardedOracleNote:
      'A multi-keeper oracle — any single update that deviates past the cap is rejected.',
    /** This chain runs the original implementation, without these protections — no version number named. */
    notHardened:
      "The vault on this network has no SafeERC20, reserve-ratio protection, or pause mechanism yet. A deployed contract's bytecode can't be changed; these protections are already live on other deployments, and when this network catches up is the operator's call.",
  },

  card: {
    oraclePrice: 'Oracle Price',
    myBalance: 'My Balance',
    issuedOverCap: 'Issued / Cap',
    capClosed: '0 (closed)',
    buy: 'Buy',
    sell: 'Redeem',
    addToWallet: '➕ Add to MetaMask',
  },

  /** 買賣對話框。 */
  dialog: {
    buyTitle: 'Buy {symbol}',
    sellTitle: 'Redeem {symbol}',
    buyAmountLabel: 'USDC amount to pay',
    sellAmountLabel: '{symbol} amount to redeem',
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
    sold: 'Redeemed {symbol} ✓ — USDC is back in your wallet',
    noWallet: "Couldn't find a wallet extension",
  },

  provenance: {
    sectionTitle: 'Asset provenance',
    underlyingLabel: 'Tracks',
    referenceIdLabel: 'Reference ID',
    priceSourceLabel: 'Price source',
    priceFeedName: {
      coingecko: 'CoinGecko',
      yahoo: 'Yahoo Finance chart',
    },
    freshnessLabel: 'Price freshness',
    disclaimer:
      'This token tracks the underlying by synthetic price only. It confers no ownership, shareholder rights, or claim of any kind.',

    carbonTitle: 'Carbon intensity',
    carbonTier: {
      unrated: 'Unrated',
      low: 'Low',
      mid: 'Mid',
      high: 'High',
    },
    carbonBasis: {
      revenue: 'tCO2e / $M revenue',
      absolute: 'Absolute annual emissions (not on the revenue scale)',
      qualitative: 'Qualitative, by sector composition — not a computed figure',
    },
    carbonUnratedNote:
      'No unexpired carbon attestation for this asset — it is priced at the most conservative tier.',
    observedLabel: 'Last attested',
    nextDueLabel: 'Next attestation due',
    sourceLabel: 'Source',
    caveatLabel: 'Known limitation',

    kycTitle: 'Why this needs KYC',
    kycReason:
      'This asset tracks a security listed on a regulated market. KYC status is checked before a leveraged position is opened; buying and redeeming the token directly is unaffected.',
    kycNotGated: 'This asset does not track a regulated security and needs no KYC.',

    heldDaysLabel: "You've held",
    heldDaysValue: '{n} days',
    sinceLabel: 'Attested since {date}',

    assets: {
      sBTC: {
        underlying: "Bitcoin mainnet's native asset, produced by proof-of-work mining.",
        carbonSource: 'Cambridge CBECI — 2025 Digital Mining Industry Report',
        carbonCaveat:
          "Absolute annual emissions ≈39.8 Mt CO2e, comparable to a mid-sized country's yearly total; absolute basis, not on the revenue scale used for equities.",
      },
      sETH: {
        underlying: "Ethereum mainnet's native asset, proof-of-stake since the 2022 Merge.",
        carbonSource: 'Cambridge — 2026 Ethereum climate-footprint report',
        carbonCaveat:
          "Post-Merge absolute annual emissions ≈2,370 tCO2e, smaller than any single company's Scope 1 in this table; absolute basis, not on the revenue scale.",
      },
      sAAPL: {
        underlying: 'Apple Inc. common stock, listed on NASDAQ.',
        carbonSource: 'Apple Environmental Progress Report 2024 (via Tracenable) · FY2024',
        carbonCaveat:
          'Scope 1+2 (market-based), excludes Scope 3 — for Apple, Scope 3 is more than 10× Scope 1+2.',
      },
      sTSLA: {
        underlying: 'Tesla, Inc. common stock, listed on NASDAQ.',
        carbonSource: 'Tesla Impact Report 2024 (via Tracenable) · FY2024',
        carbonCaveat: 'Scope 1+2 (market-based), excludes Scope 3.',
      },
      sGOLD: {
        underlying: 'Spot gold (XAU/USD), settled against the COMEX front-month gold future.',
        carbonSource: 'S&P Global Market Intelligence — Greenhouse gas and gold mines',
        carbonCaveat:
          '0.85 tCO2e/oz (2019 global average mining emissions), sector-wide >100 Mt CO2e/yr; per-ounce basis, not on the revenue scale used for equities.',
      },
      sBOND: {
        underlying:
          'iShares USD Green Bond ETF (BGRN), listed on NASDAQ — investment-grade green bonds screened against the Green Bond Principles.',
        carbonSource: 'iShares BGRN fact sheet + holdings disclosure',
        carbonCaveat:
          "Placed Low qualitatively — an investment-grade green bond fund is, by the Green Bond Principles' eligibility criteria, structurally lower-carbon-intent than an unscreened bond index (same treatment as sICLN). The real per-holding avoided-emissions figure needs the BGRN Impact Report; the issuer's hosts return 403 to automated fetch, so it awaits a human download (see the carbon data table).",
      },
      sNVDA: {
        underlying: 'NVIDIA Corporation common stock, listed on NASDAQ.',
        carbonSource: 'NVIDIA Sustainability Report 2025 (via Tracenable) · FY2025',
        carbonCaveat:
          'Scope 2 (market-based) is zero — an artefact of 100% REC/PPA coverage, not a claim of zero physical data-centre electricity; excludes Scope 3.',
      },
      sMSFT: {
        underlying: 'Microsoft Corporation common stock, listed on NASDAQ.',
        carbonSource:
          'Microsoft 2025 Environmental Sustainability Report (cross-checked via DitchCarbon) · FY2025',
        carbonCaveat: 'Scope 1+2 (market-based), excludes Scope 3.',
      },
      sGOOGL: {
        underlying: 'Alphabet Inc. Class A common stock, listed on NASDAQ.',
        carbonSource: 'Alphabet Environmental Report 2025 (covers FY2024, via Tracenable)',
        carbonCaveat: 'Scope 1+2 (market-based), excludes Scope 3.',
      },
      sICLN: {
        underlying:
          'iShares Global Clean Energy ETF, holding renewable-power generation and equipment companies worldwide.',
        carbonSource: 'iShares ICLN fact sheet + holdings (stockanalysis.com)',
        carbonCaveat:
          'Placed Low by the sector composition of its top-10 holdings, not a per-constituent carbon computation.',
      },
      sESGU: {
        underlying:
          'iShares ESG Aware MSCI USA ETF, an ESG-screened large-cap US portfolio.',
        carbonSource: 'iShares ESGU fact sheet + holdings (stockanalysis.com)',
        carbonCaveat:
          'A weighted partial estimate over only ≈24% of holdings; the remaining ≈76% is not reflected and could shift this figure materially.',
      },
    },
  },

  who: {
    title: 'Who runs what',
    intro: "An RWA platform's value is knowing who is on the line. Anonymity is crypto's value, not an RWA's.",
    priceRole: 'Price',
    priceWho:
      'A keeper pulls quotes from CoinGecko / Yahoo Finance and writes them to GuardedOracle (multiple keepers, per-update deviation cap). Stale quotes are not written on-chain.',
    carbonRole: 'Carbon attestation',
    carbonWho:
      "Carbon intensity is taken from each issuer's own public filings (sustainability reports, 10-Ks); source URLs and retrieval dates are recorded in docs/data/carbon-intensity.md.",
    reserveRole: 'Reserve operations',
    reserveWho:
      'The AssetVault operator holds the USDC reserve; the reserve ratio is written to on-chain observation events by a keeper and minting auto-halts if it breaches the floor.',
    auditRole: 'Code audit',
    auditWho:
      'The contracts have been audited in successive passes, with fix records in docs/; every deployed address is verifiable on a block explorer.',
    disclosureTitle: 'Honest disclosure',
    disclosure:
      "In this demo the carbon attestations are arranged by the project team and are not yet institutional independence. Multi-party attestation and visible dispersion mitigate — but do not solve — whether the underlying data is truthful.",
  },

  /** #36：四段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    protectionsNoteBefore: 'See ',
    protectionsNoteMid: ' and',
    protectionsNoteAfter: '.',

    introBefore: 'This page showcases ',
    introBold1: 'tokenized assets (ERC-20)',
    introMid1:
      '. Unlike the synthetic positions on the trading page, assets bought here arrive as ERC-20 tokens ',
    introMid1Spot: '. Assets bought here arrive as ERC-20 tokens ',
    introBold2: 'right in your wallet',
    introMid2: ', where you can add it to MetaMask or send it to someone else. Trading settles in ',
    introAfter: ', with pricing pulled from the on-chain oracle (no slippage).',

    staleRatioBold: 'Reserve ratio cannot be confirmed',
    staleRatioBody:
      " — at least one issued asset's price is stale, so the reserve ratio understates the liability and reads more optimistic than reality. The number above doesn't reflect whether the reserve covers what's owed until a fresh price arrives — buying is paused as a precaution. Redemption is unaffected: a stale price on an unrelated asset should never stop you from selling.",

    mintingHaltedBold: 'Minting paused',
    mintingHaltedBody:
      " — an on-chain observation found the reserve ratio below the floor (a market move alone can trigger this; nobody has to be transacting). New buys are paused until a later observation shows it has recovered. Redemption is unaffected — you can sell at any time.",

    vaultDryBefore:
      'Note: sells are paid from the vault\'s USDC reserve. If the reserve runs low, you\'ll see "vault dry" — an admin needs to call ',
    vaultDryAfter: ' to top it up.',
  },
};
