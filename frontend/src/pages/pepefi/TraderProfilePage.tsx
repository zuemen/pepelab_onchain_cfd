import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { useParams, Link as RouterLink } from 'react-router'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { TableSkeleton, CardSkeleton } from 'src/components/pepefi/Skeleton'
import { useESG } from 'src/hooks/useESG'
import ESGBadge from 'src/components/pepefi/ESGBadge'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import StatCard from 'src/components/pepefi/StatCard'
import { traderAvatarSrc } from 'src/utils/pepefi-assets'
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge'
import TraderActivity from 'src/components/pepefi/TraderActivity'
import { useMode } from 'src/contexts/mode-context'
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags'

// 統計卡：跟單旗標關閉時少了「跟隨者」那張，剩三張各佔三分之一。
const STAT_SIZE = FEATURE_COPY_TRADING ? { xs: 6, md: 3 } : { xs: 12, sm: 4 }
// 策略歷史在卡片上只列最新的這麼多版；全部版本開在彈窗裡（ListDialog）。
const FIRST_VERSIONS = 5
import { useAddressActivity } from 'src/hooks/useAddressActivity'
import HeroTrades from 'src/components/pepefi/hero/HeroTrades'
import HeroRiskStats from 'src/components/pepefi/hero/HeroRiskStats'
import HeroPerformance from 'src/components/pepefi/hero/HeroPerformance'
import { fetchHeroDetail, type HeroDetail } from 'src/lib/pepefi/heroData'
import { followerReaderOf, readActiveFollowers } from 'src/lib/pepefi/activeFollowers'
import TxProof from 'src/components/pepefi/hero/TxProof'
import ListDialog, { ExpandListButton } from 'src/components/pepefi/ListDialog'
import StrategySides from 'src/components/pepefi/feed/StrategySides'
import TraderFeedSection from 'src/components/pepefi/feed/TraderFeedSection'
import SustainabilityMix from 'src/components/pepefi/SustainabilityMix'
import { usePricingCarbonTiers } from 'src/hooks/usePricingCarbonTiers'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';

import { t, locale, interpolate } from 'src/locales';
import { explorerTx, explorerName } from 'src/lib/pepefi/notify';
import { UI_RETRIES, scanFromBlock, isChunkScanAborted, describeScanWindow, scanContractEventsStrict } from 'src/lib/pepefi/chainLogs';

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

interface RawAlloc {
  asset: string; weight: bigint; isLong: boolean; leverage: bigint
}

interface HistVer {
  versionId: number
  createdAt: bigint
  allocs:    RawAlloc[]
  expanded:  boolean
}

interface SlashEvent {
  trader:    string
  amount:    bigint
  recipient: string
  txHash:    string
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const fmtDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

/**
 * 以位址當 key 重新掛載整頁：從 A 切到 B 時，A 的名稱、質押、信用分數、收益、
 * 罰沒紀錄等所有欄位一次清空，不會在 B 的資料讀完前殘留 A 的財務與信用資料。
 */
export default function TraderProfilePage() {
  const { address } = useParams<{ address: string }>()
  return <TraderProfileView key={address?.toLowerCase() ?? ''} />
}

function TraderProfileView() {
  const wallet = usePepefiWallet()
  const { mode } = useMode()
  const { address: traderAddr } = useParams<{ address: string }>()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const pricingTiers = usePricingCarbonTiers(contracts?.exchange ?? null)
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)
  const addressActivity = useAddressActivity(contracts, wallet.provider, wallet.chainId, traderAddr)

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint | null>(null)
  const [followerList,  setFollowerList]  = useState<string[]>([])
  const [allocs,        setAllocs]        = useState<RawAlloc[]>([])
  const [hasStrategy,   setHasStrategy]   = useState(false)
  const [stratHistory,  setStratHistory]  = useState<HistVer[]>([])
  const [versionsOpen,  setVersionsOpen]  = useState(false)
  const [stakeInfo,     setStakeInfo]     = useState<StakeInfo | null>(null)
  const [repScore,      setRepScore]      = useState<bigint | null>(null)
  const [eligible,      setEligible]      = useState<boolean | null>(null)
  const [earnings,      setEarnings]      = useState<bigint | null>(null)
  const [stratCount,    setStratCount]    = useState<number | null>(null)
  const [slashHistory,  setSlashHistory]  = useState<SlashEvent[]>([])
  /**
   * 罰沒事件讀取狀態。'failed' 時**絕不能**顯示成「沒有罰沒」——讀不到和沒有是兩件事。
   * 'pending' = 還沒讀完；'ok' 時 slashBlocks = 實際掃描的塊數。
   */
  const [slashRead,     setSlashRead]     = useState<'pending' | 'ok' | 'failed'>('pending')
  const [slashBlocks,   setSlashBlocks]   = useState(0)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  // 模擬交易者的績效資料（issue #309）。讀的是靜態檔，不該被讀鏈的 loading 拖住；
  // 這個位址不是模擬交易者、或這條鏈沒有資料時維持 null，下面的區塊就不出現。
  const [hero,          setHero]          = useState<HeroDetail | null>(null)

  const toggleVer = useCallback((versionId: number) => {
    setStratHistory(prev =>
      prev.map(v => v.versionId === versionId ? { ...v, expanded: !v.expanded } : v),
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    setHero(null)
    setVersionsOpen(false)
    if (!traderAddr) return undefined
    void fetchHeroDetail(traderAddr, wallet.chainId).then((detail) => {
      if (!cancelled) setHero(detail)
    })
    return () => { cancelled = true }
  }, [traderAddr, wallet.chainId])

  useEffect(() => {
    if (!contracts || !traderAddr) return
    // 從 A 的頁面切到 B 時，A 還在飛的讀取回來後不能寫進 B 的畫面。
    let cancelled = false
    const alive = () => !cancelled
    setLoading(true)
    setError(null)
    const go = async () => {
      let traderRaw: [boolean, string, bigint] | null = null
      try {
        traderRaw = (await contracts.registry.traders(traderAddr)) as unknown as [boolean, string, bigint]
      } catch { traderRaw = null }
      if (traderRaw) {
        if (alive()) setName(traderRaw[1])
        if (alive()) setRegistered(traderRaw[0])
      }
      // 目前的跟隨者，不是 getFollowerCount 的「被跟單過幾次」（見 activeFollowers.ts）。
      // 清單只列還在跟的人、每人一次，前 10 位；讀不到時人數顯示「—」，不是 0。
      const active = (await readActiveFollowers([traderAddr], followerReaderOf(contracts.copyTracker)))
        .get(traderAddr.toLowerCase()) ?? null
      if (alive()) {
        setFollowers(active === null ? null : BigInt(active.length))
        setFollowerList(active?.slice(0, 10) ?? [])
      }

      // strategy + history
      let count = 0
      try {
        count = Number((await contracts.registry.getStrategyCount(traderAddr)) as bigint)
      } catch { count = 0 }
      if (alive()) setStratCount(count)
      if (count > 0) {
        try {
          const vers = await Promise.all(
            Array.from({ length: count }, (_, i) => i).map(async (i): Promise<HistVer> => {
              const res = (await contracts.registry.getStrategyVersion(traderAddr, BigInt(i))) as unknown as [unknown[], bigint]
              return {
                versionId: i,
                createdAt: res[1],
                allocs:    (res[0] as unknown[]).map(a => {
                  const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
                  return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
                }),
                expanded: false,
              }
            }),
          )
          const sorted = [...vers].reverse()
          if (alive()) setStratHistory(sorted)
          if (alive()) setAllocs(sorted[0]?.allocs ?? [])
          if (alive()) setHasStrategy(sorted[0]?.allocs.length > 0)
        } catch { if (alive()) setHasStrategy(false) }
      } else {
        if (alive()) setHasStrategy(false)
      }

      // stake + reputation
      try {
        const [si, score, elig] = await Promise.all([
          contracts.traderStake.getStake(traderAddr),
          contracts.traderStake.reputationScore(traderAddr),
          contracts.traderStake.isEligible(traderAddr),
        ])
        if (alive()) setStakeInfo(si as unknown as StakeInfo)
        if (alive()) setRepScore(score as bigint)
        if (alive()) setEligible(elig as boolean)
      } catch { /* TraderStake not deployed */ }

      // fee earnings
      try {
        const raw = (await contracts.feeRouter.traderEarnings(traderAddr)) as bigint
        if (alive()) setEarnings(raw)
      } catch { /* FeeRouter not deployed */ }

      if (alive()) setLoading(false)
    }
    void go()
    return () => { cancelled = true }
  }, [contracts, traderAddr])

  // 罰沒紀錄獨立一個 effect：它是幾十段 getLogs，不該拖住整頁的 loading；
  // 換頁或卸載時以 AbortController 中止，過期結果一律丟棄。
  useEffect(() => {
    if (!contracts || !traderAddr) return
    const ac = new AbortController()
    setSlashRead('pending')
    setSlashHistory([])
    void (async () => {
      try {
        const provider = contracts.traderStake.runner?.provider
        if (!provider) throw new Error('no provider')
        const latest = Number(await provider.getBlockNumber())
        if (ac.signal.aborted) return
        const from = scanFromBlock({ chainId: wallet.chainId, currentBlock: latest })
        // 任何一段讀不到就整個標成讀取失敗：部分結果在這裡會被讀成「沒有罰沒」。
        const events = await scanContractEventsStrict(
          provider,
          contracts.traderStake,
          [contracts.traderStake.filters.Slashed(traderAddr, null)],
          from,
          latest,
          { retries: UI_RETRIES, signal: ac.signal },
        )
        if (ac.signal.aborted) return
        setSlashHistory(events.map((ev) => ({
          trader:    ev.args.trader as string,
          amount:    ev.args.amount as bigint,
          recipient: ev.args.recipient as string,
          txHash:    ev.transactionHash,
        })).reverse())
        setSlashBlocks(latest - from + 1)
        setSlashRead('ok')
      } catch (err) {
        if (ac.signal.aborted || isChunkScanAborted(err)) return
        console.warn('[traderProfile] slash history read failed', err)
        setSlashHistory([])
        setSlashRead('failed')
      }
    })()
    return () => ac.abort()
  }, [contracts, traderAddr, wallet.chainId])

  // 策略歷史的一列（可以點開看資產明細與發布交易）：卡片上的最新幾版與彈窗裡的全部版本共用。
  const renderVersion = (ver: HistVer) => {
    // 模擬交易者的績效資料裡有每一版的發布交易；展開時附上，可以向節點讀回確認。
    const publishTx = hero?.strategies.find(s => s.versionId === ver.versionId)?.tx ?? null
    return (
    <Card key={ver.versionId} sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
      <Box
        component="button"
        onClick={() => toggleVer(ver.versionId)}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1.5,
          bgcolor: 'transparent',
          border: 0,
          cursor: 'pointer',
          textAlign: 'left',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flexGrow: 1 }}>
          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
            {/* 合約的 versionId 從 0 起算；畫面從 1 起算，最新一版的編號才會等於版本數。 */}
            v{ver.versionId + 1}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 'bold', color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ver.allocs
              .map(a =>
                interpolate(t.traderProfile.history.summaryEntry, {
                  asset: ASSET_LABEL[a.asset] ?? '?',
                  side: a.isLong ? t.traderProfile.history.long : t.traderProfile.history.short,
                  leverage: String(a.leverage),
                }),
              )
              .join(' · ')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 2, shrink: 0 }}>
          <Typography variant="caption" color="text.secondary">
            {fmtDate(ver.createdAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {ver.expanded ? '▲' : '▼'}
          </Typography>
        </Box>
      </Box>
      {ver.expanded && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.neutral', px: 2, py: 1.5 }}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {[
                    t.traderProfile.history.column.asset,
                    t.traderProfile.history.column.esg,
                    t.traderProfile.history.column.side,
                    t.traderProfile.history.column.leverage,
                    t.traderProfile.history.column.weight,
                  ].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {ver.allocs.map((a, idx) => (
                  <TableRow key={idx}>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                      {ASSET_LABEL[a.asset] ?? '?'}
                    </TableCell>
                    <TableCell>
                      {esg[a.asset] ? (
                        <ESGBadge composite={esg[a.asset].composite} rating={esg[a.asset].rating} />
                      ) : (
                        <Typography variant="caption" color="text.disabled">—</Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', color: a.isLong ? 'success.main' : 'error.main' }}>
                      {a.isLong ? t.traderProfile.history.longLabel : t.traderProfile.history.shortLabel}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{String(a.leverage)}×</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                      {(Number(a.weight) / 100).toFixed(0)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {publishTx && (
            <Box sx={{ mt: 1 }}>
              <TxProof label={t.traderProfile.hero.publishTx} hash={publishTx} provider={wallet.provider} chainId={wallet.chainId} />
            </Box>
          )}
        </Box>
      )}
    </Card>
    )
  }

  const historyTitle = interpolate(
    stratHistory.length === 1 ? t.traderProfile.history.titleOne : t.traderProfile.history.titleMany,
    { count: stratHistory.length },
  )

  if (!traderAddr) return <Box sx={{ p: 4 }}><Typography color="text.secondary">{t.traderProfile.invalidAddress}</Typography></Box>

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.traderProfile.connectWallet}</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Breadcrumbs */}
      <Breadcrumbs separator="/" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/marketplace" color="inherit" underline="hover" sx={{ fontSize: '0.875rem' }}>
          {t.traderProfile.breadcrumbMarketplace}
        </Link>
        <Typography variant="body2" color="text.primary">
          {name || shortAddr(traderAddr)}
        </Typography>
      </Breadcrumbs>

      {/* 放在 loading 判斷之外：揭露只看資料檔在不在，不等讀鏈。 */}
      {hero && (
        <Alert severity="info" variant="outlined">
          {t.marketplace.hero.disclosure}
        </Alert>
      )}

      {error && (
        <Alert severity="error">
          {error}
        </Alert>
      )}

      {loading ? (
        <Stack spacing={3}>
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </Stack>
      ) : (
        <>
          {/* ─── A. Header ────────────────────────────────────────── */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Stack direction="row" spacing={3} alignItems="center">
              <Avatar
                src={traderAvatarSrc(repScore, traderAddr)}
                sx={{
                  width: 80,
                  height: 80,
                  border: '3px solid',
                  borderColor: repScore && repScore >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
                  boxShadow: '0 0 16px rgba(0,0,0,0.5)',
                  bgcolor: 'rgba(255, 255, 255, 0.05)',
                  '& .MuiAvatar-img': {
                    objectFit: 'contain',
                    padding: '4px',
                  }
                }}
              />
              <Box sx={{ flexGrow: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
                  <Box>
                    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                      <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                        {name || t.traderProfile.header.unknownName}
                      </Typography>
                      <TraderRankBadge reputation={repScore} />
                    </Stack>
                    <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', mt: 0.5 }}>
                      {traderAddr}
                    </Typography>
                  </Box>
                  {repScore !== null && (
                    <Chip
                      label={interpolate(t.traderProfile.header.repChip, { rep: String(repScore) })}
                      size="small"
                      sx={{
                        fontWeight: 'bold',
                        ...(repScore >= 80n ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                          : repScore >= 50n ? { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' }
                          : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                        )
                      }}
                    />
                  )}
                </Box>

                <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1, mt: 1.5, alignItems: 'center' }}>
                  {/* 跟隨者數與跟隨者清單跟著 FEATURE_COPY_TRADING 走（商業版預設關）。 */}
                  {FEATURE_COPY_TRADING && (
                  <Typography variant="body2" color="text.secondary">
                    <Box component="span" sx={{ fontWeight: 'bold', color: 'text.primary' }}>{followers === null ? '—' : String(followers)}</Box>{' '}
                    {followers === 1n
                      ? t.traderProfile.header.followerSingular
                      : t.traderProfile.header.followerPlural}
                  </Typography>
                  )}
                  {registered && (
                    <Chip
                      label={t.traderProfile.header.registered}
                      color="success"
                      variant="outlined"
                      size="small"
                      sx={{ fontWeight: 'bold' }}
                    />
                  )}
                  {eligible !== null && (
                    <Chip
                      label={eligible ? t.traderProfile.header.staked : t.traderProfile.header.notStaked}
                      color={eligible ? 'primary' : 'error'}
                      variant="outlined"
                      size="small"
                      sx={{ fontWeight: 'bold' }}
                    />
                  )}
                </Stack>
              </Box>
            </Stack>

            {/* 跟單按鈕跟著 FEATURE_COPY_TRADING 走（商業版預設關）。 */}
            {FEATURE_COPY_TRADING && (
            <Button
              component={RouterLink}
              to={`/copy/${traderAddr}`}
              variant="contained"
              color="primary"
              fullWidth
              disabled={!hasStrategy}
              sx={{ fontWeight: 'bold', py: 1.2 }}
            >
              {!hasStrategy ? t.traderProfile.header.noStrategy : t.traderProfile.header.copyThisTrader}
            </Button>
            )}
          </Card>

          {/* ─── B. Stats grid (4 cards) ──────────────────────────── */}
          <Grid container spacing={2}>
            <Grid size={STAT_SIZE}>
              <StatCard title={t.traderProfile.stats.staked} value={stakeInfo ? f18(stakeInfo.amount) : '—'} sub="USDC" />
            </Grid>
            {FEATURE_COPY_TRADING && (
            <Grid size={STAT_SIZE}>
              <StatCard title={t.traderProfile.stats.followers} value={followers === null ? '—' : String(followers)} sub={t.traderProfile.stats.copiers} />
            </Grid>
            )}
            <Grid size={STAT_SIZE}>
              <StatCard title={t.traderProfile.stats.earnings} value={earnings !== null ? f18(earnings, 4) : '—'} sub="USDC" valueColor="success.main" />
            </Grid>
            <Grid size={STAT_SIZE}>
              <StatCard title={t.traderProfile.stats.strategies} value={stratCount !== null ? String(stratCount) : '—'} sub={t.traderProfile.stats.versions} />
            </Grid>
          </Grid>

          {hero && <HeroPerformance hero={hero} />}
          {hero && <HeroRiskStats hero={hero} />}

          {/* ─── C. Latest Strategy ────────────────────────────────── */}
          <Card sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
              {t.traderProfile.strategy.title}
            </Typography>
            {!hasStrategy ? (
              <Typography color="text.secondary">{t.traderProfile.strategy.empty}</Typography>
            ) : (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {allocs.map((a, i) => (
                  <Chip
                    key={i}
                    label={interpolate(t.traderProfile.strategy.chip, {
                      side: a.isLong ? '↑' : '↓',
                      asset: ASSET_LABEL[a.asset] ?? '?',
                      weight: (Number(a.weight) / 100).toFixed(0),
                      leverage: String(a.leverage),
                    })}
                    size="small"
                    sx={{
                      fontWeight: 'bold',
                      ...(a.isLong
                        ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                        : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                      )
                    }}
                  />
                ))}
              </Stack>
            )}
          </Card>

          {/* #333：目前策略依權重的 SDG 分布與碳分級組成（策略讀自鏈上，同上） */}
          {hasStrategy && (
            <SustainabilityMix
              holdings={allocs.map((a) => ({ asset: a.asset, weight: Number(a.weight), isLong: a.isLong }))}
              tierOf={pricingTiers.tierOf}
              source="trader"
            />
          )}

          {/* 市場多空比例與這位交易者的最近動態（issue #335）：交易桌的資訊，只在 Expert */}
          {mode === 'expert' && hasStrategy && (
            <StrategySides legs={allocs} exchange={contracts?.exchange ?? null} />
          )}
          {mode === 'expert' && traderAddr && <TraderFeedSection wallet={wallet} trader={traderAddr} />}

          {/* ─── D. Strategy History ───────────────────────────────── */}
          {stratHistory.length > 0 && (
            <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{historyTitle}</Typography>
                {stratHistory.length > FIRST_VERSIONS && (
                  <ExpandListButton count={stratHistory.length} onClick={() => setVersionsOpen(true)} />
                )}
              </Box>
              <Stack spacing={1.5}>
                {stratHistory.slice(0, FIRST_VERSIONS).map(renderVersion)}
              </Stack>
              <ListDialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title={historyTitle}>
                <Stack spacing={1.5} sx={{ p: 2 }}>
                  {stratHistory.map(renderVersion)}
                </Stack>
              </ListDialog>
            </Card>
          )}

          {/* ─── D. Followers ──────────────────────────────────────── */}
          {FEATURE_COPY_TRADING && followerList.length > 0 && (
            <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                {interpolate(t.traderProfile.followers.titleFirst, { count: followerList.length })}
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableBody>
                    {followerList.map((addr, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ fontFamily: MONO, color: 'text.primary' }}>
                          {shortAddr(addr)}
                        </TableCell>
                        <TableCell align="right" sx={{ color: 'text.secondary' }}>
                          #{i + 1}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}

          {/* ─── E. Slash History ──────────────────────────────────── */}
          {/* 讀取失敗：明說無法確認，絕不顯示成「沒有罰沒」。合約 storage 的
              totalSlashed 是完整的累計值（不受掃描範圍限制），讀得到就一併列出。 */}
          {slashRead === 'pending' && (
            <Typography variant="caption" color="text.secondary">
              {t.traderProfile.slashHistory.loading}
            </Typography>
          )}
          {slashRead === 'failed' && (
            <Alert severity="error">
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {t.traderProfile.slashHistory.readFailedTitle}
              </Typography>
              {t.traderProfile.slashHistory.readFailedBody}
              {stakeInfo && (
                <Box sx={{ mt: 0.5 }}>
                  {interpolate(t.traderProfile.slashHistory.totalFromContract, { amount: f18(stakeInfo.totalSlashed) })}
                </Box>
              )}
            </Alert>
          )}
          {slashRead === 'ok' && slashHistory.length === 0 && stakeInfo && stakeInfo.totalSlashed > 0n && (
            <Alert severity="warning">
              {interpolate(t.traderProfile.slashHistory.outsideWindow, {
                span: describeScanWindow(wallet.chainId, slashBlocks),
                amount: f18(stakeInfo.totalSlashed),
              })}
            </Alert>
          )}
          {slashHistory.length > 0 && (
            <Card sx={{ p: 3, border: '1px solid', borderColor: 'error.main', bgcolor: 'rgba(255, 86, 48, 0.08)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="subtitle1" color="error.main" sx={{ fontWeight: 'bold' }}>
                {interpolate(
                  slashHistory.length === 1
                    ? t.traderProfile.slashHistory.titleOne
                    : t.traderProfile.slashHistory.titleMany,
                  { count: slashHistory.length },
                )}
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableBody>
                    {slashHistory.map((ev, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Typography variant="body2" color="error.main" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                            −{f18(ev.amount)} USDC
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            → {shortAddr(ev.recipient)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          {explorerTx(ev.txHash, wallet.chainId) && (
                            <Link
                              href={explorerTx(ev.txHash, wallet.chainId)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              color="info.main"
                              sx={{ fontSize: '0.875rem', textDecoration: 'underline' }}
                            >
                              {explorerName(wallet.chainId)} ↗
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}

          {hero && <HeroTrades hero={hero} provider={wallet.provider} chainId={wallet.chainId} />}

          {/* ─── F. On-chain activity ──────────────────────────────── */}
          {/* 從 WhaleTrackerPage 搬過來。那一頁查完地址就把交易紀錄長在自己
              身上，於是這裡有 follower / stake / reputation 卻看不到任何一筆
              交易，兩邊各只有半張臉。 */}
          <TraderActivity activity={addressActivity} chainId={wallet.chainId} mode={mode} />

          {/* Actions */}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Button
              component={RouterLink}
              to="/marketplace"
              variant="outlined"
              color="inherit"
              sx={{ textTransform: 'none' }}
            >
              {t.traderProfile.actions.backToMarketplace}
            </Button>
            <Button
              component={RouterLink}
              to="/whale"
              variant="outlined"
              color="inherit"
              sx={{ textTransform: 'none' }}
            >
              {t.traderProfile.actions.whaleTracker}
            </Button>
          </Box>
        </>
      )}
    </Container>
  )
}
