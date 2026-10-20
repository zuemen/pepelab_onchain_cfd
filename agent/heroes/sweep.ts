// 把公開鏈回放帳號裡剩下的 ETH 轉回部署者（#344）。
//
// 回放由部署者發 gas 給交易者、跟隨者、造市帳號；中斷作廢的那一輪（例如 2026-10-20 被節點落後弄壞的），
// 或回放結束之後，那些帳號裡還有沒用到的 ETH。這支用同一個帳號金鑰檔推導出所有帳號，逐一轉回。
//   cd agent && HEROES_RPC_URL=<rpc> npx tsx heroes/sweep.ts <keys.json>
// 會先列出每個帳號的餘額與總額，輸入 sweep 才送出。正在跑的回放不要掃它的金鑰檔（帳號會被掏空，又被補 gas）。
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadKeystore } from "./keystore.ts";
import { PUBLIC_CHAIN_ID } from "./mode.ts";
import { ask, closePrompts } from "./prompt.ts";
import { publicProvider } from "./provider.ts";
import { receiptOf, PUBLIC_POLLING } from "./receipt.ts";

export const DEPLOYER = "0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585";
/** 回放用到的推導 index：造市帳號 1、展示 9、交易者 10–33、跟隨者 40–99；多掃一些空的也無妨。 */
export const INDICES = Array.from({ length: 120 }, (_, i) => i);
const TRANSFER_GAS = 21_000n;
/** Base 的 L1 資料費另外從餘額扣，留這麼多給它（一筆轉帳實際約 1e10–1e11 wei）。 */
export const L1_RESERVE = 5_000_000_000_000n; // 5e12 wei

/** 一個帳號能轉出多少：餘額扣掉 L2 gas 與 L1 資料費的保留；不夠付手續費就是 0。 */
export function sweepable(balance: bigint, maxFeePerGas: bigint): bigint {
  const cost = TRANSFER_GAS * maxFeePerGas + L1_RESERVE;
  return balance > cost * 2n ? balance - cost : 0n;
}

async function main(): Promise<void> {
  const [keystorePath] = process.argv.slice(2);
  const rpc = process.env.HEROES_RPC_URL;
  if (!keystorePath || !rpc) {
    console.error("usage: HEROES_RPC_URL=<rpc> tsx heroes/sweep.ts <keys.json>");
    process.exit(2);
  }
  const provider = publicProvider(rpc);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== PUBLIC_CHAIN_ID) throw new Error(`chainId ${chainId}: Base Sepolia (84532) only`);
  const password = process.env.HEROES_KEYSTORE_PASSWORD ?? (await ask(`password for ${keystorePath}: `, { hidden: true }));
  if (password === null) throw new Error("no password");
  const keys = await loadKeystore(keystorePath, password);
  const fee = await provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas ?? 0n;
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;

  const plan: { index: number; wallet: ethers.HDNodeWallet; amount: bigint }[] = [];
  for (const index of INDICES) {
    const wallet = keys.wallet(index).connect(provider);
    const amount = sweepable(await provider.getBalance(wallet.address), maxFeePerGas);
    if (amount > 0n) plan.push({ index, wallet, amount });
  }
  const total = plan.reduce((s, p) => s + p.amount, 0n);
  for (const p of plan) console.log(`  #${String(p.index).padStart(3)} ${p.wallet.address}  ${ethers.formatEther(p.amount)} ETH`);
  console.log(`${plan.length} accounts, ${ethers.formatEther(total)} ETH -> ${DEPLOYER}`);
  if (!plan.length) return;
  const answer = await ask('type "sweep" to send: ');
  if (answer?.trim() !== "sweep") throw new Error("not confirmed: nothing was sent");

  let sent = 0n;
  for (const p of plan) {
    try {
      const tx = await p.wallet.sendTransaction({
        to: DEPLOYER, value: p.amount, gasLimit: TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas, type: 2,
      });
      await receiptOf(provider, tx.hash, PUBLIC_POLLING);
      sent += p.amount;
      console.log(`  ok #${p.index} ${ethers.formatEther(p.amount)} (${tx.hash})`);
    } catch (e) {
      console.log(`  skip #${p.index}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log(`returned ${ethers.formatEther(sent)} ETH; deployer now ${ethers.formatEther(await provider.getBalance(DEPLOYER))} ETH`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(() => { closePrompts(); process.exit(0); }).catch((e) => { closePrompts(); console.error(e.message ?? e); process.exit(1); });
}
