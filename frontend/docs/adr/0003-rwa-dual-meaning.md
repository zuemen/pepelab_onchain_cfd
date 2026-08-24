---
status: accepted
---

# RWA keeps two meanings — screen copy and the contract's `rwaAsset` gate — rather than merging them

The word "RWA" was already load-bearing in two places that disagree with each other. `PerpetualExchange.rwaAsset` and `KYCRegistry` use it narrowly: a market is RWA if and only if it requires KYC, which today means equity, bond, and ETF — crypto and gold are explicitly not RWA by that definition. The Portfolio page's new Asset Class breakdown (股/債/金/幣 — Equity, Bond, Commodity, Crypto) needed a single word for "everything tradable here, real-world-linked or not," and "RWA" is the word the product's own competitive positioning already uses for that pitch (`docs/CAPSTONE_DELIVERABLES.md`, `docs/ADR-001-vs-hyperliquid.md`). Putting crypto inside a screen's "RWA" framing while the contract's `rwaAsset` mapping excludes it is a real conflict, not a wording nitpick — a reader who sees "RWA" on the Portfolio page and then reads `KYCRegistry`'s NatSpec will find the two sets of assets don't match.

The decision is to let both meanings stand, each precise in its own context, rather than force one word onto one meaning. `RWA` in display strings means the four-Asset-Class pitch; `RWA` in Solidity and in the KYC gate means the regulated three. [CONTEXT.md](../../CONTEXT.md#asset-classes-and-rwa) documents the split so nobody assumes one from the other.

## Considered options

**Rename the screen's term, leave "RWA" exclusive to the KYC gate.** E.g. "Multi-Asset Portfolio" or "Real-World & Digital Assets" for the four-class breakdown. Rejected because it throws away the one word the product's own positioning docs already treat as the headline differentiator — the whole point of surfacing this section was to make "RWA" the thing a visitor remembers, and a screen that avoids the word undercuts that.

**Widen the contract's definition of RWA to match the screen — extend `rwaAsset`/KYC gating to crypto and gold.** Rejected because it isn't a wording decision, it's a compliance decision: it would require KYC for markets that don't require it today. That tradeoff belongs to whoever owns the platform's KYC/regulatory posture, decided on its own merits — not settled as a side effect of picking copy for a portfolio widget.

## Consequences

- `RWA` appearing in a display string commits to nothing about whether `PerpetualExchange.rwaAsset(asset)` is true for that asset. Code that needs to know if KYC is required must read the contract mapping, never infer it from screen copy.
- `KYCRegistry` and `PerpetualExchange`'s NatSpec keep using RWA in the narrow sense; no contract-side renaming follows from this ADR.
- If a future screen needs to talk about *only* the KYC-gated markets specifically (as opposed to the four-Asset-Class pitch), it needs its own term — reusing bare "RWA" there would silently narrow the word back to the contract sense in one place while the Portfolio page keeps the wide sense, recreating the ambiguity this ADR resolves.
