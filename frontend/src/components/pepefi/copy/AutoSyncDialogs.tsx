import { useState, useEffect } from 'react';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import Switch from '@mui/material/Switch';
import TableRow from '@mui/material/TableRow';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DialogTitle from '@mui/material/DialogTitle';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import FormControlLabel from '@mui/material/FormControlLabel';

import { t, interpolate } from 'src/locales';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { formatEth, formatEthExact } from 'src/hooks/useExecutionFee';
import {
  versionLabel,
  parseEthInput,
  consentNotice,
  autoSyncConfigUnchanged,
  settingsProblem,
  executorProblem,
  type ConsentNotice,
  type ResyncPreview,
  type AutoSyncSettings,
} from 'src/lib/pepefi/autoSync';

import { MONO } from 'src/components/pepefi/brandKit';

import AutoSyncFields from './AutoSyncFields';

// ----------------------------------------------------------------------
// 投資組合上的自動同步（ADR-024）：設定彈窗、油箱存提彈窗、油箱列、「立即同步」確認視窗。
// 送出交易的是頁面；這裡只收輸入、擋掉合約一定會拒絕的值、把要簽的內容講清楚。

const P = t.portfolio.autoSync;

// ── 設定 ─────────────────────────────────────────────────────────────────────

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** 目前鏈上的設定（沒開過時是預設值）。 */
  initialEnabled: boolean;
  initialSettings: AutoSyncSettings;
  maxTipWei: bigint;
  executionFee: bigint;
  /** `executionFee` 是鏈上讀到的值（false = 後備值，不能當成「交易所現行費率」說出口，開著時也不能儲存）。 */
  executionFeeLoaded: boolean;
  /** 跟隨者目前同意的每檔執行費（CopyTracker.syncExecFeeCap）；沒開過或讀不到為 null。 */
  consentedFee?: bigint | null;
  legs: number;
  tankBalance: bigint | null;
  showLeverage: boolean;
  busy: boolean;
  /**
   * 指定執行者（合約 setSyncExecutor）：合約支援時給目前鏈上的值（'' = 任何人）與自己的地址；
   * 不給就不顯示這個欄位。
   */
  executor?: { initial: string; follower: string | null };
  /** `executor` 為儲存當下輸入的地址（'' = 任何人）；沒有這個欄位時為 undefined。 */
  onSave: (enabled: boolean, settings: AutoSyncSettings, executor?: string) => void;
}

export function AutoSyncSettingsDialog({
  open,
  onClose,
  initialEnabled,
  initialSettings,
  maxTipWei,
  executionFee,
  executionFeeLoaded,
  consentedFee = null,
  legs,
  tankBalance,
  showLeverage,
  busy,
  executor,
  onSave,
}: SettingsProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [settings, setSettings] = useState(initialSettings);
  const [executorInput, setExecutorInput] = useState(executor?.initial ?? '');
  const initialExecutor = executor?.initial ?? '';
  useEffect(() => {
    if (!open) return;
    setEnabled(initialEnabled);
    setSettings(initialSettings);
    setExecutorInput(initialExecutor);
  }, [open, initialEnabled, initialSettings, initialExecutor]);

  const problem = settingsProblem(settings, maxTipWei);
  const exProblem = executor ? executorProblem(executorInput, executor.follower) : null;
  const consent = consentNotice({
    enabled,
    initialEnabled,
    settings,
    initialSettings,
    executionFee: executionFeeLoaded ? executionFee : null,
    consentedFee,
  });
  // 讀不到現行費率時，只擋「會送 setAutoSync」的儲存：設定沒變（例如只改指定執行者）照常可以存。
  const blockedByUnknownFee = consent?.kind === 'unknownFee' && !autoSyncConfigUnchanged({
    current: { autoSync: initialEnabled, ...initialSettings },
    enabled,
    settings,
    consentedFee,
    executionFee: null,
  });

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 'bold' }}>{P.dialog.settingsTitle}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />}
            label={<Typography variant="body2" sx={{ fontWeight: 'bold' }}>{P.dialog.enabled}</Typography>}
          />
          <AutoSyncDisclosure />
          {!enabled && showLeverage && (
            <Typography variant="caption" color="text.secondary">{P.dialog.offNote}</Typography>
          )}
          {/* 關閉時欄位仍可改：槓桿上限也套用在本人的「立即同步」，指定執行者在重新開啟時仍然有效。 */}
          <AutoSyncFields
            value={settings}
            onChange={setSettings}
            maxTipWei={maxTipWei}
            executionFee={executionFee}
            legs={legs}
            showLeverage={showLeverage}
            tankBalance={tankBalance}
            executor={executor ? { value: executorInput, onChange: setExecutorInput, problem: exProblem } : undefined}
            disabled={busy}
          />
          {/* 儲存＝以現行費率簽名同意（setAutoSync 的 maxExecFeePerLeg）：開著時一定說出確切的數字（見 consentNotice）。 */}
          <ConsentNoticeView notice={consent} />
          {enabled && problem && <Alert severity="warning">{t.copy.autoSync.invalid[problem]}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>{P.dialog.cancel}</Button>
        <Button
          variant="contained"
          onClick={() => onSave(enabled, settings, executor ? executorInput.trim() : undefined)}
          disabled={busy || (enabled && problem !== null) || exProblem !== null || blockedByUnknownFee}
        >
          {busy ? '…' : P.dialog.save}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * 開啟自動同步前一定看得到的揭露：誰能做什麼、每次同步的 USDC 成本（全平再開的交易費、績效費）與時機風險、
 * 私鑰不離開錢包。跟單頁與投資組合的設定彈窗共用。
 */
export function AutoSyncDisclosure() {
  return (
    <Alert severity="info" variant="outlined">
      {t.copy.autoSync.disclosure}
      <Typography variant="body2" sx={{ display: 'block', mt: 0.75 }}>
        {t.copy.autoSync.costs}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
        {t.copy.autoSync.selfCustody}
      </Typography>
    </Alert>
  );
}

/**
 * 「你同意的執行費」那一句（consentNotice）。金額用不捨入的格式：這是簽名同意的數字，
 * 兩個只差 1 wei 的費率不能顯示成同一個。
 */
export function ConsentNoticeView({ notice }: { notice: ConsentNotice | null }) {
  if (notice === null) return null;
  const D = P.dialog;
  switch (notice.kind) {
    case 'unknownFee':
      return <Alert severity="warning">{D.consentUnknownFee}</Alert>;
    case 'raised':
      return (
        <Alert severity="warning">
          {interpolate(D.consentChanged, { fee: formatEthExact(notice.fee), old: formatEthExact(notice.old) })}
        </Alert>
      );
    case 'lowered':
      return (
        <Alert severity="info">
          {interpolate(D.consentLowered, { fee: formatEthExact(notice.fee), old: formatEthExact(notice.old) })}
        </Alert>
      );
    default:
      return (
        <Typography variant="caption" color="text.secondary">
          {interpolate(notice.kind === 'current' ? D.consentCurrent : D.consentLine, { fee: formatEthExact(notice.fee) })}
        </Typography>
      );
  }
}

// ── 油箱存提 ─────────────────────────────────────────────────────────────────

interface GasProps {
  open: boolean;
  mode: 'deposit' | 'withdraw';
  onClose: () => void;
  balance: bigint | null;
  /** 存入時的預設金額（例如夠代為同步五次）。 */
  suggested?: bigint | null;
  busy: boolean;
  onSubmit: (wei: bigint) => void;
}

export function SyncGasDialog({ open, mode, onClose, balance, suggested = null, busy, onSubmit }: GasProps) {
  const [amount, setAmount] = useState('');
  useEffect(() => {
    if (!open) return;
    if (mode === 'withdraw') setAmount(balance !== null && balance > 0n ? formatEth(balance) : '');
    else setAmount(suggested !== null && suggested > 0n ? formatEth(suggested) : '');
  }, [open, mode, balance, suggested]);

  // 提領「全部」直接用鏈上餘額，不經過顯示用的 6 位小數（formatEth 會捨去尾數）
  const [useMax, setUseMax] = useState(false);
  useEffect(() => { setUseMax(false); }, [open, mode]);

  const parsed = useMax && balance !== null ? balance : parseEthInput(amount);
  const over = mode === 'withdraw' && parsed !== null && balance !== null && parsed > balance;
  const invalid = parsed === null || parsed <= 0n;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 'bold' }}>{P.dialog.gasTitle}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">{P.tank.title}</Typography>
            <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
              {balance === null ? '—' : interpolate(P.tank.balance, { eth: formatEth(balance) })}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <TextField
              size="small"
              fullWidth
              label={P.dialog.amount}
              value={amount}
              disabled={busy}
              error={amount !== '' && (invalid || over)}
              helperText={amount !== '' && invalid ? P.dialog.invalidAmount : over ? P.dialog.overBalance : ' '}
              onChange={(e) => { setUseMax(false); setAmount(e.target.value); }}
              slotProps={{ htmlInput: { inputMode: 'decimal', style: { fontFamily: MONO } } }}
            />
            {mode === 'withdraw' && (
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={busy || balance === null || balance === 0n}
                onClick={() => { if (balance !== null) { setAmount(formatEth(balance)); setUseMax(true); } }}
                sx={{ mt: 0.5 }}
              >
                {P.dialog.max}
              </Button>
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">{P.tank.note}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>{P.dialog.cancel}</Button>
        <Button
          variant="contained"
          disabled={busy || invalid || over}
          onClick={() => { if (parsed !== null) onSubmit(parsed); }}
        >
          {busy ? '…' : mode === 'deposit' ? P.dialog.depositCta : P.dialog.withdrawCta}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── 油箱列 ───────────────────────────────────────────────────────────────────

interface TankProps {
  balance: bigint | null;
  /** 以目前設定估算的「還能代為同步幾次」；不適用時 null。 */
  affordable: bigint | null;
  /** 開著自動同步的跟單，交易所的執行費都高於同意的費率：別人一次都不能代為同步，次數估算不成立。 */
  consentBlocked?: boolean;
  busy: boolean;
  onDeposit: () => void;
  onWithdraw: () => void;
}

/** 油箱餘額與存提按鈕。提領永遠可以按（只要有餘額）：退出不藏。 */
export function SyncGasTank({ balance, affordable, consentBlocked = false, busy, onDeposit, onWithdraw }: TankProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 'bold' }}>
          {P.tank.title}
        </Typography>
        <Typography variant="subtitle2" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
          {balance === null ? '—' : interpolate(P.tank.balance, { eth: formatEth(balance) })}
          {consentBlocked ? (
            <Typography component="span" variant="caption" color="warning.main" sx={{ ml: 1, fontFamily: 'inherit' }}>
              {P.tank.consentBlocked}
            </Typography>
          ) : affordable !== null && (
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1, fontFamily: 'inherit' }}>
              {interpolate(P.tank.estimate, { count: affordable.toString() })}
            </Typography>
          )}
        </Typography>
      </Box>
      <Button size="small" variant="outlined" onClick={onDeposit} disabled={busy}>
        {P.tank.deposit}
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        onClick={onWithdraw}
        disabled={busy || balance === null || balance === 0n}
      >
        {P.tank.withdraw}
      </Button>
    </Box>
  );
}

// ── 立即同步：送出前的確認 ───────────────────────────────────────────────────

interface ResyncConfirmProps {
  open: boolean;
  onClose: () => void;
  /** 讀新版內容中。 */
  loading: boolean;
  /** 讀不到新版內容時的訊息。 */
  error: string | null;
  /** 這次要釘住的版本（交易者最新版的 versionId）；按下確認就以它送 resyncAtVersion。 */
  version: bigint | null;
  preview: ResyncPreview | null;
  /** 目前部位的最高槓桿（說明「這次會不會比現在高」）。 */
  currentMaxLeverage: number;
  busy: boolean;
  onConfirm: () => void;
}

const C = P.confirm;
const usd = (v: bigint | null) =>
  v === null ? C.unknown : interpolate(C.approx, { amount: (Number(v) / 1e18).toFixed(2), token: STABLE_LABEL });

/**
 * 「立即同步」的確認視窗。同步會平掉整列部位、依新版開新部位，所以送出前一定先看到：新版每一檔的資產、方向、
 * 比重、槓桿（新版 → 實際：策略、資產上限、自己的上限三者取小）、ETH 執行費、預估的交易費與績效費。只在 Expert
 * Mode 出現（Simple Mode 不提供立即同步）。按下確認時釘住的就是這裡顯示的那一版。
 */
export function ResyncConfirmDialog(props: ResyncConfirmProps) {
  return (
    <Dialog open={props.open} onClose={props.busy ? undefined : props.onClose} fullWidth maxWidth="sm">
      <ResyncConfirmContent {...props} />
    </Dialog>
  );
}

/** 確認視窗的內容（標題、內容、按鈕）；獨立出來，伺服器端渲染測試不必經過 Dialog 的 portal。 */
export function ResyncConfirmContent({
  onClose,
  loading,
  error,
  version,
  preview,
  currentMaxLeverage,
  busy,
  onConfirm,
}: ResyncConfirmProps) {
  const label = version === null ? '—' : versionLabel(version);
  const ready = !loading && !error && preview !== null && version !== null;
  return (
    <>
      <DialogTitle sx={{ fontWeight: 'bold' }}>{interpolate(C.title, { version: label })}</DialogTitle>
      <DialogContent dividers>
        {loading && <Typography variant="body2" color="text.secondary">{C.loading}</Typography>}
        {!loading && error && <Alert severity="error">{error}</Alert>}
        {ready && (
          <Stack spacing={2}>
            <Typography variant="body2">{interpolate(C.intro, { version: label })}</Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{C.colAsset}</TableCell>
                  <TableCell>{C.colSide}</TableCell>
                  <TableCell align="right">{C.colWeight}</TableCell>
                  <TableCell align="right">{C.colLeverage}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.legs.map((leg, i) => (
                  <TableRow key={`${leg.asset}-${i}`}>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{ASSET_LABEL[leg.asset] ?? leg.asset.slice(0, 10)}</TableCell>
                    <TableCell sx={{ color: leg.isLong ? 'success.main' : 'error.main', fontWeight: 'bold' }}>
                      {leg.isLong ? C.long : C.short}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO }}>{(Number(leg.weight) / 100).toFixed(2)}%</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                      {leg.strategyLeverage}× → <b>{leg.leverage}×</b>
                      {leg.capped && <Chip size="small" label={C.capped} sx={{ ml: 0.75, height: 18, fontSize: '0.6875rem' }} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview.noFollowerCap && <Alert severity="warning">{C.noCap}</Alert>}
            {preview.leverageRaised && (
              <Alert severity="warning">
                {interpolate(C.leverageRaised, {
                  to: preview.legs.reduce((m, l) => Math.max(m, l.leverage), 0),
                  from: currentMaxLeverage,
                })}
              </Alert>
            )}
            <Alert severity="info" variant="outlined">{C.closeAll}</Alert>
            <Stack spacing={0.75}>
              <FeeRow label={C.execFee} value={`${formatEth(preview.executionFeeWei)} ETH`} />
              {preview.topUpWei !== null && preview.topUpWei > 0n && (
                <Typography variant="caption" color="warning.main">
                  {interpolate(C.topUp, { eth: formatEth(preview.topUpWei) })}
                </Typography>
              )}
              <FeeRow label={C.released} value={usd(preview.estReleased)} />
              <FeeRow label={C.perfFee} value={usd(preview.estPerformanceFee)} />
              <FeeRow label={C.tradingFee} value={usd(preview.estOpenTradingFee)} />
              <Typography variant="caption" color="text.secondary">{C.estimateNote}</Typography>
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>{C.cancel}</Button>
        <Button variant="contained" color="warning" onClick={onConfirm} disabled={busy || !ready}>
          {busy ? P.syncing : C.cta}
        </Button>
      </DialogActions>
    </>
  );
}

function FeeRow({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'bold', textAlign: 'right' }}>{value}</Typography>
    </Box>
  );
}
