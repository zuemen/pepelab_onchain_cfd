# Carbon Intensity Data — Source Table

> Deliverable for [#94](https://github.com/zuemen/pepelab_onchain_cfd/issues/94), part of [#93](https://github.com/zuemen/pepelab_onchain_cfd/issues/93).
> Collected 2026-09-02. Every figure below traces to a named public source with a retrieval date.
> This table is a data-collection deliverable, not a contract or a promise — see "Open questions for #95" before wiring it into `CarbonTiers`.

## Why this table has to be real

ADR-003 prices holding cost and leverage on Carbon Intensity instead of an aggregate ESG score specifically because carbon "carries a unit and an auditable source" while a composite score is opinion. That claim is only true if every number in this table actually traces to something. If any figure here were invented, the platform's strongest argument would fail on inspection. So: real filings, real sustainability reports, one hop of aggregator citation at most, and every row names its source.

## Method, asset by asset

**Basis chosen:** Scope 1 + Scope 2 (market-based) greenhouse gas emissions, most recent reported fiscal year, divided by that same fiscal year's total revenue — `tCO2e / $M revenue`. This is the standard "operational carbon intensity" metric used in sustainability reporting; it excludes Scope 3 (supply chain / product use), which is directionally important but not consistently disclosed or comparable across these five companies yet.

| Asset | Scope 1+2 (market-based), tCO2e | Fiscal year | Revenue, $M | **Intensity, tCO2e/$M revenue** | Source | Retrieved |
|---|---:|---|---:|---:|---|---|
| sAAPL (Apple) | 58,500 (55,200 + 3,300) | FY2024 | 391,035 | **0.150** | Apple Environmental Progress Report 2024 (emissions), via [Tracenable](https://tracenable.com/company/apple/ghg-emissions); Apple FY2024 Form 10-K (revenue), [SEC EDGAR](https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm) | 2026-09-02 |
| sNVDA (Nvidia) | 12,952 (12,952 + 0) | FY2025 | 130,500 | **0.099** | Nvidia Sustainability Report 2025, via [Tracenable](https://tracenable.com/company/nvidia/ghg-emissions); Nvidia FY2025 10-K / earnings release, [SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1045810/000104581025000023/nvda-20250126.htm) | 2026-09-02 |
| sGOOGL (Alphabet) | 3,132,200 (73,100 + 3,059,100) | FY2024 | 350,000 | **8.949** | Alphabet Environmental Report 2025 (covers FY2024 data), via [Tracenable](https://tracenable.com/company/alphabet/ghg-emissions); Alphabet FY2024 results, [SEC 8-K](https://www.sec.gov/Archives/edgar/data/1652044/000165204425000010/googexhibit991q42024.htm) | 2026-09-02 |
| sTSLA (Tesla) | 979,000 (302,000 + 677,000) | FY2024 | 97,690 | **10.021** | Tesla Impact Report 2024, via [Tracenable](https://tracenable.com/company/tesla/ghg-emissions); Tesla FY2024 10-K, [SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1318605/000162828025003063/tsla-20241231.htm) | 2026-09-02 |
| sMSFT (Microsoft) | 2,880,890 (170,890 + 2,710,000) | FY2025 | 281,724 | **10.226** | Microsoft 2025 Environmental Sustainability Report, cross-checked via [DitchCarbon](https://ditchcarbon.com/organizations/microsoft) against a second independent search of the same primary report; Microsoft FY2025 10-K, [SEC EDGAR](https://www.sec.gov/Archives/edgar/data/789019/000095017025100235/msft-20250630.htm) | 2026-09-02 |

**Known distortion, must be stated on screen wherever this number appears:** "market-based" Scope 2 lets a company report near-zero grid emissions by purchasing renewable energy certificates (RECs) or power purchase agreements (PPAs), regardless of what's actually flowing through the local grid at the time of consumption. Nvidia's Scope 2 of exactly zero is a market-based artifact of 100% REC/PPA coverage, not a claim that its data centers draw zero physical electricity. This is a limitation of the chosen metric, not a data error — flagged rather than hidden, per this repo's existing convention (README's treatment of the Pyth relay, the funding-interval bug, etc.).

### sGOLD (commodity — no revenue, priced by physical output instead)

Gold has no "revenue" to divide by, so operational carbon intensity is reported per unit of physical output instead, which is the industry's own convention.

| Metric | Value | Source | Retrieved |
|---|---|---|---|
| Global average mining emissions | **0.85 tCO2e / oz** (2019 global average; open-pit ≈0.85, underground ≈0.40 tCO2e/oz) | S&P Global Market Intelligence, ["Greenhouse gas and gold mines"](https://pages.marketintelligence.spglobal.com/greenhouse-gas-and-gold-mines-EMC.html), citing sector-wide GHG Protocol disclosures compiled for the World Gold Council | 2026-09-02 |
| Sector absolute emissions | > 100 Mt CO2e / year globally | Same source | 2026-09-02 |
| Spot price (context only, not used in the intensity figure) | ≈$4,324 / oz | [Kitco](http://www.kitco.com/charts/gold), 2026-09-01 | 2026-09-02 |

**A note on why this isn't converted to $/M like the equities:** dividing 0.85 tCO2e by a single ounce's dollar price produces a number roughly 1,000× larger than the equity intensities above — not because gold mining is a thousand times worse, but because an ounce of gold concentrates enormous dollar value into a tiny physical unit, while a company's revenue is a full year's economic output. Forcing gold onto the same $M-revenue denominator as the equities would produce a misleading tier placement driven by a unit-conversion artifact, not by real environmental impact. See "Open questions for #95" below.

### sBTC / sETH (crypto — no revenue, network-level energy accounting)

| Asset | Annualized network emissions | Basis | Source | Retrieved |
|---|---:|---|---|---|
| sBTC (Bitcoin) | **≈39.8 Mt CO2e / year** (≈138 TWh/year electricity) | Proof-of-work mining, global grid mix | Cambridge Centre for Alternative Finance, [2025 Cambridge Digital Mining Industry Report](https://ccaf.io/cbnsi/cbeci/ghg) (CBECI) | 2026-09-02 |
| sETH (Ethereum) | **≈2,370 tCO2e / year** (≈7.87 GWh/year electricity) | Proof-of-stake, post-Merge | Cambridge Centre for Alternative Finance, [2026 Ethereum climate-footprint report](https://www.jbs.cam.ac.uk/2026/new-report-maps-ethereums-climate-footprint-with-new-precision/) | 2026-09-02 |

Bitcoin's absolute footprint (~39.8 Mt CO2e/yr, comparable to a small country's annual emissions) is roughly **16,800× larger** than Ethereum's (~2.37 kt CO2e/yr) — the gap the "proof-of-work vs. proof-of-stake" narrative is actually about. This is the number that should drive tiering, not a market-cap-normalized one — see below.

**Why market-cap normalization is rejected here:** dividing each network's annual emissions by its market capitalization (BTC ≈$1.57T, ETH ≈$293B — [CoinDesk](https://www.coindesk.com/price/bitcoin) / [Coinbase](https://www.coinbase.com/price/ethereum), both 2026-09-01) produces ≈0.025 tCO2e/$M for BTC and ≈0.000008 tCO2e/$M for ETH — both *lower* than Apple and Nvidia. That result would place Bitcoin in the platform's lowest carbon tier, directly contradicting the widely-documented, well-sourced reality that Bitcoin mining draws as much power as a mid-sized country. The distortion is structural: market cap is a *stock* (accumulated valuation, driven by speculation and scarcity), not a *flow* (ongoing economic output), so it is not the right denominator for an *ongoing operational emissions* question. Revenue is the right denominator for a company precisely because revenue is also a flow. Gold and crypto have no equivalent flow, so this table reports their absolute annualized emissions and leaves the cross-asset-class normalization as an explicit open question rather than picking a denominator that produces a number known to be misleading.

### sICLN / sESGU (ETFs — holdings-weighted, partial coverage)

Full holdings-weighted intensity requires constituent-level Scope 1+2 and revenue data for every holding, which is what commercial ESG data vendors (MSCI, Sustainalytics) sell. Manually collecting that for two diversified ETFs is out of proportion for a data-gathering ticket, so this table reports what a top-holdings pass actually supports, states its coverage honestly, and does not extrapolate beyond it.

**sICLN (iShares Global Clean Energy ETF).** Top-10 holdings (First Solar, China Yangtze Power, NextEra/NextPower, Bloom Energy, Enphase Energy, Iberdrola, Ormat, Equatorial, Vestas Wind Systems, EDP) are ≈50% of the fund and are exclusively renewable power generation and equipment companies — a sector with a structurally low emissions-per-revenue profile compared to fossil-fuel-dependent or heavy-manufacturing sectors. No constituent-level Scope 1+2 figures were collected for this pass. **Placed in Low by sector composition, not by computed intensity — flagged as qualitative.**
Source: [iShares ICLN fact sheet](https://www.ishares.com/us/literature/fact-sheet/icln-ishares-global-clean-energy-etf-fund-fact-sheet-en-us.pdf), holdings via [stockanalysis.com](https://stockanalysis.com/etf/icln/holdings/), retrieved 2026-09-02.

**sESGU (iShares ESG Aware MSCI USA ETF).** A broad, market-cap-weighted, ESG-screened large-cap US portfolio — in practice close to the S&P 500 with a handful of exclusions. Its top-10 holdings overlap heavily with names already in this table:

| Holding | Weight | Intensity (this table) |
|---|---:|---:|
| NVDA | 7.21% | 0.099 |
| AAPL | 6.39% | 0.150 |
| MSFT | 4.56% | 10.226 |
| GOOGL | 4.31% | 8.949 |
| TSLA | 1.89% | 10.021 |
| AMZN, AVGO, META, LLY, JPM | 8.00% (combined) | not collected this pass |

Weighted average over the ≈24.4% of the fund with intensity data collected here: **≈4.34 tCO2e/$M revenue** (partial coverage — the remaining ≈75.6% of the fund, including the rest of the top-10 and the long tail of smaller holdings, is not reflected in this figure and could shift it materially in either direction). **Provisionally placed in Mid; flagged as a partial estimate.**
Source: holdings via [stockanalysis.com](https://stockanalysis.com/etf/esgu/holdings/) and a second independent search, [iShares ESGU fact sheet](https://www.ishares.com/us/literature/fact-sheet/esgu-ishares-esg-aware-msci-usa-etf-fund-fact-sheet-en-us.pdf), retrieved 2026-09-02.

### sBOND replacement — BGRN, placed qualitatively (decided in #106)

> The research below concluded BGRN does not cleanly pass this table's *computed*-intensity method, for structural reasons (a green bond's greenness is the bond's property, not the issuer's). #106 adopted **option 2**: keep the ETF, place it qualitative **Low**, same as sICLN. See "Decision (#106)" at the end of this section.


**Name correction first:** the candidate named in earlier drafts of this work, "iShares Global Green Bond ETF (BGRN)," has been renamed by the issuer. The ticker BGRN now trades as **iShares USD Green Bond ETF** — narrower scope (USD-denominated only), same underlying strategy. Every reference to "Global Green Bond ETF (BGRN)" elsewhere in this repo's docs refers to this same fund under its old name.

**Fund facts** (iShares USD Green Bond ETF fact sheet, retrieved 2026-09-02): AUM ≈$445.89M, **329 holdings**, top-10 holdings are only **13.5%** of assets, largest single holding is the European Investment Bank at **3.75%**. Source: [iShares BGRN fact sheet](https://www.ishares.com/us/literature/fact-sheet/bgrn-ishares-usd-green-bond-etf-fund-fact-sheet-en-us.pdf), holdings breakdown corroborated across two independent searches.

**Why this fails the criteria as scoped, and it isn't a data-availability problem:**

1. **Too diffuse for the method used on sESGU.** sESGU's top-10 already carried 35.8% of the fund, enough to make a partial weighted estimate meaningful. BGRN's top-10 is 13.5% with no holding above 3.75% — reaching even 50% coverage means pricing dozens of individual bond issuers, not a handful.
2. **Most of those issuers don't have "revenue" in a comparable sense.** The largest holdings are supranationals — European Investment Bank, and (per further search, unconfirmed at exact weight) World Bank/IBRD and KfW. These institutions don't file a 10-K or report commercial revenue; the `tCO2e / $M revenue` metric used for the five equities in this table doesn't apply to them at all, not even in principle.
3. **A green bond's "greenness" is a property of the specific bond, not the issuer.** This is the structural issue, and it would remain even with unlimited research time. Green bonds fund an earmarked project (a solar farm, a green building); an issuer that is carbon-intensive overall can still issue one green bond for one project. Reading BGRN's constituents through the equities' "issuer-level operating carbon intensity" lens measures the wrong thing — the number that actually describes a green bond fund is **portfolio-level avoided-emissions impact reporting**, which is a different kind of statistic entirely and is reported by the issuer, not derived by dividing two numbers.

**That correct metric exists but I could not verify it first-hand.** iShares publishes an annual *"iShares USD Green Bond ETF Impact Report"* with fund-level avoided-emissions figures — exactly the right number for this asset class. Both hosts serving it (`ishares.com`, `blackrock.com`) returned `403 Forbidden` to automated fetch in this session. Secondary search results reference figures from it (e.g. one funded project category "≈670,000 tCO2e/yr avoided" from energy-efficient data centers) but not in a form I'm willing to transcribe as a verified, dated, fund-level figure — the summaries read as loosely paraphrased, not quoted, and I could not confirm which reporting year they belong to. Per this table's own standard (every number traces to a source I actually read), I am not writing that number in.

**Recommendation — three paths, in order of preference:**

1. **(Best, needs a human)** Someone with normal browser access downloads the BGRN Impact Report PDF directly and extracts the fund-level avoided-emissions-per-$M-invested figure. That is the methodologically correct number for this asset and this table should be updated with it once available.
2. **(Fallback, buildable now)** Treat BGRN like sICLN: place it by **asset-class benchmark rather than a computed number** — a diversified investment-grade green bond fund is, by the Green Bond Principles' own eligibility criteria, structurally lower-carbon-*intent* than an unscreened bond index, and gets a qualitative **Low** placement, flagged exactly as approximate as sICLN's is. Zero additional research cost; ships within this ticket's remaining budget.
3. **(Alternative asset)** Replace the ETF wrapper with a small basket of individually well-documented supranational green bonds instead — e.g. KfW's own disclosure (a real, sourced figure surfaced in this research: "EUR 12.2bn net 2024 green bond proceeds → ≈2.3 million tCO2e/yr avoided," [ESG Today](https://www.esgtoday.com/blackrock-launches-green-bond-and-climate-risk-focused-global-government-bond-etfs/)) is exactly the single-issuer, well-reported kind of instrument this table's method actually works for. This is a bigger change — it swaps "an ETF" for "a small set of named bonds" as the product — so it needs sign-off, not a silent substitution.

**Working default for this ticket:** option 2 (qualitative Low, same treatment as sICLN). Someone should still pursue option 1 before #95 is implemented, since it would replace an approximation with a real number at near-zero cost if it succeeds.

**Decision (#106):** option 2. `sBOND` now tracks **BGRN (iShares USD Green Bond ETF)** — keeper feed, `symbols.ts`, frontend `assetMeta`/`tokens`/`esg`, and the deploy/seed script name strings all updated. The market **symbol stays `sBOND`** (a generic "synthetic bond exposure" name): renaming it would change the `keccak256` asset id and cascade through the four-contract rewiring, and #102's redeploy registers the same id against the new BGRN feed. The initial oracle / candle seed price moved from ~$100 (TLT) to ~$48 (BGRN) so the keeper's first real fetch clears the deviation guard. Option 1 (the BGRN Impact Report's fund-level avoided-emissions figure) is still the number this row should eventually carry.

## Proposed carbon tiers

Fixed thresholds, not settable parameters — per ADR-003, an adjustable threshold is a discretionary policy, and non-discretion is the whole point of pricing on this instead of an ESG score.

**For revenue-based assets (equities, and any future revenue-generating RWA):**

| Tier | Threshold |
|---|---|
| Low | < 1 tCO2e / $M revenue |
| Mid | 1 – 8 tCO2e / $M revenue |
| High | > 8 tCO2e / $M revenue |

This places the five equities as a natural bimodal split: {AAPL 0.150, NVDA 0.099} → Low; {GOOGL 8.949, TSLA 10.021, MSFT 10.226} → High. Nothing currently lands in Mid among the five — that band exists for assets added later, and is where sESGU's partial estimate (≈4.34) provisionally sits.

**For non-revenue assets (commodities, crypto), placed by absolute annualized emissions and sector benchmark rather than a $-normalized figure, per the rejections documented above:**

| Asset | Tier | Basis |
|---|---|---|
| sETH | **Low** | ≈2,370 tCO2e/yr absolute — smaller than any single company's Scope 1 in this table |
| sICLN | **Low** | sector composition (renewable generation/equipment); qualitative, not computed |
| sESGU | **Mid** | partial weighted computation, ≈4.34 tCO2e/$M revenue-equivalent, ≈24% coverage |
| sGOLD | **High** | 0.85 tCO2e/oz industry benchmark; >100 Mt CO2e/yr sector-wide |
| sBTC | **High** | ≈39.8 Mt CO2e/yr absolute — comparable to a small country's annual emissions |
| sBOND → iShares USD Green Bond ETF (BGRN) | **Low** (decided, #106) | sector/instrument-class benchmark, qualitative — see full writeup below; not a computed number |

## Open questions for #95

This table deliberately does not force one $-normalized number across every asset class, because doing so (market-cap normalization for crypto, spot-price normalization for gold) produces results that are numerically consistent but substantively misleading — see the rejections above. `ESGRegistryV2` / `CarbonTiers` need one of:

1. **Two parallel bases, unified only at the tier label** (recommended): store the tier assignment (Low/Mid/High) as the on-chain fact for every asset, computed off whichever basis is defensible for that asset class (revenue-intensity for equities/ETFs, absolute-emissions benchmark for commodities/crypto). `CarbonTiers` then consumes the tier, not a single raw intensity number. This keeps the pricing/leverage logic asset-class-agnostic while keeping each tier assignment individually defensible.
2. **A single normalized score** (e.g., percentile rank across all registered assets) computed at attestation time. More elegant on-chain, but harder to defend in the open — "why is this asset's score 62" is a harder question to answer than "this asset's tier is High because its absolute annual emissions exceed X."

Recommendation: (1). It matches this table's own reasoning, requires no new on-chain math beyond storing an enum, and keeps every tier assignment traceable to a specific, stated justification rather than a formula that has to be defended as a whole.

## Coverage gaps, stated plainly

- Scope 3 (supply chain, product use) is excluded throughout. For several of these companies (Apple, Tesla) Scope 3 dwarfs Scope 1+2 by 10–20×. This table measures *operational* carbon intensity, not *full lifecycle* carbon intensity — a real and material limitation, not a rounding error.
- sESGU's intensity is a ≈24%-coverage partial estimate, not a full fund computation.
- sICLN's Low placement is qualitative (sector composition), not computed from constituent data.
- Alphabet and Tesla emissions are FY2024; Microsoft and Nvidia are FY2025 (their most recently completed fiscal years as of collection date) — the four companies do not all share a fiscal year, which is disclosed per-row above rather than normalized away.
- The sBOND replacement (BGRN) has **no computed intensity at all** — its Low placement is a sector-benchmark judgment call, not arithmetic, and the fund's own Impact Report (which would supply a real number) could not be fetched in this session. This is the least-verified row in the table and should be the first one revisited.
