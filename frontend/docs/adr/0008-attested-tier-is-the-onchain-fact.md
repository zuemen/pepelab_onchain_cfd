---
status: accepted
---

# The attested Carbon Tier is the on-chain fact — not an intensity that pricing derives one from

`CarbonTiers.tierOf` maps a carbon intensity to a Tier against three thresholds whose unit is tCO2e per $1M of trailing revenue. Its own NatSpec is explicit that this only works for assets that have revenue, that a commodity or a cryptocurrency must have its Tier **assigned directly** by whatever basis is defensible for it, and that feeding a cross-class-normalised number in "will not revert; it will silently produce a tier that is numerically consistent and substantively wrong". `docs/data/carbon-intensity.md` reaches the same conclusion independently and recommends storing the tier assignment as the on-chain fact.

Neither was followed. `ESGRegistryV2.Attestation` stores an intensity and no tier, and `PerpetualExchange` feeds the attested median straight into `tierOf`. The consequence is visible in the deployment data: five of the eleven assets — sBTC, sETH, sGOLD, sBOND, sICLN — carry a value chosen to land them in the intended bucket rather than measured. sBTC's `9.0` is not a quantity; it is `High` encoded as a fake revenue intensity. The deploy script's own asset table carries a `revenueBasis` flag distinguishing these from real measurements, and that flag is not part of the attestation — it lives only in a script comment.

Meanwhile the frontend already models this correctly: its asset carbon record holds a nullable intensity, an explicit tier, and a three-valued basis. So the two layers hold different answers to "what is the on-chain fact", each internally consistent.

The decision is to make the Tier itself the attested fact. An Attestor records the Tier they reached and the Carbon Basis they reached it on; a revenue-basis attestation still carries its intensity, because that is a real auditable quantity and throwing it away would lose information. Reads return a median Tier, and both the exchange and the vault price off that. `tierOf` survives, but only for revenue-basis assets and only to reject an attestation whose declared Tier contradicts its own declared intensity.

## Considered options

**Leave the vault to derive tiers the way the exchange already does.** Consistent with the existing code, and free. Rejected because it propagates the defect onto the path that now sets the platform's front-door price, and it does so for five of eleven assets. It also keeps the "this is a placement, not a measurement" distinction unrepresentable, while the asset screens display the placement value next to a clickable source URL — inviting a user to go and verify a number that was never measured. Verifiability is this platform's entire argument against ESG funds; publishing an unverifiable number under the shape of a verifiable one is the specific failure it exists to criticise.

**Store a per-asset Tier on the vault itself, settable by the risk role.** Cheapest by a wide margin and needs no redeployment. Rejected outright, not on cost: a settable tier is a settable price, and "a threshold an operator could adjust is a discretionary policy" is the repositioning's own load-bearing sentence. It would also hand the defence's centrepiece — an operator trying to bend the carbon rate and failing — a trivial counterexample.

**Keep a single intensity field and add a second, class-specific set of thresholds.** Rejected because it multiplies the thing `CarbonTiers` exists to keep singular. The whole reason the library is one pure function is that PerpetualExchange, CopyTracker, screens and offline analysis cannot be allowed to disagree; a second threshold table reintroduces exactly that risk one level down.

**Record basis as a boolean (`revenueBasis` yes/no), matching the deploy script.** Rejected as lossier than what the frontend already shows. "Placed against a network-level emissions benchmark" and "placed on what the fund holds" differ in how far a reader can independently go, and the provenance card already distinguishes them for the user. On-chain state should not be coarser than the screen rendering it.

## Consequences

- `ESGRegistryV2` has no proxy, so changing the attestation record means redeploying it; `PerpetualExchange` holds its registry address as `immutable`, and `CopyTracker` and `EsgRewardDistributor` hold the exchange the same way. This triggers a second chained redeployment on the scale of #102. That cost was weighed and accepted rather than discovered.
- All eleven assets must be re-attested on the new registry, now with a Tier and a Basis. An asset missed in that pass reads as unrated and prices at the most conservative tier — fail-closed, which is the right failure, but it will be silent.
- `tierOf` remains in the library while no pricing path calls it. That is intentional and this ADR is the reason: it is the consistency check for revenue-basis attestations, and the derivation path for anyone reasoning about a revenue-basis asset offline.
- A revenue-basis attestation whose declared Tier disagrees with `tierOf` of its own intensity is rejected at submission. That rule is what stops the two representations drifting apart a second time, and it is the single most important test in this change.
- `CarbonTiers`'s NatSpec and `docs/data/carbon-intensity.md`'s "Open questions for #95" both need updating: the question they leave open is now closed, and they should point here rather than continuing to describe it as undecided.
- Cross-class comparability is **not** solved. An `absolute`-basis Tier and a `revenue`-basis Tier are still not the same kind of claim. What changes is that the incomparability is now recorded on chain and shown on screen, instead of being flattened into one number that looks comparable and is not.
