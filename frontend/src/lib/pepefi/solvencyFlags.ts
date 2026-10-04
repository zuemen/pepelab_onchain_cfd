import { t, interpolate } from 'src/locales';

import { safeRead } from './safeRead';

/**
 * Agent 風險監控頁的償付後盾揭露。ADL 與組合保證金的開關是合約狀態
 * （`PerpetualExchange.adlEnabled()` / `portfolioMarginEnabled()`），owner 隨時能改，
 * 所以文案只描述機制，開或關一律讀鏈上。
 *
 * undefined = 還在讀；null = 讀不到（舊 ABI、RPC 失敗）——顯示「無法讀取」，不猜。
 */
export interface SolvencyFlags {
  adl: boolean | null | undefined;
  portfolioMargin: boolean | null | undefined;
}

export function flagStateLabel(v: boolean | null | undefined): string {
  if (v === undefined) return t.admin.agent.flagState.loading;
  if (v === null) return t.admin.agent.flagState.unknown;
  return v ? t.admin.agent.flagState.on : t.admin.agent.flagState.off;
}

export function solvencyDisclosure(flags: SolvencyFlags): string {
  return interpolate(t.admin.agent.disclosure, {
    adl: flagStateLabel(flags.adl),
    portfolioMargin: flagStateLabel(flags.portfolioMargin),
  });
}

/** 兩個 view 各自隔離：一個 revert 不會讓另一個也變成「無法讀取」。 */
interface FlagViews {
  adlEnabled?: () => Promise<unknown>;
  portfolioMarginEnabled?: () => Promise<unknown>;
}

export async function readSolvencyFlags(
  // ethers 的 Contract 型別上沒有具名方法，所以只要求是個物件，內部再當成 FlagViews 用。
  contract: object | null | undefined
): Promise<SolvencyFlags> {
  const exchange = contract as FlagViews | null | undefined;
  const read = (fn?: () => Promise<unknown>) =>
    fn
      ? safeRead(fn().then((v) => Boolean(v)) as Promise<boolean | null>, null)
      : Promise.resolve(null);
  const [adl, portfolioMargin] = await Promise.all([
    read(exchange?.adlEnabled?.bind(exchange)),
    read(exchange?.portfolioMarginEnabled?.bind(exchange)),
  ]);
  return { adl, portfolioMargin };
}
