import type { Tier } from 'src/lib/pepefi/carbon'

import Typography from '@mui/material/Typography'

import { AssetProvenanceSummary } from './AssetProvenance'

/**
 * 表格裡一格的碳分級：交易所定價用的那一個（usePricingCarbonTiers）。#383 拿掉平台自評的
 * ESG 徽章後，部位表與配置表改放這個——它直接決定那個部位的手續費與槓桿上限。
 * 讀不到（null）就是「—」，不能畫成未評等：未評等是一個結論，讀不到不是。
 */
export default function PricingTierCell({ tier }: { tier: Tier | null }) {
  if (tier === null) return <Typography variant="caption" color="text.secondary">—</Typography>
  return <AssetProvenanceSummary tier={tier} nowrap />
}
