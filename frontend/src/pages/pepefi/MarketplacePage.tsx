import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink } from 'react-router';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useLivePrices } from 'src/hooks/useLivePrices';
import { ASSET_IDS } from 'src/contracts/addresses';
import Skeleton from 'src/components/pepefi/Skeleton';
import EmptyState from 'src/components/pepefi/EmptyState';
import { useESG } from 'src/hooks/useESG';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { getPepeAvatar } from 'src/utils/pepefi-assets';
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Avatar from '@mui/material/Avatar';
import Link from '@mui/material/Link';
import { Icon } from '@iconify/react';

// ── Config ───────────────────────────────────────────────────────────────────
const FETCH_BLOCKS_VOLUME = 50_000;   // ~7 days on Sepolia

// ── Types ────────────────────────────────────────────────────────────────────
type SortKey = 'reputation' | 'followers' | 'volume' | 'pnl' | 'esg';

const ESG_FRIENDLY_THRESHOLD = 60;   // weighted composite ≥ 60

interface RawAlloc {
  asset:    string;
  weight:   bigint;
  isLong:   boolean;
  leverage: bigint;
}

interface TraderCard {
  address:       string;
  displayName:   string;
  allocs:        RawAlloc[];
  followerCount: bigint;
  hasStrategy:   boolean;
  reputation:    bigint | null;
  stake:         bigint | null;
  totalSlashed:  bigint | null;
  totalVolume:   bigint;   // margin × leverage, last 7d
  pnl7d:         bigint;   // sum realizedPnL from PositionClosed, last 7d
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const parseAllocs = (arr: unknown[]): RawAlloc[] =>
  arr.map(a => {
    const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint };
    return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage };
  });

const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const summarize = (allocs: RawAlloc[]): string =>
  allocs
    .map(a =>
      `${a.isLong ? 'L' : 'S'} ${ASSET_LABEL[a.asset] ?? '?'} ` +
      `${(Number(a.weight) / 100).toFixed(0)}% ${String(a.leverage)}×`
    )
    .join(' | ');

const cmpBigDesc = (a: bigint, b: bigint) =>
  a === b ? 0 : b > a ? 1 : -1;

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

const avatarHue = (addr: string): string => {
  const n = parseInt(addr.slice(2, 8), 16) % 360;
  return `hsl(${n}, 60%, 40%)`;
};

// ── Component ────────────────────────────────────────────────────────────────
export default function MarketplacePage() {
  const wallet = usePepefiWallet();
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);
  const livePrices = useLivePrices();

  const [traders,    setTraders]    = useState<TraderCard[]>([]);
  const [isLoading,  setIsLoading]  = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [sortKey,    setSortKey]    = useState<SortKey>('reputation');
  const [esgOnly,    setEsgOnly]    = useState(false);

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

      const volumeMap: Record<string, bigint> = {};
      for (const log of allOpened as any[]) {
        const owner = (log.args.owner as string).toLowerCase();
        const vol   = (log.args.margin as bigint) * (log.args.leverage as bigint);
        volumeMap[owner] = (volumeMap[owner] ?? 0n) + vol;
      }
      const pnlMap: Record<string, bigint> = {};
      for (const log of allClosed as any[]) {
        const owner = (log.args.owner as string).toLowerCase();
        pnlMap[owner] = (pnlMap[owner] ?? 0n) + (log.args.pnl as bigint);
      }

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
          let hasStrategy = false;
          try {
            const stratRaw = (await contracts.registry.getLatestStrategy(addr)) as unknown as [unknown[], bigint];
            allocs      = parseAllocs(stratRaw[0] as unknown[]);
            hasStrategy = allocs.length > 0;
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

          const key = addr.toLowerCase();
          return {
            address:      addr,
            displayName:  tRaw[1],
            allocs,
            followerCount: fc,
            hasStrategy,
            reputation,
            stake,
            totalSlashed,
            totalVolume: volumeMap[key] ?? 0n,
            pnl7d:       pnlMap[key]    ?? 0n,
          };
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

  const sorted = [...traders]
    .filter(t => {
      if (!t.hasStrategy) return false;
      if (!esgOnly) return true;
      const score = getEsgComposite(t);
      return score !== null && score >= ESG_FRIENDLY_THRESHOLD;
    })
    .sort((a, b) => {
      switch (sortKey) {
        case 'followers':   return cmpBigDesc(a.followerCount, b.followerCount);
        case 'volume':      return cmpBigDesc(a.totalVolume, b.totalVolume);
        case 'pnl':         return cmpBigDesc(a.pnl7d, b.pnl7d);
        case 'esg': {
          const ea = getEsgComposite(a) ?? -1;
          const eb = getEsgComposite(b) ?? -1;
          return eb - ea;
        }
        case 'reputation':
        default: {
          if (a.reputation === null && b.reputation === null) return 0;
          if (a.reputation === null) return 1;
          if (b.reputation === null) return -1;
          return cmpBigDesc(a.reputation, b.reputation);
        }
      }
    });

  const MEDALS    = ['🥇', '🥈', '🥉'];
  const MEDAL_BORDER_COLOR = [
    'rgba(234, 179, 8, 0.4)',
    'rgba(145, 158, 171, 0.4)',
    'rgba(245, 158, 11, 0.4)',
  ];

  const isStarTrader = (t: TraderCard) =>
    t.reputation !== null && t.reputation > 80n && t.followerCount > 3n;

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
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            ⭐ Star Trader Leaderboard
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Browse and copy on-chain verified strategies
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
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
            ESG {esgOnly ? '已篩選' : '全部'}
          </Button>

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <Select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              sx={{ borderRadius: 1 }}
            >
              <MenuItem value="reputation">Sort: Reputation</MenuItem>
              <MenuItem value="followers">Sort: Followers</MenuItem>
              <MenuItem value="volume">Sort: Volume (7d)</MenuItem>
              <MenuItem value="pnl">Sort: PnL (7d)</MenuItem>
              <MenuItem value="esg">Sort: ESG Score</MenuItem>
            </Select>
          </FormControl>

          <IconButton size="small" onClick={() => void fetchAll()} color="inherit">
            <Icon icon="solar:restart-bold-duotone" width={16} />
          </IconButton>
        </Box>
      </Box>

      {/* Live Prices ticker */}
      <Card sx={{ p: 2, display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
        <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1.5 }}>
          Live Prices
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {Object.entries(ASSET_LABEL).map(([id, label]) => {
            const p = livePrices[id];
            if (!p) return null;
            return (
              <Chip
                key={id}
                label={
                  <Box component="span" sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                    <Typography variant="caption" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>{label}</Typography>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: p.isMock ? 'warning.main' : 'success.main' }}>
                      ${p.usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </Typography>
                  </Box>
                }
                size="small"
                variant="outlined"
                sx={{ borderColor: 'divider', height: 24 }}
              />
            );
          })}
        </Box>
      </Card>

      {fetchError && (
        <Alert severity="error">
          <strong>Failed to load:</strong> {fetchError}
        </Alert>
      )}

      {/* Leaderboard grid */}
      {isLoading ? (
        <Grid container spacing={3}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={i}>
              <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Skeleton variant="circular" width={40} height={40} />
                  <Stack spacing={0.5} sx={{ flexGrow: 1 }}>
                    <Skeleton width={120} height={16} />
                    <Skeleton width={80} height={12} />
                  </Stack>
                </Box>
                <Skeleton width="100%" height={16} />
                <Skeleton width="80%" height={16} />
                <Box sx={{ display: 'flex', gap: 1, pt: 1 }}>
                  <Skeleton height={32} sx={{ flexGrow: 1 }} />
                  <Skeleton height={32} sx={{ flexGrow: 1 }} />
                </Box>
              </Card>
            </Grid>
          ))}
        </Grid>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No traders yet"
          description="Run SeedWhales to populate the leaderboard, or register a strategy on the Trader page."
          ctaText="Become a Trader"
          ctaHref="/trader"
        />
      ) : (
        <>
          <Grid container spacing={3}>
            {sorted.map((t, idx) => {
              const star   = isStarTrader(t);
              const medal  = MEDALS[idx];
              const isTop3 = idx < 3;
              const borderColor = isTop3 ? MEDAL_BORDER_COLOR[idx] : 'divider';
              const shadowGlow  = isTop3 ? `0 8px 24px rgba(0, 167, 111, 0.08)` : 'none';

              const esgScore = getEsgComposite(t);
              const esgComposite = esgScore !== null
                ? {
                    composite: esgScore,
                    rating: esgScore >= 80 ? 'AAA' : esgScore >= 70 ? 'AA' : esgScore >= 60 ? 'A' : esgScore >= 50 ? 'BBB' : 'CCC',
                  }
                : null;

              return (
                <Grid size={{ xs: 12, sm: 6, md: 4 }} key={t.address}>
                  <Card
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      height: '100%',
                      border: '1px solid',
                      borderColor: borderColor,
                      boxShadow: shadowGlow,
                      transition: 'transform 0.2s, box-shadow 0.2s',
                      position: 'relative',
                      overflow: 'hidden',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: (theme) => theme.shadows[16],
                        borderColor: isTop3 ? borderColor : 'primary.main',
                      },
                    }}
                  >
                    {/* Star Trader banner */}
                    {star && (
                      <Box
                        sx={{
                          py: 0.5,
                          px: 2,
                          background: 'linear-gradient(135deg, rgba(255, 171, 0, 0.16), rgba(255, 171, 0, 0.04))',
                          borderBottom: '1px solid rgba(255, 171, 0, 0.24)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                        }}
                      >
                        <Typography variant="caption" sx={{ fontWeight: 'bold', color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          ⭐ Star Trader
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.8, fontSize: '0.625rem' }}>
                          Verified On-Chain
                        </Typography>
                      </Box>
                    )}

                    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, flexGrow: 1 }}>
                      {/* Identity Row */}
                      <Box sx={{ display: 'flex', alignItems: 'start', gap: 2 }}>
                        <Avatar
                          src={getPepeAvatar(t.reputation, t.address)}
                          sx={{
                            width: 56,
                            height: 56,
                            border: '2px solid',
                            borderColor: t.reputation && t.reputation >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
                            boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                          }}
                        />

                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                            {medal ? (
                              <Typography sx={{ fontSize: '1.125rem', lineHeight: 1 }} title={`#${idx + 1}`}>{medal}</Typography>
                            ) : (
                              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', fontWeight: 'bold', mr: 0.5 }}>
                                #{idx + 1}
                              </Typography>
                            )}
                            <Link
                              component={RouterLink}
                              to={`/trader/${t.address}`}
                              sx={{
                                fontWeight: 'bold',
                                color: 'text.primary',
                                textDecoration: 'none',
                                hover: { color: 'primary.main' },
                                display: 'block',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '100%',
                              }}
                            >
                              {t.displayName || '—'}
                            </Link>
                          </Box>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap', gap: 1 }}>
                            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                              {shortAddr(t.address)}
                            </Typography>
                            <TraderRankBadge reputation={t.reputation} />
                          </Stack>
                        </Box>

                        {t.reputation !== null && (
                          <Chip
                            label={`◆ ${String(t.reputation)}`}
                            size="small"
                            color={repBadgeColor(t.reputation)}
                            sx={{ fontWeight: 'bold', fontSize: '0.75rem', height: 22 }}
                          />
                        )}
                      </Box>

                      {/* Strategy Pills */}
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, minHeight: 24 }}>
                        {!t.hasStrategy ? (
                          <Chip
                            label="No strategy"
                            size="small"
                            variant="outlined"
                            sx={{ color: 'text.secondary', borderColor: 'divider' }}
                          />
                        ) : (
                          t.allocs.map((a, i) => (
                            <Chip
                              key={i}
                              label={`${a.isLong ? '↑' : '↓'}${ASSET_LABEL[a.asset] ?? '?'} ${(Number(a.weight) / 100).toFixed(0)}% ${String(a.leverage)}×`}
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

                      {/* Metrics Table Block */}
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(4, 1fr)',
                          borderRadius: 1,
                          border: '1px solid',
                          borderColor: 'divider',
                          bgcolor: 'background.neutral',
                          py: 1,
                        }}
                      >
                        <MetricCell
                          label="Vol 7d"
                          value={t.totalVolume > 0n ? fVol(t.totalVolume) : '—'}
                          highlight={t.totalVolume >= 10_000n * 10n ** 18n}
                        />
                        <MetricCell
                          label="PnL 7d"
                          value={t.pnl7d !== 0n ? fPnL(t.pnl7d) : '—'}
                          positive={t.pnl7d > 0n}
                          negative={t.pnl7d < 0n}
                        />
                        <MetricCell
                          label="Followers"
                          value={String(t.followerCount)}
                        />
                        <MetricCell
                          label="Stake"
                          value={t.stake !== null && t.stake > 0n ? fVol(t.stake) : '—'}
                        />
                      </Box>

                      {/* Slashed Indicator */}
                      {t.totalSlashed !== null && t.totalSlashed > 0n && (
                        <Alert severity="error" icon={false} sx={{ py: 0, px: 1.5, '& .MuiAlert-message': { py: 0.5, fontSize: '0.6875rem', fontWeight: 'bold' } }}>
                          ⚠ {(Number(t.totalSlashed) / 1e18).toFixed(0)} mUSDC slashed
                        </Alert>
                      )}

                      {/* Action buttons */}
                      <Box sx={{ display: 'flex', gap: 1, mt: 'auto', pt: 1.5 }}>
                        <Button
                          fullWidth
                          variant="outlined"
                          size="small"
                          color="inherit"
                          component={RouterLink}
                          to={`/trader/${t.address}`}
                          sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem', py: 0.75, borderRadius: 1 }}
                        >
                          Profile
                        </Button>
                        {t.hasStrategy ? (
                          <Button
                            fullWidth
                            variant="contained"
                            size="small"
                            color="primary"
                            component={RouterLink}
                            to={`/copy/${t.address}`}
                            sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem', py: 0.75, borderRadius: 1 }}
                          >
                            Copy →
                          </Button>
                        ) : (
                          <Button
                            fullWidth
                            disabled
                            variant="contained"
                            size="small"
                            sx={{ textTransform: 'none', fontWeight: 'bold', fontSize: '0.75rem', py: 0.75, borderRadius: 1 }}
                          >
                            No Strategy
                          </Button>
                        )}
                      </Box>
                    </Box>
                  </Card>
                </Grid>
              );
            })}
          </Grid>

          {/* Footer Info details */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'text.secondary', fontSize: '0.75rem', mt: 2, flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {sorted.length} trader{sorted.length !== 1 ? 's' : ''} ·{' '}
              {sorted.reduce((s, t) => s + Number(t.followerCount), 0)} total followers ·{' '}
              {sorted.filter(isStarTrader).length} star trader{sorted.filter(isStarTrader).length !== 1 ? 's' : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Volume + PnL from last ~{FETCH_BLOCKS_VOLUME.toLocaleString()} blocks (~7d)
            </Typography>
          </Box>

          <Box component="details" sx={{ mt: 2 }}>
            <Typography component="summary" variant="caption" sx={{ color: 'text.secondary', cursor: 'pointer', '&:hover': { color: 'text.primary' } }}>
              Raw strategy data
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 1.5,
                p: 2,
                borderRadius: 1,
                bgcolor: 'background.neutral',
                border: '1px solid',
                borderColor: 'divider',
                fontSize: '0.6875rem',
                color: 'text.secondary',
                fontFamily: 'monospace',
                overflowX: 'auto',
              }}
            >
              {traders.map(t => `${t.displayName} (${shortAddr(t.address)}): ${summarize(t.allocs) || 'no strategy'}`).join('\n')}
            </Box>
          </Box>
        </>
      )}
    </Container>
  );
}

// ── Metric cell sub-component ─────────────────────────────────────────────────
function MetricCell({
  label, value, highlight = false, positive = false, negative = false,
}: {
  label: string; value: string; highlight?: boolean; positive?: boolean; negative?: boolean;
}) {
  const valueColor = positive ? 'success.main' : negative ? 'error.main' : highlight ? 'primary.light' : 'text.primary';
  return (
    <Box sx={{ textAlign: 'center', px: 0.5, py: 0.25 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', fontSize: '0.5625rem', letterSpacing: 0.5, mb: 0.25 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ fontWeight: 'bold', fontFamily: 'monospace', color: valueColor, fontSize: '0.75rem', lineHeight: 1 }}>
        {value}
      </Typography>
    </Box>
  );
}

void ASSET_IDS;
