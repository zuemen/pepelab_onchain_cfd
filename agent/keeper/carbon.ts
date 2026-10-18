// 碳權退役的 crank（#333、docs/ADR-022-carbon-retirement-splitter.md）。
//
// 平台手續費的收款人是 PlatformFeeSplitter：distribute() 把平台份額按合約寫死的比例撥給
// CarbonRetirement，retire(amount) 用預算買入模擬碳權並當場銷毀。兩者都 permissionless——
// 呼叫的人只決定「何時」，錢去哪裡由合約決定。這裡是唯一的觸發邏輯，三個呼叫端共用：
//   - keeper/run.ts：Base Sepolia keeper 每次執行順帶觸發
//   - heroes/replay.ts：回放每個模擬月份觸發一次
//   - heroes/priceTick.ts：本機展示時隨價格寫入觸發
import { ethers } from "ethers";

export interface SplitterPort {
  /** 待分配的平台份額（router 裡累積的加上 splitter 自己持有的）。 */
  pending(): Promise<bigint>;
  /** 送出 distribute() 並等它上鏈。 */
  distribute(): Promise<void>;
}

export interface RetirementPort {
  budget(): Promise<bigint>;
  quoteTonnes(amount: bigint): Promise<bigint>;
  /** 模擬賣方交得出來的量（餘額與授權取小）。 */
  availableTonnes(): Promise<bigint>;
  /** 送出 retire(amount) 並等它上鏈。 */
  retire(amount: bigint): Promise<void>;
}

export type SkipReason = "no-budget" | "below-one-unit" | "seller-short";

export interface CrankResult {
  /** 這次分配掉的平台份額（結算幣最小單位）；沒有分配時為 0。 */
  distributed: bigint;
  /** 這次花掉的退役預算。 */
  spent: bigint;
  /** 這次銷毀的模擬碳權（1e18 = 1 公噸）。 */
  retiredTonnes: bigint;
  /** 沒有退役時的原因。 */
  skipped: SkipReason | null;
}

/**
 * 退役整筆預算，除非買不到任何東西：預算為 0、不夠買 1 個最小單位（合約會 revert AmountTooSmall），
 * 或賣方交不出來（revert 在 transferFrom）。部分退役不做——預算留著，下一次一起退。
 */
export function planRetirement(x: { budget: bigint; tonnes: bigint; available: bigint }):
  | { amount: bigint; tonnes: bigint }
  | { skip: SkipReason } {
  if (x.budget === 0n) return { skip: "no-budget" };
  if (x.tonnes === 0n) return { skip: "below-one-unit" };
  if (x.available < x.tonnes) return { skip: "seller-short" };
  return { amount: x.budget, tonnes: x.tonnes };
}

export async function crankCarbon(splitter: SplitterPort, retirement: RetirementPort): Promise<CrankResult> {
  let distributed = 0n;
  const pending = await splitter.pending();
  // 空的時候 distribute() 會 revert NothingToDistribute，先看再送。
  if (pending > 0n) {
    await splitter.distribute();
    distributed = pending;
  }
  const budget = await retirement.budget();
  const plan = planRetirement({
    budget,
    tonnes: budget === 0n ? 0n : await retirement.quoteTonnes(budget),
    available: await retirement.availableTonnes(),
  });
  if ("skip" in plan) return { distributed, spent: 0n, retiredTonnes: 0n, skipped: plan.skip };
  await retirement.retire(plan.amount);
  return { distributed, spent: plan.amount, retiredTonnes: plan.tonnes, skipped: null };
}

export interface CarbonAddresses {
  feeRouter: string;
  splitter: string;
  retirement: string;
}

export interface DiscoveryReads {
  feeRouterOf(exchange: string): Promise<string>;
  platformTreasuryOf(router: string): Promise<string>;
  /** 不是 PlatformFeeSplitter（EOA、別的合約）時回 null。 */
  carbonRetirementOf(payee: string): Promise<string | null>;
}

/**
 * 從交易所找出分流與退役合約：exchange.feeRouter() → router.platformTreasury() → 若它是分流合約，
 * 再讀 carbonRetirement()。不需要另外設定位址——cutover 換掉 FeeRouter 之後自動跟上；平台收款人
 * 不是分流合約（例如現行 Base Sepolia 的 router 付給 EOA）就回 null、什麼都不做。
 */
export async function discoverCarbon(exchange: string, reads: DiscoveryReads): Promise<CarbonAddresses | null> {
  const feeRouter = await reads.feeRouterOf(exchange);
  if (!ethers.isAddress(feeRouter) || feeRouter === ethers.ZeroAddress) return null;
  const splitter = await reads.platformTreasuryOf(feeRouter);
  if (!ethers.isAddress(splitter) || splitter === ethers.ZeroAddress) return null;
  const retirement = await reads.carbonRetirementOf(splitter);
  if (retirement === null || !ethers.isAddress(retirement) || retirement === ethers.ZeroAddress) return null;
  return { feeRouter, splitter, retirement };
}

// ── ethers 介接 ────────────────────────────────────────────────────────────

export const SPLITTER_ABI = [
  "function pending() view returns (uint256)",
  "function distribute() returns (uint256 toCarbon, uint256 toTreasury)",
  "function carbonRetirement() view returns (address)",
  "function carbonShareBps() view returns (uint256)",
  "event PlatformFeesSplit(uint256 total, uint256 toCarbon, uint256 toTreasury)",
];

export const RETIREMENT_ABI = [
  "function budget() view returns (uint256)",
  "function quoteTonnes(uint256 amount) view returns (uint256)",
  "function availableTonnes() view returns (uint256)",
  "function retire(uint256 amount) returns (uint256 tonnes)",
  "function totalRetiredTonnes() view returns (uint256)",
  "event CarbonRetired(uint256 amount, uint256 tonnesCO2e, uint256 timestamp)",
];

const DISCOVERY_ABI = [
  "function feeRouter() view returns (address)",
  "function platformTreasury() view returns (address)",
  "function carbonRetirement() view returns (address)",
];

export function ethersDiscoveryReads(provider: ethers.Provider): DiscoveryReads {
  const at = (a: string) => new ethers.Contract(a, DISCOVERY_ABI, provider);
  return {
    feeRouterOf: async (a) => (await at(a).feeRouter()) as string,
    platformTreasuryOf: async (a) => (await at(a).platformTreasury()) as string,
    // EOA 回空資料、別的合約 revert：兩者都代表「不是分流合約」。
    carbonRetirementOf: async (a) => {
      try {
        return (await at(a).carbonRetirement()) as string;
      } catch {
        return null;
      }
    },
  };
}

/**
 * 用一個 runner 建出兩個 port。`wait` 決定怎麼等交易上鏈（keeper 有逾時保護、回放用 receiptOf），
 * 交易失敗就丟出——由呼叫端決定是記錄還是中止。
 */
export function ethersCarbonPorts(
  a: { splitter: string; retirement: string },
  runner: ethers.ContractRunner,
  wait: (tx: ethers.ContractTransactionResponse) => Promise<unknown>,
): { splitter: SplitterPort; retirement: RetirementPort } {
  const s = new ethers.Contract(a.splitter, SPLITTER_ABI, runner);
  const r = new ethers.Contract(a.retirement, RETIREMENT_ABI, runner);
  return {
    splitter: {
      pending: async () => (await s.pending()) as bigint,
      distribute: async () => {
        await wait(await s.distribute());
      },
    },
    retirement: {
      budget: async () => (await r.budget()) as bigint,
      quoteTonnes: async (amount) => (await r.quoteTonnes(amount)) as bigint,
      availableTonnes: async () => (await r.availableTonnes()) as bigint,
      retire: async (amount) => {
        await wait(await r.retire(amount));
      },
    },
  };
}

/** 一行摘要，keeper 與展示程序的 log 共用。 */
export function describeCrank(r: CrankResult): string {
  const t = ethers.formatUnits(r.retiredTonnes, 18);
  if (r.skipped === null) return `carbon: distributed ${r.distributed} wei, retired ${t} t (SIMULATED credits)`;
  return `carbon: distributed ${r.distributed} wei, no retirement (${r.skipped})`;
}
