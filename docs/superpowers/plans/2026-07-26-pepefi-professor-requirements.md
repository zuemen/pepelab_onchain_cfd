# PepeFi Professor-Requirements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual-stablecoin support (USDC + USDT), an ERC-20 tokenized-asset layer (real tokens in the wallet), a multi-source oracle read-only comparison panel, a re-enabled Sepolia price keeper preferring Coinbase, and Paper-Trading badging — all without modifying or redeploying any existing contract.

**Architecture:** The platform is a synthetic-CFD engine: `PerpetualExchange.openPosition()` records positions; users hold no ERC-20 for the asset. We add a **parallel** ERC-20 wrapping layer (`AssetVault` + `SyntheticAsset`) so both modes coexist. A second mock stablecoin (`MockUSDT`) is added for hold/faucet/swap; margin still routes through `MockUSDC` (contract-enforced). The exchange oracle is `immutable` with no setter, so Chainlink/Pyth integration stays **display-only** (read-only comparison panel) — no rewiring.

**Tech Stack:** Foundry (Solidity ^0.8.20, OpenZeppelin ERC20/Ownable), React 19 + Vite 7 + TypeScript + MUI 7 (Minimal UI Kit), ethers v6, GitHub Actions (keeper), tsx (priceKeeper).

## Global Constraints

- **Repo:** `zuemen/pepelab_onchain_cfd`. Local path: `C:\Users\sanketsu\pepelab_onchain_cfd`.
- **Target branch: `main`.** The working copy is currently on `feat/funding-conservation`. **Task 0 must reconcile this** — the spec describes `main`'s state, and several premises are already stale on `main` (see Spec Reconciliation).
- **NEVER modify any existing `.sol` file** under `contracts/src/`. Adding new `.sol` files is allowed. If any task appears to require editing `PerpetualExchange.sol` (or any existing contract) to succeed, STOP and report — do not hard-edit.
- **NEVER redeploy any existing contract** — it would wipe live positions and seed data.
- **Do not commit** deploy `broadcast/` artifacts, `.env`, or this `docs/` plan. Allowed diff surface at push time (Task 15): `frontend/**`, the specific new `contracts/src|test|script` files listed below, `.github/workflows/price-keeper.yml`, `scripts/priceKeeper.ts`.
- Each Phase gate: `contracts` → `forge build` + `forge test` (0 error, all green); `frontend` → `yarn build` (0 error). Frontend has no unit-test harness — `yarn build` (tsc + vite) is the verification gate for every frontend task.
- MockUSDC/MockUSDT/synthetic tokens all use **18 decimals** (system-wide simplification; note in report that real USDT is 6-dec).
- MockOracle price is **8 decimals**; `getPrice(bytes32)` returns **two** values `(uint256 price, uint256 updatedAt)`.
- Deploy commands are **printed for the user, never executed by the implementer** (Task 16).

---

## Spec Reconciliation (read before starting — the spec drifted from `main`)

These were verified against the live code. The plan already accounts for them; do not "fix" them back to the spec's wording.

1. **Phase 1 is ~90% done already.** `useContracts.ts` already builds a `pepeStaking` instance (line 53) and imports `PepeStaking.json` (line 23); `frontend/src/contracts/abi/PepeStaking.json` exists. The *only* real gap is `addresses.ts` `SEPOLIA.PepeStaking` still `0x0`. Task 1 is just that one-line address edit + verification.
2. **Phase 5 is locked to 做法 B (display-only).** `PerpetualExchange` declares `IOracle public immutable oracle;` (set once in constructor, no setter). Oracle **cannot** be switched without redeploy → forbidden. So we build only the read-only 3-source comparison panel and label it honestly. Do NOT attempt to wire adapters into the exchange.
3. **Phase 4 premise is stale.** On `main`, `.github/workflows/price-keeper.yml` already has `on: schedule: - cron: '0 * * * *'` and title `Oracle Price Keeper` — it is **not** deprecated and **not** dispatch-only. Real delta shrinks to: rename title to `Oracle Price Keeper (Sepolia)` and change cron to `*/15 * * * *`. Secret names (`KEEPER_RPC_URL` / `KEEPER_PRIVATE_KEY`) intentionally differ from the Base-Sepolia keeper's `BASE_SEPOLIA_RPC_URL` (different chains) — leave them.
4. **Phase 5D premise is stale.** `scripts/priceKeeper.ts` already fetches crypto from **Binance** (`fetchBinancePrices`), not CoinGecko. The change is: add Coinbase as the *preferred* source with Binance kept as fallback.
5. **ExchangePage already labels MockUSDC as "USDT"** in its faucet/deposit copy (memory: "模擬幣顯示改 USDT"). Task 6 must reconcile this: the *real* separate `MockUSDT` token + a `USDC/USDT` toggle replaces the cosmetic relabel. Read the actual file on `main` before editing.

**Confirmed facts the tasks rely on:**
- `MockUSDC.sol`: `ERC20("Mock USDC","mUSDC")` + `Ownable`; has `faucet()` (1000e18/24h, `FaucetCooldown` error), `mint(to,amount)` (unrestricted), `setSwapRouter`, `burnFrom`. 18-dec default.
- `MockOracle.getPrice(bytes32) view returns (uint256 price, uint256 updatedAt)`, 8-dec.
- Adapters (`ChainlinkOracleAdapter`, `PythOracleAdapter`, `AggregatorOracleAdapter`) all expose the same `getPrice(bytes32)→(uint256,uint256)`. Deployed only on **Base Sepolia**, in `addresses.ts` `BASE_SEPOLIA_ORACLE_SHOWCASE` = `{ ChainlinkAdapter, PythAdapter, AggregatorOracle }`.
- `ASSET_IDS` (11, canonical order): sBTC, sETH, sAAPL, sTSLA, sGOLD, sBOND, sNVDA, sMSFT, sGOOGL, sICLN, sESGU.
- Routes live in `frontend/src/routes/sections/pepefi.tsx`; nav in `frontend/src/layouts/nav-config-dashboard.tsx`.

---

## File Structure

**Contracts (all NEW):**
- `contracts/src/MockUSDT.sol` — second mock stablecoin, clone of MockUSDC (name/symbol only).
- `contracts/src/SyntheticAsset.sol` — ERC-20 per asset; vault-only mint/burn; stores `assetId`.
- `contracts/src/AssetVault.sol` — USDC↔token mint/redeem at oracle price; owner funds USDC reserve.
- `contracts/test/MockUSDT.t.sol` — clone of MockUSDC.t.sol.
- `contracts/test/AssetVault.t.sol` — mint/redeem/guards.
- `contracts/script/DeployMockUSDT.s.sol` — deploy MockUSDT.
- `contracts/script/DeploySyntheticAssets.s.sol` — deploy vault + 11 tokens + register.

**Frontend (mostly NEW, a few edits):**
- `frontend/src/contracts/addresses.ts` — EDIT: fix PepeStaking; add `MockUSDT` + `AssetVault` to interface & 3 chains; add `SYNTH_TOKENS`.
- `frontend/src/hooks/useContracts.ts` — EDIT: add `usdt` + `assetVault` instances.
- `frontend/src/contracts/abi/MockUSDT.json` — NEW (reuse MockUSDC ABI shape after build).
- `frontend/src/contracts/abi/AssetVault.json`, `SyntheticAsset.json` — NEW (from `forge build` out/).
- `frontend/src/lib/pepefi/stablecoin.ts` — NEW: stable selection + event.
- `frontend/src/hooks/useStablecoin.ts` — NEW: `{ stable, setStable, token }`.
- `frontend/src/pages/pepefi/TokenizedAssetsPage.tsx` — NEW: `/tokens` page.
- `frontend/src/components/pepefi/PaperTradingBadge.tsx` — NEW badge.
- `frontend/src/routes/sections/pepefi.tsx` — EDIT: add `/tokens` route.
- `frontend/src/layouts/nav-config-dashboard.tsx` — EDIT: add nav item.
- `frontend/src/pages/pepefi/ExchangePage.tsx` — EDIT: USDC/USDT toggle, USDT faucet, badge, /tokens hint.
- `frontend/src/pages/pepefi/TradeTerminalPage.tsx` — EDIT: badge (+ deposit toggle if present).
- `frontend/src/pages/pepefi/LandingPage.tsx` — EDIT: badge + Paper-Trading explainer.
- `frontend/src/pages/pepefi/AdminOraclePage.tsx` — EDIT: 3-source comparison panel.
- `frontend/src/layouts/dashboard/*` (header) — EDIT: mount badge.

**Infra (EDIT):**
- `.github/workflows/price-keeper.yml` — title + cron.
- `scripts/priceKeeper.ts` — Coinbase-preferred crypto fetch.

---

### Task 0: Branch reconciliation & baseline gate

**Files:** none (git + build only)

- [ ] **Step 1: Inspect branch divergence**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git status
git log --oneline -3
git log --oneline -3 main
git diff --stat main...HEAD
```

- [x] **Step 2: Working-branch decision — RESOLVED 2026-07-26 (revised after investigation)**

Initial answer was "build off `main`", but investigation showed **that is not executable**:

- `main` = `011ed22` (2026-05-29); `feat/funding-conservation` = `cd5c8b6` (2026-06-27). 163 files / 87,605 lines apart.
- **`main` is a strict ancestor of `feat/funding-conservation`** (`git merge-base --is-ancestor main HEAD` → true). No real divergence; merging feat→main is a fast-forward with **no conflict risk**.
- Files this task must edit that **do not exist on `main`**: `scripts/priceKeeper.ts` (Phase 5D), `contracts/src/{Chainlink,Pyth,Aggregator}OracleAdapter.sol` (Phase 5/5A), `.github/workflows/base-sepolia-keeper.yml`, the whole `agent/` tree, and addresses.ts's `BASE_SEPOLIA` block + `BASE_SEPOLIA_ORACLE_SHOWCASE` (Phase 5 panel reads these). `main` has 17 contracts; the spec's background describes 21.
- Conclusion: **the spec describes the `feat/funding-conservation` tree, not `main`.**

**User decision (option A):** build on top of `feat/funding-conservation`; at the end merge into `main` and push. The user accepted that this also carries the month of pre-existing work (163 files) into `main`. Execution mode: **inline (executing-plans)**.

Therefore: **do NOT `git checkout main`.** Base the feature branch on `feat/funding-conservation`.

- [ ] **Step 3: Establish a green baseline (contracts)**

Run: `cd contracts && forge build && forge test`
Expected: 0 build errors, all tests pass. If red *before any change*, STOP and report — do not build on a red baseline.

- [ ] **Step 4: Establish a green baseline (frontend)**

Run: `cd frontend && yarn install --frozen-lockfile && yarn build`
Expected: build completes, 0 errors.

- [ ] **Step 5: Create a feature branch off the confirmed base**

```bash
git checkout -b feat/professor-requirements   # off the base confirmed in Step 2
```

---

### Task 1: Fix PepeStaking Sepolia address (Phase 1)

**Files:**
- Modify: `frontend/src/contracts/addresses.ts:63`

**Interfaces:**
- Consumes: existing `useContracts().pepeStaking` (already wired — see Reconciliation #1).
- Produces: a non-zero `SEPOLIA.PepeStaking` address so the staking UI connects on chain 11155111.

- [ ] **Step 1: Confirm the two prerequisites already exist**

Run: `grep -n "pepeStaking" frontend/src/hooks/useContracts.ts && ls frontend/src/contracts/abi/PepeStaking.json`
Expected: line 53 `pepeStaking: new Contract(addr.PepeStaking, PepeStakingABI, runner)` prints; the ABI file lists. If either is missing, add the instance/import following the sibling pattern and copy the ABI from `contracts/out/PepeStaking.sol/PepeStaking.json`'s `.abi`.

- [ ] **Step 2: Edit the address**

In `frontend/src/contracts/addresses.ts`, in the `SEPOLIA` block, replace:

```ts
  PepeStaking:            "0x0000000000000000000000000000000000000000",
```
with:
```ts
  PepeStaking:            "0xf5d0953A443259ebdFC62fE49189998988e309f9",
```

- [ ] **Step 3: Verify the edit**

Run: `grep -n "PepeStaking" frontend/src/contracts/addresses.ts`
Expected: SEPOLIA line shows `0xf5d0953A443259ebdFC62fE49189998988e309f9`; ANVIL/BASE_SEPOLIA still `0x0`; `PepeIncentives` SEPOLIA already `0x65b9F1B4d18822d4faBa763621E3e4eA065aE5D7`.

- [ ] **Step 4: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/contracts/addresses.ts frontend/src/hooks/useContracts.ts
git commit -m "fix(addresses): wire deployed PepeStaking address on Sepolia"
```

---

### Task 2: MockUSDT contract + tests + deploy script (Phase 2A)

**Files:**
- Create: `contracts/src/MockUSDT.sol`
- Test: `contracts/test/MockUSDT.t.sol`
- Create: `contracts/script/DeployMockUSDT.s.sol`

**Interfaces:**
- Produces: `MockUSDT` with identical API to `MockUSDC` — `faucet()`, `mint(address,uint256)`, `setSwapRouter(address)`, `burnFrom(address,uint256)`, `FAUCET_AMOUNT=1000e18`, `FAUCET_COOLDOWN=1 days`, `name()="Mock Tether USD"`, `symbol()="USDT"`, `decimals()=18`.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/MockUSDT.t.sol` (clone of `MockUSDC.t.sol` with adjusted name/symbol assertions):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDT.sol";

contract MockUSDTTest is Test {
    MockUSDT usdt;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdt = new MockUSDT();
    }

    function test_nameAndSymbol() public view {
        assertEq(usdt.name(), "Mock Tether USD");
        assertEq(usdt.symbol(), "USDT");
        assertEq(usdt.decimals(), 18);
    }

    function test_mintIncreasesBalance() public {
        usdt.mint(alice, 1000e18);
        assertEq(usdt.balanceOf(alice), 1000e18);
    }

    function test_transfer() public {
        usdt.mint(alice, 100e18);
        vm.prank(alice);
        usdt.transfer(bob, 40e18);
        assertEq(usdt.balanceOf(alice), 60e18);
        assertEq(usdt.balanceOf(bob), 40e18);
    }

    function test_faucetMintsCorrectAmount() public {
        vm.prank(alice);
        usdt.faucet();
        assertEq(usdt.balanceOf(alice), usdt.FAUCET_AMOUNT());
    }

    function test_faucetCooldown() public {
        vm.startPrank(alice);
        usdt.faucet();
        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDT.FaucetCooldown.selector,
                block.timestamp + usdt.FAUCET_COOLDOWN()
            )
        );
        usdt.faucet();
        vm.stopPrank();
    }

    function test_faucetCanCallAfterCooldown() public {
        vm.startPrank(alice);
        usdt.faucet();
        vm.warp(block.timestamp + usdt.FAUCET_COOLDOWN() + 1);
        usdt.faucet();
        vm.stopPrank();
        assertEq(usdt.balanceOf(alice), 2 * usdt.FAUCET_AMOUNT());
    }

    function test_faucetIndependentPerAddress() public {
        vm.prank(alice);
        usdt.faucet();
        vm.prank(bob);
        usdt.faucet();
        assertEq(usdt.balanceOf(bob), usdt.FAUCET_AMOUNT());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract MockUSDTTest`
Expected: FAIL — `Source "src/MockUSDT.sol" not found`.

- [ ] **Step 3: Write MockUSDT.sol**

Create `contracts/src/MockUSDT.sol` — byte-for-byte the MockUSDC structure with only name/symbol changed:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET-ONLY mock stablecoin (USDT). `mint` is intentionally
///         unrestricted so deploy scripts, seeds, and tests can fund freely.
///         Simplification: 18 decimals to match the rest of the system
///         (real USDT is 6). NEVER deploy to production.
contract MockUSDT is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT   = 1_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucet;

    address public swapRouter;

    error FaucetCooldown(uint256 nextAvailable);

    constructor() ERC20("Mock Tether USD", "USDT") Ownable(msg.sender) {}

    function setSwapRouter(address _router) external onlyOwner {
        require(swapRouter == address(0), "Already set");
        swapRouter = _router;
    }

    function burnFrom(address from, uint256 amount) external {
        require(msg.sender == swapRouter, "Only router can burn");
        _burn(from, amount);
    }

    /// @notice One call per 24 h, mints 1 000 USDT.
    function faucet() external {
        uint256 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Unrestricted mint for deploy scripts and tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract MockUSDTTest -vv`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Write the deploy script**

Create `contracts/script/DeployMockUSDT.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/MockUSDT.sol";

contract DeployMockUSDT is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDT usdt = new MockUSDT();
        vm.stopBroadcast();
        console.log("MockUSDT deployed:", address(usdt));
    }
}
```

- [ ] **Step 6: Full contracts gate**

Run: `cd contracts && forge build && forge test`
Expected: 0 build errors, all green.

- [ ] **Step 7: Commit**

```bash
git add contracts/src/MockUSDT.sol contracts/test/MockUSDT.t.sol contracts/script/DeployMockUSDT.s.sol
git commit -m "feat(stablecoin): add MockUSDT (18-dec) mock, tests, deploy script"
```

---

### Task 3: SyntheticAsset contract + tests (Phase 3A part 1)

**Files:**
- Create: `contracts/src/SyntheticAsset.sol`
- Test: `contracts/test/SyntheticAsset.t.sol` (folded into AssetVault suite in Task 4; a minimal standalone guard test here)

**Interfaces:**
- Produces: `SyntheticAsset(string name, string symbol, bytes32 assetId, address vault)`; `decimals()=18`; `assetId() view returns (bytes32)`; `vault() view returns (address)`; `mint(address,uint256)` and `burn(address,uint256)` guarded by `onlyVault`.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/SyntheticAsset.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SyntheticAsset.sol";

contract SyntheticAssetTest is Test {
    SyntheticAsset token;
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        token = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, vault);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Synthetic Apple");
        assertEq(token.symbol(), "sAAPL");
        assertEq(token.decimals(), 18);
        assertEq(token.assetId(), AID);
        assertEq(token.vault(), vault);
    }

    function test_onlyVaultCanMint() public {
        vm.prank(alice);
        vm.expectRevert(bytes("only vault"));
        token.mint(alice, 1e18);

        vm.prank(vault);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_onlyVaultCanBurn() public {
        vm.prank(vault);
        token.mint(alice, 5e18);
        vm.prank(alice);
        vm.expectRevert(bytes("only vault"));
        token.burn(alice, 1e18);

        vm.prank(vault);
        token.burn(alice, 2e18);
        assertEq(token.balanceOf(alice), 3e18);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract SyntheticAssetTest`
Expected: FAIL — `Source "src/SyntheticAsset.sol" not found`.

- [ ] **Step 3: Write SyntheticAsset.sol**

Create `contracts/src/SyntheticAsset.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET-ONLY ERC-20 representing one synthetic asset. Mint/burn are
///         restricted to the AssetVault. Backed 1:1 by USDC held in the vault
///         at the current oracle price. NEVER deploy to production.
contract SyntheticAsset is ERC20 {
    bytes32 public immutable assetId;
    address public immutable vault;

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 assetId_,
        address vault_
    ) ERC20(name_, symbol_) {
        assetId = assetId_;
        vault = vault_;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract SyntheticAssetTest -vv`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/SyntheticAsset.sol contracts/test/SyntheticAsset.t.sol
git commit -m "feat(tokenized): SyntheticAsset ERC-20 with vault-only mint/burn"
```

---

### Task 4: AssetVault contract + tests (Phase 3A part 2)

**Files:**
- Create: `contracts/src/AssetVault.sol`
- Test: `contracts/test/AssetVault.t.sol`

**Interfaces:**
- Consumes: `SyntheticAsset` (Task 3); `IOracle.getPrice(bytes32)→(uint256 price,uint256 updatedAt)` (8-dec); an ERC-20 USDC with `transferFrom`/`transfer`.
- Produces:
  - `AssetVault(address usdc, address oracle)` (Ownable).
  - `mapping(bytes32=>address) public assetToken;`
  - `registerAsset(bytes32 assetId, address token) external onlyOwner`
  - `mint(bytes32 assetId, uint256 usdcAmount) external` — tokenAmount = `usdcAmount * 1e8 / price` (both usdc & token 18-dec, price 8-dec → 18-dec token out).
  - `redeem(bytes32 assetId, uint256 tokenAmount) external` — usdcOut = `tokenAmount * price / 1e8`.
  - `previewMint(bytes32,uint256) view returns (uint256)`, `previewRedeem(bytes32,uint256) view returns (uint256)`
  - `fundVault(uint256 usdcAmount) external onlyOwner`
  - events `Minted(address,bytes32,uint256,uint256)`, `Redeemed(address,bytes32,uint256,uint256)`.

**Note on decimals:** usdcAmount(18) × 1e8 / price(8-dec) = token(18). Redeem inverse. This matches the spec formula exactly.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/AssetVault.t.sol`. Uses `MockUSDC` and `MockOracle` (both existing) plus `SyntheticAsset`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AssetVault.sol";
import "../src/SyntheticAsset.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract AssetVaultTest is Test {
    AssetVault      vault;
    MockUSDC        usdc;
    MockOracle      oracle;
    SyntheticAsset  aapl;

    address owner = address(this);
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");
    uint256 constant PRICE_8 = 200e8; // $200, 8-dec

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        vault  = new AssetVault(address(usdc), address(oracle));

        aapl = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(vault));
        vault.registerAsset(AID, address(aapl));

        oracle.updatePrice(AID, PRICE_8);

        usdc.mint(alice, 10_000e18);
        // seed vault USDC reserve so redeem can pay out
        usdc.mint(owner, 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
    }

    function test_mintGivesCorrectTokenAmount() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);           // $2000 / $200 = 10 sAAPL
        vm.stopPrank();
        assertEq(aapl.balanceOf(alice), 10e18);
    }

    function test_previewMintMatches() public view {
        assertEq(vault.previewMint(AID, 2_000e18), 10e18);
    }

    function test_redeemReturnsUsdc() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);
        uint256 balBefore = usdc.balanceOf(alice);
        vault.redeem(AID, 10e18);            // 10 sAAPL * $200 = $2000
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice) - balBefore, 2_000e18);
        assertEq(aapl.balanceOf(alice), 0);
    }

    function test_mintRevertsWhenNoPrice() public {
        bytes32 unknown = keccak256("sNONE");
        SyntheticAsset none = new SyntheticAsset("None", "sNONE", unknown, address(vault));
        vault.registerAsset(unknown, address(none));
        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert(bytes("no price"));
        vault.mint(unknown, 1_000e18);
        vm.stopPrank();
    }

    function test_redeemRevertsWhenVaultDry() public {
        // fresh vault with no reserve
        AssetVault dry = new AssetVault(address(usdc), address(oracle));
        SyntheticAsset t = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(dry));
        dry.registerAsset(AID, address(t));
        vm.startPrank(alice);
        usdc.approve(address(dry), 2_000e18);
        dry.mint(AID, 2_000e18);             // vault now holds exactly 2000 from alice
        dry.redeem(AID, 10e18);              // pays back the 2000 — ok
        // second redeem with nothing left must revert
        vm.expectRevert();
        dry.redeem(AID, 10e18);
        vm.stopPrank();
    }

    function test_onlyOwnerCanRegister() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.registerAsset(keccak256("sX"), address(0xdead));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract AssetVaultTest`
Expected: FAIL — `Source "src/AssetVault.sol" not found`.

- [ ] **Step 3: Write AssetVault.sol**

Create `contracts/src/AssetVault.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./SyntheticAsset.sol";

interface IAssetOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice TESTNET-ONLY mint/burn vault. Users pay USDC to mint a SyntheticAsset
///         ERC-20 at the current 8-dec oracle price, and burn it back for USDC.
///         The vault must hold a USDC reserve (fundVault) to honor redemptions.
///         This is NOT an AMM — price comes purely from the oracle.
contract AssetVault is Ownable {
    IERC20        public immutable usdc;
    IAssetOracle  public immutable oracle;

    mapping(bytes32 => address) public assetToken; // assetId => SyntheticAsset

    event Minted(address indexed user, bytes32 indexed assetId, uint256 usdcIn, uint256 tokenOut);
    event Redeemed(address indexed user, bytes32 indexed assetId, uint256 tokenIn, uint256 usdcOut);
    event AssetRegistered(bytes32 indexed assetId, address token);

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        usdc   = IERC20(_usdc);
        oracle = IAssetOracle(_oracle);
    }

    function registerAsset(bytes32 assetId, address token) external onlyOwner {
        assetToken[assetId] = token;
        emit AssetRegistered(assetId, token);
    }

    function _price(bytes32 assetId) internal view returns (uint256 price) {
        (price, ) = oracle.getPrice(assetId);
        require(price > 0, "no price");
    }

    function previewMint(bytes32 assetId, uint256 usdcAmount) public view returns (uint256) {
        return usdcAmount * 1e8 / _price(assetId);
    }

    function previewRedeem(bytes32 assetId, uint256 tokenAmount) public view returns (uint256) {
        return tokenAmount * _price(assetId) / 1e8;
    }

    function mint(bytes32 assetId, uint256 usdcAmount) external {
        address token = assetToken[assetId];
        require(token != address(0), "asset not registered");
        require(usdcAmount > 0, "zero amount");
        uint256 tokenAmount = previewMint(assetId, usdcAmount);
        require(tokenAmount > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "usdc in failed");
        SyntheticAsset(token).mint(msg.sender, tokenAmount);
        emit Minted(msg.sender, assetId, usdcAmount, tokenAmount);
    }

    function redeem(bytes32 assetId, uint256 tokenAmount) external {
        address token = assetToken[assetId];
        require(token != address(0), "asset not registered");
        require(tokenAmount > 0, "zero amount");
        uint256 usdcOut = previewRedeem(assetId, tokenAmount);
        require(usdc.balanceOf(address(this)) >= usdcOut, "vault dry");
        SyntheticAsset(token).burn(msg.sender, tokenAmount);
        require(usdc.transfer(msg.sender, usdcOut), "usdc out failed");
        emit Redeemed(msg.sender, assetId, tokenAmount, usdcOut);
    }

    /// @notice Owner injects USDC reserve so users can redeem.
    function fundVault(uint256 usdcAmount) external onlyOwner {
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "fund failed");
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract AssetVaultTest -vv`
Expected: PASS (all tests). If `MockOracle`'s price setter is not named `updatePrice`, check its ABI (`grep "function set\|function update" contracts/src/MockOracle.sol`) and adjust the test's seeding calls to the real setter name — the vault code is unaffected.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/AssetVault.sol contracts/test/AssetVault.t.sol
git commit -m "feat(tokenized): AssetVault mint/redeem at oracle price with USDC reserve"
```

---

### Task 5: DeploySyntheticAssets script (Phase 3A part 3)

**Files:**
- Create: `contracts/script/DeploySyntheticAssets.s.sol`

**Interfaces:**
- Consumes: `AssetVault`, `SyntheticAsset`, existing on-chain MockUSDC + MockOracle addresses (read from env).
- Produces: console output of vault + 11 token addresses to paste into `addresses.ts` (Task 8/12).

- [ ] **Step 1: Write the script**

Create `contracts/script/DeploySyntheticAssets.s.sol`. Asset ids are `keccak256(symbol)`; verify each matches `ASSET_IDS` in `addresses.ts` (they do — both use `keccak256(symbol string)`).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AssetVault.sol";
import "../src/SyntheticAsset.sol";

contract DeploySyntheticAssets is Script {
    // 11 assets: symbol + human name. assetId = keccak256(symbol).
    function _defs() internal pure returns (string[11] memory syms, string[11] memory names) {
        syms  = ["sBTC","sETH","sAAPL","sTSLA","sGOLD","sBOND","sNVDA","sMSFT","sGOOGL","sICLN","sESGU"];
        names = [
            "Synthetic Bitcoin","Synthetic Ether","Synthetic Apple","Synthetic Tesla",
            "Synthetic Gold","Synthetic Bond","Synthetic Nvidia","Synthetic Microsoft",
            "Synthetic Alphabet","Synthetic iShares Clean Energy","Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc   = vm.envAddress("MOCKUSDC_ADDR");
        address oracle = vm.envAddress("MOCKORACLE_ADDR");

        vm.startBroadcast();
        AssetVault vault = new AssetVault(usdc, oracle);
        console.log("AssetVault deployed:", address(vault));

        (string[11] memory syms, string[11] memory names) = _defs();
        for (uint256 i = 0; i < 11; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAsset t = new SyntheticAsset(names[i], syms[i], aid, address(vault));
            vault.registerAsset(aid, address(t));
            console.log(syms[i], address(t));
        }
        vm.stopBroadcast();
        console.log("Done. Fund the vault with fundVault() so users can redeem.");
    }
}
```

- [ ] **Step 2: Compile-check via build (no broadcast)**

Run: `cd contracts && forge build`
Expected: 0 errors. (Do NOT run the script's `run()` — deployment is the user's step in Task 16.)

- [ ] **Step 3: Full contracts gate**

Run: `cd contracts && forge test`
Expected: all green (script isn't a test; this confirms nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add contracts/script/DeploySyntheticAssets.s.sol
git commit -m "feat(tokenized): deploy script for AssetVault + 11 synthetic ERC-20s"
```

---

### Task 6: Extract ABIs for new contracts to frontend

**Files:**
- Create: `frontend/src/contracts/abi/MockUSDT.json`
- Create: `frontend/src/contracts/abi/AssetVault.json`
- Create: `frontend/src/contracts/abi/SyntheticAsset.json`

**Interfaces:**
- Produces: ABI JSON arrays consumed by `useContracts.ts` (Task 7) and `TokenizedAssetsPage` (Task 11).

- [ ] **Step 1: Confirm the build artifacts exist**

Run: `cd contracts && forge build && ls out/MockUSDT.sol/MockUSDT.json out/AssetVault.sol/AssetVault.json out/SyntheticAsset.sol/SyntheticAsset.json`
Expected: all three list.

- [ ] **Step 2: Copy the `.abi` arrays into frontend ABI files**

The existing frontend ABI files (e.g. `MockUSDC.json`) are **bare ABI arrays** (not the full Foundry artifact). Match that shape. For each contract, write only the `.abi` array:

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
node -e "const a=require('./contracts/out/MockUSDT.sol/MockUSDT.json').abi;require('fs').writeFileSync('frontend/src/contracts/abi/MockUSDT.json',JSON.stringify(a,null,2))"
node -e "const a=require('./contracts/out/AssetVault.sol/AssetVault.json').abi;require('fs').writeFileSync('frontend/src/contracts/abi/AssetVault.json',JSON.stringify(a,null,2))"
node -e "const a=require('./contracts/out/SyntheticAsset.sol/SyntheticAsset.json').abi;require('fs').writeFileSync('frontend/src/contracts/abi/SyntheticAsset.json',JSON.stringify(a,null,2))"
```

Verify against a sibling: `head -c 60 frontend/src/contracts/abi/MockUSDC.json` — should start with `[` (bare array). If instead siblings are `{ "abi": [...] }`, drop `.abi` from the node commands to preserve the wrapper. Match whatever the siblings do.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/contracts/abi/MockUSDT.json frontend/src/contracts/abi/AssetVault.json frontend/src/contracts/abi/SyntheticAsset.json
git commit -m "chore(abi): export MockUSDT/AssetVault/SyntheticAsset ABIs to frontend"
```

---

### Task 7: addresses.ts + useContracts wiring for USDT & AssetVault (Phase 2B/3B part 1)

**Files:**
- Modify: `frontend/src/contracts/addresses.ts` (interface + 3 chain blocks + `SYNTH_TOKENS`)
- Modify: `frontend/src/hooks/useContracts.ts`

**Interfaces:**
- Produces: `ChainAddresses.MockUSDT`, `ChainAddresses.AssetVault`; `SYNTH_TOKENS: Record<number, Partial<Record<AssetSymbol,string>>>`; `useContracts().usdt`, `useContracts().assetVault`.

- [ ] **Step 1: Add interface fields**

In `frontend/src/contracts/addresses.ts`, extend `ChainAddresses`:

```ts
export interface ChainAddresses {
  MockUSDC:          string
  MockUSDT:          string
  MockOracle:        string
  // …existing fields unchanged…
  PepeStaking:            string
  AssetVault:             string
}
```

- [ ] **Step 2: Add the two new fields to ANVIL, SEPOLIA, BASE_SEPOLIA**

In each of the three blocks add (placeholders until user deploys — Task 16 → I fill real values on the user's return):

```ts
  MockUSDT:          "0x0000000000000000000000000000000000000000",
  AssetVault:             "0x0000000000000000000000000000000000000000",
```

- [ ] **Step 3: Add SYNTH_TOKENS constant**

After `ASSET_IDS`, add:

```ts
// Deployed SyntheticAsset ERC-20 addresses per chain (filled after DeploySyntheticAssets).
export const SYNTH_TOKENS: Record<number, Partial<Record<AssetSymbol, string>>> = {
  31337:    {},
  11155111: {},
  84532:    {},
}
export const getSynthTokens = (chainId: number | null): Partial<Record<AssetSymbol, string>> =>
  chainId === null ? {} : (SYNTH_TOKENS[chainId] ?? {})
```

(`AssetSymbol` is already exported at the bottom of the file.)

- [ ] **Step 4: Wire instances in useContracts.ts**

Add imports next to the existing ABI imports:

```ts
import MockUSDTABI             from 'src/contracts/abi/MockUSDT.json'
import AssetVaultABI          from 'src/contracts/abi/AssetVault.json'
```

Add inside the returned object (after `usdc`):

```ts
      usdt:                 new Contract(addr.MockUSDT,             MockUSDTABI,             runner),
      assetVault:           new Contract(addr.AssetVault,          AssetVaultABI,           runner),
```

- [ ] **Step 5: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors. (Contracts at `0x0` construct fine; guarded at call sites in later tasks.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/contracts/addresses.ts frontend/src/hooks/useContracts.ts
git commit -m "feat(stablecoin,tokenized): wire MockUSDT + AssetVault + SYNTH_TOKENS in frontend"
```

---

### Task 8: stablecoin lib + useStablecoin hook (Phase 2B part 2)

**Files:**
- Create: `frontend/src/lib/pepefi/stablecoin.ts`
- Create: `frontend/src/hooks/useStablecoin.ts`

**Interfaces:**
- Produces: `getStable()`, `setStable(s)`, `stableLabel(s)`, `type Stable = 'USDC'|'USDT'`; hook `useStablecoin(contracts)` → `{ stable, setStable, token }` where `token` is `contracts.usdc` or `contracts.usdt`.

- [ ] **Step 1: Write stablecoin.ts (verbatim from spec)**

Create `frontend/src/lib/pepefi/stablecoin.ts`:

```ts
export type Stable = 'USDC' | 'USDT';
const KEY = 'pepefi:stablecoin';

export function getStable(): Stable {
  try { return (localStorage.getItem(KEY) as Stable) ?? 'USDC'; }
  catch { return 'USDC'; }
}

export function setStable(s: Stable): void {
  try {
    localStorage.setItem(KEY, s);
    window.dispatchEvent(new CustomEvent('pepefi:stable-changed', { detail: s }));
  } catch {}
}

export const stableLabel = (s: Stable) => s; // display passthrough
```

- [ ] **Step 2: Write useStablecoin.ts**

Create `frontend/src/hooks/useStablecoin.ts`. `contracts` is the return of `useContracts` (may be null):

```ts
import type { Contract } from 'ethers';

import { useState, useEffect, useCallback } from 'react';

import { getStable, setStable as persistStable, type Stable } from 'src/lib/pepefi/stablecoin';

type ContractsLike = { usdc: Contract; usdt: Contract } | null;

export function useStablecoin(contracts: ContractsLike) {
  const [stable, setStableState] = useState<Stable>(getStable());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<Stable>).detail;
      if (detail === 'USDC' || detail === 'USDT') setStableState(detail);
    };
    window.addEventListener('pepefi:stable-changed', onChange);
    return () => window.removeEventListener('pepefi:stable-changed', onChange);
  }, []);

  const setStable = useCallback((s: Stable) => {
    persistStable(s);       // fires the event → state updates via listener
    setStableState(s);
  }, []);

  const token: Contract | null =
    !contracts ? null : stable === 'USDC' ? contracts.usdc : contracts.usdt;

  return { stable, setStable, token };
}
```

- [ ] **Step 3: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/pepefi/stablecoin.ts frontend/src/hooks/useStablecoin.ts
git commit -m "feat(stablecoin): stablecoin selection lib + useStablecoin hook"
```

---

### Task 9: ExchangePage USDC/USDT toggle + USDT faucet + honest limit note (Phase 2B part 3)

**Files:**
- Modify: `frontend/src/pages/pepefi/ExchangePage.tsx`

**Interfaces:**
- Consumes: `useStablecoin(contracts)` (Task 8), existing `contracts.usdc`/`contracts.usdt`, existing `notify`, `wallet`.
- Behavior: a `ToggleButtonGroup` (USDC | USDT) in the margin/deposit card; balance shown for the selected token; a USDT faucet button beside the existing USDC one; the deposit/approve path still uses **MockUSDC** (see honest note).

**IMPORTANT — read the file first.** ExchangePage already labels MockUSDC as "USDT" in copy (Reconciliation #5). Read `frontend/src/pages/pepefi/ExchangePage.tsx` around the balances/faucet/margin block (approx lines 119–460: `usdcBal`, `faucet`, `approveDeposit`, `watchAsset`) and match its existing MUI/state idioms. The margin deposit **must remain USDC** because `PerpetualExchange.depositMargin` only accepts MockUSDC.

- [ ] **Step 1: Add stablecoin state + USDT balance**

Near the existing `const contracts = useContracts(...)` and `usdcBal` state, add:

```tsx
import { useStablecoin } from 'src/hooks/useStablecoin';
// …inside component, after contracts:
const { stable, setStable } = useStablecoin(contracts);
const [usdtBal, setUsdtBal] = useState(0n);
```

In the existing balance-loading effect (where `usdcBal` is set via `safeRead(contracts.usdc.balanceOf(addr) …)`), add alongside it:

```tsx
setUsdtBal(await safeRead(contracts.usdt.balanceOf(addr) as Promise<bigint>, 0n));
```

- [ ] **Step 2: Add the toggle in the margin/deposit card**

In the deposit/margin JSX block, above the deposit input, add (import `ToggleButton, ToggleButtonGroup` from `@mui/material` if not already imported):

```tsx
<ToggleButtonGroup
  size="small"
  exclusive
  value={stable}
  onChange={(_, v) => v && setStable(v)}
  sx={{ mb: 1 }}
>
  <ToggleButton value="USDC">USDC</ToggleButton>
  <ToggleButton value="USDT">USDT</ToggleButton>
</ToggleButtonGroup>
<Typography variant="caption" color="text.secondary" display="block">
  餘額 {stable}: {(Number(stable === 'USDC' ? usdcBal : usdtBal) / 1e18).toFixed(2)}
</Typography>
<Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
  目前交易保證金使用 USDC；USDT 支援兌換與持有，保證金支援列為下一階段。
</Typography>
```

- [ ] **Step 3: Add a USDT faucet button**

Beside the existing USDC faucet handler (the one calling `contracts.usdc.faucet()`), add a parallel handler + button:

```tsx
const faucetUsdt = async () => {
  if (!contracts) return;
  try {
    const tx = asTx(await contracts.usdt.faucet());
    await tx.wait();
    notify('已領取測試 USDT ✓', true, tx.hash);
  } catch (e) { notify(errMsg(e), false); }
};
```

Render a `<Button onClick={faucetUsdt}>領取測試 USDT</Button>` next to the existing USDC faucet button. Guard: if `contracts.usdt.target` is the zero address, disable it with tooltip "MockUSDT 尚未部署".

- [ ] **Step 4: Keep deposit on USDC (do NOT switch depositMargin token)**

Confirm `approveDeposit` still uses `contracts.usdc` for both `approve` and `exchange.depositMargin`. Do not parameterize it by `stable` — margin is USDC-only by contract. (This is the honest limit the caption states.)

- [ ] **Step 5: Add a /tokens hint at the top of ExchangePage**

Near the page header, add:

```tsx
<Alert severity="info" sx={{ mb: 2 }}>
  想要真正持有 ERC-20 代幣？
  <RouterLink to={paths.pepefi.tokens} style={{ marginLeft: 8 }}>前往代幣化資產頁 →</RouterLink>
</Alert>
```

(Add `paths.pepefi.tokens` in Task 11 Step 2; import `RouterLink` from `src/routes/components` following existing usage in the file.)

- [ ] **Step 6: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/pepefi/ExchangePage.tsx
git commit -m "feat(exchange): USDC/USDT toggle, USDT faucet, honest margin note, /tokens link"
```

---

### Task 10: TradeTerminalPage deposit toggle (conditional) (Phase 2 step 9)

**Files:**
- Modify: `frontend/src/pages/pepefi/TradeTerminalPage.tsx`

- [ ] **Step 1: Check whether TradeTerminalPage has a deposit/margin control**

Run: `grep -n "depositMargin\|faucet\|approve\|usdc\|USDC" frontend/src/pages/pepefi/TradeTerminalPage.tsx`
Expected: identify if a deposit UI exists.

- [ ] **Step 2: If a deposit UI exists**, apply the same toggle + balance + honest-note pattern from Task 9 (Steps 1–2, 4). If it has **no** deposit UI, skip the toggle here — the PaperTrading badge (Task 14) is the only change to this file. Record which case applied.

- [ ] **Step 3: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 4: Commit** (only if changed)

```bash
git add frontend/src/pages/pepefi/TradeTerminalPage.tsx
git commit -m "feat(terminal): stablecoin toggle on deposit (if present)"
```

---

### Task 11: TokenizedAssetsPage + route + nav (Phase 3B part 2)

**Files:**
- Create: `frontend/src/pages/pepefi/TokenizedAssetsPage.tsx`
- Modify: `frontend/src/routes/sections/pepefi.tsx`
- Modify: `frontend/src/routes/paths.ts` (add `pepefi.tokens`)
- Modify: `frontend/src/layouts/nav-config-dashboard.tsx`

**Interfaces:**
- Consumes: `useContracts` (`assetVault`, `usdc`, `oracle`), `getSynthTokens(chainId)`, `ASSET_IDS`, `SyntheticAsset.json` ABI, `useWallet` via outlet context.
- Behavior: 11 asset cards showing oracle price, my token balance, USD value, Buy (approve+mint), Sell (redeem), and "加入 MetaMask" (`wallet_watchAsset`). Graceful "尚未啟用" when `AssetVault` is `0x0` or no synth token registered for the chain.

**Read first:** open an existing simple pepefi page (e.g. `frontend/src/pages/pepefi/VaultPage.tsx` or `RewardsPage.tsx`) to copy the page shell, `useOutletContext<WalletAPI>()` usage, `useContracts` call, notify import, and MUI card grid idiom. Match those imports exactly.

- [ ] **Step 1: Add the route path**

In `frontend/src/routes/paths.ts`, inside the `pepefi` paths object, add:

```ts
    tokens: '/tokens',
```

- [ ] **Step 2: Register the lazy route**

In `frontend/src/routes/sections/pepefi.tsx`, add the lazy import beside the others:

```tsx
const TokenizedAssetsPage = lazy(() => import('src/pages/pepefi/TokenizedAssetsPage'));
```

and add a child route inside the `SuspenseOutlet` children array:

```tsx
          { path: 'tokens', element: <TokenizedAssetsPage /> },
```

- [ ] **Step 3: Add the nav item**

In `frontend/src/layouts/nav-config-dashboard.tsx`, inside the PepeLab section `items` array, add (near Exchange):

```tsx
      { title: '代幣化資產', path: paths.pepefi.tokens, icon: ICONS.product },
```

- [ ] **Step 4: Write TokenizedAssetsPage.tsx**

Create `frontend/src/pages/pepefi/TokenizedAssetsPage.tsx`. Structure — a top explainer card, then a grid of 11 cards driven by `ASSET_IDS` + `getSynthTokens`:

```tsx
import type { WalletAPI } from 'src/hooks/useWallet';

import { Contract } from 'ethers';
import { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router';

import {
  Box, Card, Grid, Alert, Button, Dialog, TextField, Typography,
  DialogTitle, DialogActions, DialogContent, CardContent,
} from '@mui/material';

import { useContracts } from 'src/hooks/useContracts';
import SyntheticAssetABI from 'src/contracts/abi/SyntheticAsset.json';
import { ASSET_IDS, getSynthTokens, getAddresses, type AssetSymbol } from 'src/contracts/addresses';

const ZERO = '0x0000000000000000000000000000000000000000';

export default function TokenizedAssetsPage() {
  const wallet = useOutletContext<WalletAPI>();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const addr = getAddresses(wallet.chainId);
  const synth = getSynthTokens(wallet.chainId);

  const vaultReady = !!addr && addr.AssetVault !== ZERO && Object.keys(synth).length > 0;

  const [prices, setPrices] = useState<Record<string, bigint>>({});
  const [bals, setBals] = useState<Record<string, bigint>>({});
  const [dlg, setDlg] = useState<{ sym: AssetSymbol; mode: 'buy' | 'sell' } | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!contracts || !vaultReady || !wallet.address) return;
    const p: Record<string, bigint> = {};
    const b: Record<string, bigint> = {};
    for (const sym of Object.keys(synth) as AssetSymbol[]) {
      const id = ASSET_IDS[sym];
      try { const [price] = await contracts.oracle.getPrice(id); p[sym] = price as bigint; } catch { p[sym] = 0n; }
      try {
        const t = new Contract(synth[sym]!, SyntheticAssetABI, contracts.usdc.runner);
        b[sym] = (await t.balanceOf(wallet.address)) as bigint;
      } catch { b[sym] = 0n; }
    }
    setPrices(p); setBals(b);
  }, [contracts, vaultReady, wallet.address, synth]);

  useEffect(() => { refresh(); }, [refresh]);

  const doBuy = async (sym: AssetSymbol) => {
    if (!contracts) return;
    setBusy(true);
    try {
      const usdcAmt = BigInt(Math.round(parseFloat(amount) * 1e18));
      const a = await contracts.usdc.approve(addr!.AssetVault, usdcAmt);
      await a.wait();
      const tx = await contracts.assetVault.mint(ASSET_IDS[sym], usdcAmt);
      await tx.wait();
      setDlg(null); setAmount(''); await refresh();
    } finally { setBusy(false); }
  };

  const doSell = async (sym: AssetSymbol) => {
    if (!contracts) return;
    setBusy(true);
    try {
      const tokenAmt = BigInt(Math.round(parseFloat(amount) * 1e18));
      const tx = await contracts.assetVault.redeem(ASSET_IDS[sym], tokenAmt);
      await tx.wait();
      setDlg(null); setAmount(''); await refresh();
    } finally { setBusy(false); }
  };

  const addToWallet = async (sym: AssetSymbol) => {
    const eth = (window as any).ethereum;
    if (!eth) return;
    await eth.request({
      method: 'wallet_watchAsset',
      params: { type: 'ERC20', options: { address: synth[sym], symbol: sym, decimals: 18 } },
    });
  };

  if (!vaultReady) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          代幣化資產尚未在此鏈啟用（AssetVault 未部署）。部署後即可買入 ERC-20 資產。
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        本頁展示代幣化資產（ERC-20）。與交易頁的合成持倉不同，這裡買入的資產會以
        ERC-20 token 形式出現在你的錢包中，可加入 MetaMask 檢視、可轉帳給他人。
      </Alert>
      <Grid container spacing={2}>
        {(Object.keys(synth) as AssetSymbol[]).map((sym) => {
          const price = prices[sym] ?? 0n;
          const bal = bals[sym] ?? 0n;
          const usd = (Number(bal) / 1e18) * (Number(price) / 1e8);
          return (
            <Grid key={sym} item xs={12} sm={6} md={4}>
              <Card>
                <CardContent>
                  <Typography variant="h6">{sym}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    價格 ${(Number(price) / 1e8).toLocaleString()}
                  </Typography>
                  <Typography variant="body2">
                    餘額 {(Number(bal) / 1e18).toFixed(4)} {sym}（≈ ${usd.toFixed(2)}）
                  </Typography>
                  <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button size="small" variant="contained" onClick={() => setDlg({ sym, mode: 'buy' })}>買入</Button>
                    <Button size="small" variant="outlined" onClick={() => setDlg({ sym, mode: 'sell' })}>賣出</Button>
                    <Button size="small" onClick={() => addToWallet(sym)}>加入 MetaMask</Button>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      <Dialog open={!!dlg} onClose={() => setDlg(null)}>
        <DialogTitle>{dlg?.mode === 'buy' ? '買入' : '賣出'} {dlg?.sym}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth type="number" sx={{ mt: 1 }}
            label={dlg?.mode === 'buy' ? '支付 USDC 金額' : `賣出 ${dlg?.sym} 數量`}
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
          {dlg?.mode === 'buy' && dlg && prices[dlg.sym] ? (
            <Typography variant="caption" color="text.secondary">
              你將獲得 ≈ {(parseFloat(amount || '0') / (Number(prices[dlg.sym]) / 1e8)).toFixed(4)} {dlg.sym}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}>取消</Button>
          <Button
            disabled={busy || !amount}
            variant="contained"
            onClick={() => dlg && (dlg.mode === 'buy' ? doBuy(dlg.sym) : doSell(dlg.sym))}
          >
            {busy ? '處理中…' : '確認'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
```

If `WalletAPI` field names differ (e.g. `wallet.account` vs `wallet.address`), align with the sibling page read in "Read first". If sibling pages use a shared `notify`/`asTx` helper, wrap the tx calls the same way instead of raw try/finally.

- [ ] **Step 5: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors. Because `SYNTH_TOKENS` is empty until deploy, the page renders the "尚未啟用" branch — that must not crash.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/pepefi/TokenizedAssetsPage.tsx frontend/src/routes/sections/pepefi.tsx frontend/src/routes/paths.ts frontend/src/layouts/nav-config-dashboard.tsx
git commit -m "feat(tokenized): /tokens page with buy/redeem, watchAsset, nav + route"
```

---

### Task 12: Home/Dashboard USDT faucet entry (Phase 2 step 10)

**Files:**
- Modify: `frontend/src/pages/pepefi/DashboardPage.tsx` **or** `HomePage.tsx` (wherever the existing USDC faucet button lives)

- [ ] **Step 1: Locate the existing USDC faucet entry**

Run: `grep -rn "faucet\|領取\|Get Test Tokens" frontend/src/pages/pepefi/DashboardPage.tsx frontend/src/pages/pepefi/HomePage.tsx`
Expected: find the existing USDC faucet button. Put the USDT faucet next to it.

- [ ] **Step 2: Add a USDT faucet button beside it**

Following the same handler pattern (`contracts.usdt.faucet()`, `notify`), add a `領取測試 USDT` button, disabled when `contracts.usdt.target === ZERO`. If neither page has a faucet entry, add the pair to `DashboardPage.tsx`'s balances area.

- [ ] **Step 3: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/pepefi/DashboardPage.tsx frontend/src/pages/pepefi/HomePage.tsx
git commit -m "feat(faucet): USDT test-token faucet entry beside USDC"
```

---

### Task 13: Re-enable / tighten Sepolia keeper (Phase 4)

**Files:**
- Modify: `.github/workflows/price-keeper.yml`

**Reconciliation:** on `main` this file already has `schedule` and a non-deprecated title. Delta = rename title + tighten cron.

- [ ] **Step 1: Confirm current state of the file on the working branch**

Run: `sed -n '1,8p' .github/workflows/price-keeper.yml`
Expected: current `name:` and `on:` block. If it is **already** `name: Oracle Price Keeper` + scheduled (as on `main`), only Steps 2–3 apply. If it actually shows `deprecated` / dispatch-only (as the spec claims), restore the schedule per Step 3.

- [ ] **Step 2: Set the title**

Change line 1 to:

```yaml
name: Oracle Price Keeper (Sepolia)
```

- [ ] **Step 3: Ensure schedule + dispatch, 15-min cadence**

Make the `on:` block exactly:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:
```

Leave the `ORACLE` env (`0x17CA20A37Cf04F2f589B2573EC95f1411D29d958`) and secret names (`KEEPER_RPC_URL`, `KEEPER_PRIVATE_KEY`) unchanged — they are correct and intentionally distinct from the Base-Sepolia keeper's secrets.

- [ ] **Step 4: Validate YAML**

Run: `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/price-keeper.yml')); print('ok')"`
Expected: `ok`. (Eyeball indentation if python/yaml unavailable.)

- [ ] **Step 5: Commit** (grouped with Task 14 in the spec's commit map)

Hold this file; commit together with `priceKeeper.ts` in Task 14 Step 5.

---

### Task 14: priceKeeper.ts — prefer Coinbase (Phase 5D)

**Files:**
- Modify: `scripts/priceKeeper.ts`

**Reconciliation:** current crypto source is **Binance** (`fetchBinancePrices`), not CoinGecko. Add Coinbase as preferred, keep Binance as fallback. Stock source (stooq etc.) untouched.

**Read first:** open `scripts/priceKeeper.ts` fully to see `fetchBinancePrices()`, its symbol map (`BTCUSDC` etc.), and how `updateOraclePrices()` consumes the returned `Record<string, number>` keyed by asset symbol (sBTC/sETH).

- [ ] **Step 1: Add a Coinbase fetcher**

Add near `fetchBinancePrices`:

```ts
// Coinbase public ticker — no key, no CORS issues server-side.
async function fetchCoinbasePrice(product: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      headers: { 'User-Agent': 'pepefi-keeper' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { price?: string };
    const p = j.price ? parseFloat(j.price) : NaN;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// Preferred source: Coinbase; fallback: Binance (existing).
async function fetchCryptoPrices(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const cbBtc = await fetchCoinbasePrice('BTC-USD');
  const cbEth = await fetchCoinbasePrice('ETH-USD');
  if (cbBtc) out.sBTC = cbBtc;
  if (cbEth) out.sETH = cbEth;

  if (out.sBTC && out.sETH) {
    console.log('[coinbase] BTC/ETH sourced from Coinbase');
    return out;
  }
  // Fallback for whatever Coinbase didn't provide.
  console.log('[coinbase] incomplete, falling back to Binance');
  const bn = await fetchBinancePrices();
  return { ...bn, ...out }; // Coinbase values win where present
}
```

- [ ] **Step 2: Route updateOraclePrices through the new function**

In `updateOraclePrices()`, replace the call `const binancePrices = await fetchBinancePrices();` with:

```ts
const binancePrices = await fetchCryptoPrices();
```

(Keep the variable name `binancePrices` if that minimizes downstream edits, or rename to `cryptoPrices` and update its 1–2 usages. Do not change the stock/random-walk logic.)

- [ ] **Step 3: Type-check / dry compile**

Run: `cd /c/Users/sanketsu/pepelab_onchain_cfd && npx tsc --noEmit scripts/priceKeeper.ts 2>&1 | head` (or the project's configured `tsx`/lint). If the repo runs it via `tsx scripts/priceKeeper.ts`, a full run needs `RPC_URL`/`PK` env — do NOT run live. Confirm types compile.
Expected: no type errors from the new code.

- [ ] **Step 4: Confirm Coinbase reachability (network sanity, optional)**

Run: `curl -s "https://api.exchange.coinbase.com/products/BTC-USD/ticker" | head -c 120`
Expected: JSON containing a `"price"` field. (If offline, skip — code path is guarded.)

- [ ] **Step 5: Commit keeper + workflow together**

```bash
git add .github/workflows/price-keeper.yml scripts/priceKeeper.ts
git commit -m "fix(keeper): re-enable Sepolia schedule, prefer Coinbase price feed"
```

Commit message note to append: remind the user Sepolia keeper needs repo secrets `KEEPER_RPC_URL` + `KEEPER_PRIVATE_KEY`.

---

### Task 15: AdminOraclePage 3-source comparison panel (Phase 5B/5C — 做法 B, read-only)

**Files:**
- Modify: `frontend/src/pages/pepefi/AdminOraclePage.tsx`

**Reconciliation:** exchange oracle is `immutable`, no setter → **display only**. Adapters (Chainlink/Pyth/Aggregator) live on **Base Sepolia** in `BASE_SEPOLIA_ORACLE_SHOWCASE`. All expose `getPrice(bytes32)→(uint256,uint256)`.

**Read first:** open `AdminOraclePage.tsx` to see how it currently reads MockOracle and lays out its table, and reuse `MockOracleABI` (same signature works for the adapters).

- [ ] **Step 1: Build the comparison read**

Add a panel that, when `chainId === 84532`, reads each asset's price from MockOracle and from the three showcase adapters using the shared `getPrice` ABI:

```tsx
import { Contract } from 'ethers';
import MockOracleABI from 'src/contracts/abi/MockOracle.json';
import { ASSET_IDS, BASE_SEPOLIA_ORACLE_SHOWCASE } from 'src/contracts/addresses';

// inside component (contracts + wallet already available):
const [cmp, setCmp] = useState<Record<string, { mock: number; chainlink: number; pyth: number }>>({});

useEffect(() => {
  (async () => {
    if (!contracts || wallet.chainId !== 84532) return;
    const runner = contracts.oracle.runner;
    const cl = new Contract(BASE_SEPOLIA_ORACLE_SHOWCASE.ChainlinkAdapter, MockOracleABI, runner);
    const py = new Contract(BASE_SEPOLIA_ORACLE_SHOWCASE.PythAdapter, MockOracleABI, runner);
    const rows: typeof cmp = {};
    for (const [sym, id] of Object.entries(ASSET_IDS)) {
      const read = async (c: Contract) => { try { const [p] = await c.getPrice(id); return Number(p) / 1e8; } catch { return 0; } };
      rows[sym] = { mock: await read(contracts.oracle), chainlink: await read(cl), pyth: await read(py) };
    }
    setCmp(rows);
  })();
}, [contracts, wallet.chainId]);
```

- [ ] **Step 2: Render the panel + honest caption**

Render a table (asset | MockOracle | Chainlink | Pyth) from `cmp`, with a heading and this note:

```tsx
<Alert severity="info" sx={{ mb: 2 }}>
  交易引擎目前使用 MockOracle（由 keeper 從真實市場抓價寫入）。Chainlink / Pyth
  adapter 已部署並可即時查詢（如下），整合進交易引擎列為下一階段。
</Alert>
```

Only show the adapter columns on Base Sepolia (`wallet.chainId === 84532`); on other chains show MockOracle only with a note that adapters are Base-Sepolia-only.

- [ ] **Step 3: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/pepefi/AdminOraclePage.tsx
git commit -m "feat(oracle): read-only 3-source (Mock/Chainlink/Pyth) comparison panel"
```

---

### Task 16: PaperTradingBadge + placements + Landing explainer (Phase 6)

**Files:**
- Create: `frontend/src/components/pepefi/PaperTradingBadge.tsx`
- Modify: `frontend/src/layouts/dashboard/` header component (locate below)
- Modify: `frontend/src/pages/pepefi/ExchangePage.tsx`, `TradeTerminalPage.tsx`, `LandingPage.tsx`

**Interfaces:**
- Produces: default-exported `<PaperTradingBadge />` (MUI Chip, `color="warning"`, `size="small"`, info icon, tooltip).

- [ ] **Step 1: Write the badge**

Create `frontend/src/components/pepefi/PaperTradingBadge.tsx`:

```tsx
import { Chip, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export default function PaperTradingBadge() {
  return (
    <Tooltip
      arrow
      title="本平台運行於 Sepolia 測試網，所有資產與資金皆為模擬，不涉及真實金錢。等同 TradingView 的 Paper Trading 模式。"
    >
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        icon={<InfoOutlinedIcon fontSize="small" />}
        label="PAPER TRADING · 測試網模擬交易"
      />
    </Tooltip>
  );
}
```

Verify the icon import path matches the project's MUI icons usage: `grep -rn "@mui/icons-material" frontend/src | head -1`. If the project uses `iconify` instead, swap the icon to the project's `Iconify` component.

- [ ] **Step 2: Mount in the dashboard header (always visible)**

Run: `grep -rln "AccountDrawer\|HeaderSection\|Searchbar\|<LayoutSection\|headerSlotProps" frontend/src/layouts/dashboard/` to find the header layout file. In that header's right-slot (near the account/wallet button), render `<PaperTradingBadge />`. Match existing slot composition; don't restructure the header.

- [ ] **Step 3: Place on ExchangePage, TradeTerminalPage, LandingPage**

- ExchangePage: render `<PaperTradingBadge />` directly above the open-position/margin card.
- TradeTerminalPage: render at the very top of the page body.
- LandingPage: render in the hero, just below the headline.

- [ ] **Step 4: Landing "什麼是 Paper Trading？" explainer**

In `LandingPage.tsx` (in the simple-mode section), add a block:

```tsx
<Box sx={{ py: 6, textAlign: 'center' }}>
  <Typography variant="h4" gutterBottom>什麼是 Paper Trading？</Typography>
  <Typography variant="body1" sx={{ maxWidth: 680, mx: 'auto', color: 'text.secondary' }}>
    本平台使用測試網代幣進行模擬交易，讓使用者無風險體驗 RWA 投資、社交跟單與
    AI 代理交易。所有價格追蹤真實市場，但資金為模擬資產。
  </Typography>
</Box>
```

Match LandingPage's existing "simple mode" conditional wrapper if one exists.

- [ ] **Step 5: Build**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/pepefi/PaperTradingBadge.tsx frontend/src/layouts/dashboard frontend/src/pages/pepefi/ExchangePage.tsx frontend/src/pages/pepefi/TradeTerminalPage.tsx frontend/src/pages/pepefi/LandingPage.tsx
git commit -m "feat(ui): paper trading mode badge and explainer"
```

---

### Task 17: Final verification, guardrail check, push (Phase 7)

**Files:** none (verification + git)

- [ ] **Step 1: Contracts gate**

Run: `cd contracts && forge build && forge test`
Expected: 0 build errors, all tests green.

- [ ] **Step 2: Frontend gate**

Run: `cd frontend && yarn build`
Expected: 0 errors.

- [ ] **Step 3: GUARDRAIL — no existing .sol modified**

Run: `git diff --name-only main -- contracts/src | sort` then cross-check against the allowed NEW files only: `MockUSDT.sol`, `SyntheticAsset.sol`, `AssetVault.sol`.
Expected: ONLY those three appear. If any pre-existing `.sol` shows up as modified → **STOP, revert that file, report**. Do not push.

- [ ] **Step 4: GUARDRAIL — diff surface**

Run: `git diff --name-only main | sort`
Expected: only `frontend/**`, the listed new `contracts/{src,test,script}` files, `.github/workflows/price-keeper.yml`, `scripts/priceKeeper.ts`. No `broadcast/`, no `.env`, no `docs/superpowers/**` staged. If `docs/` plan appears staged, unstage it.

- [ ] **Step 5: Push**

Confirmed in Task 0: **direct push to `main`.**

```bash
git checkout main && git merge --no-ff feat/professor-requirements
git push origin main
```

Only after Steps 1–4 are all green. If Step 3 or 4 flags anything, STOP and report instead of pushing.

---

### Task 18: Emit deploy instructions & summary (do NOT execute)

**Files:** none (print only)

- [ ] **Step 1: Print the user-run deploy commands**

Print (do not run) the block below; the user runs it and returns the addresses so `addresses.ts` (`MockUSDT`, `AssetVault`, `SYNTH_TOKENS`) can be filled:

```bash
cd contracts
set -a && source .env && set +a

# 1. Deploy MockUSDT
forge create src/MockUSDT.sol:MockUSDT \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast

# 2. Deploy AssetVault + 11 SyntheticAssets (env-driven)
MOCKUSDC_ADDR=0x167Bacef1925184f0df34A3196F834C0622Cfd36 \
MOCKORACLE_ADDR=0x17CA20A37Cf04F2f589B2573EC95f1411D29d958 \
forge script script/DeploySyntheticAssets.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" \
  --broadcast --skip-simulation --slow -v

# 3. Fund AssetVault so users can redeem (approve then fund)
cast send 0x167Bacef1925184f0df34A3196F834C0622Cfd36 "approve(address,uint256)" <VAULT_ADDR> 1000000000000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"
cast send <VAULT_ADDR> "fundVault(uint256)" 1000000000000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"
```

(Sepolia MockUSDC/MockOracle addresses pre-filled from `addresses.ts`. The `DeploySyntheticAssets.s.sol` reads `MOCKUSDC_ADDR`/`MOCKORACLE_ADDR` from env.)

- [ ] **Step 2: Print the summary**

Print: per-Phase what was done; the Phase 5A finding (**`PerpetualExchange.oracle` is `immutable`, no setter → oracle NOT switchable without redeploy → 做法 B, read-only panel**); the spec-drift notes (Phase 1 mostly pre-done, Phase 4 already scheduled on `main`, keeper uses Binance not CoinGecko, ExchangePage already showed "USDT"); required GitHub secrets (`KEEPER_RPC_URL`, `KEEPER_PRIVATE_KEY`); and the addresses still to fill after deploy.

---

## Self-Review

**1. Spec coverage:**
- Phase 1 → Task 1 ✅ (plus verified pre-existing wiring).
- Phase 2 (MockUSDT contract/test/script) → Task 2 ✅; (addresses/useContracts) → Task 7 ✅; (stablecoin.ts/useStablecoin) → Task 8 ✅; (ExchangePage toggle/faucet/note) → Task 9 ✅; (TradeTerminal) → Task 10 ✅; (Home/Dashboard USDT faucet) → Task 12 ✅.
- Phase 3 (SyntheticAsset) → Task 3 ✅; (AssetVault + tests) → Task 4 ✅; (deploy script) → Task 5 ✅; (ABIs) → Task 6 ✅; (addresses/SYNTH_TOKENS) → Task 7 ✅; (TokenizedAssetsPage + route + nav) → Task 11 ✅; (ExchangePage hint) → Task 9 Step 5 ✅.
- Phase 4 → Task 13 ✅.
- Phase 5A investigation → resolved during planning (immutable oracle) and reported in Task 18; Phase 5B/5C panel → Task 15 ✅; Phase 5D Coinbase → Task 14 ✅; `useLivePrices` check → covered by Reconciliation (front-end reads on-chain oracle; verify in Task 15 read-first — **add a quick grep of `useLivePrices.ts` to confirm it reads chain oracle, not a browser CoinGecko fetch; if it fetches CoinGecko directly, switch it to read `contracts.oracle.getPrice`**).
- Phase 6 → Task 16 ✅.
- Phase 7 → Tasks 17–18 ✅.

**2. Placeholder scan:** No "TBD"/"add error handling"/"write tests for the above". Every code step carries real code. UI-integration steps that depend on an existing file's idioms include an explicit "read first" pointer plus the concrete snippet to insert — deliberate, not a placeholder.

**3. Type consistency:** `getStable/setStable/stableLabel/Stable` consistent across Task 8 lib and hook. `useStablecoin` returns `{stable,setStable,token}` per spec. AssetVault: `mint/redeem/previewMint/previewRedeem/registerAsset/fundVault/assetToken` names identical across Task 4 contract, Task 5 script, and Task 11 page. `SyntheticAsset.mint/burn/assetId/vault` consistent Task 3↔4↔11. `getSynthTokens/SYNTH_TOKENS/AssetVault field` consistent Task 7↔11. `paths.pepefi.tokens` defined Task 11 Step 1, consumed Task 9 Step 5 and Task 11 Step 3.

**Open decision for the user (surfaced in Task 0):** which branch is the build base and whether to push straight to `main` or via PR.
