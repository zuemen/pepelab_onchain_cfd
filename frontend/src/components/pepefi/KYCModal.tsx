import { useState } from 'react';
import type { Contract } from 'ethers';
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

const COUNTRIES = [
  'TW', 'US', 'JP', 'KR', 'HK', 'SG', 'GB', 'DE', 'FR', 'CA',
  'AU', 'NZ', 'CH', 'SE', 'NL', 'BE', 'IT', 'ES', 'PT', 'AT',
  'DK', 'NO', 'FI', 'IE', 'CN', 'IN', 'BR', 'MX', 'TH', 'MY',
  'ID', 'PH', 'VN', 'PL', 'CZ', 'IL', 'ZA', 'AE', 'SA', 'OTHER',
]

const COUNTRY_NAMES: Record<string, string> = {
  TW: '台灣', US: '美國', JP: '日本', KR: '韓國', HK: '香港', SG: '新加坡',
  GB: '英國', DE: '德國', FR: '法國', CA: '加拿大', AU: '澳大利亞', NZ: '紐西蘭',
  CH: '瑞士', SE: '瑞典', NL: '荷蘭', BE: '比利時', IT: '義大利', ES: '西班牙',
  PT: '葡萄牙', AT: '奧地利', DK: '丹麥', NO: '挪威', FI: '芬蘭', IE: '愛爾蘭',
  CN: '中國', IN: '印度', BR: '巴西', MX: '墨西哥', TH: '泰國', MY: '馬來西亞',
  ID: '印尼', PH: '菲律賓', VN: '越南', PL: '波蘭', CZ: '捷克', IL: '以色列',
  ZA: '南非', AE: '阿聯酋', SA: '沙烏地阿拉伯', OTHER: '其他',
}

interface Props {
  isOpen:      boolean;
  onClose:     () => void;
  onSuccess:   () => void;
  kycRegistry: Contract | null;
}

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

export default function KYCModal({ isOpen, onClose, onSuccess, kycRegistry }: Props) {
  const [fullName,    setFullName]    = useState('');
  const [nationality, setNationality] = useState('TW');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!kycRegistry) return;
    if (!fullName.trim()) { setError('請輸入姓名'); return; }
    setBusy(true);
    setError(null);
    try {
      const tx = asTx(await kycRegistry.submitKYC(fullName.trim(), nationality));
      await tx.wait();
      onSuccess();
      onClose();
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
            KYC 身分驗證
          </Typography>
          <Typography variant="caption" color="text.secondary">
            交易股票 / 債券類合成資產需要完成 KYC
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose} sx={{ color: 'text.secondary', p: 0.5 }}>
          <Box sx={{ fontSize: '0.875rem', lineHeight: 1 }}>✕</Box>
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
        {/* Demo disclaimer */}
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
            Demo KYC — 不會儲存真實個資
          </Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            此為學術展示系統。填入的姓名與國籍僅儲存在智能合約上作為 PoC 示範，請勿填入真實個人資訊。
          </Typography>
        </Alert>

        {/* Form */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="姓名（示範用）"
            placeholder="e.g. Demo User"
            fullWidth
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={busy}
            slotProps={{
              inputLabel: { shrink: true },
            }}
          />

          <FormControl fullWidth>
            <InputLabel id="nationality-select-label" shrink>國籍</InputLabel>
            <Select
              labelId="nationality-select-label"
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
              disabled={busy}
              label="國籍"
              notched
            >
              {COUNTRIES.map((c) => (
                <MenuItem key={c} value={c}>
                  {c} — {COUNTRY_NAMES[c] ?? c}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

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
          取消
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={() => void handleSubmit()}
          disabled={busy || !fullName.trim() || !kycRegistry}
          fullWidth
          sx={{ py: 1.2, fontWeight: 'bold' }}
        >
          {busy ? '提交中…' : '完成 KYC 驗證'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
