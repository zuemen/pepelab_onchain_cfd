import type { Tier } from 'src/lib/pepefi/carbon'
import type { TierBucket } from 'src/lib/pepefi/carbonMix'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { fNum, tabularNums } from 'src/lib/pepefi/format'
import { TIER_BUCKETS, carbonTierMix } from 'src/lib/pepefi/carbonMix'

/**
 * #333：一組持倉的碳分級組成。交易者頁（依他目前發布的策略權重，策略讀自鏈上）與投資組合
 * （依部位與現貨代幣的市值）共用。等級讀自交易所定價用的鏈上見證。
 *
 * 刻意不是噸數：不同資產的碳強度單位不同，不能加總（CONTEXT.md 的 Carbon Basis）。
 * 也刻意沒有資產的 SDG 標籤：11 個資產只有少數有發行方自己揭露的 SDG，其餘會是本平台的宣稱
 * （docs/data/sdg-sources.md）。
 */

export interface MixHolding {
  /** 資產 id（bytes32）。 */
  asset: string
  /** 任何非負刻度（bps、市值），只有相對大小有意義。空方部位一樣計入：曝險就是曝險。 */
  weight: number
}

/**
 * 堆疊條的配色。等級名稱沿用 /tokens 的 `tokens.provenance.carbonTier`（同一套等級），配色不能沿用
 * AssetProvenance 的 TIER_COLOR：那組 chip 配色讓中碳與未評等同為 warning，堆疊條上會分不出來。
 */
const BAR_COLOR: Record<TierBucket, string> = {
  low: 'success.main',
  mid: 'warning.main',
  high: 'error.main',
  unrated: 'grey.500',
  unknown: 'grey.300',
}

const pct = (n: number) => interpolate(t.esg.impact.pct, { pct: fNum(n, { dp: 0 }) })

const tierName = (b: TierBucket) => (b === 'unknown' ? t.esg.impact.tierUnknown : t.tokens.provenance.carbonTier[b])

export default function CarbonTierMixCard({
  holdings,
  tierOf,
  source,
}: {
  holdings: readonly MixHolding[]
  tierOf: (assetId: string) => Tier | null
  source: 'trader' | 'portfolio'
}) {
  const live = holdings.filter((h) => h.weight > 0)
  const mix = carbonTierMix(live, tierOf)

  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        {t.esg.impact.tierTitle}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {t.esg.impact.tierLead}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 2 }}>
        {source === 'trader' ? t.esg.impact.traderSource : t.esg.impact.portfolioSource}
      </Typography>
      {live.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t.esg.impact.empty}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', bgcolor: 'action.hover' }}>
            {TIER_BUCKETS.filter((b) => mix[b] > 0).map((b) => (
              <Tooltip key={b} title={`${tierName(b)} ${pct(mix[b])}`}>
                <Box sx={{ width: `${mix[b]}%`, bgcolor: BAR_COLOR[b] }} />
              </Tooltip>
            ))}
          </Box>
          <Stack spacing={0.75} sx={{ mt: 2, maxWidth: 360 }}>
            {TIER_BUCKETS.map((b) => (
              <Stack key={b} direction="row" spacing={1} alignItems="center">
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: BAR_COLOR[b] }} />
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {tierName(b)}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 'bold', ...tabularNums }}>
                  {pct(mix[b])}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t.esg.impact.tierSource}
          </Typography>
        </>
      )}
    </Card>
  )
}
