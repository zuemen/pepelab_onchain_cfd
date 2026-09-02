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
(On a machine where Smart App Control blocks Foundry, `forge` goes through WSL —
see below.)

## Bootstrap order

**User runs (outside the repo):**

```bash
winget install --id OpenJS.NodeJS.LTS --source winget   # Node >=20 (engines field)
npm i -g yarn@1.22.22                                   # after reopening the shell
winget install --id GitHub.cli --source winget          # CLAUDE.md routes issues through gh
curl -L https://foundry.paradigm.xyz | bash && foundryup   # contracts/ only — on Windows read the SAC note first
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

## Foundry on Windows: Smart App Control may block it

**Windows only, and only some Windows machines** — check before assuming:

```bash
powershell -c "(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState"
```

- `0`, or the key missing → SAC is off. The native `foundryup` in the bootstrap
  block above works; **skip the rest of this section.**
- `1` (enforced) or `2` (evaluation) → the Foundry binaries are unsigned, SAC kills
  them, and you need the WSL route below.

macOS and Linux are unaffected. SAC defaults on for clean Windows 11 installs and
off on machines upgraded into it, so this differs per contributor — never assume
from someone else's notes which side a machine is on.

### What it looks like when it hits

Observed 2026-09-02, one contributor's Win11 Pro box with SAC = `1`: `foundryup`
printed `forge verified ✓`, `cast verified ✓`, `anvil verified ✓`, then died with

```
Error: failed to run anvil in version v1.8.1
       應用程式控制原則已封鎖此檔案。 (os error 4551)
```

`verified ✓` is an attestation **hash** check, not an execution test — the first
real `anvil --version` is what SAC kills. The aborted install leaves
`~/.foundry/bin` holding `foundryup.exe` and nothing else, so `forge` is simply
absent from PATH. Re-running `foundryup` cannot help.

SAC has **no per-app allowlist**, and turning it off is one-way — re-enabling it
requires reinstalling Windows. Don't propose that to the user.

### The WSL route (only if SAC is on)

Linux binaries are outside SAC's reach. Substitute your own distro for `Ubuntu`
in every command below; `wsl -l -v` lists them.

**User runs** (writes to `~/.foundry` inside WSL — outside the repo, so it is
theirs per the sandbox boundary above):

```bash
wsl -d Ubuntu -- bash -lc 'curl -L https://foundry.paradigm.xyz | bash && foundryup'
```

**Then the PATH gotcha.** foundryup appends its `export PATH=...` to `~/.bashrc`,
below Ubuntu's `case $- in *i*) ;; *) return;; esac` guard — so a non-interactive
`bash -lc` (which is how every agent call enters WSL) never sees it. Append to
`~/.profile` instead, which login shells read regardless:

```bash
wsl -d Ubuntu -- bash -lc 'echo "export PATH=\$HOME/.foundry/bin:\$PATH" >> ~/.profile'
```

Until that is done, call the binaries by absolute path: `~/.foundry/bin/forge`.

**Agent runs.** `wsl.exe` inherits the Windows cwd, so from the repo root:

```bash
wsl.exe -d Ubuntu -- bash -lc 'cd contracts && forge build'
```

Verified 2026-09-02 with forge 1.7.1: cold `forge build` over `/mnt/c` takes
~1m45s, warm prints `No files changed`.

- `/mnt/c` I/O is slow — `forge test` is noticeably slower than a native Linux run.
- Use the `Bash` tool, not `PowerShell`, to drive `wsl.exe`: PowerShell mangles
  `|` and `;` inside the quoted command string before wsl ever sees them. (True on
  any Windows machine, SAC or not.)
- `out/` and `cache/` are gitignored and shared with anything on the Windows side;
  don't build from both at once.

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
