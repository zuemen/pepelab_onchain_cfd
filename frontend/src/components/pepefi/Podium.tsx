import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { MONO, shortAddr } from 'src/components/pepefi/brandKit';
import { getPepeAvatar } from 'src/utils/pepefi-assets';
import AllocationRow from 'src/components/pepefi/AllocationRow';
import EquitySparkline from 'src/components/pepefi/EquitySparkline';
import { scoreChipColor, fPnL, fWinRate, fReturnPct, type TraderCard } from 'src/lib/pepefi/leaderboardMetrics';

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

/** 小標籤 + mono 數值的一格統計,三格並排。 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', display: 'block', fontSize: '0.6875rem', lineHeight: 1.4 }}
      >
        {label}
      </Typography>
      <Typography
        noWrap
        sx={{
          fontFamily: MONO,
          fontWeight: 'bold',
          fontSize: '0.8125rem',
          color: tone === 'up' ? 'success.main' : tone === 'down' ? 'error.main' : 'text.primary',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/**
 * 領獎台:三張等大的卡片由左到右照名次排(參考 Hyperdash 排行榜前三名的排法),
 * 不是「第一名置中放大」的傳統頒獎台造型。卡片的主體是**策略配置與關鍵數字**——
 * 使用者要決定跟不跟單,看的是這個人押什麼、賺得穩不穩,不是一條沒有刻度的曲線。
 * 7 日權益曲線縮成一條加了標籤的小折線,只回答「這 7 天大致往哪走」。跟著目前
 * 排序走,而不是固定按 TraderScore。交易者少於 3 位時,對應的格子就不畫。
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
        gap: 1.25,
        border: '1px solid',
        borderColor: MEDAL_BORDER[rank - 1],
        boxShadow: MEDAL_GLOW[rank - 1],
      }}
    >
      {/* 身分列 */}
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

      {/* 策略配置:這個人押什麼、做多還做空——卡片的主角。 */}
      <AllocationRow allocs={trader.allocs} hasStrategy={trader.hasStrategy} size={26} />

      {/* 7 日權益曲線:縮成加了標籤的小折線,只回答「往哪走」,不搶版面。 */}
      <Box>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', display: 'block', fontSize: '0.6875rem', lineHeight: 1.4, mb: 0.25 }}
        >
          {t.marketplace.podium.equityLabel}
        </Typography>
        <Box sx={{ minHeight: 40, display: 'flex', alignItems: 'center', color: 'text.secondary' }}>
          <EquitySparkline curve={trader.equityCurve} pnl={trader.pnl7d} variant="lg" />
        </Box>
      </Box>

      <Divider sx={{ borderColor: 'divider' }} />

      {/* 關鍵數字:報酬率、勝率(含樣本數)、跟隨者。 */}
      <Stack direction="row" spacing={1}>
        <Stat
          label={t.marketplace.scoreBreakdown.returnLabel}
          value={fReturnPct(trader.score.returnPct)}
          tone={
            trader.score.returnPct === null
              ? undefined
              : trader.score.returnPct > 0
                ? 'up'
                : trader.score.returnPct < 0
                  ? 'down'
                  : undefined
          }
        />
        <Stat
          label={t.marketplace.scoreBreakdown.winRateLabel}
          value={fWinRate(trader.wins, trader.trades)}
        />
        <Stat
          label={t.marketplace.card.followersLabel}
          value={String(trader.followerCount)}
        />
      </Stack>

      {/* TraderScore + 7 日 PnL */}
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
