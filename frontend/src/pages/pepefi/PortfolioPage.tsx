import { MONO } from 'src/components/pepefi/brandKit'
import { parseEther } from 'ethers';
import { useRef, useState, useEffect, useCallback } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import {
  Line, XAxis, YAxis, Tooltip, LineChart,
  CartesianGrid, ReferenceLine, ResponsiveContainer,
} from 'recharts';

import { useESG } from 'src/hooks/useESG';
import { paths } from 'src/routes/paths';
import { useContracts } from 'src/hooks/useContracts';
import { kycActionMode, useVcKycRegistry } from 'src/hooks/useVcKycRegistry';
import { useLivePrices } from 'src/hooks/useLivePrices';

import { usePepefiWallet } from 'src/layouts/pepefi';
import { getAddresses } from 'src/contracts/deployment';
import { ASSET_IDS, CHAIN_NAMES } from 'src/contracts/addresses';
import { t, locale, interpolate } from 'src/locales';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import {
  isOutdated,
  readStopLoss,
  writeStopLoss,
  refreshCopyPath,
  stopLossReached,
  STOP_LOSS_CHOICES,
} from 'src/lib/pepefi/copyGuards';
import {
  isPriced,
  totalPnl,
  totalValue,
  toPortfolioRow,
  chainNowSec,
  cachedMaxPriceAge,
  readPosition,
  type PnlStatus,
  type PortfolioPositionRow,
} from 'src/lib/pepefi/positionPnl';
import { pnlStatusText } from 'src/lib/pepefi/positionFreshness';
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { firstBlocking, stalenessNotice } from 'src/lib/pepefi/priceFreshness';

import { useMode } from 'src/contexts/mode-context';
import { useAccountBalances } from 'src/hooks/useAccountBalances';
import { useLegacyAssets } from 'src/hooks/useLegacyAssets';
import { LegacyAssetsBanner } from 'src/components/pepefi/LegacyAssetsBanner';
import { spotValueOf, isPortfolioProvablyEmpty, type NetWorthParts, type PortfolioEmptinessCheck } from 'src/lib/pepefi/portfolio';
import { COLUMN_LABELS, columnLabelForMode, openPositionColumnsForMode, type OpenPositionColumnKey } from 'src/lib/pepefi/openPositionColumns';

import StatCard from 'src/components/pepefi/StatCard';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import NetWorthHero from 'src/components/pepefi/dashboard/NetWorthHero';
import RwaAllocation from 'src/components/pepefi/dashboard/RwaAllocation';
import { useSynthHoldings } from 'src/hooks/useSynthHoldings';
import { SHOW_PERPETUALS, FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { copyDeskVisibility } from 'src/lib/pepefi/copyDeskVisibility';
import { readAssetMode, isPriceTracked, closeBlockReason, closeAvailability, readOracleFreshness } from 'src/lib/pepefi/closeGuard';
import { SwitchChainButton } from 'src/components/pepefi/SwitchChainButton';
import KYCStatusCard from 'src/components/pepefi/dashboard/KYCStatusCard';
import QuickActions from 'src/components/pepefi/dashboard/QuickActions';
import PortfolioAnalysis from 'src/components/pepefi/dashboard/PortfolioAnalysis';
import CarbonTierMixCard from 'src/components/pepefi/CarbonTierMixCard';
import { holdingValue } from 'src/lib/pepefi/assetClass';
import { usePricingCarbonTiers } from 'src/hooks/usePricingCarbonTiers';
import EmptyState from 'src/components/pepefi/EmptyState';
import { useExecutionFee, formatEth } from 'src/hooks/useExecutionFee';
import { useAutoSyncSupport } from 'src/hooks/useAutoSyncSupport';
import { AutoSyncSettingsDialog, ResyncConfirmDialog, SyncGasDialog, SyncGasTank } from 'src/components/pepefi/copy/AutoSyncDialogs';
import {
  syncStatus,
  syncCostWei,
  sameAddress,
  versionLabel,
  clampLeverage,
  parseExecutor,
  resyncPreview,
  parseSyncState,
  parseSyncConfig,
  syncsAffordable,
  tankConsentBlocked,
  autoSyncConfigUnchanged,
  DEFAULT_TIP_WEI,
  DEFAULT_COOLDOWN,
  selfSyncShortfall,
  defaultPrefundWei,
  defaultMaxLeverage,
  AUTO_SYNC_MIN_INTERVAL,
  type SyncState,
  type SyncConfig,
  type SyncStatus,
  type ResyncPreview,
  type AutoSyncSettings,
} from 'src/lib/pepefi/autoSync';
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import MuiTooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Divider from '@mui/material/Divider';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { Icon } from '@iconify/react';
import { alpha } from '@mui/material/styles';
import { useToast } from 'src/components/pepefi/ToastProvider'

// ── Config ──────────────────────────────────────────────────────────────────

const SHORT_ADDR = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── Types ────────────────────────────────────────────────────────────────────

/** #146：現貨為預設頁籤，部位獨立第二頁籤。 */
type PortfolioTab = 'spot' | 'positions';

interface RawCopyRecord {
  trader:        string;
  versionId:     bigint;
  initialAmount: bigint;
  positionIds:   bigint[];
  copiedAt:      bigint;
  active:        boolean;
}

interface CopyRec {
  index:         number;
  trader:        string;
  traderName:    string;
  initialAmount: bigint;    // 18-dec
  copiedAt:      bigint;
  currentValue:  bigint;    // sum of getPositionValue for all positionIds
  /** 這筆 active 跟單底下的部位——平倉按鈕據此判斷哪些部位要走「取消跟單」。 */
  positionIds:   bigint[];
  versionId:     bigint;
  /** 交易者目前發布過幾版（getStrategyCount）；讀不到時為 null，就不標示「已更新」。 */
  strategyCount: bigint | null;
  /** ADR-024：交易者最新版有幾檔（估同步成本用）；合約不支援自動同步或讀不到時為 null。 */
  latestLegs:    number | null;
  syncConfig:    SyncConfig | null;
  syncState:     SyncState | null;
  /** 跟隨者開啟自動同步時同意的每腿執行費（syncExecFeeCap）；讀不到為 null。 */
  execFeeCap:    bigint | null;
  /** 指定的執行者（syncExecutor）；null = 任何人，或合約沒有這項設定。 */
  executor:      string | null;
}

/** 「立即同步」確認視窗：開啟時讀一次交易者最新版，按下確認就釘住那一版送出。 */
interface ResyncTarget {
  rec:      CopyRec;
  loading:  boolean;
  error:    string | null;
  version:  bigint | null;
  preview:  ResyncPreview | null;
  /** 目前部位的最高槓桿。 */
  heldMax:  number;
}

/** 設定彈窗開著時的內容：哪一筆、開關、設定。打開時算好一次，彈窗裡不再跟著重讀變動。 */
interface SyncSettingsTarget {
  rec:      CopyRec;
  enabled:  boolean;
  settings: AutoSyncSettings;
}

/** ethers v6 把認得的 custom error 名稱放在 revert.name；退而求其次看訊息字串。 */
const revertIs = (e: unknown, name: string): boolean => {
  const err = e as { revert?: { name?: string } | null; shortMessage?: string; message?: string };
  return err?.revert?.name === name || `${err?.shortMessage ?? ''} ${err?.message ?? ''}`.includes(name);
};

/** 見 lib/pepefi/positionPnl.ts：終端機與這頁共用同一個讀取與損益定義。 */
type PosRow = PortfolioPositionRow;

// ── Formatting ────────────────────────────────────────────────────────────────
const f18   = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d);
const fUsd  = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
const fPnL      = (v: bigint) => (Number(v) >= 0 ? '+' : '') + f18(v, 4) + ' ' + STABLE_LABEL;
const pnlColor  = (v: bigint | null) => v === null ? 'text.secondary' : Number(v) >= 0 ? 'success.main' : 'error.main';

/**
 * 部位讀不出數字（讀取失敗、無有效價格、價格過期）時的儲存格內容：「—」加原因，
 * 滑過看說明。絕不補 0——見 lib/pepefi/positionPnl.ts。
 */
function NoFigure({ status }: { status: PnlStatus }) {
  const why = pnlStatusText(status);
  return (
    <MuiTooltip title={why?.hint ?? ''}>
      <Typography component="span" variant="caption" sx={{ color: 'text.secondary', cursor: 'help', fontFamily: MONO }}>
        — {why?.label}
      </Typography>
    </MuiTooltip>
  );
}

/** 合計：任何一列沒有數字就是 null（顯示「—」），不把讀不到的列當 0 加進去。 */
const sumOrNull = (vals: readonly (bigint | null)[]): bigint | null =>
  vals.some((v) => v === null) ? null : vals.reduce<bigint>((s, v) => s + (v as bigint), 0n);
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
        <TableCell key={key} sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.unrealizedPnL) }}>
          {row.currentValue === null ? <NoFigure status={row.status} /> : f18(row.currentValue)}
        </TableCell>
      );
    case 'unrealizedPnl':
      return (
        <TableCell key={key} sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', color: pnlColor(row.unrealizedPnL) }}>
          {row.unrealizedPnL === null ? <NoFigure status={row.status} /> : fPnL(row.unrealizedPnL)}
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
  const pricingTiers = usePricingCarbonTiers(contracts?.exchange ?? null);
  // 交易所的 KYC 登錄是 VC 登錄（專屬租戶 schema v4 的 kycRegistry=vc）時，「去取得資格」走憑證頁。
  const vcKyc = useVcKycRegistry(wallet.chainId, wallet.provider);
  const kycAction = kycActionMode(vcKyc, contracts ? String(contracts.kycRegistry.target) : null);
  const livePrices = useLivePrices();
  const { data: esg } = useESG(contracts?.esgRegistry ?? null);
  // 代幣化資產持倉——RWA 配置環的另一半來源，見 RwaAllocation 的 props 註解。
  const synthHoldings = useSynthHoldings();

  // 錢包／質押／金庫。這一頁本來只讀 freeMargin，因為它只管交易帳戶；淨值
  // hero 從 Dashboard 併過來之後就需要另外三桶錢。
  const balances = useAccountBalances(contracts, wallet.address);

  // 舊版 exchange 上的資產（重部署前留下的保證金／部位）。只有真的有東西時才在上方
  // 顯示通往 /legacy 的提示，見 LegacyAssetsBanner。展示通道讀不到鏈，不掃。
  const legacyAssets = useLegacyAssets(wallet.isMock ? null : wallet.provider, wallet.chainId, wallet.address);

  const [copyRecs,   setCopyRecs]   = useState<CopyRec[]>([]);
  const [positions,  setPositions]  = useState<PosRow[]>([]);
  const [freeMargin, setFreeMargin] = useState(0n);
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [isLoaded,   setIsLoaded]   = useState(false);

  // #146：預設停在現貨。刻意不記住上次選的頁籤——這一頁回答「我現在怎麼樣」，
  // 而平台預設的答案是現貨；記住選擇會讓一個只買現貨的人某次點進部位之後，
  // 往後每次進來都先看到一個跟他無關的表。
  const [tab, setTab] = useState<PortfolioTab>('spot');

  // 這三項各自成功與否,獨立於它們讀失敗時退回的預設值([]、[]、0n)。
  // 「空投資組合」的判斷需要知道「讀失敗」跟「讀到、真的是空」的差別——
  // 兩者的數值長得一樣,但意義完全不同。見 lib/pepefi/portfolio.ts 的
  // isPortfolioProvablyEmpty。
  const [copyRecsOk,   setCopyRecsOk]   = useState(false);
  const [positionsOk,  setPositionsOk]  = useState(false);
  /** getPosition 讀不到的部位數（審查 L5）。>0 時淨資產與合計標成不完整。 */
  const [positionsUnread, setPositionsUnread] = useState(0);
  const [freeMarginOk, setFreeMarginOk] = useState(false);

  const [busy,  setBusy]  = useState<Record<string, boolean>>({});
  const { notify } = useToast();

  // ADR-024 自動同步：合約支援才讀、才顯示。油箱是帳戶層級（每個跟隨者一個），不是每筆跟單一個。
  const autoSync = useAutoSyncSupport(contracts?.copyTracker ?? null, wallet.provider);
  const execFee = useExecutionFee(contracts?.exchange ?? null);
  const [syncGas, setSyncGas] = useState<bigint | null>(null);
  const [syncSettingsFor, setSyncSettingsFor] = useState<SyncSettingsTarget | null>(null);
  const [gasDialog, setGasDialog] = useState<'deposit' | 'withdraw' | null>(null);
  const [resyncTarget, setResyncTarget] = useState<ResyncTarget | null>(null);

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));

  // 每筆跟單的停損提醒比例。只存在這個瀏覽器（見 copyGuards），不是鏈上狀態。
  const [stopLoss, setStopLoss] = useState<Record<number, number | null>>({});
  useEffect(() => {
    if (!wallet.address) return;
    const account = wallet.address;
    setStopLoss(Object.fromEntries(copyRecs.map(r => [r.index, readStopLoss(account, r.index)])));
  }, [copyRecs, wallet.address]);
  const changeStopLoss = (index: number, value: number | null) => {
    if (!wallet.address) return;
    writeStopLoss(wallet.address, index, value);
    setStopLoss(prev => ({ ...prev, [index]: value }));
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const refreshExecFee = execFee.refresh;
  const fetchAll = useCallback(async () => {
    // 執行費跟著重讀（owner 隨時可能調整）：同意的費率提示與油箱估算都靠它（ADR-024）
    refreshExecFee();
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
      const countMap: Record<string, bigint | null> = {};
      await Promise.all(
        uniqueTraders.map(async ta => {
          try { countMap[ta] = (await contracts.registry.getStrategyCount(ta)) as bigint; }
          catch { countMap[ta] = null; }
        })
      );

      // 自動同步版合約：每位交易者最新版有幾檔（同步成本 = 每檔一份 executionFee）
      const legsMap: Record<string, number | null> = {};
      if (autoSync.supported) {
        await Promise.all(
          uniqueTraders.map(async ta => {
            try {
              const latest = (await contracts.registry.getLatestStrategy(ta)) as unknown as [unknown[], bigint];
              legsMap[ta] = latest[0].length;
            } catch { legsMap[ta] = null; }
          })
        );
      }
      const readSync = async (i: number): Promise<[SyncConfig | null, SyncState | null, bigint | null, string | null]> => {
        if (!autoSync.supported) return [null, null, null, null];
        const [cfg, st, cap, ex] = await Promise.all([
          (contracts.copyTracker.syncConfig(addr, BigInt(i)) as Promise<unknown>).then(parseSyncConfig).catch(() => null),
          (contracts.copyTracker.getSyncState(addr, BigInt(i)) as Promise<unknown>).then(parseSyncState).catch(() => null),
          // 交易所 executionFee 高於這個值時，別人不能代為同步（要本人重新同意）
          (contracts.copyTracker.syncExecFeeCap(addr, BigInt(i)) as Promise<bigint>).then(v => BigInt(v)).catch(() => null),
          autoSync.executorLock
            ? (contracts.copyTracker.syncExecutor(addr, BigInt(i)) as Promise<unknown>).then(parseExecutor).catch(() => null)
            : Promise.resolve(null),
        ]);
        return [cfg, st, cap, ex];
      };

      const getVal = async (id: bigint): Promise<bigint> => {
        try { return (await contracts.exchange.getPositionValue(id)) as bigint; }
        catch { return 0n; }
      };

      const enriched = await Promise.all(
        rawRecs.map(async (rec, i): Promise<CopyRec | null> => {
          if (!rec.active) return null;
          const [vals, [cfg, st, cap, ex]] = await Promise.all([
            Promise.all(rec.positionIds.map(id => getVal(id))),
            readSync(i),
          ]);
          return {
            index:         i,
            trader:        rec.trader,
            traderName:    nameMap[rec.trader] ?? '',
            initialAmount: rec.initialAmount,
            copiedAt:      rec.copiedAt,
            currentValue:  vals.reduce((s, v) => s + v, 0n),
            positionIds:   [...rec.positionIds],
            versionId:     rec.versionId,
            strategyCount: countMap[rec.trader] ?? null,
            latestLegs:    legsMap[rec.trader] ?? null,
            syncConfig:    cfg,
            syncState:     st,
            execFeeCap:    cap,
            executor:      ex,
          };
        })
      );
      return enriched.filter((r): r is CopyRec => r !== null);
    })(), [] as CopyRec[], 'copy records');
    setCopyRecs(copyRecsResult.value);
    setCopyRecsOk(copyRecsResult.ok);

    // 油箱餘額：讀不到就是 null（顯示「—」），不當成 0
    setSyncGas(autoSync.supported
      ? await (contracts.copyTracker.syncGasBalance(addr) as Promise<bigint>).catch(() => null)
      : null);

    const positionsResult = await trackedRead((async (): Promise<PosRow[]> => {
      const posIds = (await contracts.exchange.getUserPositions(addr)) as bigint[];

      // 每個部位一個 readOpenPosition（getPosition 之後四個 view 併發，各自隔離）。
      // 終端機的持倉表也走同一個函式，所以同一個部位兩頁的未實現損益一定一樣：
      // 合約 getPositionValue − 保證金。見 lib/pepefi/positionPnl.ts。
      // maxPriceAge 有 10 分鐘快取；判斷價格過期用最新區塊時間（與合約一致）。兩者並行讀。
      const [maxPriceAgeSec, nowSec] = await Promise.all([
        cachedMaxPriceAge(contracts.exchange),
        chainNowSec(contracts.exchange),
      ]);
      const results = await Promise.all(
        // 投資組合不顯示標記價，不讀 getMarkPrice（每個部位省一次 RPC）。
        posIds.map((id) => readPosition(contracts, id, { withMarkPrice: false, maxPriceAgeSec, nowSec })),
      );
      // getPosition 本身讀不到的部位：不能悄悄從列表與淨資產裡消失（審查 L5）。
      setPositionsUnread(results.filter((r) => r.kind === 'failed').length);
      const maybeRows: (PosRow | null)[] = results.map((r) => (r.kind === 'open' ? toPortfolioRow(r.row) : null));
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
  }, [contracts, wallet.address, notify, autoSync.supported, autoSync.executorLock, refreshExecFee]);

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

  // 「更新到最新版」：只用在合約不支援自動同步（ADR-024）時——舊版合約不做持續跟隨，換版本
  // 就是取消舊的、重新跟一次（支援時改走本人 resyncAtVersion）。取消跟單後
  // 取回的錢回到交易所的可用保證金，不是錢包；跟單合約是從錢包扣款，所以要先提回錢包。
  const doRefreshCopy = async (rec: CopyRec) => {
    if (!contracts || !wallet.address) return;
    const blocked = unfollowStaleNotice(rec.index);
    if (blocked) { notify(blocked, false); return; }
    const key = `refresh_${rec.index}`;
    setLoad(key, true);
    try {
      const before = (await contracts.exchange.freeMargin(wallet.address)) as bigint;
      await asTx(await contracts.copyTracker.unfollowAndCloseAll(BigInt(rec.index))).wait();
      const after = (await contracts.exchange.freeMargin(wallet.address)) as bigint;
      const returned = after > before ? after - before : 0n;
      if (returned > 0n) {
        const tx = asTx(await contracts.exchange.withdrawMargin(returned));
        await tx.wait();
        notify(interpolate(t.portfolio.page.copyRefreshStep, { amount: f18(returned) }), true, tx.hash);
      }
      navigate(refreshCopyPath(rec.trader, returned));
    } catch (e) {
      notify(prettyError(e), false);
      await fetchAll();
    } finally { setLoad(key, false); }
  };

  // ── 自動同步（ADR-024） ────────────────────────────────────────────────────
  // 「立即同步」分兩步：先開確認視窗（openResync）讀交易者最新版、顯示每一檔的資產、方向、比重、
  // 實際槓桿（策略、資產上限、自己的上限三者取小）與費用；按下確認才送出 doResync，釘住的就是
  // 視窗裡顯示的那一版——跟隨者真的看過他同意的內容，不只是版號。
  const openResync = async (rec: CopyRec) => {
    if (!contracts) return;
    // 同步會先平掉這筆跟單底下的每一個部位：任何一檔價格過期整筆都會 revert（與取消跟單同一條規則）
    const blocked = unfollowStaleNotice(rec.index);
    if (blocked) { notify(blocked, false); return; }
    const held = positions.filter(p => rec.positionIds.includes(p.id));
    const heldMax = held.reduce((m, p) => Math.max(m, Number(p.leverage)), 0);
    setResyncTarget({ rec, loading: true, error: null, version: null, preview: null, heldMax });
    try {
      const [rawAllocs, version] = (await contracts.registry.getLatestStrategy(rec.trader)) as unknown as [
        { asset: string; weight: bigint; isLong: boolean; leverage: bigint }[],
        bigint,
      ];
      const allocs = [...rawAllocs];
      const num = (p: Promise<unknown>) => p.then(v => Number(v)).catch(() => null);
      const legs = await Promise.all(allocs.map(async (a) => ({
        asset:            String(a.asset),
        weight:           BigInt(a.weight),
        isLong:           Boolean(a.isLong),
        strategyLeverage: Number(a.leverage),
        assetMaxLeverage: await num(contracts.exchange.maxLeverageForAsset(a.asset) as Promise<unknown>),
        tradingFeeBps:    await num(contracts.exchange.tradingFeeBpsForAsset(a.asset) as Promise<unknown>),
      })));
      const perfBps = await num(contracts.exchange.PERFORMANCE_FEE_BPS() as Promise<unknown>);
      const preview = resyncPreview({
        legs,
        followerMax:       rec.syncConfig?.maxLeverage ?? 0,
        executionFee:      execFee.wei,
        tankBalance:       syncGas,
        currentLegs:       held.map(p => ({ value: p.currentValue, pnl: p.unrealizedPnL, leverage: Number(p.leverage) })),
        performanceFeeBps: perfBps ?? undefined,
      });
      setResyncTarget(cur => (cur?.rec.index === rec.index ? { ...cur, loading: false, version, preview } : cur));
    } catch (e) {
      console.error('[portfolio] read latest strategy for resync', e);
      setResyncTarget(cur => (cur?.rec.index === rec.index ? { ...cur, loading: false, error: t.portfolio.autoSync.confirm.loadFailed } : cur));
    }
  };

  // 「立即同步」送出：本人呼叫 resyncAtVersion，不付小費、不受冷卻限制，部位就地換成確認視窗裡的那一版
  // （平舊腿、只用平倉釋出的保證金開新腿，任何一腿開不起來就整筆 revert、維持舊版）。釘住版本：
  // 交易者在按下之前又發了一版，合約 revert StrategyVersionMismatch，不會直接採用沒看過的版本。
  // 執行費一樣從油箱扣；resyncAtVersion 是 payable，附帶的 ETH 先存進油箱——所以油箱不夠時把差額
  // 附在同一筆交易上，而且是先模擬過、確定只差油箱才附，不會為了一筆本來就會失敗的同步多存 ETH。
  // 執行費也釘住：畫面上顯示的每檔執行費（execFee.wei）就是簽名帶入的上限（maxExecFeePerLeg）。
  // 交易所 owner 在按下前調高費率，合約整筆 revert ExecutionFeeAboveCap、油箱不動。
  const doResync = async (rec: CopyRec, expectedVersion: bigint, legs: number | null) => {
    if (!contracts || !wallet.address) return;
    const blocked = unfollowStaleNotice(rec.index);
    if (blocked) { notify(blocked, false); return; }
    const key = `resync_${rec.index}`;
    setLoad(key, true);
    const follower = wallet.address;
    const idx = BigInt(rec.index);
    const maxExecFeePerLeg = execFee.wei;
    try {
      let topUp = 0n;
      try {
        await contracts.copyTracker.resyncAtVersion.staticCall(idx, expectedVersion, maxExecFeePerLeg);
      } catch (e) {
        if (!revertIs(e, 'InsufficientSyncGas') || legs === null) throw e;
        const fee = (await contracts.exchange.executionFee()) as bigint;
        const balance = (await contracts.copyTracker.syncGasBalance(follower)) as bigint;
        topUp = selfSyncShortfall(balance, fee, legs);
        if (topUp === 0n) throw e;
        // 附上差額再模擬一次：還是失敗就是別的原因（KYC、休市…），不送
        await contracts.copyTracker.resyncAtVersion.staticCall(idx, expectedVersion, maxExecFeePerLeg, { value: topUp });
        notify(interpolate(t.portfolio.autoSync.topUpFirst, { eth: formatEth(topUp) }), true);
      }
      const tx = asTx(await contracts.copyTracker.resyncAtVersion(idx, expectedVersion, maxExecFeePerLeg, { value: topUp }));
      await tx.wait();
      notify(t.portfolio.autoSync.synced, true, tx.hash);
      setResyncTarget(null);
    } catch (e) {
      notify(prettyError(e), false);
    } finally {
      setLoad(key, false);
      await fetchAll();
    }
  };

  /** 打開設定彈窗：沒開過的跟單用最保守的預設（槓桿上限 = 這筆跟單目前部位的最高槓桿）。 */
  const openSyncSettings = (rec: CopyRec) => {
    refreshExecFee();
    const cfg = rec.syncConfig;
    const held = positions.filter(p => rec.positionIds.includes(p.id)).map(p => p.leverage);
    const configured = cfg !== null && cfg.maxLeverage > 0;
    setSyncSettingsFor({
      rec,
      enabled: cfg?.autoSync ?? false,
      settings: {
        maxLeverage:     configured ? clampLeverage(cfg.maxLeverage) : defaultMaxLeverage(held),
        // 關閉時存過的冷卻可能是 0（合約允許）；重新開啟時從最保守的預設開始
        minSyncInterval: configured && cfg.minSyncInterval >= AUTO_SYNC_MIN_INTERVAL ? cfg.minSyncInterval : DEFAULT_COOLDOWN,
        tipWei:          configured ? cfg.tipWei : DEFAULT_TIP_WEI,
      },
    });
  };

  /**
   * 儲存自動同步設定。`executor`（'' = 任何人）有給、而且與鏈上不同時，接著送 setSyncExecutor；
   * 設定本身沒變（含同意的執行費仍是現行費率）就不重送 setAutoSync。
   */
  const doSaveAutoSync = async (rec: CopyRec, enabled: boolean, s: AutoSyncSettings, executor?: string) => {
    if (!contracts) return;
    const key = `autosync_${rec.index}`;
    setLoad(key, true);
    let configSaved = false;
    try {
      // 關閉時合約照樣檢查參數範圍：沿用目前的值，夾進合法範圍
      const tip = s.tipWei > autoSync.maxTipWei ? autoSync.maxTipWei : s.tipWei;
      const lev = clampLeverage(s.maxLeverage);
      const cur = rec.syncConfig;
      // 與設定彈窗的「你目前同意」同一個判斷（autoSyncConfigUnchanged）。讀不到執行費時不拿費率比較：
      // 那時彈窗只讓「設定沒變」的儲存通過（例如只改指定執行者），不會用後備值簽出同意的上限。
      const unchanged = autoSyncConfigUnchanged({
        current: cur,
        enabled,
        settings: { maxLeverage: lev, minSyncInterval: s.minSyncInterval, tipWei: tip },
        consentedFee: rec.execFeeCap,
        executionFee: execFee.loaded ? execFee.wei : null,
      });
      if (!unchanged) {
        // 開啟／修改時，畫面上顯示的每檔執行費就是同意的上限：交易所在送出前調高費率會整筆
        // revert ExecutionFeeAboveCap，不會把調高後的費率記成同意值。關閉不看費率（帶 0）。
        const maxExecFeePerLeg = enabled ? execFee.wei : 0n;
        const tx = asTx(await contracts.copyTracker.setAutoSync(
          BigInt(rec.index), enabled, lev, s.minSyncInterval, tip, maxExecFeePerLeg,
        ));
        await tx.wait();
        notify(enabled ? t.portfolio.autoSync.saved : t.portfolio.autoSync.disabledOk, true, tx.hash);
      }
      configSaved = true;
      const wanted = executor === undefined ? undefined : executor === '' ? null : executor;
      if (wanted !== undefined && autoSync.executorLock && !(wanted === null ? rec.executor === null : sameAddress(wanted, rec.executor))) {
        const tx = asTx(await contracts.copyTracker.setSyncExecutor(BigInt(rec.index), wanted ?? '0x0000000000000000000000000000000000000000'));
        await tx.wait();
        notify(t.portfolio.autoSync.executorSaved, true, tx.hash);
      } else if (unchanged) {
        notify(enabled ? t.portfolio.autoSync.saved : t.portfolio.autoSync.disabledOk, true);
      }
      setSyncSettingsFor(null);
    } catch (e) {
      notify(configSaved ? `${t.portfolio.autoSync.executorFailed} ${prettyError(e)}` : prettyError(e), false);
    } finally {
      setLoad(key, false);
      await fetchAll();
    }
  };

  const doSyncGas = async (mode: 'deposit' | 'withdraw', wei: bigint) => {
    if (!contracts) return;
    setLoad('syncGas', true);
    try {
      const tx = asTx(mode === 'deposit'
        ? await contracts.copyTracker.depositSyncGas({ value: wei })
        : await contracts.copyTracker.withdrawSyncGas(wei));
      await tx.wait();
      notify(interpolate(mode === 'deposit' ? t.portfolio.autoSync.tank.deposited : t.portfolio.autoSync.tank.withdrawn, {
        eth: formatEth(wei),
      }), true, tx.hash);
      setGasDialog(null);
    } catch (e) {
      notify(prettyError(e), false);
    } finally {
      setLoad('syncGas', false);
      await fetchAll();
    }
  };

  // 自己的部位直接在這裡平倉。SHOW_PERPETUALS 關閉時終端機沒有入口，這是使用者
  // 唯一看得到、按得到的平倉路徑。送出前先檢查價格新鮮度與 AssetMode（新版合約
  // 才有；舊合約讀不到就略過），兩者在鏈上都會 revert，先擋才能把原因講清楚。
  // 雙擊防護：setLoad 是 state，要等重繪按鈕才變 disabled；同一個 tick 的第二下
  // 會穿過去。ref 是同步的，第一下進來就先佔位，檢查失敗再放開。
  const closingRef = useRef<Set<string>>(new Set());
  const doClose = async (row: PosRow) => {
    if (!contracts) return;
    const key = `close_${String(row.id)}`;
    if (closingRef.current.has(key)) return;
    closingRef.current.add(key);
    setLoad(key, true);
    try {
      const label = ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8);
      const mode = await readAssetMode(
        String(contracts.exchange.target),
        wallet.provider ?? contracts.exchange.runner,
        row.asset
      );
      // useLivePrices 只輪詢 ASSET_IDS（+ PEPE）。前端資產表以外的舊部位永遠不會有
      // 輪詢價格——那種就直接讀 oracle 算新鮮度；讀不到就放行，交給合約 revert 並顯示原因。
      const tracked = isPriceTracked(row.asset, Object.values(ASSET_IDS));
      const freshness = tracked
        ? livePrices[row.asset]?.freshness
        : await readOracleFreshness(contracts.oracle, contracts.exchange, row.asset, Math.floor(Date.now() / 1000));
      const blocked = closeBlockReason({ freshness, assetLabel: label, assetMode: mode, tracked });
      if (blocked) { notify(blocked, false); return; }
      const tx = asTx(await contracts.exchange.closePosition(row.id));
      await tx.wait();
      notify(t.portfolio.close.closed, true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally {
      closingRef.current.delete(key);
      setLoad(key, false);
    }
  };

  // 仍 active 的跟單紀錄底下的部位 id。跟單紀錄讀取失敗時是 null——不知道哪些
  // 該走「取消跟單」，就一筆都不擋（見 closeAvailability）。
  const activeCopyPositionIds: ReadonlySet<string> | null = copyRecsOk
    ? new Set(copyRecs.flatMap(r => r.positionIds.map(String)))
    : null;

  // 「跟單來源」欄：跟單旗標關閉時，只有真的有跟單留下的部位才顯示——否則一整欄
  // 的「—」只是在商業版畫面上介紹一個不存在的功能。
  const showCopiedFrom =
    FEATURE_COPY_TRADING ||
    positions.some(p => !!p.copiedFrom && p.copiedFrom !== '0x0000000000000000000000000000000000000000');

  const renderCloseCell = (row: PosRow) => {
    const availability = closeAvailability(row, activeCopyPositionIds);
    if (availability === 'managed') {
      // 跟單開的部位不能單獨平倉。以前把整句說明塞在這一格，折成好幾行、每一列都被撐得很高；
      // 改成一個短標籤，完整說明放在滑鼠移上去的提示。
      return (
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          <MuiTooltip title={t.portfolio.close.copyManaged}>
            <Chip size="small" variant="outlined" label={t.portfolio.close.copyManagedShort} sx={{ cursor: 'help', fontSize: '0.75rem' }} />
          </MuiTooltip>
        </TableCell>
      );
    }
    const busyNow = !!busy[`close_${String(row.id)}`];
    return (
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        <Button
          size="small"
          variant="outlined"
          color="error"
          disabled={busyNow}
          onClick={() => void doClose(row)}
          sx={{ textTransform: 'none', minWidth: 64 }}
        >
          {busyNow ? t.portfolio.close.closing : t.portfolio.close.button}
        </Button>
        {availability === 'leftover' && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'normal', mt: 0.5 }}>
            {t.portfolio.close.leftover}
          </Typography>
        )}
      </TableCell>
    );
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
  // 有部位讀不到時，鎖住的保證金也不完整：交給 netWorthOf 標成「此總額不完整」。
  const lockedMargin = positionsUnread > 0 ? null : positions.reduce((s, p) => s + p.margin, 0n);
  // 任何部位讀不出數字就是 null：淨資產會標成「此總額不完整」，而不是把它當 0 加進去。
  const unrealisedPnl = positionsUnread > 0 ? null : totalPnl(positions.map((p) => ({ pnl: p.unrealizedPnL })));
  const positionsValueTotal = positionsUnread > 0 ? null : totalValue(positions.map((p) => ({ value: p.currentValue })));
  const fundingTotal = sumOrNull(positions.map((p) => p.accruedFunding));
  const pricedPositions = positions.filter(isPriced);

  // 現貨代幣（/tokens 買的 sGOLD、sBOND…）以 oracle 價計入淨值。讀取中當成 null
  // （不完整），讀到餘額但缺價的那幾檔由 spotUnpriced 帶出「此總額不完整」。
  const spot = spotValueOf(
    synthHoldings.loading ? null : synthHoldings.rows,
    synthHoldings.readFailures
  );

  const netWorthParts: NetWorthParts = {
    walletCash:    balances.walletCash,
    freeMargin,
    lockedMargin,
    unrealisedPnl,
    staked:        balances.staked,
    vault:         balances.vault,
    spotHoldings:  spot.value,
    spotUnpriced:  spot.unpriced,
  };

  const notionalTotal = positions.reduce((s, p) => s + p.margin * p.leverage, 0n);
  const pnlPctStr = notionalTotal > 0n && unrealisedPnl !== null
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
  const copyDesk = copyDeskVisibility(mode, copyRecs.length, FEATURE_COPY_TRADING);
  const showCopyPerformance = copyDesk.performance && totalInitial > 0n;

  const chartData = [
    { name: t.portfolio.page.chart.deposited, value: initVal },
    { name: t.portfolio.page.chart.now,       value: curVal  },
  ];

  // ── 自動同步（ADR-024）：油箱估算與彈窗 ─────────────────────────────────────
  // 估算用最保守的組合：所有跟單裡最多的檔數、開了自動同步的那幾筆裡最高的小費。
  const syncLegs = copyRecs.reduce((m, r) => Math.max(m, r.latestLegs ?? r.positionIds.length), 0);
  const enabledTips = copyRecs.flatMap(r => (r.syncConfig?.autoSync ? [r.syncConfig.tipWei] : []));
  const topTip = enabledTips.reduce<bigint>((m, v) => (v > m ? v : m), 0n);
  const tankAffordable = syncGas !== null && enabledTips.length > 0 && syncLegs > 0
    ? syncsAffordable(syncGas, syncCostWei(execFee.wei, syncLegs, topTip, false))
    : null;
  const tankBlocked = tankConsentBlocked(
    copyRecs.map(r => ({ autoSync: r.syncConfig?.autoSync ?? false, execFeeCap: r.execFeeCap })),
    execFee.loaded ? execFee.wei : null,
  );
  const suggestedDeposit = defaultPrefundWei(execFee.wei, Math.max(1, syncLegs), enabledTips.length > 0 ? topTip : DEFAULT_TIP_WEI);
  // 油箱有餘額就一定看得到、提得出來——就算已經沒有任何跟單、或跟單旗標關閉（退出不藏）。
  const hasTankBalance = syncGas !== null && syncGas > 0n;
  const nowSec = Math.floor(Date.now() / 1000);
  const syncStatusText = (st: SyncStatus, syncOn: boolean): string => {
    const S = t.portfolio.autoSync.status;
    switch (st.kind) {
      case 'cooldown':    return interpolate(S.cooldown, { time: fDate(BigInt(st.readyAt)) });
      case 'needsGas':    return interpolate(S.needsGas, { eth: formatEth(st.shortfall) });
      // Simple 模式沒有「開啟自動同步」、「設定」與「立即同步」的入口（設定含槓桿上限），狀態文字不叫人去按它們；
      // 跟單頁在 Simple 模式也一樣只說明、不給勾選框（autoSyncEntry）
      case 'manual':      return mode === 'simple' ? S.manualSimple : S.manual;
      case 'feeAboveCap': return mode === 'simple' ? S.feeAboveCapSimple : S.feeAboveCap;
      case 'consentStale': return mode === 'simple' ? S.consentStaleSimple : S.consentStale;
      case 'upToDate':    return mode === 'simple' && !syncOn ? S.upToDateSimpleOff : S.upToDate;
      default:            return S[st.kind];
    }
  };
  const tank = (
    <SyncGasTank
      balance={syncGas}
      affordable={tankAffordable}
      consentBlocked={tankBlocked}
      busy={!!busy['syncGas']}
      onDeposit={() => setGasDialog('deposit')}
      onWithdraw={() => setGasDialog('withdraw')}
    />
  );
  const syncDialogs = autoSync.supported && (
    <>
      <SyncGasDialog
        open={gasDialog !== null}
        mode={gasDialog ?? 'deposit'}
        onClose={() => setGasDialog(null)}
        balance={syncGas}
        suggested={suggestedDeposit}
        busy={!!busy['syncGas']}
        onSubmit={(wei) => { if (gasDialog) void doSyncGas(gasDialog, wei); }}
      />
      <AutoSyncSettingsDialog
        open={syncSettingsFor !== null}
        onClose={() => setSyncSettingsFor(null)}
        initialEnabled={syncSettingsFor?.enabled ?? false}
        initialSettings={syncSettingsFor?.settings ?? { maxLeverage: 1, minSyncInterval: DEFAULT_COOLDOWN, tipWei: DEFAULT_TIP_WEI }}
        maxTipWei={autoSync.maxTipWei}
        executionFee={execFee.wei}
        executionFeeLoaded={execFee.loaded}
        consentedFee={syncSettingsFor?.rec.execFeeCap ?? null}
        legs={syncSettingsFor?.rec.latestLegs ?? syncSettingsFor?.rec.positionIds.length ?? 0}
        tankBalance={syncGas}
        showLeverage={mode === 'expert'}
        busy={syncSettingsFor !== null && !!busy[`autosync_${syncSettingsFor.rec.index}`]}
        executor={autoSync.executorLock && mode === 'expert'
          ? { initial: syncSettingsFor?.rec.executor ?? '', follower: wallet.address ?? null }
          : undefined}
        onSave={(enabled, settings, executor) => {
          if (syncSettingsFor) void doSaveAutoSync(syncSettingsFor.rec, enabled, settings, executor);
        }}
      />
      <ResyncConfirmDialog
        open={resyncTarget !== null}
        onClose={() => setResyncTarget(null)}
        loading={resyncTarget?.loading ?? false}
        error={resyncTarget?.error ?? null}
        version={resyncTarget?.version ?? null}
        preview={resyncTarget?.preview ?? null}
        currentMaxLeverage={resyncTarget?.heldMax ?? 0}
        busy={resyncTarget !== null && !!busy[`resync_${resyncTarget.rec.index}`]}
        onConfirm={() => {
          if (resyncTarget && resyncTarget.version !== null) {
            // 確認視窗顯示的那一版有幾檔，就付幾份執行費（不用頁面載入時讀的檔數，交易者可能已經又發一版）
            void doResync(resyncTarget.rec, resyncTarget.version, resyncTarget.preview?.legs.length ?? null);
          }
        }}
      />
    </>
  );

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
          {t.portfolio.page.connectedTo}<Typography component="span" sx={{ color: 'warning.main', fontFamily: MONO }}>{name}</Typography>{t.portfolio.page.connectedToAfter}<br />
          {t.portfolio.page.switchTo}<Typography component="span" sx={{ color: 'primary.main', fontFamily: MONO }}>Base Sepolia</Typography>{t.portfolio.page.switchToAfter}
        </Typography>
        <SwitchChainButton />
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
  if (!isLoaded || !balances.settled || synthHoldings.loading) {
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
    spotHoldingsCount: synthHoldings.readFailures === 0 ? synthHoldings.rows.length : null,
    copyRecordsCount: copyRecsOk   ? copyRecs.length  : null,
    positionsCount:   positionsOk  ? positions.length : null,
    freeMargin:       freeMarginOk ? freeMargin       : null,
    walletCash:       balances.walletCash,
    staked:           balances.staked,
    vault:            balances.vault,
  };

  if (isLoaded && isPortfolioProvablyEmpty(emptinessCheck)) {
    // 新合約上是空的，不代表使用者沒有錢——資產可能全在舊合約上，那正是最需要
    // 看到入口的人。提示放在空狀態上方。
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 3 }}>
        <Box sx={{ width: '100%' }}><LegacyAssetsBanner state={legacyAssets} /></Box>
        {autoSync.supported && hasTankBalance && (
          <Card sx={{ p: 2.5, width: '100%', border: '1px solid', borderColor: 'divider' }}>{tank}</Card>
        )}
        {syncDialogs}
        <EmptyState
          icon="💼"
          title={t.portfolio.page.emptyTitle}
          description={interpolate(
            FEATURE_COPY_TRADING ? t.portfolio.page.emptyDescription : t.portfolio.page.emptyDescriptionNoCopy,
            { token: STABLE_LABEL }
          )}
          ctaText={interpolate(t.portfolio.page.emptyCta, { token: STABLE_LABEL })}
          onClick={() => navigate('/exchange')}
        />
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
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

      <LegacyAssetsBanner state={legacyAssets} />

      {/* ── Net worth + what to do next ──────────────────────────────────────
          Merged in from the Dashboard, which answered the same question this
          page does ("how am I doing") but read-only — every action lived here.
          A read-only twin of an actionable page is where people get stuck:
          they can see the number and cannot do anything about it without
          discovering there is a second page. Aave's dashboard is the same
          shape — net worth on top, positions and their actions below. */}
      <NetWorthHero parts={netWorthParts} pnlPct={pnlPctStr} loading={!isLoaded} />

      {/* ── 頁籤 ─────────────────────────────────────────────────────────────
          #146：現貨為主，部位獨立第二頁。Net Worth hero 留在頁籤**之上**——兩
          個頁籤回答的是同一個「我現在怎麼樣」，那個數字不該隨頁籤變動，否則切
          過去時它閃一下，會讓人以為淨值真的變了。 */}
      <Tabs
        value={tab}
        onChange={(_, val) => setTab(val)}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="spot"      label={t.portfolio.page.tab.spot}      sx={{ textTransform: 'none' }} />
        <Tab value="positions" label={t.portfolio.page.tab.positions} sx={{ textTransform: 'none' }} />
      </Tabs>

      {tab === 'spot' && (
      <>
      {/* RWA 是本平台的最大賣點，緊接在淨值 hero 之後、任何操作之前——見
          RwaAllocation.tsx 頂部註解。Simple／Expert 皆顯示，零持倉也照樣顯示。 */}
      <RwaAllocation rows={pricedPositions} holdings={synthHoldings.rows} />

      {/* KYC 是 RwaAllocation 剛講的「四大類都能配置」背後那道閘門——緊接在它
          後面，讓「這個平台讓你配什麼」和「我現在能不能配」連在一起讀。常駐
          卡片，不是撞到閘門才出現的 Modal：見 KYCStatusCard.tsx 頂部註解。 */}
      <KYCStatusCard
        kycRegistry={contracts?.kycRegistry ?? null}
        userAddress={wallet.address ?? null}
        credentialsHref={kycAction === 'credentials' ? paths.pepefi.credentials : null}
        vcChecking={kycAction === 'checking'}
        vcUnknown={kycAction === 'unknown'}
        onVcRetry={vcKyc.retry}
      />

      <QuickActions mode={mode} />
      </>
      )}

      {tab === 'positions' && (
      <>
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
          version that also offers a way in.

          #150：哪個模式看得到哪一塊跟單 UI，由 copyDeskVisibility 決定。 */}
      {copyDesk.stats && (
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

      {/* 沒有跟單部位卡（Simple Mode、旗標關閉、已全部取消）但油箱還有錢：單獨一張，提得出來。 */}
      {autoSync.supported && !copyDesk.records && hasTankBalance && (
        <Card sx={{ p: 2.5, border: '1px solid', borderColor: 'divider' }}>{tank}</Card>
      )}

      {/* ─── A. Copy Records ────────────────────────────────────────────── */}
      {copyDesk.records && (
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.portfolio.page.copyPositions}
          </Typography>
          {autoSync.supported && (copyRecs.length > 0 || hasTankBalance) && tank}
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
                    // 所有欄位一律靠左，標題與內容對齊同一邊（簡單與專家模式共用這張表）。
                    t.portfolio.page.copyColumn.trader,
                    t.portfolio.page.copyColumn.copiedAt,
                    t.portfolio.page.copyColumn.initial,
                    t.portfolio.page.copyColumn.current,
                    t.portfolio.page.copyColumn.return,
                    t.portfolio.page.copyColumn.stopLoss,
                    ...(autoSync.supported ? [t.portfolio.autoSync.column] : []),
                    t.portfolio.page.copyColumn.actions,
                  ]).map(label => (
                    <TableCell key={label} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5, whiteSpace: 'nowrap' }}>
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
                  // 「更新到最新版」會帶到 /copy 重新跟單；跟單旗標關閉時那條路由被收起，這組標示也不出現。
                  // 合約支援自動同步時改成就地同步，不經過 /copy，所以旗標關閉也照樣可以同步既有的跟單。
                  const outdated = (FEATURE_COPY_TRADING || autoSync.supported) && rec.strategyCount !== null && isOutdated(rec.versionId, rec.strategyCount);
                  const refreshKey = `refresh_${rec.index}`;
                  const stopHit = stopLossReached(rec.initialAmount, rec.currentValue, stopLoss[rec.index] ?? null);
                  // ADR-024：合約支援自動同步時，「更新到最新版」改成就地同步（resyncAtVersion），不必取消再重跟
                  const resyncKey = `resync_${rec.index}`;
                  const autoKey = `autosync_${rec.index}`;
                  const latestVersion = rec.strategyCount !== null && rec.strategyCount > 0n ? rec.strategyCount - 1n : null;
                  const sync = autoSync.supported
                    ? syncStatus({
                        recordVersion: rec.versionId,
                        latestVersion,
                        config:        rec.syncConfig,
                        state:         rec.syncState,
                        gasBalance:    syncGas,
                        executionFee:  execFee.loaded ? execFee.wei : null,
                        latestLegs:    rec.latestLegs,
                        nowSec,
                        copiedAt:      Number(rec.copiedAt),
                        execFeeCap:    rec.execFeeCap,
                        executor:      rec.executor,
                      })
                    : null;
                  const syncOn = rec.syncConfig?.autoSync ?? false;
                  const rowBusy = busy[unfKey] || busy[refreshKey] || busy[resyncKey] || busy[autoKey];
                  return (
                    <TableRow
                      key={rec.index}
                      sx={outdated
                        // 策略已更新：整列淡橘底、左側一條橘線，一眼就看得出哪一筆要處理。
                        ? {
                            bgcolor: theme => alpha(theme.palette.warning.main, 0.08),
                            '& > td:first-of-type': { boxShadow: theme => `inset 4px 0 0 ${theme.palette.warning.main}` },
                            '&:hover': { bgcolor: theme => alpha(theme.palette.warning.main, 0.12) },
                          }
                        : { '&:hover': { bgcolor: 'action.hover' } }}
                    >
                      <TableCell>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                          {rec.traderName || SHORT_ADDR(rec.trader)}
                        </Typography>
                        <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', mt: 0.2 }}>
                          {SHORT_ADDR(rec.trader)}
                        </Typography>
                        {outdated && (
                          <MuiTooltip
                            title={autoSync.supported
                              ? (mode === 'expert' ? t.portfolio.autoSync.outdatedHint : t.portfolio.autoSync.outdatedHintSimple)
                              : t.portfolio.page.copyOutdatedHint}
                          >
                            <Chip
                              size="small"
                              color="warning"
                              icon={<Icon icon="solar:danger-triangle-bold" width={14} />}
                              label={t.portfolio.page.copyOutdated}
                              sx={{ mt: 0.75, fontWeight: 'bold', fontSize: '0.75rem' }}
                            />
                          </MuiTooltip>
                        )}
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        {fDate(rec.copiedAt)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>
                        {f18(rec.initialAmount)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                        {f18(rec.currentValue)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: returnColor(rec.initialAmount, rec.currentValue) }}>
                        {returnPct(rec.initialAmount, rec.currentValue)}
                        {stopHit && (
                          <Box>
                            <Chip size="small" color="error" label={t.portfolio.page.stopLossReached} sx={{ mt: 0.5, height: 20, fontSize: '0.6875rem' }} />
                          </Box>
                        )}
                      </TableCell>
                      <TableCell>
                        <MuiTooltip title={t.portfolio.page.stopLossHint}>
                          <Select<number | ''>
                            size="small"
                            value={stopLoss[rec.index] ?? ''}
                            displayEmpty
                            onChange={e => changeStopLoss(rec.index, e.target.value === '' ? null : Number(e.target.value))}
                            sx={{ minWidth: 104, fontSize: '0.8125rem' }}
                          >
                            <MenuItem value="">{t.portfolio.page.stopLossNone}</MenuItem>
                            {STOP_LOSS_CHOICES.map(pct => (
                              <MenuItem key={pct} value={pct}>{interpolate(t.portfolio.page.stopLossOption, { pct })}</MenuItem>
                            ))}
                          </Select>
                        </MuiTooltip>
                      </TableCell>
                      {autoSync.supported && (
                        <TableCell sx={{ minWidth: 190 }}>
                          <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold', display: 'block' }}>
                            {latestVersion === null
                              ? '—'
                              : rec.versionId >= latestVersion
                                ? interpolate(t.portfolio.autoSync.versionsLatest, { current: versionLabel(rec.versionId) })
                                : interpolate(t.portfolio.autoSync.versions, { current: versionLabel(rec.versionId), latest: versionLabel(latestVersion) })}
                          </Typography>
                          <Stack direction="row" sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                            <Chip
                              size="small"
                              color={syncOn ? 'success' : 'default'}
                              variant={syncOn ? 'filled' : 'outlined'}
                              label={syncOn ? t.portfolio.autoSync.on : t.portfolio.autoSync.off}
                              sx={{ height: 20, fontSize: '0.6875rem', fontWeight: 'bold' }}
                            />
                            {(rec.syncState?.syncCount ?? 0) > 0 && (
                              <Chip
                                size="small"
                                variant="outlined"
                                label={interpolate(t.portfolio.autoSync.syncCount, { count: rec.syncState?.syncCount ?? 0 })}
                                sx={{ height: 20, fontSize: '0.6875rem' }}
                              />
                            )}
                            {rec.executor && (
                              <MuiTooltip title={mode === 'simple' ? t.portfolio.autoSync.executorTipSimple : t.portfolio.autoSync.executorTip}>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={interpolate(t.portfolio.autoSync.executorChip, { addr: SHORT_ADDR(rec.executor) })}
                                  sx={{ height: 20, fontSize: '0.6875rem', fontFamily: MONO }}
                                />
                              </MuiTooltip>
                            )}
                            {rec.syncState?.followerClosed && (
                              <MuiTooltip title={t.portfolio.autoSync.followerClosed}>
                                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', color: 'text.secondary', cursor: 'help' }}>
                                  <Icon icon="solar:info-circle-linear" width={16} />
                                </Box>
                              </MuiTooltip>
                            )}
                          </Stack>
                          {sync && (
                            <Typography
                              variant="caption"
                              sx={{ display: 'block', mt: 0.5, color: sync.kind === 'needsGas' || sync.kind === 'feeAboveCap' || sync.kind === 'consentStale' ? 'warning.main' : 'text.secondary' }}
                            >
                              {syncStatusText(sync, syncOn)}
                            </Typography>
                          )}
                        </TableCell>
                      )}
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {/* 立即同步會依新版開新部位（含槓桿）：只在 Expert Mode、而且先開確認視窗看過新版內容才送。
                            Simple Mode 收的是入口，不是退出——取消與關閉自動同步仍在。 */}
                        {outdated && autoSync.supported && mode === 'expert' && (
                          <Button
                            size="small"
                            variant="contained"
                            color="warning"
                            startIcon={<Icon icon="solar:refresh-bold" width={16} />}
                            onClick={() => void openResync(rec)}
                            disabled={rowBusy || !!unfStale}
                            title={unfStale ?? undefined}
                            sx={{ mr: 1, fontWeight: 'bold' }}
                          >
                            {busy[resyncKey] ? t.portfolio.autoSync.syncing : t.portfolio.autoSync.syncNow}
                          </Button>
                        )}
                        {autoSync.supported && mode === 'expert' && (
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            onClick={() => openSyncSettings(rec)}
                            disabled={rowBusy}
                            sx={{ mr: 1, borderColor: 'divider' }}
                          >
                            {t.portfolio.autoSync.settings}
                          </Button>
                        )}
                        {/* Simple Mode 不給設定（裡面有槓桿上限），但開著的自動同步一定要關得掉 */}
                        {autoSync.supported && mode !== 'expert' && syncOn && rec.syncConfig && (
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            onClick={() => { if (rec.syncConfig) void doSaveAutoSync(rec, false, rec.syncConfig); }}
                            disabled={rowBusy}
                            sx={{ mr: 1, borderColor: 'divider' }}
                          >
                            {busy[autoKey] ? '…' : t.portfolio.autoSync.disable}
                          </Button>
                        )}
                        {outdated && !autoSync.supported && (
                          <Button
                            size="small"
                            variant="contained"
                            color="warning"
                            startIcon={<Icon icon="solar:refresh-bold" width={16} />}
                            onClick={() => void doRefreshCopy(rec)}
                            disabled={busy[refreshKey] || busy[unfKey] || !!unfStale}
                            title={unfStale ?? undefined}
                            sx={{ mr: 1, fontWeight: 'bold' }}
                          >
                            {busy[refreshKey] ? t.portfolio.page.copyRefreshing : t.portfolio.page.copyRefresh}
                          </Button>
                        )}
                        {/* 已達停損時實心，讓它在需要的時候最醒目。 */}
                        <Button
                          size="small"
                          variant={stopHit ? 'contained' : 'outlined'}
                          color="error"
                          onClick={() => void doUnfollow(rec.index)}
                          disabled={rowBusy || !!unfStale}
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
      )}

      {/* ─── B. Open Positions ──────────────────────────────────────────────
          旗標關著時只有真的還有部位才顯示。與 /exchange 的同一個判斷同源:全部
          隱藏會讓既有部位平不掉,無條件顯示則讓一個只買現貨的人對著「0 筆未平倉」
          的空表——而他在這個版本裡根本沒有辦法開出部位。 */}
      {(SHOW_PERPETUALS || positions.length > 0) && (
      <Card sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {mode === 'simple' ? t.portfolio.page.openPositionsSimple : t.portfolio.page.openPositions}
          </Typography>
          {/* The count lives here now rather than in its own card above a table
              that already shows every row. */}
          <Typography variant="caption" color="text.secondary">
            {mode === 'simple'
              ? interpolate(t.portfolio.page.openCountSimple, { count: positions.length })
              : interpolate(FEATURE_COPY_TRADING ? t.portfolio.page.openCount : t.portfolio.page.openCountNoCopy, { count: positions.length })}
          </Typography>
        </Box>

        {/* 總計放在表格上方的一排小卡片：專家模式的表格要橫向捲動，總計放在最後一列時「總計」在最左、
            數字在最右，捲到哪邊都只看得到一半；擠在標題列又太擠。簡單模式只有價值與損益兩項，
            用自己的欄位名稱（columnLabelForMode）。 */}
        {positions.length > 0 && (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 1.5,
              px: 3,
              py: 2,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            {[
              {
                label: mode === 'simple' ? columnLabelForMode('value', 'simple') : t.portfolio.column.value,
                value: positionsValueTotal === null ? '—' : `${f18(positionsValueTotal)} ${STABLE_LABEL}`,
                color: 'text.primary',
              },
              {
                label: mode === 'simple' ? columnLabelForMode('unrealizedPnl', 'simple') : t.portfolio.column.unrealizedPnl,
                value: unrealisedPnl === null ? '—' : fPnL(unrealisedPnl),
                color: pnlColor(unrealisedPnl),
              },
              ...(mode === 'expert'
                ? [{
                    label: t.portfolio.column.accruedFunding,
                    value: fundingTotal === null ? '—' : fPnL(-fundingTotal),
                    color: fundingTotal === null ? 'text.secondary' : fundingTotal < 0n ? 'success.main' : 'error.main',
                  }]
                : []),
            ].map(card => (
              <Box key={card.label} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, px: 2, py: 1.25, bgcolor: 'background.neutral' }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {interpolate(t.portfolio.page.totalOf, { label: card.label })}
                </Typography>
                <Typography sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '1.0625rem', color: card.color, whiteSpace: 'nowrap' }}>
                  {card.value}
                </Typography>
              </Box>
            ))}
          </Box>
        )}

        {positionsUnread > 0 && (
          <Alert severity="warning" sx={{ mx: 2, mb: 1 }}>
            {interpolate(t.portfolio.page.positionsUnread, { count: positionsUnread })}
          </Alert>
        )}
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
                      {columnLabelForMode(key, 'simple')}
                    </TableCell>
                  ))}
                  <TableCell sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5 }}>
                    {t.portfolio.close.column}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.map(row => (
                  <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                    {openPositionColumnsForMode('simple').map(key => renderSimplePositionCell(key, row))}
                    {renderCloseCell(row)}
                  </TableRow>
                ))}
              </TableBody>
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
                    ...(showCopiedFrom ? [[t.portfolio.column.copiedFrom, ''] as const] : []),
                    [t.portfolio.column.unrealizedPnl, t.portfolio.columnHint.unrealizedPnl],
                    [t.portfolio.column.accruedFunding, ''],
                    [t.portfolio.column.value, ''],
                    [t.portfolio.close.column, ''],
                  ] as const).map(([h, hint]) => (
                    <TableCell
                      key={h}
                      title={hint || undefined}
                      sx={{
                        color: 'text.secondary',
                        fontWeight: 'bold',
                        fontSize: '0.75rem',
                        py: 1.5,
                        // 欄位多，不讓標題被擠到一個字一行（「槓桿」「累計資金費」）；放不下時表格自己橫向捲動。
                        whiteSpace: 'nowrap',
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
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>{row.currentPrice === null ? '—' : fUsd(row.currentPrice)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>
                      {(() => {
                        // 讀不到價格就是「—」，不再以黃色顯示模擬價；有價格時標出來源。
                        const lp = livePrices[row.asset]
                        if (!lp || lp.usd === null) {
                          return <Typography variant="caption" color="text.secondary">—</Typography>
                        }
                        return (
                          <>
                            <Typography component="span" sx={{ fontSize: '0.8125rem', fontFamily: MONO, color: 'success.main' }}>
                              ${lp.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </Typography>
                            <Typography component="div" variant="caption" color="text.secondary" sx={{ fontSize: '0.6875rem' }}>
                              {t.freshness.priceSource[lp.source]}
                            </Typography>
                          </>
                        )
                      })()}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.8125rem' }}>{f18(row.margin)}</TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem' }}>{String(row.leverage)}×</TableCell>
                    {showCopiedFrom && (
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
                      {row.copiedFrom === '0x0000000000000000000000000000000000000000' ? (
                        <Typography component="span" variant="caption" color="text.disabled">—</Typography>
                      ) : SHORT_ADDR(row.copiedFrom)}
                    </TableCell>
                    )}
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', whiteSpace: 'nowrap', color: pnlColor(row.unrealizedPnL) }}>
                      {row.unrealizedPnL === null ? <NoFigure status={row.status} /> : fPnL(row.unrealizedPnL)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', whiteSpace: 'nowrap', color: row.accruedFunding === null || row.accruedFunding === 0n ? 'text.secondary' : row.accruedFunding < 0n ? 'success.main' : 'error.main' }}>
                      {row.accruedFunding === null || row.accruedFunding === 0n ? '—' : fPnL(-row.accruedFunding)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '0.8125rem', whiteSpace: 'nowrap', color: pnlColor(row.unrealizedPnL) }}>
                      {row.currentValue === null ? <NoFigure status={row.status} /> : f18(row.currentValue)}
                    </TableCell>
                    {renderCloseCell(row)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>
      )}

      {/* ─── Analysis (expert only) ─────────────────────────────────────── */}
      {mode === 'expert' && <PortfolioAnalysis rows={pricedPositions} esg={esg} />}

      {/* #333：自己持倉（永續部位＋現貨代幣）依市值的碳分級組成（等級讀自交易所定價用的鏈上見證） */}
      {(pricedPositions.length > 0 || synthHoldings.rows.length > 0) && (
        <CarbonTierMixCard
          holdings={[
            ...pricedPositions.map((p) => ({ asset: p.asset, weight: Number(p.currentValue) / 1e18 })),
            ...synthHoldings.rows.map((h) => ({ asset: h.asset, weight: Number(holdingValue(h)) / 1e18 })),
          ]}
          tierOf={pricingTiers.tierOf}
          source="portfolio"
        />
      )}

      {/* ─── C + D side-by-side ─────────────────────────────────────────── */}
      <Grid container spacing={3}>
        {/* C. Free Margin */}
        <Grid size={{ xs: 12, md: showCopyPerformance ? 6 : 12 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5, height: '100%' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
              {mode === 'simple' ? t.portfolio.page.freeMarginSimple : t.portfolio.page.freeMargin}
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
        {showCopyPerformance && (
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
      </>
      )}

      {syncDialogs}
    </Container>
  );
}
