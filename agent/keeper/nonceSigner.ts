// keeper 的 nonce 由本機追蹤，不在每一筆交易前問 RPC。
//
// 2026-09-30 事故：keeper 先寫 GuardedOracle、等 1 個確認，再寫 MockOracle。第二筆
// 由 ethers 向公共 RPC（負載平衡）要 pending nonce，拿到的是還沒看到第一筆的節點
// 給的舊值 → 同一個 nonce → `replacement fee too low`。sBTC、sETH、GOOGL 的 Mock
// 沒寫成，加上 GitHub 排程被節流，sBTC 過期超過交易所 6 小時上限、無法交易。
//
// 為什麼不用 ethers.NonceManager：它在送出「之前」就把 delta 加一。estimateGas
// revert 或節點拒收時那個 nonce 並沒有被消耗，後面每一筆都會卡在缺口上等到逾時。
// 這裡只在節點**接受廣播**之後才遞增；失敗時不遞增。節點回「nonce 太低／已知／
// 替換」代表本機值落後（例如同一把 key 另有交易），重新向 RPC 對齊後把錯誤丟回去，
// 由 round 照原本的失敗路徑處理（下一輪補寫）。
import { AbstractSigner, type Provider, type TransactionRequest, type TransactionResponse } from "ethers";

/** 節點回這些訊息時，代表本機 nonce 已落後，需要重新對齊。 */
const STALE_NONCE =
  /nonce too low|nonce has already been used|already known|replacement (fee too low|transaction underpriced)|NONCE_EXPIRED|REPLACEMENT_UNDERPRICED/i;

export function isStaleNonceError(e: unknown): boolean {
  const err = e as { code?: string; message?: string; shortMessage?: string } | null;
  if (!err) return false;
  if (err.code === "NONCE_EXPIRED" || err.code === "REPLACEMENT_UNDERPRICED") return true;
  return STALE_NONCE.test(`${err.shortMessage ?? ""} ${err.message ?? ""}`);
}

/** 被包裝的 signer 需要的最小介面（ethers.Wallet 符合）。 */
export interface InnerSigner {
  readonly provider: Provider | null;
  getAddress(): Promise<string>;
  getNonce(blockTag?: "pending" | "latest"): Promise<number>;
  populateTransaction(tx: TransactionRequest): Promise<TransactionRequest>;
  sendTransaction(tx: TransactionRequest): Promise<TransactionResponse>;
  signMessage(message: string | Uint8Array): Promise<string>;
  signTypedData(...args: Parameters<AbstractSigner["signTypedData"]>): Promise<string>;
  signTransaction(tx: TransactionRequest): Promise<string>;
}

export class LocalNonceSigner extends AbstractSigner {
  #inner: InnerSigner;
  #next: number | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(inner: InnerSigner) {
    super(inner.provider);
    this.#inner = inner;
  }

  /** 目前本機認定的下一個 nonce（測試與日誌用）。 */
  get nextNonce(): number | null {
    return this.#next;
  }

  getAddress(): Promise<string> {
    return this.#inner.getAddress();
  }

  connect(_provider: Provider | null): LocalNonceSigner {
    throw new Error("LocalNonceSigner 不支援 connect()：請包裝一個已連線的 signer");
  }

  async #sync(): Promise<number> {
    const remote = await this.#inner.getNonce("pending");
    // 取較大者：節點落後時不要退回已用過的 nonce。
    this.#next = this.#next === null ? remote : Math.max(this.#next, remote);
    return this.#next;
  }

  override async getNonce(blockTag?: "pending" | "latest"): Promise<number> {
    if (blockTag === "latest") return this.#inner.getNonce("latest");
    return this.#next ?? this.#sync();
  }

  signTransaction(tx: TransactionRequest): Promise<string> {
    return this.#inner.signTransaction(tx);
  }

  signMessage(message: string | Uint8Array): Promise<string> {
    return this.#inner.signMessage(message);
  }

  signTypedData(...args: Parameters<AbstractSigner["signTypedData"]>): Promise<string> {
    return this.#inner.signTypedData(...args);
  }

  override sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    // 序列化：同一時間只有一筆在取 nonce 與廣播，避免兩筆拿到同一個值。
    const run = this.#queue.then(() => this.#send(tx));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send(tx: TransactionRequest): Promise<TransactionResponse> {
    if (tx.nonce != null) return this.#inner.sendTransaction(tx); // 呼叫端自行指定
    const nonce = this.#next ?? (await this.#sync());
    try {
      // populateTransaction 會做 estimateGas；revert 在這裡丟出，nonce 沒被消耗。
      const populated = await this.#inner.populateTransaction({ ...tx, nonce });
      const res = await this.#inner.sendTransaction(populated);
      this.#next = nonce + 1;
      return res;
    } catch (e) {
      if (isStaleNonceError(e)) {
        // 這個 nonce 已被占用（已上鏈、已在 mempool、或有同 nonce 的待處理交易），
        // 所以至少跳到 nonce+1；RPC 若回更大的值就用更大的。不能只重抓 RPC：
        // 落後的節點會再給一次同樣的舊值。
        this.#next = nonce + 1;
        await this.#sync().catch(() => undefined);
      }
      throw e;
    }
  }
}
