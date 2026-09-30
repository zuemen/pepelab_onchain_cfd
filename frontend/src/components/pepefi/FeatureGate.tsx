import type { ReactNode } from 'react';

import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import { paths } from 'src/routes/paths';
import { RouterLink } from 'src/routes/components';

import { t } from 'src/locales';

// ----------------------------------------------------------------------

/**
 * 商業版功能旗標的路由閘門。
 *
 * 旗標關閉時不 render 子頁面（lazy chunk 也不會被下載），改顯示「此功能未啟用」
 * 與回首頁按鈕。選擇顯示說明頁而不是靜默導回首頁：照著舊連結或書籤進來的人
 * 會知道這不是壞掉，而是這個部署沒開。
 */
export function FeatureGate({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (enabled) return <>{children}</>;

  return (
    <Stack
      data-testid="feature-disabled"
      spacing={2}
      sx={{ alignItems: 'center', textAlign: 'center', py: 10, px: 2, maxWidth: 480, mx: 'auto' }}
    >
      <Typography variant="h4" component="h1">
        {t.common.featureDisabled.title}
      </Typography>
      <Typography sx={{ color: 'text.secondary' }}>{t.common.featureDisabled.body}</Typography>
      <Button component={RouterLink} href={paths.pepefi.landing} variant="contained">
        {t.common.featureDisabled.backHome}
      </Button>
    </Stack>
  );
}
