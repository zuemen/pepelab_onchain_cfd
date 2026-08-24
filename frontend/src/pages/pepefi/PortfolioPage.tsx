import { MONO } from 'src/components/pepefi/brandKit'
import { parseEther } from 'ethers';
import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import {
  Line, XAxis, YAxis, Tooltip, LineChart,
  CartesianGrid, ReferenceLine, ResponsiveContainer,
} from 'recharts';

import { useESG } from 'src/hooks/useESG';
import { useContracts } from 'src/hooks/useContracts';
import { useLivePrices } from 'src/hooks/useLivePrices';

import { usePepefiWallet } from 'src/layouts/pepefi';
import { getAddresses, CHAIN_NAMES } from 'src/contracts/addresses';
import { t, interpolate } from 'src/locales';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { safeRead } from 'src/lib/pepefi/safeRead';
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { firstBlocking, stalenessNotice } from 'src/lib/pepefi/priceFreshness';

import { useMode } from 'src/contexts/mode-context';
import { useAccountBalances } from 'src/hooks/useAccountBalances';
import { isPortfolioProvablyEmpty, type NetWorthParts, type PortfolioEmptinessCheck } from 'src/lib/pepefi/portfolio';
import { COLUMN_LABELS, openPositionColumnsForMode, type OpenPositionColumnKey } from 'src/lib/pepefi/openPositionColumns';

import StatCard from 'src/components/pepefi/StatCard';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import NetWorthHero from 'src/components/pepefi/dashboard/NetWorthHero';
import RwaAllocation from 'src/components/pepefi/dashboard/RwaAllocation';
import QuickActions from 'src/components/pepefi/dashboard/QuickActions';
import PortfolioAnalysis from 'src/components/pepefi/dashboard/PortfolioAnalysis';
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
  openedAt:    bigint;
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
  openedAt:      bigint;    // unix seconds
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
const fPnL      = (v: bigint) => (Number(v) >= 0 ? '+' : '') + f18(v, 4) + ' ' + STABLE_LABEL;
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

// Simple-mode Open Positions row cells, keyed the same way as the header
// (openPositionColumnsForMode('simple')) so reordering or trimming that list
// can't drift out of sync with what each row actually renders.
function renderSimplePositionCell(key: OpenPositionColumnKey, row: PosRow) {
  switch (key) {
    case 'asset':
      return (
        <TableCell key={key} sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
          {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
        </TableCell>
      );
    case 'side':
      return (
        <TableCell key={key}>
          <Chip
            label={row.isLong ? t.portfolio.page.side.long : t.portfolio.page.side.short}
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
      );
    case 'value':
      return (
        <TableCell key={key} sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.currentValue - row.margin) }}>
          {f18(row.currentValue)}
        </TableCell>
      );
    case 'unrealizedPnl':
      return (
        <TableCell key={key} sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.unrealizedPnL) }}>
          {fPnL(row.unrealizedPnL)}
        </TableCell>
      );
    default:
      // Simple mode only ever asks for the four keys above — reaching this
      // means SIMPLE_COLUMNS grew without this renderer growing with it.
      return null;
  }
}

// `safeRead` (src/lib/pepefi/safeRead.ts) reports a fallback but not whether
// the read actually succeeded — fine for a value nothing else depends on,
// not enough here, where "did this succeed" feeds isPortfolioProvablyEmpty.
// This wraps the same fallback-on-error idea and also returns ok + the
// original error, so a caller can both fall back AND keep proving whether
// what it's looking at is real data or just a default.
interface TrackedRead<T> { value: T; ok: boolean; error?: unknown }

async function trackedRead<T>(promise: Promise<T>, fallback: T, label: string): Promise<TrackedRead<T>> {
  try {
    return { value: await promise, ok: true };
  } catch (error) {
    console.error(`[portfolio fetch: ${label}]`, error);
    return { value: fallback, ok: false, error };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const wallet = usePepefiWallet();
  const navigate = useNavigate();
  const { mode } = useMode();
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const livePrices = useLivePrices();
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);

  // 錢包／質押／金庫。這一頁本來只讀 freeMargin，因為它只管交易帳戶；淨值
  // hero 從 Dashboard 併過來之後就需要另外三桶錢。
  const balances = useAccountBalances(contracts, wallet.address);

  const [copyRecs,   setCopyRecs]   = useState<CopyRec[]>([]);
  const [positions,  setPositions]  = useState<PosRow[]>([]);
  const [freeMargin, setFreeMargin] = useState(0n);
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [isLoaded,   setIsLoaded]   = useState(false);

  // 這三項各自成功與否,獨立於它們讀失敗時退回的預設值([]、[]、0n)。
  // 「空投資組合」的判斷需要知道「讀失敗」跟「讀到、真的是空」的差別——
  // 兩者的數值長得一樣,但意義完全不同。見 lib/pepefi/portfolio.ts 的
  // isPortfolioProvablyEmpty。
  const [copyRecsOk,   setCopyRecsOk]   = useState(false);
  const [positionsOk,  setPositionsOk]  = useState(false);
  const [freeMarginOk, setFreeMarginOk] = useState(false);

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
    const addr = wallet.address;

    // 三項各自獨立讀取,一項失敗只讓那一項退回預設值——不連累另外兩項。
    // 之前三項擠在同一個 try,任何一項 revert 或逾時就把另外兩項也一起
    // 洗成空的預設值,結果跟真的讀到空值一模一樣,is-empty 判斷分不出來。
    const copyRecsResult = await trackedRead((async (): Promise<CopyRec[]> => {
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
      return enriched.filter((r): r is CopyRec => r !== null);
    })(), [] as CopyRec[], 'copy records');
    setCopyRecs(copyRecsResult.value);
    setCopyRecsOk(copyRecsResult.ok);

    const positionsResult = await trackedRead((async (): Promise<PosRow[]> => {
      const posIds = (await contracts.exchange.getUserPositions(addr)) as bigint[];

      // getPosition 先併發拿完，再對「還開著」的倉位併發拿細節。舊版是在
      // 每個 map 裡先 await getPosition 再 await 四個 view，兩層都算在同一個
      // Promise.all 底下沒錯，但 getPosition 一律要等一個完整 RTT 才開始下一批；
      // 拆成兩階段後總延遲是 2 個 RTT 而不是 2N 個。
      const rawPositions = await Promise.all(
        posIds.map(id =>
          safeRead<RawPos | null>(contracts.exchange.getPosition(id) as unknown as Promise<RawPos>, null),
        ),
      );

      const maybeRows = await Promise.all(
        posIds.map(async (id, i): Promise<PosRow | null> => {
          try {
            const raw = rawPositions[i];
            if (!raw || !raw.isOpen) return null;
            // Each read is isolated: a reverting view on one position must not
            // blank the whole portfolio.
            const [pnl, val, priceRes, funding] = await Promise.all([
              safeRead(contracts.exchange.getUnrealizedPnL(id) as Promise<bigint>, 0n),
              safeRead(contracts.exchange.getPositionValue(id) as Promise<bigint>, 0n),
              safeRead(
                contracts.oracle.getPrice(raw.asset) as Promise<[bigint, bigint]>,
                [0n, 0n] as [bigint, bigint],
              ),
              safeRead(contracts.exchange.pendingFunding(id) as Promise<bigint>, 0n),
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
              openedAt:       raw.openedAt,
              unrealizedPnL:  pnl as bigint,
              currentValue:   val as bigint,
              copiedFrom:     raw.copiedFrom,
              accruedFunding: funding as bigint,
            };
          } catch { return null; }
        })
      );
      return maybeRows.filter((r): r is PosRow => r !== null);
    })(), [] as PosRow[], 'positions');
    setPositions(positionsResult.value);
    setPositionsOk(positionsResult.ok);

    const freeMarginResult = await trackedRead(
      contracts.exchange.freeMargin(addr) as Promise<bigint>, 0n, 'free margin',
    );
    setFreeMargin(freeMarginResult.value);
    setFreeMarginOk(freeMarginResult.ok);

    const failures = [copyRecsResult, positionsResult, freeMarginResult].filter(r => !r.ok);
    if (failures.length > 0) notify(prettyError(failures[0].error), false);
    setIsLoaded(true);
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
  // M1：unfollowAndCloseAll 會一口氣平掉這筆跟單底下的所有倉位，每一個都要讀
  // oracle。只要有一檔過期，整筆交易 revert——所以判斷是「這些倉位裡有沒有任何
  // 一檔過期」，不是單一標的。
  const unfollowStaleNotice = (index: number): string | null => {
    const rec = copyRecs.find(r => r.index === index);
    if (!rec) return null;
    const assets = positions
      .filter(p => p.copiedFrom?.toLowerCase() === rec.trader.toLowerCase())
      .map(p => ({
        label: ASSET_LABEL[p.asset] ?? p.asset.slice(0, 8),
        freshness: livePrices[p.asset]?.freshness,
      }));
    const bad = firstBlocking(assets);
    return bad ? stalenessNotice(bad.freshness, bad.label) : null;
  };

  const doUnfollow = async (index: number) => {
    if (!contracts) return;
    const blocked = unfollowStaleNotice(index);
    if (blocked) { notify(blocked, false); return; }
    const key = `unfollow_${index}`;
    setLoad(key, true);
    try {
      const tx = asTx(await contracts.copyTracker.unfollowAndCloseAll(BigInt(index)));
      await tx.wait();
      notify(t.portfolio.page.unfollowedOk, true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad(key, false); }
  };

  const doWithdraw = async () => {
    if (!contracts) return;
    const amt = tryParse(withdrawAmt);
    if (!amt) { notify(t.portfolio.page.enterValidAmount, false); return; }
    setLoad('withdraw', true);
    try {
      const tx = asTx(await contracts.exchange.withdrawMargin(amt));
      await tx.wait();
      notify(
        interpolate(t.portfolio.page.withdrawnOk, { amount: withdrawAmt, token: STABLE_LABEL }),
        true,
        tx.hash
      );
      setWithdrawAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('withdraw', false); }
  };

  // ── Net worth ─────────────────────────────────────────────────────────────
  // freeMargin 有兩個來源：這一頁自己讀的（提領後會立刻更新）與 useAccountBalances
  // 的輪詢。以本頁的為準，因為提領完不該還顯示舊值等下一輪輪詢。
  const lockedMargin = positions.reduce((s, p) => s + p.margin, 0n);
  const unrealisedPnl = positions.reduce((s, p) => s + p.unrealizedPnL, 0n);

  const netWorthParts: NetWorthParts = {
    walletCash:    balances.walletCash,
    freeMargin,
    lockedMargin,
    unrealisedPnl,
    staked:        balances.staked,
    vault:         balances.vault,
  };

  const notionalTotal = positions.reduce((s, p) => s + p.margin * p.leverage, 0n);
  const pnlPctStr = notionalTotal > 0n
    ? (Number(unrealisedPnl) / Number(notionalTotal) >= 0 ? '+' : '')
      + ((Number(unrealisedPnl) / Number(notionalTotal)) * 100).toFixed(2) + '%'
    : '—';

  // ── Derived (chart data) ───────────────────────────────────────────────────
  const totalInitial = copyRecs.reduce((s, r) => s + r.initialAmount, 0n);
  const totalCopyCur = copyRecs.reduce((s, r) => s + r.currentValue, 0n);
  const initVal      = Number(totalInitial) / 1e18;
  const curVal       = Number(totalCopyCur) / 1e18;

  // 只有跟單記錄帶得出「投入 → 現在」這兩個點；沒有記錄就沒有績效可畫。
  // 原本的 fallback 是畫一個點、而且畫的是自由保證金——標題寫 Performance、
  // 副標寫 initial vs current，畫面上卻是一顆跟績效無關的孤點。整張卡不顯示
  // 才是誠實的做法，跟 hero 不顯示算不出來的「今日變化」是同一個理由。
  const hasCopyHistory = totalInitial > 0n;

  const chartData = [
    { name: t.portfolio.page.chart.deposited, value: initVal },
    { name: t.portfolio.page.chart.now,       value: curVal  },
  ];

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.portfolio.page.connectWallet}</Typography>
      </Box>
    );
  }

  if (isWrongNetwork) {
    const name = wallet.chainId
      ? (CHAIN_NAMES[wallet.chainId] ??
        interpolate(t.portfolio.page.chainNumber, { id: wallet.chainId }))
      : t.portfolio.page.unknownChain;
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <Typography sx={{ fontSize: '2.5rem' }}>⛓️</Typography>
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.portfolio.page.unsupportedNetwork}</Typography>
        <Typography variant="body2" color="text.secondary" align="center">
          Connected to <Typography component="span" sx={{ color: 'warning.main', fontFamily: MONO }}>{name}</Typography>.<br />
          Please switch to <Typography component="span" sx={{ color: 'primary.main', fontFamily: MONO }}>Base Sepolia</Typography> testnet.
        </Typography>
      </Box>
    );
  }

  // 展示通道沒有 provider/signer,永遠讀不到鏈上資料——不加這一關,下面的
  // isLoaded 會幾乎立刻變 true(fetchAll 一看沒有 contracts 就直接回傳),
  // 六項讀取全部停在「還沒讀成功」,最後落到跟真的空投資組合長一樣的畫面。
  // 那正是「明明有錢卻被說空」的同一種錯誤,只是換了一個必然發生的入口。
  if (wallet.isMock) {
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <EmptyState
          icon="🎭"
          title={t.portfolio.page.demoTitle}
          description={t.portfolio.page.demoDescription}
        />
      </Container>
    );
  }

  // isLoaded 只看這一頁自己那趟 fetch;balances 是另一個 hook、另一條時間線。
  // 只等前者,skeleton 可能在 balances 還在讀的時候就放行——那正是後面
  // isPortfolioProvablyEmpty 拿到「還沒讀到」被誤判方向的老問題,只是換了
  // 一個更早的入口。兩邊都跑完才算真的 loaded。
  if (!isLoaded || !balances.settled) {
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

  // 「空投資組合」只有在六項全部讀成功、而且真的全部是 0/空的時候才成立。
  // 舊版用 `?? 0n` 把「還沒讀到」跟「讀到、是 0」攤平成同一件事，於是一個
  // 有錢但某一項暫時讀失敗的使用者會被判定成空,推去 /exchange——這正是
  // 上線過的那個 bug。任何一項是 null／還沒讀成功,就不能算是「證實是空的」，
  // 見 lib/pepefi/portfolio.ts 的 isPortfolioProvablyEmpty。
  const emptinessCheck: PortfolioEmptinessCheck = {
    copyRecordsCount: copyRecsOk   ? copyRecs.length  : null,
    positionsCount:   positionsOk  ? positions.length : null,
    freeMargin:       freeMarginOk ? freeMargin       : null,
    walletCash:       balances.walletCash,
    staked:           balances.staked,
    vault:            balances.vault,
  };

  if (isLoaded && isPortfolioProvablyEmpty(emptinessCheck)) {
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <EmptyState
          icon="💼"
          title={t.portfolio.page.emptyTitle}
          description={interpolate(t.portfolio.page.emptyDescription, { token: STABLE_LABEL })}
          ctaText={interpolate(t.portfolio.page.emptyCta, { token: STABLE_LABEL })}
          onClick={() => navigate('/exchange')}
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
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.portfolio.page.title}</Typography>
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={() => { void fetchAll(); balances.refetch(); }}
          startIcon={<Icon icon="solar:restart-bold-duotone" />}
          sx={{ textTransform: 'none', color: 'text.secondary' }}
        >
          {t.portfolio.page.refresh}
        </Button>
      </Box>

      {/* ── Net worth + what to do next ──────────────────────────────────────
          Merged in from the Dashboard, which answered the same question this
          page does ("how am I doing") but read-only — every action lived here.
          A read-only twin of an actionable page is where people get stuck:
          they can see the number and cannot do anything about it without
          discovering there is a second page. Aave's dashboard is the same
          shape — net worth on top, positions and their actions below. */}
      <NetWorthHero parts={netWorthParts} pnlPct={pnlPctStr} loading={!isLoaded} />

      {/* RWA 是本平台的最大賣點，緊接在淨值 hero 之後、任何操作之前——見
          RwaAllocation.tsx 頂部註解。Simple／Expert 皆顯示，零持倉也照樣顯示。 */}
      <RwaAllocation rows={positions} />

      <QuickActions mode={mode} />

      {/* Copy stats.
          Free Margin and Open Positions used to sit here too. After the merge
          each was on screen three times — Free Margin as the hero's "Trading"
          figure, this card, and the withdraw panel below; Open Positions as a
          card and as the table right under it. Restating a number does not
          reinforce it, it just makes a reader check whether the two copies
          agree. What's left is the pair the hero can't show: copying is a
          relationship, not a balance.

          Hidden entirely when you copy nobody. Both cards would read 0 and —,
          directly above a Copy Positions panel already saying the same thing
          in words: three ways of being told you have not done something yet,
          for a feature you may never want. The panel below keeps the one
          version that also offers a way in. */}
      {copyRecs.length > 0 && (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <StatCard
              title={t.portfolio.page.activeCopies}
              value={String(copyRecs.length)}
              sub={
                copyRecs.length === 1
                  ? t.portfolio.page.traderFollowedOne
                  : t.portfolio.page.traderFollowedMany
              }
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <StatCard
              title={t.portfolio.page.totalCopyPnl}
              value={totalInitial > 0n ? returnPct(totalInitial, totalCopyCur) : '—'}
              sub={totalInitial > 0n ? `${f18(totalCopyCur)} / ${f18(totalInitial)} ${STABLE_LABEL}` : t.portfolio.page.noCopyPositions}
              valueColor={totalInitial > 0n ? returnColor(totalInitial, totalCopyCur) : 'text.secondary'}
            />
          </Grid>
        </Grid>
      )}

      {/* ─── A. Copy Records ────────────────────────────────────────────── */}
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.portfolio.page.copyPositions}
          </Typography>
        </Box>

        {copyRecs.length === 0 ? (
          /* The one place that still says "you copy nobody" — so it's the one
             that has to offer a way out of that state. */
          <Box sx={{ py: 4, px: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              {t.portfolio.page.notCopyingAnyone}
            </Typography>
            <Button
              component={RouterLink}
              to="/marketplace"
              size="small"
              variant="outlined"
              color="inherit"
              sx={{ mt: 1.5, textTransform: 'none', borderColor: 'divider' }}
            >
              {t.portfolio.page.browseTraders}
            </Button>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {([
                    { label: t.portfolio.page.copyColumn.trader,   right: false },
                    { label: t.portfolio.page.copyColumn.copiedAt, right: false },
                    { label: t.portfolio.page.copyColumn.initial,  right: true },
                    { label: t.portfolio.page.copyColumn.current,  right: true },
                    { label: t.portfolio.page.copyColumn.return,   right: true },
                    { label: t.portfolio.page.copyColumn.actions,  right: true },
                  ]).map(({ label, right }) => (
                    <TableCell key={label} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5, textAlign: right ? 'right' : 'left' }}>
                      {label}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {copyRecs.map(rec => {
                  const unfKey = `unfollow_${rec.index}`;
                  // M1：一鍵平掉所有跟單倉位，任何一檔價格過期整筆都會 revert。
                  const unfStale = unfollowStaleNotice(rec.index);
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
                          disabled={busy[unfKey] || !!unfStale}
                          title={unfStale ?? undefined}
                          sx={{ fontWeight: 'bold' }}
                        >
                          {busy[unfKey] ? '…' : unfStale ? t.portfolio.page.unfollowStale : t.portfolio.page.unfollow}
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
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.portfolio.page.openPositions}
          </Typography>
          {/* The count lives here now rather than in its own card above a table
              that already shows every row. */}
          <Typography variant="caption" color="text.secondary">
            {interpolate(t.portfolio.page.openCount, { count: positions.length })}
          </Typography>
        </Box>

        {positions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4, fontStyle: 'italic' }}>
            {t.portfolio.page.noOpenPositions}
          </Typography>
        ) : mode === 'simple' ? (
          // Simple 只回答「我有什麼、現在好不好」——四欄,不解釋算法。想看
          // entry/oracle/leverage/funding 那一套,切到 Expert。欄位清單來自
          // openPositionColumnsForMode,跟它的測試共用同一份事實。
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {openPositionColumnsForMode('simple').map(key => (
                    <TableCell key={key} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5 }}>
                      {COLUMN_LABELS[key]}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.map(row => (
                  <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                    {openPositionColumnsForMode('simple').map(key => renderSimplePositionCell(key, row))}
                  </TableRow>
                ))}
              </TableBody>
              <tfoot style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  <TableCell colSpan={2} sx={{ fontWeight: 'bold', color: 'text.primary' }}>{t.portfolio.page.total}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                    {f18(positions.reduce((s, p) => s + p.currentValue, 0n))}
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: pnlColor(positions.reduce((s, p) => s + p.unrealizedPnL, 0n)) }}>
                    {fPnL(positions.reduce((s, p) => s + p.unrealizedPnL, 0n))}
                  </TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </TableContainer>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {/* Two prices sit side by side here and they rarely agree.
                      "Oracle" is what the contract settles against, so it is
                      the one Unr. PnL is computed from; "Live Market" is the
                      off-chain feed, which moves first. Without saying so, the
                      greener live figure reads like the real one and the PnL
                      looks wrong against it. Titles carry the explanation. */}
                  {([
                    [t.portfolio.column.asset, ''],
                    [t.portfolio.column.esg, ''],
                    [t.portfolio.column.side, ''],
                    [t.portfolio.column.entry, t.portfolio.columnHint.entry],
                    [t.portfolio.column.oracle, t.portfolio.columnHint.oracle],
                    [t.portfolio.column.liveMarket, t.portfolio.columnHint.liveMarket],
                    [t.portfolio.column.margin, ''],
                    [t.portfolio.column.leverage, ''],
                    [t.portfolio.column.copiedFrom, ''],
                    [t.portfolio.column.unrealizedPnl, t.portfolio.columnHint.unrealizedPnl],
                    [t.portfolio.column.accruedFunding, ''],
                    [t.portfolio.column.value, ''],
                  ] as const).map(([h, hint]) => (
                    <TableCell
                      key={h}
                      title={hint || undefined}
                      sx={{
                        color: 'text.secondary',
                        fontWeight: 'bold',
                        fontSize: '0.75rem',
                        py: 1.5,
                        ...(hint ? { cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 3 } : {}),
                      }}
                    >
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
                        label={row.isLong ? t.portfolio.page.side.long : t.portfolio.page.side.short}
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
                  <TableCell colSpan={8} sx={{ fontWeight: 'bold', color: 'text.primary' }}>{t.portfolio.page.total}</TableCell>
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

      {/* ─── Analysis (expert only) ─────────────────────────────────────── */}
      {mode === 'expert' && <PortfolioAnalysis rows={positions} esg={esg} />}

      {/* ─── C + D side-by-side ─────────────────────────────────────────── */}
      <Grid container spacing={3}>
        {/* C. Free Margin */}
        <Grid size={{ xs: 12, md: hasCopyHistory ? 6 : 12 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
              {t.portfolio.page.freeMargin}
            </Typography>
            <Box>
              <Typography variant="h3" sx={{ fontWeight: 800, fontFamily: MONO, color: 'primary.light' }}>
                {f18(freeMargin)}{' '}
                <Typography component="span" variant="subtitle1" color="text.secondary">{STABLE_LABEL}</Typography>
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <TextField
                placeholder={t.portfolio.page.amountPlaceholder}
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
                {busy['withdraw'] ? '…' : t.portfolio.page.withdraw}
              </Button>
            </Box>
          </Card>
        </Grid>

        {/* D. Performance Chart — only when there are two real points to plot. */}
        {hasCopyHistory && (
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                {t.portfolio.page.copyPerformance}
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
                      t.portfolio.page.chart.portfolioValue,
                    ]}
                  />
                  {totalInitial > 0n && (
                    <ReferenceLine
                      y={initVal}
                      stroke="#ffab00"
                      strokeDasharray="4 4"
                      label={{ value: t.portfolio.page.chart.initial, fill: '#ffab00', fontSize: 9, position: 'insideTopRight' }}
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
              {t.portfolio.page.autoRefresh}
            </Typography>
          </Card>
        </Grid>
        )}
      </Grid>
    </Container>
  );
}
