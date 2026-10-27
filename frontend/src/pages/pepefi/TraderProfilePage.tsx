import { MONO } from 'src/components/pepefi/brandKit'
import { Contract } from 'ethers'
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
import { TraderActivityLive } from 'src/components/pepefi/TraderActivity'
import DeferredSection from 'src/components/pepefi/DeferredSection'
import SlashHistorySection from 'src/components/pepefi/SlashHistorySection'
import { useMode } from 'src/contexts/mode-context'
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags'

// 統計卡：跟單旗標關閉時少了「跟隨者」那張，剩三張各佔三分之一。
const STAT_SIZE = FEATURE_COPY_TRADING ? { xs: 6, md: 3 } : { xs: 12, sm: 4 }
// 策略歷史在卡片上只列最新的這麼多版；全部版本開在彈窗裡（ListDialog）。
const FIRST_VERSIONS = 5
import HeroTrades from 'src/components/pepefi/hero/HeroTrades'
import HeroRiskStats from 'src/components/pepefi/hero/HeroRiskStats'
import HeroPerformance from 'src/components/pepefi/hero/HeroPerformance'
import { fetchHeroDetail, type HeroDetail } from 'src/lib/pepefi/heroData'
import { heroDisclosure } from 'src/lib/pepefi/heroDisclosure'
import { followerReaderOf, readFollowersAcross } from 'src/lib/pepefi/activeFollowers'
import { legacyCopyTrackersFor, LEGACY_COPY_TRACKER_ABI } from 'src/contracts/legacyCopyTrackers'
import { readMany, valueOr } from 'src/lib/pepefi/multicall'
import { readStrategyVersions } from 'src/lib/pepefi/traderReads'
import TxProof from 'src/components/pepefi/hero/TxProof'
import ListDialog, { ExpandListButton } from 'src/components/pepefi/ListDialog'
import StrategySides from 'src/components/pepefi/feed/StrategySides'
import TraderFeedSection from 'src/components/pepefi/feed/TraderFeedSection'
import CarbonTierMixCard from 'src/components/pepefi/CarbonTierMixCard'
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

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint | null>(null)
  const [legacyFollowers, setLegacyFollowers] = useState(0)
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
    const provider = wallet.provider
    const chainId = wallet.chainId
    const go = async () => {
      // 名稱、策略版數、質押、聲譽、資格、收益一批，跟隨者另一條（它自己也是幾批），兩條同時讀。
      // 每一批都併成 Multicall3（見 multicall.ts）。讀不到（或合約沒部署）的欄位維持空白，不是 0。
      // 換過 tracker 時，舊 tracker 上還在跟的人也算進去並分開標示（contracts/legacyCopyTrackers.ts）。
      const legacyReaders = legacyCopyTrackersFor(chainId, String(contracts.copyTracker.target))
        .map((address) => followerReaderOf(new Contract(address, LEGACY_COPY_TRACKER_ABI, contracts.copyTracker.runner), provider, chainId))
      const [first, across] = await Promise.all([
        readMany(provider, chainId, [
          { contract: contracts.registry,    method: 'traders',          args: [traderAddr] },
          { contract: contracts.registry,    method: 'getStrategyCount', args: [traderAddr] },
          { contract: contracts.traderStake, method: 'getStake',         args: [traderAddr] },
          { contract: contracts.traderStake, method: 'reputationScore',  args: [traderAddr] },
          { contract: contracts.traderStake, method: 'isEligible',       args: [traderAddr] },
          { contract: contracts.feeRouter,   method: 'traderEarnings',   args: [traderAddr] },
        ]),
        // 目前的跟隨者，不是 getFollowerCount 的「被跟單過幾次」（見 activeFollowers.ts）。
        // 清單只列還在跟的人、每人一次，前 10 位；讀不到時人數顯示「—」，不是 0。
        readFollowersAcross([traderAddr], followerReaderOf(contracts.copyTracker, provider, chainId), legacyReaders),
      ])
      if (!alive()) return
      const [traderRaw, countRaw, stakeRaw, scoreRaw, eligibleRaw, earningsRaw] = first
      if (traderRaw.status === 'ok') {
        const [isRegistered, displayName] = traderRaw.value as [boolean, string, bigint]
        setName(displayName)
        setRegistered(isRegistered)
      }
      const mine = across.get(traderAddr.toLowerCase()) ?? null
      setFollowers(mine === null ? null : BigInt(mine.all.length))
      setLegacyFollowers(mine?.legacyOnly ?? 0)
      setFollowerList(mine?.all.slice(0, 10) ?? [])
      if (stakeRaw.status === 'ok') setStakeInfo(stakeRaw.value as StakeInfo)
      if (scoreRaw.status === 'ok') setRepScore(scoreRaw.value as bigint)
      if (eligibleRaw.status === 'ok') setEligible(eligibleRaw.value as boolean)
      if (earningsRaw.status === 'ok') setEarnings(earningsRaw.value as bigint)

      // 策略歷史：每一版一筆，模擬交易者有幾十版，同樣併成一批。
      // 任何一版讀不到就整份不給，跟單按鈕變成「尚無可跟單的策略」——不拿缺版的歷史當成完整的。
      const count = Number(valueOr<bigint>(countRaw, 0n))
      setStratCount(count)
      if (count > 0) {
        const vers = await readStrategyVersions(contracts.registry, traderAddr, count, provider, chainId)
        if (!alive()) return
        if (vers === null) {
          setHasStrategy(false)
        } else {
          const sorted: HistVer[] = vers.map((v) => ({ ...v, expanded: false })).reverse()
          setStratHistory(sorted)
          setAllocs(sorted[0]?.allocs ?? [])
          setHasStrategy(sorted[0]?.allocs.length > 0)
        }
      } else {
        setHasStrategy(false)
      }

      setLoading(false)
    }
    void go()
    return () => { cancelled = true }
  }, [contracts, traderAddr, wallet.provider, wallet.chainId])

  // 策略歷史的一列（可以點開看資產明細與發布交易）：卡片上的最新幾版與彈窗裡的全部版本共用。
  const renderVersion = (ver: HistVer) => {
    // 模擬交易者的績效資料裡有每一版的發布交易；展開時附上，可以向節點讀回確認。
    const heroVer = hero?.strategies.find(s => s.versionId === ver.versionId)
    const publishTx = heroVer?.tx ?? null
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
            {/* 時間壓縮的回放：鏈上的發布時間是回放當天，模擬的那一天另外標出來（#344） */}
            {heroVer && hero?.timeCompressed
              ? `${interpolate(t.traderProfile.hero.simDate, { date: heroVer.date })} · ${interpolate(t.traderProfile.hero.chainTime, { time: fmtDate(ver.createdAt) })}`
              : fmtDate(ver.createdAt)}
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
          {heroDisclosure(hero.timeCompressed)}
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
              <StatCard title={t.traderProfile.stats.followers} value={followers === null ? '—' : String(followers)} sub={legacyFollowers > 0 ? interpolate(t.traderProfile.stats.legacyCopiers, { count: legacyFollowers }) : t.traderProfile.stats.copiers} />
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

          {/* #333：目前策略依權重的碳分級組成（策略讀自鏈上，同上） */}
          {hasStrategy && (
            <CarbonTierMixCard
              holdings={allocs.map((a) => ({ asset: a.asset, weight: Number(a.weight) }))}
              tierOf={pricingTiers.tierOf}
              source="trader"
            />
          )}

          {/* 市場多空比例與這位交易者的最近動態（issue #335）：交易桌的資訊，只在 Expert */}
          {mode === 'expert' && hasStrategy && (
            <StrategySides legs={allocs} exchange={contracts?.exchange ?? null} />
          )}
          {/* 動態、罰沒紀錄、目前部位與時間軸都要逐段掃描事件：收起來，點了才掃（DeferredSection） */}
          {mode === 'expert' && traderAddr && (
            <DeferredSection title={t.feed.profile.title}>
              <TraderFeedSection wallet={wallet} trader={traderAddr} />
            </DeferredSection>
          )}

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
          {/* 合約 storage 的累計罰沒是 0：從來沒被罰沒過，不必掃事件，整區不出現。
              累計大於 0、或質押讀不到時才提供（點了才掃）。 */}
          {!loading && contracts && traderAddr && stakeInfo?.totalSlashed !== 0n && (
            <DeferredSection title={t.traderProfile.deferred.slashTitle}>
              <SlashHistorySection
                traderStake={contracts.traderStake}
                trader={traderAddr}
                chainId={wallet.chainId}
                totalSlashed={stakeInfo?.totalSlashed ?? null}
              />
            </DeferredSection>
          )}

          {hero && <HeroTrades hero={hero} provider={wallet.provider} chainId={wallet.chainId} />}

          {/* ─── F. On-chain activity ──────────────────────────────── */}
          {/* 從 WhaleTrackerPage 搬過來。那一頁查完地址就把交易紀錄長在自己
              身上，於是這裡有 follower / stake / reputation 卻看不到任何一筆
              交易，兩邊各只有半張臉。 */}
          {contracts && traderAddr && (
            <DeferredSection title={t.traderProfile.deferred.activityTitle}>
              <TraderActivityLive
                contracts={contracts}
                provider={wallet.provider}
                chainId={wallet.chainId}
                address={traderAddr}
                mode={mode}
              />
            </DeferredSection>
          )}

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
