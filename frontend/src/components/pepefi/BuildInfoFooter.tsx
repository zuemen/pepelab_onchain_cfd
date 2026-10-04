import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { PRIMARY_CHAIN_ID } from 'src/contracts/addresses';
import { buildInfoView, injectedBuildInfo } from 'src/lib/pepefi/buildInfo';

// ----------------------------------------------------------------------

const BUILD = injectedBuildInfo();

/**
 * 頁尾的版本列：連到哪條測試網（chainId）、前端是哪個 commit、什麼時候 build 的。
 *
 * 給審查與 Demo 回答「現在看到的是哪一版」。只顯示這三件事——SHA 與時間是 build 時
 * 注入的兩個欄位（src/lib/pepefi/buildMeta.ts），不讀、不顯示任何環境變數。
 * 沒有品牌字樣，所有租戶共用。
 */
export function BuildInfoFooter({ chainId }: { chainId: number | null }) {
  const view = buildInfoView(BUILD, chainId ?? PRIMARY_CHAIN_ID);
  const sep = (
    <Box component="span" aria-hidden sx={{ mx: 1, opacity: 0.5 }}>
      ·
    </Box>
  );
  return (
    <Box
      component="footer"
      data-testid="build-info"
      sx={{ px: { xs: 2, md: 5 }, py: 1.5, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontFamily: 'ui-monospace, "SF Mono", monospace', display: 'block' }}
      >
        {t.status.build.network} {view.network}
        {sep}
        {t.status.build.version} {view.version}
        {view.builtAt && (
          <>
            {sep}
            {t.status.build.builtAt} {view.builtAt}
          </>
        )}
      </Typography>
    </Box>
  );
}
