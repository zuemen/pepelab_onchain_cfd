import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { formatEth } from 'src/hooks/useExecutionFee';
import {
  TIP_CHOICES,
  hoursLabel,
  syncCostWei,
  parseEthInput,
  syncsAffordable,
  COOLDOWN_CHOICES,
  AUTO_SYNC_MIN_LEVERAGE,
  AUTO_SYNC_MAX_LEVERAGE,
  type ExecutorProblem,
  type AutoSyncSettings,
} from 'src/lib/pepefi/autoSync';

import { MONO } from 'src/components/pepefi/brandKit';

// ----------------------------------------------------------------------
// 自動同步（ADR-024）的設定欄位：槓桿上限、冷卻時間、執行者小費，加上選用的油箱預存與指定執行者。
// 跟單頁與投資組合的設定彈窗共用。這裡只負責輸入與估算；送出前的檢查在 autoSync.settingsProblem。

const L = t.copy.autoSync;

const LEVERAGES = Array.from(
  { length: AUTO_SYNC_MAX_LEVERAGE - AUTO_SYNC_MIN_LEVERAGE + 1 },
  (_, i) => AUTO_SYNC_MIN_LEVERAGE + i
);

interface Props {
  value: AutoSyncSettings;
  onChange: (next: AutoSyncSettings) => void;
  maxTipWei: bigint;
  /** 交易所 executionFee（每一檔一份）。 */
  executionFee: bigint;
  /** 估算用的檔數：最新版策略有幾檔。 */
  legs: number;
  /** 槓桿上限欄位只在 Expert Mode 出現（Simple Mode 不說槓桿）。 */
  showLeverage: boolean;
  /** 有給才顯示預存油箱的輸入框。 */
  prefund?: { value: string; onChange: (v: string) => void };
  /** 油箱目前餘額（投資組合的設定彈窗用來估算還能同步幾次）。 */
  tankBalance?: bigint | null;
  /**
   * 有給才顯示「只讓這個地址代為同步」（合約 setSyncExecutor；Expert Mode 才給）。空字串＝任何人。
   * `problem` 由呼叫端以 autoSync.executorProblem 算好（需要跟隨者自己的地址）。
   */
  executor?: { value: string; onChange: (v: string) => void; problem: ExecutorProblem | null; extraTxNote?: boolean };
  disabled?: boolean;
}

export default function AutoSyncFields({
  value,
  onChange,
  maxTipWei,
  executionFee,
  legs,
  showLeverage,
  prefund,
  tankBalance = null,
  executor,
  disabled = false,
}: Props) {
  const tips = [...new Set<bigint>([...TIP_CHOICES.filter((tip) => tip <= maxTipWei), value.tipWei])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const cooldowns = [...new Set<number>([...COOLDOWN_CHOICES, value.minSyncInterval])].sort((a, b) => a - b);

  const perSync = syncCostWei(executionFee, legs, value.tipWei, false);
  const prefundWei = prefund ? parseEthInput(prefund.value) : null;
  const budget = prefund ? prefundWei : tankBalance;
  const affordable = budget === null ? null : syncsAffordable(budget, perSync);

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {showLeverage && (
          <TextField
            select
            size="small"
            label={L.maxLeverage}
            value={value.maxLeverage}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, maxLeverage: Number(e.target.value) })}
            sx={{ minWidth: 120 }}
          >
            {LEVERAGES.map((lev) => (
              <MenuItem key={lev} value={lev}>{interpolate(L.leverageOption, { lev })}</MenuItem>
            ))}
          </TextField>
        )}
        <TextField
          select
          size="small"
          label={L.cooldown}
          value={value.minSyncInterval}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, minSyncInterval: Number(e.target.value) })}
          sx={{ minWidth: 140 }}
        >
          {cooldowns.map((sec) => (
            <MenuItem key={sec} value={sec}>{interpolate(L.cooldownOption, { hours: hoursLabel(sec) })}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={L.tip}
          value={value.tipWei.toString()}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, tipWei: BigInt(e.target.value) })}
          sx={{ minWidth: 200 }}
        >
          {tips.map((tip) => (
            <MenuItem key={tip.toString()} value={tip.toString()}>
              {tip === 0n ? L.tipNone : interpolate(L.tipOption, { eth: formatEth(tip) })}
            </MenuItem>
          ))}
        </TextField>
        {prefund && (
          <TextField
            size="small"
            label={L.prefund}
            value={prefund.value}
            disabled={disabled}
            error={prefund.value !== '' && prefundWei === null}
            onChange={(e) => prefund.onChange(e.target.value)}
            slotProps={{ htmlInput: { inputMode: 'decimal', style: { fontFamily: MONO } } }}
            sx={{ width: 180 }}
          />
        )}
      </Box>

      {executor && (
        <TextField
          size="small"
          fullWidth
          label={L.executor}
          placeholder={L.executorPlaceholder}
          value={executor.value}
          disabled={disabled}
          error={executor.problem !== null}
          helperText={executor.problem ? L.executorInvalid[executor.problem] : L.executorHelp}
          onChange={(e) => executor.onChange(e.target.value)}
          slotProps={{ htmlInput: { spellCheck: false, autoComplete: 'off', style: { fontFamily: MONO } } }}
        />
      )}

      <Stack spacing={0.5}>
        {showLeverage && (
          <Typography variant="caption" color="text.secondary">{L.maxLeverageHelp}</Typography>
        )}
        <Typography variant="caption" color="text.secondary">{L.cooldownHelp}</Typography>
        <Typography variant="caption" color="text.secondary">
          {interpolate(L.tipHelp, { max: formatEth(maxTipWei) })}
        </Typography>
        {prefund && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(L.prefundHelp, { fee: formatEth(executionFee) })}
          </Typography>
        )}
        {executor?.extraTxNote && executor.value.trim() !== '' && executor.problem === null && (
          <Typography variant="caption" color="text.secondary">{L.executorExtraTx}</Typography>
        )}
        {affordable !== null && legs > 0 && (
          <Typography variant="caption" sx={{ fontFamily: MONO, color: affordable > 0n ? 'success.main' : 'warning.main' }}>
            {interpolate(L.estimate, { count: affordable.toString(), legs, cost: formatEth(perSync) })}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
