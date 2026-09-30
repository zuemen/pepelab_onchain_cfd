# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it lists the four contexts. Only `frontend/CONTEXT.md` exists today; the other three contexts have no glossary yet.
- **`docs/ADR-00N-*.md`** — system-wide decisions (ADR-001 … ADR-007), stored flat in `docs/`, not in a `docs/adr/` folder.
- **`frontend/docs/adr/NNNN-*.md`** — frontend-scoped decisions (0001 … 0008).

If a context has no `CONTEXT.md` or ADR folder yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is multi-context — four distinct domains sit side by side with no shared root package. What actually exists (checked 2026-09-30):

```
/
├── CONTEXT-MAP.md                 ← lists the four contexts below
├── docs/
│   └── ADR-001-… ADR-007-*.md     ← system-wide decisions (flat, three-digit numbers)
├── agent/                         ← no CONTEXT.md, no ADR folder yet
├── contracts/                     ← no CONTEXT.md, no ADR folder yet
├── frontend/
│   ├── CONTEXT.md
│   └── docs/adr/0001-… 0008-*.md  ← frontend-specific decisions (four-digit numbers)
└── web/                           ← no CONTEXT.md, no ADR folder yet
```

**Two ADR numbering schemes coexist.** `ADR-00N` (three digits) means `docs/ADR-00N-*.md`;
`ADR-000N` (four digits) means `frontend/docs/adr/000N-*.md`. They are independent sequences,
so e.g. "ADR-002" and "ADR-0002" are different decisions. Some topics appear in both
(`docs/ADR-005` ↔ `frontend/docs/adr/0007`, `docs/ADR-006` ↔ `frontend/docs/adr/0008`); when
citing an ADR, give the full path or the digit count that identifies which series it is.
The repo root `CLAUDE.md` still describes per-context `CONTEXT.md` files under every context;
this file is the accurate one.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
