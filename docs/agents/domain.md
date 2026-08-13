# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — system-wide decisions. Also check `<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is multi-context — four distinct domains sit side by side with no shared root package:

```
/
├── CONTEXT-MAP.md                 ← points at the four contexts below
├── docs/adr/                      ← system-wide decisions
├── agent/
│   ├── CONTEXT.md
│   └── docs/adr/                  ← agent/keeper/MCP-server-specific decisions
├── contracts/
│   ├── CONTEXT.md
│   └── docs/adr/                  ← Solidity/Foundry-specific decisions
├── frontend/
│   ├── CONTEXT.md
│   └── docs/adr/                  ← dashboard/frontend-specific decisions
└── web/
    ├── CONTEXT.md
    └── docs/adr/                  ← marketing/static-site-specific decisions
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
