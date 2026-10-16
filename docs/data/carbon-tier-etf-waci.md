# The issuer's own carbon data contradicts the sICLN / sESGU tiers

> Findings note, 2026-10-16. Follow-up to the #333 SDG source research (`docs/data/sdg-sources.md`), which ran into this by accident. **No tier has been changed.** This note says what is wrong, what a change would touch, and which option I recommend. The decision is the team's, because a tier is an on-chain attestation and a price (ADR-003, ADR-006 / frontend ADR 0008).

## What iShares itself publishes

Read first-hand from the iShares product pages on 2026-10-16. All figures are MSCI ESG Fund Ratings as of 2026-09-18, based on holdings as of 2026-08-31.

| Fund | Platform tier today (basis) | MSCI Weighted Average Carbon Intensity, tCO2e / $M sales | WACI coverage | MSCI Implied Temperature Rise |
|---|---|---:|---:|---|
| ICLN, iShares Global Clean Energy ETF ([product page](https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf)) | **Low** (qualitative) | **241.74** | 92.81% | > 1.5°–2.0°C |
| ESGU, iShares ESG Aware MSCI USA ETF ([product page](https://www.ishares.com/us/products/286007/ishares-esg-aware-msci-usa-etf)) | **Mid** (revenue, 4.34) | **71.05** | 99.73% | > 2.5°–3.0°C |
| BGRN, iShares USD Green Bond ETF ([product page](https://www.ishares.com/us/products/305296/ishares-usd-green-bond-etf)) | **Low** (qualitative) | **708.64** | 82.39% | > 3.0°C |

The fact sheets dated 2026-06-30 give 299.74 (ICLN) and 75.61 (ESGU). Those are the figures `sdg-sources.md` quotes. The direction is the same at both dates.

ICLN's sector breakdown on the same page (as of 2026-10-14) explains its figure. Renewable Electricity is 27.45%, Electric Utilities 15.36%, Independent Power 0.53% and Oil & Gas Refining 1.70%. Together that is roughly 45% of the fund in power generation, which has the highest Scope 1 emissions per dollar of revenue of any sector, even when much of a company's generation is renewable.

## Units: the figures are directly comparable, and that is the problem

The repo's revenue basis is Scope 1 + Scope 2 emissions divided by revenue, in tCO2e per $M revenue (`carbon-intensity.md` "Method"; `CarbonTiers.sol` NatSpec). MSCI's WACI is the TCFD-standard portfolio metric: each holding's Scope 1+2 emissions divided by its $M sales, weighted by its share of the portfolio. The unit and the emission scopes are the same, so the thresholds (Low < 1, Mid 1–8, High > 8) apply to these numbers as they stand. Only the data provider differs: the repo uses company reports with market-based Scope 2, while MSCI uses its own company dataset, and I did not confirm which Scope 2 basis MSCI uses. That difference could move a single stock across the 1 or 8 line. It cannot explain these gaps: ESGU sits about 9× above the High line and ICLN about 30× above it.

So, on the repo's own method:

- **sESGU's Mid does not hold.** The 4.34 figure covers only the ≈24% of the fund that was collected, and those holdings were not a random sample. They are the largest US tech names, which are the least carbon-intensive companies in the index (AAPL 0.150, NVDA 0.099). The other ≈76% includes utilities, energy and materials. The full-coverage figure from the issuer is 71.05, which `tierOf` puts in **High**. The doc already warned that the remainder "could shift it materially in either direction". It shifted up, by about 16×.
- **sICLN's Low does not hold as written.** The stated reason is that the holdings are "a sector with a structurally low emissions-per-revenue profile" (`carbon-intensity.md`; the on-screen caveat says the same). That is a factual claim about emissions per dollar of revenue, the quantity WACI measures, and the issuer's own number contradicts it: 241.74, also **High**. The investment case for clean energy is about avoided emissions, the fossil generation it displaces. The platform deliberately does not price on that (Scope 1+2 operational intensity only; avoided emissions are not in the method).
- **The screen sends users to the contradiction.** Both rows in `frontend/src/lib/pepefi/assetMeta.ts` use the iShares fact sheet as `sourceUrl`. A user who clicks it to verify the tier finds 241.74 / 71.05 printed there. Frontend ADR 0008 describes exactly this as the failure the platform exists to criticise: a placement shown beside a source URL that does not support it.

### sBOND (BGRN) is different, but should disclose its number

BGRN's 708.64 is the highest of the three. That figure measures the **issuers**: a utility or bank that issues a green bond carries all of its operating emissions into WACI. `carbon-intensity.md` already argues, under "sBOND replacement — BGRN", that the issuer-level lens is the wrong one for green bonds: the bond's proceeds are ring-fenced for a named project, and the investor funds that project, not the issuer's whole operations. A shareholder, by contrast, owns all of a company's operations. That is why the reasoning holds for BGRN but cannot be borrowed for ICLN, which holds equities. The qualitative Low for sBOND can therefore stand, but its row should state the 708.64 figure and the reason it is set aside, rather than leave a user to find it on the linked fact sheet.

## Options

**A. Keep both tiers and rewrite the reasons.** sICLN stays qualitative Low, with the reason changed from "low emissions per revenue" to "transition-enabling holdings (ITR 1.5–2.0°C)". sESGU stays Mid, with the WACI shown next to it as a disclosed counter-figure. This changes no code. The cost is to the argument: ADR-003 prices on carbon intensity *because* it is a unit with an auditable source, and this option overrides the auditable number in exactly the two places where it is inconvenient. ITR is a forward-looking MSCI model output, which is close to the "composite opinion score" that ADR-003 rejects. Keeping sESGU at Mid on a 24% sample while a 99.7% figure from the issuer exists would be hard to defend if anyone asks.

**B. Re-attest both ETFs on the revenue basis using the issuer's WACI (recommended).** sICLN → `Revenue`, 241.74, **High**. sESGU → `Revenue`, 71.05, **High**. Each becomes a cited, near-full-coverage figure, and the registry's existing check (`tier == tierOf(intensity)`) passes. sBOND stays qualitative Low and discloses its 708.64 as described above. What changes in the story: the platform prices *operational* carbon, so a clean-energy fund full of utilities is expensive to hold with leverage. That can be defended in the open ("we price what the companies emit, not what they displace, and here is iShares' own figure"). The narrative of ADR-003 and ADR-005, "sICLN is the cheapest asset", cannot.

**C. Add a fourth basis for transition alignment (ITR).** Rejected. It needs a new `Basis` enum value, so `ESGRegistryV2` would have to be redeployed, which cascades through the exchange, CopyTracker and the distributor exactly as ADR-006 describes. It also brings in a model-based score the platform has argued against.

**D. Move sESGU to High and keep sICLN Low.** Rejected. Using the issuer's WACI for one fund and setting it aside for the other, with the only difference being which answer is wanted, is the discretionary judgement that ADR-003's constants exist to prevent.

### Secondary observation, not a recommendation

The thresholds of 1 and 8 were set against five single stocks, mostly tech companies. Any diversified equity fund will probably have a WACI well above 8, so under option B both ETFs and any future broad fund land in High, and the Mid band is left empty. That follows from how the thresholds were calibrated; it is not a data error. ADR-003 makes the thresholds `internal constant`, so changing them would be a separate contract change. I am noting the question, not proposing that change.

## What option B would touch

Fees and leverage (`CarbonTiers.paramsFor`):

| | Trading fee | Borrow fee / hour | Max leverage |
|---|---:|---:|---:|
| sICLN: Low → High | 0.10% → 1.00% | 0.01% → 0.10% | 5× → 1× |
| sESGU: Mid → High | 0.40% → 1.00% | 0.04% → 0.10% | 2× → 1× |

The vault's entry fee follows the tier too (ADR-005). A position that is already open keeps the tier stored when it was opened (`CarbonPricing.t.sol`, "existing position's stored tier must not move").

On-chain attestations:

- `contracts/script/CarbonAttestations.sol` `a[9]` / `a[10]` → `(241_740 * 1e15, H, REV, …)` / `(71_050 * 1e15, H, REV, …)`. `sourceHash` currently hard-codes the date `2026-09-02` for every asset. The two re-sourced rows need their own date (2026-10-16), so the function would take a per-asset date.
- **No redeploy.** `ESGRegistryV2.attest` overwrites the calling attestor's own record for that asset, so changing a tier only means re-attesting. Every attestor counted in `medianCarbonTier` would need to re-attest, or the median will not move. On Base Sepolia this is cheapest if the decision lands **before the #344 cutover**, so the new registry is written once.

Local replay data:

- `heroes/herolab/assets.py` `CARBON_TIER` (a hand-copied mirror of the attestations, as its own docstring says). The schedule generator caps leg leverage at `max_leverage`, so sICLN / sESGU legs above 1× would be capped. The schedule, `heroes/out/*`, `frontend/public/data/heroes/*.json` and the lab data would all need to be regenerated.

Tests that pin today's tiers:

- `frontend/src/lib/pepefi/assetMeta.test.ts:85` (`sESGU`, 4.34, mid).
- `contracts/test/DeployLocalDemo.t.sol:58-59` (sESGU at 2× / 40 bps).
- `heroes/tests/test_assets.py:12,17` (sESGU at 2× / 40 bps).
- `agent/heroes/plan.test.ts` uses `sESGU: 40n` and a 2× sESGU leg as a fixture. It still passes, but it no longer reflects the real tier.
- Comments only: `CarbonTiers.t.sol:29`, `carbon.test.ts:31`, `CarbonPricing.t.sol:29` use 4.34 as the example Mid value "from the data table". The threshold tests stay correct; the comments would point at a number that is no longer used.

Docs and on-screen text:

- `carbon-intensity.md` (the sICLN/sESGU section, "Proposed carbon tiers", "Coverage gaps").
- `docs/CARBON_METHODOLOGY.md` (lines 82, 99–100, 122–124).
- ADR-003 line 32 ("sICLN lowest") and ADR-005 line 17 (the sICLN 0.10% example).
- `docs/DEPLOY_102_CUTOVER.md` (lines 348–353: the "low-carbon conservative" strategy is built on sICLN, and the "balanced" one uses sESGU as its Mid; line 387 expects sESGU at Mid).
- `frontend/src/locales/*/tokens.ts` provenance `carbonSource` / `carbonCaveat` for both ETFs, and the sBOND caveat ("same treatment as sICLN").
- `assetMeta.ts` rows.

## Recommendation

Option B, decided before the #344 Base Sepolia cutover. Whatever is decided, two text fixes are needed now because they are wrong under every option: sICLN's stated reason ("structurally low emissions-per-revenue") and sESGU's 24%-coverage figure being presented as the fund's intensity. If the team picks A, those caveats must cite 241.74 / 71.05 and say why the tier sets them aside.

## Also fixed in this branch

`carbon-intensity.md` now names BGRN's benchmark: **Bloomberg MSCI USD Green Bond Select Index** (Bloomberg ticker I36761US), from the iShares product page, 2026-10-16. The #333 research said this doc had the index name wrong. In fact no file in the repo named the index at all, so this adds the name rather than correcting one. `sdg-sources.md` line 127 should be reworded to match.
