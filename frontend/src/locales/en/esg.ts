import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/esg.ts`。
 */
export const esg: Catalog['esg'] = {
  /** 見 `../zh-TW/esg.ts`。 */
  attested: {
    title: 'Attested Carbon Tier',
    lead: 'The Tier is itself the attested fact — recorded on chain by an Attestor alongside the basis they reached it on, not converted from a carbon intensity at read time. The vault prices its mint fee on this Tier.',
    vsOld:
      'The third-party ratings above are rating agencies’ judgements of overall sustainability conduct; this section describes the attested basis for pricing, which is the platform’s risk policy. Different sources, different purposes — shown side by side rather than merged into one score.',
    column: {
      asset: 'Asset',
      tier: 'Attested tier',
    },
    countUnit: '{count} attestations',
    noAttestations: 'No fresh attestations',
    agree: 'Attestations agree',
    apart: 'Attestations {n} tiers apart',
    unrated: 'Unrated',
    failed: 'Could not read the attestations — cannot confirm right now. This does not mean "unrated".',
    loading: 'Reading attestations…',
  },

  /** 見 `../zh-TW/esg.ts`。 */
  retirement: {
    title: 'Carbon Credit Retirements',
    lead: 'A fixed share of the platform fee, hard-coded in the contract, is routed to the retirement contract, which buys carbon credits and burns them in the same transaction. Every retirement is an irreversible record anyone can check on chain.',
    simulatedChip: 'Simulated credits',
    disclaimerTitle: 'Simulated carbon credits: no real carbon is removed here',
    disclaimer:
      'The credits retired here are simulated (mtCO2e), minted by this platform on a testnet. They were not issued by any carbon-credit registry, correspond to no real reduction or removal, and burning them offsets no real greenhouse-gas emissions. The purchase price is paid to a simulated seller address the platform controls and reaches no real carbon project. Only the mechanism is real: fees are routed at a ratio fixed in the contract, and a retirement cannot be undone.',
    totalTonnes: 'Retired to date (simulated)',
    tonnesUnit: '{n} t CO₂e',
    totalSpent: 'Spent on credits to date',
    budget: 'Budget awaiting retirement',
    count: 'Retirements',
    recentTitle: 'Recent retirements',
    column: {
      time: 'Time',
      tonnes: 'Amount (simulated)',
      amount: 'Cost',
      tx: 'On-chain tx',
    },
    empty: 'No retirements yet.',
    failed: 'Could not read the retirement records — cannot confirm right now. This does not mean "nothing retired".',
    loading: 'Reading retirement records…',
    /** #333: the beneficiary rule — one tonne can be claimed by one party only. */
    beneficiaryTitle: 'The platform is the beneficiary',
    beneficiary:
      'A tonne can be claimed by one party only. The tonnes retired here belong to the platform, not to any individual user: your trades helped bring the retirement about, but these tonnes cannot be counted as a reduction of your own emissions.',
    fundingTitle: 'Where the money comes from',
    funding:
      'Of the fee revenue the platform receives, {carbon}% of the platform’s {platform}% share goes to the retirement budget automatically — {total}% of the fee. The ratio is fixed in the contract (immutable) and the platform cannot change it; changing it takes a new deployment, which is itself visible on chain. Anyone can trigger the split and the retirement; whoever triggers it decides only when, the contract decides where the money goes.',
    /** Rendered only when the copy-trading flag is on (allow-listed in copyWording.test.ts). */
    fundingCopy:
      'The revenue on this path is the copy fee (0.3% of the copied amount) and the performance fee on profitable copied positions; ordinary trading fees do not pass through it. Retirement is paid from the platform’s own revenue — users pay nothing extra.',
    viewTx: 'View tx',
    shownOf: 'Showing the latest {shown} of {count}',
    more: 'Show earlier retirements',
  },

  /** #333: the "carbon tier mix" card on the trader page and the portfolio (CarbonTierMixCard). */
  impact: {
    tierTitle: 'Carbon tier mix',
    tierLead: 'How much of the holdings sits in each carbon tier. Carbon intensities of different assets have different units and cannot be added up into one tonnage, so only tiers are compared here.',
    /** Low / mid / high / unrated reuse tokens.provenance.carbonTier (one set of tiers); only the failed-read bucket lives here. */
    tierUnknown: 'Unknown (read failed)',
    tierSource: 'Tiers are read from the on-chain attestations the exchange prices on; assets that cannot be read are shown as unknown, never as low carbon.',
    traderSource: 'Weighted by this trader’s currently published strategy, read from chain.',
    portfolioSource: 'Weighted by the market value of your current positions.',
    empty: 'No holdings to calculate from.',
    pct: '{pct}%',
  },

  title: 'ESG Information',
  lead: 'The platform does not rate assets. Below is what each rating agency has published itself, each with its source, rating date and the date we read it. Click a row for that asset’s details.',

  /** See `../zh-TW/esg.ts`. */
  thirdParty: {
    rights:
      'Ratings are the copyright of each rating agency. They are quoted here, with a link to the original page, for an academic, non-commercial project; check the original page for the latest value before citing one.',
    legend: {
      title: 'How to read this table',
      light: 'Colours follow only the groups an agency defines itself: MSCI’s Leader / Average / Laggard, Sustainalytics’ five risk categories, and Morningstar’s globes for funds. Green, amber and red are the better, middle and worse groups of that agency.',
      scoreOnly: 'Agencies that publish only a score with no groups of their own (LSEG, S&P Global) are shown as the number, uncoloured; the platform does not draw thresholds for them.',
      noAverage: 'Every agency uses a different method, scale and direction (lower is better for Sustainalytics, higher for the others), so ratings are never added up, averaged or used to rank assets.',
    },
    column: {
      asset: 'Asset',
      carbonTier: 'Carbon tier',
      carbonTierSub: 'Platform risk policy',
    },
    light: {
      good: 'Better',
      middle: 'Middle',
      poor: 'Worse',
    },
    cell: {
      notPublic: 'Not public',
      unrated: 'Unrated',
      notApplicable: 'Not covered',
    },
    noRating: 'Unrated',
    provider: {
      msci: {
        name: 'MSCI',
        scale: 'AAA–CCC. AAA and AA are Leaders; A, BBB and BB are Average; B and CCC are Laggards.',
        scope: 'ETFs carry the MSCI ESG Fund Rating, read from the iShares product page. MSCI company ratings are only available to paying clients, so equities show “Not public”.',
      },
      sustainalytics: {
        name: 'Sustainalytics',
        scale: 'For equities, an ESG Risk Rating where lower is better, in five categories from negligible to severe; for ETFs, Morningstar’s globes (1–5, more is better), relative to the fund’s category.',
        scope: 'Morningstar Sustainalytics ratings, read from the stock and fund pages on morningstar.com.',
      },
      lseg: {
        name: 'LSEG',
        scale: 'ESG Scores, 2026 edition: 0–5, higher is better, with environmental, social and governance pillars and 12 theme scores.',
        scope: 'Rates companies only, from each company’s self-reported data for a fiscal year; read from LSEG’s ESG Scores Finder.',
      },
      spGlobal: {
        name: 'S&P Global',
        scale: '0–100, higher is better, comparable only with peers in the same industry, never across industries.',
        scope: 'Rates companies only — not ETFs or crypto assets.',
      },
      ccdata: {
        name: 'CCData × CCRI',
        scale: 'AA–E, covering the 40 most liquid crypto assets.',
        scope: 'The edition we could read first-hand is the first one, from July 2023; later editions no longer have an original page, so the grade may be out of date.',
      },
    },
    group: {
      msci: { good: 'Leader', middle: 'Average', poor: 'Laggard' },
      sustainalytics: { negligible: 'Negligible risk', low: 'Low risk', medium: 'Medium risk', high: 'High risk', severe: 'Severe risk' },
      globes: { g1: 'Low', g2: 'Below average', g3: 'Average', g4: 'Above average', g5: 'High' },
      controversy: { c1: 'Low', c2: 'Moderate', c3: 'Significant', c4: 'High', c5: 'Severe' },
    },
    issue: {
      humanCapital: 'Human capital',
      businessEthics: 'Business ethics',
      dataPrivacy: 'Data privacy and cybersecurity',
      productGovernance: 'Product governance',
      carbonProducts: 'Carbon (products and services)',
    },
    area: {
      customer: 'Customer',
      societyCommunity: 'Society and community',
      operations: 'Operations',
      businessEthics: 'Business ethics',
      employee: 'Employee',
    },
    pillar: { e: 'Environmental', s: 'Social', g: 'Governance' },
    theme: {
      climateTransition: 'Climate transition',
      energyResourceUse: 'Energy and resource use',
      biodiversity: 'Biodiversity',
      waterUse: 'Water use',
      wastePollution: 'Waste and pollution',
      labourRelations: 'Labour relations',
      healthSafety: 'Health and safety',
      humanRightsCommunity: 'Human rights and community',
      boardManagement: 'Board and management',
      shareholderRights: 'Shareholder rights',
      conductAntiCorruption: 'Conduct and anti-corruption',
      taxTransparency: 'Tax transparency and accounting',
    },
    detail: {
      ratedOn: 'Rated',
      retrievedOn: 'Read on',
      fiscalYear: 'Data year',
      fiscalYearValue: 'FY{year} (self-reported)',
      source: 'Original page',
      outOf: ' / {max}',
      industry: 'Industry',
      industryRank: 'Industry rank',
      industryRankValue: '{rank} of {of}',
      pillars: 'Environmental, social, governance (0–5)',
      themes: '12 themes (0–5)',
      msciQuality: 'ESG Quality Score (0–10)',
      msciPeer: 'Peer percentile',
      msciPeerValue: '{pct}% (of {count} funds)',
      msciWaci: 'Weighted average carbon intensity (tCO2e / $M sales)',
      msciItr: 'Implied temperature rise',
      msciCoverage: 'MSCI coverage',
      controversy: 'Highest controversy level (1 low, 5 severe)',
      controversyAsOf: 'Controversy assessed',
      controversyAreas: 'Areas',
      topIssues: 'Top material ESG issues',
      fundRisk: 'Portfolio corporate ESG risk score (0–50, lower is better)',
      fundRiskValue: 'Current {now}, historical {hist}',
      fundCoverage: 'Share of fund assets with a score',
      spCsa: 'CSA score (without modelling)',
      spUnderReview: 'S&P marks this score as under review: it is assessing a controversy linked to the company, and the score may be adjusted.',
      spRespondent: 'This company responds to S&P’s Corporate Sustainability Assessment (CSA).',
      spPublicInfo: 'This company does not respond to S&P’s CSA; the score is modelled from public information.',
      notPublic: '{provider} rates this kind of asset, but its individual ratings are not public.',
      unrated: '{provider} rates this kind of asset, but has not rated this one.',
      noRating: 'No agency has published a rating for this asset. That does not mean it was rated poorly — nobody has rated it.',
      rawTitle: 'Raw environmental data',
      rawLead: 'Figures and their sources only — never converted into a score or a colour.',
      carbonTierTitle: 'Carbon tier (platform risk policy)',
      carbonTierNote:
        'The carbon tier applies fixed thresholds to published emissions data and sets this asset’s trading fee and leverage cap on the exchange. It is the platform’s risk policy, not an ESG rating.',
    },
    method: {
      title: 'Why it is shown this way',
      items: [
        'ESG ratings are specialist research. The platform does not score assets itself; it only quotes what rating agencies publish.',
        'MSCI company ratings have no public lookup, so the MSCI column shows “Not public” for equities. CDP’s terms restrict its scores to internal use, and Bloomberg and WRDS are academic licences — none of them can go on a public site.',
        '“Not public” means rated but not visible; “Unrated” means not rated; “Not covered” means the agency does not rate this kind of asset at all. They mean different things and are labelled separately.',
      ],
    },
  },
};
