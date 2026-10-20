import { loadKeystore } from "./keystore.ts";
const k = await loadKeystore(process.argv[2], "fork-check-only");
console.log(k.wallet(10).address);
