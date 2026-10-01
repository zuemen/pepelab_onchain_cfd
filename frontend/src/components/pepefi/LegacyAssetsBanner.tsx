import type { LegacyAssetsState } from 'src/hooks/useLegacyAssets';

import { Link as RouterLink } from 'react-router';

import Link from '@mui/material/Link';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import AlertTitle from '@mui/material/AlertTitle';

import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { scanHasAssets, legacyEntryVisible, legacyReadFailedHintVisible } from 'src/lib/pepefi/legacyExchange';

// ----------------------------------------------------------------------

/**
 * Portfolio 上通往 /legacy 的入口。
 *
 * 只有在使用者**確實**在舊合約上有保證金或未平倉部位時才出現；讀取中、讀取失敗、
 * 或全部是空的都回 null——絕大多數使用者從來不會看到它，也不該為了一個與他無關的
 * 遷移議題多看一個警告。側邊欄不放入口，理由見 docs/LEGACY_EXCHANGES.md。
 *
 * 例外：某顆舊合約讀取失敗（重試後仍失敗）時，讀不到不等於沒有，顯示一行低調的文字提示；
 * 確認全空時仍什麼都不顯示。
 */
export function LegacyAssetsBanner({ state }: { state: LegacyAssetsState }) {
  if (legacyReadFailedHintVisible(state.scans)) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="legacy-read-failed-hint">
        {t.legacy.banner.readFailedHint}{' '}
        <Link component={RouterLink} to={paths.pepefi.legacy}>{t.legacy.banner.readFailedLink}</Link>
      </Typography>
    );
  }
  if (!legacyEntryVisible(state.scans)) return null;
  const count = (state.scans ?? []).filter(scanHasAssets).length;

  return (
    <Alert
      severity="warning"
      data-testid="legacy-assets-banner"
      action={
        <Button
          component={RouterLink}
          to={paths.pepefi.legacy}
          color="inherit"
          size="small"
          variant="outlined"
          sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
        >
          {t.legacy.banner.cta}
        </Button>
      }
    >
      <AlertTitle>{t.legacy.banner.title}</AlertTitle>
      {interpolate(t.legacy.banner.body, { count })}
    </Alert>
  );
}
