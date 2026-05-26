import type { NavSectionProps } from 'src/components/nav-section';

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
   * PepeFi
   */
  {
    subheader: 'PepeFi',
    items: [
      { title: 'Landing', path: paths.pepefi.landing, icon: ICONS.dashboard },
      { title: 'Dashboard', path: paths.pepefi.dashboard, icon: ICONS.analytics },
      { title: 'Exchange', path: paths.pepefi.exchange, icon: ICONS.ecommerce },
      { title: 'Marketplace', path: paths.pepefi.marketplace, icon: ICONS.invoice },
      { title: 'Portfolio', path: paths.pepefi.portfolio, icon: ICONS.banking },
      { title: 'Vault', path: paths.pepefi.vault, icon: ICONS.file },
      { title: 'History', path: paths.pepefi.history, icon: ICONS.order },
      { title: 'Whale Tracker', path: paths.pepefi.whale, icon: ICONS.label },
      { title: 'ESG', path: paths.pepefi.esg, icon: ICONS.tour },
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
  /**
   * Admin
   */
  {
    subheader: 'Admin',
    items: [
      {
        title: 'Admin',
        path: paths.pepefi.adminOracle,
        icon: ICONS.params,
        children: [
          { title: 'Oracle', path: paths.pepefi.adminOracle },
          { title: 'Treasury', path: paths.pepefi.adminTreasury },
        ],
      },
    ],
  },
];
