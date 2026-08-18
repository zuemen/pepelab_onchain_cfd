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

A file with any entry here is **not** on the ratchet allowlist in
`src/locales/locales.test.ts`, so the guard does not certify it as finished.

Line numbers are as of commit `d0378ed`.

---

**All entries resolved (#36).** Every file listed above is back on the
ratchet allowlist in `src/locales/locales.test.ts`:
`src/pages/pepefi/ExchangePage.tsx` (#32),
`src/components/pepefi/whale/WhaleFeed.tsx` (#33/#34),
`src/pages/pepefi/VaultPage.tsx`, `src/pages/pepefi/SessionsPage.tsx`,
`src/pages/pepefi/TokenizedAssetsPage.tsx`, `src/pages/pepefi/LandingPage.tsx`,
`src/layouts/pepefi/index.tsx`, `src/pages/pepefi/PepeLabPage.tsx`,
`src/pages/pepefi/TraderStakePage.tsx`, `src/pages/pepefi/CopyPage.tsx` and
`src/pages/pepefi/TraderDashboard.tsx` (#34).

The one exception: `src/pages/pepefi/X402DocsPage.tsx` (#34)'s deferred
sentence is resolved too, but the file itself still isn't on the allowlist —
it also holds a copy-paste-able curl/npx example with two Chinese comments
inside the template literal (lines ~248–250). That's deliberately-untranslated
verbatim code, not a display string — same category as the asset-path
exception — and out of scope for #36. Left as-is.

This closes out the #36 inventory: every sentence recorded here has been
resolved as either one catalog value with markup moved to wrap it, or split
into fragments verified against rendered output, per the issue's acceptance
criteria. `#37` (extending the ratchet to the whole tree) is next.

---

## Resolved along the way: hardcoded-locale timestamp formatters

Not part of this inventory (these are formatting bugs, not deferred markup),
but noted here since they turned up during the same batches: five
`toLocaleString('zh-TW', …)` calls that ignored the built locale entirely,
found and fixed in `AdminOraclePage.tsx`, `AgentMonitorPage.tsx` (#35),
`SessionsPage.tsx`, `TraderProfilePage.tsx` and `TraderDashboard.tsx` (#34).
All five now read the active `locale` export instead.

## Related: markup inside string values

`src/_mock/_others.ts` holds five notification fixtures whose **values** are
HTML strings (`'<p>👑 穿戴變更成功！您已換上最新的 <strong>…</strong>…</p>'`).
These are a different problem from the rows above: #26 rules that no markup
string may live in the catalog at all, so they cannot simply be moved. They
need the markup lifted into the component first, which is the same decision
#36 is making everywhere else.
