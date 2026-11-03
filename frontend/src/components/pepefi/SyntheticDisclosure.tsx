import type { SxProps, Theme } from '@mui/material/styles';

import { useRef, useState, useEffect } from 'react';

import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import AlertTitle from '@mui/material/AlertTitle';

import { tenant } from 'src/tenant';
import { t, locale } from 'src/locales';
import { tenantDisclosureAdditions } from 'src/tenant/disclosure';

// ----------------------------------------------------------------------

const STORAGE_KEY = 'pepefi:disclosure:collapsed';

/**
 * 這個瀏覽器第一次看到揭露：展開；之後預設收合，除非使用者選擇展開。
 * 讀不到儲存空間（無痕模式等）一律展開——寧可多看，不可漏看。
 */
function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    if (localStorage.getItem(STORAGE_KEY) === null) localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* 無痕模式等：下次仍然展開 */
  }
}

/**
 * 真的進到畫面才記下「看過了」：有些頁面把揭露放在長頁底部，掛載不等於看過。
 * 不在渲染期間寫儲存空間（StrictMode 會把初始值函式呼叫兩次）。瀏覽器沒有
 * IntersectionObserver 時不記，下次仍然展開。
 */
function useMarkSeenWhenVisible() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          markSeen();
          io.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/**
 * 合成資產揭露。
 *
 * 「不可忽略、可收合」：沒有關閉按鈕，標題與一句摘要永遠顯示；收合只收起條列細節。
 * 第一次看到的人一定看得到完整內容；看過之後預設收合，不再佔掉交易頁的首屏。
 */
export function SyntheticDisclosure({ sx }: { sx?: SxProps<Theme> }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const seenRef = useMarkSeenWhenVisible();
  const d = t.common.disclosure;
  // 白標租戶的追加揭露（只能追加在核心三條之後），見 src/tenant/disclosure.ts。
  const extra = tenantDisclosureAdditions(tenant.compliance, locale, d.operatedBy);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* 無痕模式等：只影響記憶，不影響顯示 */
    }
  };

  return (
    <Alert
      ref={seenRef}
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
      {extra.operatorLine && (
        <Box component="span" sx={{ display: 'block', mt: 0.5 }} data-testid="tenant-operator">
          {extra.operatorLine}
        </Box>
      )}
      <Collapse in={!collapsed} unmountOnExit={false}>
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5, '& li': { mb: 0.5 } }}>
          <li>{d.prototype}</li>
          <li>{d.synthetic}</li>
          <li>{d.noAdvice}</li>
          {extra.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </Box>
      </Collapse>
    </Alert>
  );
}
