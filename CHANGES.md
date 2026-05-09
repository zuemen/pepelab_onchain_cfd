# Patch Changes — Code Review Round 1

## CRITICAL #5 — MockUSDC: faucet cooldown (24 h / 1 000 mUSDC)

**Files:** `contracts/src/MockUSDC.sol`, `contracts/test/MockUSDC.t.sol`, `frontend/src/contracts/abi/MockUSDC.json`, `frontend/src/pages/ExchangePage.tsx`

- Added `faucet()` with `FAUCET_COOLDOWN = 1 days`; reverts with custom error `FaucetCooldown(uint256 nextAvailable)` when called within 24 h.
- Guard condition `last != 0 && block.timestamp < last + FAUCET_COOLDOWN` — first-ever call is always allowed (Foundry `block.timestamp` starts at 1).
- `mint(address, uint256)` remains public for deploy scripts and tests.
- Added 4 faucet tests: `test_faucetMintsCorrectAmount`, `test_faucetCooldown`, `test_faucetCanCallAfterCooldown`, `test_faucetIndependentPerAddress`.
- ExchangePage Faucet button now calls `contracts.usdc.faucet()` (no params).
- Faucet label updated: "One call per 24 h · 1 000 mUSDC per claim".

## CRITICAL #3 — `getAddresses` no longer silently falls back to Anvil

**Files:** `frontend/src/contracts/addresses.ts`, `frontend/src/hooks/useContracts.ts`

- `getAddresses(chainId)` returns `ChainAddresses | null`; returns `null` for unknown chains.
- `useContracts` returns `null` when `getAddresses` returns `null` — all pages already guard with `if (!contracts) return`.
- Removed `CONTRACT_ADDRESSES = ANVIL` and `CHAIN_ID = 31337` backward-compat exports.

## CRITICAL #4 — Layout network switcher handles 4902 (chain not added)

**Files:** `frontend/src/components/Layout.tsx`

- Both `switchToAnvil` and `switchToSepolia` catch `err.code === 4902` and fall through to `wallet_addEthereumChain` with full chain params.
- Changed `sessionStorage` → `localStorage` (disclaimer dismissal persists across tabs/sessions).

## CRITICAL #1 — MarketplacePage: `getLatestStrategy` wrapped in try/catch

**Files:** `frontend/src/pages/MarketplacePage.tsx`

- `getLatestStrategy` is fetched separately from `traders()` and `getFollowerCount()`.
- On revert, `allocs` defaults to `[]`; UI shows "No strategy yet" badge — marketplace no longer goes blank.
- Added toast/notify state and error display for outer fetch failures.

## CRITICAL #2 — CopyPage: trader name and strategy fetched independently

**Files:** `frontend/src/pages/CopyPage.tsx`

- Trader name fetch and strategy fetch are now two separate try/catch blocks.
- Strategy revert (no strategy published) sets `stratAllocs = []`; UI shows "No strategy published yet."
- Trader name is shown even when strategy fetch fails.

## HIGH #1 — AdminOraclePage: owner check before allowing updates

**Files:** `frontend/src/pages/AdminOraclePage.tsx`

- On mount, reads `contracts.oracle.owner()` and compares to `wallet.address` (case-insensitive).
- Shows red "Read-only mode" banner when wallet is not owner.
- All "Update Price" buttons are `disabled` when `!isOwner`.

## HIGH #2 — All catch blocks now log + show user-visible error toast

**Files:** `ExchangePage.tsx`, `TraderDashboard.tsx`, `MarketplacePage.tsx`, `CopyPage.tsx`, `PortfolioPage.tsx`, `AdminOraclePage.tsx`

- All silent `catch { /* ignore */ }` in fetch functions replaced with `console.error(…) + notify(…, false)`.
- Users see "Network error — check your wallet network" (or the actual error message) on any RPC failure.

## HIGH #3 — TraderDashboard: weight auto-fix + duplicate asset guard

**Files:** `frontend/src/pages/TraderDashboard.tsx`

- "Auto-fix to 100%" button appears when `totalBps ∈ (9000, 11000)` and weight ≠ 10000; redistributes remainder to the last row.
- Duplicate asset detection: rows with duplicate `asset` get a red border; publish is blocked with `hasDup` flag; warning message shown.
- `canPublish` now also requires `!hasDup`.

## HIGH #4 — TX hash captured + Etherscan link on Sepolia

**Files:** `ExchangePage.tsx`, `TraderDashboard.tsx`, `CopyPage.tsx`, `PortfolioPage.tsx`, `AdminOraclePage.tsx`

- Replaced `type Waitable` + `waitTx` helper with `type TxResp { wait, hash }` + `asTx` cast.
- Every transaction call captures the returned hash and passes it to `notify(msg, ok, hash)`.
- Toast `{ msg, ok, hash? }` — when `hash` is set and `wallet.chainId === 11155111`, renders an "View on Etherscan ↗" anchor.
- Toast timeout increased from 4 000 ms → 6 000 ms.

## HIGH #5 — Disclaimer deduplication

**Files:** `frontend/src/pages/LandingPage.tsx`, `frontend/src/components/Layout.tsx`

- Removed duplicate disclaimer block from `LandingPage.tsx`; Layout banner is the single source.
- Layout disclaimer uses `localStorage` (was `sessionStorage`) so dismissal persists across page reloads.

---

*All 78 Foundry tests pass. TypeScript: zero errors. Vite build: success.*
