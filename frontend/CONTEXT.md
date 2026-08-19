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

`PnL` follows the ADR-0002 abbreviation rule: spelled out on first appearance on a screen, bare afterward. Everything else in this table is a full word, not an abbreviation, so it doesn't get the parenthetical treatment.

British spelling (`Unrealised`, `realise`) is the convention, matching the files that reached zero Han characters first. `exchange.ts` and `terminal.ts` still carry a few pre-existing American spellings (`Unrealized`, `realize`) left from before this glossary existed; normalise them to British spelling as those files are translated, rather than treating the American spelling as a second accepted form.

### Portfolio

**Net Worth**:
Everything a user's account is worth in one figure: wallet balance, free margin, locked margin, unrealised PnL, staked amount, and LP vault value.
_Avoid_: total assets, balance, total value

**Unread Balance**:
A balance the app tried and failed to read on-chain. Distinct from a balance that was read successfully and is zero — an unread balance makes Net Worth incomplete and is reported as such.
_Avoid_: missing balance, empty balance

### Wallet

**Mock Wallet**:
A demo connection used for presentations. It carries an address and counts as connected, but has no chain access at all, so no balance or position can ever be read while it is in use.
_Avoid_: test wallet, fake wallet, guest mode
