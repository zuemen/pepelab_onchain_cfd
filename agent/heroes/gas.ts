// 公開鏈回放的 gas（#344）：本機用 anvil_setBalance 直接給每個帳號 1000 ETH，公開鏈不行——
// 由部署者轉 ETH 給這一天要動的帳號，夠用就好。全部只是算數，不碰鏈。

/** 每筆交易預留的 gas 量：最貴的是跟單（一次開好幾個部位），實測遠低於這個數字。 */
export const GAS_PER_TX = 1_500_000n;
/** L2 之外的 L1 資料費，每筆的上限估計（Base Sepolia 實際約 1e10–1e11 wei）。 */
export const L1_FEE_PER_TX = 2_000_000_000_000n; // 2e12 wei

export interface Need {
  address: string;
  /** 這一段會送幾筆交易。 */
  txs: number;
  /** 交易本身附帶的 ETH（開倉的執行費）。 */
  value: bigint;
}

/** 一筆交易最多花多少 ETH。 */
export const costPerTx = (maxFeePerGas: bigint): bigint => maxFeePerGas * GAS_PER_TX + L1_FEE_PER_TX;

export const needWei = (need: Need, maxFeePerGas: bigint): bigint => BigInt(need.txs) * costPerTx(maxFeePerGas) + need.value;

/**
 * 要轉多少給這個帳號：餘額不夠這一段用時，補到這一段需要的兩倍（少發幾次轉帳）；夠用就是 0。
 */
export function topUp(balance: bigint, need: Need, maxFeePerGas: bigint): bigint {
  const want = needWei(need, maxFeePerGas);
  if (want === 0n || balance >= want) return 0n;
  return want * 2n - balance;
}

/** 交易所收的執行費累積到這麼多，就由 owner（部署者）領回來繼續發 gas。 */
export const RECYCLE_THRESHOLD = 10n ** 16n; // 0.01 ETH
