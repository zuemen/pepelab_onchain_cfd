import type { Theme } from '@mui/material/styles'
import type { AddressEvent, AddressActivity, AddressEventKind } from 'src/hooks/useAddressActivity'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import Stack from '@mui/material/Stack'
import { alpha } from '@mui/material/styles'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Typography from '@mui/material/Typography'
import LinearProgress from '@mui/material/LinearProgress'
import TableContainer from '@mui/material/TableContainer'

import { explorerTx } from 'src/lib/pepefi/notify'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import EmptyState from 'src/components/pepefi/EmptyState'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { MONO, PEPE, shortAddr } from 'src/components/pepefi/brandKit'
import { fUsd, timeAgo, fCompact, sideLabel, fSignedUsd } from 'src/lib/pepefi/whale'

interface Props {
  activity: AddressActivity
  chainId:  number | null
  mode:     'simple' | 'expert'
}

// 這兩張卡從 WhaleTrackerPage 搬過來。它們回答的是「這個人做了什麼」，
// 屬於 /trader/:address；whale tracker 回答的是「錢往哪流」。

const KIND_LABEL: Record<AddressEventKind, string> = {
  PositionOpened:     'Opened',
  PositionClosed:     'Closed',
  PositionLiquidated: 'Liquidated',
  Following:          'Following',
  FollowedBy:         'Followed by',
  Staked:             'Staked',
  Slashed:            'Slashed',
}

// 顏色從 theme 取，不是寫死的 rgba()。舊版把六種事件的色票直接寫成 hex，
// dark/light 切換與品牌換色都繞不過它們。
const KIND_COLOR: Record<AddressEventKind, (t: Theme) => string> = {
  PositionOpened:     t => t.palette.success.main,
  PositionClosed:     t => t.palette.warning.main,
  PositionLiquidated: t => t.palette.error.main,
  Following:          t => t.palette.secondary.main,
  FollowedBy:         t => t.palette.info.main,
  Staked:             t => t.palette.warning.main,
  Slashed:            t => t.palette.error.main,
}

const Addr = ({ a }: { a: unknown }) => (
  <Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(String(a))}</Box>
)

function EventDetail({ event }: { event: AddressEvent }) {
  const d = event.details

  switch (event.kind) {
    case 'PositionOpened': {
      const isLong = d.isLong as boolean
      return (
        <span>
          <Box component="span" sx={{ fontWeight: 800, color: isLong ? PEPE.long : PEPE.short }}>
            {sideLabel(isLong)}
          </Box>{' '}
          {ASSET_LABEL[d.asset as string] ?? '?'} {String(d.leverage as bigint)}× @{' '}
          {fUsd(d.entryPrice as bigint)} · margin {fCompact(d.margin as bigint)}
        </span>
      )
    }
    case 'PositionClosed': {
      const pnl = d.pnl as bigint
      return (
        <span>
          PnL{' '}
          <Box component="span" sx={{ fontWeight: 800, color: pnl >= 0n ? PEPE.long : PEPE.short }}>
            {fSignedUsd(pnl)}
          </Box>{' '}
          · received {fCompact(d.closeAmount as bigint)}
        </span>
      )
    }
    case 'PositionLiquidated': {
      const pnl = d.pnl as bigint
      return (
        <span>
          Liquidated at{' '}
          <Box component="span" sx={{ fontWeight: 800, color: PEPE.short }}>{fSignedUsd(pnl)}</Box>
          {' '}by <Addr a={d.liquidator} />
        </span>
      )
    }
    case 'Following':
      return <span>Started copying <Addr a={d.trader} /> · margin {fCompact(d.totalMargin as bigint)}</span>
    case 'FollowedBy':
      return <span><Addr a={d.follower} /> started copying this trader · margin {fCompact(d.totalMargin as bigint)}</span>
    case 'Staked':
      return <span>Staked <Box component="span" sx={{ fontWeight: 700 }}>{fCompact(d.amount as bigint)}</Box></span>
    case 'Slashed':
      return (
        <span>
          Slashed <Box component="span" sx={{ fontWeight: 700, color: PEPE.short }}>{fCompact(d.amount as bigint)}</Box>
          {' '}→ <Addr a={d.recipient} />
        </span>
      )
    default:
      return null
  }
}

export default function TraderActivity({ activity, chainId, mode }: Props) {
  const { events, positions, scanRange, progress, missing, loading, error } = activity

  const rangeText = scanRange
    ? `#${scanRange.from.toLocaleString()}–#${scanRange.to.toLocaleString()}`
    : null

  return (
    <Stack spacing={3}>
      {error && <Typography variant="body2" color="error.main">{error}</Typography>}

      {/* ── Current open positions ──────────────────────────────────────────── */}
      <Card>
        <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Current Open Positions</Typography>
          <Typography variant="caption" color="text.secondary">
            read live from the exchange · includes positions older than the scan window
          </Typography>
        </Box>

        {loading && positions.length === 0 ? (
          <TableSkeleton rows={3} cols={5} />
        ) : positions.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
            No open positions.
          </Typography>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {(mode === 'simple'
                    ? ['Market', 'Side', 'Notional', 'PnL']
                    : ['Market', 'Side', 'Entry', 'Mark', 'Margin', 'Notional', 'PnL']
                  ).map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.map(p => (
                  <TableRow key={p.id} hover>
                    <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{p.assetLabel}</TableCell>
                    <TableCell sx={{ fontWeight: 800, whiteSpace: 'nowrap', color: p.isLong ? PEPE.long : PEPE.short }}>
                      {sideLabel(p.isLong)} {String(p.leverage)}×
                    </TableCell>
                    {mode === 'expert' && (
                      <TableCell sx={{ fontFamily: MONO, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                        {fUsd(p.entryPrice)}
                      </TableCell>
                    )}
                    {mode === 'expert' && (
                      <TableCell
                        sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}
                        title={p.markPrice === null ? 'Mark price could not be read' : undefined}
                      >
                        {p.markPrice === null ? '—' : fUsd(p.markPrice)}
                      </TableCell>
                    )}
                    {mode === 'expert' && (
                      <TableCell sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>{fCompact(p.margin)}</TableCell>
                    )}
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fCompact(p.notional)}
                    </TableCell>
                    <TableCell
                      sx={{
                        fontFamily: MONO,
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        color: p.pnl === null ? 'text.disabled' : p.pnl >= 0n ? PEPE.long : PEPE.short,
                      }}
                      title={p.pnl === null ? 'Unrealised PnL could not be read' : undefined}
                    >
                      {p.pnl === null ? '—' : fSignedUsd(p.pnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {missing > 0 && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', px: 2.5, py: 1.5 }}>
            {missing} position{missing === 1 ? '' : 's'} could not be read — the RPC node may be rate-limiting.
          </Typography>
        )}
      </Card>

      {/* ── Activity timeline ───────────────────────────────────────────────── */}
      <Card>
        <Box
          sx={{
            p: 2.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 1,
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Activity Timeline</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            {loading && progress
              ? `Scanning ${progress.done}/${progress.total}`
              : rangeText ?? '—'}
          </Typography>
        </Box>

        {loading && progress && progress.total > 0 && (
          <LinearProgress variant="determinate" value={(progress.done / progress.total) * 100} sx={{ height: 2 }} />
        )}

        {loading && events.length === 0 ? (
          <TableSkeleton rows={6} cols={4} />
        ) : events.length === 0 ? (
          <EmptyState
            icon="📭"
            title="No activity found"
            description={rangeText ? `No events in blocks ${rangeText}.` : 'Nothing to show yet.'}
          />
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['When', 'Event', 'Detail', 'Tx'].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {events.map(e => {
                  const href = explorerTx(e.txHash, chainId)
                  return (
                    <TableRow key={`${e.txHash}-${e.logIndex}`} hover>
                      <TableCell
                        sx={{ fontSize: '0.75rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
                        title={e.timestampExact ? undefined : 'Estimated from average block time'}
                      >
                        {e.timestampExact ? '' : '~'}{timeAgo(e.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={KIND_LABEL[e.kind]}
                          size="small"
                          sx={{
                            fontWeight: 700,
                            color:       t => KIND_COLOR[e.kind](t),
                            bgcolor:     t => alpha(KIND_COLOR[e.kind](t), 0.16),
                            border:      '1px solid',
                            borderColor: t => alpha(KIND_COLOR[e.kind](t), 0.24),
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.8125rem' }}>
                        <EventDetail event={e} />
                      </TableCell>
                      <TableCell>
                        {href ? (
                          <Link
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={e.txHash}
                            aria-label="View transaction in block explorer"
                            sx={{ color: 'success.main', fontWeight: 'bold', textDecoration: 'none' }}
                          >
                            ↗
                          </Link>
                        ) : (
                          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                            {e.txHash.slice(0, 8)}…
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>
    </Stack>
  )
}
