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
      light: 'Colours follow only the groups an agency defines itself (currently only MSCI: Leader, Average, Laggard).',
      scoreOnly: 'Agencies that publish only a score with no groups of their own (S&P Global) are shown as the number, uncoloured; the platform does not draw thresholds for them.',
      noAverage: 'Every agency uses a different method and scale, so ratings are never added up, averaged or used to rank assets.',
    },
    column: {
      asset: 'Asset',
      carbonTier: 'Carbon tier',
      carbonTierSub: 'Platform risk policy',
    },
    light: {
      leader: 'Leader',
      average: 'Average',
      laggard: 'Laggard',
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
      spGlobal: {
        name: 'S&P Global',
        scale: '0–100, comparable only with peers in the same industry, never across industries.',
        scope: 'Rates companies only — not ETFs or crypto assets.',
      },
      ccdata: {
        name: 'CCData × CCRI',
        scale: 'AA–E, covering the 40 most liquid crypto assets.',
        scope: 'The edition we could read first-hand is the first one, from July 2023; later editions no longer have an original page, so the grade may be out of date.',
      },
    },
    detail: {
      ratedOn: 'Rated',
      retrievedOn: 'Read on',
      source: 'Original page',
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
        'Sustainalytics and MSCI company ratings currently have no public lookup, so they are not listed. CDP’s terms restrict its scores to internal use, so it is not listed either.',
        '“Not public” means rated but not visible; “Unrated” means not rated; “Not covered” means the agency does not rate this kind of asset at all. They mean different things and are labelled separately.',
      ],
    },
  },
};
