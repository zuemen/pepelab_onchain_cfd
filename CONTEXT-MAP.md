# Context Map

This repo holds four contexts that sit side by side, with no shared root package.

## Contexts

- [Frontend](./frontend/CONTEXT.md) — the user-facing PepeFi web app: dashboard, trading surfaces, portfolio
- **Agent** (`agent/`) — the off-chain agent, keeper, and MCP server. _No glossary yet._
- **Contracts** (`contracts/`) — the Solidity contracts and their Foundry test suite. _No glossary yet._
- **Web** (`web/`) — the static marketing shell. _No glossary yet._

Glossaries are written lazily, as terms get resolved. A context listed without one simply hasn't needed it yet.

## Relationships

- **Frontend → Contracts**: the frontend reads and writes contract state directly via ethers; contract ABIs and addresses are the shared surface.
- **Agent → Contracts**: the agent and keeper transact against the same contracts.
