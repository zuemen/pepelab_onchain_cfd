## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (zuemen/pepelab_onchain_cfd), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout — CONTEXT-MAP.md at root, per-context CONTEXT.md under agent/, contracts/, frontend/, web/. See `docs/agents/domain.md`.

### Environment setup

Sandboxed shells only write for real **inside the project directory** — global installs (`winget`, `npm i -g`, `foundryup`) silently fail while still reporting success, so hand those to the user instead of running and verifying them. Bootstrap order, per-directory package manager (frontend = yarn only, agent = npm only), and Windows/Git Bash gotchas: `docs/agents/environment.md`.
