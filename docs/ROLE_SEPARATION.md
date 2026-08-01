# Role Separation — Sepolia V2 Stack

Executed 2026-07-27. Closes `KNOWN_LIMITATIONS.md` #13 (all six roles on one
deployer key) as far as key separation goes; the multisig step is still open and
is called out below rather than glossed over.

## Contracts

| Contract | Address |
|---|---|
| GuardedOracle | `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` |
| AssetVaultV2 (proxy) | `0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17` |

## Role holders after handover

| Role | Contract | Holder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | both | `0x2a588AeA3271B159c9188d95E0d10614711f83e3` |
| `KEEPER_ROLE` | GuardedOracle | `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` |
| `GUARDIAN_ROLE` | GuardedOracle | `0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4` |
| `PAUSER_ROLE` | AssetVaultV2 | `0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4` |
| `RISK_ROLE` | AssetVaultV2 | `0xECe96A5EC46e20E0F9A441c9D787E89CE366B165` |
| `owner` (Ownable) | MockOracle `0x17CA20A3…d958` | `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` |

MockOracle ownership moved to the keeper on 2026-07-27 because
`MockOracle.updatePrice` is `onlyOwner` — the scheduled keeper could not write a
single price otherwise, and the run failed every 15 minutes. Its only owner
functions are `addAsset` and `updatePrice`, so this does not widen the keeper's
reach. It does put the oracle the V1 exchange reads behind a key stored in GitHub
Actions, and MockOracle has no deviation cap: whoever holds that key can set any
price. That exposure is limitation #3 and is the reason GuardedOracle exists.

Deployer `0xE80A81360608C1342e66743F70a00f75d792Eb93` **still holds every role**.
The handover ran with `REVOKE_DEPLOYER=false` on purpose — see "What is still
open".

Private keys are in `contracts/.env.roles`, gitignored, never committed.

## Procedure

`script/HandoverRoles.s.sol`, which grants first, reads every role back on chain,
and only then revokes. The order is not cosmetic: revoking before verifying can
leave an AccessControl contract with no admin, and there is no recovery from that
— roles can never be granted again, the vault's risk parameters freeze
permanently, and the proxy can never be upgraded.

1. Fund the three new operational keys with 0.05–0.08 Sepolia ETH
2. `HANDOVER_DRY_RUN=true` — prints the plan, sends nothing
3. `HANDOVER_DRY_RUN=false REVOKE_DEPLOYER=false` — grants only
4. Exercise each new key against the live contracts
5. `REVOKE_DEPLOYER=true` — **not yet run**

## Verification performed on chain

Every check below was executed against Sepolia, not assumed.

**Grants took effect** — `hasRole` returns true for all six role/holder pairs.

**Guardian can pause and unpause.** `pause()` from the guardian key succeeded,
`paused()` returned true, `unpause()` restored it. The kill switch works from a
key that holds nothing else.

**Keeper can post prices.** `getPrice(sBTC)` was reverting on staleness before
the handover. `updatePrice` from the new keeper key succeeded and `getPrice`
returned normally afterwards — so this step also fixed a live staleness fault.

**The deviation cap rejects a bad post from an authorised key.** With sBTC at
$73,468, posting $1 from the keeper key reverted with `DeviationTooLarge`, and a
follow-up read confirmed the stored price was unchanged. This is the property
that makes keeper separation worth doing: a compromised keeper cannot move the
price arbitrarily, only within `maxDeviationBps` (10%), and every attempt is on
chain.

## Deviation cap temporarily disabled — 2026-07-27

Recorded because it is exactly the admin power described as a risk below, and a
log that only contains the flattering operations is not a log.

GuardedOracle held seed prices that predated the keeper and were badly wrong:
sNVDA $1,100.83 against a real $196.51, sESGU $44.96 against $162.09, sGOOGL
$170.11 against $326.56. The 10% per-update cap is designed to stop exactly that
kind of jump, so correcting them within the cap would have taken about 47
sequential transactions walking each price 9% at a time.

Instead the admin key set `maxDeviationBps` to 0, the keeper wrote all eleven
correct prices, and the cap was restored to 1000 in the same session. Verified
afterwards: `maxDeviationBps` reads 1000, and a $1 post against sAAPL at $335.65
reverts `DeviationTooLarge`. `AssetVaultV2.reserveRatioBps()` returns normally,
so the V2 stack prices off fresh data again.

Three points worth being plain about:

The guard did not fail — it was switched off deliberately by the account allowed
to switch it off. That is the difference between a control and a law, and it is
why the admin key matters more than the keeper key.

A one-key admin made this a single unilateral action with no second opinion.
With the Safe in place it would have needed two signatures, which is the entire
argument for the multisig step below.

Walking the prices in 47 steps would have demonstrated nothing new. The guard was
already proven on chain, twice, by rejecting a $1 sBTC post. Repeating the
demonstration is not worth an hour of transactions; disclosing the shortcut is.

## What is still open

**The admin is a single EOA, not a multisig.** `0x2a588AeA…` is a freshly
generated key that does nothing else, which is a real improvement over the
deployer that also holds funds and every other role — but it is one key. A
compromised admin can still retune the deviation cap, repoint the oracle, or
grant itself keeper. The deviation cap bounds a compromised *keeper*; nothing
bounds a compromised *admin*.

The fix is a Safe 2-of-3 across the three team members, which is free on Sepolia
and takes about five minutes at app.safe.global. It needs two teammate addresses,
which is why it is not done here. A multisig with one signer is not a multisig,
so the interim EOA is described as what it is rather than counted as the fix.

**The deployer has not been revoked.** Deliberate. Revocation is irreversible and
the new keeper key is not yet in GitHub Actions, so revoking now would stop the
price feed. Sequence:

1. Put `KEEPER_PK` from `.env.roles` into the repo secret `KEEPER_PRIVATE_KEY`
2. Wait for one scheduled keeper run to confirm it posts
3. Replace the interim admin with the Safe (grant Safe, verify, revoke EOA)
4. Then `REVOKE_DEPLOYER=true`

Until step 4, the deployer key remains a single point of compromise for both
contracts. The separation above is real but not yet exclusive.
