// issue #100 ①③④：資產身世卡 +「誰負責什麼」+ 時間尺度。
//
// 同一顆資產、同一份程式，只是把系統已經知道的事情說出來：追蹤標的 /
// 「本代幣不代表所有權」/ 價格來源與新鮮度 / 碳強度與出處 / KYC 理由 /
// 上次與下次見證日。逐檔事實在 lib/pepefi/assetMeta.ts，顯示字串在
// catalog 的 tokens.provenance / tokens.who。

import type { ReactNode } from 'react'

import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import { Icon } from '@iconify/react'

import { MONO } from 'src/components/pepefi/brandKit'
import { t, interpolate } from 'src/locales'
import type { AssetMeta } from 'src/lib/pepefi/assetMeta'
import {
  attestationExpired,
  nextAttestationDue,
  type Tier,
} from 'src/lib/pepefi/carbon'
import { classifyFreshness, type Freshness } from 'src/lib/pepefi/priceFreshness'

const TIER_COLOR: Record<Tier, 'default' | 'success' | 'warning' | 'error'> = {
  unrated: 'warning',
  low: 'success',
  mid: 'warning',
  high: 'error',
}

const FRESHNESS_COLOR: Record<Freshness['level'], 'success' | 'warning' | 'error' | 'default'> = {
  live: 'success',
  aging: 'warning',
  stale: 'error',
  unknown: 'default',
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ mt: 0.25 }}>
        {children}
      </Typography>
    </Box>
  )
}

export interface AssetProvenanceCardProps {
  meta: AssetMeta
  /** 結算價的鏈上 updatedAt（秒）。有的話顯示新鮮度分級。 */
  priceUpdatedAtSec?: number
  /** 合約的 maxPriceAge（秒）；預設 Base Sepolia 的 6 小時。 */
  maxPriceAgeSec?: number
  /** 這顆資產最舊未平倉部位的 openedAt（秒）——持有天數。沒有部位就不顯示。 */
  heldSinceSec?: number
  nowMs?: number
}

export function AssetProvenanceCard({
  meta,
  priceUpdatedAtSec,
  maxPriceAgeSec = 21600,
  heldSinceSec,
  nowMs = Date.now(),
}: AssetProvenanceCardProps) {
  const p = meta.provenance
  const c = meta.carbon
  const tp = t.tokens.provenance
  const str = tp.assets[meta.symbol as keyof typeof tp.assets]
  if (!p || !c || !str) return null

  const nowSec = Math.floor(nowMs / 1000)

  const freshness =
    priceUpdatedAtSec !== undefined
      ? classifyFreshness({ updatedAtSec: priceUpdatedAtSec, nowSec, maxPriceAgeSec })
      : null

  const expired = attestationExpired(c.observed, nowMs)
  // 見證過期 → 這顆資產視同未評等（詞彙表 Attestation：lapsed 就停止計數）。
  const shownTier: Tier = expired ? 'unrated' : c.tier
  const heldDays =
    heldSinceSec !== undefined ? Math.max(0, Math.floor((nowSec - heldSinceSec) / 86400)) : null

  return (
    <Accordion disableGutters sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
      <AccordionSummary
        expandIcon={<Icon icon="solar:alt-arrow-down-linear" />}
        sx={{ px: 0, minHeight: 0 }}
      >
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="caption" sx={{ fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {tp.sectionTitle}
          </Typography>
          <Chip size="small" color={TIER_COLOR[shownTier]} variant="outlined" label={tp.carbonTier[shownTier]} />
          {freshness && (
            <Chip
              size="small"
              color={FRESHNESS_COLOR[freshness.level]}
              variant="outlined"
              label={`${tp.freshnessLabel}: ${freshness.label}`}
            />
          )}
        </Stack>
      </AccordionSummary>

      <AccordionDetails sx={{ px: 0, pt: 0 }}>
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          <Field label={tp.underlyingLabel}>{str.underlying}</Field>

          <Field label={tp.referenceIdLabel}>
            <Box component="span" sx={{ fontFamily: MONO }}>{p.referenceId}</Box>
          </Field>

          <Field label={tp.priceSourceLabel}>
            {tp.priceFeedName[p.priceFeed]}
            <Box component="span" sx={{ fontFamily: MONO, color: 'text.secondary', ml: 0.75 }}>
              {p.priceSymbol}
            </Box>
          </Field>

          {/* ── 碳強度 ── */}
          <Box>
            <Typography variant="caption" color="text.secondary" display="block">
              {tp.carbonTitle}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
              <Chip size="small" color={TIER_COLOR[shownTier]} label={tp.carbonTier[shownTier]} />
              {c.intensity !== null && !expired && (
                <Typography variant="body2" sx={{ fontFamily: MONO }}>
                  {c.intensity} <Typography component="span" variant="caption" color="text.secondary">
                    {tp.carbonBasis.revenue}
                  </Typography>
                </Typography>
              )}
              {c.intensity === null && (
                <Typography variant="caption" color="text.secondary">
                  {tp.carbonBasis[c.basis]}
                </Typography>
              )}
            </Stack>

            {(shownTier === 'unrated') && (
              <Alert severity="warning" variant="outlined" sx={{ mt: 1, py: 0 }}>
                {tp.carbonUnratedNote}
              </Alert>
            )}

            <Stack spacing={0.25} sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {tp.observedLabel}: <Box component="span" sx={{ fontFamily: MONO }}>{c.observed}</Box>
                {c.observed !== '—' && (
                  <>
                    {'  ·  '}
                    {tp.nextDueLabel}: <Box component="span" sx={{ fontFamily: MONO }}>{nextAttestationDue(c.observed)}</Box>
                  </>
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {tp.sourceLabel}:{' '}
                <Link href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {str.carbonSource}
                </Link>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {tp.caveatLabel}: {str.carbonCaveat}
              </Typography>
            </Stack>
          </Box>

          {/* ── KYC 理由 ── */}
          <Box>
            <Typography variant="caption" color="text.secondary" display="block">
              {tp.kycTitle}
            </Typography>
            <Typography
              variant="body2"
              sx={{ mt: 0.25 }}
              color={meta.regulated ? 'text.primary' : 'text.secondary'}
            >
              {meta.regulated ? tp.kycReason : tp.kycNotGated}
            </Typography>
          </Box>

          {/* ── 時間尺度（issue #100 ④）── */}
          {(heldDays !== null || c.observed !== '—') && (
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {heldDays !== null && (
                <Typography variant="caption" color="text.secondary">
                  {tp.heldDaysLabel}{' '}
                  <Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>
                    {interpolate(tp.heldDaysValue, { n: heldDays })}
                  </Box>
                </Typography>
              )}
              {c.observed !== '—' && (
                <Typography variant="caption" color="text.secondary">
                  {interpolate(tp.sinceLabel, { date: c.observed })}
                </Typography>
              )}
            </Stack>
          )}

          <Typography variant="caption" color="text.disabled">
            {tp.disclaimer}
          </Typography>
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

// ── 誰負責什麼 ──────────────────────────────────────────────────────────────

export function WhoRunsWhat() {
  const w = t.tokens.who
  const rows: Array<[string, string]> = [
    [w.priceRole, w.priceWho],
    [w.carbonRole, w.carbonWho],
    [w.reserveRole, w.reserveWho],
    [w.auditRole, w.auditWho],
  ]
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        {w.title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {w.intro}
      </Typography>
      <Stack spacing={1.25} divider={<Divider flexItem />}>
        {rows.map(([role, who]) => (
          <Box key={role} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '140px 1fr' }, gap: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
              {role}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {who}
            </Typography>
          </Box>
        ))}
      </Stack>
      <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
        <Typography variant="caption" sx={{ fontWeight: 'bold', display: 'block' }}>
          {w.disclosureTitle}
        </Typography>
        <Typography variant="caption">{w.disclosure}</Typography>
      </Alert>
    </Box>
  )
}
