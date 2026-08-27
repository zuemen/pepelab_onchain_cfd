import type { TraderScoreBreakdown } from 'src/lib/pepefi/leaderboardMetrics';

import Box from '@mui/material/Box';
import Popover from '@mui/material/Popover';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';

interface Props {
  anchorEl: HTMLElement | null;
  score:    TraderScoreBreakdown | null;
  onClose:  () => void;
}

const fPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/**
 * TraderScore 是怎麼算出來的——不是展示公式長什麼樣子,是把這位交易者自己
 * 五行的實際數字與各自拿到幾分攤開來。點分數 chip 開啟,錨定在該 chip 上。
 */
export default function ScoreBreakdownPopover({ anchorEl, score, onClose }: Props) {
  if (!score) return null;
  const s = t.marketplace.scoreBreakdown;

  const rows: Array<{ label: string; value: string; points: string }> = [
    {
      label: s.returnLabel,
      value: score.returnPct === null ? '—' : fPct(score.returnPct),
      points: `${score.returnScore.toFixed(0)} / 40`,
    },
    {
      label: s.winRateLabel,
      value: score.winRate === null ? '—' : `${(score.winRate * 100).toFixed(0)}%`,
      points: `${score.winRateScore.toFixed(0)} / 25`,
    },
    {
      label: t.marketplace.card.stakeLabel,
      value: score.stakeAmount.toLocaleString(),
      points: `${score.stakeScore.toFixed(0)} / 20`,
    },
    {
      label: t.marketplace.table.reputation,
      value: String(score.reputationValue),
      points: `${score.reputationScore.toFixed(0)} / 15`,
    },
    {
      label: s.slashLabel,
      value: score.slashRatio > 0 ? `-${(score.slashRatio * 100).toFixed(0)}%` : '—',
      points: score.slashPenalty === 0 ? '0' : score.slashPenalty.toFixed(0),
    },
  ];

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
    >
      <Box sx={{ p: 2, minWidth: 240 }}>
        {score.insufficientSample && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1, fontWeight: 'bold' }}>
            ⚠ {s.insufficientNote}
          </Typography>
        )}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 12px', alignItems: 'center' }}>
          {rows.map(row => (
            <Box key={row.label} sx={{ display: 'contents' }}>
              <Typography variant="caption" color="text.secondary">{row.label}</Typography>
              <Typography variant="caption" sx={{ fontFamily: MONO, textAlign: 'right' }}>{row.value}</Typography>
              <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold', textAlign: 'right' }}>
                {row.points}
              </Typography>
            </Box>
          ))}
        </Box>
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{s.totalLabel}</Typography>
          <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
            {interpolate(s.totalValue, { total: score.total.toFixed(0) })}
          </Typography>
        </Box>
      </Box>
    </Popover>
  );
}
