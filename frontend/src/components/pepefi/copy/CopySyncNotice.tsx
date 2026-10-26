import type { WalletAPI } from 'src/hooks/useWallet';
import type { SyncAttention } from 'src/lib/pepefi/autoSync';

import { useState, useEffect } from 'react';
import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { useCopySyncAlerts } from 'src/hooks/useCopySyncAlerts';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';

// ----------------------------------------------------------------------

/**
 * 全站提醒：交易者發布了新版，你有紀錄還停在舊版（ADR-024）。
 *
 * 跟隨者自己的 agent（copy-sync personal 模式或 --notify-only）會用 webhook 通知本人；沒有跑 agent 的人
 * 只能靠這裡。尤其是「自動同步不會自己發生」的情況——沒開自動同步、油箱不足、交易所調高了執行費——
 * 要讓他在打開任何內頁時就知道，而不是哪天剛好打開投資組合才發現。
 *
 * 投資組合頁本身不顯示（那裡每一列都有完整的同步狀態）；按「知道了」之後，同一組落後（哪一筆、
 * 落後到哪一版）在這個分頁裡不再提醒，交易者再發一版就會再出現。文案刻意不寫「跟單」與槓桿，
 * 與投資組合的同步欄位一致（Simple 模式、跟單旗標關閉的建置也看得到既有紀錄的提醒）。
 */
const DISMISS_KEY = 'pepefi.copySyncNotice.dismissed';

function readDismissed(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(signature: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, signature);
  } catch {
    /* 私密視窗或封鎖儲存：這次的「知道了」只在記憶體裡有效 */
  }
}

/** 純呈現（伺服器端渲染測試用）。沒有落後時回 null。 */
export function CopySyncNoticeView({ attention, onDismiss }: { attention: SyncAttention; onDismiss: () => void }) {
  if (attention.behind === 0) return null;
  const T = t.portfolio.syncNotice;
  const reasons = attention.reasons.map(r => T.reasons[r]).join(T.reasonSeparator);
  return (
    <Box sx={{ px: { xs: 2, md: 3 }, pt: 2 }}>
      <Alert
        role="status"
        severity={attention.needsYou > 0 ? 'warning' : 'info'}
        data-testid="copy-sync-notice"
        action={
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button
              component={RouterLink}
              to={paths.pepefi.portfolio}
              color="inherit"
              size="small"
              variant="outlined"
              sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              {T.cta}
            </Button>
            <Button color="inherit" size="small" onClick={onDismiss} sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}>
              {T.dismiss}
            </Button>
          </Box>
        }
      >
        {interpolate(T.behind, { count: attention.behind })}
        {attention.needsYou > 0
          ? interpolate(T.needsYou, { count: attention.needsYou, reasons })
          : T.waitingOnly}
      </Alert>
    </Box>
  );
}

export function CopySyncNotice({ wallet, pathname, hidden }: { wallet: WalletAPI; pathname: string; hidden: boolean }) {
  const { attention, autoSyncSupported } = useCopySyncAlerts(wallet, pathname);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { setDismissed(readDismissed()); }, []);

  // 與投資組合的「策略已更新」標示同一個條件：跟單旗標關閉、合約也不支援自動同步時，沒有就地更新的路可走。
  if (hidden || !attention || attention.behind === 0) return null;
  if (!FEATURE_COPY_TRADING && !autoSyncSupported) return null;
  if (pathname === paths.pepefi.portfolio) return null;
  if (dismissed === attention.signature) return null;

  return (
    <CopySyncNoticeView
      attention={attention}
      onDismiss={() => {
        writeDismissed(attention.signature);
        setDismissed(attention.signature);
      }}
    />
  );
}
