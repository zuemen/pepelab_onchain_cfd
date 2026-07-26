/**
 * PepeLab x402 Autonomous Agent — M2M Micro-Payment Workflow
 *
 * Demonstrates the complete x402 autonomous loop on Base Sepolia (84532):
 *   1. Agent discovers the signal-api endpoints (GET /)
 *   2. Attempts to fetch a paid signal → receives HTTP 402 (Payment Required)
 *   3. Uses Session Key to sign an EIP-3009 USDC micro-payment
 *   4. Re-sends the request with X-PAYMENT header → receives the signal
 *   5. (Optional) If a session is configured, autonomously opens a position
 *      via AgentSessionManager within budget/leverage constraints
 *
 * Prerequisites:
 *   - Node.js ≥ 20
 *   - npm install (from agent/ root)
 *   - AGENT_PRIVATE_KEY in agent/.env (EOA with Base Sepolia USDC + ETH)
 *
 * Usage:
 *   cd agent && npx tsx x402_agent.ts
 *   — or —
 *   npx tsx agent/x402_agent.ts
 */
import { createWalletClient, http, publicActions, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load env from agent/.env ───────────────────────────────────────────────
const __here = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__here, ".env") });

// ── Configuration ──────────────────────────────────────────────────────────
const API_URL =
  process.env.SIGNAL_API_URL?.trim() || "http://localhost:4021";
const PK = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
const RPC =
  process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const CHAIN_ID = 84532; // Base Sepolia

// Session Key configuration (Phase 2 — autonomous trading)
const SESSION_MANAGER =
  process.env.SESSION_MANAGER_ADDRESS?.trim() ||
  "0x5Ebcc64C712C5a26119789dCbD0753981dc518E8";
const SESSION_ID = process.env.DEMO_SESSION_ID?.trim();
const DEMO_MARGIN = Number(process.env.DEMO_MARGIN ?? "10");
const DEMO_ASSET = process.env.DEMO_ASSET ?? "sBTC";

// ABI fragments for on-chain interaction
const SESSION_MANAGER_ABI = [
  {
    name: "openPositionForSession",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "sessionId", type: "uint256" },
      { name: "asset", type: "bytes32" },
      { name: "isLong", type: "bool" },
      { name: "margin", type: "uint256" },
      { name: "leverage", type: "uint256" },
      { name: "copiedFrom", type: "address" },
    ],
    outputs: [{ name: "positionId", type: "uint256" }],
  },
  {
    name: "sessions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "user", type: "address" },
      { name: "agent", type: "address" },
      { name: "maxMarginPerTrade", type: "uint256" },
      { name: "totalMarginBudget", type: "uint256" },
      { name: "spentMargin", type: "uint256" },
      { name: "maxLeverage", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "revoked", type: "bool" },
    ],
  },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// ── Helpers ────────────────────────────────────────────────────────────────
function banner(title: string) {
  console.log("\n" + "═".repeat(68));
  console.log(`  ${title}`);
  console.log("═".repeat(68));
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

// ── Step 1: Discover API ───────────────────────────────────────────────────
async function discoverApi() {
  banner("① Discover Signal API");
  const res = await fetch(`${API_URL}/`);
  const data = await res.json() as any;
  console.log(`Service   : ${data.service}`);
  console.log(`Network   : ${data.network}`);
  console.log(`Pay To    : ${data.payTo}`);
  console.log(`Endpoints :`);
  for (const [path, info] of Object.entries(data.endpoints || {})) {
    const i = info as any;
    console.log(`  ${path.padEnd(30)} ${i.price.padEnd(8)} ${i.desc}`);
  }
  return data;
}

// ── Step 2: x402 Paid Signal Fetch ─────────────────────────────────────────
async function fetchPaidSignal(
  walletClient: any,
  traderAddress: string
): Promise<any> {
  banner("② Fetch Paid Signal (x402 micro-payment)");
  console.log(`Target    : ${API_URL}/signals/${traderAddress}`);
  console.log(`Price     : $0.01 USDC (Base Sepolia official USDC)`);

  // Dynamic import to handle x402-fetch
  let wrapFetchWithPayment: any;
  try {
    const x402Mod = await import("x402-fetch");
    wrapFetchWithPayment = x402Mod.wrapFetchWithPayment;
  } catch {
    console.log(
      "⚠ x402-fetch not installed. Run: npm install x402-fetch"
    );
    console.log(
      "  Falling back to direct API call (skipping x402 payment)..."
    );
    const res = await fetch(`${API_URL}/signals/${traderAddress}`);
    if (res.status === 402) {
      console.log("  ← Received HTTP 402 (Payment Required) as expected");
      console.log(
        "  The x402 protocol challenge is working. Install x402-fetch to auto-pay."
      );
      const body = await res.json().catch(() => ({}));
      console.log(
        `  Challenge details: ${JSON.stringify(body).slice(0, 200)}…`
      );
      return null;
    }
    return res.json();
  }

  // Wrap fetch to auto-handle 402 → sign USDC → retry
  const payFetch = wrapFetchWithPayment(
    fetch,
    walletClient as Parameters<typeof wrapFetchWithPayment>[1]
  );

  console.log("  Sending request (will auto-handle 402 challenge)...");
  const res = await payFetch(`${API_URL}/signals/${traderAddress}`, {
    method: "GET",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Signal API returned ${res.status}: ${errText}`);
  }

  const data = await res.json();
  console.log(`  ✓ Signal received successfully!`);
  if (data.settled) {
    console.log(`  ✓ On-chain 70/20/10 settlement confirmed`);
  }
  if (data.settlementTx) {
    console.log(
      `  ✓ Settlement tx: https://sepolia.basescan.org/tx/${data.settlementTx}`
    );
  }

  return data;
}

// ── Step 3: Analyze Signal & Decide ────────────────────────────────────────
interface TradeDecision {
  symbol: string;
  isLong: boolean;
  leverage: number;
}

function analyzeAndDecide(signalData: any): TradeDecision | null {
  banner("③ Agent Decision Engine");

  const perf = signalData?.data;
  if (!perf?.isRegistered) {
    console.log("✗ Trader not registered — SKIP ALL");
    return null;
  }

  const net = perf.positions?.netPnL ?? 0;
  console.log(
    `Trader "${perf.displayName}" net PnL: ${net.toFixed(2)} USDC`
  );
  console.log(
    `  Realized: ${(perf.positions?.realizedPnL ?? 0).toFixed(2)} | Unrealized: ${(perf.positions?.unrealizedPnL ?? 0).toFixed(2)}`
  );

  // Pick first non-headwind suggestion
  for (const s of perf.suggestion ?? []) {
    const follow = !s.fundingHeadwind && net >= 0;
    const verb = follow ? "✓ FOLLOW" : "✗ SKIP";
    console.log(
      `  ${verb}  ${s.asset} ${s.direction} ${s.leverage}x (weight ${s.weightPercent}%) — ${s.note}`
    );

    if (follow) {
      return {
        symbol: s.asset,
        isLong: s.direction === "long",
        leverage: s.leverage,
      };
    }
  }

  console.log("No suitable trades found — SKIP ALL");
  return null;
}

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
} as const;

// ── Step 4: Autonomous Trade via Session Key ───────────────────────────────
async function executeTradeViaSession(
  walletClient: any,
  trade: TradeDecision,
  traderAddress: string
): Promise<void> {
  banner("④ Autonomous Trade via Session Key");

  const desc = `${trade.symbol} ${trade.isLong ? "LONG" : "SHORT"} ${trade.leverage}x, margin ${DEMO_MARGIN} USDC`;

  if (!SESSION_ID || SESSION_MANAGER === ZERO_ADDR) {
    console.log("⚠ Session not configured (need SESSION_MANAGER_ADDRESS + DEMO_SESSION_ID)");
    console.log(`  Would have traded: ${desc} (simulated, not sent)`);
    return;
  }

  // Verify session is still active
  console.log(`  Verifying session #${SESSION_ID}...`);
  try {
    const sessionData = await walletClient.readContract({
      address: SESSION_MANAGER as `0x${string}`,
      abi: SESSION_MANAGER_ABI,
      functionName: "sessions",
      args: [BigInt(SESSION_ID)],
    });

    const [
      user,
      agent,
      maxMarginPerTrade,
      totalMarginBudget,
      spentMargin,
      maxLeverage,
      expiry,
      revoked,
    ] = sessionData as any;

    if (revoked) {
      console.log("  ✗ Session is revoked — cannot trade");
      return;
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now > expiry) {
      console.log("  ✗ Session is expired — cannot trade");
      return;
    }

    console.log(`  Session owner : ${shortAddr(user)}`);
    console.log(`  Session agent : ${shortAddr(agent)}`);
    console.log(
      `  Budget        : ${formatUnits(spentMargin, 18)} / ${formatUnits(totalMarginBudget, 18)} USDC`
    );
    console.log(`  Max leverage  : ${Number(maxLeverage)}x`);
    console.log(
      `  Expires       : ${new Date(Number(expiry) * 1000).toISOString()}`
    );
  } catch (err) {
    console.log(`  ✗ Failed to read session: ${(err as Error).message}`);
    console.log(`  Would have traded: ${desc} (simulated)`);
    return;
  }

  console.log(`\n  Executing: ${desc} (session #${SESSION_ID})…`);
  console.log(`  (Full on-chain execution via AgentSessionManager)`);
  
  const assetId = ASSET_IDS[trade.symbol as keyof typeof ASSET_IDS];
  if (!assetId) {
    console.log(`  ✗ Unknown asset symbol: ${trade.symbol}`);
    return;
  }

  // Resolve copiedFrom address
  const copiedFrom = traderAddress && traderAddress !== "0x0000000000000000000000000000000000000001"
    ? traderAddress
    : ZERO_ADDR;

  try {
    const marginWei = BigInt(Math.round(DEMO_MARGIN * 1e18));
    const txHash = await walletClient.writeContract({
      address: SESSION_MANAGER as `0x${string}`,
      abi: SESSION_MANAGER_ABI,
      functionName: "openPositionForSession",
      args: [
        BigInt(SESSION_ID),
        assetId as `0x${string}`,
        trade.isLong,
        marginWei,
        BigInt(trade.leverage),
        copiedFrom as `0x${string}`,
      ],
      value: 1000000000000000n, // 0.001 ETH execution fee
    });
    console.log(`  → Sent transaction: ${txHash}`);
    console.log(`  Waiting for transaction receipt...`);
    const receipt = await walletClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`  → Trade submitted to chain ✓ (Block #${receipt.blockNumber})`);
  } catch (writeErr) {
    console.error(`  ✗ Execution failed on-chain:`, (writeErr as Error).message || writeErr);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  banner("🐸 PepeLab x402 Autonomous Agent — Base Sepolia");

  // Validate private key
  const hasKey = PK.startsWith("0x") && PK.length === 66;

  if (!hasKey) {
    console.log(
      "⚠ No valid AGENT_PRIVATE_KEY set.\n" +
        "  Running in DISCOVERY-ONLY mode.\n" +
        "  To run the full x402 payment loop:\n" +
        "    1. Get Base Sepolia ETH from https://docs.base.org/chain/network-faucets\n" +
        "    2. Get test USDC from https://faucet.circle.com (select Base Sepolia)\n" +
        "    3. Set AGENT_PRIVATE_KEY in agent/.env\n"
    );
    await discoverApi();
    console.log("\n✓ Discovery complete. Set AGENT_PRIVATE_KEY to continue.\n");
    return;
  }

  // Set up wallet
  const account = privateKeyToAccount(PK as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC),
  }).extend(publicActions);

  console.log(`Agent wallet : ${account.address} (Base Sepolia)`);
  console.log(`Signal API   : ${API_URL}`);
  console.log(`Chain ID     : ${CHAIN_ID}`);
  console.log(`Session Mgr  : ${shortAddr(SESSION_MANAGER)}`);
  console.log(`Session ID   : ${SESSION_ID || "(not configured)"}`);

  // Step 1: Discover
  const discovery = await discoverApi();

  // Step 2: Fetch paid signal
  // Resolve a trader address for demo
  let traderAddr = process.env.DEMO_TRADER_ADDRESS?.trim() || "";
  if (!traderAddr) {
    // Try to get from discovery endpoints or use a placeholder
    console.log(
      "\n  ℹ No DEMO_TRADER_ADDRESS set. The signal API will auto-pick the first on-chain trader."
    );
    traderAddr = "0x0000000000000000000000000000000000000001"; // placeholder
  }

  let signalData: any = null;
  try {
    signalData = await fetchPaidSignal(walletClient, traderAddr);
  } catch (err) {
    console.error(`  ✗ Failed to fetch signal: ${(err as Error).message}`);
    console.log(
      "  This is expected if the signal-api server is not running."
    );
    console.log(
      "  Start it with: cd agent && npm run signal-api"
    );
  }

  // Step 3: Decide
  if (signalData) {
    const trade = analyzeAndDecide(signalData);

    // Step 4: Execute
    if (trade) {
      await executeTradeViaSession(walletClient, trade, traderAddr);
    } else {
      console.log("\n  → No actionable signal. Agent stays idle.");
    }
  }

  banner("✓ Agent Cycle Complete");
  console.log(
    "  In production, this would loop every 30s–5min.\n" +
      "  The agent:\n" +
      "    1. Paid $0.01 USDC via x402 (EIP-3009) for the signal\n" +
      "    2. Analyzed the trader's performance & funding rates\n" +
      "    3. Made an autonomous trading decision within session bounds\n" +
      "    4. Revenue was split 70/20/10 on-chain via FeeRouter\n"
  );
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});
