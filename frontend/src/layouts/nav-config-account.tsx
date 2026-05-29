import type { AccountDrawerProps } from './components/account-drawer';

import { Iconify } from 'src/components/iconify';

// ----------------------------------------------------------------------

export const _account: AccountDrawerProps['data'] = [
  {
    label: 'My Trader Profile (個人首頁)',
    href: '/trader/0x7cc14a7cc14a7cc14a7cc14a',
    icon: <Iconify icon="custom:profile-duotone" />,
  },
  {
    label: 'Potion Shop (魔法藥水商店)',
    href: '#gamefi-potions',
    icon: <Iconify icon="custom:invoice-duotone" />,
  },
  {
    label: 'My Wardrobe & Clothes (尊貴更衣室)',
    href: '#gamefi-wardrobe',
    icon: <Iconify icon="solar:settings-bold-duotone" />,
  },
  {
    label: 'Pepe Skins & Gacha (🎰 造型盲盒與商城)',
    href: '#gamefi-skins',
    icon: <Iconify icon="solar:palette-bold-duotone" />,
  },
  {
    label: 'Staking DeFi Yields (跟單質押)',
    href: '/stake',
    icon: <Iconify icon="solar:shield-keyhole-bold-duotone" />,
  },
  {
    label: 'PepeFi Rewards 🎁 (每日激勵)',
    href: '/rewards',
    icon: <Iconify icon="solar:notes-bold-duotone" />,
  },
];
