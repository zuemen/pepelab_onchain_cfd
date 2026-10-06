import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'

import { paths } from 'src/routes/paths'
import { RouterLink } from 'src/routes/components'

import { t } from 'src/locales'

export type RwaPageKey = 'cards' | 'oracle' | 'solvency'

const PAGES: { key: RwaPageKey; href: string }[] = [
  { key: 'cards', href: paths.pepefi.rwa },
  { key: 'oracle', href: paths.pepefi.oracle },
  { key: 'solvency', href: paths.pepefi.solvency },
]

/**
 * 三頁之間的切換列。簡單模式的側邊欄沒有這三頁（Simple 導覽是固定的 8 個入口），
 * 所以從 /tokens 的連結進到 /rwa 之後，要能直接走到另外兩頁。
 */
export function RwaPagesNav({ current }: { current: RwaPageKey }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1.5 }} data-testid="rwa-pages-nav">
      {PAGES.map((p) => (
        <Chip
          key={p.key}
          component={RouterLink}
          href={p.href}
          clickable
          size="small"
          label={t.rwa.nav[p.key]}
          color={p.key === current ? 'primary' : 'default'}
          variant={p.key === current ? 'filled' : 'outlined'}
          aria-current={p.key === current ? 'page' : undefined}
        />
      ))}
    </Stack>
  )
}
