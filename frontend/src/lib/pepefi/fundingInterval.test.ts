import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';
import { interpolate } from 'src/locales/interpolate';

import { UNKNOWN_INTERVAL, fundingIntervalOf, formatFundingInterval } from './fundingInterval';

const zh = LOCALES['zh-TW'].catalog.terminal;
const en = LOCALES.en.catalog.terminal;

/** 與 OrderTicket／FundingTable 相同的組字方式。 */
const labels = (terminal: typeof zh, seconds: bigint | null) => {
  const interval = formatFundingInterval(seconds, terminal.funding.intervalUnit);
  return {
    ticket: interpolate(terminal.ticket.fundingRate, { interval }),
    column: interpolate(terminal.funding.column.rate, { interval }),
  };
};

describe('資金費率標籤由鏈上 FUNDING_INTERVAL() 組字（#196）', () => {
  it('28800 秒 → 8 小時：與改版前寫死的字串完全相同（正式站外觀不變）', () => {
    expect(labels(zh, 28_800n)).toEqual({ ticket: '資金費率（8 小時）', column: '費率（8 小時）' });
    expect(labels(en, 28_800n)).toEqual({ ticket: 'Funding rate (8h)', column: 'Rate (8h)' });
  });

  it('300 秒 → 5 分鐘：週期改了，標籤跟著改', () => {
    expect(labels(zh, 300n)).toEqual({ ticket: '資金費率（5 分鐘）', column: '費率（5 分鐘）' });
    expect(labels(en, 300n)).toEqual({ ticket: 'Funding rate (5m)', column: 'Rate (5m)' });
  });

  it('讀不到時顯示「—」，不回退成寫死的 8 小時', () => {
    expect(labels(zh, null)).toEqual({ ticket: '資金費率（—）', column: '費率（—）' });
    expect(labels(en, null)).toEqual({ ticket: 'Funding rate (—)', column: 'Rate (—)' });
  });

  it('兩個語系的標籤都用 {interval} placeholder', () => {
    for (const terminal of [zh, en]) {
      expect(terminal.ticket.fundingRate).toContain('{interval}');
      expect(terminal.funding.column.rate).toContain('{interval}');
      expect(terminal.ticket.fundingRate).not.toMatch(/8/);
      expect(terminal.funding.column.rate).not.toMatch(/8/);
    }
  });
});

describe('formatFundingInterval', () => {
  const u = zh.funding.intervalUnit;

  it('取能整除的最大單位', () => {
    expect(formatFundingInterval(86_400n, u)).toBe('1 天');
    expect(formatFundingInterval(3_600, u)).toBe('1 小時');
    expect(formatFundingInterval(5_400n, u)).toBe('90 分鐘'); // 1.5 小時不四捨五入
    expect(formatFundingInterval(90n, u)).toBe('90 秒');
  });

  it('null／undefined／0／負數／非整數 → —', () => {
    for (const v of [null, undefined, 0n, 0, -300n, Number.NaN, 1.5]) {
      expect(formatFundingInterval(v, u)).toBe(UNKNOWN_INTERVAL);
    }
  });
});

describe('fundingIntervalOf', () => {
  it('取第一個讀到的週期；全部讀不到或沒有資料是 null', () => {
    expect(fundingIntervalOf({})).toBeNull();
    expect(fundingIntervalOf({ a: { interval: null } })).toBeNull();
    expect(fundingIntervalOf({ a: { interval: null }, b: { interval: 300n } })).toBe(300n);
  });
});
