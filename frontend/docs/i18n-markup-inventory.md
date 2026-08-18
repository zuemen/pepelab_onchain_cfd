# Inventory: sentences that wrap inline markup

Input for **#36**. Every entry below was deliberately left in place by the
extraction batches (#32–#35), because the sentence wraps markup around a
fragment **mid-sentence** — a bold run, an inline `<code>`, a `<Link>`, or a
styled `<Box component="span">`.

They are held back for the reason #26 gives: splitting a sentence into
fragments is where word order, spacing and punctuation break in a way the
compiler cannot see, and a translator has to be able to reorder the parts.
Resolving them is one decision per sentence — either the whole sentence
becomes one catalog value with the markup moved to wrap it, or it is split
into fragments whose order and spacing are verified against rendered output.

Line numbers are as of commit `d0378ed`.

---

**All entries resolved (#36).** `src/pages/pepefi/ExchangePage.tsx` (#32),
`src/components/pepefi/whale/WhaleFeed.tsx` (#33/#34),
`src/pages/pepefi/VaultPage.tsx`, `src/pages/pepefi/SessionsPage.tsx`,
`src/pages/pepefi/TokenizedAssetsPage.tsx`, `src/pages/pepefi/LandingPage.tsx`,
`src/layouts/pepefi/index.tsx`, `src/pages/pepefi/PepeLabPage.tsx`,
`src/pages/pepefi/TraderStakePage.tsx`, `src/pages/pepefi/CopyPage.tsx` and
`src/pages/pepefi/TraderDashboard.tsx` (#34) — every one of these sentences
became either one catalog value with the markup moved to wrap it, or fragments
verified against rendered output.

`src/pages/pepefi/X402DocsPage.tsx` (#34)'s deferred sentence is resolved too.
The file still holds a copy-paste-able curl/npx example with two Chinese
comments inside the template literal (lines ~248–250) — deliberately
untranslated verbatim code, not a display string. Since #37 (below) replaced
the old per-file allowlist with a whole-tree scan, those two lines are now
recorded as an explicit, reasoned exception in `LINE_EXCEPTIONS` right next
to the test in `src/locales/locales.test.ts`, same as the asset-path rule.

**#37 (extend the ratchet to the whole source tree): done.** The guard test
now scans every non-catalog `.ts`/`.tsx` file under `src/` instead of an
allowlist of migrated paths — adding an inline display string anywhere now
fails the test by default.

---

## Resolved along the way: hardcoded-locale timestamp formatters

Not part of this inventory (these are formatting bugs, not deferred markup),
but noted here since they turned up during the same batches: five
`toLocaleString('zh-TW', …)` calls that ignored the built locale entirely,
found and fixed in `AdminOraclePage.tsx`, `AgentMonitorPage.tsx` (#35),
`SessionsPage.tsx`, `TraderProfilePage.tsx` and `TraderDashboard.tsx` (#34).
All five now read the active `locale` export instead.

## Resolved along the way: markup inside string values

`src/_mock/_others.ts` held nine notification fixtures whose **values** were
HTML strings (`'<p>👑 穿戴變更成功！您已換上最新的 <strong>…</strong>…</p>'`),
rendered via `dangerouslySetInnerHTML` in `notification-item.tsx`. A different
problem from the rows above — #26 rules that no markup string may live in the
catalog at all, so it couldn't simply be moved — found while scoping #37.
Fixed by changing the data shape to `NotifSegment[]` (`{ text, bold? }`) and
rendering real `<strong>` JSX from the component instead of raw HTML.
