// 本機鏈 provider 的設定：連續查兩次 nonce，兩次都要真的問到節點。
//   cd agent && npx tsx heroes/provider.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { localProvider } from "./provider.ts";

const ADDR = "0x0000000000000000000000000000000000000001";

/** 把送出的 JSON-RPC 換成假的節點：每查一次 nonce 就回一個更大的數字，像剛有一筆交易上鏈。 */
function countingNode(provider: ethers.JsonRpcProvider): void {
  let nonce = 0;
  (provider as unknown as { _send: (p: unknown) => Promise<unknown[]> })._send = async (payload) => {
    const list = (Array.isArray(payload) ? payload : [payload]) as { id: number; method: string }[];
    return list.map((p) => ({ id: p.id, result: p.method === "eth_getTransactionCount" ? ethers.toBeHex(++nonce) : null }));
  };
}

// ethers v6 預設把 250ms 內相同的請求併成一次。Anvil 即時出塊、收據每 50ms 輪詢一次，
// 上一筆上鏈後的下一筆常常落在這 250ms 內，拿到的是舊 nonce → nonce too low。
const provider = localProvider("http://127.0.0.1:1");
countingNode(provider);
const first = await provider.getTransactionCount(ADDR, "pending");
const second = await provider.getTransactionCount(ADDR, "pending");
assert.equal(first, 1);
assert.equal(second, 2, "second nonce read came from the request cache instead of the node");

const network = await provider.getNetwork();
assert.equal(network.chainId, 31337n);

console.log("provider: ok");
