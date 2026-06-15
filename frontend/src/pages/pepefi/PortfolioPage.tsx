import { MONO } from 'src/components/pepefi/brandKit'
import { parseEther } from 'ethers';
import { useState, useEffect, useCallback } from 'react';
import {
  Line, XAxis, YAxis, Tooltip, LineChart,
  CartesianGrid, ReferenceLine, ResponsiveContainer,
} from 'recharts';

import { useESG } from 'src/hooks/useESG';
import { useContracts } from 'src/hooks/useContracts';
import { useLivePrices } from 'src/hooks/useLivePrices';

import { usePepefiWallet } from 'src/layouts/pepefi';
import { getAddresses, CHAIN_NAMES } from 'src/contracts/addresses';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { prettyError } from 'src/lib/pepefi/errorMessages';

import StatCard from 'src/components/pepefi/StatCard';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import EmptyState from 'src/components/pepefi/EmptyState';
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton';

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
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import Link from '@mui/material/Link';
import { Icon } from '@iconify/react';
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'

// ── Config ──────────────────────────────────────────────────────────────────

const SHORT_ADDR = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── Types ────────────────────────────────────────────────────────────────────
interface RawCopyRecord {
  trader:        string;
  versionId:     bigint;
  initialAmount: bigint;
  positionIds:   bigint[];
  copiedAt:      bigint;
  active:        boolean;
}

interface RawPos {
  asset:       string;
  isLong:      boolean;
  isOpen:      boolean;
  entryPrice:  bigint;
  margin:      bigint;
  leverage:    bigint;
  copiedFrom:  string;
}

interface CopyRec {
  index:         number;
  trader:        string;
  traderName:    string;
  initialAmount: bigint;    // 18-dec
  copiedAt:      bigint;
  currentValue:  bigint;    // sum of getPositionValue for all positionIds
}

interface PosRow {
  id:            bigint;
  asset:         string;
  isLong:        boolean;
  entryPrice:    bigint;    // 18-dec
  currentPrice:  bigint;    // 18-dec
  margin:        bigint;    // 18-dec
  leverage:      bigint;
  unrealizedPnL: bigint;    // signed 18-dec
  currentValue:  bigint;    // 18-dec ≥ 0
  copiedFrom:    string;    // address(0) for self-opened
  accruedFunding: bigint;   // signed 18-dec
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f18   = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d);
const fUsd  = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
const fPnL      = (v: bigint) => (Number(v) >= 0 ? '+' : '') + f18(v, 4) + ' USDC';
const pnlColor  = (v: bigint) => Number(v) >= 0 ? 'success.main' : 'error.main';
const returnPct = (initial: bigint, current: bigint): string => {
  if (initial === 0n) return '—';
  const pct = ((Number(current) - Number(initial)) / Number(initial)) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
};
const returnColor = (initial: bigint, current: bigint) =>
  current >= initial ? 'success.main' : 'error.main';

type TxResp = { wait(): Promise<unknown>; hash: string };
const asTx = (tx: unknown): TxResp => tx as TxResp;

const tryParse = (s: string): bigint | null => {
  if (!s) return null;
  try { return parseEther(s); } catch { return null; }
};

// ── Component ────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const wallet = usePepefiWallet();
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const livePrices = useLivePrices();
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);

  const [copyRecs,   setCopyRecs]   = useState<CopyRec[]>([]);
  const [positions,  setPositions]  = useState<PosRow[]>([]);
  const [freeMargin, setFreeMargin] = useState(0n);
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [isLoaded,   setIsLoaded]   = useState(false);

  const [busy,  setBusy]  = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null);

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash });
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) {
      setIsLoaded(true);
      return;
    }
    try {
      const addr = wallet.address;

      // ── A: Copy records ───────────────────────────────────────────────────
      const rawRecs = (await contracts.copyTracker.getCopyRecords(addr)) as unknown as RawCopyRecord[];

      const uniqueTraders = [...new Set(rawRecs.map(r => r.trader))];
      const nameMap: Record<string, string> = {};
      await Promise.all(
        uniqueTraders.map(async ta => {
          try {
            const t = (await contracts.registry.traders(ta)) as unknown as [boolean, string, bigint];
            nameMap[ta] = t[1];
          } catch { nameMap[ta] = ''; }
        })
      );

      const getVal = async (id: bigint): Promise<bigint> => {
        try { return (await contracts.exchange.getPositionValue(id)) as bigint; }
        catch { return 0n; }
      };

      const enriched = await Promise.all(
        rawRecs.map(async (rec, i): Promise<CopyRec | null> => {
          if (!rec.active) return null;
          const vals = await Promise.all(rec.positionIds.map(id => getVal(id)));
          return {
            index:         i,
            trader:        rec.trader,
            traderName:    nameMap[rec.trader] ?? '',
            initialAmount: rec.initialAmount,
            copiedAt:      rec.copiedAt,
            currentValue:  vals.reduce((s, v) => s + v, 0n),
          };
        })
      );
      setCopyRecs(enriched.filter((r): r is CopyRec => r !== null));

      // ── B: Open positions ─────────────────────────────────────────────────
      const posIds = (await contracts.exchange.getUserPositions(addr)) as bigint[];

      const maybeRows = await Promise.all(
        posIds.map(async (id): Promise<PosRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos;
            if (!raw.isOpen) return null;
            const [pnl, val, priceRes, funding] = await Promise.all([
              contracts.exchange.getUnrealizedPnL(id),
              contracts.exchange.getPositionValue(id),
              contracts.oracle.getPrice(raw.asset),
              contracts.exchange.pendingFunding(id).catch(() => 0n),
            ]);
            const pr = priceRes as unknown as [bigint, bigint];
            return {
              id,
              asset:          raw.asset,
              isLong:         raw.isLong,
              entryPrice:     raw.entryPrice,
              currentPrice:   pr[0] * 10n ** 10n,
              margin:         raw.margin,
              leverage:       raw.leverage,
              unrealizedPnL:  pnl as bigint,
              currentValue:   val as bigint,
              copiedFrom:     raw.copiedFrom,
              accruedFunding: funding as bigint,
            };
          } catch { return null; }
        })
      );
      setPositions(maybeRows.filter((r): r is PosRow => r !== null));

      // ── C: Free margin ────────────────────────────────────────────────────
      setFreeMargin((await contracts.exchange.freeMargin(addr)) as bigint);
    } catch (e) {
      console.error('[portfolio fetch]', e);
      notify(prettyError(e), false);
    } finally {
      setIsLoaded(true);
    }
  }, [contracts, wallet.address, notify]);

  useEffect(() => {
    void fetchAll();
    const timer = setInterval(() => { void fetchAll(); }, 30_000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const isWrongNetwork = wallet.isConnected && wallet.chainId !== null && !getAddresses(wallet.chainId);
  useEffect(() => {
    if (!wallet.isConnected || isWrongNetwork) setIsLoaded(true);
  }, [wallet.isConnected, isWrongNetwork]);

  // ── Transactions ────────────────────────────────────────────────────────────
  const doUnfollow = async (index: number) => {
    if (!contracts) return;
    const key = `unfollow_${index}`;
    setLoad(key, true);
    try {
      const tx = asTx(await contracts.copyTracker.unfollowAndCloseAll(BigInt(index)));
      await tx.wait();
      notify('Unfollowed and all positions closed ✓', true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad(key, false); }
  };

  const doWithdraw = async () => {
    if (!contracts) return;
    const amt = tryParse(withdrawAmt);
    if (!amt) { notify('Enter a valid amount', false); return; }
    setLoad('withdraw', true);
    try {
      const tx = asTx(await contracts.exchange.withdrawMargin(amt));
      await tx.wait();
      notify(`Withdrew ${withdrawAmt} USDC ✓`, true, tx.hash);
      setWithdrawAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('withdraw', false); }
  };

  // ── Derived (chart data) ───────────────────────────────────────────────────
  const totalInitial = copyRecs.reduce((s, r) => s + r.initialAmount, 0n);
  const totalCopyCur = copyRecs.reduce((s, r) => s + r.currentValue, 0n);
  const initVal      = Number(totalInitial) / 1e18;
  const curVal       = Number(totalCopyCur) / 1e18;

  const chartData =
    totalInitial > 0n
      ? [
          { name: 'Deposited', value: initVal },
          { name: 'Now',       value: curVal  },
        ]
      : [{ name: 'Now', value: Number(freeMargin) / 1e18 }];

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to view your portfolio.</Typography>
      </Box>
    );
  }

  if (isWrongNetwork) {
    const name = wallet.chainId ? (CHAIN_NAMES[wallet.chainId] ?? `Chain ${wallet.chainId}`) : 'unknown';
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <Typography sx={{ fontSize: '2.5rem' }}>⛓️</Typography>
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Unsupported Network</Typography>
        <Typography variant="body2" color="text.secondary" align="center">
          Connected to <Typography component="span" sx={{ color: 'warning.main', fontFamily: MONO }}>{name}</Typography>.<br />
          Please switch to <Typography component="span" sx={{ color: 'primary.main', fontFamily: MONO }}>Base Sepolia</Typography> testnet.
        </Typography>
      </Box>
    );
  }

  if (!isLoaded) {
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Grid container spacing={2}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Grid size={{ xs: 12, sm: 6, md: 3 }} key={i}>
              <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Skeleton width={80} height={16} />
                <Skeleton width={120} height={28} />
                <Skeleton width="100%" height={16} />
              </Card>
            </Grid>
          ))}
        </Grid>
        <Card sx={{ border: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Skeleton width={120} height={20} />
          </Box>
          <TableSkeleton rows={3} cols={8} />
        </Card>
      </Container>
    );
  }

  if (isLoaded && copyRecs.length === 0 && positions.length === 0 && freeMargin === 0n) {
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <EmptyState
          icon="💼"
          title="Your portfolio is empty"
          description="Start by getting test USDC, then copy a trader or open positions yourself."
          ctaText="Get USDC"
          ctaHref="/exchange"
        />
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Toast Alert */}
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        message={toast?.msg}
        action={
          toast?.hash && explorerTx(toast.hash, wallet.chainId) ? (
            <Button
              color="primary"
              size="small"
              component="a"
              href={explorerTx(toast.hash, wallet.chainId)!}
              target="_blank"
              rel="noopener noreferrer"
            >
              {explorerName(wallet.chainId)}
            </Button>
          ) : null
        }
      />

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>My Portfolio</Typography>
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={() => void fetchAll()}
          startIcon={<Icon icon="solar:restart-bold-duotone" />}
          sx={{ textTransform: 'none', color: 'text.secondary' }}
        >
          Refresh
        </Button>
      </Box>

      {/* Stat cards */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard
            title="Free Margin"
            value={f18(freeMargin)}
            sub="USDC available"
            valueColor="primary.light"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard
            title="Active Copies"
            value={String(copyRecs.length)}
            sub={copyRecs.length === 1 ? 'trader followed' : 'traders followed'}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard
            title="Open Positions"
            value={String(positions.length)}
            sub="manual + copied"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard
            title="Total Copy PnL"
            value={totalInitial > 0n ? returnPct(totalInitial, totalCopyCur) : '—'}
            sub={totalInitial > 0n ? `${f18(totalCopyCur)} / ${f18(totalInitial)} USDC` : 'no copy positions'}
            valueColor={totalInitial > 0n ? returnColor(totalInitial, totalCopyCur) : 'text.secondary'}
          />
        </Grid>
      </Grid>

      {/* ─── A. Copy Records ────────────────────────────────────────────── */}
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Copy Positions
          </Typography>
        </Box>

        {copyRecs.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4, fontStyle: 'italic' }}>
            No active copy positions.
          </Typography>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['Trader','Copied At','Initial','Current','Return','Actions'].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5, textAlign: h === 'Actions' || h === 'Return' || h === 'Current' || h === 'Initial' ? 'right' : 'left' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {copyRecs.map(rec => {
                  const unfKey = `unfollow_${rec.index}`;
                  return (
                    <TableRow key={rec.index} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                      <TableCell>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                          {rec.traderName || SHORT_ADDR(rec.trader)}
                        </Typography>
                        <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', mt: 0.2 }}>
                          {SHORT_ADDR(rec.trader)}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
                        {fDate(rec.copiedAt)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, textAlign: 'right' }}>
                        {f18(rec.initialAmount)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, textAlign: 'right', fontWeight: 'bold' }}>
                        {f18(rec.currentValue)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, textAlign: 'right', fontWeight: 'bold', color: returnColor(rec.initialAmount, rec.currentValue) }}>
                        {returnPct(rec.initialAmount, rec.currentValue)}
                      </TableCell>
                      <TableCell sx={{ textAlign: 'right' }}>
                        <Button
                          size="small"
                          variant="contained"
                          color="error"
                          onClick={() => void doUnfollow(rec.index)}
                          disabled={busy[unfKey]}
                          sx={{ fontWeight: 'bold' }}
                        >
                          {busy[unfKey] ? '…' : 'Unfollow'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* ─── B. Open Positions ──────────────────────────────────────────── */}
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Open Positions
          </Typography>
        </Box>

        {positions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4, fontStyle: 'italic' }}>
            No open positions.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['Asset','ESG','Side','Entry','Current','Live Market','Margin','Lev','Copied From','Unr. PnL','Accrued Funding','Value'].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5 }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.map(row => (
                  <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                      {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      {esg[row.asset] ? (
                        <ESGBadge composite={esg[row.asset].composite} rating={esg[row.asset].rating} />
                      ) : (
                        <Typography variant="caption" color="text.secondary">—</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={row.isLong ? 'LONG ↑' : 'SHORT ↓'}
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
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>{fUsd(row.entryPrice)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>{fUsd(row.currentPrice)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>
                      {livePrices[row.asset] ? (
                        <Typography component="span" sx={{ fontSize: '0.8125rem', fontFamily: MONO, color: livePrices[row.asset].isMock ? 'warning.main' : 'success.main' }}>
                          ${livePrices[row.asset].usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </Typography>
                      ) : <Typography variant="caption" color="text.secondary">—</Typography>}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>{f18(row.margin)}</TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem' }}>{String(row.leverage)}×</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
                      {row.copiedFrom === '0x0000000000000000000000000000000000000000' ? (
                        <Typography component="span" variant="caption" color="text.disabled">—</Typography>
                      ) : SHORT_ADDR(row.copiedFrom)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.unrealizedPnL) }}>
                      {fPnL(row.unrealizedPnL)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: row.accruedFunding < 0n ? 'success.main' : row.accruedFunding > 0n ? 'error.main' : 'text.secondary' }}>
                      {row.accruedFunding === 0n ? '—' : fPnL(-row.accruedFunding)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.currentValue - row.margin) }}>
                      {f18(row.currentValue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <tfoot style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  <TableCell colSpan={8} sx={{ fontWeight: 'bold', color: 'text.primary' }}>Total</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: pnlColor(positions.reduce((s, p) => s + p.unrealizedPnL, 0n)) }}>
                    {fPnL(positions.reduce((s, p) => s + p.unrealizedPnL, 0n))}
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: positions.reduce((s, p) => s + p.accruedFunding, 0n) < 0n ? 'success.main' : 'error.main' }}>
                    {fPnL(-positions.reduce((s, p) => s + p.accruedFunding, 0n))}
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                    {f18(positions.reduce((s, p) => s + p.currentValue, 0n))}
                  </TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* ─── C + D side-by-side ─────────────────────────────────────────── */}
      <Grid container spacing={3}>
        {/* C. Free Margin */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
              Free Margin
            </Typography>
            <Box>
              <Typography variant="h3" sx={{ fontWeight: 800, fontFamily: MONO, color: 'primary.light' }}>
                {f18(freeMargin)}{' '}
                <Typography component="span" variant="subtitle1" color="text.secondary">USDC</Typography>
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <TextField
                placeholder="Amount"
                type="number"
                size="small"
                fullWidth
                value={withdrawAmt}
                onChange={e => setWithdrawAmt(e.target.value)}
                disabled={busy['withdraw']}
              />
              <Button
                variant="contained"
                color="error"
                onClick={() => void doWithdraw()}
                disabled={busy['withdraw']}
                sx={{ fontWeight: 'bold', minWidth: 120 }}
              >
                {busy['withdraw'] ? '…' : 'Withdraw'}
              </Button>
            </Box>
          </Card>
        </Grid>

        {/* D. Performance Chart */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Performance
              </Typography>
              {totalInitial > 0n && (
                <Chip
                  label={returnPct(totalInitial, totalCopyCur)}
                  color={totalCopyCur >= totalInitial ? 'success' : 'error'}
                  size="small"
                  sx={{ fontWeight: 'bold' }}
                />
              )}
            </Box>

            <Box sx={{ width: '100%', height: 160 }}>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="name"
                    stroke="#454F5B"
                    tick={{ fill: '#637381', fontSize: 10, fontWeight: 500 }}
                  />
                  <YAxis
                    stroke="#454F5B"
                    tick={{ fill: '#637381', fontSize: 10, fontWeight: 500 }}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                    width={48}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#161c24',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      fontSize: '11px',
                      color: '#fff',
                    }}
                    itemStyle={{ color: '#fff' }}
                    labelStyle={{ color: '#919eab' }}
                    formatter={(value) => [
                      `$${Number(value ?? 0).toFixed(2)}`,
                      'Portfolio Value',
                    ]}
                  />
                  {totalInitial > 0n && (
                    <ReferenceLine
                      y={initVal}
                      stroke="#ffab00"
                      strokeDasharray="4 4"
                      label={{ value: 'Initial', fill: '#ffab00', fontSize: 9, position: 'insideTopRight' }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#00b8d9"
                    strokeWidth={2.5}
                    dot={{ fill: '#00b8d9', r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Box>

            <Typography variant="caption" color="text.secondary" align="center" sx={{ opacity: 0.6 }}>
              Auto-refreshes every 30 s · Two-point view (initial vs current)
            </Typography>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
}
