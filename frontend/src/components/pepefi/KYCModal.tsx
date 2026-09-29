import { useState } from 'react';
import type { Contract } from 'ethers';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import {
  kycSubmitArgs,
  saveKycReceipt,
  buildKycSubmission,
  type KycSubmission,
} from 'src/lib/pepefi/kycCommitment';
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
  /** 這一輪送出的 salt 與雜湊——只在使用者端，送出後顯示給使用者自行保存。 */
  const [receipt,     setReceipt]     = useState<KycSubmission | null>(null);
  const [receiptSaved, setReceiptSaved] = useState(false);

  const awaitingReview = isPending || submitted;

  const handleSubmit = async () => {
    if (!kycRegistry) return;
    if (!fullName.trim()) { setError(t.kyc.nameRequired); return; }
    setBusy(true);
    setError(null);
    try {
      // 個資不上鏈：送的是 keccak256(salt ‖ 正規化姓名) 與 keccak256(salt ‖ 國籍代碼)，
      // 合約參數型別仍是 string（hex 字串）。salt 與原始資料只留在使用者端。
      const submission = buildKycSubmission(fullName, nationality);
      // 送交易「之前」先存收據：交易成功但頁面在存檔前關掉的話，salt 就永遠找不回來。
      let saved = false;
      const persist = async (txHash: string | null) => {
        try {
          const runner = kycRegistry.runner as { getAddress?: () => Promise<string>; provider?: { getNetwork?: () => Promise<{ chainId: bigint }> } } | null;
          const user = runner?.getAddress ? await runner.getAddress() : '';
          const net = runner?.provider?.getNetwork ? await runner.provider.getNetwork() : null;
          saved = saveKycReceipt({
            ...submission,
            chainId: net ? Number(net.chainId) : null,
            registry: await kycRegistry.getAddress(),
            user,
            createdAt: Date.now(),
            txHash,
          });
        } catch {
          saved = false;
        }
      };
      await persist(null);
      setReceipt(submission);
      setReceiptSaved(saved);

      const tx = asTx(await kycRegistry.submitKYC(...kycSubmitArgs(submission)));
      await tx.wait();
      await persist(tx.hash);
      setReceiptSaved(saved);
      // submitKYC 現在只 emit KYCSubmitted——使用者「還沒」通過。舊版在這裡直接
      // onClose()，畫面看起來就像驗證完成了，然後他回去下單被合約 revert
      // NotKycVerified，完全不知道發生什麼事。改成留在原地明確告知「待審核」。
      setSubmitted(true);
      onSuccess();
    } catch (e) {
      // 交易沒成功：這組 salt 沒有對應任何鏈上雜湊，不顯示收據（本機那份下次送出會覆蓋）。
      setReceipt(null);
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

        {/* 揭露：舊版前端曾把姓名與國籍明文寫上鏈，那些資料無法刪除。 */}
        {!awaitingReview && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {t.kyc.legacyPlaintextNotice}
          </Typography>
        )}

        {/* 送出後：salt 與雜湊只在這裡出現一次，請使用者自行保存。 */}
        {receipt && submitted && (
          <Alert severity="warning" variant="outlined">
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {t.kyc.receipt.title}
            </Typography>
            <Typography variant="caption" display="block" sx={{ mb: 1 }}>
              {receiptSaved ? t.kyc.receipt.savedLocally : t.kyc.receipt.notSaved}
            </Typography>
            {[
              [t.kyc.receipt.salt, receipt.salt],
              [t.kyc.receipt.nameHash, receipt.nameHash],
              [t.kyc.receipt.nationalityHash, receipt.nationalityHash],
            ].map(([label, value]) => (
              <TextField
                key={label}
                label={label}
                value={value}
                size="small"
                fullWidth
                sx={{ mb: 1, '& input': { fontFamily: 'monospace', fontSize: 11 } }}
                slotProps={{ input: { readOnly: true }, inputLabel: { shrink: true } }}
              />
            ))}
            <Typography variant="caption" display="block" color="text.secondary">
              {interpolate(t.kyc.receipt.scheme, { name: receipt.normalizedName, code: receipt.normalizedNationality })}
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
