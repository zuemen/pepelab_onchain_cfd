// 送交易的兩種方式（#344）。
//
// 本機（LocalSender）：與改版前一模一樣——ethers 自己估 gas、自己取 nonce，送一筆等一筆上鏈。
// 同一份排程回放兩次逐筆相同（區塊、交易雜湊、期末淨值），所以這條路一個欄位都不能多。
//
// 公開鏈（PublicSender）：同一天裡不同帳號的交易平行送出，同一個帳號的交易依送出順序排 nonce：
//   - nonce 自己記，不每筆問節點（公開 RPC 的負載平衡後面，連續兩次問到的 pending nonce 可能不同；
//     2026-10-10 的 cutover 在 sepolia.base.org 上遇過 nonce 錯亂）。估 gas 失敗（會 revert）的那筆不佔 nonce。
//   - 有私鑰的帳號在本機簽名，**廣播前**就知道交易雜湊並記進進度；中途斷掉，續跑時拿雜湊問節點，
//     不會在不知道結果的情況下再送一次。
//   - gas 上限 = 估計值 × 1.25：同一個區塊裡前一筆會改到後一筆讀的狀態（資金費率、名目）。
//   - 廣播回 nonce 類錯誤時，nonce 改回向節點重讀。
import { ethers } from "ethers";
import { receiptOf, type ReceiptPolling } from "./receipt.ts";

export interface Account {
  address: string;
  signer: ethers.Signer;
}

/** 一筆要送的交易。send 用在本機模式；populate 給公開鏈模式自己估 gas、排 nonce、簽名。 */
export interface Call {
  from: Account;
  send: () => Promise<ethers.TransactionResponse>;
  populate: () => Promise<ethers.TransactionRequest>;
}

/** 合約呼叫。value 只有付執行費的那幾個函式有；沒有 value 時不傳 overrides，與改版前送出的交易相同。 */
export function contractCall(from: Account, contract: ethers.Contract, method: string, args: unknown[], value?: bigint): Call {
  const fn = () => contract.connect(from.signer).getFunction(method);
  const tail = value === undefined ? [] : [{ value }];
  return {
    from,
    send: () => fn()(...args, ...tail) as Promise<ethers.TransactionResponse>,
    populate: () => fn().populateTransaction(...args, ...tail),
  };
}

/** 單純轉 ETH（部署者發 gas 給各帳號）。 */
export function transferCall(from: Account, to: string, value: bigint): Call {
  return {
    from,
    send: () => from.signer.sendTransaction({ to, value }),
    populate: async () => ({ to, value }),
  };
}

export interface Hooks {
  /** 交易雜湊確定的那一刻（本機簽名時在廣播前）。 */
  onHash(hash: string, nonce: number | undefined): void;
}

export interface Sender {
  /** 送出並等它上鏈。revert 或逾時都丟錯；估 gas 就失敗時錯誤帶 rejected=true（沒有送出任何東西）。 */
  submit(call: Call, hooks: Hooks): Promise<ethers.TransactionReceipt>;
  /** 這個模式下「同一批」要不要平行跑：本機一律依序，公開鏈平行。 */
  readonly parallel: boolean;
}

export class RejectedError extends Error {
  readonly rejected = true;
}

export const isRejected = (e: unknown): boolean => (e as { rejected?: boolean })?.rejected === true;

export class LocalSender implements Sender {
  readonly parallel = false;
  constructor(private readonly provider: ethers.Provider) {}

  async submit(call: Call, hooks: Hooks): Promise<ethers.TransactionReceipt> {
    let response: ethers.TransactionResponse;
    try {
      response = await call.send();
    } catch (e) {
      throw new RejectedError((e as Error).message);
    }
    hooks.onHash(response.hash, undefined);
    return receiptOf(this.provider, response.hash);
  }
}

const NONCE_ERROR = /nonce|replacement|already known|underpriced/i;
export const GAS_PAD_BPS = 12_500n;

/** 一個帳號的 nonce 與送出順序。 */
class Lane {
  nonce: number | null = null;
  tail: Promise<unknown> = Promise.resolve();
}

export interface FeeSource {
  /** EIP-1559 的兩個上限；會被快取一小段時間。 */
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** getFeeData 每筆都問一次太浪費：快取 30 秒，maxFee 給兩倍 base fee 的空間（ethers 的預設算法）。 */
export function cachedFees(provider: ethers.Provider, ttlMs = 30_000): FeeSource {
  let at = 0;
  let cached: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null = null;
  return {
    async fees() {
      if (!cached || Date.now() - at > ttlMs) {
        const f = await provider.getFeeData();
        if (f.maxFeePerGas === null || f.maxPriorityFeePerGas === null) throw new Error("node returned no EIP-1559 fee data");
        cached = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
        at = Date.now();
      }
      return cached;
    },
  };
}

export class PublicSender implements Sender {
  readonly parallel = true;
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly provider: ethers.Provider,
    private readonly feeSource: FeeSource,
    private readonly polling: ReceiptPolling,
  ) {}

  private lane(address: string): Lane {
    const key = address.toLowerCase();
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = new Lane()));
    return lane;
  }

  async submit(call: Call, hooks: Hooks): Promise<ethers.TransactionReceipt> {
    const lane = this.lane(call.from.address);
    // 同一個帳號的「估 gas → 排 nonce → 簽名 → 廣播」排成一列；等收據不在這一列裡，所以同帳號可以連發。
    const broadcast = lane.tail.then(() => this.broadcast(lane, call, hooks));
    lane.tail = broadcast.catch(() => undefined);
    const hash = await broadcast;
    return receiptOf(this.provider, hash, this.polling);
  }

  private async broadcast(lane: Lane, call: Call, hooks: Hooks): Promise<string> {
    const from = call.from.address;
    if (lane.nonce === null) lane.nonce = await this.provider.getTransactionCount(from, "pending");
    const nonce = lane.nonce;
    let tx: ethers.TransactionRequest;
    try {
      const base = { ...(await call.populate()), from };
      const gas = await this.provider.estimateGas(base);
      tx = { ...base, nonce, gasLimit: (gas * GAS_PAD_BPS) / 10_000n, ...(await this.feeSource.fees()), type: 2 };
    } catch (e) {
      throw new RejectedError((e as Error).message); // 沒有送出，nonce 不前進
    }
    try {
      if (call.from.signer instanceof ethers.BaseWallet) {
        const signed = await call.from.signer.signTransaction({ ...tx, chainId: (await this.provider.getNetwork()).chainId });
        const hash = ethers.keccak256(signed);
        hooks.onHash(hash, nonce);
        lane.nonce = nonce + 1;
        try {
          await this.provider.broadcastTransaction(signed);
        } catch (e) {
          // 節點已經有這一筆（重送、或上一次其實送出了）：照常等收據。
          if (!/already known|known transaction|nonce too low/i.test((e as Error).message)) throw e;
        }
        return hash;
      }
      // anvil fork 演練裡假冒的部署者：沒有私鑰，交給節點簽（eth_sendTransaction）。
      const response = await call.from.signer.sendTransaction(tx);
      lane.nonce = nonce + 1;
      hooks.onHash(response.hash, nonce);
      return response.hash;
    } catch (e) {
      if (NONCE_ERROR.test((e as Error).message)) lane.nonce = null; // 下一筆重讀
      throw e;
    }
  }
}

/** 本機依序、公開鏈平行（上限 limit 個同時進行）。順序不變：本機模式的交易順序與改版前相同。 */
export async function forEach<T>(parallel: boolean, items: readonly T[], fn: (item: T, i: number) => Promise<void>, limit = 32): Promise<void> {
  if (!parallel) {
    for (const [i, item] of items.entries()) await fn(item, i);
    return;
  }
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        errors.push(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length) throw errors[0];
}
