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
    try {
      return await receiptOf(this.provider, hash, this.polling);
    } catch (e) {
      if (/^reverted:/.test((e as Error).message)) throw e;
      // 等不到收據（塞車、RPC 斷線）：這筆可能還會上鏈。停下來，續跑時拿雜湊問節點，不當成失敗也不重送。
      throw new InFlightError(`${hash}: ${(e as Error).message}`);
    }
  }

  private async broadcast(lane: Lane, call: Call, hooks: Hooks): Promise<string> {
    const from = call.from.address;
    if (lane.nonce === null) lane.nonce = await retryNetwork(() => this.provider.getTransactionCount(from, "pending"));
    const nonce = lane.nonce;
    let tx: ethers.TransactionRequest;
    try {
      // 估 gas 遇到節點逾時或限流不是「會 revert」：重試，只有合約真的拒絕才算這筆失敗。
      tx = await retryNetwork(async () => {
        const base = { ...(await call.populate()), from };
        const gas = await this.provider.estimateGas(base);
        return { ...base, nonce, gasLimit: (gas * GAS_PAD_BPS) / 10_000n, ...(await this.feeSource.fees()), type: 2 };
      });
    } catch (e) {
      if (isNetworkError(e)) throw new InFlightError(`not sent, node unreachable: ${(e as Error).message}`, { forgettable: true });
      throw new RejectedError((e as Error).message); // 沒有送出，nonce 不前進
    }
    if (call.from.signer instanceof ethers.BaseWallet) {
      const signed = await call.from.signer.signTransaction({ ...tx, chainId: (await this.provider.getNetwork()).chainId });
      const hash = ethers.keccak256(signed);
      hooks.onHash(hash, nonce);
      try {
        await retryNetwork(() => this.provider.broadcastTransaction(signed));
      } catch (e) {
        // 錯誤訊息不可信（「already known」也可能是別筆）：先問節點知不知道這一筆，知道就照常等收據。
        const known = await this.provider.getTransaction(hash).catch(() => undefined);
        if (!known) {
          lane.nonce = null; // 下一筆向節點重讀
          // 節點明確拒收（餘額不足、nonce 衝突）：什麼都沒送出去，可以當作沒送過。
          // 連不上節點、問不到結果：不知道有沒有送出，保留「已送出」，續跑時用 nonce 判斷，絕不直接重送。
          if (known === null && isDefiniteRejection(e)) throw new NotBroadcastError((e as Error).message);
          throw new InFlightError(`${hash}: broadcast outcome unknown: ${(e as Error).message}`);
        }
      }
      lane.nonce = nonce + 1;
      return hash;
    }
    // anvil fork 演練裡假冒的部署者：沒有私鑰，交給節點簽（eth_sendTransaction）。
    let response: ethers.TransactionResponse;
    try {
      response = await call.from.signer.sendTransaction(tx);
    } catch (e) {
      if (NONCE_ERROR.test((e as Error).message)) lane.nonce = null;
      throw new NotBroadcastError((e as Error).message);
    }
    lane.nonce = nonce + 1;
    hooks.onHash(response.hash, nonce);
    return response.hash;
  }
}

/**
 * 節點拒收這一筆（餘額不足、nonce 衝突…），什麼都沒送出去。不是 revert：重送可能就成功，所以停下整趟回放，
 * 讓擁有者處理（例如補部署者的 ETH）後續跑；進度裡這個動作要當作沒送過。
 */
export class NotBroadcastError extends Error {
  readonly fatal = true;
  readonly forget = true;
}

/**
 * 節點連不上或結果不明：停下整趟回放。送出了的（有雜湊）進度裡保留「已送出」，續跑時問節點；
 * 確定還沒送出的（估 gas 就連不上，forgettable）當作沒送過。
 */
export class InFlightError extends Error {
  readonly fatal = true;
  readonly forget: boolean;
  constructor(message: string, { forgettable = false } = {}) {
    super(message);
    this.forget = forgettable;
  }
}

/** 節點逾時、限流、斷線、5xx：與交易本身無關的錯誤。 */
export function isNetworkError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === "CALL_EXCEPTION" || code === "INSUFFICIENT_FUNDS" || code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED") return false;
  if (code === "TIMEOUT" || code === "NETWORK_ERROR" || code === "SERVER_ERROR") return true;
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|429|too many requests|rate limit|capacity|503|502/i
    .test((e as Error)?.message ?? "");
}

/** 節點明確拒收、什麼都沒進 mempool 的錯誤。 */
export function isDefiniteRejection(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === "INSUFFICIENT_FUNDS" || code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED") return true;
  return /insufficient funds|nonce too low|nonce too high|replacement|underpriced|intrinsic gas|exceeds block gas limit/i
    .test((e as Error)?.message ?? "");
}

/** 網路錯誤重試幾次（2、4、8、16 秒），其他錯誤直接丟出。 */
export async function retryNetwork<T>(fn: () => Promise<T>, attempts = 5, baseMs = 2_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
  }
}

export const isFatal = (e: unknown): e is NotBroadcastError | InFlightError => (e as { fatal?: boolean })?.fatal === true;

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
