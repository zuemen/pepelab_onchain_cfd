import { it, expect, describe } from 'vitest';

import en from './en';
import zhTW from './zh-TW';

// ----------------------------------------------------------------------

/**
 * #148：/exchange 只剩水龍頭與 ETH↔USDC swap，CFD 開倉搬到 /terminal。開倉面板刪掉
 * 之後，這份 catalog 還留著叫人「到右側 Margin Account 存成保證金」的 toast——指向
 * 一張已經不存在的卡片。這條斷言讓 exchange catalog 不再提起保證金、開倉、槓桿。
 */
const BANNED = ['保證金', '開倉', '槓桿', 'margin', 'leverage', 'open position'];

function strings(value: unknown, at: string): { at: string; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  }
  return [];
}

function offenders(catalog: typeof zhTW): string[] {
  return strings(catalog.exchange, 'exchange').flatMap(({ at, text }) =>
    BANNED.filter((word) => text.toLowerCase().includes(word)).map((word) => `${at}: "${word}" in ${text}`)
  );
}

describe('the /exchange page vocabulary', () => {
  it('never mentions margin, opening positions or leverage in zh-TW', () => {
    expect(offenders(zhTW)).toEqual([]);
  });

  it('never mentions margin, opening positions or leverage in en', () => {
    expect(offenders(en)).toEqual([]);
  });

  it('actually catches a banned word', () => {
    const leaky = { ...zhTW, exchange: { ...zhTW.exchange, working: '存入保證金中…' } };
    expect(offenders(leaky)).not.toEqual([]);
  });
});
