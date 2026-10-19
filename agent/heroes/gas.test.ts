// 公開鏈回放的 gas 發放（#344）：不夠才補、補到兩倍；夠用就不發。
//   cd agent && npx tsx heroes/gas.test.ts
import assert from "node:assert";
import { costPerTx, GAS_PER_TX, L1_FEE_PER_TX, needWei, topUp } from "./gas.ts";

const fee = 12_000_000n; // 0.012 gwei，Base Sepolia 的常見上限
const need = { address: "0x1", txs: 8, value: 3n * 10n ** 14n }; // 換倉：8 筆交易、3 筆開倉的執行費

assert.equal(costPerTx(fee), fee * GAS_PER_TX + L1_FEE_PER_TX);
const want = needWei(need, fee);
assert.equal(want, 8n * costPerTx(fee) + need.value);

assert.equal(topUp(want, need, fee), 0n, "enough: no transfer");
assert.equal(topUp(want + 1n, need, fee), 0n);
assert.equal(topUp(0n, need, fee), 2n * want, "empty: fill to twice the need");
assert.equal(topUp(want - 1n, need, fee), want + 1n, "short by one wei: still top up to twice the need");
assert.equal(topUp(0n, { address: "0x1", txs: 0, value: 0n }, fee), 0n, "nothing to send: nothing to fund");

// 量級：一天換倉約 0.0005 ETH，遠低於部署者手上的 0.08 ETH
assert.ok(want < 10n ** 15n, `a rebalance should need < 0.001 ETH, got ${want}`);

console.log("gas: ok");
