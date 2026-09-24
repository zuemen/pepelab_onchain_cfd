# x402 Signal API — Cost Model

What one paid call costs the seller in gas, on today's testnet setup and on a
hypothetical Base mainnet deployment with a self-hosted facilitator. Every input
is either read from this repository, measured on Base Sepolia, or taken from the
external facilitator load-test sheet and labelled as such. Prices are unchanged
by this document: `/signals` $0.01, `/oracle` $0.005 (`app.ts:52-53`).

## How one paid call moves money

1. The buyer signs an EIP-3009 `transferWithAuthorization`. The **facilitator**
   submits it and pays its gas; USDC lands in `payTo` (`KNOWN_LIMITATIONS.md` §19).
2. Our middleware queues a ledger entry once the facilitator reports success
   (`app.ts:249-284`).
3. The settlement worker later sends **one `FeeRouter.routeExternalRevenue`
   transaction per entry** from the treasury wallet, which pays that gas
   (`settlement-worker.ts:56-57`, `settlement.ts:153-154`). It routes the full
   price: 70% trader, 20% platform, 10% vault (`settlement.ts:116`).
4. One-off: the first run needs an `approve(MaxUint256)` (`settlement.ts:147-151`).
   On the official-USDC router there is no `mint` — that path is MockUSDC-only
   (`settlement.ts:125-127`).

So each paid call is **two on-chain transactions**. Today the seller pays for
one of them; with a self-hosted facilitator it pays for both.

## Measured on-chain

Base Sepolia, read from the public Blockscout API on 2026-09-23. Gas price on
every transaction: 0.006 gwei.

| Transaction | Sender (pays gas) | gasUsed | Total fee | of which L1 fee |
|---|---|---|---|---|
| EIP-3009 settle, $0.005 | facilitator `0xd407…f1bf` | 83,648 – 83,672 | 513.2 – 530.0 gwei | 11.3 – 28.0 gwei |
| EIP-3009 settle, $0.01 | facilitator `0xd407…f1bf` | 91,272 | 559.3 – 560.7 gwei | 11.6 – 13.1 gwei |
| `routeExternalRevenue`, known trader | treasury | 96,671 – 96,911 | 586.1 – 587.4 gwei | 5.9 – 6.1 gwei |
| `routeExternalRevenue`, new trader slot | treasury | 113,771 | 688.4 gwei | 5.7 gwei |
| `routeExternalRevenue`, first ever call | treasury | 182,411 | 1,187.3 gwei | 92.8 gwei |

The x402 FeeRouter (`0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d`) has exactly
four `routeExternalRevenue` calls in its history. Transactions used above:

- `routeExternalRevenue` (sender treasury `0xE80A81360608C1342e66743F70a00f75d792Eb93`):
  - 2026-06-15 `0xe014eb3c90f62a79b49efa0d28fc07b56ac7477272a99aab2507983b181dbef6` (182,411 gas)
  - 2026-06-16 `0x518cc7ae4f3b16d03e18b937fc5246df0d0928d1a81cfbc7da0431a50bc525e5` (96,911 gas)
  - 2026-07-15 `0xfc61abce56f3c4cc1be4c4efb3e8d140999701f13ccf56d35a43bfa221ce1939` (113,771 gas, trader `0x0`)
  - 2026-07-15 `0xba22cd5027e7992f41ef650b8ebae85a0797f1352f02a991c0861fc163d09189` (96,671 gas, trader `0x0`)
- EIP-3009 `transferWithAuthorization` (sender facilitator `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`):
  - 2026-06-22 `0xb8b9c9fe045536172f1a5c36c80e2ccc1919230b6a63aa531d409c589c344710` ($0.005, 83,648 gas)
  - 2026-06-23 `0x8561821d0ea7a1cf68c2f74674c73841a09545bb350b81af47692c22e03d38fb` ($0.005, 83,672 gas)
  - 2026-07-15 `0x2590feb209b0dc15b8578aa96db3d4121d6b71f1880f62369014473b987456d4` ($0.01, 91,272 gas)
  - 2026-07-15 `0x9e0a6a048111de0d2c8a70cdbce83c4083d471a94c34de6d39679a2a80b90f81` ($0.01, 91,272 gas)

The measured EIP-3009 L1 fee (11–28 gwei) is **above** the load-test sheet's
8 gwei budget; the router's (≈6 gwei) is within it.

## Assumptions

| Symbol | Value | Source |
|---|---|---|
| Effective L2 gas price | 0.006 gwei × 1.3 = 0.0078 gwei | load-test sheet; 0.006 matches every tx above |
| L1 data fee per tx | 4.0 gwei × 2 = 8 gwei | load-test sheet |
| Per-tx budget | `gasUsed × 0.0078 + 8` gwei | load-test sheet's method |
| EIP-3009 budget gas | 120,000 | load-test sheet (upper bound of 110k–120k) |
| `routeExternalRevenue` gas | 96,911 | measured, known-trader case above |
| ETH → NT$ | 78,057 | load-test sheet |
| ETH → US$ | 2,119 | implied by the sheet's "9.44E-07 ETH ≈ US$0.002" (1 gwei ≈ US$2.1186E-06) |
| Platform take | 20% of price | `onchainRevenue.ts:4-5` |

The US$ rate is the sheet's own rounding, not a market quote. Every US$ figure
below scales linearly with it.

## Per-transaction cost

| Transaction | Formula | gwei | ETH | NT$ | US$ |
|---|---|---|---|---|---|
| EIP-3009 settle (budget) | 120,000 × 0.0078 + 8 | 944.0 | 9.44E-07 | 0.0737 | 0.00200 |
| `routeExternalRevenue` (budget) | 96,911 × 0.0078 + 8 | 763.9 | 7.64E-07 | 0.0596 | 0.00162 |
| EIP-3009 settle (measured max, no buffer) | — | 560.7 | 5.61E-07 | 0.0438 | 0.00119 |
| `routeExternalRevenue` (measured, no buffer) | — | 587.4 | 5.87E-07 | 0.0459 | 0.00124 |
| Ethereum L1 EIP-3009, for comparison | 180,000 × 0.889 × 1.3 | 208,026 | 2.08E-04 | 16.24 | 0.441 |

Ethereum is ≈220× the Base budget (208,026 / 944). Nothing below assumes Ethereum.

## Price vs seller gas, per endpoint

Seller gas per paid call:

- **Testnet today:** the router transaction only = 763.9 gwei (budget). The
  facilitator pays the other one. Testnet ETH has no market value, so the real
  cost is $0; the column prices it at the mainnet assumptions to show the shape.
- **Base mainnet, self-hosted facilitator:** EIP-3009 + router = 944.0 + 763.9 =
  1,707.9 gwei (budget) = US$0.00362.

| | `/signals` | `/oracle` |
|---|---|---|
| Price | $0.01 | $0.005 |
| Platform's 20% | $0.002 | $0.001 |
| **Testnet today** — seller gas (router tx, mainnet-priced) | $0.00162 (16.2% of price) | $0.00162 (32.4% of price) |
| **Base mainnet, self-hosted** — seller gas (both txs, budget) | $0.00362 (36.2% of price) | $0.00362 (72.4% of price) |
| Platform net per call on mainnet (20% − gas, budget) | **−$0.00162** | **−$0.00262** |
| Same, measured fees without buffers (1,148.1 gwei = $0.00243) | −$0.00043 | −$0.00143 |

The seller absorbs all gas while keeping only 20% of the price, because the
split routes the full amount (`settlement.ts:116`). **At these assumptions, a
self-hosted mainnet deployment loses money on every paid call on both
endpoints.** This is a statement about the cost structure, not a pricing
proposal.

## If this moves to Base mainnet

- **Faucet rate limits disappear.** `agent/.env.example` funds testing from the
  Base faucet (ETH) and Circle's faucet (USDC). On mainnet both are bought, so
  that operational limit goes away.
- **Both transactions become real costs.** Using the public facilitator is a
  testnet-only option (§19); self-hosting means paying the EIP-3009 gas in the
  table above in addition to the router gas we already pay.
- **Batching helps only the router half.** See `NEXT_STEPS.md`, "x402 settlement
  is one transaction per payment". The EIP-3009 transaction is per payment by
  construction of the x402 v1 `exact` scheme.

## Capacity

**Not load-tested to 100 TPS.** The bottleneck is this service's serialized
settlement, not the Base chain.

### Settlement worker ceiling (from configuration, not measured)

The worker takes at most `SETTLEMENT_BATCH_SIZE` entries per run (default 25,
`settlement-worker.ts:43`) and runs on `*/10 * * * *` (§14): **150 settled
payments per hour ≈ 0.04 per second.** Above that sustained rate the queue grows
without bound — entries are not lost, they wait. Raising the batch size does not
remove the ceiling: entries are processed one after another, each awaiting its
own receipt (`settlement.ts:154`), so one signer cannot exceed roughly one
settlement per Base block (≈2 s), i.e. ≈0.5/s, before counting RPC round-trips.
100 TPS would be ~200× that.

### Request path

Every paid request also waits for the facilitator's `/settle`, which waits for
the EIP-3009 receipt (x402-hono `index.mjs:155`), so a paid call cannot return
faster than one Base block. The facilitator's own rate limit is unknown (§16).

Concurrency run, 2026-09-24, `probe-facilitator.ts MODE=concurrency`, 20
requests per level, unpaid `GET /oracle/sBTC` against a local server (this is
the freshness gate's 2 RPC reads + the 402 challenge; no payment, no USDC moved).
Ran against `npm run start` in `agent/signal-api` on localhost, `/healthz`
returned 200 before the run. Every sample returned 402, never 503
`price_stale`, never a connection failure (`status:0`). A direct read of the
same two calls the gate makes (`oracle.getPrice(sBTC)`, `perp.maxPriceAge()`)
through the same RPC on 2026-09-24 succeeded (price age 5,611 s < maxPriceAge
21,600 s), consistent with the gate reading a fresh price. The probe itself
cannot distinguish that from a swallowed RPC error, because the gate falls
through to 402 on any read failure (`app.ts:622-624`).

| Concurrency | n | p50 | p95 | Throughput | Status distribution |
|---|---|---|---|---|---|
| 1 | 20 | 302 ms | 346 ms | 3.19 req/s | {"402":20} |
| 5 | 20 | 335 ms | 941 ms | 8.62 req/s | {"402":20} |
| 10 | 20 | 286 ms | 1438 ms | 10.79 req/s | {"402":20} |

`settleError` is not counted: since §14 the request path sends no transactions,
so `nonce too low` / `replacement transaction underpriced` cannot occur there.
The only `settleError` the request path can produce is an Upstash write failure.

### Alchemy CU per request

`batchMaxCount: 1` (`provider.ts:33`) sends every call as its own HTTP request;
`staticNetwork: true` means no `eth_chainId` probe.

**Request path, one paid `/oracle` call** (the 402 challenge plus the paid retry):

| Step | Method | Count | Source |
|---|---|---|---|
| Freshness gate on the 402 challenge | eth_call | 2 | `app.ts:597-600` |
| Freshness gate again on the paid retry | eth_call | 2 | same middleware, every request |
| `getOracleSnapshot` | eth_call | 6 | `aggregate.ts:239-246` |
| `resolveTrader` (only if `DEMO_TRADER_ADDRESS` is unset) | eth_call | 0–1 | `app.ts:132` |
| **Total** | | **10–11 × 26 = 260–286 CU** | |

**Request path, one paid `/signals` call:** `/signals/*` has no freshness gate —
its middleware (`app.ts:567-590`) only regex-validates the trader address, no
RPC. The count is entirely `getTraderPerformance`'s (`aggregate.ts:333-429`)
calls:

| Step | Method | Count | Source |
|---|---|---|---|
| Trader profile + eligibility + strategy count | `traders`, `isEligibleTrader`, `getStrategyCount` | 3 | `aggregate.ts:342-344` |
| `getUserPositions` | `getUserPositions` | 1 | `aggregate.ts:366` |
| `getLatestStrategy` (only if `getStrategyCount` > 0) | `getLatestStrategy` | 0–1 | `aggregate.ts:353` |
| `getFundingRate` per strategy leg (only if a strategy exists) | `getFundingRate` | 0–L | `aggregate.ts:390` |
| `getPositionDetail` per position | `getPosition`, `getUnrealizedPnL`, `pendingFunding` | 3 × positions | `aggregate.ts:308-312` |
| **Total** | | **(4 + s×(1+L) + 3×positions) eth_calls**, s∈{0,1} = has a registered strategy, L = that strategy's leg count | |

CU = eth_calls × 26. For a trader with no strategy and 0 positions: 4 × 26 =
**104 CU**. For a trader with a 2-leg strategy and 3 open/closed positions:
(4 + 1×(1+2) + 3×3) × 26 = 16 × 26 = **416 CU**.

**Settlement worker, per entry** (steady state: allowance already set):

| Method | Count | CU |
|---|---|---|
| eth_call (`decimals`, `balanceOf`, `allowance`) | 3 | 78 |
| eth_sendRawTransaction | 1 | 40 |
| eth_getTransactionReceipt | ≥ 1 | ≥ 20 |
| `eth_getTransactionCount`, `eth_estimateGas`, `eth_getBlockByNumber`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_blockNumber` | 1 each | not priced by the sheet |
| **Lower bound** | | **≥ 138 CU** |

Confirmed by reading `agent/node_modules/ethers/lib.esm/providers/abstract-signer.js`
(`populateTransaction`, lines 62–171: `getNonce` → `eth_getTransactionCount` at
line 66, `estimateGas` → `eth_estimateGas` at line 69, `getFeeData` at lines 95
and 106; `sendTransaction`, lines 194–200) and
`agent/node_modules/ethers/lib.esm/providers/abstract-provider.js`
(`getFeeData`, lines 639–679: `eth_getBlockByNumber` via `#getBlock("latest", …)`
at line 643, `eth_gasPrice` at line 646, `eth_maxPriorityFeePerGas` at line 654;
`broadcastTransaction`, lines 790–804: `eth_blockNumber` via `getBlockNumber()`
at line 792, `eth_sendRawTransaction` via `_perform({ method:
"broadcastTransaction" })` at line 794). `staticNetwork: true` means
`getNetwork()` inside `populateTransaction` does not add an `eth_chainId` call.
These six methods are marked "not priced by the sheet" — not counted in the
lower bound, treated as a gap.

Plus one `FeeRouter.usdc()` eth_call per worker run (`settlement.ts:89`, cached).

**At 10 paid `/oracle` calls per second:** request path 2,600–2,860 CUPS. The
worker could not keep up at that rate (ceiling above); if it could, it would
add ≥ 1,380 CUPS.
