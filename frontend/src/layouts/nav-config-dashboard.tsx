import type { Mode } from 'src/contexts/mode-context';
import type { NavSectionProps, NavItemDataProps } from 'src/components/nav-section';

import { paths } from 'src/routes/paths';

import { t } from 'src/locales';
import { CONFIG } from 'src/global-config';
import { SHOW_PERPETUALS } from 'src/lib/pepefi/featureFlags';

import { SvgColor } from 'src/components/svg-color';

// ----------------------------------------------------------------------

const icon = (name: string) => (
  <SvgColor src={`${CONFIG.assetsDir}/assets/icons/navbar/${name}.svg`} />
);

const ICONS = {
  job: icon('ic-job'),
  blog: icon('ic-blog'),
  chat: icon('ic-chat'),
  mail: icon('ic-mail'),
  user: icon('ic-user'),
  file: icon('ic-file'),
  lock: icon('ic-lock'),
  tour: icon('ic-tour'),
  order: icon('ic-order'),
  label: icon('ic-label'),
  blank: icon('ic-blank'),
  kanban: icon('ic-kanban'),
  folder: icon('ic-folder'),
  course: icon('ic-course'),
  params: icon('ic-params'),
  banking: icon('ic-banking'),
  booking: icon('ic-booking'),
  invoice: icon('ic-invoice'),
  product: icon('ic-product'),
  calendar: icon('ic-calendar'),
  disabled: icon('ic-disabled'),
  external: icon('ic-external'),
  subpaths: icon('ic-subpaths'),
  menuItem: icon('ic-menu-item'),
  ecommerce: icon('ic-ecommerce'),
  analytics: icon('ic-analytics'),
  dashboard: icon('ic-dashboard'),
};

// ----------------------------------------------------------------------

export const navData: NavSectionProps['data'] = [
  /**
   * PepeLab
   */
  {
    subheader: t.nav.section.pepelab,
    items: [
      // 順序＝平台想被理解的順序：先看自己的資產配置，再去買賣代幣化資產，
      // 然後才是跟單與其他。永續終端機（terminal）排到最後、緊鄰 agent 工具，
      // 因為它現在是進階功能，不是門面。
      { title: t.nav.item.portfolio, path: paths.pepefi.portfolio, icon: ICONS.analytics },
      { title: t.nav.item.tokens, path: paths.pepefi.tokens, icon: ICONS.product },
      { title: t.nav.item.exchange, path: paths.pepefi.exchange, icon: ICONS.ecommerce },
      { title: t.nav.item.marketplace, path: paths.pepefi.marketplace, icon: ICONS.invoice },
      { title: t.nav.item.history, path: paths.pepefi.history, icon: ICONS.order },
      { title: t.nav.item.vault, path: paths.pepefi.vault, icon: ICONS.file },
      { title: t.nav.item.esg, path: paths.pepefi.esg, icon: ICONS.tour },
      { title: t.nav.item.whale, path: paths.pepefi.whale, icon: ICONS.label },
      { title: t.nav.item.pepe, path: paths.pepefi.pepe, icon: ICONS.blog },
      { title: t.nav.item.rewards, path: paths.pepefi.rewards, icon: ICONS.booking },
      // 專業終端是永續的入口,跟著 SHOW_PERPETUALS 走。收的是入口不是路徑——
      // 直接打 /terminal 仍然到得了,既有部位照樣平得掉。
      ...(SHOW_PERPETUALS
        ? [{ title: t.nav.item.terminal, path: paths.pepefi.terminal, icon: ICONS.dashboard }]
        : []),
      { title: t.nav.item.x402, path: paths.pepefi.x402, icon: ICONS.external },
      { title: t.nav.item.sessions, path: paths.pepefi.sessions, icon: ICONS.lock },
      { title: t.nav.item.agentMonitor, path: paths.pepefi.agentMonitor, icon: ICONS.analytics },
    ],
  },
  /**
   * Trader
   */
  {
    subheader: t.nav.section.trader,
    items: [
      { title: t.nav.item.traderDashboard, path: paths.pepefi.trader, icon: ICONS.user },
      { title: t.nav.item.stake, path: paths.pepefi.stake, icon: ICONS.booking },
    ],
  },
];

// ----------------------------------------------------------------------
// Simple 模式的側邊欄。
//
// 全站 17 個項目對新手是雜訊，不是選項——切到 simple 模式之前，mode 這個
// 狀態存在了，但從沒改變過側邊欄一個字。這裡把它接上：simple 只留使用流程
// 上真的用得到的五個入口，其餘收起來，讓側邊欄本身變成「這是簡化版」的
// 第一個訊號，而不是要使用者先點開每一項才知道自己用不到。
//
// 照使用順序排：先看自己的錢與持倉（Portfolio，前身的 Dashboard 已併入），
// 再去買代幣化資產（Tokens——simple 模式的主要動作就是這個，它本來被漏掉，
// 於是簡化版反而只剩永續入口），接著是現金／水龍頭（Exchange），然後看大戶
// 動向（Whale Tracker），Pepe 養成中心放最後，因為它是遊戲化的附加內容。
//
// terminal 不在這裡，而且是刻意的：simple 模式就是「沒有槓桿的那一版」。
const SIMPLE_NAV_PATHS: readonly string[] = [
  paths.pepefi.portfolio,
  paths.pepefi.tokens,
  paths.pepefi.exchange,
  paths.pepefi.whale,
  paths.pepefi.pepe,
];

/**
 * 依模式決定側邊欄／手機選單／搜尋列要顯示哪些項目。
 *
 * 不做路由層級的攔截——simple 模式收起的是入口，不是路徑本身；被藏起來的
 * 頁面仍然可以直接用網址打開。把它們真的鎖起來會變成一套假的權限系統：
 * 擋不住真的想繞過限制的人（前端路由本來就攔不住），卻會擋到照著教學文件
 * 或客服連結進來、剛好走了一條沒在側邊欄上的路徑的正常使用者。
 */
export function navDataForMode(mode: Mode): NavSectionProps['data'] {
  if (mode === 'expert') return navData;

  const allItems = navData.flatMap((section) => section.items);
  const items = SIMPLE_NAV_PATHS.map((path) => allItems.find((item) => item.path === path)).filter(
    (item): item is NavItemDataProps => item !== undefined
  );

  return [{ subheader: t.nav.section.pepelab, items }];
}
