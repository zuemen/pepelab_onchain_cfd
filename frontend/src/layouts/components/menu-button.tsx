import type { IconButtonProps } from '@mui/material/IconButton';

import IconButton from '@mui/material/IconButton';

import { t } from 'src/locales';

import { Iconify } from 'src/components/iconify';

// ----------------------------------------------------------------------

export function MenuButton({ sx, ...other }: IconButtonProps) {
  return (
    // Default label, still overridable through ...other for callers that open
    // something more specific than "the menu".
    <IconButton aria-label={t.common.shell.openNavAria} sx={sx} {...other}>
      <Iconify icon="custom:menu-duotone" width={24} />
    </IconButton>
  );
}
