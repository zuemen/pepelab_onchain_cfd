// x402 收入「真上鏈結算」：把付費訊號的費用透過 FeeRouter.routeExternalRevenue
// 真的走 70/20/10 分潤（70% 歸該 trader）。
//
// 啟用方式：在 .env 設 FEE_SETTLEMENT_PRIVATE_KEY（一個在 FeeRouter 所在鏈
// = Ethereum Sepolia 上、持有 mUSDC + 少量 ETH 的測試金鑰）。未設則停用，
// 僅保留鏈下帳務（/revenue）。
import { ethers } from "ethers";
import { loadEnv, makeProvider, ADDRESSES } from "@pepelab/shared";

loadEnv();

const FEE_ROUTER_ABI = [
  "function routeExternalRevenue(address trader, uint256 fee)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)", // MockUSDC: public (TESTNET ONLY)
];

const PK = process.env.FEE_SETTLEMENT_PRIVATE_KEY?.trim();

let wallet: ethers.Wallet | null = null;
let feeRouter: ethers.Contract | null = null;
let usdc: ethers.Contract | null = null;

if (PK && PK.startsWith("0x") && PK.length === 66) {
  const provider = makeProvider();
  wallet = new ethers.Wallet(PK, provider);
  feeRouter = new ethers.Contract(ADDRESSES.FeeRouter, FEE_ROUTER_ABI, wallet);
  usdc = new ethers.Contract(ADDRESSES.MockUSDC, USDC_ABI, wallet);
}

export function isSettlementEnabled(): boolean {
  return wallet !== null;
}

export interface SettlementResult {
  status: "settled" | "failed";
  tx?: string;
  error?: string;
}

// 序列化所有結算：fire-and-forget 的並發呼叫共用同一個 EOA，若同時送會撞 nonce。
// 用 promise chain 確保一次只送一筆。
let queue: Promise<unknown> = Promise.resolve();

/**
 * 把一筆費用（USD）上鏈分潤給 trader。會自動確保 mUSDC 餘額與對 FeeRouter 的
 * 授權（不足才送交易）。多筆呼叫會自動排隊（避免 nonce 衝突）。回傳結果含 tx hash。
 */
export function settleRevenue(trader: string, feeUsd: number): Promise<SettlementResult> {
  const run = queue.then(() => _settle(trader, feeUsd));
  // 讓 queue 不論成敗都接續下去
  queue = run.catch(() => undefined);
  return run;
}

async function _settle(trader: string, feeUsd: number): Promise<SettlementResult> {
  if (!wallet || !feeRouter || !usdc) {
    return { status: "failed", error: "settlement disabled" };
  }
  try {
    const atomic = ethers.parseUnits(feeUsd.toString(), 18); // mUSDC = 18-dec
    const me = wallet.address;

    // 確保餘額（不足就鑄一批測試 mUSDC，省去 faucet）
    const bal = (await usdc.balanceOf(me)) as bigint;
    if (bal < atomic) {
      const mintTx = await usdc.mint(me, atomic * 1000n);
      await mintTx.wait();
    }

    // 確保授權
    const allowance = (await usdc.allowance(me, ADDRESSES.FeeRouter)) as bigint;
    if (allowance < atomic) {
      const apTx = await usdc.approve(ADDRESSES.FeeRouter, ethers.MaxUint256);
      await apTx.wait();
    }

    const tx = await feeRouter.routeExternalRevenue(trader, atomic);
    await tx.wait();
    return { status: "settled", tx: tx.hash };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
