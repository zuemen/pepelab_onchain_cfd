// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/v2/AssetVaultV2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/AssetVault.sol";
import "../../src/SyntheticAsset.sol";
import "../../src/MockOracle.sol";

/// @notice A stablecoin that behaves like mainnet USDT: transfer and
///         transferFrom return NOTHING rather than a bool.
///
///         This is why SafeERC20 exists. Calling these through an interface that
///         declares `returns (bool)` reverts while decoding the empty return
///         data, so `require(token.transfer(...))` fails even though the
///         transfer itself was fine.
contract VoidReturnUSDT {
    string public name     = "Void Return USDT";
    string public symbol   = "USDT";
    uint8  public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    // NOTE: no `returns (bool)` — exactly like mainnet USDT.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract AssetVaultV2SafeERC20Test is Test {
    VoidReturnUSDT   usdt;
    MockOracle       oracle;
    AssetVaultV2     v2;
    SyntheticAssetV2 v2Token;

    address admin = address(this);
    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdt   = new VoidReturnUSDT();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);

        AssetVaultV2 impl = new AssetVaultV2();
        v2 = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (address(usdt), address(oracle), admin))
        )));
        v2Token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        v2Token.grantRole(v2Token.MINTER_ROLE(), address(v2));
        v2.registerAsset(AID, address(v2Token));
        v2.setAssetCap(AID, type(uint256).max);
        v2.setRiskParams(0, 0, 0, 1 hours);

        usdt.mint(alice, 100_000e18);
        usdt.mint(admin, 100_000e18);
        usdt.approve(address(v2), type(uint256).max);
        v2.fundVault(50_000e18);
    }

    /// @dev V2 works end-to-end against a void-return token.
    function test_v2MintAndRedeemWorkWithVoidReturnToken() public {
        vm.startPrank(alice);
        usdt.approve(address(v2), 2_000e18);
        v2.mint(AID, 2_000e18);
        vm.stopPrank();

        assertEq(v2Token.balanceOf(alice), 10e18);

        uint256 before = usdt.balanceOf(alice);
        vm.prank(alice);
        v2.redeem(AID, 10e18);
        assertEq(usdt.balanceOf(alice) - before, 2_000e18);
    }

    /// @dev The same flow against V1, which uses `require(token.transferFrom(...))`.
    ///      It reverts on ABI-decoding the empty return data — the exact failure
    ///      mode SafeERC20 prevents. Documents why V1 must not be pointed at a
    ///      real USDT-style token.
    function test_v1RevertsWithVoidReturnToken() public {
        AssetVault v1 = new AssetVault(address(usdt), address(oracle));
        SyntheticAsset v1Token =
            new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(v1));
        v1.registerAsset(AID, address(v1Token));

        vm.startPrank(alice);
        usdt.approve(address(v1), 2_000e18);
        vm.expectRevert();
        v1.mint(AID, 2_000e18);
        vm.stopPrank();

        assertEq(v1Token.balanceOf(alice), 0);
    }
}
