import type { OpenedTrade } from 'src/hooks/useExchangeActivity'
import type { RegisteredTrader } from 'src/hooks/useRegisteredTraders'

import { Link as RouterLink } from 'react-router'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import Stack from '@mui/material/Stack'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Typography from '@mui/material/Typography'
import LinearProgress from '@mui/material/LinearProgress'
import TableContainer from '@mui/material/TableContainer'

import EmptyState from 'src/components/pepefi/EmptyState'
import { PepeIdentity } from 'src/components/pepefi/PepeIdentity'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { t, interpolate } from 'src/locales'
import { MONO, PEPE } from 'src/components/pepefi/brandKit'
import { explorerTx } from 'src/lib/pepefi/notify'
import { timeAgo, fCompact, sideLabel, positionProfile } from 'src/lib/pepefi/whale'

import WhaleTagChips from './WhaleTagChips'

interface Props {
  trades:   OpenedTrade[]
  mode:     'simple' | 'expert'
  chainId:  number | null
  loading:  boolean
  progress: { done: number; total: number } | null
  /** 註冊過的 trader（小寫地址 → 資料）。用來掛 ⭐ 與跟單入口。 */
  registered: Map<string, RegisteredTrader>
  /** 空清單時要說的話，通常帶掃描範圍。 */
  emptyHint?: string
  /** 空清單的標題。掃描失敗時不能沿用「沒有鯨魚交易」——那是在回答一個
   *  根本沒問成的問題。 */
  emptyTitle?: string
}

const sideColor = (isLong: boolean) => (isLong ? PEPE.long : PEPE.short)

/**
 * 這個地址是不是 Marketplace 上可跟單的 Star Trader。
 *
 * 有註冊 → 一鍵跟單；沒註冊 → 匿名鯨魚，只能看。這是 whale tracker 與
 * marketplace 之間唯一的那條線，也是兩頁職責分開之後還能互通的原因。
 */
function CopyCta({ owner, registered }: { owner: string; registered: Map<string, RegisteredTrader> }) {
  if (!registered.get(owner.toLowerCase())?.registered) return null
  return (
    <Chip
      component={RouterLink}
      to={`/copy/${owner}`}
      clickable
      size="small"
      label={t.whale.feed.copy}
      color="secondary"
      variant="outlined"
      sx={{ height: 22, fontWeight: 700, fontSize: '0.6875rem' }}
      title={t.whale.feed.copyHint}
    />
  )
}

/** 推估的時間戳前面加 `~`，不要讓它看起來和真的一樣精確。 */
function TimeCell({ trade }: { trade: OpenedTrade }) {
  return (
    <Box
      component="span"
      title={trade.timestampExact ? undefined : t.whale.feed.estimatedTime}
      sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}
    >
      {trade.timestampExact ? '' : '~'}
      {timeAgo(trade.timestamp)}
    </Box>
  )
}

function TxLink({ trade, chainId }: { trade: OpenedTrade; chainId: number | null }) {
  const href = explorerTx(trade.txHash, chainId)
  if (!href) {
    return (
      <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
        {trade.txHash.slice(0, 8)}…
      </Typography>
    )
  }
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={trade.txHash}
      aria-label={t.whale.feed.txAria}
      sx={{ color: 'success.main', fontWeight: 'bold', textDecoration: 'none' }}
    >
      ↗
    </Link>
  )
}

/**
 * 大額開倉的即時流 —— 這一頁真正的主角。
 *
 * 這正是頁面原本缺的東西：頁面叫 Whale Tracker，但鯨魚資料流只出現在
 * Dashboard 的一張小卡，主畫面放的是一份與 Marketplace 的 Star Trader
 * Leaderboard 重複、而且更弱的交易員排行榜。
 *
 * simple 模式寫成一句人話，是照 Lookonchain / Arkham 那類鏈上情報的慣例：
 * 主體 + 動作 + 金額 + 時間 + 連結。expert 模式才給密集表格。舊頁面的
 * simple 模式只換掉排行榜那一塊，下面照樣把八欄的表格端給新手。
 */
export default function WhaleFeed({ trades, mode, chainId, loading, progress, registered, emptyHint, emptyTitle }: Props) {
  const header = (
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
        {t.whale.feed.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {loading && progress
          ? interpolate(t.whale.feed.scanning, {
              done: progress.done,
              total: progress.total,
            })
          : interpolate(t.whale.feed.trades, { count: trades.length })}
      </Typography>
    </Box>
  )

  // 掃描是幾十次序列 RPC。只顯示一句「載入中」等於讓使用者對著不動的畫面猜
  // 還要多久——有分母就知道它在前進。
  const progressBar = loading && progress && progress.total > 0 && (
    <LinearProgress
      variant="determinate"
      value={(progress.done / progress.total) * 100}
      sx={{ height: 2 }}
    />
  )

  if (loading && trades.length === 0) {
    return (
      <Card>
        {header}
        {progressBar}
        <TableSkeleton rows={6} cols={mode === 'simple' ? 2 : 5} />
      </Card>
    )
  }

  if (trades.length === 0) {
    return (
      <EmptyState
        icon={emptyTitle ? '⚠️' : '🌊'}
        title={emptyTitle ?? t.whale.feed.emptyTitle}
        description={emptyHint ?? t.whale.feed.emptyDescription}
      />
    )
  }

  return (
    <Card>
      {header}
      {progressBar}

      {mode === 'simple' ? (
        <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
          {trades.map(trade => (
            <Box
              key={`${trade.txHash}-${trade.logIndex}`}
              sx={{
                p: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                flexWrap: 'wrap',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Link
                component={RouterLink}
                to={`/trader/${trade.owner}`}
                sx={{ textDecoration: 'none', color: 'inherit', flexShrink: 0 }}
              >
                <PepeIdentity address={trade.owner} size={40} />
              </Link>

              <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>
                  {t.whale.feed.openedVerb}{' '}
                  <Box component="span" sx={{ fontWeight: 800, color: sideColor(trade.isLong) }}>
                    {String(trade.leverage)}× {sideLabel(trade.isLong)}
                  </Box>{' '}
                  <Box component="span" sx={{ fontWeight: 700 }}>{trade.assetLabel}</Box>{' '}
                  {t.whale.feed.forPreposition}{' '}
                  <Box component="span" sx={{ fontFamily: MONO, fontWeight: 800 }}>
                    {fCompact(trade.notional)}
                  </Box>
                </Typography>
                <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
                  <TimeCell trade={trade} />
                </Typography>
              </Box>

              <WhaleTagChips
                tags={positionProfile({
                  notional:    trade.notional,
                  leverage:    trade.leverage,
                  isFirstSeen: trade.isFirstSeen,
                })}
              />
              <CopyCta owner={trade.owner} registered={registered} />
              <TxLink trade={trade} chainId={chainId} />
            </Box>
          ))}
        </Stack>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'background.neutral' }}>
                {[
                  t.whale.feed.column.time,
                  t.whale.feed.column.trader,
                  t.whale.feed.column.market,
                  t.whale.feed.column.side,
                  t.whale.feed.column.notional,
                  t.whale.feed.column.entry,
                  t.whale.feed.column.tx,
                ].map(h => (
                  <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {trades.map(t => (
                <TableRow key={`${t.txHash}-${t.logIndex}`} hover>
                  <TableCell sx={{ fontSize: '0.75rem' }}>
                    <TimeCell trade={t} />
                  </TableCell>
                  <TableCell>
                    <Link
                      component={RouterLink}
                      to={`/trader/${t.owner}`}
                      sx={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <PepeIdentity address={t.owner} size={28} />
                    </Link>
                    {/* expert 模式只掛 new-face：mega 從 Notional 欄看得出來，
                        high-leverage 就寫在隔壁的 Side 欄，再掛一次是雜訊。
                        「這個地址本週第一次出現」則沒有任何一欄講得出來。 */}
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                      {t.isFirstSeen && (
                        <WhaleTagChips
                          tags={positionProfile({
                            notional:    t.notional,
                            leverage:    t.leverage,
                            isFirstSeen: true,
                          }).filter(tag => tag.id === 'new-face')}
                        />
                      )}
                      <CopyCta owner={t.owner} registered={registered} />
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{t.assetLabel}</TableCell>
                  <TableCell sx={{ fontWeight: 800, color: sideColor(t.isLong), whiteSpace: 'nowrap' }}>
                    {sideLabel(t.isLong)} {String(t.leverage)}×
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fCompact(t.notional)}
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                    {fCompact(t.entryPrice)}
                  </TableCell>
                  <TableCell>
                    <TxLink trade={t} chainId={chainId} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Card>
  )
}
