# Key Rotation — 2026-08-07

The deployer private key had been sitting in this public repo's history since
May. It was rotated on 2026-08-07. This is what was found and what was done,
including the parts that were worse than expected.

## The leak

```
commit 1d8536e (2026-05-28)
const wallet = new ethers.Wallet('0x2b94ce61…0ec0d', provider);
```

That key derives `0xE80A81360608C1342e66743F70a00f75d792Eb93` — the deployer,
owner of nearly every contract on both chains and the x402 payout address.
Deleting the file did nothing; the history is in every clone and fork.

## What made it urgent

The account was **already taken over** when the rotation ran. It carried an
EIP-7702 delegation:

```
cast code 0xE80A…Eb93
0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

`0xef0100` is the EIP-7702 delegation designator; the trailing 20 bytes are a
sweeper bot's contract. On a public testnet, bots watch every address whose key
has ever appeared in public and claim it. This one had.

Nothing had been drained yet — 0.22 ETH and 64.96M PEPE were still there — but
that was timing, not safety.

The same class of failure had already cost money hours earlier: `SeedWhales.s.sol`
derived its twelve demo traders from Anvil's default mnemonic, whose keys are
equally public. All twelve were delegated to sweepers (nonces in the thousands),
and 0.33 ETH of funding vanished without seeding a single position. Fixed
separately by moving the script to a private `SEED_MNEMONIC`.

## Two bugs the rotation exposed

**The target list was six contracts short.** `RotateOwnership.s.sol` had slots
for all 21 contracts, but `rotate-key.sh` only exported twelve addresses. The six
deployed earlier that same day — MockUSDT, ESGRegistry, PepeClaim,
EsgRewardDistributor, PepeStaking, AssetVault — were missing. A rotation run
before this was noticed would have printed success and left six contracts on the
leaked key. Caught by calling `owner()` on each contract rather than trusting the
script's list.

**Batched nonces are rejected for delegated accounts.** The first execute
attempt failed with `gapped-nonce tx from delegated accounts`. Forge pre-assigns
nonces across a broadcast batch; Base requires strictly sequential nonces from
7702-delegated accounts. `--slow` waits for each receipt, so nonces stay
sequential. The flag is now in the script with the reason recorded — it is a
correctness requirement here, not a speed trade-off.

## Result, verified on chain

New owner: `0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585`
Private key in `contracts/.env.rotation` (mode 600, gitignored, never printed).

| Check | Result |
|---|---|
| Contracts moved to new owner | 18 targets, all confirmed by `owner()` |
| The six late additions | 6/6 moved |
| Contracts still on the leaked key | 0 |
| ETH | 0.213 moved, 0.01 left as gas buffer |
| PEPE | 64.96M moved, 0 remaining |
| MockUSDC / official USDC | swept |

MockOracle was deliberately excluded: its owner is already the separated keeper
key, and rotating it would have broken the price feed.

## What is still true

The leaked key remains public forever and the account is still delegated to a
sweeper. It now owns nothing and holds only a gas dust balance. Never send
anything to it again.

The new key is a single EOA, not a multisig — the same limitation recorded in
`KNOWN_LIMITATIONS.md` #13. Rotating away from a compromised key and holding the
replacement properly are two different problems; only the first is solved here.
