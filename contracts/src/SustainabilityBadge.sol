// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SustainabilityBadge
/// @notice A non-transferable (soulbound) achievement credential. Minted by
///         a `MINTER_ROLE` holder (e.g. `EsgRewardDistributor`) to record
///         that an address earned a specific achievement; never tradeable.
/// @dev    Decision #05/#10 (spec #93): "只要能轉讓就有價格,有價格就有人為
///         了價格刷" — the moment a badge can change hands it acquires a
///         price, and a price is exactly the speculative incentive the
///         GameFi-to-credential redesign exists to remove. This contract is
///         the single enforcement point for that: every transfer path in
///         OZ v5's ERC721 — `transferFrom`, both `safeTransferFrom`
///         overloads, and a transfer attempted after `approve` /
///         `setApprovalForAll` — funnels through the `_update` hook
///         overridden below, so there is nowhere else a transfer could slip
///         through. Minting (`from == address(0)`) is unaffected; there is
///         deliberately no burn function, since an achievement, once
///         earned, is not something a holder or the contract should be able
///         to make disappear.
///
///         `reasonFor` is a free-text label rather than an enum tied to any
///         particular reward mechanism (carbon tier, trade volume, whatever
///         comes next) — this contract knows nothing about ESG or carbon
///         intensity, so any future minter can reuse it for a different
///         achievement without a redeploy here.
contract SustainabilityBadge is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    error NonTransferable();

    uint256 private _nextTokenId;

    /// @notice Human-readable reason the badge was minted, e.g.
    ///         "30+ day hold on a Low-carbon-tier position". Set once at
    ///         mint time; immutable thereafter (no setter is exposed).
    mapping(uint256 => string) public reasonFor;

    event BadgeMinted(address indexed to, uint256 indexed tokenId, string reason);

    constructor(address admin) ERC721("PepeLab Sustainability Badge", "PSB") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Mint a new badge to `to`, recording `reason`.
    /// @dev Token ids are assigned sequentially starting at 1; the minter
    ///      does not choose them, so two mints can never collide.
    function mint(address to, string calldata reason) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        reasonFor[tokenId] = reason;
        _safeMint(to, tokenId);
        emit BadgeMinted(to, tokenId, reason);
    }

    // ── Non-transferable ─────────────────────────────────────────────────────

    /// @dev OZ v5 funnels `_mint`, `_burn`, `transferFrom` and both
    ///      `safeTransferFrom` overloads through this single hook. A
    ///      transfer is `from != 0 && to != 0`; mint is `from == 0`, burn
    ///      (unused here, but the check stays general) is `to == 0`. Only
    ///      the transfer case is rejected here — `approve`/`setApprovalForAll`
    ///      are rejected outright below instead, since whatever they'd
    ///      approve could never clear this hook anyway.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    /// @dev Approving a transfer that can never happen is a trap, not a
    ///      no-op: `getApproved`/`isApprovedForAll` would keep reporting a
    ///      real approval to any marketplace or dashboard that reads them as
    ///      a proxy for "listed"/"transferable", right up until the actual
    ///      transfer reverts. Rejecting both calls outright — rather than
    ///      leaving them to silently succeed and write storage nothing can
    ///      ever use — surfaces that immediately instead of at transfer time.
    function approve(address, uint256) public pure override {
        revert NonTransferable();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert NonTransferable();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
