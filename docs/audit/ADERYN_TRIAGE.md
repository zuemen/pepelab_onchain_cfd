# Aderyn Triage — V2 Stack

Aderyn v0.6.8, run against `contracts/src/v2/` on 2026-07-27. Raw output in
`aderyn-v2-report.md`. Aderyn is a static analyser from Cyfrin; it overlaps with
Slither but not completely, which is why both run.

**Result: 1 High, 12 Low. Both High and the two Low findings that could matter
are false positives on this codebase. Reasoning below rather than a bare
dismissal.**

---

## H-1: Contract locks Ether without a withdraw function — false positive

Flagged on `AssetVaultV2`, `AssetVaultV2_1`, `AssetVaultV2_2`.

The payable surface Aderyn sees is `UUPSUpgradeable.upgradeToAndCall`, which OZ
declares payable so an upgrade can forward value to an initialiser. The vault
itself has no `receive`, no `fallback`, and no payable entry point of its own —
every value path is USDC via `SafeERC20`. `upgradeToAndCall` is behind
`_authorizeUpgrade`, which is `onlyRole(DEFAULT_ADMIN_ROLE)`, so the only account
that could send ether during an upgrade is the admin, deliberately, with no
reason to.

Ether cannot reach the contract through normal operation. Adding a withdraw
function to satisfy the detector would add an admin-only value-moving path that
does not currently exist — a worse trade than the finding it closes.

## L-6: `nonReentrant` is not the first modifier — false positive

Flagged on `mint` and `redeem`: `external whenNotPaused nonReentrant`.

The concern behind this rule is a preceding modifier making an external call
before the reentrancy lock is taken. `whenNotPaused` is `PausableUpgradeable`'s
guard: it reads `_paused` from storage and reverts. No external calls, no hooks,
no delegatecalls. There is nothing to re-enter before `nonReentrant` engages.

Ordering is intentional: pause is a kill switch, so it should reject before any
other work — including the SSTORE that `nonReentrant` performs.

## L-9: Unchecked return — false positive

12 instances, all `_grantRole(...)` inside `initialize`.

OZ's `_grantRole` returns `bool` meaning "did this call change anything" — false
when the account already had the role. In `initialize` the contract is fresh, so
every grant is by definition new. `HandoverRoles.s.sol` handles the runtime case
properly: it reads roles back with `hasRole` and reverts via `RoleNotGranted` if
a grant did not take.

## Remaining Low findings

L-1 centralization, L-2 costly loop ops, L-3 empty block, L-4/L-5 literals,
L-7 PUSH0, L-8 address set without check, L-10 pragma, L-11 public not used
internally, L-12 unused state variable — style and informational. L-1 is the
substantive one and is the same issue as `KNOWN_LIMITATIONS.md` #13: roles held
by too few keys. That was addressed by the role separation performed on
2026-07-27; see `ROLE_SEPARATION.md`.

---

## What this run is and is not

It is a second static-analysis opinion, from a different engine than the Slither
already in CI, with each finding triaged rather than counted.

It is not an audit. Aderyn found nothing exploitable here, which says more about
the class of bug static analysis catches than about the contracts. The fee
accounting error CI caught on 2026-07-27 is the illustration: an invariant test
found it, and neither Slither nor Aderyn would have — the code was internally
consistent and locally correct, just wrong about a quantity. That is the kind of
thing a human auditor finds. Third-party audit stays a prerequisite for mainnet.
