// x402 收入歸屬 + FeeRouter 70/20/10 帳務層。
//
// 為什麼是帳務（而非直接上鏈）：FeeRouter 的拆分函式 distributeCopyFee /
// receivePerformanceFee 是 onlyAuthorized（限 copyTracker / exchange）且從
// msg.sender pull USDC，server 無法直接呼叫；加上 x402 在 Base Sepolia 結算、
// FeeRouter 在 Ethereum Sepolia，跨鏈也擋住「raw 轉帳即分潤」。因此這裡先做
// 鏈下歸屬與分潤計算（對齊鏈上 70/20/10），真正上鏈結算需要 FeeRouter 加一個
// permissionless 入口（見 README 的 on-chain settlement 說明）。

// 與 contracts/src/FeeRouter.sol 對齊
export const PLATFORM_SHARE_BPS = 2000n; // 20%
export const VAULT_SHARE_BPS = 1000n; // 10%
// trader 拿剩餘 70%

export interface RevenueEntry {
  ts: string;
  endpoint: "signals" | "oracle";
  asset?: string;
  trader?: string; // signals 歸屬的 trader；oracle 無 → 計入 protocol
  feeUsd: number;
  split: { trader: number; platform: number; vault: number };
  beneficiary: string; // 拿 70% 的對象：trader 地址 or "protocol"
  // 鏈上結算狀態（FeeRouter.routeExternalRevenue）。off = 未啟用結算。
  settlement: { status: "off" | "pending" | "settled" | "failed"; tx?: string; error?: string };
}

interface Totals {
  count: number;
  feeUsd: number;
  trader: number;
  platform: number;
  vault: number;
}

const ledger: RevenueEntry[] = [];

function splitFee(feeUsd: number) {
  const platform = (feeUsd * Number(PLATFORM_SHARE_BPS)) / 10_000;
  const vault = (feeUsd * Number(VAULT_SHARE_BPS)) / 10_000;
  const trader = feeUsd - platform - vault; // 70%
  return { trader, platform, vault };
}

/** 記一筆 x402 收入並計算 70/20/10 分潤。 */
export function recordRevenue(p: {
  endpoint: "signals" | "oracle";
  feeUsd: number;
  trader?: string;
  asset?: string;
}): RevenueEntry {
  const split = splitFee(p.feeUsd);
  const entry: RevenueEntry = {
    ts: new Date().toISOString(),
    endpoint: p.endpoint,
    asset: p.asset,
    trader: p.trader,
    feeUsd: p.feeUsd,
    split,
    // signals：70% 歸該 trader（agent 買誰的訊號、誰賺）；oracle：歸 protocol
    beneficiary: p.endpoint === "signals" && p.trader ? p.trader : "protocol",
    settlement: { status: "off" },
  };
  ledger.push(entry);
  return entry;
}

/** 收入彙總（總額 + 各方累計 + 每個 beneficiary 的 70% 累計 + 最近明細）。 */
export function getRevenueSummary() {
  const totals: Totals = { count: 0, feeUsd: 0, trader: 0, platform: 0, vault: 0 };
  const byBeneficiary: Record<string, number> = {};
  let settledOnChain = 0;
  for (const e of ledger) {
    totals.count += 1;
    totals.feeUsd += e.feeUsd;
    totals.trader += e.split.trader;
    totals.platform += e.split.platform;
    totals.vault += e.split.vault;
    byBeneficiary[e.beneficiary] = (byBeneficiary[e.beneficiary] ?? 0) + e.split.trader;
    if (e.settlement.status === "settled") settledOnChain += 1;
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    model: "FeeRouter 70/20/10 (trader/platform/vault)",
    onChainSettlement: settledOnChain > 0 ? "on" : "off",
    settledOnChain,
    totals: {
      count: totals.count,
      feeUsd: round(totals.feeUsd),
      traderShare: round(totals.trader),
      platformShare: round(totals.platform),
      vaultShare: round(totals.vault),
    },
    byBeneficiary: Object.fromEntries(
      Object.entries(byBeneficiary).map(([k, v]) => [k, round(v)]),
    ),
    recent: ledger.slice(-20),
  };
}
