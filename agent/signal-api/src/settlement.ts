// x402 收入「真上鏈結算」：把付費訊號的費用透過 FeeRouter.routeExternalRevenue
// 真的走 70/20/10 分潤（70% 歸該 trader）。
//
// 啟用方式：在 .env 設 FEE_SETTLEMENT_PRIVATE_KEY（一個在 Base Sepolia 上、
// 持有 mUSDC + 少量 ETH 的測試金鑰）。未設則停用，僅保留鏈下帳務（/revenue）。
import { ethers } from "ethers";
import { loadEnv, makeProvider, ADDRESSES } from "@pepelab/shared";

loadEnv();

const FEE_ROUTER_ABI = [
  "function routeExternalRevenue(address trader, uint256 fee)",
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
// FeeRouter, while the perp engine keeps MockUSDC. Defaults fall back to the
// MockUSDC FeeRouter from addresses.ts (old behaviour).
const SETTLEMENT_TOKEN =
  process.env.X402_SETTLEMENT_TOKEN?.trim() || ADDRESSES.MockUSDC;
const SETTLEMENT_ROUTER =
  process.env.X402_FEE_ROUTER?.trim() || ADDRESSES.FeeRouter;

let wallet: ethers.Wallet | null = null;
let feeRouter: ethers.Contract | null = null;
let usdc: ethers.Contract | null = null;

if (PK && PK.startsWith("0x") && PK.length === 66) {
  const provider = makeProvider();
  wallet = new ethers.Wallet(PK, provider);
  feeRouter = new ethers.Contract(SETTLEMENT_ROUTER, FEE_ROUTER_ABI, wallet);
  usdc = new ethers.Contract(SETTLEMENT_TOKEN, USDC_ABI, wallet);
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
    // 依結算 token 的實際小數位換算（官方 USDC=6, MockUSDC=18）。
    const decimals = Number(await usdc.decimals());
    const atomic = ethers.parseUnits(feeUsd.toString(), decimals);
    const me = wallet.address;

    // 確保餘額。MockUSDC 可自助鑄幣省 faucet；官方 USDC 不可 mint → 改用既有
    // 餘額（來自 x402 付款），鑄幣失敗就略過、不擋結算。
    const bal = (await usdc.balanceOf(me)) as bigint;
    if (bal < atomic) {
      try {
        const mintTx = await usdc.mint(me, atomic * 1000n);
        await mintTx.wait();
      } catch {
        return {
          status: "failed",
          error: `結算 token 餘額不足且不可 mint（${SETTLEMENT_TOKEN}）。treasury 需先收到 x402 付款的 USDC。`,
        };
      }
    }

    // 確保授權
    const allowance = (await usdc.allowance(me, SETTLEMENT_ROUTER)) as bigint;
    if (allowance < atomic) {
      const apTx = await usdc.approve(SETTLEMENT_ROUTER, ethers.MaxUint256);
      await apTx.wait();
    }

    const tx = await feeRouter.routeExternalRevenue(trader, atomic);
    await tx.wait();
    return { status: "settled", tx: tx.hash };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
