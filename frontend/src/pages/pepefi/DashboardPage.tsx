import { MONO } from 'src/components/pepefi/brandKit'
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
import { safeRead } from 'src/lib/pepefi/safeRead';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton';
import { PepeAvatar } from 'src/components/pepefi/PepeAvatar';
import { pepeNameFor } from 'src/lib/pepefi/pepeName';
import type { NetWorthParts } from 'src/lib/pepefi/portfolio';
import NetWorthHero from 'src/components/pepefi/dashboard/NetWorthHero';
import QuickActions from 'src/components/pepefi/dashboard/QuickActions';

/** 鏈上餘額的輪詢間隔。原本是 8 秒——見下方 useEffect 的說明。 */
const POLL_MS = 30_000;

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
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
  // chainId 必須傳進去：掃描起點與出塊時間都依鏈而定，不傳就會退回 12 秒/塊的
  // Ethereum 假設，在 Base 上把每筆事件的時間高估六倍。
  const { alerts: whaleAlerts } = useWhaleAlerts(
    contracts?.exchange ?? null,
    wallet.provider,
    20,
    wallet.chainId ?? null,
  );
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
  // GameFi 的狀態（PEPE 餘額與空投、簽到連續、成就、任務、造型收藏、以及
  // 它們共用的 toast）原本都掛在這一頁。全部移除：
  //   - PEPE 餘額／空投 → components/pepefi/PepeTokenCard，掛在 /rewards
  //   - 每日簽到        → /rewards 早就有一份，這裡是重複的
  //   - 成就／任務／收藏 → /pepe 才是它們的家
  // 這一頁只剩下投資組合需要的資料。
  const [enabled, setEnabled] = useState<Set<string>>(new Set(TREND_ASSET_IDS));
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
      // Isolated per read. Previously one reverting call — TraderStake is 0x0
      // on chains where it isn't deployed — took positions, margin, and balance
      // down with it, which is what blanked the dashboard.
      const [posIds, fmRaw, walletUsdcRaw, stakedUsdcRaw] = await Promise.all([
        safeRead(contracts.exchange.getUserPositions(wallet.address) as Promise<bigint[]>, []),
        safeRead(contracts.exchange.freeMargin(wallet.address) as Promise<bigint>, 0n),
        safeRead(contracts.usdc.balanceOf(wallet.address) as Promise<bigint>, 0n),
        safeRead(contracts.traderStake.getStake(wallet.address) as Promise<unknown>, 0n),
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

  // 兩組 8 秒輪詢（餘額 + PEPE）疊上 useLivePrices 的每輪 12 次 oracle 讀取，
  // 在公共 RPC 上是穩定的限流來源。鏈上餘額不會每 8 秒變一次；30 秒足夠，而且
  // 分頁在背景時完全不打（切回前景會立刻補一次）。
  useEffect(() => {
    void fetchAll();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchAll();
    }, POLL_MS);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void fetchAll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [fetchAll]);

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

  // 淨值的組成。null 代表那一項**沒讀到**（例如 TraderStake 在這條鏈上是
  // 0x0），netWorthOf 會把它排除在總額外並回報，而不是靜默當成 0 端出一個
  // 看起來很篤定的錯數字。derived.* 一定有值（由持倉算出來的），所以不是 null。
  const netWorthParts: NetWorthParts = {
    walletCash:    walletUSDC,
    freeMargin,
    lockedMargin:  derived.totalMargin,
    unrealisedPnl: derived.totalPnL,
    staked:        stakedUSDC,
    vault:         vaultUSDC,
  };

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

      {/* ── Identity + way into the lab ─────────────────────────────────────── */}
      {/* Was a six-figure GameFi summary (PEPE balance, check-in streak,
          achievements, quests, cosmetics). Every one of those numbers is
          already on /pepe or /rewards, and rendering them here is what kept
          the Dashboard coupled to the whole GameFi state tree. What's left is
          the part a portfolio page actually needs: who you are, and one way in. */}
      <Card sx={{ p: 2.5, bgcolor: '#0e1420', border: '1px solid var(--palette-primary-main)22', borderRadius: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <PepeAvatar address={wallet.address ?? undefined} size={56} />

          <Box sx={{ minWidth: 0 }}>
            <Typography fontWeight={900} fontSize={18} sx={{ color: 'var(--palette-primary-main)' }}>
              {pepeNameFor(wallet.address)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
              {wallet.address ? `${wallet.address.slice(0,6)}…${wallet.address.slice(-4)}` : ''}
            </Typography>
          </Box>

          <Button
            component={RouterLink}
            to="/pepe"
            variant="contained"
            sx={{ ml: { sm: 'auto' }, bgcolor: 'var(--palette-primary-main)', color: '#0e1420', fontWeight: 900, textTransform: 'none' }}
          >
            🐸 Pepe Lab →
          </Button>
        </Box>
      </Card>

      {/* ── Simple mode: big live-price cards ── */}
      {mode === 'simple' && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, fontWeight: 700 }}>
            📊 即時價格
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 2 }}>
            {Object.entries(livePrices).map(([id, lp]) => {
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
                    {meta.icon || (meta.category === 'crypto' ? '🪙' : meta.category === 'equity' ? '📊' : meta.category === 'bond' ? '📜' : '🏅')}
                  </Typography>
                  <Typography fontWeight={800} fontSize={14}>{meta.symbol}</Typography>
                  <Typography fontWeight={700} fontSize={15} sx={{ color: 'var(--palette-primary-main)', fontFamily: MONO }}>
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

      {/* ── Net worth hero ─────────────────────────────────────── */}
      <NetWorthHero
        parts={netWorthParts}
        pnlPct={pnlPctStr}
        loading={isLoading}
      />

      {/* ── What to do next ───────────────────────────────── */}
      <QuickActions mode={mode} />

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
        ) : mode === 'simple' ? (
          /* 簡單模式給卡片，不是把同一張表少切幾欄。一列表格要使用者自己把
             欄位標題和數字對起來才讀得懂；一張卡片直接說完一件事：買了什麼、
             方向與倍數、現在值多少、賺賠多少。 */
          <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2 }}>
            {derived.rows.map(row => {
              const meta = ASSET_META[row.asset];
              const noQuote = row.currentPrice18 === 0n;
              return (
                <Card
                  key={String(row.id)}
                  sx={{
                    p: 2,
                    border: '1px solid',
                    borderColor: 'divider',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1.5,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Typography sx={{ fontSize: '1.5rem', lineHeight: 1 }}>{meta?.icon ?? '?'}</Typography>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ fontWeight: 800, fontFamily: MONO }}>
                        {meta?.symbol ?? row.asset.slice(0, 8)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {meta?.name ?? ''}
                      </Typography>
                    </Box>
                    <Chip
                      label={`${row.isLong ? 'LONG' : 'SHORT'} ${String(row.leverage)}×`}
                      size="small"
                      sx={{
                        fontWeight: 'bold',
                        bgcolor: row.isLong ? 'rgba(34,197,94,0.12)' : 'rgba(255,86,48,0.12)',
                        color: row.isLong ? 'success.main' : 'error.main',
                        border: '1px solid',
                        borderColor: row.isLong ? 'rgba(34,197,94,0.2)' : 'rgba(255,86,48,0.2)',
                      }}
                    />
                  </Box>

                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <Box>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Worth now
                      </Typography>
                      <Typography sx={{ fontWeight: 800, fontFamily: MONO, fontSize: '1.125rem' }}>
                        {fUsd(row.holdingsValue)}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Profit / loss
                      </Typography>
                      {noQuote ? (
                        <Typography variant="body2" color="text.secondary">No quote</Typography>
                      ) : (
                        <>
                          <Typography sx={{ fontWeight: 800, fontFamily: MONO, color: pnlColor(row.livePnL) }}>
                            {fPnL(row.livePnL)}
                          </Typography>
                          <Typography variant="caption" sx={{ color: pnlColor(row.livePnL), opacity: 0.85 }}>
                            {fPct(row.livePnL, row.notional)}
                          </Typography>
                        </>
                      )}
                    </Box>
                  </Box>
                </Card>
              );
            })}
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['資產','多/空','持有數量','平均成本','現價','持倉現值','損益','ESG'].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5, textAlign: h === '損益' || h === '持倉現值' ? 'right' : 'left' }}>
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
                            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
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
                        <TableCell sx={{ fontFamily: MONO }}>
                          {fQty(row.quantity, row.asset)}
                          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                            {meta?.symbol?.replace(/^s/, '') ?? ''}
                          </Typography>
                        </TableCell>
                      )}
                      {/* 平均成本 (expert only) */}
                      {mode === 'expert' && (
                        <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                          {fUsdFloat(Number(row.entryPrice) / 1e18)}
                        </TableCell>
                      )}
                      {/* 現價 (expert only) */}
                      {mode === 'expert' && (
                        <TableCell sx={{ fontFamily: MONO }}>
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
                      <TableCell sx={{ fontFamily: MONO, textAlign: 'right', fontWeight: 'bold' }}>
                        {fUsd(row.holdingsValue)}
                      </TableCell>
                      {/* 損益 */}
                      <TableCell sx={{ textAlign: 'right', fontFamily: MONO }}>
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
                    <TableCell colSpan={5} sx={{ fontWeight: 'bold', color: 'text.primary' }}>Total</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', textAlign: 'right' }}>
                      {fUsd(derived.totalHoldings)}
                    </TableCell>
                    <TableCell sx={{ textAlign: 'right', fontFamily: MONO }}>
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

      {/* ── Analysis (expert only) ──────────────────────────── */}
      {/* 分類收益、配置圓餅圖 + ESG、鯨魚動向、趨勢圖——這四塊回答的是
          「為什麼會長成這樣」，不是「我現在有多少錢」。新手先需要後者，
          前者在他看得懂之前只是雜訊。 */}
      {mode === 'expert' && (
        <>

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
                          <Typography variant="h5" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
                            {fUsd(s.value)}
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 'bold', color: pnlColor(s.pnl), fontFamily: MONO, mt: 0.5 }}>
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
                        {/* 地址檢視搬到 /trader/:address 了（whale 頁不再自己長出
                            搜尋結果）。/whale?addr= 仍會轉址，但沒必要多繞一次。 */}
                        <Link component={RouterLink} to={`/trader/${a.owner}`} sx={{ fontFamily: MONO, color: 'info.main', fontSize: '0.75rem', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                          {shortAddr(a.owner)}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ py: 1, fontSize: '0.75rem' }}>{a.assetLabel}</TableCell>
                      <TableCell sx={{ py: 1, fontSize: '0.75rem' }}>
                        <Typography component="span" sx={{ fontSize: '0.75rem', fontWeight: 'bold', color: a.isLong ? 'success.main' : 'error.main' }}>
                          {a.isLong ? 'LONG' : 'SHORT'} {String(a.leverage)}×
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ py: 1, textAlign: 'right', fontFamily: MONO, fontWeight: 'bold', fontSize: '0.75rem' }}>
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
                          <Typography variant="caption" sx={{ width: 60, fontFamily: MONO, fontWeight: 'bold' }}>
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
                          <Typography variant="caption" sx={{ width: 30, textAlign: 'right', fontFamily: MONO, fontWeight: 'bold', color: 'text.secondary' }}>
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
        </>
      )}

      {mode === 'simple' && (
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
          Switch to expert mode for allocation, ESG scores, whale activity and trend charts.
        </Typography>
      )}


    </Container>
  );
}
