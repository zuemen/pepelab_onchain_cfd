import type { Mode } from 'src/contexts/mode-context';

import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { Icon } from '@iconify/react';

// ----------------------------------------------------------------------
// 「我接下來要做什麼」。
//
// 這一列刻意**不重複** hero 那排組成的連結（Wallet / Trading / Staked /
// LP Vault 已經各自連到 /exchange、/stake、/vault）。那些是「去管理某一桶錢」，
// 這裡是「現在要做的動作」。
//
// 也刻意不放「入金／提領」——這條鏈上沒有那個動作可以對應：資金來自
// /exchange 的水龍頭，保證金進出是開倉平倉的一部分。放一顆按不到東西的
// Deposit 按鈕只會讓人去找一個不存在的流程。

type Action = {
  label: string;
  to: string;
  icon: string;
  primary?: boolean;
  /** 只有專家模式看得到。 */
  expertOnly?: boolean;
};

// 沒有 "Positions"：這一列現在長在 Portfolio 頁上，連回自己是死連結。
const ACTIONS: Action[] = [
  { label: 'Trade',        to: '/exchange',    icon: 'solar:chart-square-bold-duotone', primary: true },
  { label: 'Copy a trader', to: '/marketplace', icon: 'solar:users-group-rounded-bold-duotone' },
  { label: 'History',      to: '/history',     icon: 'solar:clock-circle-bold-duotone' },
  { label: 'Pro Terminal', to: '/terminal',    icon: 'solar:programming-bold-duotone', expertOnly: true },
];

export default function QuickActions({ mode }: { mode: Mode }) {
  const actions = ACTIONS.filter((a) => mode === 'expert' || !a.expertOnly);

  return (
    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
      {actions.map((action) => (
        <Button
          key={action.label}
          component={RouterLink}
          to={action.to}
          variant={action.primary ? 'contained' : 'outlined'}
          color={action.primary ? 'primary' : 'inherit'}
          startIcon={<Icon icon={action.icon} width={18} />}
          sx={{
            textTransform: 'none',
            fontWeight: 700,
            flex: { xs: '1 1 45%', sm: '0 0 auto' },
            ...(action.primary ? {} : { borderColor: 'divider' }),
          }}
        >
          {action.label}
        </Button>
      ))}
    </Box>
  );
}
