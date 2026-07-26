import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import { Icon } from '@iconify/react';

interface Props {
  /** Drop the trailing Chinese label where space is tight (e.g. the header). */
  compact?: boolean;
}

/**
 * Everything on this platform is testnet-simulated. Rather than leaving that
 * implicit, label it the way TradingView labels Paper Trading — it is a feature
 * of the demo, not a caveat to bury.
 */
export default function PaperTradingBadge({ compact = false }: Props) {
  return (
    <Tooltip
      arrow
      title="本平台運行於測試網，所有資產與資金皆為模擬，不涉及真實金錢。等同 TradingView 的 Paper Trading 模式。"
    >
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        icon={<Icon icon="solar:info-circle-bold-duotone" />}
        label={compact ? 'PAPER TRADING' : 'PAPER TRADING · 測試網模擬交易'}
        sx={{ fontWeight: 'bold', letterSpacing: 0.3, cursor: 'help' }}
      />
    </Tooltip>
  );
}
