import { createElement } from 'react';
import { it, expect, describe } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { t, interpolate } from 'src/locales';
import { LOCALES } from 'src/locales/catalogs';

import { resyncPreview } from 'src/lib/pepefi/autoSync';

import { MemoryRouter } from 'react-router';

import AutoSyncFields from './AutoSyncFields';
import { CopySyncNoticeView } from './CopySyncNotice';
import { SyncGasTank, ConsentNoticeView, AutoSyncDisclosure, ResyncConfirmContent } from './AutoSyncDialogs';

// ----------------------------------------------------------------------
// 自動同步（ADR-024）元件的伺服器端渲染煙霧測試：不需要瀏覽器，確認渲染不會丟例外，
// 而且估算、Simple Mode 不出現槓桿這兩條規則真的反映在輸出上。

const FEE = 10n ** 14n; // 0.0001 ETH
const settings = { maxLeverage: 3, minSyncInterval: 3600, tipWei: 5n * 10n ** 13n };
const noop = () => undefined;

const html = (el: ReturnType<typeof createElement>) =>
  // MUI 的 Select 在伺服器端會把 & 轉成實體；比對前還原
  renderToStaticMarkup(el).replace(/&amp;/g, '&');

describe('AutoSyncFields', () => {
  it('estimates how many syncs the prefund pays for', () => {
    const out = html(
      createElement(AutoSyncFields, {
        value: settings,
        onChange: noop,
        maxTipWei: 10n ** 15n,
        executionFee: FEE,
        legs: 3,
        showLeverage: true,
        prefund: { value: '0.0035', onChange: noop },
      })
    );
    // 每次 3 × 0.0001 + 0.00005 = 0.00035 ETH → 0.0035 ETH 夠 10 次
    expect(out).toContain(interpolate(t.copy.autoSync.estimate, { count: '10', legs: 3, cost: '0.00035' }));
    expect(out).toContain(t.copy.autoSync.maxLeverage);
  });

  it('leaves the leverage cap out when leverage must not be shown', () => {
    const out = html(
      createElement(AutoSyncFields, {
        value: settings,
        onChange: noop,
        maxTipWei: 10n ** 15n,
        executionFee: FEE,
        legs: 3,
        showLeverage: false,
        tankBalance: 0n,
      })
    );
    expect(out).not.toContain(t.copy.autoSync.maxLeverage);
    expect(out).not.toContain(t.copy.autoSync.maxLeverageHelp);
    expect(out).toContain(interpolate(t.copy.autoSync.estimate, { count: '0', legs: 3, cost: '0.00035' }));
  });
});

describe('SyncGasTank', () => {
  it('shows the balance and keeps withdraw disabled only when the tank is empty', () => {
    const full = html(createElement(SyncGasTank, { balance: 10n ** 15n, affordable: 2n, busy: false, onDeposit: noop, onWithdraw: noop }));
    expect(full).toContain(interpolate(t.portfolio.autoSync.tank.balance, { eth: '0.001' }));
    expect(full).toContain(interpolate(t.portfolio.autoSync.tank.estimate, { count: '2' }));
    expect(full.match(/disabled=""/g) ?? []).toHaveLength(0);

    const empty = html(createElement(SyncGasTank, { balance: 0n, affordable: null, busy: false, onDeposit: noop, onWithdraw: noop }));
    expect(empty.match(/disabled=""/g) ?? []).toHaveLength(1);
  });

  it('says executors are paused instead of a sync count when the fee is above every consent', () => {
    const out = html(createElement(SyncGasTank, { balance: 10n ** 15n, affordable: 2n, consentBlocked: true, busy: false, onDeposit: noop, onWithdraw: noop }));
    expect(out).toContain(t.portfolio.autoSync.tank.consentBlocked);
    expect(out).not.toContain(interpolate(t.portfolio.autoSync.tank.estimate, { count: '2' }));
  });

  it('says it cannot read the balance instead of showing zero', () => {
    const out = html(createElement(SyncGasTank, { balance: null, affordable: null, busy: false, onDeposit: noop, onWithdraw: noop }));
    expect(out).toContain('—');
    expect(out).not.toContain(interpolate(t.portfolio.autoSync.tank.balance, { eth: '0' }));
  });
});

describe('AutoSyncFields executor', () => {
  const base = { value: settings, onChange: noop, maxTipWei: 10n ** 15n, executionFee: FEE, legs: 3, showLeverage: true };

  it('offers “only this address” with its help text, and shows the problem instead when the input is wrong', () => {
    const fine = html(createElement(AutoSyncFields, { ...base, executor: { value: '', onChange: noop, problem: null } }));
    expect(fine).toContain(t.copy.autoSync.executor);
    expect(fine).toContain(t.copy.autoSync.executorHelp);

    const self = html(createElement(AutoSyncFields, { ...base, executor: { value: '0x' + 'aa'.repeat(20), onChange: noop, problem: 'self' } }));
    expect(self).toContain(t.copy.autoSync.executorInvalid.self);
    expect(self).not.toContain(t.copy.autoSync.executorHelp);
  });

  it('mentions the extra transaction only on the copy page and only when an address is filled in', () => {
    const agent = '0x' + 'bb'.repeat(20);
    expect(html(createElement(AutoSyncFields, { ...base, executor: { value: agent, onChange: noop, problem: null, extraTxNote: true } })))
      .toContain(t.copy.autoSync.executorExtraTx);
    expect(html(createElement(AutoSyncFields, { ...base, executor: { value: '', onChange: noop, problem: null, extraTxNote: true } })))
      .not.toContain(t.copy.autoSync.executorExtraTx);
  });

  it('is absent when the contract has no designated executor', () => {
    expect(html(createElement(AutoSyncFields, base))).not.toContain(t.copy.autoSync.executor);
  });
});

describe('AutoSyncDisclosure', () => {
  it('discloses the USDC trading fee, performance fee and timing risk before switching on', () => {
    const out = html(createElement(AutoSyncDisclosure));
    expect(out).toContain(t.copy.autoSync.disclosure);
    expect(out).toContain(t.copy.autoSync.costs);
    expect(out).toContain(t.copy.autoSync.selfCustody);
    // 「每次同步全平再開」「績效費」「時機」三件事都要寫到
    expect(t.copy.autoSync.costs).toMatch(/交易費.*績效費.*時間點/);
    expect(t.copy.autoSync.cooldownHelp).toMatch(/越短/);
  });
});

describe('ResyncConfirmDialog', () => {
  const C = t.portfolio.autoSync.confirm;
  const BTC = '0x' + '01'.repeat(32);
  const preview = resyncPreview({
    legs: [
      { asset: BTC, weight: 6000n, isLong: true, strategyLeverage: 5, assetMaxLeverage: 2, tradingFeeBps: 100 },
      { asset: BTC, weight: 4000n, isLong: false, strategyLeverage: 4, assetMaxLeverage: 5, tradingFeeBps: 10 },
    ],
    followerMax: 0,
    executionFee: FEE,
    tankBalance: 0n,
    currentLegs: [{ value: 600n * 10n ** 18n, pnl: 100n * 10n ** 18n, leverage: 2 }],
  });
  const props = {
    open: true, onClose: noop, loading: false, error: null, version: 2n, preview, currentMaxLeverage: 2, busy: false, onConfirm: noop,
  };

  it('shows every leg of the new version with the leverage that will be used, before anything is sent', () => {
    const out = html(createElement(ResyncConfirmContent, props));
    expect(out).toContain(interpolate(C.title, { version: '3' }));
    expect(out).toContain(interpolate(C.intro, { version: '3' }));
    expect(out).toContain(C.long);
    expect(out).toContain(C.short);
    expect(out).toContain('60.00%');
    expect(out).toContain('5× → <b>2×</b>');
    expect(out).toContain(C.capped);
    expect(out).toContain(C.closeAll);
    expect(out).toContain(C.cta);
  });

  it('warns about a missing leverage cap, a leverage raise and an empty tank, and shows the fee estimates', () => {
    const out = html(createElement(ResyncConfirmContent, props));
    expect(out).toContain(C.noCap);
    expect(out).toContain(interpolate(C.leverageRaised, { to: 4, from: 2 }));
    expect(out).toContain(interpolate(C.topUp, { eth: '0.0002' }));
    expect(out).toContain(C.perfFee);
    expect(out).toContain(interpolate(C.approx, { amount: '10.00', token: 'USDC' }));
    expect(out).toContain(C.tradingFee);
  });

  it('cannot be confirmed while loading or after a failed read', () => {
    const loading = html(createElement(ResyncConfirmContent, { ...props, loading: true, preview: null, version: null }));
    expect(loading).toContain(C.loading);
    expect(loading.match(/disabled=""/g)?.length ?? 0).toBeGreaterThan(0);
    const failed = html(createElement(ResyncConfirmContent, { ...props, error: C.loadFailed, preview: null }));
    expect(failed).toContain(C.loadFailed);
    expect(failed).not.toContain(C.closeAll);
  });
});

describe('CopySyncNotice (site-wide reminder)', () => {
  const N = t.portfolio.syncNotice;
  const render = (attention: Parameters<typeof CopySyncNoticeView>[0]['attention']) =>
    html(createElement(MemoryRouter, null, createElement(CopySyncNoticeView, { attention, onDismiss: noop })));

  it('says how many entries lag, which ones need the follower and why, and links to the portfolio', () => {
    const out = render({ behind: 3, needsYou: 2, reasons: ['needsGas', 'manual'], signature: '0:1,1:1,2:1' });
    expect(out).toContain(interpolate(N.behind, { count: 3 }));
    expect(out).toContain(interpolate(N.needsYou, { count: 2, reasons: `${N.reasons.needsGas}${N.reasonSeparator}${N.reasons.manual}` }));
    expect(out).toContain('href="/portfolio"');
    expect(out).toContain(N.dismiss);
    expect(out).toContain('MuiAlert-standardWarning');
    // Simple 模式、跟單旗標關閉的建置也會看到：不提槓桿
    expect(out).not.toMatch(/槓桿|leverage/i);
  });

  it('is calm when everything only waits for the cooldown or an executor', () => {
    const out = render({ behind: 1, needsYou: 0, reasons: [], signature: '0:2' });
    expect(out).toContain(N.waitingOnly);
    expect(out).toContain('MuiAlert-standardInfo');
  });

  it('renders nothing when nothing lags', () => {
    expect(render({ behind: 0, needsYou: 0, reasons: [], signature: '' })).toBe('');
  });

  it('never mentions copy trading or leverage in its strings', () => {
    const all = JSON.stringify(N);
    expect(all).not.toMatch(/跟單|跟隨者|槓桿/);
  });
});

describe('Simple Mode auto-sync wording', () => {
  // Simple Mode 沒有自動同步的勾選框、「設定」與「立即同步」（跟單頁 autoSyncEntry、投資組合同一規則）：
  // 給 Simple Mode 的句子不能提槓桿，也不能叫人去按看不到的按鈕。
  const simpleStrings = (c: (typeof LOCALES)[keyof typeof LOCALES]['catalog']) => [
    c.copy.autoSync.expertOnly,
    c.copy.confirm.snapshotNoteSyncableSimple,
    c.portfolio.autoSync.status.manualSimple,
    c.portfolio.autoSync.status.feeAboveCapSimple,
    c.portfolio.autoSync.outdatedHintSimple,
  ];

  it.each(['zh-TW', 'en'] as const)('%s: no leverage and no Expert-only buttons', (code) => {
    const c = LOCALES[code].catalog;
    // 按鈕名稱以 catalog 為準（「設定」「立即同步」），英文的 settings 當一般名詞用不算
    const buttons = [c.portfolio.autoSync.syncNow, `「${c.portfolio.autoSync.settings}」`, `“${c.portfolio.autoSync.settings}”`];
    for (const s of simpleStrings(c)) {
      expect(s, s).not.toMatch(/槓桿|leverage/i);
      for (const b of buttons) expect(s, s).not.toContain(b);
    }
  });
});

describe('ConsentNoticeView', () => {
  const D = t.portfolio.autoSync.dialog;
  it('shows the exact fees the follower signs, even one wei apart', () => {
    const out = html(createElement(ConsentNoticeView, { notice: { kind: 'raised', fee: FEE + 1n, old: FEE } }));
    expect(out).toContain(interpolate(D.consentChanged, { fee: '0.000100000000000001', old: '0.0001' }));
  });

  it('picks the sentence for each case', () => {
    expect(html(createElement(ConsentNoticeView, { notice: null }))).toBe('');
    expect(html(createElement(ConsentNoticeView, { notice: { kind: 'unknownFee' } }))).toContain(D.consentUnknownFee);
    expect(html(createElement(ConsentNoticeView, { notice: { kind: 'lowered', fee: FEE / 2n, old: FEE } })))
      .toContain(interpolate(D.consentLowered, { fee: '0.00005', old: '0.0001' }));
    expect(html(createElement(ConsentNoticeView, { notice: { kind: 'current', fee: FEE } })))
      .toContain(interpolate(D.consentCurrent, { fee: '0.0001' }));
    expect(html(createElement(ConsentNoticeView, { notice: { kind: 'sign', fee: FEE } })))
      .toContain(interpolate(D.consentLine, { fee: '0.0001' }));
  });
});
