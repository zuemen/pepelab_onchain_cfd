# P1: AssetVault V2 — Upgradeable, Solvency-Aware, Institution-Configurable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tokenized-asset layer with a UUPS-upgradeable V2 that closes the three proven vulnerabilities (unbounded counterparty exposure, bank-run drain, missing staleness check) and exposes the risk knobs a licensed institution needs to operate it under its own compliance regime.

**Architecture:** `SyntheticAssetV2` swaps the immutable `vault` for a role-gated mutable minter, so the vault can be upgraded or replaced without re-deploying the 11 tokens. `AssetVaultV2` sits behind a UUPS proxy and adds: oracle staleness rejection, mint/redeem fees that accrue a solvency buffer, a per-asset exposure cap, a minimum reserve-ratio gate that blocks new mints before the reserve can be drained, and pause + role separation (admin / risk / pauser). V1 contracts are left untouched and stay deployed on Sepolia for side-by-side comparison.

**Tech Stack:** Foundry (Solidity ^0.8.20, `via_ir=true`, optimizer 200), OpenZeppelin Contracts + **openzeppelin-contracts-upgradeable** (new dependency), UUPS proxy pattern, `forge test`.

## Global Constraints

- **NEVER modify any existing `.sol` file.** Every change here is a new file. V1 (`AssetVault.sol`, `SyntheticAsset.sol`) stays byte-identical and stays deployed.
- **NEVER redeploy existing contracts.** V2 deploys alongside; V1's Sepolia vault (`0xB4D10cBC6143E410dd7b48797334C4397b99325f`, funded 1,000,000 mUSDC) and its 11 tokens keep working.
- **Commercial path is B2B white-label.** The operator is a *licensed institution*, not us and not retail. Every risk parameter must therefore be operator-configurable at runtime, not hardcoded — an institution's risk committee sets these, we don't.
- **This plan does not make the platform legal to operate for retail.** It is engineering hardening. Securities-referenced assets (sAAPL/sTSLA/sNVDA/sMSFT/sGOOGL/sBOND) remain the licensee's regulatory responsibility. Do not add copy claiming compliance, suitability, or investor protection that the code does not deliver.
- Oracle prices are **8 decimals**; `getPrice(bytes32)` returns **two** values `(uint256 price, uint256 updatedAt)`. USDC and all synthetic tokens are **18 decimals**.
- Gate per task: `forge build` + `forge test` → 0 errors, all green. Frontend untouched in P1 (it is P3's scope), so no `yarn build` gate here except Task 8.
- Deployment commands are **printed for the user, never executed**.

---

## The three vulnerabilities being fixed

Each is already proven by a passing test in `contracts/test/AssetVaultSolvency.t.sol` (committed `1981968`). Read that file first — it is the specification for what must change.

1. **Unbounded counterparty exposure.** `AssetVault` is the counterparty to every long. `redeem` pays `tokenAmount * currentPrice / 1e8` from a shared reserve, with no fee, spread, or cap. A rising market drains the operator's reserve. Proven by `test_priceRiseDrainsOwnerReserve`.
2. **Bank-run ordering.** Once drained, later holders cannot exit despite holding value. First-out wins. Proven by `test_laterRedeemerCannotExitAfterDrain`.
3. **No staleness check.** `_price()` reads `updatedAt` and discards it. `PerpetualExchange` reverts `StalePrice` past `maxPriceAge`; the vault accepts a price a year old. Proven by `test_mintAcceptsArbitrarilyStalePrice`.

**Design response.** Fees + exposure cap + reserve-ratio gate cannot make an uncollateralized counterparty risk-free — that is a property of the mint-burn model, not a bug to patch away. What they do is make the exposure **bounded, priced, and visible**: the operator chooses how much risk to carry, earns fees for carrying it, and new mints stop before the reserve is gone rather than after. State this honestly in the docs; do not describe V2 as "fully collateralized", because it is not.

---

## File Structure

**New contracts:**
- `contracts/src/v2/SyntheticAssetV2.sol` — ERC-20 with a role-gated, *mutable* minter set. One responsibility: the token itself.
- `contracts/src/v2/AssetVaultV2.sol` — UUPS-upgradeable mint/redeem vault with risk controls. One responsibility: pricing, exposure, and reserve accounting.
- `contracts/src/v2/IAssetVaultV2.sol` — the external interface an integrating institution codes against (also what P3's SDK mirrors).

**New tests:**
- `contracts/test/v2/SyntheticAssetV2.t.sol` — minter role mechanics.
- `contracts/test/v2/AssetVaultV2Fees.t.sol` — fee math and buffer accrual.
- `contracts/test/v2/AssetVaultV2Risk.t.sol` — staleness, exposure cap, reserve gate, pause.
- `contracts/test/v2/AssetVaultV2Upgrade.t.sol` — proxy upgrade preserves state.
- `contracts/test/v2/AssetVaultV2Parity.t.sol` — V2 reproduces V1's happy-path math exactly (so the demo story doesn't change).

**New script:**
- `contracts/script/DeployAssetVaultV2.s.sol` — proxy + implementation + 11 V2 tokens + wiring.

**Modified (non-`.sol`):**
- `contracts/foundry.toml` — add the upgradeable remapping.
- `.gitmodules` / `lib/` — new dependency.
- `docs/RISK_MODEL.md` (new) — honest description of the residual risk, for the licensee's risk committee.

---

### Task 1: Install openzeppelin-contracts-upgradeable

**Files:**
- Modify: `contracts/foundry.toml:8-11` (remappings array)
- Add: `contracts/lib/openzeppelin-contracts-upgradeable/` (submodule)

**Interfaces:**
- Produces: the import path `@openzeppelin/contracts-upgradeable/` resolving, so later tasks can import `UUPSUpgradeable`, `Initializable`, `AccessControlUpgradeable`, `PausableUpgradeable`.

- [ ] **Step 1: Confirm the installed OZ version (already verified: 5.6.1)**

Run: `cd contracts && grep '"version"' lib/openzeppelin-contracts/package.json | head -1`
Expected: `"version": "5.6.1"`. Verified 2026-07-26. If it differs, use whatever it reports as the tag in Step 2 — the upgradeable package must match the base package's minor version or the two will not compile together.

Also already verified: `ERC1967Proxy` lives in the **non-upgradeable** package at
`lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol`, which is where every task imports it from. Do not look for it in the upgradeable package.

- [ ] **Step 2: Install the matching upgradeable package**

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.6.1 --no-commit
```

- [ ] **Step 3: Add the remapping**

In `contracts/foundry.toml`, extend the `remappings` array to:

```toml
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
    "forge-std/=lib/forge-std/src/",
]
```

- [ ] **Step 4: Verify it resolves**

Create a scratch file `contracts/src/v2/_ResolveCheck.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

// Compile-only check that the remapping resolves. Deleted in Step 6.
abstract contract _ResolveCheck is UUPSUpgradeable, AccessControlUpgradeable, PausableUpgradeable {}
```

Run: `cd contracts && forge build 2>&1 | grep -icE "^error|compiler run failed"`
Expected: `0`

- [ ] **Step 5: Confirm the existing suite still builds and passes**

Run: `cd contracts && forge test 2>&1 | tail -2`
Expected: `358 tests passed, 0 failed` (355 from before + 3 solvency tests).

- [ ] **Step 6: Delete the scratch file and commit**

```bash
cd contracts && rm src/v2/_ResolveCheck.sol && forge build --quiet
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/foundry.toml contracts/.gitmodules contracts/lib/openzeppelin-contracts-upgradeable
git commit -m "build(contracts): add openzeppelin-contracts-upgradeable for V2 proxy work"
```

If `.gitmodules` lives at the repo root instead, adjust the path — check with `git status --short` before committing.

---

### Task 2: SyntheticAssetV2 with a mutable minter role

**Files:**
- Create: `contracts/src/v2/SyntheticAssetV2.sol`
- Test: `contracts/test/v2/SyntheticAssetV2.t.sol`

**Interfaces:**
- Produces: `SyntheticAssetV2(string name_, string symbol_, bytes32 assetId_, address admin_)`; `MINTER_ROLE` (bytes32 constant); `mint(address,uint256)` / `burn(address,uint256)` gated by `onlyRole(MINTER_ROLE)`; `assetId() view returns (bytes32)`; standard `AccessControl` surface (`grantRole`, `revokeRole`, `hasRole`, `DEFAULT_ADMIN_ROLE`).
- **Why this differs from V1:** V1's `vault` is `immutable`, so replacing the vault orphans all 11 tokens and every user balance. V2 makes the minter a revocable role, so a vault upgrade or migration is a `grantRole`/`revokeRole` — no token redeploy, no user impact.

Note: this token is *not* upgradeable and does not need to be. Its logic is fixed; only the authority over it must be changeable. Keeping it non-proxied means holders' balances live in a plain, auditable ERC-20.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/v2/SyntheticAssetV2.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/SyntheticAssetV2.sol";

contract SyntheticAssetV2Test is Test {
    SyntheticAssetV2 token;
    address admin    = makeAddr("admin");
    address vaultOld = makeAddr("vaultOld");
    address vaultNew = makeAddr("vaultNew");
    address alice    = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        vm.prank(admin);
        token.grantRole(token.MINTER_ROLE(), vaultOld);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Synthetic Apple");
        assertEq(token.symbol(), "sAAPL");
        assertEq(token.decimals(), 18);
        assertEq(token.assetId(), AID);
    }

    function test_minterCanMintAndBurn() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);
        assertEq(token.balanceOf(alice), 10e18);

        vm.prank(vaultOld);
        token.burn(alice, 4e18);
        assertEq(token.balanceOf(alice), 6e18);
    }

    function test_nonMinterCannotMint() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    /// @dev The whole reason V2 exists: swapping the vault must not require
    ///      redeploying the token or touching holder balances.
    function test_vaultCanBeRotatedWithoutRedeploy() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);

        vm.startPrank(admin);
        token.revokeRole(token.MINTER_ROLE(), vaultOld);
        token.grantRole(token.MINTER_ROLE(), vaultNew);
        vm.stopPrank();

        // old vault is now powerless
        vm.prank(vaultOld);
        vm.expectRevert();
        token.mint(alice, 1e18);

        // new vault works, balance preserved
        vm.prank(vaultNew);
        token.mint(alice, 5e18);
        assertEq(token.balanceOf(alice), 15e18);
    }

    function test_onlyAdminCanGrantMinter() public {
        vm.prank(alice);
        vm.expectRevert();
        token.grantRole(token.MINTER_ROLE(), alice);
    }

    function test_holderCanTransfer() public {
        vm.prank(vaultOld);
        token.mint(alice, 10e18);
        address bob = makeAddr("bob");
        vm.prank(alice);
        token.transfer(bob, 4e18);
        assertEq(token.balanceOf(bob), 4e18);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract SyntheticAssetV2Test`
Expected: FAIL — `Source "src/v2/SyntheticAssetV2.sol" not found`.

- [ ] **Step 3: Write the implementation**

Create `contracts/src/v2/SyntheticAssetV2.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice ERC-20 representing one synthetic asset, held directly in the user's
///         wallet (addable to MetaMask via EIP-747, transferable).
///
///         V2 change vs SyntheticAsset: the minter is a revocable ROLE, not an
///         immutable address. V1 hardcoded the vault, so replacing the vault
///         would have orphaned every token and every holder balance. Here a
///         vault upgrade is grantRole/revokeRole — no redeploy, no user impact.
///
///         Deliberately NOT upgradeable: the token's logic is fixed and holder
///         balances should live in a plain, auditable ERC-20. Only the authority
///         over minting needs to be mutable.
contract SyntheticAssetV2 is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice keccak256 of the symbol — matches the oracle asset id, so the
    ///         frontend can resolve a price from the token alone.
    bytes32 public immutable assetId;

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 assetId_,
        address admin_
    ) ERC20(name_, symbol_) {
        require(admin_ != address(0), "zero admin");
        assetId = assetId_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts && forge test --match-contract SyntheticAssetV2Test -vv`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/src/v2/SyntheticAssetV2.sol contracts/test/v2/SyntheticAssetV2.t.sol
git commit -m "feat(v2): SyntheticAssetV2 with revocable minter role

V1 hardcoded the vault as immutable, so replacing the vault would orphan all 11
tokens and every holder balance. V2 makes minting a revocable role, so a vault
upgrade is grantRole/revokeRole with no redeploy and no user impact.

Deliberately not proxied — the token logic is fixed, and holder balances belong
in a plain auditable ERC-20."
```

---

### Task 3: AssetVaultV2 skeleton — UUPS proxy + roles + initializer

**Files:**
- Create: `contracts/src/v2/IAssetVaultV2.sol`
- Create: `contracts/src/v2/AssetVaultV2.sol`
- Test: `contracts/test/v2/AssetVaultV2Upgrade.t.sol`

**Interfaces:**
- Consumes: `SyntheticAssetV2` (Task 2) — specifically `MINTER_ROLE`, `mint`, `burn`, `assetId`.
- Produces:
  - `initialize(address usdc_, address oracle_, address admin_)` — replaces the constructor under UUPS.
  - Roles: `RISK_ROLE` (sets risk params), `PAUSER_ROLE` (pause/unpause), `DEFAULT_ADMIN_ROLE` (upgrade authority).
  - `usdc() view returns (address)`, `oracle() view returns (address)`, `version() view returns (string)`.
  - `registerAsset(bytes32 assetId, address token)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.
  - `assetToken(bytes32) view returns (address)`.
  - `_authorizeUpgrade(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.
- Note: mint/redeem/fees/risk land in Tasks 4–6. This task establishes the proxy and proves upgrade preserves state, because getting that wrong later is expensive.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/v2/AssetVaultV2Upgrade.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @dev A trivial V3 used only to prove the upgrade path preserves storage.
contract AssetVaultV3Probe is AssetVaultV2 {
    function version() public pure override returns (string memory) {
        return "3.0.0-probe";
    }
}

contract AssetVaultV2UpgradeTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        bytes memory init = abi.encodeCall(
            AssetVaultV2.initialize, (address(usdc), address(oracle), admin)
        );
        vault = AssetVaultV2(address(new ERC1967Proxy(address(impl), init)));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        vm.startPrank(admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        vault.registerAsset(AID, address(aapl));
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);
    }

    function test_initializedState() public view {
        assertEq(vault.usdc(), address(usdc));
        assertEq(vault.oracle(), address(oracle));
        assertEq(vault.assetToken(AID), address(aapl));
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(vault.version(), "2.0.0");
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert();
        vault.initialize(address(usdc), address(oracle), admin);
    }

    function test_onlyAdminCanUpgrade() public {
        AssetVaultV3Probe next = new AssetVaultV3Probe();
        vm.prank(alice);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
    }

    /// @dev The point of the proxy: fixing a bug must not lose registrations or
    ///      reserves. If this ever fails, the upgrade path is unsafe.
    function test_upgradePreservesState() public {
        usdc.mint(address(vault), 5_000e18);   // simulate an existing reserve

        AssetVaultV3Probe next = new AssetVaultV3Probe();
        vm.prank(admin);
        vault.upgradeToAndCall(address(next), "");

        assertEq(vault.version(), "3.0.0-probe");
        assertEq(vault.assetToken(AID), address(aapl));      // registration kept
        assertEq(usdc.balanceOf(address(vault)), 5_000e18);  // reserve kept
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_onlyAdminCanRegisterAsset() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.registerAsset(keccak256("sX"), address(0xdead));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract AssetVaultV2UpgradeTest`
Expected: FAIL — `Source "src/v2/AssetVaultV2.sol" not found`.

- [ ] **Step 3: Write the interface**

Create `contracts/src/v2/IAssetVaultV2.sol`. This is the surface an integrating institution codes against, and what P3's SDK mirrors:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Integration surface for AssetVaultV2. Institutions code against this.
interface IAssetVaultV2 {
    // ── views ────────────────────────────────────────────────────────────────
    function usdc() external view returns (address);
    function oracle() external view returns (address);
    function version() external view returns (string memory);
    function assetToken(bytes32 assetId) external view returns (address);

    function previewMint(bytes32 assetId, uint256 usdcAmount)
        external view returns (uint256 tokenOut, uint256 feePaid);
    function previewRedeem(bytes32 assetId, uint256 tokenAmount)
        external view returns (uint256 usdcOut, uint256 feePaid);

    function reserve() external view returns (uint256);
    function outstandingValue() external view returns (uint256);
    function reserveRatioBps() external view returns (uint256);
    function exposureOf(bytes32 assetId) external view returns (uint256);

    // ── user actions ─────────────────────────────────────────────────────────
    function mint(bytes32 assetId, uint256 usdcAmount) external returns (uint256 tokenOut);
    function redeem(bytes32 assetId, uint256 tokenAmount) external returns (uint256 usdcOut);

    // ── operator actions ─────────────────────────────────────────────────────
    function fundVault(uint256 usdcAmount) external;
    function withdrawFees(address to, uint256 amount) external;

    // ── events ───────────────────────────────────────────────────────────────
    event Minted(address indexed user, bytes32 indexed assetId, uint256 usdcIn, uint256 tokenOut, uint256 fee);
    event Redeemed(address indexed user, bytes32 indexed assetId, uint256 tokenIn, uint256 usdcOut, uint256 fee);
    event AssetRegistered(bytes32 indexed assetId, address token);
    event VaultFunded(address indexed from, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event RiskParamsUpdated(uint256 mintFeeBps, uint256 redeemFeeBps, uint256 minReserveRatioBps, uint256 maxPriceAge);
    event AssetCapUpdated(bytes32 indexed assetId, uint256 cap);
}
```

- [ ] **Step 4: Write the vault skeleton**

Create `contracts/src/v2/AssetVaultV2.sol`. Storage layout order matters permanently under UUPS — never reorder or remove these fields in a future version, only append:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./SyntheticAssetV2.sol";
import "./IAssetVaultV2.sol";

interface IAssetOracleV2 {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice Upgradeable mint/redeem vault for tokenized synthetic assets.
///
///         Honest description of the risk model: the vault is the counterparty
///         to every long. It is NOT fully collateralized and this contract does
///         not make it so — that is a property of the mint-burn design. What it
///         does is make the exposure bounded, priced, and observable:
///           - fees accrue a buffer and pay the operator for carrying risk
///           - a per-asset cap bounds exposure to any single market
///           - a minimum reserve ratio stops new mints BEFORE the reserve is
///             gone, instead of discovering it when a redeemer is denied
///           - pause gives the operator a kill switch
///
///         Risk parameters are operator-configurable because the operator is a
///         licensed institution whose risk committee — not this code — decides
///         acceptable exposure. See docs/RISK_MODEL.md.
contract AssetVaultV2 is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    IAssetVaultV2
{
    bytes32 public constant RISK_ROLE   = keccak256("RISK_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS_DENOM = 10_000;

    // ── storage — APPEND ONLY, never reorder (UUPS) ──────────────────────────
    address private _usdc;
    address private _oracle;

    mapping(bytes32 => address) private _assetToken;

    /// @notice USDC set aside as collected fees; excluded from the payout reserve.
    uint256 public accruedFees;

    /// @notice Token units outstanding per asset, used for the exposure cap.
    mapping(bytes32 => uint256) private _outstanding;

    /// @notice Max token units mintable per asset. 0 = asset closed to new mints.
    mapping(bytes32 => uint256) public assetCap;

    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    uint256 public minReserveRatioBps;
    uint256 public maxPriceAge;

    /// @notice Asset ids ever registered, so ratio math can iterate them.
    bytes32[] private _assetIds;

    // ── errors ───────────────────────────────────────────────────────────────
    error StalePrice(bytes32 assetId, uint256 updatedAt);
    error NoPrice(bytes32 assetId);
    error AssetNotRegistered(bytes32 assetId);
    error ZeroAmount();
    error CapExceeded(bytes32 assetId, uint256 outstanding, uint256 cap);
    error ReserveRatioTooLow(uint256 ratioBps, uint256 minBps);
    error VaultDry(uint256 needed, uint256 available);
    error InvalidParam();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address usdc_, address oracle_, address admin_) public initializer {
        if (usdc_ == address(0) || oracle_ == address(0) || admin_ == address(0)) revert InvalidParam();

        __UUPSUpgradeable_init();
        __AccessControl_init();
        __Pausable_init();

        _usdc   = usdc_;
        _oracle = oracle_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(RISK_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);

        // Conservative defaults. The operator's risk committee overrides these.
        mintFeeBps         = 30;      // 0.30%
        redeemFeeBps       = 30;      // 0.30%
        minReserveRatioBps = 11_000;  // require 110% reserve coverage to mint
        maxPriceAge        = 1 hours; // matches keeper cadence with headroom
    }

    function version() public pure virtual returns (string memory) {
        return "2.0.0";
    }

    function usdc() public view returns (address) { return _usdc; }
    function oracle() public view returns (address) { return _oracle; }
    function assetToken(bytes32 assetId) public view returns (address) { return _assetToken[assetId]; }
    function exposureOf(bytes32 assetId) public view returns (uint256) { return _outstanding[assetId]; }

    function registerAsset(bytes32 assetId, address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidParam();
        if (_assetToken[assetId] == address(0)) _assetIds.push(assetId);
        _assetToken[assetId] = token;
        emit AssetRegistered(assetId, token);
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // Tasks 4–6 add: _price, previewMint/previewRedeem, mint, redeem,
    // reserve/outstandingValue/reserveRatioBps, fundVault, withdrawFees,
    // setRiskParams, setAssetCap.
}
```

- [ ] **Step 5: Add temporary stubs so the interface compiles**

`AssetVaultV2` declares `IAssetVaultV2` but Tasks 4–6 supply most of it. Append these stubs inside the contract so Task 3 compiles; each is replaced by a real implementation in a later task:

```solidity
    // ── temporary stubs — replaced in Tasks 4–6 ──────────────────────────────
    function previewMint(bytes32, uint256) public view virtual returns (uint256, uint256) { revert InvalidParam(); }
    function previewRedeem(bytes32, uint256) public view virtual returns (uint256, uint256) { revert InvalidParam(); }
    function reserve() public view virtual returns (uint256) { return 0; }
    function outstandingValue() public view virtual returns (uint256) { return 0; }
    function reserveRatioBps() public view virtual returns (uint256) { return 0; }
    function mint(bytes32, uint256) external virtual returns (uint256) { revert InvalidParam(); }
    function redeem(bytes32, uint256) external virtual returns (uint256) { revert InvalidParam(); }
    function fundVault(uint256) external virtual { revert InvalidParam(); }
    function withdrawFees(address, uint256) external virtual { revert InvalidParam(); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract AssetVaultV2UpgradeTest -vv`
Expected: PASS (5 tests). If `upgradeToAndCall` is not found, the OZ 5 UUPS API is in use and the call is correct — check instead that `ERC1967Proxy` imported from `@openzeppelin/contracts/proxy/ERC1967/` (non-upgradeable package) which is where OZ 5 keeps it.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/src/v2/AssetVaultV2.sol contracts/src/v2/IAssetVaultV2.sol contracts/test/v2/AssetVaultV2Upgrade.t.sol
git commit -m "feat(v2): AssetVaultV2 UUPS skeleton with role separation

Establishes the proxy and proves an upgrade preserves registrations, reserve,
and roles before any business logic depends on it. Roles are split admin/risk/
pauser because the operator is a licensed institution where upgrade authority
and risk-parameter authority belong to different people.

Storage is append-only by contract — documented in the layout comment."
```

---

### Task 4: Staleness rejection and fee-aware previews

**Files:**
- Modify: `contracts/src/v2/AssetVaultV2.sol` (replace the `previewMint`/`previewRedeem` stubs, add `_price`)
- Test: `contracts/test/v2/AssetVaultV2Fees.t.sol`

**Interfaces:**
- Consumes: `maxPriceAge`, `mintFeeBps`, `redeemFeeBps`, `BPS_DENOM` (Task 3).
- Produces:
  - `previewMint(bytes32, uint256 usdcAmount) view returns (uint256 tokenOut, uint256 feePaid)` — fee taken off the USDC input, remainder converted at oracle price.
  - `previewRedeem(bytes32, uint256 tokenAmount) view returns (uint256 usdcOut, uint256 feePaid)` — gross USDC computed at oracle price, fee deducted, `usdcOut` is net to user.
  - `_price(bytes32) internal view returns (uint256)` — reverts `NoPrice` on zero and `StalePrice` past `maxPriceAge`. **This is vulnerability #3's fix.**
- Decimal math (unchanged from V1 so the demo numbers stay familiar): `tokenOut = netUsdc * 1e8 / price`; `grossUsdc = tokenAmount * price / 1e8`.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/v2/AssetVaultV2Fees.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

contract AssetVaultV2FeesTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        vm.startPrank(admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        vault.registerAsset(AID, address(aapl));
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);   // $200
    }

    /// @dev 0.30% of 2000 = 6 USDC fee; 1994 / 200 = 9.97 sAAPL.
    function test_previewMintDeductsFee() public view {
        (uint256 tokenOut, uint256 fee) = vault.previewMint(AID, 2_000e18);
        assertEq(fee, 6e18);
        assertEq(tokenOut, 1_994e18 * 1e8 / 200e8);
        assertEq(tokenOut, 9.97e18);
    }

    /// @dev 10 sAAPL * $200 = 2000 gross; 0.30% = 6 fee; 1994 net out.
    function test_previewRedeemDeductsFee() public view {
        (uint256 usdcOut, uint256 fee) = vault.previewRedeem(AID, 10e18);
        assertEq(fee, 6e18);
        assertEq(usdcOut, 1_994e18);
    }

    function test_zeroFeeMatchesV1Math() public {
        vm.prank(admin);
        vault.setRiskParams(0, 0, 11_000, 1 hours);

        (uint256 tokenOut, uint256 fee) = vault.previewMint(AID, 2_000e18);
        assertEq(fee, 0);
        assertEq(tokenOut, 10e18);      // identical to V1
    }

    /// @dev VULNERABILITY #3 FIX. V1 accepted a price of any age.
    function test_previewRevertsOnStalePrice() public {
        vm.warp(block.timestamp + 2 hours);   // maxPriceAge is 1 hour
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.StalePrice.selector, AID, 1));
        vault.previewMint(AID, 1_000e18);
    }

    function test_previewSucceedsJustInsideMaxAge() public {
        vm.warp(block.timestamp + 59 minutes);
        (uint256 tokenOut, ) = vault.previewMint(AID, 2_000e18);
        assertGt(tokenOut, 0);
    }

    function test_previewRevertsWhenAssetNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.AssetNotRegistered.selector, keccak256("sX")));
        vault.previewMint(keccak256("sX"), 1_000e18);
    }
}
```

The `StalePrice` selector's `updatedAt` is `1` because Foundry starts `block.timestamp` at 1 and `addAsset` records that. If your Foundry version starts elsewhere, capture the value with `oracle.getPrice(AID)` in the test rather than hardcoding.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract AssetVaultV2FeesTest`
Expected: FAIL — `setRiskParams` undefined and previews revert `InvalidParam` (the Task 3 stubs).

- [ ] **Step 3: Replace the preview stubs and add `_price` + `setRiskParams`**

In `contracts/src/v2/AssetVaultV2.sol`, delete the `previewMint`, `previewRedeem` stub lines and add:

```solidity
    /// @dev VULNERABILITY #3 FIX: V1 read updatedAt and discarded it, so a dead
    ///      keeper meant trading against a frozen quote. PerpetualExchange has
    ///      always reverted StalePrice past maxPriceAge; this now matches it.
    function _price(bytes32 assetId) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = IAssetOracleV2(_oracle).getPrice(assetId);
        if (price == 0) revert NoPrice(assetId);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(assetId, updatedAt);
    }

    function previewMint(bytes32 assetId, uint256 usdcAmount)
        public view returns (uint256 tokenOut, uint256 feePaid)
    {
        if (_assetToken[assetId] == address(0)) revert AssetNotRegistered(assetId);
        uint256 price = _price(assetId);
        feePaid  = usdcAmount * mintFeeBps / BPS_DENOM;
        tokenOut = (usdcAmount - feePaid) * 1e8 / price;
    }

    function previewRedeem(bytes32 assetId, uint256 tokenAmount)
        public view returns (uint256 usdcOut, uint256 feePaid)
    {
        if (_assetToken[assetId] == address(0)) revert AssetNotRegistered(assetId);
        uint256 price = _price(assetId);
        uint256 gross = tokenAmount * price / 1e8;
        feePaid = gross * redeemFeeBps / BPS_DENOM;
        usdcOut = gross - feePaid;
    }

    /// @notice Operator risk knobs. Separate RISK_ROLE from upgrade authority so
    ///         a risk committee can retune without holding upgrade power.
    function setRiskParams(
        uint256 mintFeeBps_,
        uint256 redeemFeeBps_,
        uint256 minReserveRatioBps_,
        uint256 maxPriceAge_
    ) external onlyRole(RISK_ROLE) {
        // Cap fees at 10% so a compromised risk key cannot confiscate deposits.
        if (mintFeeBps_ > 1_000 || redeemFeeBps_ > 1_000) revert InvalidParam();
        if (maxPriceAge_ == 0) revert InvalidParam();

        mintFeeBps         = mintFeeBps_;
        redeemFeeBps       = redeemFeeBps_;
        minReserveRatioBps = minReserveRatioBps_;
        maxPriceAge        = maxPriceAge_;

        emit RiskParamsUpdated(mintFeeBps_, redeemFeeBps_, minReserveRatioBps_, maxPriceAge_);
    }
```

Also remove `virtual` from the `previewMint`/`previewRedeem` stub signatures you deleted — the interface no longer needs them overridable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract AssetVaultV2FeesTest -vv`
Expected: PASS (6 tests).

- [ ] **Step 5: Confirm nothing regressed**

Run: `cd contracts && forge test 2>&1 | tail -2`
Expected: all green, count grown by 6.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/src/v2/AssetVaultV2.sol contracts/test/v2/AssetVaultV2Fees.t.sol
git commit -m "feat(v2): reject stale prices, add fee-aware previews

Fixes vulnerability #3: V1 read updatedAt and discarded it, so a dead keeper let
users trade against a frozen quote (the V1 test warps a full year and still
mints). _price now reverts StalePrice past maxPriceAge, matching what
PerpetualExchange has always done.

Fees are the first half of the vulnerability #1 response — they price the
counterparty risk the operator carries. setRiskParams sits behind RISK_ROLE,
separate from upgrade authority, and caps fees at 10% so a compromised risk key
cannot confiscate deposits. Zero fees reproduce V1's math exactly."
```

---

### Task 5: Exposure cap and reserve-ratio gate

**Files:**
- Modify: `contracts/src/v2/AssetVaultV2.sol` (replace reserve/outstanding stubs, add `setAssetCap`)
- Test: `contracts/test/v2/AssetVaultV2Risk.t.sol`

**Interfaces:**
- Consumes: `_price` (Task 4), `_outstanding`, `assetCap`, `minReserveRatioBps`, `accruedFees`, `_assetIds` (Task 3).
- Produces:
  - `reserve() view returns (uint256)` — USDC balance minus `accruedFees` (fees are not payout collateral).
  - `outstandingValue() view returns (uint256)` — Σ over registered assets of `outstanding * price / 1e8`. Skips assets whose price is stale or zero rather than reverting, so risk views stay readable during an oracle outage.
  - `reserveRatioBps() view returns (uint256)` — `reserve * 10000 / outstandingValue`; returns `type(uint256).max` when nothing is outstanding.
  - `setAssetCap(bytes32, uint256)` — `onlyRole(RISK_ROLE)`. **This is vulnerability #1's bound.**
- **This is vulnerability #2's fix:** blocking mints while the ratio is healthy-but-falling prevents the bank-run ordering, because the reserve is never allowed to reach the point where an earlier redeemer strands a later one.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/v2/AssetVaultV2Risk.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

contract AssetVaultV2RiskTest is Test {
    AssetVaultV2     vault;
    MockUSDC         usdc;
    MockOracle       oracle;
    SyntheticAssetV2 aapl;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();

        AssetVaultV2 impl = new AssetVaultV2();
        vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        vm.startPrank(admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        vault.registerAsset(AID, address(aapl));
        vault.setAssetCap(AID, 1_000e18);       // 1000 sAAPL cap
        vault.setRiskParams(0, 0, 11_000, 1 hours);
        vm.stopPrank();

        oracle.addAsset(AID, 200e8);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(admin, 1_000_000e18);
        vm.startPrank(admin);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
        vm.stopPrank();
    }

    function _mintAs(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.mint(AID, amount);
        vm.stopPrank();
    }

    function test_reserveExcludesAccruedFees() public {
        vm.prank(admin);
        vault.setRiskParams(100, 0, 11_000, 1 hours);   // 1% mint fee
        _mintAs(alice, 10_000e18);                       // 100 USDC fee

        assertEq(vault.accruedFees(), 100e18);
        // reserve = 100,000 seeded + 10,000 in - 100 fees
        assertEq(vault.reserve(), 109_900e18);
    }

    function test_outstandingValueTracksPrice() public {
        _mintAs(alice, 2_000e18);                        // 10 sAAPL at $200
        assertEq(vault.exposureOf(AID), 10e18);
        assertEq(vault.outstandingValue(), 2_000e18);

        oracle.updatePrice(AID, 400e8);
        assertEq(vault.outstandingValue(), 4_000e18);    // liability doubled
    }

    /// @dev VULNERABILITY #1 BOUND: exposure to a single market is capped.
    function test_mintRevertsWhenAssetCapExceeded() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.mint(AID, 100_000e18);                     // 500 sAAPL, under cap
        vm.expectRevert(abi.encodeWithSelector(
            AssetVaultV2.CapExceeded.selector, AID, 500e18 + 501e18, 1_000e18
        ));
        vault.mint(AID, 100_200e18);                     // would exceed 1000
        vm.stopPrank();
    }

    function test_capOfZeroClosesAssetToNewMints() public {
        vm.prank(admin);
        vault.setAssetCap(AID, 0);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.CapExceeded.selector, AID, 5e18, 0));
        vault.mint(AID, 1_000e18);
        vm.stopPrank();
    }

    /// @dev VULNERABILITY #2 FIX: mints stop while the reserve can still pay
    ///      everyone, so no redeemer strands a later one.
    function test_mintRevertsWhenReserveRatioTooLow() public {
        _mintAs(alice, 90_000e18);          // 450 sAAPL, liability 90,000
        oracle.updatePrice(AID, 420e8);      // liability -> 189,000; reserve 190,000

        assertLt(vault.reserveRatioBps(), 11_000);

        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert();                   // ReserveRatioTooLow
        vault.mint(AID, 1_000e18);
        vm.stopPrank();
    }

    /// @dev Redeem must stay open even when the ratio is unhealthy — blocking
    ///      exits would be the bank run, not the fix for it.
    function test_redeemStillWorksWhenRatioUnhealthy() public {
        _mintAs(alice, 90_000e18);
        oracle.updatePrice(AID, 420e8);
        assertLt(vault.reserveRatioBps(), 11_000);

        vm.prank(alice);
        uint256 out = vault.redeem(AID, 100e18);
        assertEq(out, 100e18 * 420e8 / 1e8);
    }

    function test_reserveRatioIsMaxWhenNothingOutstanding() public view {
        assertEq(vault.reserveRatioBps(), type(uint256).max);
    }

    function test_pauseBlocksMintAndRedeem() public {
        _mintAs(alice, 2_000e18);
        vm.prank(admin);
        vault.pause();

        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert();
        vault.mint(AID, 1_000e18);
        vm.expectRevert();
        vault.redeem(AID, 1e18);
        vm.stopPrank();
    }

    function test_onlyRiskRoleCanSetCap() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setAssetCap(AID, 1e18);
    }

    function test_outstandingValueSkipsStaleAssetInsteadOfReverting() public {
        _mintAs(alice, 2_000e18);
        vm.warp(block.timestamp + 2 hours);          // price now stale
        assertEq(vault.outstandingValue(), 0);       // readable, not reverting
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract AssetVaultV2RiskTest`
Expected: FAIL — `setAssetCap` and `mint` are stubs.

- [ ] **Step 3: Implement the risk views and cap setter**

In `contracts/src/v2/AssetVaultV2.sol`, replace the `reserve`, `outstandingValue`, `reserveRatioBps` stubs with:

```solidity
    /// @notice USDC available to pay redeemers. Excludes accrued fees, which
    ///         belong to the operator and are not payout collateral.
    function reserve() public view returns (uint256) {
        uint256 bal = IERC20(_usdc).balanceOf(address(this));
        return bal > accruedFees ? bal - accruedFees : 0;
    }

    /// @dev Skips assets with a stale or zero price rather than reverting, so
    ///      risk dashboards stay readable during an oracle outage. A skipped
    ///      asset understates the liability — callers must treat a stale oracle
    ///      as "ratio unknown", which is why mint independently calls _price and
    ///      reverts on staleness.
    function outstandingValue() public view returns (uint256 total) {
        uint256 len = _assetIds.length;
        for (uint256 i = 0; i < len; i++) {
            bytes32 id = _assetIds[i];
            uint256 amount = _outstanding[id];
            if (amount == 0) continue;
            (uint256 price, uint256 updatedAt) = IAssetOracleV2(_oracle).getPrice(id);
            if (price == 0 || block.timestamp > updatedAt + maxPriceAge) continue;
            total += amount * price / 1e8;
        }
    }

    function reserveRatioBps() public view returns (uint256) {
        uint256 liability = outstandingValue();
        if (liability == 0) return type(uint256).max;
        return reserve() * BPS_DENOM / liability;
    }

    /// @notice Bounds exposure to one market. 0 closes the asset to new mints
    ///         while leaving redemptions open.
    function setAssetCap(bytes32 assetId, uint256 cap) external onlyRole(RISK_ROLE) {
        assetCap[assetId] = cap;
        emit AssetCapUpdated(assetId, cap);
    }
```

- [ ] **Step 4: Implement mint and redeem with the gates**

Replace the `mint`, `redeem`, `fundVault`, `withdrawFees` stubs with:

```solidity
    /// @notice Pay USDC, receive tokens at the oracle price less the mint fee.
    /// @dev Gated by the per-asset cap and the reserve ratio. Both are checked
    ///      BEFORE state changes so a rejected mint costs only gas.
    function mint(bytes32 assetId, uint256 usdcAmount)
        external whenNotPaused returns (uint256 tokenOut)
    {
        address token = _assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 feePaid;
        (tokenOut, feePaid) = previewMint(assetId, usdcAmount);   // reverts if stale
        if (tokenOut == 0) revert ZeroAmount();

        uint256 newOutstanding = _outstanding[assetId] + tokenOut;
        if (newOutstanding > assetCap[assetId]) {
            revert CapExceeded(assetId, newOutstanding, assetCap[assetId]);
        }

        _outstanding[assetId] = newOutstanding;
        accruedFees += feePaid;

        require(IERC20(_usdc).transferFrom(msg.sender, address(this), usdcAmount), "usdc in failed");

        // VULNERABILITY #2 FIX: refuse the mint if it would leave the book below
        // the operator's minimum coverage. Checked after the transfer so the
        // incoming USDC counts toward the ratio it must satisfy.
        uint256 ratio = reserveRatioBps();
        if (ratio < minReserveRatioBps) revert ReserveRatioTooLow(ratio, minReserveRatioBps);

        SyntheticAssetV2(token).mint(msg.sender, tokenOut);
        emit Minted(msg.sender, assetId, usdcAmount, tokenOut, feePaid);
    }

    /// @notice Burn tokens, receive their USDC value less the redeem fee.
    /// @dev Deliberately NOT gated by the reserve ratio — blocking exits during
    ///      stress is the bank run, not a defence against it.
    function redeem(bytes32 assetId, uint256 tokenAmount)
        external whenNotPaused returns (uint256 usdcOut)
    {
        address token = _assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 feePaid;
        (usdcOut, feePaid) = previewRedeem(assetId, tokenAmount);

        uint256 avail = reserve();
        if (avail < usdcOut) revert VaultDry(usdcOut, avail);

        _outstanding[assetId] -= tokenAmount;
        accruedFees += feePaid;

        SyntheticAssetV2(token).burn(msg.sender, tokenAmount);
        require(IERC20(_usdc).transfer(msg.sender, usdcOut), "usdc out failed");

        emit Redeemed(msg.sender, assetId, tokenAmount, usdcOut, feePaid);
    }

    /// @notice Operator injects payout collateral.
    function fundVault(uint256 usdcAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (usdcAmount == 0) revert ZeroAmount();
        require(IERC20(_usdc).transferFrom(msg.sender, address(this), usdcAmount), "fund failed");
        emit VaultFunded(msg.sender, usdcAmount);
    }

    /// @notice Operator withdraws earned fees. Cannot touch payout collateral.
    function withdrawFees(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidParam();
        if (amount > accruedFees) revert InvalidParam();
        accruedFees -= amount;
        require(IERC20(_usdc).transfer(to, amount), "fee out failed");
        emit FeesWithdrawn(to, amount);
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd contracts && forge test --match-contract AssetVaultV2RiskTest -vv`
Expected: PASS (11 tests). If `test_mintRevertsWhenAssetCapExceeded`'s expected numbers differ, recompute from the fee setting in `setUp` (fees are 0 there, so 100,000 USDC at $200 = 500 tokens) and correct the literals.

- [ ] **Step 6: Full suite**

Run: `cd contracts && forge test 2>&1 | tail -2`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/src/v2/AssetVaultV2.sol contracts/test/v2/AssetVaultV2Risk.t.sol
git commit -m "feat(v2): exposure cap and reserve-ratio gate on mint

Bounds vulnerability #1 and fixes vulnerability #2.

Per-asset cap bounds exposure to any single market; cap 0 closes an asset to new
mints while leaving redemptions open. The reserve-ratio gate refuses mints that
would push coverage below the operator's minimum, so the reserve never reaches
the point where an earlier redeemer strands a later one — that was the bank-run
ordering the V1 test demonstrates.

Redeem is deliberately NOT ratio-gated: blocking exits under stress is the bank
run, not a defence against it. reserve() excludes accrued fees so operator
revenue is never counted as payout collateral, and withdrawFees cannot touch it.

This does not make the vault fully collateralized — the mint-burn design leaves
the operator as counterparty. It makes the exposure bounded, priced, and
observable. See docs/RISK_MODEL.md."
```

---

### Task 6: V1 parity test

**Files:**
- Test: `contracts/test/v2/AssetVaultV2Parity.t.sol`

**Interfaces:**
- Consumes: everything from Tasks 2–5, plus V1's `AssetVault`/`SyntheticAsset`.
- Produces: proof that with fees at zero and a generous cap, V2 reproduces V1's mint/redeem numbers exactly — so switching the demo to V2 doesn't change the story told to reviewers, and any difference is a deliberate risk control rather than a maths regression.

- [ ] **Step 1: Write the test**

Create `contracts/test/v2/AssetVaultV2Parity.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/AssetVault.sol";
import "../../src/SyntheticAsset.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @notice With fees off and a generous cap, V2 must reproduce V1's numbers.
///         Any divergence should be a deliberate risk control, not drift.
contract AssetVaultV2ParityTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;

    AssetVault       v1;
    SyntheticAsset   v1Token;
    AssetVaultV2     v2;
    SyntheticAssetV2 v2Token;

    address admin = address(this);
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);

        // V1
        v1 = new AssetVault(address(usdc), address(oracle));
        v1Token = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(v1));
        v1.registerAsset(AID, address(v1Token));

        // V2, configured to behave like V1
        AssetVaultV2 impl = new AssetVaultV2();
        v2 = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdc), address(oracle), admin))
        )));
        v2Token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        v2Token.grantRole(v2Token.MINTER_ROLE(), address(v2));
        v2.registerAsset(AID, address(v2Token));
        v2.setAssetCap(AID, type(uint256).max);
        v2.setRiskParams(0, 0, 0, 1 hours);   // no fees, no ratio floor

        usdc.mint(alice, 100_000e18);
        usdc.mint(bob,   100_000e18);
        usdc.mint(admin, 500_000e18);
        usdc.approve(address(v1), type(uint256).max);
        usdc.approve(address(v2), type(uint256).max);
        v1.fundVault(100_000e18);
        v2.fundVault(100_000e18);
    }

    function test_mintAmountsMatch() public {
        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        v2.mint(AID, 2_000e18);
        vm.stopPrank();

        assertEq(v1Token.balanceOf(alice), v2Token.balanceOf(bob));
        assertEq(v2Token.balanceOf(bob), 10e18);
    }

    function test_redeemProceedsMatchAfterPriceMove() public {
        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        v2.mint(AID, 2_000e18);
        vm.stopPrank();

        oracle.updatePrice(AID, 250e8);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore   = usdc.balanceOf(bob);

        vm.prank(alice);
        v1.redeem(AID, 10e18);
        vm.prank(bob);
        v2.redeem(AID, 10e18);

        assertEq(usdc.balanceOf(alice) - aliceBefore, usdc.balanceOf(bob) - bobBefore);
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_500e18);
    }

    /// @dev The one intended divergence: V1 accepts a year-old price, V2 refuses.
    function test_stalePriceIsTheIntendedDivergence() public {
        vm.warp(block.timestamp + 365 days);

        vm.startPrank(alice);
        usdc.approve(address(v1), 2_000e18);
        v1.mint(AID, 2_000e18);          // V1: succeeds (the vulnerability)
        vm.stopPrank();
        assertEq(v1Token.balanceOf(alice), 10e18);

        vm.startPrank(bob);
        usdc.approve(address(v2), 2_000e18);
        vm.expectRevert();               // V2: StalePrice
        v2.mint(AID, 2_000e18);
        vm.stopPrank();
        assertEq(v2Token.balanceOf(bob), 0);
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd contracts && forge test --match-contract AssetVaultV2ParityTest -vv`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/test/v2/AssetVaultV2Parity.t.sol
git commit -m "test(v2): prove V2 reproduces V1 math, and name the one divergence

With fees off and no ratio floor, V2's mint and redeem numbers are identical to
V1's, including after a price move — so moving the demo to V2 does not change
the story. The single intended divergence is staleness: V1 mints against a
year-old price, V2 reverts."
```

---

### Task 7: RISK_MODEL.md — honest residual-risk documentation

**Files:**
- Create: `docs/RISK_MODEL.md`

**Interfaces:**
- Consumes: the behaviour proven in Tasks 4–6.
- Produces: the document a licensee's risk committee reads before deploying, and the honest counterpart to the marketing in P3. This exists so nobody has to reverse-engineer the risk model from Solidity.

- [ ] **Step 1: Write the document**

Create `docs/RISK_MODEL.md`:

```markdown
# AssetVault Risk Model

Audience: the risk function of an institution deploying this engine.

## What this contract is

A mint-burn vault. Users pay USDC and receive an ERC-20 tracking an oracle
price; they burn it to get USDC back at the then-current price. There is no
curve and no slippage.

## What it is not

**It is not fully collateralized, and V2 does not make it so.**

The vault is the counterparty to every long. It holds the USDC paid in, but its
liability is marked at the current price. If prices rise, the liability exceeds
what was paid in and the difference comes from operator-supplied collateral.
This is a property of the design, not a defect to be patched.

Anyone describing this engine as "fully backed", "risk-free", or "1:1 redeemable
in all conditions" is describing something else.

## Residual risk the operator carries

| Risk | Mechanism | Control |
|---|---|---|
| Directional exposure | Vault is short every long | `assetCap` per asset; `mintFeeBps`/`redeemFeeBps` price it |
| Reserve depletion | Rising market inflates liability | `minReserveRatioBps` blocks new mints before depletion |
| Redemption failure | Reserve below what a redeemer is owed | `VaultDry` revert; operator monitors `reserveRatioBps()` |
| Stale oracle | Trading against a frozen quote | `maxPriceAge`; `_price` reverts `StalePrice` |
| Oracle compromise | Single key sets prices | **NOT MITIGATED HERE.** See below |
| Operator key compromise | Admin can upgrade the vault | Role separation; use a timelock + multisig |

## The controls, precisely

- **`mintFeeBps` / `redeemFeeBps`** — taken in USDC, accrue to `accruedFees`,
  excluded from `reserve()`. Capped at 1000 bps (10%) in `setRiskParams` so a
  compromised `RISK_ROLE` key cannot confiscate deposits. Fees compensate the
  operator for carrying directional risk; they do not eliminate it.
- **`assetCap[assetId]`** — maximum token units outstanding per asset. Checked
  before state changes. `0` closes an asset to new mints while leaving
  redemptions open — the correct way to wind an asset down.
- **`minReserveRatioBps`** — `reserve() * 10000 / outstandingValue()`. A mint
  reverts `ReserveRatioTooLow` if it would leave coverage below this. Default
  11000 (110%). **Redemptions are never ratio-gated** — blocking exits during
  stress is the bank run, not a defence against it.
- **`maxPriceAge`** — default 1 hour. Must exceed the keeper's update interval
  with headroom, or normal operation will revert. The Sepolia keeper runs every
  15 minutes.
- **`pause()`** — halts mint and redeem. Held by `PAUSER_ROLE`.

## Known limitation: `outstandingValue()` and stale prices

`outstandingValue()` **skips** assets whose price is stale or zero instead of
reverting, so risk dashboards remain readable during an oracle outage. This
understates the liability, which means `reserveRatioBps()` is optimistic while
any asset is stale. Treat a stale oracle as *ratio unknown*, not as *ratio
healthy*. `mint` independently calls `_price` and reverts on staleness, so no
mint can be admitted on the strength of an optimistic ratio.

## Not addressed by this contract

- **Oracle decentralization.** `MockOracle.updatePrice` is `onlyOwner`. A single
  compromised key can set any price and drain the vault. Production deployments
  must point at a decentralized feed (the Chainlink/Pyth adapters exist but are
  not wired into the exchange — `PerpetualExchange.oracle` is `immutable`).
- **Mock stablecoins.** `MockUSDC.mint` and `MockUSDT.mint` are unrestricted by
  design for testnet. Never deploy them to a network carrying value.
- **Third-party audit.** None of the 24 contracts has been audited.
- **Regulatory status.** Six of the eleven assets reference real securities.
  Offering them is the licensee's regulatory responsibility, in its own
  jurisdiction, under its own licence. This engine takes no position on that and
  provides no compliance guarantee.

## Pre-deployment checklist for a licensee

- [ ] Third-party audit completed, findings resolved
- [ ] Oracle is a decentralized feed, not a single key
- [ ] Real USDC, not `MockUSDC`
- [ ] `DEFAULT_ADMIN_ROLE` held by a multisig behind a timelock
- [ ] `RISK_ROLE` and `PAUSER_ROLE` on separate keys from admin
- [ ] `assetCap` set for every asset per the risk committee's limits
- [ ] `maxPriceAge` exceeds the production keeper interval
- [ ] Monitoring alerts on `reserveRatioBps()` and oracle age
- [ ] Runbook for `pause()` and for winding an asset down via `assetCap = 0`
```

- [ ] **Step 2: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add docs/RISK_MODEL.md
git commit -m "docs: honest AssetVault risk model for licensee risk committees

States plainly that the vault is not fully collateralized and that V2 does not
make it so, documents each control and what it does and does not achieve, and
lists what this contract does not address at all: oracle centralization, mock
stablecoins with open mint, absent audit, and regulatory status.

Includes the known limitation that outstandingValue() skips stale assets and is
therefore optimistic, plus a pre-deployment checklist."
```

---

### Task 8: Deploy script and testnet verification

**Files:**
- Create: `contracts/script/DeployAssetVaultV2.s.sol`

**Interfaces:**
- Consumes: `AssetVaultV2.initialize`, `SyntheticAssetV2` constructor, `MINTER_ROLE`, `registerAsset`, `setAssetCap`.
- Produces: console output of the proxy, implementation, and 11 V2 token addresses for the operator to record. Does **not** touch V1's deployment.

- [ ] **Step 1: Write the script**

Create `contracts/script/DeployAssetVaultV2.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/AssetVaultV2.sol";
import "../src/v2/SyntheticAssetV2.sol";

/// @notice Deploys the V2 tokenized-asset layer alongside V1. V1 stays deployed
///         and untouched.
///
///           MOCKUSDC_ADDR=0x… MOCKORACLE_ADDR=0x… forge script … --broadcast
///
///         Caps default to 0 (asset closed) so nothing can be minted until the
///         operator's risk committee sets real limits. This is deliberate — an
///         open cap on deploy would be a risk decision made by a script.
contract DeployAssetVaultV2 is Script {
    function _defs()
        internal pure
        returns (string[11] memory syms, string[11] memory names)
    {
        syms = [
            "sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND",
            "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"
        ];
        names = [
            "Synthetic Bitcoin", "Synthetic Ether", "Synthetic Apple",
            "Synthetic Tesla", "Synthetic Gold", "Synthetic Bond",
            "Synthetic Nvidia", "Synthetic Microsoft", "Synthetic Alphabet",
            "Synthetic Clean Energy ETF", "Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc   = vm.envAddress("MOCKUSDC_ADDR");
        address oracle = vm.envAddress("MOCKORACLE_ADDR");
        address admin  = msg.sender;

        vm.startBroadcast();

        AssetVaultV2 impl = new AssetVaultV2();
        console.log("AssetVaultV2 implementation:", address(impl));

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (usdc, oracle, admin))
        );
        AssetVaultV2 vault = AssetVaultV2(address(proxy));
        console.log("AssetVaultV2 proxy (use this):", address(vault));

        (string[11] memory syms, string[11] memory names) = _defs();
        for (uint256 i = 0; i < 11; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAssetV2 token = new SyntheticAssetV2(names[i], syms[i], aid, admin);
            token.grantRole(token.MINTER_ROLE(), address(vault));
            vault.registerAsset(aid, address(token));
            console.log(syms[i], address(token));
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("Caps are 0 — every asset is closed to new mints.");
        console.log("Risk committee must call setAssetCap() before use.");
        console.log("Then approve + fundVault() to seed payout collateral.");
    }
}
```

- [ ] **Step 2: Compile-check without broadcasting**

Run: `cd contracts && forge build --quiet 2>&1 | grep -icE "^error|compiler run failed"`
Expected: `0`. Do **not** run `run()` — deployment is the user's step.

- [ ] **Step 3: Full suite green**

Run: `cd contracts && forge test 2>&1 | tail -2`
Expected: all green.

- [ ] **Step 4: Guardrail — confirm no existing `.sol` was modified**

Run: `cd /c/Users/sanketsu/pepelab_onchain_cfd && git diff --name-status origin/main -- '*.sol' | grep -E '^M' || echo "NONE"`
Expected: `NONE`, or only files that were already modified on `main` before this plan started. Any newly modified pre-existing contract → STOP and report.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
git add contracts/script/DeployAssetVaultV2.s.sol
git commit -m "feat(v2): deploy script for upgradeable V2 layer

Deploys implementation + ERC1967 proxy + 11 V2 tokens, granting the vault
MINTER_ROLE on each. V1 is untouched and stays deployed.

Caps default to 0, so every asset ships closed to new mints — opening them is a
risk decision for the operator's committee, not something a deploy script should
make silently."
```

- [ ] **Step 6: Print the deploy commands for the user (do not run)**

```bash
cd contracts
set -a && source .env && set +a

MOCKUSDC_ADDR=0x167Bacef1925184f0df34A3196F834C0622Cfd36 \
MOCKORACLE_ADDR=0x17CA20A37Cf04F2f589B2573EC95f1411D29d958 \
forge script script/DeployAssetVaultV2.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" \
  --broadcast --skip-simulation --slow -v

# then, per asset the risk committee approves (example: 1000 sBTC):
cast send <V2_PROXY> "setAssetCap(bytes32,uint256)" $(cast keccak sBTC) 1000000000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"

# seed payout collateral:
cast send 0x167Bacef1925184f0df34A3196F834C0622Cfd36 "approve(address,uint256)" <V2_PROXY> 1000000000000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"
cast send <V2_PROXY> "fundVault(uint256)" 1000000000000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY"
```

---

## Self-Review

**1. Spec coverage.**
- Fix vulnerability #1 (unbounded exposure) → Task 5 (`assetCap`) + Task 4 (fees price it). Honest limits stated in Task 7. ✅
- Fix vulnerability #2 (bank-run ordering) → Task 5 (reserve-ratio gate on mint, redeem left open). ✅
- Fix vulnerability #3 (staleness) → Task 4 (`_price` reverts `StalePrice`), divergence proven in Task 6. ✅
- V2 upgradeable → Task 3 (UUPS + state-preservation test). ✅
- `SyntheticAsset.vault` immutability problem → Task 2 (revocable `MINTER_ROLE`, rotation test). ✅
- Institution-configurable risk (B2B) → Task 4 `setRiskParams`, Task 5 `setAssetCap`, role separation in Task 3, `pause` in Task 3/5. ✅
- Never modify existing `.sol` → all new files; guardrail in Task 8 Step 4. ✅
- Never redeploy existing contracts → V2 deploys alongside; Task 8 script docstring. ✅
- Dependency needed → Task 1. ✅

**Deliberately out of scope** (belongs to P2/P3, noted so it isn't mistaken for an oversight): CI/CD and coverage tooling (P2), oracle decentralization (needs a new exchange — `PerpetualExchange.oracle` is `immutable`, so it cannot be rewired without redeploying, which the constraints forbid), frontend switch to V2 (P3), audit engagement (external).

**2. Placeholder scan.** No TBD/TODO. Every code step carries complete code. Task 5's expected-revert literals include instructions for recomputing if Foundry's arithmetic differs, which is guidance rather than a placeholder.

**3. Type consistency.** `MINTER_ROLE`, `RISK_ROLE`, `PAUSER_ROLE`, `BPS_DENOM` consistent Tasks 2–8. `previewMint`/`previewRedeem` return `(uint256, uint256)` in `IAssetVaultV2` (Task 3), implementation (Task 4), and all call sites (Tasks 5–6) — note this differs from V1's single-value return, which is why the frontend change is deferred to P3 rather than mixed in here. `reserve`/`outstandingValue`/`reserveRatioBps`/`exposureOf` consistent Tasks 3–5. `initialize(address,address,address)` identical in Tasks 3, 6, 8. Error names (`StalePrice`, `NoPrice`, `AssetNotRegistered`, `ZeroAmount`, `CapExceeded`, `ReserveRatioTooLow`, `VaultDry`, `InvalidParam`) declared once in Task 3 and used consistently after.

**Known interface break to carry into P3:** `previewMint` returns two values in V2 versus one in V1. `TokenizedAssetsPage.tsx` calls the single-value form. P3 must handle both or gate on which vault a chain uses.

---

## Roadmap: P2 and P3

Not written yet — write them when P1 is merged, so they build on what actually shipped rather than what was planned.

**P2 — CI/CD and audit readiness.** 358 contract tests currently run only on developers' machines; `.github/workflows/` has just the two keepers. Scope: `forge test` + `yarn build` on PR, `forge coverage` with a floor, Slither in CI, gas snapshots to catch regressions, and an audit-prep bundle (scope document, known-issues list from `RISK_MODEL.md`, deployment inventory). This is what lets an institutional customer's technical due diligence pass.

**P3 — B2B white-label productization.** Multi-tenant configuration, an institutional API surface mirroring `IAssetVaultV2`, a TypeScript SDK, integration docs, and the frontend switch to V2 including the `previewMint` signature change. Also the honest commercial artifacts: what the licensee is responsible for versus what the engine provides.
