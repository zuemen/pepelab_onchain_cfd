// x402 收入「真上鏈結算」：把付費訊號的費用透過 FeeRouter.routeExternalRevenue
// 真的走 70/20/10 分潤（70% 歸該 trader）。
//
// 啟用方式：在 .env 設 FEE_SETTLEMENT_PRIVATE_KEY（一個在 Base Sepolia 上、
// 持有 mUSDC + 少量 ETH 的測試金鑰）。未設則停用，僅保留鏈下帳務（/revenue）。
import { ethers } from "ethers";
import { loadEnv, makeProvider, ADDRESSES, resolveSettlementToken } from "@pepelab/shared";

loadEnv();

const FEE_ROUTER_ABI = [
  "function routeExternalRevenue(address trader, uint256 fee)",
  "function usdc() view returns (address)",
  "function platformTreasury() view returns (address)",
];
const USDC_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)", // MockUSDC only (TESTNET); real USDC reverts → skipped
];

const PK = process.env.FEE_SETTLEMENT_PRIVATE_KEY?.trim();

// A0: settlement currency is configurable so x402 revenue can settle in the
// SAME token the agent paid (official Base Sepolia USDC, 6-dec) via a dedicated
// FeeRouter, while the perp engine keeps MockUSDC.
//
// 稽核（四·Medium）：這裡以前的預設值是 `ADDRESSES.MockUSDC`，而 app.ts 的預設值是
// 官方 USDC —— 兩個不同的預設值意味著 `_assertCurrencyMatch` 比對的根本不是對外
// 宣告的那個 token，永遠抓不到誤配。現在兩邊都走 shared 的 `resolveSettlementToken()`。
const SETTLEMENT_TOKEN = resolveSettlementToken();
const SETTLEMENT_ROUTER =
  process.env.X402_FEE_ROUTER?.trim() || ADDRESSES.FeeRouter;
/** 只有這一顆是可以自助鑄幣的測試代幣；其它 token 一律不嘗試 mint。 */
const MINTABLE_MOCK_USDC = ADDRESSES.MockUSDC;

let wallet: ethers.Wallet | null = null;
let feeRouter: ethers.Contract | null = null;
let usdc: ethers.Contract | null = null;
let provider: ethers.JsonRpcProvider | null = null;

if (PK && PK.startsWith("0x") && PK.length === 66) {
  provider = makeProvider();
  wallet = new ethers.Wallet(PK, provider);
  feeRouter = new ethers.Contract(SETTLEMENT_ROUTER, FEE_ROUTER_ABI, wallet);
  usdc = new ethers.Contract(SETTLEMENT_TOKEN, USDC_ABI, wallet);
}

export function isSettlementEnabled(): boolean {
  return wallet !== null;
}

/** 結算 signer 的**地址**（只給地址，私鑰不外流）。未啟用時 undefined。 */
export function settlementSignerAddress(): string | undefined {
  return wallet?.address;
}

export function settlementRouterAddress(): string {
  return SETTLEMENT_ROUTER;
}

/** 給 payTo/signer/treasury 安全檢查用的唯讀 provider（只用 getCode）。 */
export function settlementProvider(): ethers.JsonRpcProvider | null {
  return provider;
}

/** 讀 FeeRouter.platformTreasury()（immutable；20% 平台分潤的去向）。 */
export async function readPlatformTreasury(): Promise<string> {
  if (!feeRouter) throw new Error("settlement disabled");
  return (await feeRouter.platformTreasury()) as string;
}

/**
 * 結算結果。2026-09-29（P0）起多了兩種狀態：
 *   - "unknown"：routeExternalRevenue 已簽出（可能已廣播）但沒在時限內拿到 receipt。
 *     **絕不可自動重送**——worker 記下 tx hash，下一輪用 receipt 對帳。
 *   - "reverted"：拿到 receipt 且 status=0。
 * "failed" 只用在**確定沒有送出** routeExternalRevenue 的情況（可安全重試）。
 */
export type SettlementResult =
  | { status: "settled"; tx: string }
  | { status: "failed"; error: string; tx?: undefined }
  | { status: "unknown"; tx: string; error: string }
  | { status: "reverted"; tx: string; error: string };

/** 已簽出交易的資訊：hash、nonce 與完整的已簽 raw tx（可用 `cast publish` 重播）。 */
export interface SignedTxInfo {
  txHash: string;
  nonce: number;
  rawTx: string;
}

export interface SettleHooks {
  /**
   * routeExternalRevenue 簽好、**廣播之前**呼叫。呼叫端必須在這裡把 hash / nonce /
   * raw tx 持久化（worker 寫進 settle:<key>）；丟錯 → 不廣播，回 failed。
   */
  onSigned?: (info: SignedTxInfo) => Promise<void>;
}

/** 等 receipt 的時限。逾時 → "unknown"，不重送。 */
const WAIT_TIMEOUT_MS = Number(process.env.SETTLEMENT_WAIT_TIMEOUT_MS ?? "90000");

/** settleWith 需要的最小依賴——讓測試可以塞假 provider / 假合約。 */
export interface SettleDeps {
  signer: {
    address: string;
    populateTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionLike<string>>;
    signTransaction(tx: ethers.TransactionRequest): Promise<string>;
  };
  usdc: {
    decimals(): Promise<bigint | number>;
    balanceOf(a: string): Promise<bigint>;
    allowance(o: string, s: string): Promise<bigint>;
    approve(s: string, v: bigint): Promise<{ wait(c?: number, t?: number): Promise<unknown> }>;
    mint(to: string, v: bigint): Promise<{ wait(c?: number, t?: number): Promise<unknown> }>;
  };
  feeRouter: {
    routeExternalRevenue: { populateTransaction(trader: string, fee: bigint): Promise<ethers.ContractTransaction> };
  };
  provider: {
    broadcastTransaction(signed: string): Promise<unknown>;
    waitForTransaction(hash: string, confirms?: number, timeout?: number): Promise<{ status: number | null } | null>;
  };
  settlementToken: string;
  routerAddress: string;
  mintableToken: string;
  waitTimeoutMs: number;
}

// 序列化所有結算：共用同一個 EOA，同時送會撞 nonce。用 promise chain 確保一次只送一筆。
// （worker 是單一 process + workflow concurrency group，跨 process 不會並發。）
let queue: Promise<unknown> = Promise.resolve();

/**
 * 把一筆費用（USD）上鏈分潤給 trader。會自動確保結算 token 餘額與對 FeeRouter 的
 * 授權（不足才送交易）。多筆呼叫會自動排隊（避免 nonce 衝突）。
 */
export function settleRevenue(
  trader: string,
  feeUsd: number,
  hooks: SettleHooks = {},
): Promise<SettlementResult> {
  const run = queue.then(() => _settle(trader, feeUsd, hooks));
  // 讓 queue 不論成敗都接續下去
  queue = run.catch(() => undefined);
  return run;
}

/** 對帳用：查 tx receipt。null = 還查不到（未上鏈／被丟棄／RPC 不同步）。 */
export async function getReceiptStatus(txHash: string): Promise<"success" | "reverted" | null> {
  if (!provider) throw new Error("settlement disabled");
  const r = await provider.getTransactionReceipt(txHash);
  if (!r) return null;
  return r.status === 1 ? "success" : "reverted";
}

/**
 * signer 的 nonce 狀態（審查 Medium-5）。`pending > latest` 代表 mempool 裡有這個
 * signer 尚未上鏈的交易——此時再送新交易只會排在它後面一起卡住。
 */
export async function getNonceStatus(): Promise<{ latest: number; pending: number }> {
  if (!provider || !wallet) throw new Error("settlement disabled");
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(wallet.address, "latest"),
    provider.getTransactionCount(wallet.address, "pending"),
  ]);
  return { latest, pending };
}

// 一次性檢查：結算 token 必須 == FeeRouter 綁定的 usdc()，否則會 approve A、
// router 卻 pull/分潤 B → routeExternalRevenue 在金庫 depositFromProtocol 處 revert。
// 把「靜默失敗」變成明確錯誤（最常見的 .env 誤配：X402_FEE_ROUTER 留空回退到
// MockUSDC router，但 X402_SETTLEMENT_TOKEN 是官方 USDC）。
let currencyChecked = false;
async function _assertCurrencyMatch(): Promise<string | null> {
  if (currencyChecked) return null;
  try {
    const routerUsdc = (await feeRouter!.usdc()) as string;
    if (routerUsdc.toLowerCase() !== SETTLEMENT_TOKEN.toLowerCase()) {
      return (
        `結算幣別不符：X402_SETTLEMENT_TOKEN=${SETTLEMENT_TOKEN} 但 ` +
        `X402_FEE_ROUTER.usdc()=${routerUsdc}。請先用 DeployX402Router.s.sol 部署官方 USDC ` +
        `的 FeeRouter 並把位址填進 X402_FEE_ROUTER（見 .env.example）。`
      );
    }
    currencyChecked = true;
    return null;
  } catch (err) {
    return `無法讀取 FeeRouter.usdc()（位址錯誤？）：${(err as Error).message}`;
  }
}

/**
 * 廣播被節點**明確拒絕**（交易確定沒有進 mempool）的錯誤碼。其餘錯誤（網路逾時、
 * 5xx…）都可能是「其實已經送出去了」，只能當 unknown 處理。
 */
const DEFINITE_REJECTION_CODES = new Set([
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "TRANSACTION_REPLACED",
  "INVALID_ARGUMENT",
]);

async function _settle(trader: string, feeUsd: number, hooks: SettleHooks): Promise<SettlementResult> {
  if (!wallet || !feeRouter || !usdc || !provider) {
    return { status: "failed", error: "settlement disabled" };
  }
  const mismatch = await _assertCurrencyMatch();
  if (mismatch) return { status: "failed", error: mismatch };
  return settleWith(
    {
      signer: wallet,
      usdc: usdc as unknown as SettleDeps["usdc"],
      feeRouter: feeRouter as unknown as SettleDeps["feeRouter"],
      provider,
      settlementToken: SETTLEMENT_TOKEN,
      routerAddress: SETTLEMENT_ROUTER,
      mintableToken: MINTABLE_MOCK_USDC,
      waitTimeoutMs: WAIT_TIMEOUT_MS,
    },
    trader,
    feeUsd,
    hooks,
  );
}

// 註：x402 付款由 facilitator 結算到 payTo；本函式另以結算錢包餘額透過 FeeRouter
// 補上對應金額的 70/20/10「鏈上分潤紀錄」。即分潤金額對得上、但非與該筆 x402
// 付款原子綁定（demo 帳務）。正式可改為直接從 payTo 收款後原子路由。
/** 結算本體（可注入依賴，供測試）。先簽、先記、再廣播；等不到 receipt 就回 unknown。 */
export async function settleWith(
  d: SettleDeps,
  trader: string,
  feeUsd: number,
  hooks: SettleHooks = {},
): Promise<SettlementResult> {
  let signed: string;
  let info: SignedTxInfo;
  try {
    // 依結算 token 的實際小數位換算（官方 USDC=6, MockUSDC=18）。
    const decimals = Number(await d.usdc.decimals());
    const atomic = ethers.parseUnits(feeUsd.toString(), decimals);
    const me = d.signer.address;

    // 確保餘額。只有已知的 MockUSDC 才嘗試自助鑄幣（稽核 四·Low）。
    const bal = (await d.usdc.balanceOf(me)) as bigint;
    if (bal < atomic) {
      const mintable = d.settlementToken.toLowerCase() === d.mintableToken.toLowerCase();
      if (!mintable) {
        return {
          status: "failed",
          error:
            `結算 token 餘額不足（${d.settlementToken}，非可鑄幣的 MockUSDC）。` +
            `treasury 需先收到 x402 付款的 USDC。`,
        };
      }
      const mintTx = await d.usdc.mint(me, atomic * 1000n);
      await mintTx.wait(1, d.waitTimeoutMs);
    }

    // 確保授權（approve MaxUint256 是冪等的：重送也不會多分潤）。
    const allowance = (await d.usdc.allowance(me, d.routerAddress)) as bigint;
    if (allowance < atomic) {
      const apTx = await d.usdc.approve(d.routerAddress, ethers.MaxUint256);
      await apTx.wait(1, d.waitTimeoutMs);
    }

    // 先簽、先記 hash、再廣播：這樣就算廣播那一步網路逾時、或 process 在廣播後死掉，
    // worker 手上都有 hash / nonce / raw tx 可以對帳或人工重播，而不是盲目重送一筆
    // 新的（= 重複分潤）。
    const req = await d.feeRouter.routeExternalRevenue.populateTransaction(trader, atomic);
    const populated = await d.signer.populateTransaction(req);
    signed = await d.signer.signTransaction(populated as ethers.TransactionRequest);
    const parsed = ethers.Transaction.from(signed);
    info = { txHash: parsed.hash!, nonce: parsed.nonce, rawTx: signed };
  } catch (err) {
    // 到這裡為止 routeExternalRevenue 都還沒簽出 → 確定沒送，可安全重試。
    return { status: "failed", error: (err as Error).message };
  }

  try {
    await hooks.onSigned?.(info);
  } catch (err) {
    return { status: "failed", error: `記錄 tx hash 失敗，未廣播：${(err as Error).message}` };
  }

  try {
    await d.provider.broadcastTransaction(signed);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (DEFINITE_REJECTION_CODES.has(code)) {
      return { status: "failed", error: `節點拒絕廣播（${code}）：${(err as Error).message}` };
    }
    return { status: "unknown", tx: info.txHash, error: `廣播結果不明：${(err as Error).message}` };
  }

  try {
    const receipt = await d.provider.waitForTransaction(info.txHash, 1, d.waitTimeoutMs);
    if (!receipt) return { status: "unknown", tx: info.txHash, error: "未取得 receipt" };
    if (receipt.status === 1) return { status: "settled", tx: info.txHash };
    return { status: "reverted", tx: info.txHash, error: "routeExternalRevenue reverted（receipt.status=0）" };
  } catch (err) {
    // TIMEOUT 或 RPC 錯誤：交易可能仍會上鏈。**不重送**，交給下一輪對帳。
    return { status: "unknown", tx: info.txHash, error: `等待 receipt 失敗：${(err as Error).message}` };
  }
}
