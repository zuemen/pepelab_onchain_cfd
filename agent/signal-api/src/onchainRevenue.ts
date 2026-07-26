// 鏈上收入讀取：在 serverless 上，in-memory 帳務每次 invocation 會歸零，故 /revenue
// 直接讀【x402 專用】FeeRouter（綁官方 USDC）的真實累計——更可信、也適合公開展示。
//
// 此 X402 FeeRouter 唯一入口是 routeExternalRevenue，故 platformEarnings()（累計 20%）
// 就是純 x402 收入的單一真相：total = P×5、trader 全體 = P×3.5、vault = P×0.5。
// traderEarnings(addr) 給單一 trader 的 70% 累計。
import { ethers } from "ethers";
import { makeProvider } from "@pepelab/shared";

const FEE_ROUTER_READ_ABI = [
  "function usdc() view returns (address)",
  "function platformEarnings() view returns (uint256)",
  "function traderEarnings(address) view returns (uint256)",
] as const;
const ERC20_READ_ABI = ["function decimals() view returns (uint8)"] as const;

const ROUTER = process.env.X402_FEE_ROUTER?.trim() || "";

export function isOnchainRevenueEnabled(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(ROUTER);
}

/** 讀鏈上 70/20/10 累計（官方 USDC）。可選 trader 查其 70% 累計。 */
export async function getOnchainRevenue(trader?: string) {
  if (!isOnchainRevenueEnabled()) {
    return {
      model: "FeeRouter 70/20/10 (trader/platform/vault)",
      onChain: false,
      note: "X402_FEE_ROUTER 未設",
      totals: { count: 0, feeUsd: 0, traderShare: 0, platformShare: 0, vaultShare: 0 },
    };
  }
  const provider = makeProvider();
  const router = new ethers.Contract(ROUTER, FEE_ROUTER_READ_ABI, provider);

  const [usdcAddr, platformRaw] = await Promise.all([
    router.usdc() as Promise<string>,
    router.platformEarnings() as Promise<bigint>,
  ]);
  const decimals = Number(
    await new ethers.Contract(usdcAddr, ERC20_READ_ABI, provider).decimals(),
  );
  const P = Number(ethers.formatUnits(platformRaw, decimals)); // 累計 platform 20%

  let traderEarnings: number | undefined;
  if (trader && /^0x[0-9a-fA-F]{40}$/.test(trader)) {
    const t = (await router.traderEarnings(trader)) as bigint;
    traderEarnings = Number(ethers.formatUnits(t, decimals));
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  return {
    model: "FeeRouter 70/20/10 (trader/platform/vault)",
    onChain: true,
    network: "base-sepolia",
    settlementToken: usdcAddr,
    feeRouter: ROUTER,
    // 與前端既有 Revenue 形狀相容（count 鏈上無事件掃描，留 0）。
    totals: {
      count: 0,
      feeUsd: round(P * 5),
      traderShare: round(P * 3.5),
      platformShare: round(P),
      vaultShare: round(P * 0.5),
    },
    trader: trader ? { address: trader, traderEarningsUsdc: traderEarnings } : undefined,
  };
}
