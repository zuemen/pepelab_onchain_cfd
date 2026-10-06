import Link from '@mui/material/Link'

import { paths } from 'src/routes/paths'
import { RouterLink } from 'src/routes/components'

import { t } from 'src/locales'

/**
 * 交易頁資產選擇處的小連結：連到 /rwa 的資產卡與法遵揭露。
 * 刻意做成獨立元件，插進共用頁面時只多一行。
 */
export function RwaInfoLink({ dense = false }: { dense?: boolean }) {
  return (
    <Link
      component={RouterLink}
      href={paths.pepefi.rwa}
      title={t.rwa.link.hint}
      data-testid="rwa-info-link"
      underline="hover"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        fontSize: dense ? 12 : 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        color: 'info.main',
      }}
    >
      {t.rwa.link.label} →
    </Link>
  )
}
