import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { MONO, shortAddr } from 'src/components/pepefi/brandKit';
import { getPepeAvatar } from 'src/utils/pepefi-assets';
import EquitySparkline from 'src/components/pepefi/EquitySparkline';
import { scoreChipColor, type TraderCard } from 'src/lib/pepefi/leaderboardMetrics';

const MEDALS = ['🥇', '🥈', '🥉'];
const MEDAL_GLOW = [
  '0 8px 24px rgba(234, 179, 8, 0.16)',
  '0 8px 24px rgba(145, 158, 171, 0.12)',
  '0 8px 24px rgba(245, 158, 11, 0.12)',
];
const MEDAL_BORDER = [
  'rgba(234, 179, 8, 0.5)',
  'rgba(145, 158, 171, 0.4)',
  'rgba(245, 158, 11, 0.4)',
];

interface Props {
  /** 目前排序下,排除「資料不足」交易者後的前三名——已經是最終要顯示的那三位,不在這裡再篩一次。 */
  podium: TraderCard[];
  onScoreClick: (el: HTMLElement, trader: TraderCard) => void;
}

/**
 * 領獎台:中間第一名視覺上最大,兩側第二、三名——跟著目前排序走,而不是固定按
 * TraderScore。交易者少於 3 位時,對應的格子就不畫,不補空卡片。
 */
export default function Podium({ podium, onScoreClick }: Props) {
  if (podium.length === 0) return null;

  const card = (trader: TraderCard, rank: number) => {
    const big = rank === 1;
    return (
      <Card
        key={trader.address}
        sx={{
          p: big ? 3 : 2.5,
          width: big ? 220 : 188,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1.5,
          textAlign: 'center',
          border: '1px solid',
          borderColor: MEDAL_BORDER[rank - 1],
          boxShadow: MEDAL_GLOW[rank - 1],
          order: rank === 1 ? 0 : rank === 2 ? -1 : 1,
        }}
      >
        <Typography sx={{ fontSize: big ? '2rem' : '1.5rem', lineHeight: 1 }}>{MEDALS[rank - 1]}</Typography>

        <Avatar
          src={getPepeAvatar(trader.reputation, trader.address)}
          sx={{
            width: big ? 64 : 48,
            height: big ? 64 : 48,
            border: '2px solid',
            borderColor: MEDAL_BORDER[rank - 1],
            bgcolor: 'rgba(255, 255, 255, 0.05)',
            '& .MuiAvatar-img': { objectFit: 'contain', padding: '3px' },
          }}
        />

        <Box sx={{ minWidth: 0, width: '100%' }}>
          <Typography
            noWrap
            sx={{ fontWeight: 'bold', fontSize: big ? '0.9375rem' : '0.8125rem' }}
          >
            {trader.displayName || t.marketplace.card.noName}
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
            {shortAddr(trader.address)}
          </Typography>
        </Box>

        <Chip
          label={trader.score.total.toFixed(0)}
          size="small"
          color={scoreChipColor(trader.score.total)}
          onClick={e => onScoreClick(e.currentTarget, trader)}
          sx={{ fontWeight: 'bold', fontFamily: MONO, cursor: 'pointer' }}
        />

        <EquitySparkline curve={trader.equityCurve} pnl={trader.pnl7d} />

        {trader.hasStrategy ? (
          <Button
            fullWidth
            variant="contained"
            size="small"
            color="primary"
            component={RouterLink}
            to={`/copy/${trader.address}`}
            sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem', mt: 0.5 }}
          >
            {t.marketplace.card.copy}
          </Button>
        ) : (
          <Button
            fullWidth
            disabled
            variant="contained"
            size="small"
            sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem', mt: 0.5 }}
          >
            {t.marketplace.card.noStrategyButton}
          </Button>
        )}
      </Card>
    );
  };

  return (
    <Box>
      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1.5, display: 'block', mb: 1.5 }}>
        {t.marketplace.podium.heading}
      </Typography>
      <Stack direction="row" spacing={2} justifyContent="center" alignItems="flex-end" flexWrap="wrap">
        {podium.map((trader, idx) => card(trader, idx + 1))}
      </Stack>
    </Box>
  );
}
