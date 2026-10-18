// 公開鏈回放的位址表（#344）：從新交易所的接線讀出來；任何一個沒接、或沒接上 #333 就拒絕。
//   cd agent && npx tsx heroes/chainAddresses.test.ts
import assert from "node:assert";
import { addressesFromExchange, type WiringReads } from "./chainAddresses.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const EX = a(1);
const CT = a(2);
const wiring = (overrides: Record<string, string> = {}): WiringReads => ({
  read: async (c, g) => {
    const table: Record<string, string> = {
      [`${EX}.oracle`]: a(10), [`${EX}.kyc`]: a(11), [`${EX}.usdc`]: a(12), [`${EX}.copyTracker`]: CT,
      [`${CT}.registry`]: a(13), [`${CT}.traderStake`]: a(14), ...overrides,
    };
    const v = table[`${c}.${g}`];
    if (v === undefined) throw new Error(`unexpected read ${c}.${g}`);
    return v;
  },
});
const carbon = async () => ({ feeRouter: a(20), splitter: a(21), retirement: a(22) });

const out = await addressesFromExchange(EX, wiring(), carbon);
assert.deepEqual(out, {
  PerpetualExchange: EX, MockOracle: a(10), KYCRegistry: a(11), MockUSDC: a(12), CopyTracker: CT,
  StrategyRegistry: a(13), TraderStake: a(14), FeeRouter: a(20), PlatformFeeSplitter: a(21), CarbonRetirement: a(22),
});
await assert.rejects(addressesFromExchange(EX, wiring({ [`${EX}.copyTracker`]: a(0) }), carbon), /unset/);
await assert.rejects(addressesFromExchange(EX, wiring(), async () => null), /#333 is not wired/);

console.log("chainAddresses: ok");
