// 展示用：定時把即時價格寫進本機鏈的預言機，報價才不會過期。
// 價格來源與 keeper 相同（CoinGecko／Yahoo）；抓不到的資產把目前的價格原樣重寫一次，只更新時間。
//   cd agent && npx tsx heroes/priceTick.ts [addresses.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { fetchPrice, SOURCES } from "../keeper/feeds.ts";
import { ORACLE_ABI } from "./abi.ts";
import { receiptOf } from "./receipt.ts";

const RPC = process.env.HEROES_RPC_URL ?? "http://127.0.0.1:8545";
const EVERY_SEC = Number(process.env.HEROES_TICK_SEC ?? 60);
// Anvil 的預設助記詞；索引 0 是本機鏈預言機的 owner。公開的測試金鑰，只能用在本機鏈。
const MNEMONIC = "test test test test test test test test test test test junk";
const addressesPath = process.argv[2] ?? fileURLToPath(new URL("../../heroes/out/addresses.json", import.meta.url));

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 31337n) throw new Error(`refusing to write prices on chainId ${chainId}: local Anvil (31337) only`);
  const owner = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(provider);
  const { MockOracle } = JSON.parse(readFileSync(addressesPath, "utf8"));
  const oracle = new ethers.Contract(MockOracle, ORACLE_ABI, owner);

  for (;;) {
    let live = 0;
    for (const symbol of Object.keys(SOURCES)) {
      const id = ethers.id(symbol);
      const quote = await fetchPrice(symbol);
      const [current] = (await oracle.getPrice(id)) as [bigint, bigint];
      const next = quote.value !== null && quote.value > 0 ? BigInt(Math.round(quote.value * 1e8)) : current;
      if (next !== current) live += 1;
      await receiptOf(provider, (await oracle.updatePrice(id, next)).hash);
    }
    console.log(`${new Date().toISOString()} wrote ${Object.keys(SOURCES).length} prices (${live} changed)`);
    await new Promise((resolve) => setTimeout(resolve, EVERY_SEC * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
