// 公開鏈回放（#344）要的合約位址，從 cutover 部署的新交易所一路讀出來，不手抄：
//   exchange → oracle / kyc / usdc / copyTracker / feeRouter
//   copyTracker → registry / traderStake
//   feeRouter.platformTreasury() → 分流合約 → carbonRetirement()（#333，與 keeper 同一套 discoverCarbon）
// 讀不到或接線不對就丟錯，不寫半份。
//   cd agent && HEROES_RPC_URL=<rpc> npx tsx heroes/chainAddresses.ts <新 exchange> <out.json>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { discoverCarbon, ethersDiscoveryReads } from "../keeper/carbon.ts";
import { PUBLIC_CHAIN_ID } from "./mode.ts";
import { publicProvider } from "./provider.ts";

const WIRING_ABI = [
  "function oracle() view returns (address)",
  "function kyc() view returns (address)",
  "function usdc() view returns (address)",
  "function copyTracker() view returns (address)",
  "function registry() view returns (address)",
  "function traderStake() view returns (address)",
  "function owner() view returns (address)",
];

export interface WiringReads {
  read(contract: string, getter: string): Promise<string>;
}

/** 純粹的接線讀取：給定 read(合約, getter)，回傳回放要的位址表。 */
export async function addressesFromExchange(exchange: string, wiring: WiringReads, carbon: () => ReturnType<typeof discoverCarbon>) {
  const r = (c: string, g: string) => wiring.read(c, g);
  const unset = (v: string) => !ethers.isAddress(v) || v === ethers.ZeroAddress;
  const copyTracker = await r(exchange, "copyTracker");
  if (unset(copyTracker)) throw new Error("CopyTracker is unset on the new exchange's wiring");
  const out: Record<string, string> = {
    PerpetualExchange: ethers.getAddress(exchange),
    MockOracle: await r(exchange, "oracle"),
    KYCRegistry: await r(exchange, "kyc"),
    MockUSDC: await r(exchange, "usdc"),
    CopyTracker: copyTracker,
    StrategyRegistry: await r(copyTracker, "registry"),
    TraderStake: await r(copyTracker, "traderStake"),
  };
  for (const [k, v] of Object.entries(out)) {
    if (unset(v)) throw new Error(`${k} is unset on the new exchange's wiring`);
  }
  const found = await carbon();
  if (!found) throw new Error("the exchange's platform FeeRouter does not pay a PlatformFeeSplitter: #333 is not wired (OWNER_ACTIONS step 5 item 4)");
  out.FeeRouter = found.feeRouter;
  out.PlatformFeeSplitter = found.splitter;
  out.CarbonRetirement = found.retirement;
  return out;
}

async function main(): Promise<void> {
  const [exchange, outPath] = process.argv.slice(2);
  const rpc = process.env.HEROES_RPC_URL;
  if (!exchange || !outPath || !rpc) {
    console.error("usage: HEROES_RPC_URL=<rpc> tsx heroes/chainAddresses.ts <exchange> <out.json>");
    process.exit(2);
  }
  const provider = publicProvider(rpc);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== PUBLIC_CHAIN_ID) throw new Error(`chainId ${chainId}: this reads the Base Sepolia (84532) cutover only`);
  const wiring: WiringReads = {
    read: async (c, g) => ethers.getAddress((await new ethers.Contract(c, WIRING_ABI, provider).getFunction(g)()) as string),
  };
  const out = await addressesFromExchange(exchange, wiring, () => discoverCarbon(exchange, ethersDiscoveryReads(provider)));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ chainId: Number(chainId), ...out }, null, 1) + "\n");
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(20)} ${v}`);
  console.log(`written: ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
