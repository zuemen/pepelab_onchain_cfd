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

const ALLOWED: ReadonlyArray<{ prefix: string; why: string }> = [
  // ── 旗標關閉時整個畫面／元件不渲染 ──
  { prefix: 'copy.', why: '/copy/:addr 由 FeatureGate 收起' },
  { prefix: 'rewards.', why: '/rewards 由 PEPE 獎勵旗標收起' },
  // /stake 照常開放（配置市集發布策略的前提），所以只豁免旗標關閉時會被 stake.copyOff.* 取代的四條。
  { prefix: 'stake.sections.reputation.subtitle', why: '旗標關閉時改用 stake.copyOff.subtitle' },
  { prefix: 'stake.current.minimum', why: '旗標關閉時改用 stake.copyOff.minimum' },
  { prefix: 'stake.add.description', why: '旗標關閉時改用 stake.copyOff.addDescription' },
  { prefix: 'stake.info.slashing', why: '旗標關閉時改用 stake.copyOff.slashing' },
  { prefix: 'marketplace.subtitle', why: '交易者排行榜副標，只在 Expert + 跟單旗標開啟時渲染' },
  { prefix: 'marketplace.sort.', why: '同上（排行榜）' },
  { prefix: 'marketplace.card.', why: '同上（排行榜）' },
  { prefix: 'marketplace.footer.', why: '同上（排行榜）' },
  { prefix: 'whale.feed.copy', why: 'CopyCta 在旗標關閉時回 null' },
  { prefix: 'traderProfile.header.follower', why: '跟隨者數在旗標關閉時不渲染' },
  { prefix: 'traderProfile.header.noStrategy', why: '跟單按鈕在旗標關閉時不渲染' },
  { prefix: 'traderProfile.header.copyThisTrader', why: '同上' },
  { prefix: 'traderProfile.stats.followers', why: '跟隨者統計卡在旗標關閉時不渲染' },
  { prefix: 'traderProfile.stats.copiers', why: '同上' },
  { prefix: 'traderProfile.followers.', why: '跟隨者清單在旗標關閉時不渲染' },
  { prefix: 'traderDashboard.publish.stakeRequiredBody', why: '旗標關閉時改顯示 stakeRequiredBodyNeutral' },
  { prefix: 'traderDashboard.earnings.claimable', why: '旗標關閉時改顯示 claimableNeutral' },
  { prefix: 'traderDashboard.earnings.note', why: '旗標關閉時改顯示 noteNeutral' },
  { prefix: 'landing.tagline', why: '旗標關閉時改用 landing.copyOff.*' },
  { prefix: 'landing.features.copy', why: '跟單功能卡在旗標關閉時被濾掉' },
  { prefix: 'landing.steps.four', why: '旗標關閉時改用 landing.copyOff.stepFour' },
  { prefix: 'landing.markup.heroBefore', why: '旗標關閉時改用 landing.copyOff.heroBefore' },
  { prefix: 'landing.markup.paperMid', why: '旗標關閉時改用 landing.copyOff.paperMid' },
  { prefix: 'meta.description', why: 'vite.config.ts 在旗標關閉時改用 meta.descriptionNoCopy（index.html 不用這一條）' },
  { prefix: 'portfolio.quickAction.copyTrader', why: '旗標關閉時改用 quickAction.marketplace' },
  { prefix: 'portfolio.page.emptyDescription', why: '旗標關閉時改用 emptyDescriptionNoCopy（前綴也涵蓋那一條，但它本身不含跟單用語）' },
  { prefix: 'portfolio.page.openCount', why: 'Expert 表頭；旗標關閉時改用 openCountNoCopy' },
  { prefix: 'vault.markup.howItWorksBody', why: '旗標關閉時改用 howItWorksBodyNoCopy' },

  // ── 只在使用者真的有跟單資料時出現（既有部位不能被旗標藏起來） ──
  { prefix: 'portfolio.page.', why: '跟單部位卡與統計：只在已有跟單紀錄時顯示（copyDeskVisibility）' },
  { prefix: 'portfolio.close.', why: '平倉欄對跟單留下的部位的說明，只在該列是跟單部位時出現' },
  { prefix: 'portfolio.column.copiedFrom', why: '旗標關閉時只在有跟單留下的部位時才顯示此欄' },
  { prefix: 'history.', why: '鏈上歷史事件（跟單費等），只在使用者真的有這類事件時出現' },
  { prefix: 'traderProfile.activity.', why: '交易者的鏈上活動時間軸，只在真的有跟單事件時出現' },
  { prefix: 'errors.', why: '合約錯誤對應，只在觸發該錯誤時出現' },

  // ── 非使用者畫面 ──
  { prefix: 'admin.', why: '管理員頁（營運方自己看，描述實際的費用分潤模型）' },
  { prefix: 'common.wallet.mockDesc', why: 'Mock Wallet 只在開發環境出現' },
  { prefix: 'common.notification.', why: '範本通知資料，已不再渲染（只剩 _mock 引用）' },
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

const isAllowed = (key: string) => ALLOWED.some(({ prefix }) => key.startsWith(prefix));

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
    const unused = ALLOWED.filter(({ prefix }) => !all.some((k) => k.startsWith(prefix))).map((a) => a.prefix);
    expect(unused).toEqual([]);
  });
});
