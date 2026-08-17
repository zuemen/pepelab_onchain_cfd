# Environment setup

How to bootstrap this repo on a fresh machine, and which half of that an agent
can actually do.

## The sandbox boundary

The boundary is **which tool**, not which path:

| Tool | Write target | Lands on the user's disk? |
|---|---|---|
| Write / Edit | anywhere | ✅ yes — including `~/.bashrc`, `~/.gitconfig` |
| Bash / PowerShell | `pepelab_onchain_cfd/` and below | ✅ yes |
| Bash / PowerShell | anywhere else | ❌ no — goes to an isolated layer |

So editing a dotfile in the user's home directory is fine. Running an installer
that writes there is not.

The failure is **silent**. An out-of-repo install exits `0`, and reading the path
back afterwards shows the files — the isolated layer replays the agent's own
writes to the agent. `dangerouslyDisableSandbox: true` does **not** pierce it.
So the agent's own verification is worthless out here, and confidently reporting
"installed and verified" is exactly the wrong move.

Observed 2026-08-17: `npm i -g yarn@1.22.22` reported success, `yarn -v` printed
`1.22.22` from a login shell reproduced by the agent, and the user's own terminal
had no `%APPDATA%\npm` directory at all. Three rounds of PATH debugging, a
`.bashrc` edit, and a reboot were spent on a directory that never existed.

### Belongs to the user — never report these as done

Any **command** that installs outside the repo:

- `winget` / `choco` / `scoop` installs → `Program Files`
- `npm i -g`, `corepack enable` → `%APPDATA%\npm`, `Program Files\nodejs`
- `foundryup` → `~/.foundry`
- anything setting env vars or touching the registry

Hand the user the command, then read the output **they** paste back. That is the
only evidence that counts.

Dotfiles (`~/.bashrc`, `~/.gitconfig`, `~/.ssh/config`) are the exception — reach
for Write/Edit there, not a shell heredoc, and the change is real.

### The agent can do these

Everything under the repo: `git submodule update --init --recursive`,
`yarn install` in `frontend/`, `npm ci` in `agent/`, `forge build`, test runs,
dev server. These are real and worth doing — they are also the slow parts.

## Bootstrap order

**User runs (outside the repo):**

```bash
winget install --id OpenJS.NodeJS.LTS --source winget   # Node >=20 (engines field)
npm i -g yarn@1.22.22                                   # after reopening the shell
winget install --id GitHub.cli --source winget          # CLAUDE.md routes issues through gh
curl -L https://foundry.paradigm.xyz | bash && foundryup # only if touching contracts/
```

The first `git push` also needs the user: `credential.helper` is `manager`, and on
a fresh machine it opens an interactive GitHub sign-in that an agent cannot
complete. Reads work without it — the repo is public — so a green `git ls-remote`
proves nothing about push.

**Agent runs (inside the repo):**

```bash
git submodule update --init --recursive
cd frontend && yarn install --frozen-lockfile
cd ../agent && npm ci && npm test
```

## Per-directory package manager

- **`frontend/` — yarn only.** `package.json` pins `"packageManager": "yarn@1.22.22"`
  and carries `resolutions` (security pins from the 2026-08-06 audit). npm ignores
  `resolutions` and there is no `package-lock.json` to validate.
- **`agent/` — npm only.** npm workspaces (`shared`, `signal-api`, `mcp-server`,
  `demo-agent`) with a committed `package-lock.json`.
- **`contracts/`** — Foundry. `lib/forge-std` is vendored as plain files despite
  appearing in `.gitmodules`; only the two OpenZeppelin libs are real submodules
  and they are empty until `git submodule update --init`.

## Windows / Git Bash gotchas

- `winget install` hangs on a spinner while waiting for a UAC prompt that may not
  come to the foreground. It is not stuck.
- `corepack enable` fails with `EPERM` on `C:\Program Files\nodejs\yarnpkg` without
  an elevated shell. Use `npm i -g yarn@1.22.22` instead — same yarn, and npm's
  global prefix (`%APPDATA%\npm`) is user-writable.
- The Node MSI puts `%APPDATA%\npm` on the **user** PATH and `Program Files\nodejs`
  on the **system** PATH. Shells opened before the install see neither; reopen.
- Windows may restore terminal windows after a reboot with their pre-reboot
  environment. If PATH looks stale right after a reboot, open a genuinely new window.
- npm 11+ blocks install scripts by default. In `agent/` this leaves `keccak`,
  `esbuild`, `bufferutil`, `utf-8-validate` unbuilt; `npm test` passes anyway, so
  don't chase it.

## Verifying a fresh clone

```bash
cd ~/projects/pepelab_onchain_cfd
ls -d frontend/node_modules agent/node_modules contracts/lib/openzeppelin-contracts/contracts
cd agent && npm test        # offline, no keys, sends no transactions
cd ../frontend && yarn dev  # no .env needed; addresses are in src/contracts/addresses.ts
```

`.env` is only needed for `agent/` servers (signal-api, demo-agent, tg-bot) and for
`contracts/` deployment. `frontend/.env.example` is minimal-kit template residue —
the `VITE_FIREBASE_*` / `VITE_SUPABASE_*` keys are unused.
