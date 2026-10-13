// 讀 DeployLocalDemo 的 broadcast 紀錄，更新前端位址表的本機鏈區塊，並寫出 heroes/out/addresses.json。
//   cd agent && npx tsx heroes/writeAddresses.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addressesFromBroadcast, renderAnvilBlock, replaceAnvilBlock } from "./addresses.ts";

const at = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const BROADCAST = at("contracts/broadcast/DeployLocalDemo.s.sol/31337/run-latest.json");
const FRONTEND = at("frontend/src/contracts/addresses.ts");
const OUT = at("heroes/out/addresses.json");

const addresses = addressesFromBroadcast(JSON.parse(readFileSync(BROADCAST, "utf8")));

const before = readFileSync(FRONTEND, "utf8");
const after = replaceAnvilBlock(before, renderAnvilBlock(addresses));
if (after !== before) writeFileSync(FRONTEND, after);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ chainId: 31337, ...addresses }, null, 1) + "\n");

console.log(`${after === before ? "unchanged" : "updated"}: frontend/src/contracts/addresses.ts (ANVIL block)`);
console.log(`written: heroes/out/addresses.json (exchange ${addresses.PerpetualExchange})`);
