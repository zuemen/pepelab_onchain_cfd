---
status: accepted
---

# 永續 means Sustainability on screen; the perpetual mechanism loses the word entirely

Two unrelated things in this product both answer to the Chinese word 永續. `PerpetualExchange` is a 永續合約 — a perpetual contract, the funding-rate mechanism that keeps a position open without an expiry date. The platform's repositioning makes 永續投資 — sustainable, ESG-aware investing — its core pitch, and `ESGRegistry` and `EsgRewardDistributor` were already on chain serving that sense before the pitch existed.

This is the same shape of collision as [ADR 0003](./0003-rwa-dual-meaning.md), and it was tempting to resolve it the same way: let both senses stand, each precise in its own context. It does not work here. The two RWA senses are safe together because one lives on screens and the other lives in Solidity, and a reader is never holding both at once. These two are not so lucky — a portfolio screen showing sustainability scores would sit directly above a position opened on a perpetual, and both would want the word 永續 in the same viewport. Precision by context fails when the contexts share a screen.

The decision is that Sustainability takes the word outright. 永續 in any display string means the ESG sense. The perpetual mechanism is demoted to an implementation detail: it keeps its English name in Solidity and in engineering conversation, and it is never rendered into Chinese anywhere a user can read it. A user learns what they hold and what it costs to hold; they are never told that a perpetual is the thing carrying it.

## Considered options

**Keep both senses, disambiguated by context (the ADR 0003 approach).** Rejected because the contexts overlap here rather than staying apart — see above. The mitigation would be qualifying every use (永續投資 vs 永續合約) forever, in every string, and the first time someone writes bare 永續 the ambiguity is back.

**Rename the sustainability pitch instead — 綠色投資, ESG 投資, 責任投資.** Rejected because 永續投資 is the established Chinese term for this category of investing; a platform whose entire repositioning rests on that category cannot afford to use a word the audience does not already recognise for it. The perpetual mechanism has no such constraint — it has a perfectly good English name and an audience of engineers.

**Keep 永續合約 in display text and accept the collision as a curiosity.** Rejected because the collision is not neutral. The platform is repositioning *away* from being read as a speculation venue; leaving 永續合約 on screen means the strongest signal of the old positioning sits inside the word carrying the new one.

## Consequences

- Display text never names the mechanism. Costs, margin and liquidation still have to be explained to the user, but in terms of what happens to their money rather than in terms of the instrument that does it.
- The trading vocabulary table in [CONTEXT.md](../../CONTEXT.md#trading-vocabulary-chinese-to-english) now maps terms that are mostly contract-layer only. It stays valid as an engineering reference; which of its rows may still appear on screen is a separate decision this ADR does not make.
- Solidity, tests, and `docs/` keep saying perpetual. No contract-side renaming follows from this ADR — the same division of labour as ADR 0003.
- Any future screen that genuinely needs to distinguish the two senses is a signal the mechanism has leaked back into the display layer, and the fix is to remove the leak rather than to qualify the word.
