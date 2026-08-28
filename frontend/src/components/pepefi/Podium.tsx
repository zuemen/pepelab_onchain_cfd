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
import { scoreChipColor, fPnL, type TraderCard } from 'src/lib/pepefi/leaderboardMetrics';

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
 * 領獎台:三張等大的卡片由左到右照名次排(參考 Hyperdash 排行榜前三名的排法),
 * 不是「第一名置中放大」的傳統頒獎台造型——填色的權益曲線是卡片的視覺主體,
 * 名次徽章縮小放右上角。跟著目前排序走,而不是固定按 TraderScore。交易者少於
 * 3 位時,對應的格子就不畫,不補空卡片。
 */
export default function Podium({ podium, onScoreClick }: Props) {
  if (podium.length === 0) return null;

  const card = (trader: TraderCard, rank: number) => (
    <Card
      key={trader.address}
      sx={{
        flex: '1 1 240px',
        minWidth: 240,
        maxWidth: 340,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        border: '1px solid',
        borderColor: MEDAL_BORDER[rank - 1],
        boxShadow: MEDAL_GLOW[rank - 1],
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Avatar
            src={getPepeAvatar(trader.reputation, trader.address)}
            sx={{
              width: 36,
              height: 36,
              flexShrink: 0,
              border: '1px solid',
              borderColor: MEDAL_BORDER[rank - 1],
              bgcolor: 'rgba(255, 255, 255, 0.05)',
              '& .MuiAvatar-img': { objectFit: 'contain', padding: '2px' },
            }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap sx={{ fontWeight: 'bold', fontSize: '0.8125rem' }}>
              {trader.displayName || t.marketplace.card.noName}
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
              {shortAddr(trader.address)}
            </Typography>
          </Box>
        </Box>
        <Typography sx={{ fontSize: '1.375rem', lineHeight: 1, flexShrink: 0 }} title={`#${rank}`}>
          {MEDALS[rank - 1]}
        </Typography>
      </Box>

      {/* 填色區域圖是卡片的視覺主體,不是表格那種塞在角落的小折線——variant="lg"。 */}
      <EquitySparkline curve={trader.equityCurve} pnl={trader.pnl7d} variant="lg" />

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Chip
          label={trader.score.total.toFixed(0)}
          size="small"
          color={scoreChipColor(trader.score.total)}
          onClick={e => onScoreClick(e.currentTarget, trader)}
          sx={{ fontWeight: 'bold', fontFamily: MONO, cursor: 'pointer' }}
        />
        <Typography
          sx={{
            fontFamily: MONO,
            fontWeight: 'bold',
            fontSize: '0.875rem',
            color: trader.pnl7d > 0n ? 'success.main' : trader.pnl7d < 0n ? 'error.main' : 'text.primary',
          }}
        >
          {trader.pnl7d !== 0n ? fPnL(trader.pnl7d) : '—'}
        </Typography>
      </Box>

      {trader.hasStrategy ? (
        <Button
          fullWidth
          variant="contained"
          size="small"
          color="primary"
          component={RouterLink}
          to={`/copy/${trader.address}`}
          sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem' }}
        >
          {t.marketplace.card.copy}
        </Button>
      ) : (
        <Button
          fullWidth
          disabled
          variant="contained"
          size="small"
          sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem' }}
        >
          {t.marketplace.card.noStrategyButton}
        </Button>
      )}
    </Card>
  );

  return (
    <Box>
      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1.5, display: 'block', mb: 1.5 }}>
        {t.marketplace.podium.heading}
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        {podium.map((trader, idx) => card(trader, idx + 1))}
      </Stack>
    </Box>
  );
}
