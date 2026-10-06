import type { WaterfallLayer } from 'src/lib/pepefi/solvency'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { formatAmount } from 'src/lib/pepefi/solvency'
import { readingText } from 'src/lib/pepefi/rwaLabels'

const BAR_COLOR = {
  margin: 'primary.main',
  insurance: 'info.main',
  adl: 'warning.main',
  badDebt: 'error.main',
} as const

function layerValue(layer: WaterfallLayer, decimals: number | null): string {
  const v = t.rwa.solvency.layerValue
  const fmt = (x: bigint) => (decimals === null ? t.rwa.common.decimalsFailed : `${formatAmount(x, decimals)} USDC`)
  switch (layer.key) {
    case 'margin':
      return interpolate(v.margin, { amount: readingText(layer.amount ?? undefined, fmt) })
    case 'insurance':
      return interpolate(v.insurance, { amount: readingText(layer.amount ?? undefined, fmt) })
    case 'adl':
      return readingText(layer.enabled, (on) => (on ? v.adlOn : v.adlOff))
    case 'badDebt':
      return v.badDebt
    default:
      return ''
  }
}

/** 損失吸收瀑布：保證金 → 保險金庫 → ADL → 壞帳事件（docs/RISK_WATERFALL.md §2.3）。 */
export function LossWaterfall({ layers, decimals }: { layers: WaterfallLayer[]; decimals: number | null }) {
  const s = t.rwa.solvency
  return (
    <Card variant="outlined" data-testid="loss-waterfall" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 800 }}>
        {s.waterfallTitle}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        {s.waterfallIntro}
      </Typography>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {layers.map((layer, i) => {
          const copy = s.waterfall[layer.key]
          const off = layer.key === 'adl' && layer.enabled?.status === 'ok' && !layer.enabled.value
          return (
            <Box
              component="li"
              key={layer.key}
              data-testid={`waterfall-${layer.key}`}
              sx={{
                display: 'flex',
                gap: 1.5,
                alignItems: 'stretch',
                ml: { xs: 0, sm: i * 2.5 },
                opacity: off ? 0.6 : 1,
              }}
            >
              <Box sx={{ width: 6, borderRadius: 3, bgcolor: BAR_COLOR[layer.key], flexShrink: 0 }} />
              <Box sx={{ py: 0.5, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                  {copy.title}
                </Typography>
                <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
                  {copy.body}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                  {layerValue(layer, decimals)}
                </Typography>
              </Box>
            </Box>
          )
        })}
      </Box>
      <Typography variant="body2" sx={{ mt: 2, fontWeight: 600, color: 'warning.dark' }}>
        {s.noGuarantee}
      </Typography>
    </Card>
  )
}
