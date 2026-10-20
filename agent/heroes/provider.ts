// 回放與展示用價格寫入共用的本機鏈 provider。兩邊都在 automine 的 Anvil 上一筆接一筆送交易，
// 設定不同就會一邊正常、一邊壞掉（展示用的 priceTick 曾因為用了預設值而 nonce too low）。
import { ethers } from "ethers";

export const LOCAL = ethers.Network.from(31337);

/**
 * 固定網路、不批次、不快取。
 * - cacheTimeout: -1：ethers 預設把 250ms 內相同的請求併成一次。Anvil 即時出塊、收據每 50ms
 *   輪詢一次，上一筆上鏈後的下一筆常落在這 250ms 內，查到的是舊 nonce → nonce too low。
 * - batchMaxCount: 1：預設的 10ms 批次等待會讓幾萬筆依序送出的交易慢上好幾倍。
 */
export const localProvider = (rpc: string): ethers.JsonRpcProvider =>
  new ethers.JsonRpcProvider(rpc, LOCAL, {
    staticNetwork: LOCAL, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 100,
  });

export const BASE_SEPOLIA = ethers.Network.from(84532);

/**
 * 節點限流（2026-10-20 正式回放跑到第 126 天：Alchemy 免費方案的 compute units per second）。
 * 只看節點回的錯誤本身（code 429 或說明文字），不看整段 ethers 訊息：那裡有交易的 calldata，
 * 十六進位裡出現「429」不代表限流。
 */
export function isRateLimited(e: unknown): boolean {
  type NodeError = { code?: unknown; message?: unknown };
  const err = e as { status?: unknown; shortMessage?: unknown; error?: NodeError; info?: { error?: NodeError } };
  // ethers 有兩種包法：call／estimateGas 包成 CALL_EXCEPTION，節點原文在 info.error；
  // 其他方法（例如 eth_getBlockByNumber）包成 UNKNOWN_ERROR「could not coalesce error」，原文在 error
  // （2026-10-20 正式回放跑到 2025-07-16 停在這一種）。
  const node = err?.info?.error ?? err?.error;
  if (node?.code === 429 || err?.status === 429) return true;
  // HTTP 層的 429：ethers 自己重試幾次後丟 SERVER_ERROR「exceeded maximum retry limit」，狀態在 info.responseStatus
  if (/^429\b/.test(String((err as { info?: { responseStatus?: unknown } })?.info?.responseStatus ?? ""))) return true;
  const said = `${typeof node?.message === "string" ? node.message : ""} ${typeof err?.shortMessage === "string" ? err.shortMessage : ""}`;
  return /too many requests|compute units per second|rate limit|exceeded its .*capacity|exceeded maximum retry limit/i.test(said);
}

/** 節點還沒有那個區塊（落後）時的錯誤訊息：等一下再問同一個區塊。 */
const NOT_YET = /header not found|block not found|unknown block|not found: block|beyond (the )?current head|future block|requested block|block .*(greater|higher) than/i;

/**
 * 讀到的狀態一定包含我們自己已確認的交易（#344，2026-10-20 正式回放）。
 *
 * 公開 RPC（Alchemy、Infura）後面是多台節點輪流回應。交易所的收據從一台拿到，下一個請求可能落到
 * 還沒同步到那個區塊的另一台：approve 剛上鏈，估 stake 的 gas 卻看到授權是 0，判定會 revert
 * （那一次 35 筆這樣失敗）；同理，平倉之後讀可用保證金會讀到平倉前的數字。
 *
 * 所以 eth_call 與 eth_estimateGas 一律指定「我們看過的最新區塊」（noteBlock 記下每一筆收據的區塊），
 * 不用 latest；節點還沒有那個區塊就等一秒再問，最多 60 次。
 */
export class ConsistentProvider extends ethers.JsonRpcProvider {
  seenBlock = 0;

  noteBlock(block: number): void {
    if (block > this.seenBlock) this.seenBlock = block;
  }

  override getRpcRequest(req: Parameters<ethers.JsonRpcProvider["getRpcRequest"]>[0]): ReturnType<ethers.JsonRpcProvider["getRpcRequest"]> {
    const r = super.getRpcRequest(req);
    if (!r || this.seenBlock === 0) return r;
    const pinned = ethers.toQuantity(this.seenBlock);
    if (r.method === "eth_call" && (r.args[1] === "latest" || r.args[1] === "pending")) {
      return { method: r.method, args: [r.args[0], pinned] };
    }
    if (r.method === "eth_estimateGas" && r.args.length === 1) return { method: r.method, args: [r.args[0], pinned] };
    return r;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 與 ethers 的 send 相同的回傳型別
  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    for (let i = 0; ; i++) {
      try {
        return await super.send(method, params);
      } catch (e) {
        const pinned = (method === "eth_call" || method === "eth_estimateGas") && Array.isArray(params) && params.length > 1;
        // ethers 把節點的錯誤包成 CALL_EXCEPTION（"missing revert data"），原文在 info.error 裡
        const text = `${(e as Error)?.message ?? ""} ${JSON.stringify((e as { info?: { error?: unknown } })?.info?.error ?? "")}`;
        // 節點限流：任何請求都等一下再送同一個，2、4、8、16、30 秒…，共約 10 分鐘。
        // 重送同一筆已簽名的交易也安全（雜湊相同）。
        if (isRateLimited(e) && i < 25) {
          await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * 2 ** Math.min(i, 4))));
          continue;
        }
        if (!pinned || i >= 60 || !NOT_YET.test(text)) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * 公開鏈回放（#344）用。網路固定（不每次問 chainId），不快取（同上），讀取釘在看過的最新區塊（見上）。
 * 批次保留預設：同一天裡幾十個帳號同時輪詢收據，併成一個 HTTP 請求。
 */
export const publicProvider = (rpc: string): ConsistentProvider =>
  new ConsistentProvider(rpc, BASE_SEPOLIA, {
    staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, pollingInterval: 2000,
  });
