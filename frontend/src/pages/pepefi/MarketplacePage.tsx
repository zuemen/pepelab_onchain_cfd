import { MONO, LiveDot } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink } from 'react-router';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useMode } from 'src/contexts/mode-context';
import { ASSET_IDS, CHAIN_NAMES } from 'src/contracts/addresses';
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton';
import EmptyState from 'src/components/pepefi/EmptyState';
import { useESG } from 'src/hooks/useESG';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import Podium from 'src/components/pepefi/Podium';
import EquitySparkline from 'src/components/pepefi/EquitySparkline';
import ScoreBreakdownPopover from 'src/components/pepefi/ScoreBreakdownPopover';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { getPepeAvatar } from 'src/utils/pepefi-assets';
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge';
import { t, interpolate } from 'src/locales';
import {
  parseAllocs,
  buildVolumeMap,
  buildMarginMap,
  buildPnlMap,
  groupClosedEventsByOwner,
  buildTraderCard,
  cmpBigDesc,
  cmpNullableBigDesc,
  matchesSearch,
  scoreChipColor,
  type RawAlloc,
  type TraderCard,
  type OpenedEvent,
  type ClosedEvent,
} from 'src/lib/pepefi/leaderboardMetrics';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Tooltip from '@mui/material/Tooltip';
import Avatar from '@mui/material/Avatar';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableSortLabel from '@mui/material/TableSortLabel';
import { Icon } from '@iconify/react';

// ── Config ───────────────────────────────────────────────────────────────────
const FETCH_BLOCKS_VOLUME = 50_000;   // ~7 days on Sepolia

// Expert Mode 有 12 欄,單一螢幕寬度塞不下——固定「#」「交易者」在左、「操作」在
// 右,中間的指標欄自己橫向捲動。兩顆固定不動的欄位讓使用者橫向捲動時永遠知道
// 這一列是誰、永遠按得到跟單鈕,不用捲到底才找得到。
const STICKY_RANK_W   = 56;
const STICKY_TRADER_W = 220;
/** 左側固定欄與可捲動區交界處的陰影,提示「這裡還有內容,可以往右滑」。 */
const STICKY_LEFT_EDGE_SHADOW  = '6px 0 6px -6px rgba(0,0,0,0.35)';
const STICKY_RIGHT_EDGE_SHADOW = '-6px 0 6px -6px rgba(0,0,0,0.35)';

// ── Types ────────────────────────────────────────────────────────────────────
type SortKey = 'score' | 'reputation' | 'followers' | 'volume' | 'pnl' | 'stake' | 'esg';

const ESG_FRIENDLY_THRESHOLD = 60;   // weighted composite ≥ 60

/**
 * Simple Mode 只留「# · 交易者 · TraderScore · 7d 曲線 · 7d 損益 · 跟單」——
 * 這些排序鍵在 Simple 沒有對應欄位,選了也看不出差異,所以 Simple 底下的
 * Select 選單直接不給選;若在 Expert 用其中一種排序後切回 Simple,見下面
 * 的 mode-reset effect,退回預設的 score。
 */
const EXPERT_ONLY_SORT_KEYS = new Set<SortKey>(['reputation', 'followers', 'volume', 'stake', 'esg']);

// ── Helpers ──────────────────────────────────────────────────────────────────
const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const fVol = (v: bigint): string => {
  const n = Number(v) / 1e18;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return n.toFixed(0);
};

const fPnL = (v: bigint): string => {
  const n = Number(v) / 1e18;
  const prefix = n >= 0 ? '+' : '';
  if (Math.abs(n) >= 1_000) return prefix + (n / 1_000).toFixed(1) + 'k';
  return prefix + n.toFixed(1);
};

const repBadgeColor = (score: bigint) =>
  score >= 80n ? 'success'
  : score >= 60n ? 'warning'
  : 'error';

/** 「62% (21)」的形式:百分比永遠附帶樣本數,不裸露一個看起來很篤定的百分比。 */
const fWinRate = (wins: number, trades: number): string =>
  trades === 0 ? '—' : `${Math.round((wins / trades) * 100)}% (${trades})`;

// ── Component ────────────────────────────────────────────────────────────────
export default function MarketplacePage() {
  const wallet = usePepefiWallet();
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);
  const { mode } = useMode();

  const [traders,    setTraders]    = useState<TraderCard[]>([]);
  const [isLoading,  setIsLoading]  = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [sortKey,    setSortKey]    = useState<SortKey>('score');
  const [esgOnly,    setEsgOnly]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [scorePopover, setScorePopover] = useState<{ anchorEl: HTMLElement; trader: TraderCard } | null>(null);

  // Expert 專屬排序鍵在 Simple 底下沒有對應欄位可看——切回 Simple 時退回預設的
  // score,不要停在一個看不見的欄位上(見 #89 acceptance criteria)。
  useEffect(() => {
    if (mode === 'simple' && EXPERT_ONLY_SORT_KEYS.has(sortKey)) {
      setSortKey('score');
    }
  }, [mode, sortKey]);

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.provider) return;
    setIsLoading(true);
    setFetchError(null);
    try {
      const currentBlock = await wallet.provider.getBlockNumber();
      const fromBlock    = Math.max(0, currentBlock - FETCH_BLOCKS_VOLUME);

      const [openedRes, closedRes, addressesRes] = await Promise.allSettled([
        contracts.exchange.queryFilter(contracts.exchange.filters.PositionOpened(), fromBlock, 'latest'),
        contracts.exchange.queryFilter(contracts.exchange.filters.PositionClosed(), fromBlock, 'latest'),
        contracts.registry.getAllTraders() as Promise<string[]>,
      ]);
      const allOpened  = openedRes.status    === 'fulfilled' ? openedRes.value    : [];
      const allClosed  = closedRes.status    === 'fulfilled' ? closedRes.value    : [];
      const addresses  = addressesRes.status === 'fulfilled' ? addressesRes.value : [];

      const openedEvents: OpenedEvent[] = (allOpened as any[]).map(log => ({
        owner:    log.args.owner as string,
        margin:   log.args.margin as bigint,
        leverage: log.args.leverage as bigint,
      }));
      const closedEvents: ClosedEvent[] = (allClosed as any[]).map(log => ({
        owner: log.args.owner as string,
        pnl:   log.args.pnl as bigint,
      }));
      const aggregates = {
        volumeMap:           buildVolumeMap(openedEvents),
        marginMap:           buildMarginMap(openedEvents),
        pnlMap:              buildPnlMap(closedEvents),
        closedEventsByOwner: groupClosedEventsByOwner(closedEvents),
      };

      const cards = await Promise.all(
        (addresses as string[]).map(async (addr): Promise<TraderCard> => {
          let tRaw: [boolean, string, bigint] = [false, '', 0n];
          let fc: bigint = 0n;
          try {
            const [traderRaw, followerCount] = await Promise.all([
              contracts.registry.traders(addr),
              contracts.copyTracker.getFollowerCount(addr),
            ]);
            tRaw = traderRaw as unknown as [boolean, string, bigint];
            fc = followerCount as bigint;
          } catch { /* unregistered or unavailable */ }

          let allocs: RawAlloc[] = [];
          try {
            const stratRaw = (await contracts.registry.getLatestStrategy(addr)) as unknown as [unknown[], bigint];
            allocs = parseAllocs(stratRaw[0] as unknown[]);
          } catch { /* no strategy yet */ }

          let reputation:   bigint | null = null;
          let stake:        bigint | null = null;
          let totalSlashed: bigint | null = null;
          try {
            const [score, si] = await Promise.all([
              contracts.traderStake.reputationScore(addr),
              contracts.traderStake.getStake(addr),
            ]);
            reputation   = score as bigint;
            const s      = si as unknown as { amount: bigint; totalSlashed: bigint };
            stake        = s.amount;
            totalSlashed = s.totalSlashed;
          } catch { /* TraderStake not deployed */ }

          return buildTraderCard(
            {
              address:      addr,
              displayName:  tRaw[1],
              allocs,
              followerCount: fc,
              reputation,
              stake,
              totalSlashed,
            },
            aggregates,
          );
        })
      );

      setTraders(cards);
    } catch (e) {
      console.error('[marketplace fetch]', e);
      setFetchError(e instanceof Error ? e.message.slice(0, 140) : 'Network error — check wallet');
    } finally { setIsLoading(false); }
  }, [contracts, wallet.provider]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

  const getEsgComposite = (t: TraderCard): number | null => {
    if (!t.hasStrategy || t.allocs.length === 0) return null;
    const totalW = t.allocs.reduce((s, a) => s + Number(a.weight), 0);
    if (totalW === 0) return null;
    let wavg = 0;
    for (const a of t.allocs) {
      const info = esg[a.asset];
      if (!info) return null;
      wavg += info.composite * Number(a.weight);
    }
    return Math.round(wavg / totalW);
  };

  // 有策略、且(若開了 ESG 篩選)通過門檻的交易者——這是「排行榜裡本來就有的人」。
  // 搜尋框再篩一層在下面的 visible,兩者分開算是為了區分「這條鏈真的沒人」跟
  // 「有人,只是搜尋詞沒有比對到」這兩種完全不同的空狀態。
  const filtered = traders.filter(tr => {
    if (!tr.hasStrategy) return false;
    if (!esgOnly) return true;
    const score = getEsgComposite(tr);
    return score !== null && score >= ESG_FRIENDLY_THRESHOLD;
  });

  const visible = [...filtered]
    .filter(tr => matchesSearch(tr, search))
    .sort((a, b) => {
      switch (sortKey) {
        case 'followers': return cmpBigDesc(a.followerCount, b.followerCount);
        case 'volume':    return cmpBigDesc(a.totalVolume, b.totalVolume);
        case 'pnl':       return cmpBigDesc(a.pnl7d, b.pnl7d);
        case 'stake':     return cmpNullableBigDesc(a.stake, b.stake);
        case 'reputation': return cmpNullableBigDesc(a.reputation, b.reputation);
        case 'esg': {
          const ea = getEsgComposite(a) ?? -1;
          const eb = getEsgComposite(b) ?? -1;
          return eb - ea;
        }
        case 'score':
        default:
          return b.score.total - a.score.total;
      }
    });

  // 領獎台跟著目前排序走,取 visible 的前三名——但「資料不足」(平倉 <5 筆)的
  // 交易者排除在外,不讓僥倖的少量樣本登上榜首。這些人仍然留在下面的表格裡,
  // 只是不佔領獎台的位置。
  const podium = visible.filter(tr => !tr.score.insufficientSample).slice(0, 3);
  const podiumAddresses = new Set(podium.map(tr => tr.address));

  // 表格從第 4 名接續,不重複顯示領獎台上的人——但名次標示的是這個人在 visible
  // 裡的真實排名,不是表格陣列裡的位置。「資料不足」的人若排在前三名,不會上
  // 領獎台,但仍會用他真實的名次(例如 #2)留在表格裡,名次因此可能不連續。
  const rankOf = new Map(visible.map((tr, i) => [tr.address, i + 1]));
  const tableRows = visible.filter(tr => !podiumAddresses.has(tr.address));

  const isStarTrader = (t: TraderCard) =>
    t.reputation !== null && t.reputation > 80n && t.followerCount > 3n;

  const starTraderCount = visible.filter(isStarTrader).length;

  const allSortOptions: Array<{ key: SortKey; label: string }> = [
    { key: 'score', label: t.marketplace.sort.score },
    { key: 'pnl', label: t.marketplace.sort.pnl },
    { key: 'reputation', label: t.marketplace.sort.reputation },
    { key: 'followers', label: t.marketplace.sort.followers },
    { key: 'volume', label: t.marketplace.sort.volume },
    { key: 'stake', label: t.marketplace.sort.stake },
    { key: 'esg', label: t.marketplace.sort.esg },
  ];
  const sortOptions = allSortOptions.filter(opt => mode === 'expert' || !EXPERT_ONLY_SORT_KEYS.has(opt.key));

  const sortableHeader = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <TableCell align={align} sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
      <TableSortLabel
        active={sortKey === key}
        direction="desc"
        onClick={() => setSortKey(key)}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to browse the marketplace.</Typography>
      </Box>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
              {t.marketplace.title}
            </Typography>
            <LiveDot />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t.marketplace.subtitle}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t.marketplace.search.placeholder}
            sx={{ minWidth: 220 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Icon icon="solar:magnifer-linear" width={16} />
                  </InputAdornment>
                ),
              },
            }}
          />

          <Button
            size="small"
            variant={esgOnly ? 'contained' : 'outlined'}
            color={esgOnly ? 'success' : 'inherit'}
            onClick={() => setEsgOnly(v => !v)}
            startIcon={<Icon icon="solar:leaf-bold" />}
            sx={{
              borderRadius: 1,
              borderColor: 'divider',
              textTransform: 'none',
              fontWeight: 'bold',
            }}
          >
            {interpolate(t.marketplace.esgButton, {
              state: esgOnly ? t.marketplace.esgFiltered : t.marketplace.esgAll,
            })}
          </Button>

          {/* 窄螢幕沒有欄位標頭可點,這個下拉是排序的替代入口——跟表頭共用同一個 sortKey。 */}
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <Select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              sx={{ borderRadius: 1 }}
            >
              {sortOptions.map(opt => (
                <MenuItem key={opt.key} value={opt.key}>{opt.label}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <IconButton
            size="small"
            onClick={() => void fetchAll()}
            color="inherit"
            aria-label={t.marketplace.refreshAria}
          >
            <Icon icon="solar:restart-bold-duotone" width={16} />
          </IconButton>
        </Box>
      </Box>

      {fetchError && (
        <Alert severity="error">
          <strong>{t.marketplace.loadFailed}</strong> {fetchError}
        </Alert>
      )}

      {/* Leaderboard table */}
      {isLoading ? (
        <Card>
          <TableSkeleton rows={8} cols={mode === 'expert' ? 12 : 6} />
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🎯"
          title={t.marketplace.empty.title}
          description={interpolate(t.marketplace.empty.description, {
            chain: wallet.chainId !== null
              ? (CHAIN_NAMES[wallet.chainId] ?? interpolate(t.marketplace.empty.unknownChain, { chainId: wallet.chainId }))
              : interpolate(t.marketplace.empty.unknownChain, { chainId: '—' }),
            blocks: FETCH_BLOCKS_VOLUME.toLocaleString(),
          })}
          ctaText={t.marketplace.empty.cta}
          ctaHref="/trader"
          secondaryCtaText={t.marketplace.empty.secondaryCta}
          secondaryCtaHref="/x402"
        />
      ) : visible.length === 0 ? (
        // 這條鏈上有交易者,只是搜尋詞沒比對到——跟上面「這條鏈真的沒人」是兩種不同的空狀態,
        // 不該共用同一句要人去檢查連的鏈的說明。
        <Typography variant="body2" color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>
          {interpolate(t.marketplace.search.noResults, { query: search })}
        </Typography>
      ) : (
        <>
          <Podium
            podium={podium}
            onScoreClick={(el, trader) => setScorePopover({ anchorEl: el, trader })}
          />

          <TableContainer component={Card} sx={{ overflowX: 'auto' }}>
            {/* borderCollapse:'separate' — MUI's default 'collapse' clips box-shadow on <td>,
                which would silently hide the sticky-column scroll-affordance shadows below. */}
            <Table size="small" sx={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  <TableCell
                    sx={{
                      position: 'sticky', left: 0, zIndex: 3, minWidth: STICKY_RANK_W,
                      bgcolor: 'background.neutral', color: 'text.secondary', fontWeight: 'bold',
                    }}
                  >
                    {t.marketplace.table.rank}
                  </TableCell>
                  <TableCell
                    sx={{
                      position: 'sticky', left: STICKY_RANK_W, zIndex: 3, minWidth: STICKY_TRADER_W,
                      bgcolor: 'background.neutral', color: 'text.secondary', fontWeight: 'bold',
                      boxShadow: STICKY_LEFT_EDGE_SHADOW,
                    }}
                  >
                    {t.marketplace.table.trader}
                  </TableCell>
                  {sortableHeader('score', t.marketplace.table.score)}
                  <TableCell align="center" sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.marketplace.table.trend}</TableCell>
                  {mode === 'expert' && (
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{t.marketplace.table.strategy}</TableCell>
                  )}
                  {mode === 'expert' && sortableHeader('volume', t.marketplace.card.volLabel)}
                  {sortableHeader('pnl', t.marketplace.card.pnlLabel)}
                  {mode === 'expert' && (
                    <TableCell align="right" sx={{ color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.marketplace.table.winRate}</TableCell>
                  )}
                  {mode === 'expert' && sortableHeader('followers', t.marketplace.card.followersLabel)}
                  {mode === 'expert' && sortableHeader('stake', t.marketplace.card.stakeLabel)}
                  {mode === 'expert' && sortableHeader('esg', t.marketplace.table.esg)}
                  <TableCell
                    align="center"
                    sx={{
                      position: 'sticky', right: 0, zIndex: 3,
                      bgcolor: 'background.neutral', color: 'text.secondary', fontWeight: 'bold',
                      boxShadow: STICKY_RIGHT_EDGE_SHADOW,
                    }}
                  >
                    {t.marketplace.table.actions}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map(trader => {
                  const rank = rankOf.get(trader.address) ?? 0;
                  const star = isStarTrader(trader);

                  // esgComposite only feeds the strategy/ESG cells below, both Expert-only — skip the
                  // work entirely in Simple Mode instead of computing it for every row and discarding it.
                  const esgScore = mode === 'expert' ? getEsgComposite(trader) : null;
                  const esgComposite = esgScore !== null
                    ? {
                        composite: esgScore,
                        rating: esgScore >= 80 ? 'AAA' : esgScore >= 70 ? 'AA' : esgScore >= 60 ? 'A' : esgScore >= 50 ? 'BBB' : 'CCC',
                      }
                    : null;

                  return (
                    <TableRow key={trader.address} hover>
                      <TableCell
                        sx={{
                          position: 'sticky', left: 0, zIndex: 1, minWidth: STICKY_RANK_W,
                          bgcolor: 'background.paper', fontFamily: MONO, color: 'text.secondary', fontWeight: 'bold',
                        }}
                      >
                        #{rank}
                      </TableCell>

                      <TableCell
                        sx={{
                          position: 'sticky', left: STICKY_RANK_W, zIndex: 1, minWidth: STICKY_TRADER_W,
                          maxWidth: STICKY_TRADER_W, overflow: 'hidden', bgcolor: 'background.paper',
                          boxShadow: STICKY_LEFT_EDGE_SHADOW,
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Avatar
                            src={getPepeAvatar(trader.reputation, trader.address)}
                            sx={{
                              width: 32,
                              height: 32,
                              flexShrink: 0,
                              border: '1px solid',
                              borderColor: trader.reputation && trader.reputation >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
                              bgcolor: 'rgba(255, 255, 255, 0.05)',
                              '& .MuiAvatar-img': { objectFit: 'contain', padding: '2px' },
                            }}
                          />
                          {/* 名稱、地址、RANK 徽章各自獨立一行——固定寬度的 sticky 欄位裡沒有
                              足夠的水平空間讓地址跟徽章擠在同一行,用垂直空間換,不硬疊。 */}
                          <Box sx={{ minWidth: 0, overflow: 'hidden' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Link
                                component={RouterLink}
                                to={`/trader/${trader.address}`}
                                sx={{
                                  fontWeight: 'bold',
                                  color: 'text.primary',
                                  textDecoration: 'none',
                                  display: 'block',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  maxWidth: '100%',
                                }}
                              >
                                {trader.displayName || t.marketplace.card.noName}
                              </Link>
                              {star && (
                                <Tooltip title={`${t.marketplace.card.starTrader} · ${t.marketplace.card.verifiedOnChain}`}>
                                  <span>⭐</span>
                                </Tooltip>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', lineHeight: 1.6 }}
                            >
                              {shortAddr(trader.address)}
                            </Typography>
                            <Box sx={{ mt: 0.25 }}>
                              <TraderRankBadge reputation={trader.reputation} />
                            </Box>
                          </Box>
                        </Box>
                      </TableCell>

                      <TableCell align="right">
                        <Chip
                          label={trader.score.total.toFixed(0)}
                          size="small"
                          color={scoreChipColor(trader.score.total)}
                          onClick={e => setScorePopover({ anchorEl: e.currentTarget, trader })}
                          sx={{ fontWeight: 'bold', fontSize: '0.75rem', height: 22, fontFamily: MONO, cursor: 'pointer' }}
                        />
                      </TableCell>

                      <TableCell align="center">
                        <EquitySparkline curve={trader.equityCurve} pnl={trader.pnl7d} />
                      </TableCell>

                      {mode === 'expert' && (
                        <TableCell sx={{ maxWidth: 260 }}>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                            {!trader.hasStrategy ? (
                              <Chip
                                label={t.marketplace.card.noStrategy}
                                size="small"
                                variant="outlined"
                                sx={{ color: 'text.secondary', borderColor: 'divider' }}
                              />
                            ) : (
                              trader.allocs.map((a, i) => (
                                <Chip
                                  key={i}
                                  label={interpolate(t.marketplace.card.allocChip, {
                                    side: a.isLong ? '↑' : '↓',
                                    asset: ASSET_LABEL[a.asset] ?? '?',
                                    weight: (Number(a.weight) / 100).toFixed(0),
                                    leverage: String(a.leverage),
                                  })}
                                  size="small"
                                  sx={{
                                    fontSize: '0.625rem',
                                    height: 20,
                                    fontWeight: 'bold',
                                    bgcolor: a.isLong ? 'rgba(34, 197, 94, 0.08)' : 'rgba(255, 86, 48, 0.08)',
                                    color: a.isLong ? 'success.main' : 'error.main',
                                    borderColor: a.isLong ? 'rgba(34, 197, 94, 0.24)' : 'rgba(255, 86, 48, 0.24)',
                                    border: '1px solid',
                                  }}
                                />
                              ))
                            )}
                            {esgComposite && (
                              <ESGBadge composite={esgComposite.composite} rating={esgComposite.rating} size="sm" />
                            )}
                          </Box>
                        </TableCell>
                      )}

                      {mode === 'expert' && (
                        <TableCell align="right" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                          {trader.totalVolume > 0n ? fVol(trader.totalVolume) : '—'}
                        </TableCell>
                      )}

                      <TableCell
                        align="right"
                        sx={{
                          fontFamily: MONO,
                          fontWeight: 'bold',
                          color: trader.pnl7d > 0n ? 'success.main' : trader.pnl7d < 0n ? 'error.main' : 'text.primary',
                        }}
                      >
                        {trader.pnl7d !== 0n ? fPnL(trader.pnl7d) : '—'}
                      </TableCell>

                      {mode === 'expert' && (
                        <TableCell align="right" sx={{ fontFamily: MONO }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                            {fWinRate(trader.wins, trader.trades)}
                            {trader.score.insufficientSample && (
                              <Tooltip title={t.marketplace.scoreBreakdown.insufficientNote}>
                                <Chip
                                  label={t.marketplace.table.insufficientSample}
                                  size="small"
                                  variant="outlined"
                                  sx={{ height: 16, fontSize: '0.5625rem', color: 'text.secondary', borderColor: 'divider' }}
                                />
                              </Tooltip>
                            )}
                          </Box>
                        </TableCell>
                      )}

                      {mode === 'expert' && (
                        <TableCell align="right" sx={{ fontFamily: MONO }}>
                          {String(trader.followerCount)}
                        </TableCell>
                      )}

                      {mode === 'expert' && (
                        <TableCell align="right" sx={{ fontFamily: MONO }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                            {trader.stake !== null && trader.stake > 0n ? fVol(trader.stake) : '—'}
                            {trader.totalSlashed !== null && trader.totalSlashed > 0n && (
                              <Tooltip title={interpolate(t.marketplace.card.slashed, {
                                amount: (Number(trader.totalSlashed) / 1e18).toFixed(0),
                              })}>
                                <Box component="span" sx={{ color: 'error.main', fontSize: '0.75rem', cursor: 'default' }}>⚠</Box>
                              </Tooltip>
                            )}
                          </Box>
                        </TableCell>
                      )}

                      {mode === 'expert' && (
                        <TableCell align="right">
                          {esgComposite ? `${esgComposite.composite}` : '—'}
                        </TableCell>
                      )}

                      <TableCell
                        align="center"
                        sx={{
                          position: 'sticky', right: 0, zIndex: 1,
                          bgcolor: 'background.paper', boxShadow: STICKY_RIGHT_EDGE_SHADOW,
                        }}
                      >
                        <Stack direction="row" spacing={1} justifyContent="center">
                          {mode === 'expert' && (
                            <Button
                              variant="outlined"
                              size="small"
                              color="inherit"
                              component={RouterLink}
                              to={`/trader/${trader.address}`}
                              sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.6875rem', minWidth: 0, px: 1 }}
                            >
                              {t.marketplace.card.profile}
                            </Button>
                          )}
                          {trader.hasStrategy ? (
                            <Button
                              variant="contained"
                              size="small"
                              color="primary"
                              component={RouterLink}
                              to={`/copy/${trader.address}`}
                              sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.6875rem', minWidth: 0, px: 1 }}
                            >
                              {t.marketplace.card.copy}
                            </Button>
                          ) : (
                            <Button
                              disabled
                              variant="contained"
                              size="small"
                              sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.6875rem', minWidth: 0, px: 1 }}
                            >
                              {t.marketplace.card.noStrategyButton}
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          {/* Footer Info details */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'text.secondary', fontSize: '0.75rem', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {interpolate(
                visible.length === 1 ? t.marketplace.footer.countOne : t.marketplace.footer.countMany,
                { count: visible.length },
              )}{' '}
              ·{' '}
              {interpolate(t.marketplace.footer.followersTotal, {
                count: visible.reduce((s, tr) => s + Number(tr.followerCount), 0),
              })}{' '}
              ·{' '}
              {interpolate(
                starTraderCount === 1 ? t.marketplace.footer.starTraderOne : t.marketplace.footer.starTraderMany,
                { count: starTraderCount },
              )}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {interpolate(t.marketplace.footer.volumeWindow, {
                blocks: FETCH_BLOCKS_VOLUME.toLocaleString(),
              })}
            </Typography>
          </Box>
        </>
      )}

      <ScoreBreakdownPopover
        anchorEl={scorePopover?.anchorEl ?? null}
        score={scorePopover?.trader.score ?? null}
        onClose={() => setScorePopover(null)}
      />
    </Container>
  );
}

void ASSET_IDS;
