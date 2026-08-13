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
