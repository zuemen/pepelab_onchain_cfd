import { it, expect, describe } from 'vitest';

import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';

import { LOCALES } from './catalogs';

// ----------------------------------------------------------------------

/**
 * 跟單旗標關閉（商業版預設）時，使用者看得到的字串不得提到跟單。
 *
 * 靜態掃描分不出「這個 key 此刻有沒有被渲染」，所以反過來做：掃整份 catalog，
 * 每一個含跟單用語的 key 都必須落在下面的白名單裡，而白名單的每一條都寫明它為什麼
 * 在旗標關閉時看不到（或為什麼看得到是正當的）。新增一句提到跟單的文案而沒有處理
 * 旗標，這個測試就會失敗、逼人做決定。
 */
const ZH = /跟單|跟隨者/;
const EN =
  /copy[- ]?trad|copy a trader|copy this trader|copier|copied (?:position|from)|\+ copied|follower|unfollow|copy fee|copy position|copy record|social copy|copying (?:a|the|trader)/i;

// 白名單一律寫**精確 key**，只有兩條「整條路由都被旗標收起」的例外用前綴（ROUTE_PREFIXES）。
// 萬用前綴（例如 portfolio.page.）會讓同一區塊新加的跟單文案悄悄過關。
const ROUTE_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: 'copy.', why: '/copy/:addr 整條路由由 FeatureGate 收起' },
  { prefix: 'rewards.', why: '/rewards 整條路由由 PEPE 獎勵旗標收起' },
];

const ALLOWED: ReadonlyArray<{ key: string; why: string }> = [
  // ── 旗標關閉時元件不渲染，或改用替代文案 ──
  { key: 'marketplace.subtitle', why: '交易者排行榜，只在 Expert + 跟單旗標開啟時渲染' },
  { key: 'marketplace.sort.followers', why: '同上（排行榜）' },
  { key: 'marketplace.card.copy', why: '同上（排行榜）' },
  { key: 'marketplace.card.followersLabel', why: '同上（排行榜）' },
  { key: 'marketplace.footer.followersTotal', why: '同上（排行榜）' },
  { key: 'whale.feed.copy', why: 'CopyCta 在旗標關閉時回 null' },
  { key: 'whale.feed.copyHint', why: '同上' },
  { key: 'traderProfile.header.followerSingular', why: '跟隨者數在旗標關閉時不渲染' },
  { key: 'traderProfile.header.followerPlural', why: '同上' },
  { key: 'traderProfile.header.noStrategy', why: '跟單按鈕在旗標關閉時不渲染' },
  { key: 'traderProfile.header.copyThisTrader', why: '同上' },
  { key: 'traderProfile.stats.followers', why: '跟隨者統計卡在旗標關閉時不渲染' },
  { key: 'traderProfile.stats.copiers', why: '同上' },
  { key: 'traderProfile.followers.titleFirst', why: '跟隨者清單在旗標關閉時不渲染' },
  { key: 'traderDashboard.publish.stakeRequiredBody', why: '旗標關閉時改顯示 stakeRequiredBodyNeutral' },
  { key: 'traderDashboard.earnings.claimable', why: '旗標關閉時改顯示 claimableNeutral' },
  { key: 'traderDashboard.earnings.note', why: '旗標關閉時改顯示 noteNeutral' },
  { key: 'stake.sections.reputation.subtitle', why: '旗標關閉時改用 stake.copyOff.subtitle' },
  { key: 'stake.current.minimum', why: '旗標關閉時改用 stake.copyOff.minimum' },
  { key: 'stake.add.description', why: '旗標關閉時改用 stake.copyOff.addDescription' },
  { key: 'stake.info.slashing', why: '旗標關閉時改用 stake.copyOff.slashing' },
  { key: 'landing.tagline', why: '旗標關閉時改用 landing.copyOff.tagline' },
  { key: 'landing.features.copyTitle', why: '跟單功能卡在旗標關閉時被濾掉' },
  { key: 'landing.features.copyDesc', why: '同上' },
  { key: 'landing.steps.four', why: '旗標關閉時改用 landing.copyOff.stepFour' },
  { key: 'landing.markup.heroBefore', why: '旗標關閉時改用 landing.copyOff.heroBefore' },
  { key: 'landing.markup.paperMid', why: '旗標關閉時改用 landing.copyOff.paperMid' },
  { key: 'meta.description', why: 'vite.config.ts 在旗標關閉時改用 meta.descriptionNoCopy' },
  { key: 'portfolio.quickAction.copyTrader', why: '旗標關閉時改用 quickAction.marketplace' },
  { key: 'portfolio.page.emptyDescription', why: '旗標關閉時改用 emptyDescriptionNoCopy' },
  { key: 'portfolio.page.openCount', why: 'Expert 表頭；旗標關閉時改用 openCountNoCopy' },
  { key: 'vault.markup.howItWorksBody', why: '旗標關閉時改用 howItWorksBodyNoCopy' },

  // ── 只在使用者真的有跟單資料時出現（既有部位不能被旗標藏起來） ──
  { key: 'portfolio.page.activeCopies', why: '跟單統計卡：copyDeskVisibility，旗標關閉時不顯示' },
  { key: 'portfolio.page.totalCopyPnl', why: '同上' },
  { key: 'portfolio.page.noCopyPositions', why: '同上' },
  { key: 'portfolio.page.copyPositions', why: '跟單部位卡：只在已有跟單紀錄時顯示' },
  { key: 'portfolio.page.notCopyingAnyone', why: '跟單部位卡的空狀態：旗標關閉時零筆不顯示整張卡' },
  { key: 'portfolio.page.copyColumn.copiedAt', why: '跟單部位卡的欄位' },
  { key: 'portfolio.page.copyPerformance', why: '跟單績效圖：旗標關閉時不顯示' },
  { key: 'portfolio.page.unfollow', why: '跟單部位卡的取消按鈕（既有跟單要能取消）' },
  { key: 'portfolio.page.unfollowedOk', why: '取消跟單成功的提示' },
  { key: 'portfolio.close.copyManaged', why: '只在該列屬於 active 跟單紀錄時出現' },
  { key: 'portfolio.close.leftover', why: '只在該列是跟單留下的部位時出現' },
  { key: 'portfolio.column.copiedFrom', why: '旗標關閉時只在有跟單留下的部位時才顯示此欄' },
  { key: 'history.eventType.copyFee', why: '鏈上歷史事件，只在使用者真的有這類事件時出現' },
  { key: 'history.eventType.unfollow', why: '同上' },
  { key: 'history.detail.unfollowed', why: '同上' },
  { key: 'traderProfile.activity.timeline.kind.following', why: '交易者鏈上活動時間軸，只在真的有跟單事件時出現' },
  { key: 'traderProfile.activity.timeline.kind.followedBy', why: '同上' },
  { key: 'traderProfile.activity.timeline.detail.followingBefore', why: '同上' },
  { key: 'traderProfile.activity.timeline.detail.followedByAfter', why: '同上' },
  { key: 'errors.contract.no strategies', why: '合約錯誤對應，只在觸發該錯誤時出現' },
  { key: 'errors.contract.TradingFeeExceedsMargin', why: '同上' },
  { key: 'errors.contract.CopyAlreadyClaimed', why: '同上' },
  { key: 'errors.contract.NotFollowing', why: '同上' },
  { key: 'errors.contract.SelfCopyNotAllowed', why: '同上' },
  { key: 'errors.reverted.copy', why: '同上（跟單獎勵領取失敗）' },

  // ── 非使用者畫面 ──
  { key: 'admin.treasury.claim.note', why: '管理員頁（營運方自己看，描述實際的費用分潤模型）' },
  { key: 'admin.treasury.incentives.description', why: '同上' },
  { key: 'admin.treasury.incentives.descriptionPoints', why: '同上（#169 點數版的同一段說明）' },
  { key: 'admin.treasury.info.revenueModelBody', why: '同上' },
  { key: 'common.wallet.mockDesc', why: 'Mock Wallet 只在開發環境出現' },
];

function hits(catalog: unknown, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      if (re.test(node)) out.push(path);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(catalog, '');
  return out;
}

const isAllowed = (key: string) =>
  ALLOWED.some((a) => a.key === key) || ROUTE_PREFIXES.some(({ prefix }) => key.startsWith(prefix));

describe.skipIf(FEATURE_COPY_TRADING)('跟單旗標關閉時沒有殘留的跟單文案', () => {
  it('zh-TW：每個含跟單用語的字串都在白名單（且有理由）裡', () => {
    expect(hits(LOCALES['zh-TW'].catalog, ZH).filter((k) => !isAllowed(k))).toEqual([]);
  });

  it('en：同上', () => {
    expect(hits(LOCALES.en.catalog, EN).filter((k) => !isAllowed(k))).toEqual([]);
  });

  it('替代文案本身不含跟單用語', () => {
    const zh = LOCALES['zh-TW'].catalog;
    const en = LOCALES.en.catalog;
    const zhAlt = [
      zh.meta.descriptionNoCopy,
      zh.portfolio.quickAction.marketplace,
      zh.portfolio.page.emptyDescriptionNoCopy,
      zh.portfolio.page.openCountNoCopy,
      zh.traderDashboard.publish.stakeRequiredBodyNeutral,
      zh.nav.account.staking,
      ...Object.values(zh.stake.copyOff),
      zh.traderDashboard.earnings.claimableNeutral,
      zh.traderDashboard.earnings.noteNeutral,
      zh.vault.markup.howItWorksBodyNoCopy,
      ...Object.values(zh.landing.copyOff),
    ];
    const enAlt = [
      en.meta.descriptionNoCopy,
      en.portfolio.quickAction.marketplace,
      en.portfolio.page.emptyDescriptionNoCopy,
      en.portfolio.page.openCountNoCopy,
      en.traderDashboard.publish.stakeRequiredBodyNeutral,
      en.nav.account.staking,
      ...Object.values(en.stake.copyOff),
      en.traderDashboard.earnings.claimableNeutral,
      en.traderDashboard.earnings.noteNeutral,
      en.vault.markup.howItWorksBodyNoCopy,
      ...Object.values(en.landing.copyOff),
    ];
    for (const s of zhAlt) expect(s, s).not.toMatch(ZH);
    for (const s of enAlt) expect(s, s).not.toMatch(EN);
  });

  it('每一條白名單都真的用得到（避免白名單腐爛成萬用豁免）', () => {
    const all = [...hits(LOCALES['zh-TW'].catalog, ZH), ...hits(LOCALES.en.catalog, EN)];
    const unusedKeys = ALLOWED.filter(({ key }) => !all.includes(key)).map((a) => a.key);
    const unusedPrefixes = ROUTE_PREFIXES.filter(({ prefix }) => !all.some((k) => k.startsWith(prefix))).map((a) => a.prefix);
    expect([...unusedKeys, ...unusedPrefixes]).toEqual([]);
  });
});
