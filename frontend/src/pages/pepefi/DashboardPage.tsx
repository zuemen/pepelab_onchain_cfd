import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  PieChart, Pie, Cell, Tooltip as PieTooltip, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as LineTooltip, ResponsiveContainer,
} from 'recharts';
import type { LivePrice } from 'src/hooks/useLivePrices';
import { useContracts } from 'src/hooks/useContracts';
import { useLivePrices } from 'src/hooks/useLivePrices';
import { useESG } from 'src/hooks/useESG';
import { usePriceHistory } from 'src/hooks/usePriceHistory';
import { useWhaleAlerts } from 'src/hooks/useWhaleAlerts';
import { useMode } from 'src/contexts/mode-context';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { ASSET_IDS } from 'src/contracts/addresses';
import { ASSET_META } from 'src/lib/pepefi/assetMeta';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import { Icon } from '@iconify/react';

// ── Constants ─────────────────────────────────────────────────────────────────

const PEPE_QUOTES = [
  '「不要問市場給了你什麼，要問你為市場帶來了什麼。」 — Pepe the Wise',
  '「槓桿是雙面刃，用好了飛天，用壞了入地。」 — OG Pepe',
  '「每天簽到，財富自然到。」 — Lucky Pepe',
  '「鏈上透明，永不說謊。」 — On-chain Pepe',
  '「止損是交易者最好的朋友。」 — Profitable Pepe',
  '「跟單之前，先搞清楚自己跟的是誰。」 — Alpha Pepe',
  '「ESG 高分代表責任感，長期看好。」 — Green Pepe',
  '「Copy trading 不是投機，是有策略的信任。」 — Social Pepe',
];

const PEPE_AVATARS = [
  '/avatars/pepe-01.png',
  '/assets/images/pepefi/pepe_eth.jpg',
  '/avatars/pepe-01.png',
];

const TREND_ASSET_IDS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sAAPL,
];

const TREND_COLORS: Record<string, string> = {
  [ASSET_IDS.sBTC]:  '#f7931a',
  [ASSET_IDS.sETH]:  '#627eea',
  [ASSET_IDS.sGOLD]: '#ffd700',
  [ASSET_IDS.sAAPL]: '#a2aaad',
};

// ── Display category: 'etf' merged into commodity ────────────────────────────

type DisplayCat = 'crypto' | 'equity' | 'commodity' | 'bond';
const DISPLAY_CATS: DisplayCat[] = ['crypto', 'equity', 'commodity', 'bond'];

const displayCatOf = (assetId: string): DisplayCat => {
  const cat = ASSET_META[assetId]?.category;
  if (cat === 'equity') return 'equity';
  if (cat === 'bond')   return 'bond';
  if (cat === 'commodity' || cat === 'etf') return 'commodity';
  return 'crypto';
};

const CAT_CONFIG: Record<DisplayCat, {
  label: string; icon: string; color: string;
  bg: string; borderColor: string;
}> = {
  crypto:    { label: 'Crypto',          icon: '₿', color: '#6366f1', bg: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.02) 100%)', borderColor: 'rgba(99, 102, 241, 0.2)' },
  equity:    { label: 'Equity',          icon: '◈', color: '#a855f7', bg: 'linear-gradient(135deg, rgba(168, 85, 247, 0.15) 0%, rgba(168, 85, 247, 0.02) 100%)', borderColor: 'rgba(168, 85, 247, 0.2)' },
  commodity: { label: 'Commodity & ETF', icon: '◆', color: '#f59e0b', bg: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15) 0%, rgba(245, 158, 11, 0.02) 100%)', borderColor: 'rgba(245, 158, 11, 0.2)' },
  bond:      { label: 'Bond',            icon: '◉', color: '#10b981', bg: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(16, 185, 129, 0.02) 100%)', borderColor: 'rgba(16, 185, 129, 0.2)' },
};

const PIE_COLORS = DISPLAY_CATS.map(c => CAT_CONFIG[c].color);

// ── Types ─────────────────────────────────────────────────────────────────────

interface PosRow {
  id:            bigint;
  asset:         string;
  isLong:        boolean;
  entryPrice:    bigint;   // 18-dec
  margin:        bigint;   // 18-dec USDC
  leverage:      bigint;
  unrealizedPnL: bigint;   // signed int256 as bigint, 18-dec
  oraclePrice18: bigint;   // oracle current price converted to 18-dec
}

interface DerivedRow extends PosRow {
  notional:      bigint;   // margin × leverage, 18-dec
  quantity:      bigint;   // notional × 1e18 / entryPrice, 18-dec asset units
  currentPrice18: bigint;  // live or oracle, 18-dec
  holdingsValue: bigint;   // quantity × currentPrice18 / 1e18, 18-dec USDC
  livePnL:       bigint;   // (currentPrice - entryPrice) × quantity / 1e18 × dir, 18-dec
}

function deriveRow(pos: PosRow, livePrices: Record<string, LivePrice>): DerivedRow {
  const notional = pos.margin * pos.leverage;
  const quantity = pos.entryPrice > 0n
    ? (notional * 10n ** 18n) / pos.entryPrice
    : 0n;

  const liveUsd = livePrices[pos.asset]?.usd;
  const currentPrice18 = liveUsd
    ? BigInt(Math.round(liveUsd * 1e8)) * 10n ** 10n
    : pos.oraclePrice18;

  if (currentPrice18 === 0n) {
    return { ...pos, notional, quantity, currentPrice18: 0n, holdingsValue: 0n, livePnL: 0n };
  }

  const holdingsValue = (quantity * currentPrice18) / 10n ** 18n;

  const priceDiff = currentPrice18 - pos.entryPrice;
  const livePnL = pos.isLong
    ? (priceDiff * quantity) / 10n ** 18n
    : (-priceDiff * quantity) / 10n ** 18n;

  return { ...pos, notional, quantity, currentPrice18, holdingsValue, livePnL };
}

// ── Formatters ────────────────────────────────────────────────────────────────

const fUsd = (v: bigint | number | null | undefined) => {
  if (v === null || v === undefined) return '$0.00';
  try {
    const val = typeof v === 'bigint' ? Number(v) / 1e18 : Number(v);
    if (isNaN(val)) return '$0.00';
    return '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return '$0.00';
  }
};

const f18 = (v: bigint | null | undefined, d = 0) => {
  if (v === null || v === undefined) return '0';
  try {
    const val = Number(v / 10n ** 18n);
    if (isNaN(val)) return '0';
    return val.toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  } catch {
    return '0';
  }
};

const fUsdFloat = (v: number) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fPnL = (v: bigint) => {
  const n = Number(v) / 1e18;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
};

const fPct = (pnl: bigint, notional: bigint): string => {
  if (notional === 0n) return '0.00%';
  const pct = (Number(pnl) / Number(notional)) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
};

const fQty = (qty: bigint, assetId: string): string => {
  const n = Number(qty) / 1e18;
  const cat = ASSET_META[assetId]?.category;
  if (cat === 'crypto') return n.toPrecision(4);
  return n.toFixed(2);
};

const pnlColor = (v: bigint) => Number(v) >= 0 ? 'success.main' : 'error.main';

const fNotional = (n: bigint) => {
  const v = Number(n) / 1e18;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
};

const timeAgo = (ts: number): string => {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 120)   return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const ESG_TIER = (score: number): { name: string; color: string } => {
  if (score >= 80) return { name: 'ESG Champion',           color: '#00b8d9' };
  if (score >= 60) return { name: 'ESG Aware',              color: '#22c55e' };
  return                  { name: 'Consider greener assets', color: '#ffab00' };
};

const ESG_COMMENT = (score: number): string => {
  if (score >= 80) return '投資組合符合高標準 ESG 準則，表現優異 🌱';
  if (score >= 65) return '投資組合 ESG 表現良好，仍有進一步優化空間';
  if (score >= 50) return '部分持倉 ESG 評級偏低，建議調整資產配置';
  return '投資組合 ESG 風險較高，請考慮改善整體配置';
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { mode } = useMode();
  const wallet = usePepefiWallet();
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const { alerts: whaleAlerts } = useWhaleAlerts(contracts?.exchange ?? null, wallet.provider);
  const livePrices = useLivePrices();
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);
  const { history: priceHistory } = usePriceHistory(
    contracts?.oracle ?? null,
    wallet.provider,
    TREND_ASSET_IDS,
    livePrices
  );
 
  const [positions,  setPositions]  = useState<PosRow[]>([]);
  const [freeMargin, setFreeMargin] = useState<bigint>(0n);
  const [isLoading,  setIsLoading]  = useState(false);
  const [isLoaded,   setIsLoaded]   = useState(false);
 
  const [stakedUSDC, setStakedUSDC] = useState<bigint | null>(null);
  const [walletUSDC, setWalletUSDC] = useState<bigint | null>(null);
  const [vaultUSDC,  setVaultUSDC]  = useState<bigint | null>(null);
 
  // ── PEPE token state ──────────────────────────────────────────────────────
  const [pepeBal,      setPepeBal]      = useState<bigint | null>(null);
  const [pepeClaimed,  setPepeClaimed]  = useState<boolean | null>(null);
  const [pepeAmount,   setPepeAmount]   = useState<bigint>(1000n * 10n ** 18n);
  const [pepeKyc,      setPepeKyc]      = useState(false);
  const [pepePoolBal,  setPepePoolBal]  = useState<bigint | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimError,   setClaimError]   = useState<string | null>(null);
 
  const [enabled, setEnabled] = useState<Set<string>>(new Set(TREND_ASSET_IDS));
 
  // ── Daily check-in banner ─────────────────────────────────────────────────
  const [checkedInToday, setCheckedInToday] = useState<boolean | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const toggleAsset = (id: string) =>
    setEnabled(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
 
  // ── Fetch ─────────────────────────────────────────────────────────────────
 
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    setIsLoading(true);
    try {
      const [posIds, fmRaw, walletUsdcRaw, stakedUsdcRaw] = await Promise.all([
        contracts.exchange.getUserPositions(wallet.address),
        contracts.exchange.freeMargin(wallet.address),
        contracts.usdc.balanceOf(wallet.address),
        contracts.traderStake.getStake(wallet.address),
      ]);
      setFreeMargin(fmRaw as bigint);
      setWalletUSDC(walletUsdcRaw as bigint);

      let stakedAmt = 0n;
      if (stakedUsdcRaw) {
        if (typeof stakedUsdcRaw === 'bigint') {
          stakedAmt = stakedUsdcRaw;
        } else if (typeof stakedUsdcRaw === 'object') {
          const raw = stakedUsdcRaw as any;
          if ('amount' in raw) {
            stakedAmt = BigInt(raw.amount);
          } else if (Array.isArray(raw) && raw.length > 0) {
            stakedAmt = BigInt(raw[0]);
          } else if (raw[0] !== undefined) {
            stakedAmt = BigInt(raw[0]);
          }
        }
      }
      setStakedUSDC(stakedAmt);
 
      let vaultUsdcVal = 0n;
      if (contracts.insuranceVault) {
        try {
          const [myShares, totalAssets, totalSupply] = await Promise.all([
            contracts.insuranceVault.balanceOf(wallet.address),
            contracts.insuranceVault.totalAssets(),
            contracts.insuranceVault.totalSupply(),
          ]);
          if (BigInt(totalSupply) > 0n) {
            vaultUsdcVal = (BigInt(myShares) * BigInt(totalAssets)) / BigInt(totalSupply);
          }
        } catch (e) {
          console.warn('Failed to fetch insurance vault balance:', e);
        }
      }
      setVaultUSDC(vaultUsdcVal);
 
      const rows = await Promise.all(
        (posIds as bigint[]).map(async (id): Promise<PosRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as {
              asset: string; isLong: boolean; isOpen: boolean;
              entryPrice: bigint; margin: bigint; leverage: bigint;
            };
            if (!raw.isOpen) return null;
            const [pnlRaw, priceRaw] = await Promise.all([
              contracts.exchange.getUnrealizedPnL(id),
              contracts.oracle.getPrice(raw.asset),
            ]);
            const price8 = (priceRaw as [bigint, bigint])[0];
            return {
              id, asset: raw.asset, isLong: raw.isLong,
              entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
              unrealizedPnL: pnlRaw as bigint,
              oraclePrice18: price8 * 10n ** 10n,
            };
          } catch { return null; }
        })
      );
      setPositions(rows.filter((r): r is PosRow => r !== null));
      setIsLoaded(true);
    } catch (e) {
      console.error('[dashboard fetch]', e);
      setIsLoaded(true);
    } finally { setIsLoading(false); }
  }, [contracts, wallet.address]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

  // ── PEPE fetch (isolated — failures never affect main dashboard) ───────────
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

  const fetchPepe = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    if (String(contracts.pepeToken.target).toLowerCase() === ZERO_ADDR) return;
    if (String(contracts.pepeClaim.target).toLowerCase()  === ZERO_ADDR) return;
    const [balR, claimedR, amountR, kycR, poolR] = await Promise.allSettled([
      contracts.pepeToken.balanceOf(wallet.address),
      contracts.pepeClaim.claimed(wallet.address),
      contracts.pepeClaim.claimAmount(),
      contracts.kycRegistry.isVerified(wallet.address),
      contracts.pepeToken.balanceOf(contracts.pepeClaim.target),
    ]);
    if (balR.status     === 'fulfilled') setPepeBal(balR.value as bigint);
    if (claimedR.status === 'fulfilled') setPepeClaimed(claimedR.value as boolean);
    if (amountR.status  === 'fulfilled') setPepeAmount(amountR.value as bigint);
    if (kycR.status     === 'fulfilled') setPepeKyc(Boolean(kycR.value));
    else setPepeKyc(true);
    if (poolR.status    === 'fulfilled') setPepePoolBal(poolR.value as bigint);
  }, [contracts, wallet.address]);

  useEffect(() => { void fetchPepe() }, [fetchPepe]);

  useEffect(() => {
    if (!contracts?.pepeIncentives || !wallet.address) return;
    const ZERO = '0x0000000000000000000000000000000000000000';
    if (String((contracts.pepeIncentives as any).target).toLowerCase() === ZERO) return;
    contracts.pepeIncentives.lastCheckIn(wallet.address)
      .then((lastDay: unknown) => {
        const todayIdx = Math.floor(Date.now() / 1000 / 86400);
        setCheckedInToday(Number(lastDay) >= todayIdx);
      })
      .catch(() => setCheckedInToday(null));
  }, [contracts, wallet.address]);

  const doClaimPepe = useCallback(async () => {
    if (!contracts) return;
    setClaimLoading(true);
    setClaimError(null);
    try {
      const tx = await contracts.pepeClaim.claim();
      await (tx as { wait: () => Promise<unknown> }).wait();
      await fetchPepe();
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const match = raw.match(/revert[^"]*"([^"]+)"/) ?? raw.match(/"([^"]+)"/);
      setClaimError(match ? match[1] : raw.slice(0, 100));
    } finally {
      setClaimLoading(false);
    }
  }, [contracts, fetchPepe]);

  const addPepeToWallet = async () => {
    if (!(window as any).ethereum) return;
    try {
      await (window as any).ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address:  '0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9',
            symbol:   'PEPE',
            decimals: 18,
          },
        },
      });
    } catch (e) { console.error('Add PEPE to wallet failed', e); }
  };

  // ── Derived: live-updated from livePrices tick ────────────────────────────

  const derived = useMemo(() => {
    const rows = positions.map(p => deriveRow(p, livePrices));
    const totalHoldings = rows.reduce((s, r) => s + r.holdingsValue, 0n);
    const totalPnL      = rows.reduce((s, r) => s + r.livePnL,      0n);
    const totalMargin   = rows.reduce((s, r) => s + r.margin,        0n);
    const totalNotional = rows.reduce((s, r) => s + r.notional,      0n);
    return { rows, totalHoldings, totalPnL, totalMargin, totalNotional };
  }, [positions, livePrices]);

  // ── Category breakdown ────────────────────────────────────────────────────

  const catSummary = useMemo(() => {
    const out: Record<DisplayCat, { value: bigint; pnl: bigint; symbols: string[] }> = {
      crypto:    { value: 0n, pnl: 0n, symbols: [] },
      equity:    { value: 0n, pnl: 0n, symbols: [] },
      commodity: { value: 0n, pnl: 0n, symbols: [] },
      bond:      { value: 0n, pnl: 0n, symbols: [] },
    };
    for (const row of derived.rows) {
      const dcat = displayCatOf(row.asset);
      out[dcat].value += row.holdingsValue;
      out[dcat].pnl   += row.livePnL;
      const sym = ASSET_META[row.asset]?.symbol ?? '?';
      if (!out[dcat].symbols.includes(sym)) out[dcat].symbols.push(sym);
    }
    return out;
  }, [derived.rows]);

  // ── Pie data ──────────────────────────────────────────────────────────────

  const pieData = useMemo(
    () =>
      DISPLAY_CATS
        .filter(c => catSummary[c].value > 0n)
        .map(c => ({
          name:    CAT_CONFIG[c].label,
          value:   Number(catSummary[c].value) / 1e18,
          dcat:    c,
        })),
    [catSummary]
  );

  // ── ESG composite ─────────────────────────────────────────────────────────

  const portfolioESG = useMemo(() => {
    if (derived.rows.length === 0) return null;
    let totalVal = 0; let wavg = 0;
    for (const row of derived.rows) {
      const info = esg[row.asset];
      if (!info) return null;
      const val = Number(row.holdingsValue) / 1e18;
      totalVal += val;
      wavg     += info.composite * val;
    }
    if (totalVal === 0) return null;
    const composite = Math.round(wavg / totalVal);
    const rating =
      composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' :
      composite >= 60 ? 'A'   : composite >= 50 ? 'BBB' : 'CCC';
    return { composite, rating };
  }, [derived.rows, esg]);

  // ── Trend chart data ──────────────────────────────────────────────────────

  const chartData = useMemo(() => {
    const allTimes = Array.from(
      new Set(TREND_ASSET_IDS.flatMap(id => (priceHistory[id] ?? []).map(p => p.time)))
    ).sort((a, b) => a - b);
    if (allTimes.length === 0) return [];
    const basePrice: Record<string, number> = {};
    for (const id of TREND_ASSET_IDS) {
      const pts = priceHistory[id];
      if (pts && pts.length > 0) basePrice[id] = pts[0].price;
    }
    return allTimes.map(t => {
      const row: Record<string, number | string> = {
        time: new Date(t * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
      };
      for (const id of TREND_ASSET_IDS) {
        const pts = priceHistory[id];
        if (!pts || !basePrice[id]) continue;
        const pt = pts.filter(p => p.time <= t).at(-1);
        if (pt) row[id] = +((pt.price / basePrice[id] - 1) * 100).toFixed(3);
      }
      return row;
    });
  }, [priceHistory]);

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to view your dashboard.</Typography>
      </Box>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const pnlPctStr = derived.totalNotional > 0n
    ? fPct(derived.totalPnL, derived.totalNotional) : '—';

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>

      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            Portfolio Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            持倉現值 · 四類收益 · 配置佔比 · ESG 評分 · 趨勢走勢
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={() => void fetchAll()}
          disabled={isLoading}
          startIcon={<Icon icon="solar:restart-bold-duotone" width={16} />}
          sx={{ borderColor: 'divider' }}
        >
          Refresh
        </Button>
      </Box>

      {/* ── Simple mode: big live-price cards ── */}
      {mode === 'simple' && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, fontWeight: 700 }}>
            📊 即時價格
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 2 }}>
            {Object.entries(livePrices).slice(0, 6).map(([id, lp]) => {
              const meta = ASSET_META[id];
              if (!meta) return null;
              const up = !lp.isMock;
              return (
                <Card key={id} sx={{
                  p: 2, textAlign: 'center',
                  bgcolor: '#0e1420',
                  border: `1px solid ${up ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius: 2,
                }}>
                  <Typography fontSize={40} sx={{ display: 'block', mb: 0.5 }}>
                    {meta.category === 'crypto' ? '🪙' : meta.category === 'equity' ? '📊' : meta.category === 'bond' ? '📜' : '🏅'}
                  </Typography>
                  <Typography fontWeight={800} fontSize={14}>{meta.symbol}</Typography>
                  <Typography fontWeight={700} fontSize={15} sx={{ color: '#7cc14a', fontFamily: 'monospace' }}>
                    ${lp.usd >= 1 ? lp.usd.toLocaleString(undefined, { maximumFractionDigits: 2 }) : lp.usd.toFixed(4)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: lp.isMock ? 'text.disabled' : 'success.main', fontWeight: 700 }}>
                    {lp.isMock ? '模擬價格' : '● 即時'}
                  </Typography>
                </Card>
              );
            })}
          </Box>
        </Box>
      )}

      {/* ── Asset Overview & Wealth Navigator ── */}
      <Card sx={{
        p: 3,
        background: 'linear-gradient(135deg, rgba(124,193,74,0.12) 0%, rgba(11,22,37,0.8) 100%)',
        border: '1px solid rgba(124,193,74,0.35)',
        borderRadius: 2.5,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        {/* Aggregated Net Worth Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 3.5 }}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontWeight: 'bold', letterSpacing: 1 }}>
              💼 總資產估值 (TOTAL USDC NET WORTH)
            </Typography>
            <Typography variant="h3" sx={{ fontWeight: '900', color: '#7cc14a', fontFamily: 'monospace' }}>
              {fUsd((walletUSDC ?? 0n) + (stakedUSDC ?? 0n) + derived.totalMargin + freeMargin + (vaultUSDC ?? 0n))}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', p: 2, borderRadius: 2 }}>
            <Box sx={{ fontSize: 32 }}>🐸</Box>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>MemeFi 代幣儲備</Typography>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#ffd700', fontFamily: 'monospace' }}>
                {pepeBal !== null ? f18(pepeBal, 0) : '0'} PEPE
              </Typography>
            </Box>
          </Box>
        </Box>
 
        {/* Flow Map Visual Navigator */}
        <Box sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1.5,
          mb: 3.5,
          p: 2,
          bgcolor: 'rgba(0, 0, 0, 0.25)',
          borderRadius: 1.5,
          border: '1px dashed rgba(124, 193, 74, 0.25)'
        }}>
          <Typography variant="subtitle2" sx={{ color: '#a8d96a', display: 'flex', alignItems: 'center', gap: 1, fontWeight: 'bold' }}>
            <Icon icon="solar:map-arrow-square-bold-duotone" width={18} />
            財產分流導航地圖 (Asset Flow Map):
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
            <Chip label="👛 Web3 錢包" size="small" variant="outlined" sx={{ borderColor: 'rgba(255,255,255,0.2)', color: '#fff', fontWeight: 'bold' }} />
            <span style={{ color: 'rgba(255,255,255,0.2)' }}>──►</span>
            <Chip label="💰 錢包可用現金" size="small" sx={{ bgcolor: 'rgba(255,255,255,0.06)', color: 'text.secondary', fontWeight: 'bold' }} />
            <span style={{ color: 'rgba(255,255,255,0.2)' }}>──分流至──►</span>
            <Chip label="📈 槓桿合約帳戶" size="small" sx={{ bgcolor: 'rgba(99,102,241,0.12)', color: '#a5b4fc', fontWeight: 'bold' }} />
            <span style={{ color: 'rgba(255,255,255,0.2)' }}>＋</span>
            <Chip label="🛡️ DeFi 質押倉位" size="small" sx={{ bgcolor: 'rgba(16,185,129,0.12)', color: '#a7f3d0', fontWeight: 'bold' }} />
            <span style={{ color: 'rgba(255,255,255,0.2)' }}>＋</span>
            <Chip label="🏦 LP 做市保險池" size="small" sx={{ bgcolor: 'rgba(245,158,11,0.12)', color: '#fcd34d', fontWeight: 'bold' }} />
          </Box>
        </Box>
 
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 3.5 }} />
 
        {/* Segmented Wealth Cards */}
        <Grid container spacing={3.5}>
          {/* 1. Wallet Available cash */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Card sx={{
              p: 2.5,
              bgcolor: 'rgba(255,255,255,0.01)',
              border: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              justifyContent: 'space-between'
            }}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
                  💰 錢包可用現金 (Cash)
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1.5, fontFamily: 'monospace', color: 'text.primary' }}>
                  {walletUSDC !== null ? fUsd(walletUSDC) : '$0.00'}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, minHeight: 48 }}>
                  存放在您 Web3 錢包中的可用 USDC 測試幣。這是您所有鏈上操作與後備儲蓄的起點。
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 2.5 }}>
                <Button
                  component={RouterLink}
                  to="/exchange"
                  size="small"
                  variant="outlined"
                  sx={{
                    flex: 1,
                    borderColor: 'rgba(255,255,255,0.08)',
                    color: 'text.secondary',
                    textTransform: 'none',
                    fontWeight: 'bold',
                    '&:hover': { borderColor: 'primary.main', bgcolor: 'rgba(0,167,111,0.04)', color: '#fff' }
                  }}
                >
                  去領水與入金 ↗
                </Button>
                <Button
                  component={RouterLink}
                  to="/history"
                  size="small"
                  variant="text"
                  sx={{
                    color: 'text.secondary',
                    textTransform: 'none',
                    '&:hover': { color: 'text.primary' }
                  }}
                >
                  資產歷史 ↗
                </Button>
              </Stack>
            </Card>
          </Grid>
 
          {/* 2. Perpetual Margined account */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Card sx={{
              p: 2.5,
              bgcolor: 'rgba(99,102,241,0.03)',
              border: '1px solid rgba(99,102,241,0.15)',
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              justifyContent: 'space-between',
              transition: 'all 0.2s',
              '&:hover': { borderColor: 'rgba(99,102,241,0.3)', boxShadow: '0 8px 24px rgba(99,102,241,0.08)' }
            }}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: '#818cf8' }}>
                  📈 槓桿合約帳戶 (Trading)
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1.5, fontFamily: 'monospace', color: '#a5b4fc' }}>
                  {fUsd(derived.totalMargin + freeMargin)}
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 1, minHeight: 48 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>已鎖定倉位保證金:</span>
                    <span style={{ color: 'text.primary', fontFamily: 'monospace' }}>{fUsd(derived.totalMargin)}</span>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>帳戶可用自由餘額:</span>
                    <span style={{ color: 'text.primary', fontFamily: 'monospace' }}>{fUsd(freeMargin)}</span>
                  </Typography>
                </Stack>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 2.5 }}>
                <Button
                  component={RouterLink}
                  to="/exchange"
                  size="small"
                  variant="contained"
                  sx={{
                    flex: 1,
                    bgcolor: '#6366f1',
                    color: '#fff',
                    fontWeight: 'bold',
                    textTransform: 'none',
                    '&:hover': { bgcolor: '#4f46e5' }
                  }}
                >
                  自主交易 ↗
                </Button>
                <Button
                  component={RouterLink}
                  to="/portfolio"
                  size="small"
                  variant="outlined"
                  sx={{
                    borderColor: 'rgba(99,102,241,0.3)',
                    color: '#a5b4fc',
                    textTransform: 'none',
                    fontWeight: 'bold',
                    '&:hover': { borderColor: '#6366f1', bgcolor: 'rgba(99,102,241,0.08)' }
                  }}
                >
                  跟單保證金 ↗
                </Button>
              </Stack>
            </Card>
          </Grid>
 
          {/* 3. DeFi Staking Position */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Card sx={{
              p: 2.5,
              bgcolor: 'rgba(16,185,129,0.03)',
              border: '1px solid rgba(16,185,129,0.15)',
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              justifyContent: 'space-between',
              transition: 'all 0.2s',
              '&:hover': { borderColor: 'rgba(16,185,129,0.3)', boxShadow: '0 8px 24px rgba(16,185,129,0.08)' }
            }}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: '#34d399' }}>
                  🛡️ DeFi 質押倉位 (Staked)
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1.5, fontFamily: 'monospace', color: '#a7f3d0' }}>
                  {stakedUSDC !== null ? fUsd(stakedUSDC) : '$0.00'}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, minHeight: 48 }}>
                  質押在 TraderStake 治理合約中的資本。用於提升交易聲譽、並解鎖發布跟單策略的權限。
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 2.5 }}>
                <Button
                  component={RouterLink}
                  to="/stake"
                  size="small"
                  variant="contained"
                  sx={{
                    flex: 1,
                    bgcolor: '#10b981',
                    color: '#fff',
                    fontWeight: 'bold',
                    textTransform: 'none',
                    '&:hover': { bgcolor: '#059669' }
                  }}
                >
                  管理質押 ↗
                </Button>
                <Button
                  component={RouterLink}
                  to="/marketplace"
                  size="small"
                  variant="outlined"
                  sx={{
                    borderColor: 'rgba(16,185,129,0.3)',
                    color: '#a7f3d0',
                    textTransform: 'none',
                    fontWeight: 'bold',
                    '&:hover': { borderColor: '#10b981', bgcolor: 'rgba(16,185,129,0.08)' }
                  }}
                >
                  發布策略 ↗
                </Button>
              </Stack>
            </Card>
          </Grid>
 
          {/* 4. LP Insurance Vault Position */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Card sx={{
              p: 2.5,
              bgcolor: 'rgba(245,158,11,0.03)',
              border: '1px solid rgba(245,158,11,0.15)',
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              justifyContent: 'space-between',
              transition: 'all 0.2s',
              '&:hover': { borderColor: 'rgba(245,158,11,0.3)', boxShadow: '0 8px 24px rgba(245,158,11,0.08)' }
            }}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: '#f59e0b' }}>
                  🏦 LP 保險資金池 (LP Vault)
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1.5, fontFamily: 'monospace', color: '#fcd34d' }}>
                  {vaultUSDC !== null ? fUsd(vaultUSDC) : '$0.00'}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, minHeight: 48 }}>
                  提供做市資金給流動性保險資金池。會自動賺取全平台高達 10% 的交易與結算手續費。
                </Typography>
              </Box>
              <Button
                component={RouterLink}
                to="/vault"
                size="small"
                variant="contained"
                sx={{
                  mt: 2.5,
                  width: '100%',
                  bgcolor: '#f59e0b',
                  color: '#fff',
                  fontWeight: 'bold',
                  textTransform: 'none',
                  '&:hover': { bgcolor: '#d97706' }
                }}
              >
                管理做市資金 LP ↗
              </Button>
            </Card>
          </Grid>
        </Grid>
      </Card>

      {/* ── Daily check-in banner ─────────────────────────────────────────────── */}
      {!bannerDismissed && checkedInToday === false && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            px: 3,
            py: 1.5,
            borderRadius: 2,
            background: 'linear-gradient(90deg, rgba(124,193,74,0.15) 0%, rgba(255,210,61,0.12) 100%)',
            border: '1px solid rgba(124,193,74,0.35)',
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#a8d96a' }}>
            🐸 你今天還沒簽到！每日簽到可得 +50 PEPE，連續簽到最多 +110 PEPE
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <Button
              component={RouterLink}
              to="/rewards"
              size="small"
              variant="contained"
              sx={{
                bgcolor: '#7cc14a',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '0.8rem',
                py: 0.5,
                px: 2,
                '&:hover': { bgcolor: '#5a9e2f' },
              }}
            >
              去簽到
            </Button>
            <IconButton size="small" onClick={() => setBannerDismissed(true)} sx={{ color: 'text.secondary', p: 0.5 }}>
              <Icon icon="mingcute:close-line" width={16} />
            </IconButton>
          </Box>
        </Box>
      )}

      {/* ── A. 頂部總覽 ───────────────────────────────────────────────────────── */}
      <Grid container spacing={2}>
        {[
          {
            label: '總資產現值',
            value: isLoaded ? fUsd(derived.totalHoldings) : '—',
            sub:   '所有持倉 notional 現值',
            color: 'text.primary',
          },
          {
            label: '未實現損益',
            value: isLoaded ? `${fPnL(derived.totalPnL)} USDC` : '—',
            sub:   pnlPctStr,
            color: isLoaded ? pnlColor(derived.totalPnL) : 'text.primary',
          },
          {
            label: '可用餘額',
            value: isLoaded ? fUsd(freeMargin) : '—',
            sub:   'Free Margin',
            color: 'text.primary',
          },
          {
            label: 'ESG 評分',
            value: portfolioESG ? `${portfolioESG.composite}` : '—',
            sub:   portfolioESG ? ESG_TIER(portfolioESG.composite).name : 'no positions',
            color: portfolioESG ? ESG_TIER(portfolioESG.composite).color : 'text.secondary',
          },
        ].map(({ label, value, sub, color }) => (
          <Grid size={{ xs: 12, sm: 6, md: 3 }} key={label}>
            <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 0.5, height: '100%' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                {label}
              </Typography>
              {isLoading ? (
                <Skeleton width={100} height={28} />
              ) : (
                <Typography variant="h5" sx={{ color, fontWeight: 'bold', fontFamily: 'monospace' }}>
                  {value}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {sub}
              </Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* ── B. 四類資產收益卡 ──────────────────────────────────────────── */}
      <Box>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 2, fontWeight: 'bold', letterSpacing: 1.5 }}>
          四類資產收益
        </Typography>
        <Grid container spacing={2}>
          {DISPLAY_CATS.map(cat => {
            const cfg = CAT_CONFIG[cat];
            const s   = catSummary[cat];
            const cnt = s.symbols.length;
            return (
              <Grid size={{ xs: 12, sm: 6 }} key={cat}>
                <Card
                  sx={{
                    p: 3,
                    background: cfg.bg,
                    borderColor: cfg.borderColor,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    height: '100%',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="h6" sx={{ fontSize: '1.25rem', lineHeight: 1 }}>{cfg.icon}</Typography>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'text.primary' }}>{cfg.label}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                      {cnt} asset{cnt !== 1 ? 's' : ''}
                    </Typography>
                  </Box>

                  {isLoading ? (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Skeleton width={120} height={24} />
                      <Skeleton width={80} height={16} />
                    </Box>
                  ) : cnt === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', py: 1 }}>
                      No positions
                    </Typography>
                  ) : (
                    <>
                      <Box>
                        <Typography variant="h5" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}>
                          {fUsd(s.value)}
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 'bold', color: pnlColor(s.pnl), fontFamily: 'monospace', mt: 0.5 }}>
                          {fPnL(s.pnl)} USDC
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {s.symbols.map(sym => (
                          <Chip
                            key={sym}
                            label={sym}
                            size="small"
                            sx={{
                              borderColor: `${cfg.color}60`,
                              color: cfg.color,
                              bgcolor: `${cfg.color}15`,
                              fontWeight: 'bold',
                              fontSize: '0.6875rem',
                            }}
                          />
                        ))}
                      </Box>
                    </>
                  )}
                </Card>
              </Grid>
            );
          })}
        </Grid>
      </Box>

      {/* ── Whale Activity ────────────────────────────────────────────────────── */}
      {whaleAlerts.length > 0 && (
        <Card sx={{ p: 3, border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)', bgcolor: 'rgba(0, 184, 217, 0.02)' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'info.main', fontWeight: 'bold' }}>
              🐋 Whale Activity
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'normal' }}>
                (≥ $5k notional)
              </Typography>
            </Typography>
            <Link component={RouterLink} to="/whale" sx={{ fontSize: '0.75rem', color: 'info.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
              Open Whale Tracker →
            </Link>
          </Box>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ borderColor: 'divider' }}>
                  {['Address','Asset','Side','Notional','Time'].map(h => (
                    <TableCell key={h} sx={{ pb: 1, color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', textAlign: h === 'Notional' || h === 'Time' ? 'right' : 'left' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {whaleAlerts.slice(0, 8).map(a => (
                  <TableRow key={a.txHash} sx={{ '&:hover': { bgcolor: 'rgba(0, 184, 217, 0.05)' } }}>
                    <TableCell sx={{ py: 1 }}>
                      <Link component={RouterLink} to={`/whale?addr=${a.owner}`} sx={{ fontFamily: 'monospace', color: 'info.main', fontSize: '0.75rem', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                        {shortAddr(a.owner)}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ py: 1, fontSize: '0.75rem' }}>{a.assetLabel}</TableCell>
                    <TableCell sx={{ py: 1, fontSize: '0.75rem' }}>
                      <Typography component="span" sx={{ fontSize: '0.75rem', fontWeight: 'bold', color: a.isLong ? 'success.main' : 'error.main' }}>
                        {a.isLong ? 'LONG' : 'SHORT'} {String(a.leverage)}×
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ py: 1, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '0.75rem' }}>
                      {fNotional(a.notional)}
                    </TableCell>
                    <TableCell sx={{ py: 1, textAlign: 'right', color: 'text.secondary', fontSize: '0.75rem' }}>
                      {timeAgo(a.timestamp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {/* ── C. 資產配置圓餅圖 + E. ESG 組合評分 ─────────────────────────────── */}
      <Grid container spacing={2}>
        {/* C. Pie Chart */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 300 }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 3, fontWeight: 'bold', letterSpacing: 1 }}>
              資產配置佔比
            </Typography>
            {isLoading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}>
                <Skeleton width={180} height={180} variant="circular" />
              </Box>
            ) : pieData.length === 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, gap: 1 }}>
                <Typography sx={{ fontSize: '2rem', opacity: 0.3 }}>◕</Typography>
                <Typography variant="body2" color="text.secondary">開倉後顯示配置佔比</Typography>
              </Box>
            ) : (
              <Box sx={{ flexGrow: 1, width: '100%', height: 220 }}>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={pieData} dataKey="value" nameKey="name"
                      cx="50%" cy="50%" outerRadius={70} innerRadius={35} paddingAngle={3}
                    >
                      {pieData.map(entry => (
                        <Cell key={entry.dcat} fill={PIE_COLORS[DISPLAY_CATS.indexOf(entry.dcat as DisplayCat)]} />
                      ))}
                    </Pie>
                    <PieTooltip
                      contentStyle={{ background: '#161c24', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12, color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(value: any) => [fUsdFloat(value as number), '']}
                    />
                    <Legend
                      iconType="circle" iconSize={8}
                      formatter={value => <span style={{ color: '#919eab', fontSize: 11, fontWeight: 500 }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Card>
        </Grid>

        {/* E. ESG composite */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: 'block', fontWeight: 'bold', letterSpacing: 1 }}>
              ESG 組合評分
            </Typography>

            {isLoading ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Skeleton width={150} height={40} />
                <Skeleton width="100%" height={16} />
                <Skeleton width="80%" height={16} />
              </Box>
            ) : !portfolioESG ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, gap: 1, py: 4 }}>
                <Typography sx={{ fontSize: '2.5rem', opacity: 0.3 }}>🌱</Typography>
                <Typography variant="body2" color="text.secondary">
                  {derived.rows.length === 0 ? '開倉後顯示 ESG 評分' : 'ESG 資料載入中…'}
                </Typography>
              </Box>
            ) : (
              <>
                <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 3 }}>
                  <Box>
                    <Typography variant="h2" sx={{ fontWeight: 800, lineHeight: 1, color: ESG_TIER(portfolioESG.composite).color }}>
                      {portfolioESG.composite}
                    </Typography>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mt: 1, color: ESG_TIER(portfolioESG.composite).color }}>
                      {ESG_TIER(portfolioESG.composite).name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      加權平均 ESG 評分
                    </Typography>
                  </Box>
                  <Box sx={{ pb: 0.5 }}>
                    <Chip
                      label={portfolioESG.rating}
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.875rem',
                        bgcolor: portfolioESG.composite >= 65 ? 'rgba(34,197,94,0.16)' : portfolioESG.composite >= 50 ? 'rgba(255,171,0,0.16)' : 'rgba(255,86,48,0.16)',
                        borderColor: portfolioESG.composite >= 65 ? 'rgba(34,197,94,0.24)' : portfolioESG.composite >= 50 ? 'rgba(255,171,0,0.24)' : 'rgba(255,86,48,0.24)',
                        color: portfolioESG.composite >= 65 ? '#22c55e' : portfolioESG.composite >= 50 ? '#ffab00' : '#ff5630',
                        border: '1px solid',
                      }}
                    />
                  </Box>
                </Box>

                <Box sx={{ width: '100%' }}>
                  <LinearProgress
                    variant="determinate"
                    value={portfolioESG.composite}
                    sx={{
                      height: 8,
                      borderRadius: 4,
                      bgcolor: 'background.neutral',
                      '& .MuiLinearProgress-bar': {
                        bgcolor: ESG_TIER(portfolioESG.composite).color,
                        borderRadius: 4,
                      },
                    }}
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">0</Typography>
                    <Typography variant="caption" color="text.secondary">50</Typography>
                    <Typography variant="caption" color="text.secondary">100</Typography>
                  </Box>
                </Box>

                <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                  {ESG_COMMENT(portfolioESG.composite)}
                </Typography>

                <Stack spacing={1.5} sx={{ pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                  {derived.rows.map(row => {
                    const info = esg[row.asset];
                    if (!info) return null;
                    const sym = ASSET_META[row.asset]?.symbol ?? '?';
                    return (
                      <Box key={`${row.asset}-${String(row.id)}`} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Typography variant="caption" sx={{ width: 60, fontFamily: 'monospace', fontWeight: 'bold' }}>
                          {sym}
                        </Typography>
                        <Box sx={{ flexGrow: 1 }}>
                          <LinearProgress
                            variant="determinate"
                            value={info.composite}
                            sx={{
                              height: 6,
                              borderRadius: 3,
                              bgcolor: 'background.neutral',
                              '& .MuiLinearProgress-bar': {
                                bgcolor: info.composite >= 65 ? 'success.main' : info.composite >= 50 ? 'warning.main' : 'error.main',
                                borderRadius: 3,
                              },
                            }}
                          />
                        </Box>
                        <Typography variant="caption" sx={{ width: 30, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold', color: 'text.secondary' }}>
                          {info.composite}
                        </Typography>
                        <Typography variant="caption" sx={{ width: 30, color: 'text.secondary', fontWeight: 'bold' }}>
                          {info.rating}
                        </Typography>
                      </Box>
                    );
                  })}
                </Stack>
              </>
            )}
          </Card>
        </Grid>
      </Grid>

      {/* ── D. 持倉明細表 ─────────────────────────────────────────────────────── */}
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            D · 持倉明細
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {derived.rows.length} open position{derived.rows.length !== 1 ? 's' : ''}
          </Typography>
        </Box>

        {isLoading ? (
          <Box sx={{ p: 3 }}>
            <TableSkeleton rows={3} cols={8} />
          </Box>
        ) : derived.rows.length === 0 ? (
          <Box sx={{ py: 8, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <Typography variant="h3" sx={{ opacity: 0.2 }}>◑</Typography>
            <Typography variant="body2" color="text.secondary">
              尚未開倉，前往{' '}
              <Link component={RouterLink} to="/exchange" sx={{ color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                Exchange
              </Link>{' '}
              開設第一個倉位
            </Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {(mode === 'simple'
                    ? ['資產','多/空','持倉現值','損益']
                    : ['資產','多/空','持有數量','平均成本','現價','持倉現值','損益','ESG']
                  ).map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: mode === 'simple' ? '0.875rem' : '0.75rem', py: 1.5, textAlign: h === '損益' || h === '持倉現值' ? 'right' : 'left' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {derived.rows.map(row => {
                  const meta = ASSET_META[row.asset];
                  const info = esg[row.asset];
                  const pnlPctRow = fPct(row.livePnL, row.notional);
                  return (
                    <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                      {/* 資產 */}
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                          <Typography variant="h6" sx={{ fontSize: '1.25rem', lineHeight: 1 }}>{meta?.icon ?? '?'}</Typography>
                          <Box>
                            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}>
                              {meta?.symbol ?? row.asset.slice(0, 8)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: '0.625rem', display: 'block', lineHeight: 1 }}>
                              {meta?.category}
                            </Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      {/* 多/空 */}
                      <TableCell>
                        <Chip
                          label={`${row.isLong ? 'LONG' : 'SHORT'} ${String(row.leverage)}×`}
                          size="small"
                          sx={{
                            fontWeight: 'bold',
                            fontSize: '0.75rem',
                            bgcolor: row.isLong ? 'rgba(34,197,94,0.12)' : 'rgba(255,86,48,0.12)',
                            color: row.isLong ? 'success.main' : 'error.main',
                            borderColor: row.isLong ? 'rgba(34,197,94,0.2)' : 'rgba(255,86,48,0.2)',
                            border: '1px solid',
                          }}
                        />
                      </TableCell>
                      {/* 持有數量 (expert only) */}
                      {mode === 'expert' && (
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {fQty(row.quantity, row.asset)}
                          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                            {meta?.symbol?.replace(/^s/, '') ?? ''}
                          </Typography>
                        </TableCell>
                      )}
                      {/* 平均成本 (expert only) */}
                      {mode === 'expert' && (
                        <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          {fUsdFloat(Number(row.entryPrice) / 1e18)}
                        </TableCell>
                      )}
                      {/* 現價 (expert only) */}
                      {mode === 'expert' && (
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {row.currentPrice18 === 0n ? (
                            <Typography color="text.secondary">—</Typography>
                          ) : (
                            <Box component="span">
                              {fUsdFloat(Number(row.currentPrice18) / 1e18)}
                              {livePrices[row.asset]?.isMock && (
                                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>~</Typography>
                              )}
                            </Box>
                          )}
                        </TableCell>
                      )}
                      {/* 持倉現值 */}
                      <TableCell sx={{ fontFamily: 'monospace', textAlign: 'right', fontWeight: 'bold' }}>
                        {fUsd(row.holdingsValue)}
                      </TableCell>
                      {/* 損益 */}
                      <TableCell sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
                        {row.currentPrice18 === 0n ? (
                          <Typography variant="caption" color="text.secondary">無報價</Typography>
                        ) : (
                          <Box>
                            <Typography sx={{ fontWeight: 'bold', color: pnlColor(row.livePnL), fontSize: '0.875rem' }}>
                              {fPnL(row.livePnL)}
                            </Typography>
                            <Typography variant="caption" sx={{ color: pnlColor(row.livePnL), opacity: 0.8, display: 'block', mt: -0.2 }}>
                              {pnlPctRow}
                            </Typography>
                          </Box>
                        )}
                      </TableCell>
                      {/* ESG Badge (expert only) */}
                      {mode === 'expert' && (
                        <TableCell>
                          {info ? (
                            <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                          ) : (
                            <Typography variant="caption" color="text.secondary">—</Typography>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
              {/* Footer: totals */}
              {derived.rows.length > 1 && (
                <tfoot style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    <TableCell colSpan={mode === 'simple' ? 2 : 5} sx={{ fontWeight: 'bold', color: 'text.primary' }}>Total</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', textAlign: 'right' }}>
                      {fUsd(derived.totalHoldings)}
                    </TableCell>
                    <TableCell sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
                      <Typography sx={{ fontWeight: 'bold', color: pnlColor(derived.totalPnL), fontSize: '0.875rem' }}>
                        {fPnL(derived.totalPnL)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: pnlColor(derived.totalPnL), opacity: 0.8, display: 'block', mt: -0.2 }}>
                        {pnlPctStr}
                      </Typography>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </tfoot>
              )}
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* ── F. 四資產趨勢圖 ───────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1 }}>
            四資產趨勢（% 變化）
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {TREND_ASSET_IDS.map(id => {
              const sym = ASSET_META[id]?.symbol ?? id.slice(0, 6);
              const isEnabled = enabled.has(id);
              return (
                <Button
                  key={id}
                  onClick={() => toggleAsset(id)}
                  size="small"
                  variant={isEnabled ? 'contained' : 'outlined'}
                  color="inherit"
                  startIcon={
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TREND_COLORS[id] }} />
                  }
                  sx={{
                    borderRadius: 50,
                    textTransform: 'none',
                    fontSize: '0.75rem',
                    py: 0.5,
                    px: 1.5,
                    borderColor: 'divider',
                    bgcolor: isEnabled ? `${TREND_COLORS[id]}18` : 'transparent',
                    color: isEnabled ? TREND_COLORS[id] : 'text.secondary',
                    '&:hover': {
                      bgcolor: isEnabled ? `${TREND_COLORS[id]}25` : 'action.hover',
                      borderColor: isEnabled ? TREND_COLORS[id] : 'text.secondary',
                    },
                  }}
                >
                  {sym}
                </Button>
              );
            })}
          </Box>
        </Box>

        {chartData.length < 2 ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, py: 6 }}>
            <Typography sx={{ fontSize: '2.5rem', opacity: 0.3 }}>📈</Typography>
            <Typography variant="body2" color="text.secondary">趨勢資料累積中…</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.8 }}>
              每次載入頁面記錄一個快照，幾分鐘後即可看到走勢
            </Typography>
          </Box>
        ) : (
          <Box sx={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={{ fill: '#637381', fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis
                  tick={{ fill: '#637381', fontSize: 10 }}
                  tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
                  width={48}
                />
                <LineTooltip
                  contentStyle={{ background: '#161c24', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11, color: '#fff' }}
                  labelStyle={{ color: '#919eab' }}
                  itemStyle={{ color: '#fff' }}
                  formatter={(value: any, name: any) => [
                    `${(value as number) >= 0 ? '+' : ''}${(value as number).toFixed(2)}%`,
                    ASSET_META[name as string]?.symbol ?? (name as string),
                  ]}
                />
                {TREND_ASSET_IDS.filter(id => enabled.has(id)).map(id => (
                  <Line
                    key={id} type="monotone" dataKey={id}
                    stroke={TREND_COLORS[id]} dot={false} strokeWidth={2} connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Card>

      {/* ── Pepe of the Day ──────────────────────────────────────────────────── */}
      {(() => {
        const dayIdx = Math.floor(Date.now() / 1000 / 86400);
        const avatar = PEPE_AVATARS[dayIdx % PEPE_AVATARS.length];
        const quote  = PEPE_QUOTES[dayIdx % PEPE_QUOTES.length];
        return (
          <Card sx={{
            p: 3,
            background: 'linear-gradient(135deg, rgba(124,193,74,0.06) 0%, rgba(255,210,61,0.04) 100%)',
            border: '1px solid rgba(124,193,74,0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexWrap: 'wrap',
          }}>
            <Box
              component="img"
              src={avatar}
              alt="Pepe of the Day"
              onError={(e) => { (e.target as HTMLImageElement).src = '/assets/images/pepefi/pepe_eth.jpg'; }}
              sx={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '3px solid #7cc14a',
                boxShadow: '0 0 16px rgba(124,193,74,0.4)',
                flexShrink: 0,
              }}
            />
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="overline" sx={{ color: '#7cc14a', fontWeight: 'bold', letterSpacing: 2, display: 'block', mb: 0.5 }}>
                🐸 Pepe of the Day
              </Typography>
              <Typography variant="body1" sx={{ color: 'text.primary', fontStyle: 'italic', lineHeight: 1.6 }}>
                {quote}
              </Typography>
            </Box>
            <Box sx={{ flexShrink: 0, textAlign: 'right' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                每日更新
              </Typography>
              <Button
                component={RouterLink}
                to="/rewards"
                size="small"
                variant="outlined"
                sx={{ borderColor: '#7cc14a', color: '#7cc14a', fontSize: '0.8rem', '&:hover': { bgcolor: 'rgba(124,193,74,0.08)' } }}
              >
                簽到領 PEPE 🎁
              </Button>
            </Box>
          </Card>
        );
      })()}

      {/* ── G. PEPE 平台幣 ──────────────────────────────────────────────────────── */}
      {(() => {
        const pepeReady = !!(contracts &&
          String(contracts.pepeToken.target).toLowerCase() !== ZERO_ADDR &&
          String(contracts.pepeClaim.target).toLowerCase() !== ZERO_ADDR);
        return (
          <Card
            sx={{
              p: 3,
              background: 'linear-gradient(135deg, rgba(0, 167, 111, 0.08), rgba(0, 167, 111, 0.01))',
              borderColor: 'rgba(0, 167, 111, 0.2)',
              borderWidth: 1,
              borderStyle: 'solid',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 'bold', display: 'block', letterSpacing: 1 }}>
                  G · PEPE 平台幣
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Pepe RWA Token · KYC 通過即可領取空投
                </Typography>
              </Box>
              {pepeReady && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Button
                    size="small"
                    variant="text"
                    color="info"
                    onClick={() => void addPepeToWallet()}
                    startIcon={<Icon icon="solar:wallet-bold-duotone" />}
                    sx={{ textTransform: 'none', fontSize: '0.75rem', fontWeight: 'bold' }}
                  >
                    加入錢包
                  </Button>
                  <IconButton size="small" onClick={() => void fetchPepe()} color="inherit">
                    <Icon icon="solar:restart-bold-duotone" width={16} />
                  </IconButton>
                </Box>
              )}
            </Box>

            {!pepeReady ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 1, fontStyle: 'italic' }}>
                PEPE 功能尚未啟用（合約尚未部署於此鏈）
              </Typography>
            ) : pepeBal === null ? (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                <Box>
                  <Typography variant="overline" color="text.secondary" display="block">PEPE 餘額</Typography>
                  <Skeleton width={120} height={32} />
                </Box>
                <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
                <Box>
                  <Typography variant="overline" color="text.secondary" display="block">空投領取</Typography>
                  <Skeleton width={160} height={40} />
                </Box>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                {/* Balance */}
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold', display: 'block' }}>
                    PEPE 餘額
                  </Typography>
                  <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.light', fontFamily: 'monospace', mt: 0.5 }}>
                    {(Number(pepeBal) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })}{' '}
                    <Typography component="span" variant="subtitle2" color="text.secondary">PEPE</Typography>
                  </Typography>
                </Box>

                {/* Divider */}
                <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' }, borderColor: 'rgba(0, 167, 111, 0.15)' }} />

                {/* Claim */}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                    空投領取
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    {pepeClaimed ? (
                      <Chip
                        label="✓ 已領取"
                        color="success"
                        variant="outlined"
                        sx={{ fontWeight: 'bold', px: 1, height: 38, borderRadius: 1 }}
                      />
                    ) : pepePoolBal !== null && pepePoolBal < pepeAmount ? (
                      <Button
                        disabled
                        variant="contained"
                        color="inherit"
                        sx={{ py: 1, px: 3, fontWeight: 'bold', borderRadius: 1 }}
                      >
                        獎池已空
                      </Button>
                    ) : (
                      <Button
                        variant="contained"
                        color="primary"
                        onClick={() => void doClaimPepe()}
                        disabled={claimLoading || !pepeKyc}
                        title={!pepeKyc ? '需先完成 KYC 才能領取' : undefined}
                        startIcon={claimLoading ? <Icon icon="line-md:loading-twotone-loop" /> : <span>🐸</span>}
                        sx={{
                          py: 1,
                          px: 3,
                          fontWeight: 'bold',
                          borderRadius: 1,
                          bgcolor: 'primary.main',
                          boxShadow: '0 8px 16px 0 rgba(0, 167, 111, 0.2)',
                          '&:hover': { bgcolor: 'primary.dark' },
                        }}
                      >
                        {claimLoading
                          ? '領取中…'
                          : `Claim ${(Number(pepeAmount) / 1e18).toLocaleString()} PEPE`
                        }
                      </Button>
                    )}

                    {!pepeKyc && !pepeClaimed && !(pepePoolBal !== null && pepePoolBal < pepeAmount) && (
                      <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 'bold' }}>
                        需先完成 KYC 才能領取
                      </Typography>
                    )}
                  </Box>
                  {claimError && (
                    <Typography variant="caption" color="error" sx={{ fontWeight: 'bold', mt: 0.5 }}>
                      {claimError}
                    </Typography>
                  )}
                </Box>
              </Box>
            )}
          </Card>
        );
      })()}

    </Container>
  );
}
