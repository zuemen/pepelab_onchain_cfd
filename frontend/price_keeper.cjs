const { ethers } = require('ethers');
// Price data source: Binance Public API (free, no API key required)
// Docs: https://binance-docs.github.io/apidocs/spot/en/#symbol-price-ticker

process.on('uncaughtException', (err) => {
  console.error('*** Uncaught Exception caught to prevent crash ***:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('*** Unhandled Rejection caught to prevent crash at:', promise, 'reason:', reason);
});

const provider = new ethers.JsonRpcProvider('https://sepolia.infura.io/v3/7cdfb4923cee46ed9238a5181e4e9a4d');
const wallet = new ethers.Wallet('0x2b94ce61c754caa8138bd62a86b8665afdbbe70c87bed997d91c5bcd90a0ec0d', provider);

const ORACLE_ADDR = '0x17CA20A37Cf04F2f589B2573EC95f1411D29d958';

const oracleAbi = [
  'function updatePrice(bytes32 assetId, uint256 newPrice) external',
  'function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)'
];

const ASSET_IDS = {
  sBTC:   "0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1",
  sETH:   "0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9",
  sAAPL:  "0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220",
  sTSLA:  "0xd3cea6476633c192bfd36c9af4a9d0ee6e1863484325ee0f546a36393d1df1e9",
  sGOLD:  "0x12b611f69af3b5e84f9d2d8a8818b4ad7f2cf0b45274bc7c3b9616f67c7baa1a",
  sBOND:  "0xc310184149786e37d3493804e896dd8582e216011114ff6a7b6b8c02678bf6bb",
  sNVDA:  "0x59367feafbd2791db3a7462e596e9514b8f32a0dd24dcb4fd34af4725e59388d",
  sMSFT:  "0x9148a0fa033f72a846b348bb77b949e9dde2f4cd70a6045eb9e25ee5215b5b0b",
  sGOOGL: "0xa0934421d87a4a6d14ebffa8df8f7aeda1ab515b1a348ca82620b23a527b6875",
  sICLN:  "0x61663214831fdd7b1dd003226fb7436774c5b030f5858cf47d7aee23934564cb",
  sESGU:  "0x5820b70264a0c106d7ef7036e13c03b5d9018e2b51178ed68526cf915d594ca2",
};

const BASE_PRICES = {
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

let cachedBinancePrices = null;
let lastBinanceFetchTime = 0;

async function fetchBinancePrices() {
  const now = Date.now();
  // Cache for 10 seconds to avoid spamming the Binance public API
  if (cachedBinancePrices && (now - lastBinanceFetchTime < 10000)) {
    return cachedBinancePrices;
  }
  try {
    // Batch fetch BTC and ETH from Binance (free, no API key)
    const symbols = ['BTCUSDC', 'ETHUSDC'];
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const res = await fetch(url);
    if (!res.ok) {
      // Fallback: fetch individually
      const result = { BTC: null, ETH: null };
      for (const sym of symbols) {
        try {
          const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
          if (r.ok) {
            const d = await r.json();
            if (sym === 'BTCUSDC') result.BTC = parseFloat(d.price);
            if (sym === 'ETHUSDC') result.ETH = parseFloat(d.price);
          }
        } catch { /* skip */ }
      }
      if (result.BTC || result.ETH) {
        cachedBinancePrices = result;
        lastBinanceFetchTime = now;
      }
      return cachedBinancePrices;
    }
    const json = await res.json();
    const priceMap = {};
    for (const t of json) priceMap[t.symbol] = parseFloat(t.price);
    cachedBinancePrices = {
      BTC: priceMap['BTCUSDC'] || null,
      ETH: priceMap['ETHUSDC'] || null,
    };
    lastBinanceFetchTime = now;
    return cachedBinancePrices;
  } catch (e) {
    console.error('  -> Failed to fetch from Binance:', e.message || e);
    return cachedBinancePrices;
  }
}

let isTicking = false;

async function updateOraclePrices() {
  if (isTicking) {
    console.log('Skipping tick: Previous tick is still running...');
    return;
  }
  isTicking = true;

  try {
    console.log('\n--- Ticking Price Keeper Bot (' + new Date().toLocaleTimeString() + ') ---');
    const oracle = new ethers.Contract(ORACLE_ADDR, oracleAbi, wallet);

    // Fetch real-time BTC and ETH from Binance (free, no API key)
    const binancePrices = await fetchBinancePrices();
    const liveBtc = binancePrices ? binancePrices.BTC : null;
    const liveEth = binancePrices ? binancePrices.ETH : null;

    for (const [key, id] of Object.entries(ASSET_IDS)) {
      try {
        let targetPrice = BASE_PRICES[key];
        let source = 'Default';
        
        if (key === 'sBTC' && liveBtc) {
          targetPrice = liveBtc;
          source = 'Binance Spot';
        } else if (key === 'sETH' && liveEth) {
          targetPrice = liveEth;
          source = 'Binance Spot';
        } else {
          // Other assets: use a dynamic random walk based on baseline
          const wiggle = 1 + (Math.random() - 0.5) * 0.003; // +/- 0.15%
          targetPrice = BASE_PRICES[key] * wiggle;
          source = 'Random Walk';
        }

        // Read current on-chain price and last updated time
        const [rawPrice, rawUpdatedAt] = await oracle.getPrice(id);
        const currentPrice = Number(rawPrice) / 1e8;
        const lastUpdated = Number(rawUpdatedAt);
        
        // Calculate deviation and elapsed time
        const priceDiffPercent = currentPrice > 0 ? Math.abs(targetPrice - currentPrice) / currentPrice : 1;
        const secondsElapsed = Math.floor(Date.now() / 1000) - lastUpdated;
        
        const DEVIATION_THRESHOLD = 0.001; // 0.1% change triggers update
        const HEARTBEAT_INTERVAL = 300;     // 5 minutes (300s) triggers update regardless of deviation

        const needsUpdate = priceDiffPercent >= DEVIATION_THRESHOLD || secondsElapsed >= HEARTBEAT_INTERVAL;

        console.log(`[${source}] ${key.padEnd(5)} | Live: $${targetPrice.toFixed(2)} | On-Chain: $${currentPrice.toFixed(2)} | Dev: ${(priceDiffPercent * 100).toFixed(3)}% | Age: ${secondsElapsed}s | Needs Update: ${needsUpdate}`);

        if (needsUpdate) {
          const price8 = BigInt(Math.round(targetPrice * 1e8));
          const tx = await oracle.updatePrice(id, price8);
          console.log(`  -> Sending update tx: ${tx.hash}`);
          await tx.wait();
          console.log(`  -> ${key} updated successfully on-chain ✓`);
        }
      } catch (e) {
        console.error(`  -> Failed to tick ${key}:`, e.message || e);
      }
    }
  } catch (outerErr) {
    console.error('Outer execution error in price keeper:', outerErr.message || outerErr);
  } finally {
    isTicking = false;
  }
}

async function main() {
  console.log('Starting automated gas-optimized Price Keeper Bot (Binance Edition) on Sepolia...');
  console.log('Oracle address:', ORACLE_ADDR);
  console.log('Keeper wallet: ', wallet.address);

  // Run immediately on start
  await updateOraclePrices().catch(console.error);

  // Run every 60 seconds
  setInterval(async () => {
    await updateOraclePrices().catch(console.error);
  }, 60000);
}

main().catch(console.error);
