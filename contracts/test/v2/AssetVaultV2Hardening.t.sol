// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @notice Fixes from the 2026-07-27 self-review of V2: bounded asset
///         registration, asset de-registration, and reentrancy guards.
contract AssetVaultV2HardeningTest is Test {
    AssetVaultV2 vault;
    MockUSDC     usdc;
    MockOracle   oracle;

    address admin = address(this);
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
        vault.setRiskParams(0, 0, 0, 1 hours);
    }

    function _register(bytes32 id, string memory sym) internal returns (SyntheticAssetV2 t) {
        t = new SyntheticAssetV2(sym, sym, id, admin);
        t.grantRole(t.MINTER_ROLE(), address(vault));
        vault.registerAsset(id, address(t));
    }

    // ── bounded registration ─────────────────────────────────────────────────

    /// @dev mint() prices every active asset, so unbounded registration would
    ///      eventually push mint past the block gas limit. The ceiling means an
    ///      operator cannot brick their own vault by onboarding markets.
    function test_registrationIsCappedAtMax() public {
        uint256 max = vault.MAX_REGISTERED_ASSETS();
        for (uint256 i = 0; i < max; i++) {
            _register(keccak256(abi.encode("asset", i)), "sX");
        }
        assertEq(vault.registeredAssets().length, max);

        // Deploy first: vm.expectRevert applies to the NEXT call, and _register
        // would have spent it on the token's constructor.
        bytes32 extra = keccak256("one-too-many");
        SyntheticAssetV2 t = new SyntheticAssetV2("sY", "sY", extra, admin);

        vm.expectRevert(abi.encodeWithSelector(AssetVaultV2.TooManyAssets.selector, max));
        vault.registerAsset(extra, address(t));
    }

    /// @dev Re-registering an existing id swaps the token without consuming a
    ///      new slot.
    function test_reRegisterDoesNotConsumeSlot() public {
        _register(AID, "sAAPL");
        assertEq(vault.registeredAssets().length, 1);

        SyntheticAssetV2 replacement = new SyntheticAssetV2("sAAPL", "sAAPL", AID, admin);
        vault.registerAsset(AID, address(replacement));

        assertEq(vault.registeredAssets().length, 1);
        assertEq(vault.assetToken(AID), address(replacement));
    }

    // ── de-registration ──────────────────────────────────────────────────────

    function test_unregisterFreesSlotAndClearsState() public {
        _register(AID, "sAAPL");
        vault.setAssetCap(AID, 100e18);

        vault.unregisterAsset(AID);

        assertEq(vault.registeredAssets().length, 0);
        assertEq(vault.assetToken(AID), address(0));
        assertEq(vault.assetCap(AID), 0);
    }

    function test_unregisterAllowsRegisteringAgainAtMax() public {
        uint256 max = vault.MAX_REGISTERED_ASSETS();
        for (uint256 i = 0; i < max; i++) {
            _register(keccak256(abi.encode("asset", i)), "sX");
        }
        vault.unregisterAsset(keccak256(abi.encode("asset", uint256(0))));
        _register(keccak256("replacement"), "sZ");     // slot freed
        assertEq(vault.registeredAssets().length, max);
    }

    /// @dev The guard that matters: removing an asset with holders would strand
    ///      them holding a token the vault no longer redeems.
    function test_cannotUnregisterWhileTokensOutstanding() public {
        SyntheticAssetV2 t = _register(AID, "sAAPL");
        oracle.addAsset(AID, 200e8);
        vault.setAssetCap(AID, 1_000e18);

        usdc.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);
        vm.stopPrank();

        assertEq(t.balanceOf(alice), 10e18);
        vm.expectRevert(
            abi.encodeWithSelector(AssetVaultV2.AssetStillOutstanding.selector, AID, 10e18)
        );
        vault.unregisterAsset(AID);

        // once holders exit, removal is allowed
        vm.prank(alice);
        vault.redeem(AID, 10e18);
        vault.unregisterAsset(AID);
        assertEq(vault.registeredAssets().length, 0);
    }

    function test_unregisterUnknownAssetReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(AssetVaultV2.AssetNotRegistered.selector, keccak256("nope"))
        );
        vault.unregisterAsset(keccak256("nope"));
    }

    function test_onlyAdminCanUnregister() public {
        _register(AID, "sAAPL");
        vm.prank(alice);
        vm.expectRevert();
        vault.unregisterAsset(AID);
    }

    /// @dev De-registering must not corrupt the remaining set — removal swaps
    ///      the last element into the hole, so order changes but membership
    ///      must not.
    function test_unregisterPreservesRemainingMembership() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        bytes32 c = keccak256("C");
        _register(a, "sA");
        _register(b, "sB");
        _register(c, "sC");

        vault.unregisterAsset(b);

        bytes32[] memory left = vault.registeredAssets();
        assertEq(left.length, 2);
        bool hasA;
        bool hasC;
        for (uint256 i = 0; i < left.length; i++) {
            if (left[i] == a) hasA = true;
            if (left[i] == c) hasC = true;
        }
        assertTrue(hasA);
        assertTrue(hasC);
    }

    // ── reentrancy guard ─────────────────────────────────────────────────────

    /// @dev The guard is initialized, so a nested call reverts rather than
    ///      running with half-updated state. Proven by driving mint through a
    ///      token whose transferFrom re-enters the vault.
    function test_mintIsReentrancyGuarded() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        MockOracle    o    = new MockOracle();
        o.addAsset(AID, 200e8);

        AssetVaultV2 impl = new AssetVaultV2();
        AssetVaultV2 v = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(evil), address(o), admin))
        )));
        v.setRiskParams(0, 0, 0, 1 hours);

        SyntheticAssetV2 t = new SyntheticAssetV2("sAAPL", "sAAPL", AID, admin);
        t.grantRole(t.MINTER_ROLE(), address(v));
        v.registerAsset(AID, address(t));
        v.setAssetCap(AID, 1_000e18);

        evil.arm(address(v), AID);
        evil.mint(alice, 10_000e18);

        vm.prank(alice);
        vm.expectRevert();          // ReentrancyGuardReentrantCall
        v.mint(AID, 2_000e18);
    }
}

/// @dev A token that calls back into the vault during transferFrom, the shape a
///      hook-bearing stablecoin would have.
contract ReentrantUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    AssetVaultV2 private _vault;
    bytes32      private _asset;
    bool         private _entered;

    function arm(address vault_, bytes32 asset_) external {
        _vault = AssetVaultV2(vault_);
        _asset = asset_;
    }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (!_entered) {
            _entered = true;
            _vault.mint(_asset, 1e18);   // must be rejected by the guard
        }
        return true;
    }
}
