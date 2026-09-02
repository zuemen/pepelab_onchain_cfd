# Frontend

The user-facing PepeFi web app — the dashboard, trading surfaces, and portfolio views that people interact with on-chain through their wallet.

## Language

### Presentation modes

**Mode**:
The audience a screen is being rendered for: `simple` or `expert`. A single app-wide preference, chosen by the user, that decides how much detail every screen exposes.
_Avoid_: view, level, tier, difficulty

**Simple Mode**:
The casual holder's view — answers "what do I own, and how is it doing". Trading-desk instrumentation and advanced tooling are hidden.
_Avoid_: basic mode, beginner mode, easy mode

**Expert Mode**:
The full trading-desk view — every metric, column, and tool the app offers, with nothing withheld.
_Avoid_: advanced mode, pro mode

**Theme Mode**:
The light/dark appearance setting, owned by the MUI settings system. Unrelated to Mode despite sharing the word, and the two are never mixed.
_Avoid_: calling this simply "mode"

### Locale and display text

**Display String**:
A piece of text the user can read on screen, whichever module it happens to live in. Comments, identifiers and console output are not display strings, however user-facing the code around them is.
_Avoid_: label, copy, text, message, i18n string

**String Catalog**:
The one place display strings live — plain data, grouped by feature, with one structurally identical copy per Locale. Holds no markup and no logic.
_Avoid_: translation file, locale file, lang file, dictionary, i18n resources

**Locale**:
The single language a build ships in — `zh-TW` or `en`. Chosen when the app is built, so one build is one language and the user cannot change it from inside the app.
_Avoid_: language mode, i18n mode, lang, or any name containing "mode" (Mode is the Simple/Expert preference, Theme Mode is light/dark)

Display text is Traditional Chinese, with four categories deliberately left in their original form; the rule and its reasoning are in [ADR 0002](./docs/adr/0002-display-text-language-rule.md).

### Trading vocabulary, Chinese to English

The `en` catalog translates the trading domain's recurring terms, not just individual sentences. Translated independently across a dozen catalog files, the same Chinese term drifts into several different English words for the same concept — this list pins one rendering per term so it doesn't. Seeded from the terms already settled in the catalog files that reached zero Han characters first (`whale`, `history`, `vault`, `traderProfile`, `traderDashboard`) and from identifiers already in code (`freeMargin`, `lockedMargin`, `unrealizedPnl`).

| Chinese | English |
|---|---|
| 保證金 | Margin |
| 可用保證金 | Free Margin |
| 鎖定保證金 / 已用保證金 | Locked Margin |
| 開倉 | Open (a position) |
| 平倉 | Close (a position) |
| 未平倉部位 | Open Position(s) |
| 強制平倉 / 清算 | Liquidation, liquidated |
| 資金費率 | Funding rate |
| 質押 | Stake, staked |
| 罰沒 | Slash, slashed |
| 未實現損益 | Unrealised PnL |
| 預言機報價 | Oracle price |
| 滑價 | Slippage |
| 名目曝險 | Notional Exposure |
| 資產類別 | Asset Class |
| 對照指數 | Benchmark |

`PnL` follows the ADR-0002 abbreviation rule: spelled out on first appearance on a screen, bare afterward. Everything else in this table is a full word, not an abbreviation, so it doesn't get the parenthetical treatment.

British spelling (`Unrealised`, `realise`) is the convention, matching the files that reached zero Han characters first. `exchange.ts` and `terminal.ts` still carry a few pre-existing American spellings (`Unrealized`, `realize`) left from before this glossary existed; normalise them to British spelling as those files are translated, rather than treating the American spelling as a second accepted form.

That table is now **contract-layer vocabulary**. It pins one English rendering per Chinese term wherever the mechanism is discussed — Solidity, tests, engineering conversation, and Expert Mode screens, which deliberately keep the trading desk's language. It no longer governs Simple Mode, where the mechanism is never named ([ADR 0006](./docs/adr/0006-sustainability-owns-the-word-yongxu.md)). A term appearing in both places is rendered by whichever table applies to the screen at hand, and the two never appear together.

| Mechanism (contract layer) | Simple Mode says |
|---|---|
| 開倉 / 平倉 · Open / Close a position | 買進 / 贖回 |
| 未實現損益 · Unrealised PnL | 持有期報酬 |
| 保證金 · Margin | 投入金額 |
| 槓桿 · Leverage | *(absent)* |
| 強制平倉 · Liquidation | *(absent)* |
| 資金費率 · Funding rate | *(absent)* |

An entry marked *(absent)* has no Simple Mode rendering on purpose. A screen that finds it needs one is a signal that the mechanism has leaked into the display layer, and the fix is to remove the leak rather than to invent a word.

### Portfolio

**Net Worth**:
Everything a user's account is worth in one figure: wallet balance, free margin, locked margin, unrealised PnL, staked amount, and LP vault value.
_Avoid_: total assets, balance, total value

**Unread Balance**:
A balance the app tried and failed to read on-chain. Distinct from a balance that was read successfully and is zero — an unread balance makes Net Worth incomplete and is reported as such.
_Avoid_: missing balance, empty balance

**Reserve Ratio**:
What the vault holds against what it owes, as one figure anyone can compute from chain state. Both halves are on chain — the holding is the vault's own stablecoin balance, the owing is every outstanding position priced by the oracle — so it is verified rather than attested. Falling below the floor stops new minting; it never stops redemption, because blocking exits under stress is the bank run rather than a defence against it.
_Avoid_: backing, collateralisation, proof of reserves (that name implies an off-chain asset and an attestor, and there is neither)

**Unknown Ratio**:
A Reserve Ratio computed while some position could not be priced. The figure that comes back is optimistic, not wrong-but-close, so a screen reports it as "cannot confirm" and never as a number. The same distinction the KYC gate draws between `unknown` and `unverified`.
_Avoid_: stale ratio, approximate ratio, treating an unknown ratio as a healthy one

### Sustainability

**Sustainability (永續)**:
The platform's core pitch and the only thing the Chinese word 永續 is allowed to mean on screen: investing with regard for a holding's environmental, social and governance conduct. Every user-facing use of 永續 carries this sense and no other.
_Avoid_: ESG as a synonym (ESG names the measured dimensions; Sustainability names the stance), green, responsible, impact

**Perpetual**:
The contract-layer mechanism that settles positions without an expiry date — funding rate, mark price, liquidation. A pure implementation detail: it never appears in display text, and it is never rendered into Chinese, because 永續合約 on a screen would collide head-on with Sustainability. A user learns what they own and what it costs; they never learn that a perpetual is what carries it.
_Avoid_: 永續合約 or any Chinese rendering in display text, perp, swap

Both senses of 永續 exist in this repo the way both senses of RWA do, and for the same reason — the display language and the contract language answer to different audiences. The difference is that the two RWA senses can safely sit on one screen, while the two 永續 senses cannot, so the perpetual sense is barred from the display layer entirely rather than merely kept distinct from it.

### Carbon and attestation

**Carbon Intensity**:
How much greenhouse gas a holding is responsible for per unit of economic activity, sourced from the issuer's own published reporting. The one sustainability measure this platform prices on, chosen because it carries a unit and an auditable source — which an aggregate ESG score does not. Distinct from the E/S/G scores, which are kept for display and never reach pricing.
_Avoid_: ESG score, carbon footprint (that names a total, not an intensity), emissions

**Carbon Tier**:
The band a Carbon Intensity falls into, and the only thing pricing actually reads: it fixes an asset's holding cost and its leverage ceiling. Derived by one pure function shared by contracts, screens and analysis, from thresholds that are constants rather than settable parameters — a threshold an operator could adjust is a discretionary policy, and non-discretion is the whole point.
_Avoid_: carbon rating, grade, band, risk level

**Unrated Asset**:
An asset with no usable Carbon Intensity — never attested, or every attestation expired. Priced at the most conservative Tier, which is neither a refusal to trade nor a concession: absence of data is not absence of exposure.
_Avoid_: neutral, default, exempt

**Attestation**:
One party's recorded claim about an asset's Carbon Intensity, carrying who said it, when they observed it, and a hash of the source they read. Expires; a lapsed attestation stops counting rather than lingering as an old number.
_Avoid_: rating, score, reading, oracle update

**Attestor**:
Whoever may record an Attestation. Deliberately a different role from the KYC Reviewer and from the contract's `verifiers` mapping — an Attestor speaks about an asset, a Reviewer decides about a person, and neither implies the other.
_Avoid_: verifier, reviewer, rater, auditor

**Dispersion**:
How far the Attestations for one asset sit from each other. A first-class figure shown on screen rather than an error to be averaged away, because rating agencies disagreeing about the same company is the condition this platform exists to make visible.
_Avoid_: variance, error, spread, confidence

### Allocation and sharing

**Allocation**:
A weighted mix of assets that sums to the whole — the thing a user adopts and holds. Versioned, published openly, and constrained so that a mix concentrated in one asset cannot be published under the name.
_Avoid_: strategy, portfolio (that is what a user ends up with, not what a publisher writes), basket, signal

**Allocation Publisher**:
Someone who publishes an Allocation and earns a share of the profit their adopters make. Puts up a stake first, so the reputation has a cost. Never called a trader — the word names the activity this platform moved away from.
_Avoid_: trader, strategist, manager, influencer

**Adopt**:
To put your own money to work following an Allocation. Your positions, your wallet, your risk — nothing is pooled, and the publisher never holds your funds.
_Avoid_: copy, follow, mirror, subscribe (all four describe the trading-desk product this replaced)

**Diversification**:
How spread out a holding is across its assets. Measured and shown for a user's own holdings, never enforced on them; enforced only on a published Allocation, where the word is a claim being made to other people.
_Avoid_: spread, concentration (that names the opposite), balance

### Achievements

**Achievement**:
A permanent, non-transferable mark that a user sustained some behaviour the platform wants to encourage — holding for a long time, keeping a spread of assets, keeping a low-carbon mix. Non-transferability is the whole design: anything transferable acquires a price, and anything with a price gets farmed.
_Avoid_: reward, prize, points, badge NFT

**Streak**:
Consecutive days a user has stayed engaged. Counted, but never the thing that decides a level — a level bought by holding tokens is not a level earned.
_Avoid_: login bonus, daily reward

### Asset classes and RWA

**RWA**:
Two meanings that deliberately coexist — which one applies depends on whether you're reading a screen or a contract. On screen, it's the umbrella term for everything tradable on the platform, spanning all four Asset Classes including crypto, and it's the platform's core pitch. In the contracts, `PerpetualExchange.rwaAsset` and `KYCRegistry` use it narrowly: only the KYC-gated regulated markets (equity, bond, ETF), explicitly excluding crypto and gold. Neither sense implies the other — a screen calling something "RWA" says nothing about whether the contract's KYC gate applies to it. See [ADR 0003](./docs/adr/0003-rwa-dual-meaning.md) for why the two were kept apart rather than merged.
_Avoid_: assuming the display sense and the contract `rwaAsset` sense are the same set of assets

**Asset Class**:
One of the four categories a screen groups holdings into: Equity (股, including ETF), Bond (債), Commodity (金), Crypto (幣). Distinct from `AssetCategory` in `assetMeta.ts`, which keeps `etf` as its own fifth value — an Asset Class display always folds ETF into Equity.
_Avoid_: category, bucket, sector

**Benchmark**:
A reference price series shown purely for comparison — S&P 500, gold, Bitcoin. Never settles a position and is never itself a tradable market.
_Avoid_: index (collides with a perpetual's index price)

**Anchor Date**:
The start of a "you vs Benchmark" comparison window: the `openedAt` of a user's oldest open position. No open position means no Anchor Date, and the comparison does not render.
_Avoid_: start date, since, inception

### KYC

**KYC Verification**:
An address's standing with the compliance registry: cleared, or not. Granted by a reviewer, never by the applicant. Checked at one single moment — when a position is opened on a regulated market. Never on close, and never retroactively, so withdrawing verification shuts the door on new positions without touching positions already open or rewards already claimed.
_Avoid_: KYC'd, whitelisted, approved (approval is the reviewer's action; verification is the standing it produces)

**KYC Status**:
What the app currently knows about an address's KYC Verification — which is not the same thing as the verification itself. Five values, deliberately kept apart because each one calls for different words on screen and a different next step: `verified` (cleared; regulated markets are open), `pending` (submitted and waiting — re-sending the form achieves nothing but burnt gas), `unverified` (the chain says plainly that nothing was ever submitted), `not-required` (no registry on this chain, so there is no gate here at all), `unknown` (the read failed). `unknown` is not a soft `verified`: the gate is fail-closed, so the screen says "cannot confirm", never "you have not done KYC".
_Avoid_: collapsing `unknown` into `unverified`, treating `not-required` as a kind of `verified`

**Submission**:
The applicant's own act — recording their data and joining the review queue. Grants nothing on its own.
_Avoid_: doing KYC, registering, signing up (all three read as though something already completed)

**Reviewer**:
Whoever the registry lets approve or revoke: the owner, plus every address the owner has appointed. Deliberately wider than the contract's `verifiers` mapping, which holds only the appointed ones and never the owner — a screen asking "may this person review?" has to check both, the way `onlyVerifier` does.
_Avoid_: admin, compliance officer, verifier (that word names the mapping, not the role)

**Screening**:
An automated pre-check run over a Submission — blocked jurisdiction, name against a watchlist — that produces a *recommendation* for a Reviewer and never a decision. Nothing it concludes reaches the chain on its own; a Reviewer still presses approve. The watchlist it checks against is fictional.
_Avoid_: verification, auto-approval, AML check

**Review Queue**:
The Reviewer's view of every Submission the registry has ever seen, in three parts — awaiting review, verified, revoked — rebuilt from the registry's events rather than read from a list the contract keeps, because it keeps none.
_Avoid_: pending list (that is one of its three parts), applications table

### Wallet

**Mock Wallet**:
A demo connection used for presentations. It carries an address and counts as connected, but has no chain access at all, so no balance or position can ever be read while it is in use.
_Avoid_: test wallet, fake wallet, guest mode
