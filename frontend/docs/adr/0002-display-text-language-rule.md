---
status: accepted
---

# Display text is Traditional Chinese, with four categories left untranslated

The mix of Chinese and English in the interface had no rule behind it — `Exchange` and `Pro Terminal` sat in the sidebar next to `🪙 代幣化資產`, and `Margin Account` and `Approve & Deposit` sat inside Chinese paragraphs. Display text is now Traditional Chinese throughout, **except** four categories that stay in their original form because translating them would take something away from the reader:

1. **Token symbols** — `PEPE`, `mUSDC`, `USDC`, `ETH`, `XAU`. These must match what the wallet and the block explorer show, or the user cannot tell they are looking at the same asset.
2. **Product and protocol names** — `PepeLab`, `PepeAMM`, `x402`, `MCP`, `Base Sepolia`, `Chainlink`, `Pyth`. Proper nouns; a translated one is unsearchable.
3. **Contract error identifiers and parameter names** — `StalePrice`, `maxOracleAge`, `InsufficientFreeMargin`. The user pastes these into a search or a support message. The sentence explaining the error is Chinese; the identifier inside it is not.
4. **Abbreviations** — `PnL`, `APR`, `APY`, `TVL`, `OI`, `LP`, `bps`. Written as Chinese followed by the abbreviation in parentheses on first appearance on a screen — 未實現損益（PnL） — and as the bare abbreviation afterwards, so the reader learns the term without losing the ability to recognise it elsewhere.

Everything else is translated, including the parts that a crypto interface often leaves in English: trading verbs (`Long`, `Short`), position table column headers (`Entry Price`, `Liq. Price`, `Funding`), and action buttons (`Approve`, `Deposit`, `Withdraw`, `Stake`). The point of the rule is that the exemptions are a closed list with a reason each, rather than a running judgement call that produces a new mixed-language convention every time someone adds a screen.

## Consequences

- The `en` catalog is where the English lives. It is not a second, looser version of the Chinese one.
- Once the rule is fully applied, "no Han characters outside comments in a migrated directory" becomes a complete invariant, because every display string is Chinese by then. That is what lets a cheap static scan guard the migration; it cannot detect a stray English display string, and it does not need to.
- An exemption that is not on the list above is a bug, not a style choice. Adding a fifth category means editing this ADR.
