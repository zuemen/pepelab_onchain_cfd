# Key Management — Role Separation Runbook

Audience: whoever operates the deployed contracts.

## Where things stand

Both hardened contracts were deployed with every role on the deployer key
`0xE80A81360608C1342e66743F70a00f75d792Eb93`:

| Contract | Address (Sepolia) | Roles currently held by the deployer |
|---|---|---|
| GuardedOracle | `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` | admin, keeper, guardian |
| AssetVaultV2 | `0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17` | admin, risk, pauser |

**What that means, precisely.** GuardedOracle bounds a compromised *keeper* — it
cannot crash or spike the price, only nudge it inside the deviation cap, and
`GuardedOracleTest` proves that on-chain behaviour. It does **not** bound a
compromised *admin*: admin can widen `maxDeviationBps`, swap the reference
source, grant itself keeper, unfreeze an asset, or upgrade the vault
implementation outright.

So today the guard's protection is real but partial. One key still holds
everything. Separating the roles is what converts the design into the protection
it describes.

## Target layout

| Role | Holder | Why |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | **Multisig, ideally behind a timelock** | Equivalent to custody of the reserve. Can upgrade the proxy. |
| `KEEPER_ROLE` (oracle) | Hot key, on the price-posting box | Must be online, so assume it will eventually leak. Bounded by the deviation cap. |
| `GUARDIAN_ROLE` (oracle) / `PAUSER_ROLE` (vault) | Warm key, separate from admin | Halting must be fast and must not require assembling a multisig. |
| `RISK_ROLE` (vault) | Risk owner's key | Sets caps and fees. Deliberately cannot upgrade. |

A guardian key that can only *stop* things is much less dangerous than an admin
key, which is why pause and freeze sit apart from admin.

## The ordering, and why it is not negotiable

```
1. grant every new holder
2. read the roles back and assert they took effect
3. only then revoke the deployer, admin last
```

Reversing this can leave a contract with **zero admins**. AccessControl has no
recovery from that state:

- nothing can ever grant a role again
- the vault's risk parameters freeze permanently
- the UUPS proxy can never be upgraded, so any future bug is permanent

This is not hypothetical. `RoleHandover.t.sol` contains
`test_revokingBeforeGrantingBricksTheContractForever` and
`test_brickedVaultCanNeverBeUpgraded`, which perform the mistake and assert that
recovery is impossible. `HandoverRoles.s.sol` re-reads `hasRole` for the new
admin immediately before each revoke and reverts `WouldLeaveNoAdmin` rather than
proceeding.

## Procedure

### 1. Decide the addresses

Only you can make this call. A multisig with a single signer is not a multisig;
a multisig whose signers share a laptop is not one either.

### 2. Dry run — sends nothing

```bash
cd contracts
set -a && source .env && set +a

GUARDED_ORACLE=0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
ASSET_VAULT=0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17 \
NEW_ADMIN=<multisig> \
NEW_KEEPER=<hot keeper> \
NEW_GUARDIAN=<guardian> \
NEW_RISK=<risk owner> \
HANDOVER_DRY_RUN=true \
forge script script/HandoverRoles.s.sol --rpc-url "$SEPOLIA_RPC_URL"
```

Check the printed plan carefully. A typo in `NEW_ADMIN` that you then revoke
against is the one mistake this document exists to prevent.

### 3. Grant only — deployer keeps its roles

```bash
… NEW_ADMIN=<multisig> … \
HANDOVER_DRY_RUN=false REVOKE_DEPLOYER=false \
forge script script/HandoverRoles.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

Both old and new keys work now. Nothing is at risk if a new key turns out wrong.

### 4. Exercise the new keys before trusting them

Do not skip this. Prove each key can do its job *and* cannot exceed it:

```bash
# keeper posts a price
cast send $ORACLE "updatePrice(bytes32,uint256)" $(cast keccak sBTC) <price> \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$KEEPER_KEY"

# keeper cannot widen its own cap — this MUST revert
cast send $ORACLE "setRiskParams(uint256,uint256)" 5000 3600 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$KEEPER_KEY"

# guardian can pause; multisig can set risk params
```

### 5. Revoke the deployer

Only after step 4 passes.

```bash
… HANDOVER_DRY_RUN=false REVOKE_DEPLOYER=true \
forge script script/HandoverRoles.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

The script grants and verifies again before revoking, so re-running is safe —
`_grant` and `_revoke` both no-op when already in the desired state.

### 6. Verify the end state

```bash
DEPLOYER=0xE80A81360608C1342e66743F70a00f75d792Eb93
cast call $ORACLE "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 $DEPLOYER \
  --rpc-url "$SEPOLIA_RPC_URL"    # expect false
cast call $ORACLE "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 <multisig> \
  --rpc-url "$SEPOLIA_RPC_URL"    # expect true
```

Repeat for the vault. Then update the `KEEPER_PRIVATE_KEY` secret consumed by
`agent/keeper/run.ts` to the keeper key, or the keeper stops being able to post.

Rotating the key is not enough on its own: the keeper must also be the owner of
the `MockOracle` on **every** chain it writes to, and hold gas there. Missing
either one produces a keeper that runs and writes nothing. That is exactly how
Base Sepolia went 9.5 days without a price update after the 2026-07-27
separation — see [RUNBOOK_KEEPER.md](RUNBOOK_KEEPER.md).

## What this still does not fix

Role separation bounds the damage from any single key. It does not make the
system trustless:

- Keepers remain trusted parties. A patient attacker holding a keeper key can
  still walk the price in legal steps — `test_attackerCanStillWalkPriceGradually`.
- The multisig can do anything, including upgrading the vault. A timelock buys
  observers time to react; it does not remove the power.
- `PerpetualExchange` is untouched by all of this. Its oracle is `immutable` and
  its owner key is still a single key. See `docs/KNOWN_LIMITATIONS.md`.
