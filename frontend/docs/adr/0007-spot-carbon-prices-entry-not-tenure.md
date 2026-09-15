---
status: accepted
---

# On the spot path, Carbon Tier prices entry — not tenure, and not the exit

The repositioning's headline claim is that carbon intensity decides the cost of *holding* an asset: the higher the emissions, the more expensive it is to keep. That sentence was written while the platform's front door was the perpetual exchange, where it is straightforwardly true — a position accrues a borrow fee per hour, and `CarbonTiers` sets that rate per tier.

The front door is now the vault's mint and redeem. `CarbonTiers` returns `(tradingFeeBps, borrowFeeBpsPerHour, maxLeverage)`, and a spot holding can only use the first of the three. `borrowFeeBpsPerHour` has no counterpart — nobody is lending anything. `maxLeverage` is identically 1. So wiring the vault to `CarbonTiers` buys a difference in what it costs to *get in*, not in what it costs to *stay*, and the claim as written stops being true on the surface that matters most.

The decision is to narrow the claim rather than to build a mechanism that would rescue it. On the spot path the Tier fixes the mint fee and nothing else. Copy, `CONTEXT.md` and the asset screens say "buying in costs more", never "holding costs more". The tenure claim stays alive, accurately, on the perpetual path.

The exit is deliberately excluded as well: the redeem fee stays flat across every tier. Charging more to redeem a high-carbon asset penalises the act of getting out of one, which points the incentive backwards — and it is the same principle the vault already applies when it refuses to let the Reserve Ratio gate redemption. The way out stays clear.

## Considered options

**Charge a carbon-tiered fee at redeem, scaled by how long the tokens were held.** This would make tenure genuinely expensive and preserve the original sentence. Rejected because the holding period is not knowable. These are ordinary transferable ERC-20s — that they show up in MetaMask and can be sent to someone else is the tokenised layer's stated selling point — so any per-holder clock is reset by a transfer, including a transfer to oneself. A fee that anyone can zero out with one free action is not a fee; it is a tax on users who did not think of it.

**Demurrage: decay every holder's balance daily at a rate set by the asset's Carbon Tier.** This is the only design that makes holding actually cost more without needing to track tenure, and it is a real, precedented mechanism. Rejected on cost and on collateral damage: it would have to live inside the token's own transfer paths, it changes the liability side of every reserve-ratio computation, it invalidates a large amount of existing contract test coverage, and it converts the layer's own pitch — your balance is in your wallet — into a balance that shrinks on its own every day. That is a lot of new surface, on the token contract itself, to save one sentence of copy.

**Leave the vault on its flat fee and let the Carbon Tier remain purely informational on this path.** Rejected because a tier badge that costs nothing is exactly the decorative ESG label this project exists to argue against.

## Consequences

- The difference the mechanism actually produces on the spot path is a 10× spread in the entry fee between the lowest and the highest tier. That is demonstrable live, in one transaction each, which is worth more than a stronger sentence nobody can check.
- The lowest tier's fee is *below* the flat fee the vault charged before this change, and the highest tier's is above it. Low-carbon assets getting cheaper is intended: the claim is that carbon sorts cost, not that everything costs more.
- Any screen that says or implies high-carbon assets are more expensive to *hold* is wrong on the spot path and must be corrected, not reinterpreted.
- The two claims now differ by path. If the perpetual surface is ever brought back out from behind its flag, the tenure claim comes back with it and both are true at once, each on its own path — but they must stay separately worded, because a reader on one path cannot see the other.
- `CarbonTiers` keeps returning all three params. The vault reads one of them. That is not dead code to be cleaned up: the library is deliberately the single definition for every consumer, and a consumer using a subset is the expected shape.
