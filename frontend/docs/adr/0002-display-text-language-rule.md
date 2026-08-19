---
status: accepted
---

# Display text is Traditional Chinese, with four categories left untranslated

The mix of Chinese and English in the interface had no rule behind it — `Exchange` and `Pro Terminal` sat in the sidebar next to `🪙 代幣化資產`, and `Margin Account` and `Approve & Deposit` sat inside Chinese paragraphs. Display text is now Traditional Chinese throughout, **except** four categories that stay in their original form because translating them would take something away from the reader:

1. **Token symbols** — `PEPE`, `USDC`, `USDT`, `ETH`, `XAU`. These must match what the wallet and the block explorer show, or the user cannot tell they are looking at the same asset.

   **One symbol deliberately does not match the chain.** The platform's margin collateral is `MockUSDC`, whose on-chain symbol is `mUSDC` (`contracts/src/MockUSDC.sol`), but every screen displays it as `USDC`. Two things drove this. The `m` was not read as "mock" — it was read as a typo or as some other product, so it bought no safety while making the same asset look like two. And it was never consistent anyway: the sibling mock `MockUSDT` ships as `ERC20("Mock Tether USD", "USDT")`, with no prefix, so `mUSDC` was the outlier rather than the convention. Both mocks now display as the asset they simulate. This knowingly gives up the wallet-matching guarantee above for exactly one token; the platform is testnet-only and carries a persistent 模擬交易 banner, which states "not real money" far better than one letter in a symbol did.

   The cost is a collision, and it is the part that matters. x402 settles in the **real, Circle-issued USDC**, whose on-chain symbol is also `USDC` — that one is real money. So the real one is never written bare: it is always **`Circle USDC`**, naming the issuer (a proper noun, so category 2 already covers the spelling). The mock is never written with a qualifier. That leaves a rule a reader can apply without knowing any of the above:

   > Bare `USDC` on a PepeLab screen is the testnet mock. `Circle USDC` is real money.

   Both halves are load-bearing. Writing the mock as `測試 USDC`, or the real one as bare `USDC`, breaks the invariant and puts the user one misreading away from believing faucet tokens can pay for x402 calls.
2. **Product and protocol names** — `PepeLab`, `PepeAMM`, `x402`, `MCP`, `Base Sepolia`, `Chainlink`, `Pyth`. Proper nouns; a translated one is unsearchable.
3. **Contract error identifiers and parameter names** — `StalePrice`, `maxOracleAge`, `InsufficientFreeMargin`. The user pastes these into a search or a support message. The sentence explaining the error is Chinese; the identifier inside it is not.
4. **Abbreviations** — `PnL`, `APR`, `APY`, `TVL`, `OI`, `LP`, `bps`. Written as Chinese followed by the abbreviation in parentheses on first appearance on a screen — 未實現損益（PnL） — and as the bare abbreviation afterwards, so the reader learns the term without losing the ability to recognise it elsewhere.

Everything else is translated, including the parts that a crypto interface often leaves in English: trading verbs (`Long`, `Short`), position table column headers (`Entry Price`, `Liq. Price`, `Funding`), and action buttons (`Approve`, `Deposit`, `Withdraw`, `Stake`). The point of the rule is that the exemptions are a closed list with a reason each, rather than a running judgement call that produces a new mixed-language convention every time someone adds a screen.

## Consequences

- The `en` catalog is where the English lives. It is not a second, looser version of the Chinese one.
- Once the rule is fully applied, "no Han characters outside comments in a migrated directory" becomes a complete invariant, because every display string is Chinese by then. That is what lets a cheap static scan guard the migration; it cannot detect a stray English display string, and it does not need to.
- An exemption that is not on the list above is a bug, not a style choice. Adding a fifth category means editing this ADR.
- The three token spellings live in `src/lib/pepefi/tokenLabel.ts`, not in the catalog and not in components: `STABLE_LABEL` (`USDC`, the mock collateral), `ALT_STABLE_LABEL` (`USDT`), `X402_STABLE_LABEL` (`Circle USDC`). `tokenLabel.test.ts` pins all three and asserts they stay pairwise distinct, so the `USDC` / `Circle USDC` split cannot silently collapse back into one word.
- Recurring trading terms (margin, liquidation, funding rate, staking and slashing, PnL, oracle price, slippage…) have one pinned English rendering each, in [CONTEXT.md](../../CONTEXT.md#trading-vocabulary-chinese-to-english). That list exists so the English catalog reads as one vocabulary rather than as however many words a dozen independently-translated files happen to reach for the same Chinese term.
