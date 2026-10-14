import { ethers } from "ethers";

/**
 * 直接輪詢收據，不用 response.wait()：wait() 第一次查不到收據時會改等「下一個區塊」，
 * 而 automine 的 Anvil 上常常只有我們自己在送交易——沒有下一個區塊就永遠卡住
 * （完整回放實際卡過一次）。回放與展示用的價格寫入都用這個。
 */
export async function receiptOf(provider: ethers.Provider, hash: string): Promise<ethers.TransactionReceipt> {
  for (let i = 0; i < 1200; i++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`reverted: ${hash}`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no receipt after 60s: ${hash}`);
}
