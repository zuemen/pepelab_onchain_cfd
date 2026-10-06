import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'

import { t } from 'src/locales'

/** 法規名稱與一手出處（docs/DESIGN_BESU.md §5.1，查證 2026-10-05）。網址不是顯示字串。 */
const LAW_SOURCES = {
  futuresAct: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0400100',
  leverageRules: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0400151',
  // 櫃買中心「證券商衍生性商品業務諮詢常見問答題庫」PDF（路徑以百分比編碼，避免原始碼裡出現中文字串）。
  tpexRules:
    'https://dsp.tpex.org.tw/storage/derivatives_download/%E8%AD%89%E5%88%B8%E5%95%86%E8%A1%8D%E7%94%9F%E6%80%A7%E5%95%86%E5%93%81%E6%A5%AD%E5%8B%99%E8%AB%AE%E8%A9%A2%E5%B8%B8%E8%A6%8B%E5%95%8F%E7%AD%94%E9%A1%8C%E5%BA%AB.pdf',
  sandbox: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0380254',
} as const

const ITEM_ORDER = ['prototype', 'synthetic', 'noUnderlying', 'settlement', 'regulated', 'unaudited'] as const

/** 「法遵與定位揭露」區塊（/rwa 頁）。純靜態文字，不讀鏈。 */
export function ComplianceDisclosure() {
  const c = t.rwa.compliance
  return (
    <Card variant="outlined" data-testid="rwa-compliance" sx={{ p: 2.5, borderColor: 'warning.main' }}>
      <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>
        {c.title}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {ITEM_ORDER.map((k) => (
          <Typography key={k} component="li" variant="body2" sx={{ lineHeight: 1.6 }}>
            {c.items[k]}
          </Typography>
        ))}
      </Box>
      <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
        {c.lawsTitle}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {(Object.keys(LAW_SOURCES) as (keyof typeof LAW_SOURCES)[]).map((k) => (
          <Typography key={k} component="li" variant="body2">
            <Link href={LAW_SOURCES[k]} target="_blank" rel="noopener noreferrer" underline="hover">
              {c.laws[k]}
            </Link>
          </Typography>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
        {c.notLegalAdvice}
      </Typography>
    </Card>
  )
}
