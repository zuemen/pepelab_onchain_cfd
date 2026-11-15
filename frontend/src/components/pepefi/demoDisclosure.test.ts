import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { tenant } from 'src/tenant';
import { SHOW_DEMO_DISCLOSURE } from 'src/lib/pepefi/featureFlags';

import PaperTradingBadge from './PaperTradingBadge';
import { SyntheticDisclosure } from './SyntheticDisclosure';

// 2026-11-15 本人決定：default 租戶展示時不顯示每頁的測試網揭露橫幅與「模擬交易」標籤
// （featureFlags.SHOW_DEMO_DISCLOSURE）。租戶站照舊顯示，文案也維持原本的測試網揭露。
describe('SHOW_DEMO_DISCLOSURE', () => {
  it('default 租戶、未設 VITE_SHOW_DEMO_DISCLOSURE：關閉', () => {
    expect(tenant.id).toBe('default');
    expect(SHOW_DEMO_DISCLOSURE).toBe(false);
  });

  it('關閉時橫幅與標籤都不輸出任何東西', () => {
    expect(renderToStaticMarkup(createElement(SyntheticDisclosure))).toBe('');
    expect(renderToStaticMarkup(createElement(PaperTradingBadge))).toBe('');
    expect(renderToStaticMarkup(createElement(PaperTradingBadge, { compact: true }))).toBe('');
  });
});
