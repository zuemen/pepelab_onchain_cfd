import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { getPepeRank } from 'src/utils/pepefi-assets';
import { t, interpolate } from 'src/locales';

interface Props {
  reputation: number | bigint | null;
  size?: 'sm' | 'md';
}

/**
 * 聲譽徽章。聲譽只反映質押被罰沒的紀錄（TraderStake.reputationScore），跟績效無關，
 * 所以顯示分數本身；顏色仍依鑽石／黃金／白銀／青銅分級，級別名稱放在滑鼠移上去的說明裡。
 * 以前顯示「等級 Diamond 鑽石」，看起來像績效等級——虧 99% 的交易者只要沒被罰沒也是鑽石。
 */
export default function TraderRankBadge({ reputation, size = 'sm' }: Props) {
  const rank = getPepeRank(reputation);

  return (
    <Tooltip title={interpolate(t.common.rankTooltip, { tier: rank.label })}>
      <Chip
        size={size === 'sm' ? 'small' : 'medium'}
        variant="outlined"
        label={
          <>
            <Typography component="span" variant="caption" sx={{ opacity: 0.8, mr: 0.5, fontWeight: 'bold', fontSize: '0.675rem' }}>
              {t.common.rankPrefix}
            </Typography>
            <Typography component="span" variant="caption" sx={{ fontWeight: 'black', letterSpacing: 0.5 }}>
              {reputation === null ? t.common.rankUnknown : String(reputation)}
            </Typography>
          </>
        }
        sx={{
          background: rank.gradient,
          color: '#ffffff',
          borderColor: rank.borderColor,
          boxShadow: rank.shadow,
          fontWeight: 'bold',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
          cursor: 'default',
          '& .MuiChip-label': {
            display: 'inline-flex',
            alignItems: 'center',
            px: 1.2,
          },
          '&:hover': {
            boxShadow: rank.shadow.replace('12px', '18px'),
          }
        }}
      />
    </Tooltip>
  );
}
