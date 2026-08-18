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

Resolved (#36): `src/pages/pepefi/ExchangePage.tsx` (#32),
`src/components/pepefi/whale/WhaleFeed.tsx` (#33/#34),
`src/pages/pepefi/VaultPage.tsx`, `src/pages/pepefi/SessionsPage.tsx`,
`src/pages/pepefi/TokenizedAssetsPage.tsx`, `src/pages/pepefi/LandingPage.tsx`,
`src/layouts/pepefi/index.tsx` and `src/pages/pepefi/PepeLabPage.tsx` (#34) —
all back on the ratchet allowlist.

`src/pages/pepefi/X402DocsPage.tsx` (#34)'s deferred sentence is resolved too,
but the file itself still isn't on the allowlist: it also holds a
copy-paste-able curl/npx example with two Chinese comments inside the
template literal (lines ~248–250). That's deliberately-untranslated verbatim
code, not a display string — same category as the asset-path exception — and
out of scope for #36. Left as-is; noted here so it isn't mistaken for a
missed #36 entry.

## `src/pages/pepefi/TraderStakePage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| ~449 | `<b>` | PEPE farm disclaimer — `⚠ 此數字為前端依質押量與時間試算的<b>展示值</b>，鏈上沒有對應的獎勵池，目前無法領取。…` |
| ~498 | `<b>` | Footnote disclaimer — `…目前是<b>前端試算的展示值</b>：鏈上沒有對應的獎勵池，也沒有任何合約會把它發給你，因此收割按鈕停用。` |

## `src/pages/pepefi/CopyPage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 675 | `<b>` | KYC-pending alert — `⏳ 你的 KYC 申請<b>已送出，正在等待審核</b>。審核人員核准後才能跟單含股票 / 債券的策略，不需要重複送出。` |

## `src/pages/pepefi/TraderDashboard.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 624 | `<Link>` | `Stake ≥ 100 mUSDC on the <Link to="/stake">Stake page</Link> to unlock publishing.` |

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
