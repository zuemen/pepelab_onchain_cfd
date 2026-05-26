import type { BoxProps } from '@mui/material/Box';

// ----------------------------------------------------------------------

export function NavUpgrade({ sx, ...other }: BoxProps) {
  // Return null to completely hide sidebar upgrade/pro promotional boxes
  return null;
}

// ----------------------------------------------------------------------

export function UpgradeBlock({ sx, ...other }: BoxProps) {
  // Return null to completely hide the "Small Rocket" upgrade popover banner
  return null;
}
