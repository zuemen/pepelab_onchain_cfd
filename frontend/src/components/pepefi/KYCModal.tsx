import { useState } from 'react';
import type { Contract } from 'ethers';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';

import { Iconify } from 'src/components/iconify';

const COUNTRIES = [
  'TW', 'US', 'JP', 'KR', 'HK', 'SG', 'GB', 'DE', 'FR', 'CA',
  'AU', 'NZ', 'CH', 'SE', 'NL', 'BE', 'IT', 'ES', 'PT', 'AT',
  'DK', 'NO', 'FI', 'IE', 'CN', 'IN', 'BR', 'MX', 'TH', 'MY',
  'ID', 'PH', 'VN', 'PL', 'CZ', 'IL', 'ZA', 'AE', 'SA', 'OTHER',
]

/** ISO 兩碼是資料，右邊的國名是顯示字串，所以只有後者住在 catalog。 */
const COUNTRY_NAMES: Record<string, string> = t.kyc.country

interface Props {
  isOpen:      boolean;
  onClose:     () => void;
  onSuccess:   () => void;
  kycRegistry: Contract | null;
  /**
   * 這個地址已經送出過申請、正在等審核。
   *
   * KYCRegistry 改成審核制之後，「還沒通過」有兩種完全不同的狀態，重送表單對
   * `pending` 的使用者沒有任何幫助（只是再燒一次 gas），所以送出鍵要關掉。
   */
  isPending?:  boolean;
}

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

export default function KYCModal({ isOpen, onClose, onSuccess, kycRegistry, isPending = false }: Props) {
  const [fullName,    setFullName]    = useState('');
  const [nationality, setNationality] = useState('TW');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  /** 這一輪送出成功 → 停在「已送出、待審核」畫面，不要直接關掉讓人以為過了。 */
  const [submitted,   setSubmitted]   = useState(false);

  const awaitingReview = isPending || submitted;

  const handleSubmit = async () => {
    if (!kycRegistry) return;
    if (!fullName.trim()) { setError(t.kyc.nameRequired); return; }
    setBusy(true);
    setError(null);
    try {
      const tx = asTx(await kycRegistry.submitKYC(fullName.trim(), nationality));
      await tx.wait();
      // submitKYC 現在只 emit KYCSubmitted——使用者「還沒」通過。舊版在這裡直接
      // onClose()，畫面看起來就像驗證完成了，然後他回去下單被合約 revert
      // NotKycVerified，完全不知道發生什麼事。改成留在原地明確告知「待審核」。
      setSubmitted(true);
      onSuccess();
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          p: 1.5,
          bgcolor: 'background.paper',
          backgroundImage: 'none',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', pb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            {awaitingReview ? t.kyc.titleAwaitingReview : t.kyc.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t.kyc.subtitle}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t.kyc.closeAria}
          sx={{ color: 'text.secondary', p: 0.5 }}
        >
          {/* Iconify rather than a bare "✕" glyph: the character renders at a
              different weight and baseline in every font, and cannot inherit
              the icon sizing used by every other close button here. */}
          <Iconify icon="mingcute:close-line" width={18} />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
        {/* 審核制說明。這是這個 Dialog 最重要的一句話：送出 ≠ 通過。 */}
        <Alert severity={awaitingReview ? 'success' : 'info'} variant="outlined">
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
            {awaitingReview ? t.kyc.noticeTitleAwaitingReview : t.kyc.noticeTitle}
          </Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            {awaitingReview ? t.kyc.noticeBodyAwaitingReview : t.kyc.noticeBody}
          </Typography>
        </Alert>

        {/* Demo disclaimer — 已送出待審時不用再看填表注意事項 */}
        {!awaitingReview && (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{
            bgcolor: 'rgba(255, 171, 0, 0.08)',
            borderColor: 'rgba(255, 171, 0, 0.24)',
            color: 'warning.main',
            '& .MuiAlert-icon': { color: 'warning.main' },
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
            {t.kyc.demoTitle}
          </Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            {t.kyc.demoBody}
          </Typography>
        </Alert>
        )}

        {/* Form — 待審核時隱藏，重複送出只是再燒一次 gas */}
        {!awaitingReview && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={t.kyc.nameLabel}
            placeholder={t.kyc.namePlaceholder}
            fullWidth
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={busy}
            slotProps={{
              inputLabel: { shrink: true },
            }}
          />

          <FormControl fullWidth>
            <InputLabel id="nationality-select-label" shrink>{t.kyc.nationalityLabel}</InputLabel>
            <Select
              labelId="nationality-select-label"
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
              disabled={busy}
              label={t.kyc.nationalityLabel}
              notched
            >
              {COUNTRIES.map((c) => (
                <MenuItem key={c} value={c}>
                  {interpolate(t.kyc.nationalityOption, { code: c, name: COUNTRY_NAMES[c] ?? c })}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ py: 0 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, gap: 1.5 }}>
        <Button
          variant="outlined"
          color="inherit"
          onClick={onClose}
          disabled={busy}
          fullWidth
          sx={{ py: 1.2 }}
        >
          {awaitingReview ? t.kyc.close : t.kyc.cancel}
        </Button>
        {!awaitingReview && (
          <Button
            variant="contained"
            color="primary"
            onClick={() => void handleSubmit()}
            disabled={busy || !fullName.trim() || !kycRegistry}
            fullWidth
            sx={{ py: 1.2, fontWeight: 'bold' }}
          >
            {busy ? t.kyc.submitting : t.kyc.submit}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
