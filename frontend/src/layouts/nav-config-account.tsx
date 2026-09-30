import type { AccountDrawerProps } from './components/account-drawer';

import { paths } from 'src/routes/paths';

import { t } from 'src/locales';
import { isPathEnabled } from 'src/lib/pepefi/featureFlags';

import { Iconify } from 'src/components/iconify';

// ----------------------------------------------------------------------

/**
 * 帳戶選單。
 *
 * 「My Trader Profile」原本連到 `/trader/0x7cc14a7cc14a7cc14a7cc14a`——那是
 * **24 個 hex 字元**，根本不是合法位址，點下去只會進到一個查無此人的頁面。
 * 現在改成依連線中的錢包產生：有位址就連到自己的 profile，沒有就退回
 * `/trader` 交易員總覽（一個真實存在的路由）。
 *
 * 藥水／坐騎／外觀屬於 GameFi，獎勵屬於 PEPE 獎勵；商業版旗標關掉時由
 * accountNavData 的 isPathEnabled 過濾掉，不另外寫一套判斷。
 */
const ALL_ACCOUNT_ITEMS = (address?: string | null): NonNullable<AccountDrawerProps['data']> => [
  {
    label: t.nav.account.profile,
    href: address ? `/trader/${address}` : '/trader',
    icon: <Iconify icon="custom:profile-duotone" />,
  },
  {
    label: t.nav.account.potions,
    href: `${paths.pepefi.pepe}?tab=potions`,
    icon: <Iconify icon="custom:invoice-duotone" />,
  },
  {
    label: t.nav.account.mounts,
    href: `${paths.pepefi.pepe}?tab=mounts`,
    icon: <Iconify icon="solar:settings-bold-duotone" />,
  },
  {
    label: t.nav.account.skins,
    href: `${paths.pepefi.pepe}?tab=skins`,
    icon: <Iconify icon="solar:palette-bold-duotone" />,
  },
  {
    label: t.nav.account.staking,
    href: '/stake',
    icon: <Iconify icon="solar:shield-keyhole-bold-duotone" />,
  },
  {
    label: t.nav.account.rewards,
    href: '/rewards',
    icon: <Iconify icon="solar:notes-bold-duotone" />,
  },
];

export const accountNavData = (address?: string | null): AccountDrawerProps['data'] =>
  ALL_ACCOUNT_ITEMS(address).filter((item) => isPathEnabled(item.href));

/** 舊呼叫端的相容出口（沒有錢包位址時的預設清單）。 */
export const _account = accountNavData(null);
