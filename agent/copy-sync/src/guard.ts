// 執行者金鑰的簽章白名單：這把熱錢包**只能**簽一種東西——對指定 CopyTracker 的 resyncFor 呼叫。
//
// 這是「agent 程式自律」那一層（第二道防線）。真正保護跟隨者的是合約：resyncFor 只能把部位調成
// 交易者鏈上最新版，呼叫者沒有任何參數可選（ADR-024）。這裡防的是執行者自己的錢——
// 程式被改壞、相依套件被植入、或操作者手滑時，這把金鑰也簽不出轉帳、approve、
// EIP-7702 委派或任意訊息，熱錢包裡那一點 gas ETH 不會被一筆交易掃走。
//
// 白名單（比照 agent/shared/src/signingGuard.ts 的寫法，但範圍更窄）：
//   - 交易：`to` 必須是設定的 CopyTracker；selector 必須是 resyncFor(address,uint256)；
//     calldata 解碼後重新編碼必須逐字相同（尾端夾帶資料一律拒絕）；value 必須是 0
//     （resyncFor 是 payable，附帶的 ETH 會存進跟隨者的油箱——執行費與小費都從油箱扣，
//     執行者永遠不需要、也不該附帶 ETH）；chainId 必須等於啟動時確認的鏈；
//     type-4（EIP-7702）、authorizationList、合約建立一律拒絕。
//   - EIP-712、personal_sign、裸 hash、EIP-7702 authorization：一律拒絕。
import { ethers } from "ethers";
import { RESYNC_FOR_SIGNATURE } from "./abi.ts";

export type ExecutorGuardReason =
  | "TX_NOT_ALLOWLISTED"
  | "TX_CHAIN_ID_INVALID"
  | "TX_VALUE_NOT_ZERO"
  | "EIP7702_FORBIDDEN"
  | "TYPED_DATA_FORBIDDEN"
  | "MESSAGE_FORBIDDEN";

export class ExecutorGuardError extends Error {
  constructor(
    public readonly reasonCode: ExecutorGuardReason,
    detail: string,
  ) {
    super(`[copy-sync guard] ${reasonCode}: ${detail}`);
    this.name = "ExecutorGuardError";
  }
}

const RESYNC_IFACE = new ethers.Interface([RESYNC_FOR_SIGNATURE]);
export const RESYNC_FOR_SELECTOR = RESYNC_IFACE.getFunction("resyncFor")!.selector;

export interface GuardConfig {
  /** 唯一允許的交易對象。 */
  copyTracker: string;
  /** 啟動時向 RPC 確認過的 chainId。 */
  chainId: number;
}

function toBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return null;
}

function is7702(tx: { type?: unknown; authorizationList?: unknown }): boolean {
  const t = tx.type;
  if (t === 4 || t === 4n || t === "0x4" || t === "0x04" || t === "eip7702") return true;
  const list = tx.authorizationList as unknown[] | null | undefined;
  return Array.isArray(list) && list.length > 0;
}

/** 檢查一筆要簽的交易；不合規就丟 ExecutorGuardError。 */
export function assertResyncTransaction(
  tx: { to?: unknown; data?: unknown; value?: unknown; type?: unknown; authorizationList?: unknown; chainId?: unknown },
  cfg: GuardConfig,
): { follower: string; recordIdx: bigint } {
  if (is7702(tx)) throw new ExecutorGuardError("EIP7702_FORBIDDEN", "執行者金鑰不得簽 EIP-7702 交易");
  const cid = toBig(tx.chainId);
  if (cid === null || cid !== BigInt(cfg.chainId)) {
    throw new ExecutorGuardError("TX_CHAIN_ID_INVALID", `交易 chainId ${String(tx.chainId ?? "(缺)")} 必須等於 ${cfg.chainId}`);
  }
  const to = typeof tx.to === "string" ? tx.to : (tx.to as { address?: string } | null)?.address;
  if (!to || !ethers.isAddress(to) || ethers.getAddress(to) !== ethers.getAddress(cfg.copyTracker)) {
    throw new ExecutorGuardError("TX_NOT_ALLOWLISTED", `交易對象 ${String(to ?? "(合約建立)")} 不是 CopyTracker`);
  }
  const data = typeof tx.data === "string" ? tx.data : "";
  if (data.slice(0, 10).toLowerCase() !== RESYNC_FOR_SELECTOR) {
    throw new ExecutorGuardError("TX_NOT_ALLOWLISTED", `selector ${data.slice(0, 10) || "(空)"} 不是 resyncFor`);
  }
  let decoded: ethers.Result;
  try {
    decoded = RESYNC_IFACE.decodeFunctionData("resyncFor", data);
  } catch {
    throw new ExecutorGuardError("TX_NOT_ALLOWLISTED", "resyncFor calldata 無法完整解碼");
  }
  if (RESYNC_IFACE.encodeFunctionData("resyncFor", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new ExecutorGuardError("TX_NOT_ALLOWLISTED", "resyncFor calldata 不是標準編碼（尾端夾帶資料或格式異常）");
  }
  const value = tx.value === undefined || tx.value === null ? 0n : toBig(tx.value);
  if (value !== 0n) throw new ExecutorGuardError("TX_VALUE_NOT_ZERO", `resyncFor 不應附帶 ETH（value=${String(tx.value)}）`);
  return { follower: decoded[0] as string, recordIdx: decoded[1] as bigint };
}

/**
 * `ethers.Wallet` 的子類：所有會產生簽章的方法都先過白名單。sendTransaction／contract 寫呼叫
 * 最後都經過 signTransaction，所以覆寫它就涵蓋全部交易路徑（同 GuardedWallet 的做法）。
 */
export class ExecutorWallet extends ethers.Wallet {
  readonly #cfg: GuardConfig;

  constructor(key: string | ethers.SigningKey, cfg: GuardConfig, provider?: ethers.Provider | null) {
    super(key, provider);
    if (!ethers.isAddress(cfg.copyTracker)) throw new Error("ExecutorWallet：copyTracker 不是合法位址");
    if (!Number.isSafeInteger(cfg.chainId) || cfg.chainId <= 0) throw new Error("ExecutorWallet：chainId 不合法");
    this.#cfg = { copyTracker: ethers.getAddress(cfg.copyTracker), chainId: cfg.chainId };
  }

  get guardConfig(): GuardConfig {
    return { ...this.#cfg };
  }

  override async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    assertResyncTransaction(tx as never, this.#cfg);
    return super.signTransaction(tx);
  }

  override async signTypedData(): Promise<string> {
    throw new ExecutorGuardError("TYPED_DATA_FORBIDDEN", "執行者金鑰不簽任何 EIP-712 資料");
  }

  override async signMessage(): Promise<string> {
    throw new ExecutorGuardError("MESSAGE_FORBIDDEN", "執行者金鑰不簽任何訊息");
  }

  override signMessageSync(): string {
    throw new ExecutorGuardError("MESSAGE_FORBIDDEN", "執行者金鑰不簽任何訊息");
  }

  override async authorize(): Promise<ethers.Authorization> {
    throw new ExecutorGuardError("EIP7702_FORBIDDEN", "執行者金鑰不得簽 EIP-7702 authorization");
  }

  override authorizeSync(): ethers.Authorization {
    throw new ExecutorGuardError("EIP7702_FORBIDDEN", "執行者金鑰不得簽 EIP-7702 authorization");
  }

  override connect(provider: ethers.Provider | null): ExecutorWallet {
    return new ExecutorWallet(this.signingKey, this.#cfg, provider);
  }
}
