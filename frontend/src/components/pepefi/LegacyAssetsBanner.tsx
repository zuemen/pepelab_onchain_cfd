import type { LegacyAssetsState } from 'src/hooks/useLegacyAssets';

import { Link as RouterLink } from 'react-router';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import AlertTitle from '@mui/material/AlertTitle';

import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { scanHasAssets, legacyEntryVisible } from 'src/lib/pepefi/legacyExchange';

// ----------------------------------------------------------------------

/**
 * Portfolio 上通往 /legacy 的入口。
 *
 * 只有在使用者**確實**在舊合約上有保證金或未平倉部位時才出現；讀取中、讀取失敗、
 * 或全部是空的都回 null——絕大多數使用者從來不會看到它，也不該為了一個與他無關的
 * 遷移議題多看一個警告。側邊欄不放入口，理由見 docs/LEGACY_EXCHANGES.md。
 */
export function LegacyAssetsBanner({ state }: { state: LegacyAssetsState }) {
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
