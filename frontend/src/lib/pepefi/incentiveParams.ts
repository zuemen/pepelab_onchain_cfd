// PepeIncentives 的獎勵數值——交易挖礦比例與上限、跟單獎勵、四個等級的門檻與獎勵。
//
// 這些全部是合約的 owner 參數（setTradeMining / setCopyReward / setTierParams），部署後
// 隨時會調：GameFi 上線時就從合約的預設值（0.5%、200、1萬→500…）改成 GameFi 的數值。
// /rewards 以前把它們寫死在常數與文案裡，合約一調，畫面就跟鏈上不符。所以一律從鏈上讀，
// 讀不到就是 null，畫面改用不提數字的文案，不拿舊的預設值充數。

/** 合約上的原始值，金額都是 18 位小數。 */
export interface IncentiveParams {
  tradeMiningBps: bigint;
  tradeMiningCap: bigint;
  copyReward: bigint;
  tierThresholds: readonly bigint[];
  tierRewards: readonly bigint[];
}

const TIER_COUNT = 4;

/** 只需要這幾個 view 的最小介面，測試不必建整顆 ethers Contract。 */
export interface IncentiveParamsReader {
  tradeMiningBps(): Promise<unknown>;
  tradeMiningCap(): Promise<unknown>;
  copyReward(): Promise<unknown>;
  tierThresholds(i: number): Promise<unknown>;
  tierRewards(i: number): Promise<unknown>;
}

const tiers = Array.from({ length: TIER_COUNT }, (_, i) => i);

/** 任何一個讀取失敗就回 null：數字要嘛全對，要嘛不顯示。 */
export async function readIncentiveParams(c: IncentiveParamsReader): Promise<IncentiveParams | null> {
  try {
    const [bps, cap, copy, thresholds, rewards] = await Promise.all([
      c.tradeMiningBps(),
      c.tradeMiningCap(),
      c.copyReward(),
      Promise.all(tiers.map((i) => c.tierThresholds(i))),
      Promise.all(tiers.map((i) => c.tierRewards(i))),
    ]);
    return {
      tradeMiningBps: BigInt(bps as bigint),
      tradeMiningCap: BigInt(cap as bigint),
      copyReward: BigInt(copy as bigint),
      tierThresholds: thresholds.map((v) => BigInt(v as bigint)),
      tierRewards: rewards.map((v) => BigInt(v as bigint)),
    };
  } catch {
    return null;
  }
}

/** 交易挖礦的預估獎勵：名目 × bps，封頂 cap。與 PepeIncentives.claimTradeMining 同一個算法。 */
export function tradeMiningReward(notional: bigint, p: Pick<IncentiveParams, 'tradeMiningBps' | 'tradeMiningCap'>): bigint {
  const r = (notional * p.tradeMiningBps) / 10_000n;
  return r > p.tradeMiningCap ? p.tradeMiningCap : r;
}

/** 200n → "2"、50n → "0.5"。 */
export function bpsToPercent(bps: bigint): string {
  return (Number(bps) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 18 位小數的金額 → 「1,000」這種整數顯示。 */
export function formatWholeTokens(v: bigint): string {
  return (v / 10n ** 18n).toLocaleString();
}
