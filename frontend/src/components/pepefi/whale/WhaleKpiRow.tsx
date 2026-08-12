import type { ActivityTotals } from 'src/hooks/useExchangeActivity'

import Grid from '@mui/material/Grid'
import Card from '@mui/material/Card'

import StatCard from 'src/components/pepefi/StatCard'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { fCompact } from 'src/lib/pepefi/whale'

interface Props {
  totals:       ActivityTotals
  /** 全站未平倉名目（來自合約，非事件推導）。null = 還在讀。 */
  openInterest: bigint | null
  /** 掃描視窗的人話描述，例如 "last 7d"。 */
  windowLabel:  string
  /** 目前的鯨魚門檻，例如 "$1k"。 */
  thresholdLabel: string
  /** 交易所在這條鏈上是否可用。false 時所有數字顯示 '—' 而不是 0。 */
  ready:        boolean
  loading:      boolean
}

/**
 * 三張 KPI。
 *
 * 每一張都寫清楚數字的**範圍**。舊頁面把滾動 7 天視窗的統計標成
 * "all-time (all traders)" 與 "total lifetime"——那不只是措辭問題，
 * 使用者會拿一個只涵蓋一週的數字當成全部歷史來判斷。
 *
 * 前兩張的範圍是掃描視窗，第三張不是：未平倉名目直接讀合約的
 * globalLong/ShortNotional，涵蓋視窗之前就開著的倉，所以標 "live"。
 */
export default function WhaleKpiRow({ totals, openInterest, windowLabel, thresholdLabel, ready, loading }: Props) {
  if (loading) {
    return (
      <Grid container spacing={3}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Grid size={{ xs: 12, md: 4 }} key={i}>
            <Card sx={{ p: 4 }}>
              <TableSkeleton rows={2} cols={1} />
            </Card>
          </Grid>
        ))}
      </Grid>
    )
  }

  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 4 }}>
        <StatCard
          title="Whale Trades"
          value={ready ? String(totals.whaleCount) : '—'}
          sub={`≥ ${thresholdLabel} notional · ${windowLabel}`}
          valueColor={ready && totals.whaleCount > 0 ? 'primary.main' : undefined}
        />
      </Grid>
      <Grid size={{ xs: 12, md: 4 }}>
        <StatCard
          title="Traded Volume"
          value={ready ? fCompact(totals.volume) : '—'}
          sub={ready ? `all ${totals.openedCount} positions opened · ${windowLabel}` : windowLabel}
        />
      </Grid>
      <Grid size={{ xs: 12, md: 4 }}>
        <StatCard
          title="Open Interest"
          value={openInterest === null ? '—' : fCompact(openInterest)}
          sub="live · every market, all time"
          valueColor={openInterest !== null && openInterest > 0n ? 'success.main' : undefined}
        />
      </Grid>
    </Grid>
  )
}
