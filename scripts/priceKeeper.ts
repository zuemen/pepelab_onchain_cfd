/**
 * PepeLab Dynamic Price Oracle Keeper
 *
 * Fetches real-time prices from Binance public API (free, no API key required)
 * and pushes them on-chain to MockOracle every 30 seconds.
 *
 * Supported chains: Sepolia (11155111) and Base Sepolia (84532).
 * Usage:
 *   1. Copy .env.example → .env and fill in RPC_URL + KEEPER_PRIVATE_KEY
 *   2. npx tsx scripts/priceKeeper.ts
 *
 * Gas optimization: only updates when price deviation ≥ 0.1% or 5 min heartbeat.
 */
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load .env from project root ────────────────────────────────────────────
const __here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__here, "../contracts/.env") });

// ── Crash-safe handlers ────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("*** Uncaught Exception caught to prevent crash ***:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "*** Unhandled Rejection caught to prevent crash at:",
    promise,
    "reason:",
    reason
  );
});

// ── Configuration ──────────────────────────────────────────────────────────
const CHAIN = process.env.KEEPER_CHAIN ?? "sepolia"; // "sepolia" | "base-sepolia"
const RPC_URL =
  CHAIN === "base-sepolia"
    ? process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org"
    : process.env.SEPOLIA_RPC_URL ?? "";
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? "";

if (!RPC_URL) {
  console.error("❌ RPC_URL is not set. Please configure SEPOLIA_RPC_URL or BASE_SEPOLIA_RPC_URL in contracts/.env");
  process.exit(1);
}
if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length !== 66) {
  console.error("❌ KEEPER_PRIVATE_KEY (or PRIVATE_KEY) is not set or invalid in contracts/.env");
  process.exit(1);
}

// Oracle addresses per chain
const ORACLE_ADDRESSES: Record<string, string> = {
  sepolia: "0x17CA20A37Cf04F2f589B2573EC95f1411D29d958",
  "base-sepolia": "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3",
};
const ORACLE_ADDR = process.env.ORACLE_ADDRESS ?? ORACLE_ADDRESSES[CHAIN] ?? "";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const oracleAbi = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];

// ── On-chain reference feed (Chainlink / Pyth via AggregatorOracleAdapter) ──
//
// PerpetualExchange.oracle is `immutable`, so the exchange can never be pointed
// at Chainlink or Pyth without a redeploy that would destroy every open
// position. It can, however, be fed BY them: the adapters are already deployed
// and queryable, and the exchange reads whatever MockOracle holds.
//
// So when RELAY_SOURCE is set, this keeper reads the aggregator on chain and
// relays that price into MockOracle instead of using a CEX API. The exchange
// then settles on a decentralized feed at one remove.
//
// Be precise about what this is: a trusted relay, not a trustless integration.
// The keeper key can still write whatever it likes. It removes the dependency
// on a centralised exchange API, not the dependency on the keeper.
const RELAY_SOURCE = process.env.RELAY_SOURCE ?? "";

const aggregatorAbi = [
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
  "function isStale(bytes32 assetId) view returns (bool)",
];

// ── GuardedOracle mirror ────────────────────────────────────────────────────
//
// The V2 stack prices off GuardedOracle, not MockOracle, and GuardedOracle
// fails closed: getPrice REVERTS once a price ages past maxPriceAge rather than
// returning stale data. AssetVaultV2.outstandingValue() calls it directly, so a
// stale price takes down reserveRatioBps() and mint() with it — V2 stops
// working entirely.
//
// Nothing was keeping it fresh, because this keeper only ever wrote MockOracle.
// So mirror every update into GuardedOracle when GUARDED_ORACLE is configured.
//
// Two ways a mirrored write legitimately fails, neither of which should stop
// the keeper:
//   - the asset was never added to GuardedOracle (AssetNotFound)
//   - the move exceeds its per-update deviation cap (DeviationTooLarge) — that
//     is the guard doing its job, and clamping the number to sneak past it
//     would defeat the point
const GUARDED_ORACLE = process.env.GUARDED_ORACLE ?? "";

const guardedOracleAbi = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function peek(bytes32 assetId) view returns (uint256 price, uint256 updatedAt, bool exists, bool frozen)",
];

/** Mirror one price into GuardedOracle. Never throws. */
async function mirrorToGuarded(
  assetId: string,
  key: string,
  price8: bigint
): Promise<void> {
  if (!GUARDED_ORACLE) return;
  try {
    const g = new ethers.Contract(GUARDED_ORACLE, guardedOracleAbi, wallet);
    const [, , exists, frozen] = (await g.peek(assetId)) as [
      bigint,
      bigint,
      boolean,
      boolean,
    ];
    if (!exists) return;                       // not registered there
    if (frozen) {
      console.log(`  -> ${key} frozen on GuardedOracle, skipping mirror`);
      return;
    }
    const tx = await g.updatePrice(assetId, price8);
    await tx.wait();
    console.log(`  -> ${key} mirrored to GuardedOracle ✓`);
  } catch (e) {
    // Deviation cap rejections are expected and healthy — log, do not retry
    // with a massaged number.
    console.log(`  -> ${key} GuardedOracle mirror skipped: ${(e as Error).message.slice(0, 90)}`);
  }
}

/** Read one asset from the on-chain reference feed. null when unavailable. */
async function fetchFromRelay(assetId: string): Promise<number | null> {
  if (!RELAY_SOURCE) return null;
  try {
    const agg = new ethers.Contract(RELAY_SOURCE, aggregatorAbi, provider);
    const stale = (await agg.isStale(assetId)) as boolean;
    if (stale) return null;
    const [raw] = (await agg.getPrice(assetId)) as [bigint, bigint];
    const p = Number(raw) / 1e8;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    // Adapter has no feed for this asset (most equities), or the call reverted.
    return null;
  }
}

// ── Asset IDs (keccak256 of symbol string — must match Deploy.s.sol) ──────
const ASSET_IDS: Record<string, string> = {
  sBTC: "0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1",
  sETH: "0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9",
  sAAPL: "0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220",
  sTSLA: "0xd3cea6476633c192bfd36c9af4a9d0ee6e1863484325ee0f546a36393d1df1e9",
  sGOLD: "0x12b611f69af3b5e84f9d2d8a8818b4ad7f2cf0b45274bc7c3b9616f67c7baa1a",
  sBOND: "0xc310184149786e37d3493804e896dd8582e216011114ff6a7b6b8c02678bf6bb",
  sNVDA: "0x59367feafbd2791db3a7462e596e9514b8f32a0dd24dcb4fd34af4725e59388d",
  sMSFT: "0x9148a0fa033f72a846b348bb77b949e9dde2f4cd70a6045eb9e25ee5215b5b0b",
  sGOOGL: "0xa0934421d87a4a6d14ebffa8df8f7aeda1ab515b1a348ca82620b23a527b6875",
  sICLN: "0x61663214831fdd7b1dd003226fb7436774c5b030f5858cf47d7aee23934564cb",
  sESGU: "0x5820b70264a0c106d7ef7036e13c03b5d9018e2b51178ed68526cf915d594ca2",
};

// Fallback base prices for assets Binance doesn't cover (non-crypto synthetics)
const BASE_PRICES: Record<string, number> = {
  sBTC: 73190,
  sETH: 1987,
  sAAPL: 200,
  sTSLA: 250,
  sGOLD: 2650,
  sBOND: 100,
  sNVDA: 1100,
  sMSFT: 415,
  sGOOGL: 170,
  sICLN: 13,
  sESGU: 45,
};

// Binance public API symbols → our synthetic mapping
const BINANCE_SYMBOL_MAP: Record<string, string> = {
  sBTC: "BTCUSDC",
  sETH: "ETHUSDC",
};

// ── Binance Price Fetcher (free, no API key) ───────────────────────────────
interface BinanceTicker {
  symbol: string;
  price: string;
}

let cachedBinancePrices: Record<string, number> | null = null;
let lastBinanceFetch = 0;
const BINANCE_CACHE_TTL = 10_000; // 10 seconds

async function fetchBinancePrices(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedBinancePrices && now - lastBinanceFetch < BINANCE_CACHE_TTL) {
    return cachedBinancePrices;
  }

  const symbols = Object.values(BINANCE_SYMBOL_MAP);
  const result: Record<string, number> = {};

  try {
    // Fetch all symbols in one batch request
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const res = await fetch(url);

    if (!res.ok) {
      // Fallback: fetch individually
      for (const sym of symbols) {
        try {
          const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
          if (r.ok) {
            const data = (await r.json()) as BinanceTicker;
            result[data.symbol] = parseFloat(data.price);
          }
        } catch {
          /* skip individual failures */
        }
      }
    } else {
      const data = (await res.json()) as BinanceTicker[];
      for (const t of data) {
        result[t.symbol] = parseFloat(t.price);
      }
    }

    if (Object.keys(result).length > 0) {
      cachedBinancePrices = result;
      lastBinanceFetch = now;
    }
    return result;
  } catch (e) {
    console.error("  -> Failed to fetch from Binance:", (e as Error).message);
    return cachedBinancePrices ?? {};
  }
}

// ── Coinbase Price Fetcher (preferred: free, no key, generous rate limits) ──
// Keyed by the same Binance symbols as fetchBinancePrices so the caller's
// lookup through BINANCE_SYMBOL_MAP works for either source.
const COINBASE_PRODUCT_MAP: Record<string, string> = {
  BTCUSDC: "BTC-USD",
  ETHUSDC: "ETH-USD",
};

interface CoinbaseTicker {
  price?: string;
}

async function fetchCoinbasePrice(product: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${product}/ticker`,
      { headers: { "User-Agent": "pepefi-price-keeper" } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as CoinbaseTicker;
    const p = data.price ? parseFloat(data.price) : NaN;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// Which source each symbol actually came from on the last fetch — purely for
// the log line, so it never claims Coinbase when Binance answered.
let lastCryptoSource: Record<string, string> = {};

/**
 * Crypto spot prices, Coinbase first with Binance as fallback. Only the symbols
 * Coinbase couldn't answer are requested from Binance.
 */
async function fetchCryptoPrices(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  lastCryptoSource = {};

  await Promise.all(
    Object.entries(COINBASE_PRODUCT_MAP).map(async ([sym, product]) => {
      const p = await fetchCoinbasePrice(product);
      if (p !== null) {
        out[sym] = p;
        lastCryptoSource[sym] = "Coinbase";
      }
    })
  );

  const missing = Object.values(BINANCE_SYMBOL_MAP).filter(
    (s) => out[s] === undefined
  );
  if (missing.length === 0) return out;

  console.log(`  -> Coinbase missing ${missing.join(", ")}; falling back to Binance`);
  const binance = await fetchBinancePrices();
  for (const s of missing) {
    if (binance[s] !== undefined) {
      out[s] = binance[s];
      lastCryptoSource[s] = "Binance Spot";
    }
  }
  return out;
}

// ── Oracle Update Logic ────────────────────────────────────────────────────
const DEVIATION_THRESHOLD = 0.001; // 0.1% price change triggers update
const HEARTBEAT_INTERVAL = 300; // 5 minutes triggers update regardless
const TICK_INTERVAL = 30_000; // 30 seconds between ticks

let isTicking = false;

async function updateOraclePrices(): Promise<void> {
  if (isTicking) {
    console.log("Skipping tick: Previous tick is still running...");
    return;
  }
  isTicking = true;

  try {
    console.log(
      `\n--- Ticking Price Keeper Bot (${new Date().toLocaleTimeString()}) [${CHAIN}] ---`
    );
    const oracle = new ethers.Contract(ORACLE_ADDR, oracleAbi, wallet);

    // Real-time BTC and ETH — Coinbase preferred, Binance as fallback
    const cryptoPrices = await fetchCryptoPrices();

    for (const [key, id] of Object.entries(ASSET_IDS)) {
      try {
        let targetPrice = BASE_PRICES[key];
        let source = "Default";

        // Preferred: relay the on-chain decentralized feed, so the exchange
        // settles on Chainlink/Pyth data even though its oracle address is
        // immutable. Falls through when the adapter has no feed for this asset
        // (true for most equities on testnet) or reports itself stale.
        const relayed = await fetchFromRelay(id);

        const cryptoSymbol = BINANCE_SYMBOL_MAP[key];
        if (relayed !== null) {
          targetPrice = relayed;
          source = "Chainlink/Pyth";
        } else if (cryptoSymbol && cryptoPrices[cryptoSymbol]) {
          targetPrice = cryptoPrices[cryptoSymbol];
          source = lastCryptoSource[cryptoSymbol] ?? "Exchange";
        } else {
          // Other assets: use a dynamic random walk based on baseline
          const wiggle = 1 + (Math.random() - 0.5) * 0.003; // +/- 0.15%
          targetPrice = BASE_PRICES[key] * wiggle;
          source = "Random Walk";
        }

        // Read current on-chain price and last updated time
        const [rawPrice, rawUpdatedAt] = await oracle.getPrice(id);
        const currentPrice = Number(rawPrice) / 1e8;
        const lastUpdated = Number(rawUpdatedAt);

        // Calculate deviation and elapsed time
        const priceDiffPercent =
          currentPrice > 0
            ? Math.abs(targetPrice - currentPrice) / currentPrice
            : 1;
        const secondsElapsed = Math.floor(Date.now() / 1000) - lastUpdated;

        const needsUpdate =
          priceDiffPercent >= DEVIATION_THRESHOLD ||
          secondsElapsed >= HEARTBEAT_INTERVAL;

        console.log(
          `[${source.padEnd(12)}] ${key.padEnd(5)} | Live: $${targetPrice.toFixed(2)} | On-Chain: $${currentPrice.toFixed(2)} | Dev: ${(priceDiffPercent * 100).toFixed(3)}% | Age: ${secondsElapsed}s | ${needsUpdate ? "⚡ UPDATE" : "  skip"}`
        );

        if (needsUpdate) {
          const price8 = BigInt(Math.round(targetPrice * 1e8));
          const tx = await oracle.updatePrice(id, price8);
          console.log(`  -> Sending update tx: ${tx.hash}`);
          await tx.wait();
          console.log(`  -> ${key} updated successfully on-chain ✓`);

          // Keep the V2 stack alive. MockOracle's heartbeat (5 min) is well
          // inside GuardedOracle's staleness deadline (1 h), so following the
          // same trigger is enough to stop V2 mint from failing closed.
          await mirrorToGuarded(id, key, price8);
        }
      } catch (e) {
        console.error(`  -> Failed to tick ${key}:`, (e as Error).message);
      }
    }
  } catch (outerErr) {
    console.error(
      "Outer execution error in price keeper:",
      (outerErr as Error).message
    );
  } finally {
    isTicking = false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(
    `\n🐸 PepeLab Dynamic Price Keeper (Binance Edition) starting on ${CHAIN}…`
  );
  console.log(`   Oracle address : ${ORACLE_ADDR}`);
  console.log(`   Keeper wallet  : ${wallet.address}`);
  console.log(`   RPC            : ${RPC_URL}`);
  console.log(`   Tick interval  : ${TICK_INTERVAL / 1000}s`);
  console.log(`   Data source    : Binance Public API (free, no key)`);
  console.log(
    `   Assets         : BTC/ETH live · ${Object.keys(ASSET_IDS).length - 2} synthetics via random walk\n`
  );

  // Run immediately on start
  await updateOraclePrices().catch(console.error);

  // Run every 30 seconds
  setInterval(async () => {
    await updateOraclePrices().catch(console.error);
  }, TICK_INTERVAL);
}

main().catch(console.error);
