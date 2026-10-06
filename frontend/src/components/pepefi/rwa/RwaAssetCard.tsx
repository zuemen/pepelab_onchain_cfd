import type { ReactNode } from 'react'
import type { Reading } from 'src/lib/pepefi/contractProbe'
import type { AssetSymbol } from 'src/contracts/addresses'
import type { RwaCardChain } from 'src/lib/pepefi/rwaCards'
import type { ModeSupport } from 'src/lib/pepefi/assetModeProbe'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'

import { ASSET_IDS } from 'src/contracts/addresses'
import { t, interpolate } from 'src/locales'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { readingText } from 'src/lib/pepefi/rwaLabels'
import { marketStatus } from 'src/lib/pepefi/marketStatus'
import { sessionClassOf } from 'src/lib/pepefi/marketHours'
import { RWA_CLASS, keeperPrimary, keeperSecondary } from 'src/lib/pepefi/rwaProfile'
import { bpsToPct, rwaFlagNote, attestorNote, closureRule, kycRequirement } from 'src/lib/pepefi/rwaCards'

// ----------------------------------------------------------------------

export interface RwaAssetCardProps {
  symbol: AssetSymbol
  /** undefined = 還在讀。 */
  chain: RwaCardChain | undefined
  kycAddress: Reading<string> | undefined
  modeSupport: ModeSupport | undefined
  nowSec: number
}

type Tone = 'default' | 'warning' | 'error' | 'success'

function Field({ label, children, tone = 'default', testId }: { label: string; children: ReactNode; tone?: Tone; testId?: string }) {
  return (
    <Box
      data-testid={testId}
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '11rem 1fr' }, gap: { xs: 0.25, sm: 1.5 }, py: 0.75 }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, pt: '2px' }}>
        {label}
      </Typography>
      <Box
        sx={{
          fontSize: 14,
          color: tone === 'warning' ? 'warning.dark' : tone === 'error' ? 'error.main' : tone === 'success' ? 'success.dark' : 'text.primary',
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

function Note({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{ mt: 0.5, lineHeight: 1.55, color: tone === 'warning' ? 'warning.dark' : 'text.secondary' }}
    >
      {children}
    </Typography>
  )
}

const assetsCopy = t.tokens.provenance.assets as Record<string, { underlying: string } | undefined>

export function RwaAssetCard({ symbol, chain, kycAddress, modeSupport, nowSec }: RwaAssetCardProps) {
  const c = t.rwa.cards
  const cls = RWA_CLASS[symbol]
  const meta = ASSET_META[ASSET_IDS[symbol]]
  const primary = keeperPrimary(symbol)
  const secondary = keeperSecondary(symbol)

  const rwaFlag = chain?.rwaFlag
  const flagNote = rwaFlag ? rwaFlagNote(symbol, rwaFlag) : null
  const kyc = chain && kycAddress ? kycRequirement(kycAddress, chain.rwaFlag) : null
  const status = marketStatus({ symbol, nowSec, probe: chain?.mode ?? { kind: 'unknown' } })
  const statusKey =
    status.kind === 'closedNoStop' || status.kind === 'closedActive' ? 'closed' : status.kind
  const closure = modeSupport ? closureRule(symbol, modeSupport) : null
  const attNote = chain ? attestorNote(chain.attestors) : null

  return (
    <Card variant="outlined" data-testid={`rwa-card-${symbol}`} sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 26, lineHeight: 1 }} aria-hidden>
          {meta?.icon ?? '?'}
        </Typography>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
            {symbol}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {meta?.provenance?.referenceId ?? '—'}
          </Typography>
        </Box>
        <Box sx={{ flexGrow: 1 }} />
        <Chip
          size="small"
          label={c.classLabel[cls]}
          color={cls === 'crypto' ? 'default' : 'primary'}
          variant={cls === 'crypto' ? 'outlined' : 'filled'}
        />
      </Stack>

      <Field label={c.referenceAsset}>{assetsCopy[symbol]?.underlying ?? '—'}</Field>
      <Divider sx={{ my: 0.5 }} />

      <Field label={c.rwaFlag} testId="rwa-flag" tone={flagNote === 'goldMismatch' || flagNote === 'unflaggedRwa' ? 'warning' : 'default'}>
        {readingText(rwaFlag, (v) => (v ? c.rwaFlagged : c.rwaUnflagged))}
        {flagNote && <Note tone={flagNote === 'goldMismatch' || flagNote === 'unflaggedRwa' ? 'warning' : 'default'}>{c.rwaNote[flagNote]}</Note>}
      </Field>

      <Field label={c.kyc} testId="rwa-kyc">
        {kyc ? c.kycValue[kyc] : t.rwa.common.loading}
        {kyc === 'required' && <Note>{c.kycNote}</Note>}
      </Field>

      <Field label={c.priceSource} testId="rwa-source">
        {primary
          ? interpolate(c.priceSourceValue, { source: c.sourceName[primary.provider], ticker: primary.ticker })
          : '—'}
        <Note>
          {secondary
            ? interpolate(c.secondary, { source: c.sourceName[secondary.provider], ticker: secondary.ticker })
            : c.singleSource}
        </Note>
        <Note>{c.keeperSchedule}</Note>
      </Field>

      <Field label={c.session}>{c.sessionValue[sessionClassOf(symbol)]}</Field>

      <Field
        label={c.status}
        testId="rwa-status"
        tone={statusKey === 'halted' ? 'error' : statusKey === 'closed' || statusKey === 'reduceOnly' ? 'warning' : 'success'}
      >
        {c.statusValue[statusKey]}
      </Field>

      <Field label={c.closureRule} testId="rwa-closure" tone={closure === 'noStop' ? 'warning' : 'default'}>
        {closure ? c.closure[closure] : t.rwa.common.loading}
      </Field>

      <Field label={c.carbon} testId="rwa-carbon">
        {readingText(chain?.carbon, (v) => `${c.tier[v.tier]} · ${interpolate(c.freshCount, { n: v.freshCount })}`)}
        <Note>
          {c.attestors} · {readingText(chain?.attestors, (n) => interpolate(c.attestorsValue, { n }))}
        </Note>
        {attNote && <Note tone="warning">{attNote === 'single' ? c.singleAttestor : c.noAttestor}</Note>}
      </Field>

      <Field label={c.maxLeverage} testId="rwa-leverage">
        {readingText(chain?.maxLeverage, (n) => interpolate(c.maxLeverageValue, { n }))}
      </Field>
      <Field label={c.maintenance} testId="rwa-maintenance">
        {readingText(chain?.maintenanceBps, (bps) => interpolate(c.maintenanceValue, { pct: bpsToPct(bps), bps }))}
      </Field>

      <Divider sx={{ my: 0.5 }} />
      <Field label={c.risk}>
        <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
          {c.riskByClass[cls]}
        </Typography>
        <Note>{c.riskCommon}</Note>
      </Field>
    </Card>
  )
}
