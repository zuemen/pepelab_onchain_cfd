import type { Theme, SxProps } from '@mui/material/styles';

import { useHref, useLocation } from 'react-router';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import { tenant } from 'src/tenant';
import { localeHref } from 'src/locales/site';
import { LOCALES } from 'src/locales/catalogs';
import { t, locale, siteLocales } from 'src/locales';

// ----------------------------------------------------------------------

/**
 * 「中 / EN」語言切換（issue #396）。每種語言是一份獨立的 build，所以這裡是普通的
 * `<a href>`、整頁跳到另一種語言的同一頁，不是 router 內的導覽。
 * 只出一種語言的租戶（siteLocales 沒填）不顯示。
 */
export function LocaleSwitch({ sx }: { sx?: SxProps<Theme> }) {
  // 含 basename 的完整路徑，例如英文站上的 /en/esg?asset=sAAPL。
  const currentPath = useHref(useLocation());

  if (siteLocales.length < 2) return null;

  return (
    <Stack
      role="group"
      aria-label={t.common.layout.localeSwitchAria}
      direction="row"
      alignItems="center"
      sx={[{ gap: 0.25 }, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      {siteLocales.map((code, i) => {
        const { htmlLang, switchLabel, nativeName } = LOCALES[code];
        const current = code === locale;
        return (
          <Stack key={code} direction="row" alignItems="center" sx={{ gap: 0.25 }}>
            {i > 0 && (
              <Box component="span" aria-hidden sx={{ color: 'text.disabled', fontSize: '0.7rem' }}>
                /
              </Box>
            )}
            <Box
              component={current ? 'span' : 'a'}
              href={current ? undefined : (localeHref(currentPath, code, tenant) ?? undefined)}
              lang={htmlLang}
              hrefLang={current ? undefined : htmlLang}
              aria-label={nativeName}
              aria-current={current ? 'true' : undefined}
              sx={{
                px: 0.5,
                py: 0.25,
                borderRadius: 0.75,
                fontSize: '0.7rem',
                fontWeight: 700,
                lineHeight: 1.5,
                textDecoration: 'none',
                color: current ? 'primary.main' : 'text.secondary',
                '&:hover': current ? undefined : { color: 'text.primary', bgcolor: 'action.hover' },
              }}
            >
              {switchLabel}
            </Box>
          </Stack>
        );
      })}
    </Stack>
  );
}
