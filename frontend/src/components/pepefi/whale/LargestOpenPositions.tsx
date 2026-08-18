import type { LargestOpenPositions as Data } from 'src/hooks/useLargestOpenPositions'

import { Link as RouterLink } from 'react-router'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'

import { PepeIdentity } from 'src/components/pepefi/PepeIdentity'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { t, interpolate } from 'src/locales'
import { MONO, PEPE } from 'src/components/pepefi/brandKit'
import { fUsd, fCompact, sideLabel, fSignedUsd } from 'src/lib/pepefi/whale'

import WhaleTagChips from './WhaleTagChips'

interface Props {
  data:  Data
  mode:  'simple' | 'expert'
  /** 交易所在這條鏈上是否可用。false 時不要說「沒有部位」——那是兩件事。 */
  ready: boolean
}

/**
 * 目前最大的未平倉部位。
 *
 * 這是排行榜讓出來的另一半位置，也是 HyperStats / Hyperdash 那類 perp 追蹤
 * 工具的首屏內容：與其排「誰歷史上做得大」，不如直接顯示現在最大的賭注押在哪裡、
 * 入場價多少、現在賺賠多少。
 *
 * markPrice 與 pnl 可能是 null——那代表**沒讀到**，不是零。舊頁面把讀取失敗
 * 的 PnL 填成 0n，畫面上顯示 $0.00，看起來像一個持平的部位。
 */
export default function LargestOpenPositions({ data, mode, ready }: Props) {
  const { rows, missing, loading, error } = data

  const col = t.whale.largest.column
  const columns =
    mode === 'simple'
      ? [col.market, col.trader, col.side, col.notional, col.pnl]
      : [col.market, col.trader, col.side, col.entry, col.mark, col.notional, col.pnl]

  return (
    <Card>
      <Box
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="overline" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
          {t.whale.largest.title}
        </Typography>
        {rows.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(t.whale.largest.top, { count: rows.length })}
          </Typography>
        )}
      </Box>

      {!ready ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
          {t.whale.largest.unavailable}
        </Typography>
      ) : loading && rows.length === 0 ? (
        <TableSkeleton rows={5} cols={columns.length} />
      ) : error ? (
        <Typography variant="body2" color="error.main" sx={{ p: 3 }}>{error}</Typography>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
          {t.whale.largest.empty}
        </Typography>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'background.neutral' }}>
                {columns.map(h => (
                  <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.positionId} hover>
                  <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {r.assetLabel}
                  </TableCell>

                  <TableCell>
                    <Link
                      component={RouterLink}
                      to={`/trader/${r.owner}`}
                      sx={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <PepeIdentity address={r.owner} size={28} />
                    </Link>
                    {mode === 'simple' && <WhaleTagChips tags={r.tags} />}
                  </TableCell>

                  <TableCell
                    sx={{
                      fontWeight: 800,
                      whiteSpace: 'nowrap',
                      color: r.isLong ? PEPE.long : PEPE.short,
                    }}
                  >
                    {sideLabel(r.isLong)} {String(r.leverage)}×
                  </TableCell>

                  {mode === 'expert' && (
                    <TableCell sx={{ fontFamily: MONO, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      {fUsd(r.entryPrice)}
                    </TableCell>
                  )}

                  {mode === 'expert' && (
                    <TableCell
                      sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}
                      title={r.markPrice === null ? t.whale.largest.markUnread : undefined}
                    >
                      {r.markPrice === null ? '—' : fUsd(r.markPrice)}
                    </TableCell>
                  )}

                  <TableCell sx={{ fontFamily: MONO, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fCompact(r.notional)}
                  </TableCell>

                  <TableCell
                    sx={{
                      fontFamily: MONO,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      color: r.pnl === null
                        ? 'text.disabled'
                        : r.pnl >= 0n ? PEPE.long : PEPE.short,
                    }}
                    title={r.pnl === null ? t.whale.largest.pnlUnread : undefined}
                  >
                    {r.pnl === null ? '—' : fSignedUsd(r.pnl)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {missing > 0 && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', px: 2, py: 1.5 }}>
          {interpolate(
            missing === 1 ? t.whale.largest.missingOne : t.whale.largest.missingMany,
            { count: missing },
          )}
        </Typography>
      )}
    </Card>
  )
}
