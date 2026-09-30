// 離線測試用的假鏈：viem custom transport，依 ABI 解碼 eth_call 並回傳預先設定的結果。
// 支援 Multicall3（aggregate3）與逐筆 eth_call 兩條路徑，並記錄每個 eth_call 帶的 block tag，
// 讓測試能斷言「所有讀取都在同一個區塊」。完全不連網。
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  type Abi,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";

export class Revert extends Error {
  constructor() {
    super("execution reverted");
  }
}

/** address(lowercase) → { abi, fns: functionName → (args, blockNumber) => result | throw Revert } */
export type ContractMocks = Record<
  string,
  { abi: Abi; fns: Record<string, (args: readonly unknown[], blockNumber: bigint) => unknown> }
>;

export interface MockChain {
  client: PublicClient;
  /** 每一次 eth_call 的 block tag（hex）。 */
  callBlockTags: string[];
  /** 每一個（解開 multicall 後）被呼叫的函式名稱。 */
  calls: string[];
  /** 其他 RPC 方法的呼叫紀錄。 */
  methods: string[];
}

export function mockChain(opts: {
  chain: Chain;
  latestBlock: bigint;
  blockTimestamp: (bn: bigint) => bigint;
  contracts: ContractMocks;
  /** 讓某些 RPC 方法丟出網路層錯誤（非 revert）。 */
  failRpc?: (method: string) => boolean;
}): MockChain {
  const callBlockTags: string[] = [];
  const calls: string[] = [];
  const methods: string[] = [];
  const mc = opts.chain.contracts?.multicall3?.address?.toLowerCase();

  const dispatch = (to: string, data: Hex, bn: bigint): { ok: true; data: Hex } | { ok: false } => {
    const c = opts.contracts[to.toLowerCase()];
    if (!c) return { ok: false };
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: c.abi, data });
    } catch {
      return { ok: false }; // 未知 selector → 等同合約沒有這個函式
    }
    const fn = c.fns[decoded.functionName];
    calls.push(decoded.functionName);
    if (!fn) return { ok: false };
    try {
      const result = fn(decoded.args ?? [], bn);
      return {
        ok: true,
        data: encodeFunctionResult({ abi: c.abi, functionName: decoded.functionName, result } as never),
      };
    } catch (e) {
      if (e instanceof Revert) return { ok: false };
      throw e;
    }
  };

  const client = createPublicClient({
    chain: opts.chain,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        methods.push(method);
        if (opts.failRpc?.(method)) throw new Error(`mock RPC failure: ${method}`);
        const p = (params ?? []) as unknown[];
        switch (method) {
          case "eth_chainId":
            return numberToHex(opts.chain.id);
          case "eth_blockNumber":
            return numberToHex(opts.latestBlock);
          case "eth_getBlockByNumber": {
            const bn = BigInt(p[0] as string);
            return {
              number: numberToHex(bn),
              hash: ("0x" + bn.toString(16).padStart(64, "0")) as Hex,
              parentHash: ("0x" + "00".repeat(32)) as Hex,
              timestamp: numberToHex(opts.blockTimestamp(bn)),
              nonce: "0x0000000000000000",
              difficulty: "0x0",
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              miner: "0x0000000000000000000000000000000000000000",
              extraData: "0x",
              logsBloom: "0x" + "00".repeat(256),
              transactionsRoot: "0x" + "00".repeat(32),
              stateRoot: "0x" + "00".repeat(32),
              receiptsRoot: "0x" + "00".repeat(32),
              sha3Uncles: "0x" + "00".repeat(32),
              size: "0x0",
              transactions: [],
              uncles: [],
              baseFeePerGas: "0x1",
            };
          }
          case "eth_call": {
            const [tx, tag] = p as [{ to: string; data: Hex }, string];
            callBlockTags.push(tag);
            const bn = BigInt(tag);
            if (mc && tx.to.toLowerCase() === mc) {
              const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
              const inner = (args![0] as readonly { target: string; allowFailure: boolean; callData: Hex }[]).map((c) => {
                const r = dispatch(c.target, c.callData, bn);
                if (!r.ok && !c.allowFailure) throw { code: 3, message: "execution reverted", data: "0x" };
                return { success: r.ok, returnData: r.ok ? r.data : ("0x" as Hex) };
              });
              return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: inner });
            }
            const r = dispatch(tx.to, tx.data, bn);
            if (!r.ok) throw { code: 3, message: "execution reverted", data: "0x" };
            return r.data;
          }
          default:
            throw new Error(`mockChain: 未支援的 RPC 方法 ${method}`);
        }
      },
    }),
  }) as PublicClient;

  return { client, callBlockTags, calls, methods };
}
