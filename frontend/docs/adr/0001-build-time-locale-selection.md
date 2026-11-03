---
status: accepted
---

# Build-time locale selection, not a runtime language switcher

> **Partly superseded by [ADR 0010](./0010-locale-by-url-path.md) (2026-10-30).** Each Locale is still its own build and the app still never swaps language in place, but one site now ships every Locale of its Tenant under different URL paths (`/`, `/en/`), and the top bar has a 中 / EN link that loads the same page from the other build. Read "no in-app switcher" below as "no in-place switch".

The interface was a ruleless mix of Traditional Chinese and English, with ~1,000 lines of display string hardcoded across ~100 files and no way to produce an English build. We centralised display strings into a String Catalog and made the Locale a **build-time** choice: one build ships one language, selected by a build variable, with no in-app switcher and no persisted language preference. Two languages therefore mean two deployments of the same commit, which is enough because the audience is Chinese-speaking and the English build exists to be readable by outside reviewers, not to be toggled by users.

## Considered options

**The UI kit's own i18n (runtime `react-i18next` with per-language JSON).** The kit documents this and ships the leftover seams for it — an unused language popover, an unused locale-components parameter on the theme factory, the RTL wrapper. Rejected because JSON keys are stringly-typed: a typo or a missing key renders the key itself on screen with no compile-time signal. Across a thousand strings and a hundred files, that trades the one guarantee we actually wanted — the compiler refusing to build an incomplete translation — for a feature (runtime switching) we don't need.

**A self-built runtime switcher over a typed catalog.** Rejected on cost, and the cost is not the provider. Display strings live at module scope in this codebase — the nav configuration, the contract-error map, the skins/mounts/achievements tables — and module scope is evaluated once at import, so a runtime switch would freeze those strings at page load. Every such table would have to become a function or a hook, and the error formatter's ~77 call sites would each need a translator threaded through them. That work is also incompatible with migrating the app in batches: until every consumer is converted, half the screen would switch language and half would not, whereas a half-finished build-time migration is merely half-migrated.

## Consequences

- Serving both languages meant a second deployment with one environment variable changed; there was no single URL that offered both. **Superseded by [ADR 0010](./0010-locale-by-url-path.md)** (2026-10-30): one site now builds every language of the tenant in one go and serves them by URL path (`/` and `/en/`). Each language is still its own build, so everything else in this ADR stands.
- Components read the catalog through a plain module import, deliberately the only access pattern, because a hook cannot be used where the module-scope data tables need it.
- If a switcher is ever wanted, the path is a mechanical codemod of those imports to a hook plus the module-scope table conversions described above — knowingly deferred, not avoided.
- The kit's language popover and flag icons stay dead code. Whoever revives them should read this ADR first.
