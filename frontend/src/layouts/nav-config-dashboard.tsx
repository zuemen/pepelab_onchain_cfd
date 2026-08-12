import type { Mode } from 'src/contexts/mode-context';
import type { NavSectionProps, NavItemDataProps } from 'src/components/nav-section';

import { paths } from 'src/routes/paths';

import { CONFIG } from 'src/global-config';

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
    subheader: 'PepeLab',
    items: [
      { title: '🏠 Portfolio', path: paths.pepefi.portfolio, icon: ICONS.analytics },
      { title: '🐸 Pepe 養成中心', path: paths.pepefi.pepe, icon: ICONS.blog },
      { title: 'Exchange', path: paths.pepefi.exchange, icon: ICONS.ecommerce },
      { title: '🪙 代幣化資產', path: paths.pepefi.tokens, icon: ICONS.product },
      { title: 'Pro Terminal', path: paths.pepefi.terminal, icon: ICONS.dashboard },
      { title: 'x402 Signal API', path: paths.pepefi.x402, icon: ICONS.external },
      { title: 'Marketplace', path: paths.pepefi.marketplace, icon: ICONS.invoice },
      { title: 'Vault', path: paths.pepefi.vault, icon: ICONS.file },
      { title: 'History', path: paths.pepefi.history, icon: ICONS.order },
      { title: 'Whale Tracker', path: paths.pepefi.whale, icon: ICONS.label },
      { title: 'ESG', path: paths.pepefi.esg, icon: ICONS.tour },
      { title: 'Rewards 🎁', path: paths.pepefi.rewards, icon: ICONS.booking },
      { title: '🤖 Agent Sessions', path: paths.pepefi.sessions, icon: ICONS.lock },
      { title: '📊 Agent Monitor', path: paths.pepefi.agentMonitor, icon: ICONS.analytics },
    ],
  },
  /**
   * Trader
   */
  {
    subheader: 'Trader',
    items: [
      { title: 'Trader Dashboard', path: paths.pepefi.trader, icon: ICONS.user },
      { title: 'Stake', path: paths.pepefi.stake, icon: ICONS.booking },
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
// 再去下單（Exchange），然後看大戶動向（Whale Tracker），Pepe 養成中心放
// 最後，因為它是遊戲化的附加內容。
const SIMPLE_NAV_PATHS: readonly string[] = [
  paths.pepefi.portfolio,
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

  const allItems = navData.flatMap(section => section.items);
  const items = SIMPLE_NAV_PATHS
    .map(path => allItems.find(item => item.path === path))
    .filter((item): item is NavItemDataProps => item !== undefined);

  return [{ subheader: 'PepeLab', items }];
}
