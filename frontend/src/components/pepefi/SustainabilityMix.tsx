import type { Tier } from 'src/lib/pepefi/carbon'
import type { TierBucket } from 'src/lib/pepefi/carbonMix'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { sdgGoalName, sdgHoldings, sdgDistribution } from 'src/lib/pepefi/sdg'
import { fNum, tabularNums } from 'src/lib/pepefi/format'
import { TIER_BUCKETS, carbonTierMix } from 'src/lib/pepefi/carbonMix'

/**
 * #333：一組持倉的 SDG 分布與碳分級組成。交易者頁（依他目前發布的策略權重，策略讀自鏈上）與
 * 投資組合（依部位市值）共用。
 *
 * 碳分級組成刻意不是噸數：不同資產的碳強度單位不同，不能加總（CONTEXT.md 的 Carbon Basis）。
 * SDG 對應是團隊判斷，卡片上照實標示。
 */

export interface MixHolding {
  /** 資產 id（bytes32）。 */
  asset: string
  /** 任何非負刻度（bps、市值），只有相對大小有意義。 */
  weight: number
  /** false＝空方部位：計入碳分級組成（曝險就是曝險），不計入 SDG 分布。省略＝做多（現貨）。 */
  isLong?: boolean
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

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <Box sx={{ height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden', flex: 1 }}>
      <Box sx={{ height: '100%', width: `${Math.min(100, value)}%`, bgcolor: color }} />
    </Box>
  )
}

export default function SustainabilityMix({
  holdings,
  tierOf,
  source,
}: {
  holdings: readonly MixHolding[]
  tierOf: (assetId: string) => Tier | null
  source: 'trader' | 'portfolio'
}) {
  const live = holdings.filter((h) => h.weight > 0)
  const sdg = sdgDistribution(sdgHoldings(live))
  const mix = carbonTierMix(live, tierOf)

  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        {source === 'trader' ? t.esg.impact.traderSource : t.esg.impact.portfolioSource}
      </Typography>
      {live.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t.esg.impact.empty}
        </Typography>
      ) : (
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                {t.esg.impact.sdgTitle}
              </Typography>
              <Chip size="small" variant="outlined" label={t.esg.sdg.basisChip} />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              {t.esg.impact.sdgLead}
            </Typography>
            <Stack spacing={1.25}>
              {sdg.goals.map((g) => (
                <Box key={g.goal}>
                  <Typography variant="caption" sx={{ display: 'block' }}>
                    {interpolate(t.esg.sdg.goalLabel, { goal: g.goal })}
                    {' · '}
                    {sdgGoalName(t.esg.sdg.goalNames, g.goal)}
                  </Typography>
                  {g.positivePct > 0 && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Bar value={g.positivePct} color="success.main" />
                      <Typography variant="caption" sx={{ width: 96, ...tabularNums }}>
                        {t.esg.sdg.positive} {pct(g.positivePct)}
                      </Typography>
                    </Stack>
                  )}
                  {g.negativePct > 0 && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Bar value={g.negativePct} color="error.main" />
                      <Typography variant="caption" sx={{ width: 96, ...tabularNums }}>
                        {t.esg.sdg.negative} {pct(g.negativePct)}
                      </Typography>
                    </Stack>
                  )}
                </Box>
              ))}
            </Stack>
            {sdg.shortPct > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {interpolate(t.esg.impact.sdgShort, { pct: fNum(sdg.shortPct, { dp: 0 }) })}
              </Typography>
            )}
            {sdg.unmappedPct > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {interpolate(t.esg.impact.sdgUnmapped, { pct: fNum(sdg.unmappedPct, { dp: 0 }) })}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {t.esg.impact.basisNote}
            </Typography>
          </Grid>

          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              {t.esg.impact.tierTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              {t.esg.impact.tierLead}
            </Typography>
            <Box sx={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', bgcolor: 'action.hover' }}>
              {TIER_BUCKETS.filter((b) => mix[b] > 0).map((b) => (
                <Tooltip key={b} title={`${tierName(b)} ${pct(mix[b])}`}>
                  <Box sx={{ width: `${mix[b]}%`, bgcolor: BAR_COLOR[b] }} />
                </Tooltip>
              ))}
            </Box>
            <Stack spacing={0.75} sx={{ mt: 2 }}>
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
          </Grid>
        </Grid>
      )}
    </Card>
  )
}
