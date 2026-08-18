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
`src/components/pepefi/whale/WhaleFeed.tsx` (#33/#34) and
`src/pages/pepefi/VaultPage.tsx` (#34) — all back on the ratchet allowlist.

`src/pages/pepefi/X402DocsPage.tsx` (#34)'s deferred sentence is resolved too,
but the file itself still isn't on the allowlist: it also holds a
copy-paste-able curl/npx example with two Chinese comments inside the
template literal (lines ~248–250). That's deliberately-untranslated verbatim
code, not a display string — same category as the asset-path exception — and
out of scope for #36. Left as-is; noted here so it isn't mistaken for a
missed #36 entry.

## `src/pages/pepefi/SessionsPage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 353–356 | `<b>` ×2 | Page intro — `每個 agent 具 <b>did:pkh</b> 身分，授權可憑證化為 <b>W3C VC</b>…` |
| 366–368 | `<b>` ×3 | The three SSI-triangle roles (Issuer / Holder / Verifier) |
| 380–382 | `<b>` ×2 | Wrong-network alert |
| 393–395 | `<b>` ×3 | "session key is not your main wallet" note |
| 427 | `<b>` | Burner-key warning — `…請存到本機 agent 設定，<b>別放主錢包資產</b>。…` |
| 601–603 | `<b>`, `<code>` ×5 | The three export steps |
| 609–610 | `<b>` ×2, `<code>` ×2 | Address-vs-private-key note |
| 626 | `<code>` | Include-key checkbox label |
| 633 | `<code>` | Placeholder note |
| 651–652 | `<b>` ×2, `<code>` | Final private-key warning |

## `src/pages/pepefi/TokenizedAssetsPage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 357–358 | `<b>` ×2 | `兩套實作並存於鏈上…詳見 <b>docs/RISK_MODEL.md</b> 與 <b>docs/KNOWN_LIMITATIONS.md</b>。` |
| 395–397 | `<b>` ×3 | Page intro |
| 409–412 | `<b>`, `<code>` ×2 | Stale-oracle explanation |
| 566–567 | `<Box component="code">` | `提示：…需由管理者呼叫 <code>fundVault()</code> 補充。` |

## `src/pages/pepefi/LandingPage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 133–135 | `<b style>` | Hero paragraph — `…外加 <b>x402 付費訊號</b>——讓 AI agent…` |
| 277–279 | `<b>` ×2 | Paper Trading explanation |

## `src/layouts/pepefi/index.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 110–112 | `<b>` ×2 | Network-mismatch banner — `目前連線於 <b>{chain}</b>。正式部署鏈是 <b>Base Sepolia（…）</b> ——…` |

## `src/pages/pepefi/PepeLabPage.tsx` (#34)

| Line | Markup | Sentence |
|------|--------|----------|
| 649 | `<strong>` | Current-mount summary — `{desc} 目前您已達到了 <strong>Lv. {level} · 進化型態 …</strong> 的尊貴段位。` |
| 679 | `<strong>` ×2 | Next-mount unlock hint — `距離解鎖下一隻坐騎 <strong>{emoji} {name}</strong> 還差 <strong>{levels}</strong> 級！(需要達 Lv.{level})` |
| 844 | `<strong>` ×2 | Gachapon cost line — `花費 <strong>500 PEPE</strong> 從 <strong>{stage}</strong> 專屬的 {count} 款造型中隨機抽取。` |

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
