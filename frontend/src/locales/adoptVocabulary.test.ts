import { it, expect, describe } from 'vitest';

import en from './en';
import zhTW from './zh-TW';

// ----------------------------------------------------------------------

/**
 * #149 / ADR-007：採用配置是 Simple Mode 的無槓桿現貨商品，整個流程不能出現
 * 交易桌的字——槓桿、清算、交易者、跟單。一個畫面如果需要這些字，代表機制已經
 * 滲漏到顯示層（frontend/CONTEXT.md 的 *(absent)* 規則），這份測試把那條規則
 * 變成會失敗的斷言。
 */
const BANNED = [
  '槓桿', '清算', '強制平倉', '交易者', '交易員', '跟單', '跟隨', '永續', '保證金',
  'leverage', 'liquidat', 'trader', 'copy', 'follow', 'perp', 'margin', 'mirror', 'subscribe',
];

function strings(value: unknown, at: string): { at: string; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  }
  return [];
}

function offenders(catalog: typeof zhTW): string[] {
  // 採用流程會顯示的全部字串：自己的 catalog，加上 prettyError 在買進失敗時可能
  // 回的那幾句（金庫的 revert、使用者拒絕、認不出來的 revert）。
  const shown = [
    ...strings(catalog.adopt, 'adopt'),
    ...strings(
      {
        MintingHalted: catalog.errors.contract.MintingHalted,
        StalePrice: catalog.errors.contract.StalePrice,
        ReserveRatioTooLow: catalog.errors.contract.ReserveRatioTooLow,
        CapExceeded: catalog.errors.contract.CapExceeded,
        EnforcedPause: catalog.errors.contract.EnforcedPause,
        userRejected: catalog.errors.contract['user rejected'],
        executionReverted: catalog.errors.contract['execution reverted'],
        reverted: catalog.errors.reverted.adopt,
        unrecognised: catalog.errors.unrecognised,
      },
      'errors',
    ),
  ];
  return shown.flatMap(({ at, text }) =>
    BANNED.filter((word) => text.toLowerCase().includes(word)).map((word) => `${at}: "${word}" in ${text}`)
  );
}

describe('the adopt flow vocabulary', () => {
  it('never uses trading-desk words in zh-TW', () => {
    expect(offenders(zhTW)).toEqual([]);
  });

  it('never uses trading-desk words in en', () => {
    expect(offenders(en)).toEqual([]);
  });

  it('actually catches a banned word', () => {
    const leaky = { ...zhTW, adopt: { ...zhTW.adopt, title: '跟單交易者' } };
    expect(offenders(leaky)).not.toEqual([]);
  });
});

/**
 * #331：「你的資產在哪裡」在 Simple 模式顯示的那一份，同一套詞彙規則。Expert 那一份
 * 刻意用交易桌的字（保證金、跟單、清算），不在這裡檢查。
 */
function custodyOffenders(catalog: typeof zhTW): string[] {
  const shown = [
    ...strings(catalog.custody.heading, 'custody.heading'),
    ...strings(catalog.custody.simple, 'custody.simple'),
  ];
  return shown.flatMap(({ at, text }) =>
    BANNED.filter((word) => text.toLowerCase().includes(word)).map((word) => `${at}: "${word}" in ${text}`)
  );
}

describe('the custody explainer in Simple Mode', () => {
  it('never uses trading-desk words in zh-TW', () => {
    expect(custodyOffenders(zhTW)).toEqual([]);
  });

  it('never uses trading-desk words in en', () => {
    expect(custodyOffenders(en)).toEqual([]);
  });

  it('actually catches a banned word', () => {
    const leaky = { ...zhTW, custody: { ...zhTW.custody, simple: { ...zhTW.custody.simple, intro: '保證金在你名下' } } };
    expect(custodyOffenders(leaky)).not.toEqual([]);
  });
});
