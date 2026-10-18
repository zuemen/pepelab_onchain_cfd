import { ethers } from "ethers";

export interface ReceiptPolling {
  intervalMs: number;
  timeoutMs: number;
}

/** 本機 Anvil：即時出塊，每 50ms 問一次，60 秒內沒有就是出事了。 */
export const LOCAL_POLLING: ReceiptPolling = { intervalMs: 50, timeoutMs: 60_000 };

/** Base Sepolia：2 秒一個區塊，每秒問一次；公開鏈偶爾塞車，等 5 分鐘。 */
export const PUBLIC_POLLING: ReceiptPolling = { intervalMs: 1_000, timeoutMs: 300_000 };

/**
 * 直接輪詢收據，不用 response.wait()：wait() 第一次查不到收據時會改等「下一個區塊」，
 * 而 automine 的 Anvil 上常常只有我們自己在送交易——沒有下一個區塊就永遠卡住
 * （完整回放實際卡過一次）。回放與展示用的價格寫入都用這個。
 */
export async function receiptOf(
  provider: ethers.Provider,
  hash: string,
  polling: ReceiptPolling = LOCAL_POLLING,
): Promise<ethers.TransactionReceipt> {
  const tries = Math.ceil(polling.timeoutMs / polling.intervalMs);
  for (let i = 0; i < tries; i++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`reverted: ${hash}`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, polling.intervalMs));
  }
  throw new Error(`no receipt after ${polling.timeoutMs / 1000}s: ${hash}`);
}
