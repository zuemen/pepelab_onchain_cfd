import type { PnlStatus } from './positionPnl';

import { t, interpolate } from 'src/locales';

/**
 * 終端機持倉資料的新鮮度。持倉每 POSITION_POLL_MS 輪詢一次；畫面上一律標出「更新於幾點」，
 * 讀取失敗或太久沒更新時改成警告並把數字變灰——合約讀數看起來很權威，過期了更要說。
 */
export type DataFreshness = 'never' | 'fresh' | 'stale' | 'failed';

export function dataFreshness(a: {
  updatedAt: number | null;
  readFailed: boolean;
  nowMs: number;
  staleAfterMs: number;
}): DataFreshness {
  if (a.updatedAt === null) return a.readFailed ? 'failed' : 'never';
  if (a.readFailed) return 'failed';
  return a.nowMs - a.updatedAt > a.staleAfterMs ? 'stale' : 'fresh';
}

const hhmmss = (ms: number) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

export function freshnessText(
  f: DataFreshness,
  updatedAt: number | null,
  staleAfterMs: number
): string {
  if (f === 'never' || updatedAt === null) return t.terminal.panel.neverRead;
  const time = hhmmss(updatedAt);
  if (f === 'failed') return interpolate(t.terminal.panel.readFailed, { time });
  if (f === 'stale')
    return interpolate(t.terminal.panel.staleData, { time, sec: Math.round(staleAfterMs / 1000) });
  return interpolate(t.terminal.panel.updatedAt, { time });
}

/** 損益沒有數字時顯示的簡短原因與說明。status = ok 時兩者皆 null。 */
export function pnlStatusText(status: PnlStatus): { label: string; hint: string } | null {
  const s = t.common.pnlStatus;
  switch (status) {
    case 'unreadable':
      return { label: s.unreadable, hint: s.unreadableHint };
    case 'noPrice':
      return { label: s.noPrice, hint: s.noPriceHint };
    case 'stale':
      return { label: s.stale, hint: s.staleHint };
    default:
      return null;
  }
}
