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

/**
 * #131：側邊欄的入口已經改名「資產」／"Assets"（nav.item.tokens）。其他頁面引導使用者去那一頁時
 * 必須用同一個名字——說「到『資產交易』頁」會讓人在側邊欄找一個不存在的項目。
 */
describe('pointers to the /tokens page use the sidebar name (#131)', () => {
  const OLD_NAMES = ['資產交易', 'trade assets'];
  const stale = (catalog: typeof zhTW) =>
    strings(catalog, 'catalog').flatMap(({ at, text }) =>
      OLD_NAMES.filter((name) => text.toLowerCase().includes(name)).map((name) => `${at}: "${name}"`)
    );

  it('no catalog string mentions the old page name', () => {
    expect(stale(zhTW)).toEqual([]);
    expect(stale(en)).toEqual([]);
  });

  it('the sidebar entry is still the name the pointers use', () => {
    expect(zhTW.nav.item.tokens).toContain('資產');
    expect(zhTW.nav.item.tokens).not.toContain('交易');
    expect(en.nav.item.tokens).toContain('Assets');
    expect(zhTW.exchange.tx.faucetStable).toContain('「資產」頁');
    expect(en.exchange.tx.faucetStable).toContain('the Assets page');
  });
});
