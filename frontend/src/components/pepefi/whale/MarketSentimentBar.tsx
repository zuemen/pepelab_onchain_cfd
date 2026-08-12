import type { MarketSentiment } from 'src/hooks/useMarketSentiment'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import { MONO, PEPE } from 'src/components/pepefi/brandKit'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { fCompact } from 'src/lib/pepefi/whale'

interface Props {
  sentiment: MarketSentiment
  mode:      'simple' | 'expert'
  /** 交易所在這條鏈上是否可用。false 時不要說「沒有部位」——那是兩件事。 */
  ready:     boolean
}

/** 多空各佔一段的橫條。total 為 0 的市場不會走到這裡。 */
function SplitBar({ longShare, height = 8 }: { longShare: number; height?: number }) {
  const pct = Math.round(longShare * 100)
  return (
    <Box sx={{ display: 'flex', width: '100%', height, borderRadius: 999, overflow: 'hidden' }}>
      <Box sx={{ width: `${pct}%`, bgcolor: PEPE.long }} />
      <Box sx={{ width: `${100 - pct}%`, bgcolor: PEPE.short }} />
    </Box>
  )
}

/**
 * 各市場的多空未平倉分布。
 *
 * 這一塊是排行榜讓出來的位置。排行榜被砍掉是因為 /marketplace 的 Star Trader
 * Leaderboard 已經在做同一件事，而且做得更完整（reputation / followers / PnL /
 * ESG 都能排），whale 頁那份只能按累積成交量排，是它的弱化版。
 *
 * 換上來的東西是 Marketplace 結構上做不到的：**部位維度**，而不是交易員維度。
 * 數字直接讀合約的 globalLong/ShortNotional，所以它是全站真相，不受掃描視窗限制。
 */
export default function MarketSentimentBar({ sentiment, mode, ready }: Props) {
  const { rows, total, longShare, missing, loading, error } = sentiment

  return (
    <Card sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        {/* 刻意不叫 "Open Interest"：KPI 那一列已經有一張同名的卡，兩個地方
            用同一個標題講不同粒度的事（總額 vs 多空分布）只會讓人以為重複了。 */}
        <Typography variant="overline" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
          Long vs Short
        </Typography>
        <Typography variant="caption" color="text.secondary">
          open interest · live
        </Typography>
      </Box>

      {!ready ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
          Unavailable on this network.
        </Typography>
      ) : loading && rows.length === 0 ? (
        <TableSkeleton rows={4} cols={1} />
      ) : error ? (
        <Typography variant="body2" color="error.main">{error}</Typography>
      ) : total === 0n ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
          No open positions in any market.
        </Typography>
      ) : (
        <>
          {/* 全站合計 */}
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.75 }}>
              <Typography variant="caption" sx={{ color: PEPE.long, fontWeight: 800 }}>
                LONG {Math.round(longShare * 100)}%
              </Typography>
              <Typography variant="caption" sx={{ color: PEPE.short, fontWeight: 800 }}>
                {100 - Math.round(longShare * 100)}% SHORT
              </Typography>
            </Box>
            <SplitBar longShare={longShare} height={10} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              <Box component="span" sx={{ fontFamily: MONO }}>{fCompact(total)}</Box> across{' '}
              {rows.length} market{rows.length === 1 ? '' : 's'}
            </Typography>
          </Box>

          {/* 逐市場。simple 模式只給前三大，其餘是雜訊。 */}
          <Stack spacing={1.25}>
            {(mode === 'simple' ? rows.slice(0, 3) : rows).map(r => (
              <Tooltip
                key={r.asset}
                title={`Long ${fCompact(r.long)} · Short ${fCompact(r.short)}`}
                placement="left"
              >
                <Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>
                      {r.icon} {r.label}
                    </Typography>
                    <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                      {fCompact(r.total)}
                    </Typography>
                  </Box>
                  <SplitBar longShare={r.longShare} />
                </Box>
              </Tooltip>
            ))}
          </Stack>

          {/* 讀不到的市場要講出來。rpcBatch.ts 的原則：限流不能被靜默翻譯成
              「這個市場沒有部位」——那會讓使用者以為畫面壞了而不是重試就好。 */}
          {missing > 0 && (
            <Typography variant="caption" color="warning.main">
              {missing} market{missing === 1 ? '' : 's'} could not be read — the RPC node may be rate-limiting.
            </Typography>
          )}
        </>
      )}
    </Card>
  )
}
