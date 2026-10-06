import type { Catalog } from '../zh-TW';

/**
 * See `../zh-TW/rwa.ts`.
 */
export const rwa: Catalog['rwa'] = {
  link: {
    label: 'RWA asset cards & disclosures',
    hint: 'What these markets reference, access rules, price sources and market-hours rules',
  },

  common: {
    loading: 'Loading…',
    readFailed: 'Read failed',
    notInDeployment: 'Not in this deployment',
    unknown: 'Cannot tell',
    notDeployed: 'Not deployed on this chain',
    yes: 'Yes',
    no: 'No',
    retry: 'Reload',
    chainSourcePublic: 'Read-only via the public node for {chain} (no wallet needed, no transactions sent)',
    chainSourceWallet: "Read-only via your wallet's node for {chain} (no transactions sent)",
    noProvider: 'No read-only node available: connect a wallet and switch to Base Sepolia.',
    asOfBlock: 'block {n}',
    seconds: '{n} s',
    minutes: '{n} min',
    hours: '{n} h',
    days: '{n} d',
    bps: '{n} bps',
  },

  nav: {
    section: 'RWA transparency',
    cards: '📋 RWA asset cards',
    oracle: '🔎 Reference prices',
    solvency: '🏦 Reserves & solvency',
  },

  cards: {
    title: 'RWA asset cards & compliance disclosures',
    subtitle:
      'For each market: the real-world asset it references, whether KYC is required, the reference price source, trading hours, carbon tier and risk parameters. Fields marked "on-chain" are live read-only values; when a read fails it says so instead of showing a default.',
    classLabel: {
      equity: 'Equity',
      gold: 'Gold',
      bondEtf: 'Bond ETF',
      esgEtf: 'ESG ETF',
      crypto: 'Crypto',
    },
    referenceAsset: 'Referenced real-world asset',
    referenceId: 'Identifier',
    rwaFlag: 'RWA reference (on-chain rwaAsset)',
    rwaFlagged: 'Flagged',
    rwaUnflagged: 'Not flagged',
    rwaNote: {
      goldMismatch:
        'Gold is a real-world asset, but this deployment does not flag sGOLD as rwaAsset on-chain, so opening a position does not check KYC. Shown here exactly as it is on-chain.',
      unflaggedRwa: 'This market references a real-world asset but is not flagged as rwaAsset on-chain.',
      cryptoNotRwa: 'Crypto assets are not real-world assets (RWA) and are not flagged on-chain.',
      cryptoFlagged: 'Crypto assets are not real-world assets, but this one is flagged as rwaAsset on-chain.',
    },
    kyc: 'KYC required to open (on-chain)',
    kycValue: {
      required: 'Required',
      notRequired: 'Not required',
      gateOff: 'Not required (the exchange has no KYC registry set)',
      unknown: 'Cannot tell (read failed)',
    },
    kycNote:
      "Derived from the exchange's kyc() and rwaAsset(); checked only when opening, never when closing. The live KYC registry is the older version: submission and approval are not separated, so this is a demo gate, not identity verification.",
    priceSource: 'Reference price source',
    priceSourceValue: 'The keeper reads {source} ({ticker}) and writes it to MockOracle, which the exchange reads',
    keeperSchedule:
      'The keeper runs every 15 minutes on a GitHub Actions schedule (which can be delayed); it writes when the move is ≥ 0.1% or 15 minutes have passed.',
    secondary: 'Second source: {source} ({ticker}), used only to confirm large moves',
    singleSource: 'Single source only: the keeper has no independent second source to cross-check this market.',
    sourceName: {
      coingecko: 'CoinGecko',
      yahoo: 'Yahoo Finance',
      coinbase: 'Coinbase',
      nasdaq: 'Nasdaq',
      goldapi: 'gold-api.com',
    },
    session: 'Trading hours',
    sessionValue: {
      crypto: '24/7',
      equity: 'Mon–Fri 09:30–16:00 US Eastern (regular session; scheduled hours only, holidays not included)',
      future: 'COMEX: Sun 18:00 to Fri 17:00 US Eastern, daily break 17:00–18:00 (holidays not included)',
    },
    status: 'Right now',
    statusValue: {
      always: 'Trading 24/7',
      open: 'Market open',
      closed: 'Market closed',
      reduceOnly: 'Reduce-only (on-chain mode)',
      halted: 'Halted (on-chain mode)',
    },
    closureRule: 'Market-closed rule',
    closure: {
      noStop:
        'This deployment does not stop orders while the market is closed: orders still fill at the last close. Prices can gap at the open, so a close-out price can be far from the one on screen.',
      stop: 'This deployment supports market-closed stops: the keeper switches the asset to reduce-only while closed.',
      unknown: "Cannot confirm whether this deployment stops orders while closed (reading the exchange's code failed).",
      crypto: 'Trades 24/7; there is no market close.',
    },
    carbon: 'Carbon tier (ESGRegistryV2)',
    tier: {
      unrated: 'Unrated',
      low: 'Low carbon',
      mid: 'Mid carbon',
      high: 'High carbon',
    },
    attestors: 'Attestors',
    attestorsValue: '{n}',
    freshCount: '{n} fresh attestation(s)',
    singleAttestor:
      'There is only one attestor so far, and it is the operator itself; "taking the median" does nothing with a single attestation.',
    noAttestor: 'No attestations at all.',
    maxLeverage: 'Max leverage (on-chain)',
    maxLeverageValue: '{n}×',
    maintenance: 'Maintenance margin (on-chain)',
    maintenanceValue: '{pct} ({bps} bps)',
    risk: 'Risk disclosure',
    riskCommon:
      'Leverage magnifies losses, up to the whole margin; prices are written by a single keeper with no third-party audit; tokens and positions give no rights to the underlying.',
    riskByClass: {
      equity:
        'Equities only get new prices during the US regular session; dividends are not passed through (longs receive none, shorts pay none); splits trip the circuit breaker and are handled manually; there is no final-settlement function for a delisting.',
      gold: 'Tracks the COMEX front-month future; roll jumps are not handled; there is a basis versus spot.',
      bondEtf: 'ETFs only get new prices during the US regular session; distributions are not passed through; a single keeper source writes the price.',
      esgEtf:
        'ETFs only get new prices during the US regular session; distributions are not passed through; ESG screening is the issuer’s, not a certification by this platform.',
      crypto: 'Trades 24/7, so liquidation can happen at night and on weekends.',
    },
    loadFailed: 'On-chain read failed; fields below show "Read failed".',
  },

  compliance: {
    title: 'Compliance & positioning disclosures',
    items: {
      prototype:
        'This project is a research prototype on the Base Sepolia testnet. It is not a live financial service and holds no financial-services licence.',
      synthetic:
        'What it offers is a cash-settled synthetic derivative that references real-asset prices (perpetual / contract-for-difference style), not a tokenized security.',
      noUnderlying:
        'The platform does not issue, hold or custody any underlying asset; holders get no shareholder rights, dividends or claim on the underlying.',
      settlement: 'Settlement uses MockUSDC, a test token anyone can mint, with no real value.',
      regulated:
        'In Taiwan, contracts for difference are regulated leveraged trading that requires a licence from the regulator; this prototype is only suitable for an internal PoC at a licensed institution or a regulatory sandbox — to be confirmed by compliance.',
      unaudited: 'The contracts have not had a third-party security audit.',
    },
    lawsTitle: 'Related regulations (sources in docs/DESIGN_BESU.md §5, checked 2026-10-05)',
    laws: {
      futuresAct:
        'Futures Trading Act, Art. 3 (definition of leverage margin contracts) and Art. 80 (leverage transaction merchants require a licence)',
      leverageRules: 'Regulations Governing Leverage Transaction Merchants (FSC)',
      tpexRules:
        "TPEx rules on securities firms' over-the-counter derivatives business (contracts for difference offered by securities firms)",
      sandbox: 'Financial Technology Development and Innovative Experimentation Act (regulatory sandbox)',
    },
    notLegalAdvice: 'This page is not legal advice; whether and how these regulations apply must be confirmed by compliance.',
  },

  oracle: {
    title: 'Reference price witness board',
    subtitle:
      'The on-chain price the exchange reads (MockOracle, written by the keeper) next to several public off-chain sources. Anyone can reconcile with this page; it is not a signed price and not a decentralized oracle.',
    colAsset: 'Asset',
    colOnchain: 'On-chain price',
    colWritten: 'Written at (on-chain)',
    colAge: 'Price age',
    colSources: 'Off-chain reference (quote time)',
    writtenOnlyNote:
      "On-chain MockOracle stores only the write time (updatedAt), not the source's quote time. On a weekend the write time can be fresh while the price is still Friday's close — check each source's quote time on the right.",
    ageNote: 'Price age = latest block time − write time (the same clock the contract uses for staleness).',
    ageLocalClock: '(chain time unavailable, using the local clock)',
    maxAge: "The contract's maxPriceAge is {age}; beyond it, opening, closing and liquidation all revert.",
    role: {
      'keeper-primary': 'keeper primary',
      'keeper-secondary': 'keeper second source',
      independent: 'independent',
    },
    quoteTimeNone: 'source gives no quote time',
    sourceError: 'fetch failed ({reason})',
    singleSource: 'Single source only',
    okSources: '{ok}/{total} sources available',
    spread: 'spread between sources {bps}',
    goldNote:
      'Gold: the keeper reads the COMEX front-month future (GC=F); the second source is XAU spot, so there is a basis — it is a sanity check only.',
    offchainUnavailable: 'Off-chain reference prices failed to load ({reason}); showing on-chain data only.',
    offchainLoading: 'Loading off-chain reference prices…',
    offchainFrom:
      "Off-chain reference prices come from signal-api's free read-only endpoint /reference-prices (60 s cache, generated {at}).",
    licenseNote: 'Commercial licensing of each upstream source has not been verified; this is a sanity check for a testnet prototype.',
    deviationLevel: {
      ok: 'consistent',
      warn: 'deviating',
      alert: 'large deviation',
    },
    onchainFailed: 'Read failed',
  },

  solvency: {
    title: 'Reserves & solvency',
    subtitle:
      "The exchange's pool, the insurance vault and the tokenized vault's reserve ratio, all live on-chain reads. This page shows whether counterparty solvency can be checked; it is not a proof of reserve for the underlying assets.",
    notPoR:
      'The platform holds no underlying assets, so there is no — and no need for a — proof of reserve for them. The reserves here are MockUSDC test tokens, not a proof of reserve for the underlying.',
    exchangeTitle: 'Perpetual exchange',
    exchangeBalance: 'Exchange USDC balance (the pool)',
    totalMargin: 'Margin of open positions',
    unrealizedPnl: 'Unrealized PnL of open positions',
    openPositions: '{open} open position(s) ({scanned} scanned)',
    noPositions: 'There are no positions yet (nextPositionId = 0).',
    positionsPartial: '{n} position read(s) failed; totals may be understated.',
    positionsTruncated: 'Only the latest {n} positions were scanned; totals may be incomplete.',
    freeMarginNote: 'Deposited balances not used in positions (freeMargin) can only be read per address and are not included.',
    insuranceTitle: 'Insurance vault',
    insuranceAssets: 'Insurance vault assets (totalAssets)',
    adl: 'Auto-deleveraging (ADL)',
    adlOn: 'On',
    adlOff: 'Off',
    vaultTitle: 'Tokenized vault (AssetVaultV2)',
    reserve: 'Reserve',
    liability: 'Liability (outstandingValue)',
    ratio: 'Reserve ratio',
    ratioNoLiability: 'No liability (ratio is meaningless)',
    ratioMin: 'Minimum ratio {pct} (below it minting stops; redemptions are never blocked)',
    ratioStale: '{n} asset(s) could not be priced, so the liability is understated and the ratio "cannot be confirmed".',
    ratioOk: 'Every asset is priced.',
    mintingHalted: 'Minting halted (the ratio crossed below the minimum)',
    notFullyBacked:
      "The vault is not fully collateralized: it is the counterparty to every long and limits exposure with a minimum ratio, per-asset caps and pausing, not 1:1 backing. Today's ratio is high only because the liability is small and the reserve is a large amount of test tokens; it cannot be used to claim over-collateralization.",
    historyTitle: 'Reserve ratio history (ReserveObserved events)',
    historyWindow: 'Last ~{hours} h (blocks {from}–{to}, ≤ {chunk} blocks per query)',
    historyLoading: 'Scanning on-chain events…',
    historyFailed: 'Read failed: could not fetch events for this period.',
    historyPartial: '{failed}/{total} segments failed; the curve may have gaps.',
    historyEmpty:
      'No ReserveObserved events in this period (the keeper calls observeReserve once per run, and the schedule can be delayed). This does not mean the ratio is 0.',
    historyUnknownPoint: 'Observations with unpriced assets (understated liability) are left off the curve.',
    historyPoints: '{n} observation(s)',
    historyRange: 'Curve covers {from} to {to}; low {min}, high {max} (the vertical axis auto-scales and does not start at 0)',
    waterfallTitle: 'Loss-absorption waterfall (live deployment)',
    waterfallIntro: 'When one position loses more than its margin, the shortfall is absorbed in this order (docs/RISK_WATERFALL.md §2):',
    waterfall: {
      margin: {
        title: '① Trader margin',
        body: "The losing position's own margin absorbs first. Isolated: other positions and withdrawable balances are not touched.",
      },
      insurance: {
        title: '② Insurance vault',
        body: 'The insurance vault covers the shortfall with no per-event cap; it can be drained to 0.',
      },
      adl: {
        title: '③ Auto-deleveraging (ADL)',
        body: 'If the vault is short, profitable opposite-side positions in the same asset are closed in order and their profit is cut (principal untouched), scanning up to 128 positions.',
      },
      badDebt: {
        title: '④ Bad-debt event',
        body: 'Whatever is still uncovered is only disclosed through a BadDebt event; nothing tops it up automatically. The pool is left short, borne indirectly by everyone holding a balance.',
      },
    },
    layerValue: {
      margin: 'Can absorb now: {amount}',
      insurance: 'Can cover now: {amount}',
      adlOn: 'On, on-chain',
      adlOff: 'Off on-chain: this layer does not exist',
      badDebt: 'Disclosed, not absorbed',
    },
    noGuarantee:
      'Bottom line: the live deployment does not guarantee solvency. The first three layers are capped; the fourth is disclosure, not absorption.',
  },
};
