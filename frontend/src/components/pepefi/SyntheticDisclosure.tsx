import type { SxProps, Theme } from '@mui/material/styles';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import AlertTitle from '@mui/material/AlertTitle';

import { t } from 'src/locales';

// ----------------------------------------------------------------------

const STORAGE_KEY = 'pepefi:disclosure:collapsed';

function readCollapsed(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 合成資產揭露。
 *
 * 「不可忽略、可收合」：沒有關閉按鈕，標題與一句摘要永遠顯示；收合只收起條列細節。
 * 收合狀態存在 sessionStorage（同一個分頁內換頁不必反覆收合），新分頁一律展開——
 * 第一次看到的人一定看得到完整內容。
 */
export function SyntheticDisclosure({ sx }: { sx?: SxProps<Theme> }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const d = t.common.disclosure;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* 無痕模式等：只影響記憶，不影響顯示 */
    }
  };

  return (
    <Alert
      severity="warning"
      variant="outlined"
      role="note"
      aria-label={d.title}
      data-testid="synthetic-disclosure"
      sx={[{ alignItems: 'flex-start', '& .MuiAlert-message': { width: 1 } }, ...(Array.isArray(sx) ? sx : [sx])]}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={toggle}
          aria-expanded={!collapsed}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {collapsed ? d.expand : d.collapse}
        </Button>
      }
    >
      <AlertTitle sx={{ fontWeight: 700 }}>{d.title}</AlertTitle>
      <Box component="span" sx={{ display: 'block' }}>
        {d.summary}
      </Box>
      <Collapse in={!collapsed} unmountOnExit={false}>
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5, '& li': { mb: 0.5 } }}>
          <li>{d.prototype}</li>
          <li>{d.synthetic}</li>
          <li>{d.noAdvice}</li>
        </Box>
      </Collapse>
    </Alert>
  );
}
