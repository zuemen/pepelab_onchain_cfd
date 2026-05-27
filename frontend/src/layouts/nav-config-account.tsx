import type { AccountDrawerProps } from './components/account-drawer';

import { Iconify } from 'src/components/iconify';

// ----------------------------------------------------------------------

export const _account: AccountDrawerProps['data'] = [
  {
    label: 'My Trader Profile (個人首頁)',
    href: '/trader/0x7cc14a7cc14a7cc14a7cc14a7cc14a',
    icon: <Iconify icon="custom:profile-duotone" />,
  },
  {
    label: 'Pepe Breeding Lab (佩佩蛙孵化室)',
    href: '#gamefi-breed',
    icon: <Iconify icon="solar:notes-bold-duotone" />,
  },
  {
    label: 'Potion Shop (藥水商店)',
    href: '#gamefi-potions',
    icon: <Iconify icon="custom:invoice-duotone" />,
  },
  {
    label: 'My Wardrobe & Clothes (更衣室與等級)',
    href: '#gamefi-wardrobe',
    icon: <Iconify icon="solar:settings-bold-duotone" />,
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
