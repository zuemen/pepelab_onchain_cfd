import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import { Icon } from '@iconify/react';

import { t, interpolate } from 'src/locales';

// ----------------------------------------------------------------------
// 長清單（部位紀錄、鏈上動態時間軸）的完整版彈窗。卡片上只放前幾筆，標題右側放 ExpandListButton；
// 按下去開這個彈窗，內容在彈窗裡上下捲動，標題列固定在上方，右上角 ✕ 關閉（Esc、點外面也會關）。
// 不把幾百列直接攤在頁面上，個人頁才不會被一張表撐到捲不完。

/** 卡片標題右側的「展開全部 N 筆」。count 是完整清單的筆數。 */
export function ExpandListButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button
      size="small"
      variant="outlined"
      color="inherit"
      onClick={onClick}
      startIcon={<Icon icon="solar:maximize-square-minimalistic-linear" width={16} />}
      sx={{ textTransform: 'none', fontWeight: 'bold', borderColor: 'divider', flexShrink: 0 }}
    >
      {interpolate(t.common.dialog.expandList, { count })}
    </Button>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 標題下方的一行說明（例如統計範圍、損益的定義）。 */
  subtitle?: ReactNode;
  children: ReactNode;
}

export default function ListDialog({ open, onClose, title, subtitle, children }: Props) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      scroll="paper"
      slotProps={{ paper: { sx: { height: '85vh' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, pr: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="span" variant="h6" sx={{ fontWeight: 'bold', display: 'block' }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} aria-label={t.common.dialog.close} size="small">
          <Icon icon="mingcute:close-line" width={20} />
        </IconButton>
      </DialogTitle>
      {/* dividers：內容捲動時上下各一條分隔線，標題列留在原地。 */}
      <DialogContent dividers sx={{ p: 0 }}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
