// /tokens 的圖文介紹：買進從頭到尾怎麼走，手續費和碳權又是什麼關係。
//
// 費率一律從 carbon.ts 來，不在文案裡寫第二份數字。退役那一段照 ADR-022 的規定：畫面只要
// 講到退役，就要同時講這是模擬碳權。買入手續費有沒有接上退役由鏈上決定（carbonLinked）：
// 合約升級前後，畫面都要說實話。

import { Icon } from '@iconify/react'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { paramsFor, carbonSharePer100Usdc, CARBON_FEE_SHARE_BPS, type Tier } from 'src/lib/pepefi/carbon'

import { TIER_COLOR } from './AssetProvenance'

const STEP_ICONS = [
  'solar:wallet-bold-duotone',
  'solar:leaf-bold-duotone',
  'solar:bag-check-bold-duotone',
  'solar:restart-bold-duotone',
] as const

const FEE_TIERS: readonly Tier[] = ['low', 'mid', 'high']

const CARBON_CHAIN_ICONS = [
  'solar:hand-money-bold-duotone',
  'solar:leaf-bold-duotone',
  'solar:fire-bold-duotone',
] as const

const feeLabel = (tier: Tier) => `${(paramsFor(tier).tradingFeeBps / 100).toFixed(2)}%`

export function BuyFlowIntro({ carbonLinked }: { carbonLinked: boolean }) {
  const copy = t.tokens.buyFlow
  const tierNames = t.tokens.provenance.carbonTier
  const carbon = carbonLinked
    ? {
        chain: [interpolate(copy.linked.chainStart, { share: `${CARBON_FEE_SHARE_BPS / 100}%` }), ...copy.chainRest],
        body: interpolate(copy.linked.body, {
          low: String(carbonSharePer100Usdc('low')),
          high: String(carbonSharePer100Usdc('high')),
        }),
        note: copy.linked.note,
      }
    : { chain: [copy.unlinked.chainStart, ...copy.chainRest], body: copy.unlinked.body, note: copy.unlinked.note }

  return (
    <Card sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>{copy.title}</Typography>

      <Box
        component="ol"
        sx={{
          listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
        }}
      >
        {copy.steps.map((step, i) => (
          <Box component="li" key={step.title} sx={{ position: 'relative', minWidth: 0 }}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1 }}>
              <Box
                sx={{
                  width: 40, height: 40, borderRadius: '50%', flexShrink: 0, color: 'primary.main',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  bgcolor: 'action.selected',
                }}
              >
                <Icon icon={STEP_ICONS[i]} width={24} aria-hidden />
              </Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {i + 1}. {step.title}
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">{step.body}</Typography>

            {/* 第 2 步：碳分級怎麼決定費率，三個等級直接擺出來比。 */}
            {i === 1 && (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {FEE_TIERS.map((tier) => (
                  <Chip
                    key={tier}
                    size="small"
                    variant="outlined"
                    color={TIER_COLOR[tier]}
                    label={`${tier === 'high' ? copy.highOrUnrated : tierNames[tier]} ${feeLabel(tier)}`}
                  />
                ))}
              </Stack>
            )}

            {i < copy.steps.length - 1 && (
              <Box
                sx={{
                  display: { xs: 'none', lg: 'block' }, position: 'absolute', top: 12, right: 0,
                  color: 'text.disabled', lineHeight: 0,
                }}
              >
                <Icon icon="solar:alt-arrow-right-linear" width={16} aria-hidden />
              </Box>
            )}
          </Box>
        ))}
      </Box>

      <Box sx={{ mt: 2.5, p: 2, borderRadius: 1.5, bgcolor: 'action.hover' }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{copy.carbonTitle}</Typography>
          <Chip size="small" color="warning" variant="outlined" label={copy.simulatedChip} />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          {carbon.chain.map((label, i) => (
            <Stack key={label} direction="row" spacing={1} alignItems="center">
              {i > 0 && (
                <Box sx={{ color: 'text.disabled', lineHeight: 0 }}>
                  <Icon icon="solar:alt-arrow-right-linear" width={16} aria-hidden />
                </Box>
              )}
              <Box sx={{ color: 'success.main', lineHeight: 0 }}>
                <Icon icon={CARBON_CHAIN_ICONS[i]} width={20} aria-hidden />
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{label}</Typography>
            </Stack>
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary">{carbon.body}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {carbon.note}
        </Typography>
      </Box>
    </Card>
  )
}
